import {
  ALARM_NAME,
  BG_REFRESH_BATCH_SIZE,
  BG_REFRESH_INTRA_DELAY_MS,
  BG_REFRESH_MIN_BATCH_DELAY_MS
} from '@/shared/constants';
import {
  loadAuthorVideoCacheMap,
  loadFeedCacheMap,
  loadGroups,
  loadSettings,
  saveAuthorVideoCacheMap,
  saveFeedCacheMap,
  saveRuntimeStateMap,
  loadRuntimeStateMap
} from '@/shared/storage/repository';
import type { ExtensionSettings } from '@/shared/types';
import type { SchedulerStatusResponse } from '@/shared/messages';
import {
  isAuthorCacheExpired,
  refreshAuthorCache,
  type AuthorCacheMap
} from '@/background/feed-service';

export interface SchedulerTask {
  mid: number;
  name: string;
  groupId?: string;
}

const MAX_HISTORY = 50;

interface HistoryEntry {
  mid: number;
  name: string;
  success: boolean;
  timestamp: number;
  error?: string;
}

interface SchedulerInternalState {
  queue: SchedulerTask[];
  currentTask: SchedulerTask | null;
  batchCompleted: number;
  batchFailed: SchedulerTask[];
  running: boolean;
  lastRunAt?: number;
  // 当前执行循环使用的批次间延迟
  currentBatchDelay: number;
  // 调度历史（最新在前）
  history: HistoryEntry[];
  // runLoop 执行期间的内存缓存引用，用于调试面板实时读取
  liveAuthorCacheMap: AuthorCacheMap | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const state: SchedulerInternalState = {
  queue: [],
  currentTask: null,
  batchCompleted: 0,
  batchFailed: [],
  running: false,
  currentBatchDelay: BG_REFRESH_MIN_BATCH_DELAY_MS,
  history: [],
  liveAuthorCacheMap: null
};

function pushHistory(entry: HistoryEntry): void {
  state.history.unshift(entry);
  if (state.history.length > MAX_HISTORY) {
    state.history.length = MAX_HISTORY;
  }
}

/**
 * 注册或更新后台刷新 alarm。
 */
export async function setupAlarm(settings: ExtensionSettings): Promise<void> {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: settings.backgroundRefreshIntervalMinutes,
    periodInMinutes: settings.backgroundRefreshIntervalMinutes
  });
}

/**
 * 从所有启用分组中收集过期作者，按 lastFetchedAt 升序排列。
 */
function collectStaleAuthors(
  authorCacheMap: AuthorCacheMap,
  allAuthorMids: Set<number>,
  settings: ExtensionSettings
): SchedulerTask[] {
  const stale: Array<{ mid: number; name: string; lastFetchedAt: number }> = [];

  for (const mid of allAuthorMids) {
    const cache = authorCacheMap[mid];
    if (isAuthorCacheExpired(cache, settings)) {
      stale.push({
        mid,
        name: cache?.name ?? String(mid),
        lastFetchedAt: cache?.lastFetchedAt ?? 0
      });
    }
  }

  stale.sort((a, b) => a.lastFetchedAt - b.lastFetchedAt);
  return stale.map(({ mid, name }) => ({ mid, name }));
}

/**
 * 将优先任务插入队列最前面。
 * 去重：跳过队列和 currentTask 中已存在的 mid。
 * 如果插入后当前批次总数超过 BATCH_SIZE，超出部分自然留在队列后续批次处理。
 */
export function enqueuePriority(tasks: SchedulerTask[]): void {
  const existingMids = new Set<number>();
  if (state.currentTask) {
    existingMids.add(state.currentTask.mid);
  }
  for (const t of state.queue) {
    existingMids.add(t.mid);
  }

  const newTasks = tasks.filter((t) => !existingMids.has(t.mid));
  if (newTasks.length === 0) return;

  state.queue.unshift(...newTasks);

  // 如果调度器空闲，立即启动
  if (!state.running) {
    void runLoop();
  }
}

/**
 * 获取调度器当前状态（调试用）。
 * 异步加载缓存数据以生成摘要信息。
 */
export async function getStatus(): Promise<SchedulerStatusResponse> {
  // 调度器运行期间优先读内存中的实时缓存，避免读到过时的 storage 快照
  const authorCacheMap = state.liveAuthorCacheMap ?? await loadAuthorVideoCacheMap();
  const feedCacheMap = await loadFeedCacheMap();

  const authorCaches = Object.values(authorCacheMap)
    .map((c) => ({
      mid: c.mid,
      name: c.name,
      videoCount: c.videos.length,
      lastFetchedAt: c.lastFetchedAt,
      face: c.face
    }))
    .sort((a, b) => b.lastFetchedAt - a.lastFetchedAt);

  const groupCaches = Object.values(feedCacheMap)
    .map((c) => ({
      groupId: c.groupId,
      authorCount: c.authorMids.length,
      updatedAt: c.updatedAt
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    running: state.running,
    queueLength: state.queue.length,
    currentTask: state.currentTask ? { mid: state.currentTask.mid, name: state.currentTask.name } : null,
    batchCompleted: state.batchCompleted,
    batchFailed: state.batchFailed.length,
    lastRunAt: state.lastRunAt,
    queue: state.queue.map((t) => ({ mid: t.mid, name: t.name, groupId: t.groupId })),
    authorCaches,
    groupCaches,
    history: state.history
  };
}

/**
 * 调度器核心执行循环。
 * 从队列中逐个取出任务串行执行，每个任务间隔 INTRA_DELAY。
 * 每完成 BATCH_SIZE 个任务后，将失败任务追加到队列末尾，持久化缓存，等待批次间延迟。
 */
async function runLoop(): Promise<void> {
  if (state.running) return;
  state.running = true;
  state.lastRunAt = Date.now();

  // 加载缓存（整个循环共享同一份引用，每批次结束时持久化）
  const authorCacheMap = await loadAuthorVideoCacheMap();
  state.liveAuthorCacheMap = authorCacheMap;

  while (state.queue.length > 0) {
    const task = state.queue.shift()!;
    state.currentTask = task;

    try {
      await refreshAuthorCache(task.mid, task.name, authorCacheMap);
      state.batchCompleted++;
      pushHistory({ mid: task.mid, name: task.name, success: true, timestamp: Date.now() });
    } catch (error) {
      console.warn('[BBE] 调度器刷新失败 mid:', task.mid, error);
      state.batchFailed.push(task);
      pushHistory({
        mid: task.mid,
        name: task.name,
        success: false,
        timestamp: Date.now(),
        error: error instanceof Error ? error.message : String(error)
      });
    }

    state.currentTask = null;

    // 批次结束判定
    if (state.batchCompleted >= BG_REFRESH_BATCH_SIZE) {
      // 失败任务追加到队列末尾，留给下一批次
      if (state.batchFailed.length > 0) {
        state.queue.push(...state.batchFailed);
        state.batchFailed = [];
      }
      state.batchCompleted = 0;

      await saveAuthorVideoCacheMap(authorCacheMap);

      if (state.queue.length > 0) {
        await sleep(state.currentBatchDelay);
      }
    } else if (state.queue.length > 0) {
      await sleep(BG_REFRESH_INTRA_DELAY_MS);
    }
  }

  // 队列清空，处理最后一批的失败任务（留给下次 alarm）
  if (state.batchFailed.length > 0) {
    state.queue.push(...state.batchFailed);
    state.batchFailed = [];
  }
  state.batchCompleted = 0;

  // 最终持久化
  await saveAuthorVideoCacheMap(authorCacheMap);

  state.running = false;
  state.liveAuthorCacheMap = null;
}

/**
 * Alarm 触发时的处理逻辑：
 * - 如果调度器正在运行，不生成新任务（当前任务会自然继续）。
 * - 如果空闲，收集过期作者生成任务队列并启动。
 */
async function handleAlarm(): Promise<void> {
  if (state.running) {
    return;
  }

  const [settings, groups, feedCacheMap, authorCacheMap] = await Promise.all([
    loadSettings(),
    loadGroups(),
    loadFeedCacheMap(),
    loadAuthorVideoCacheMap()
  ]);

  const enabledGroups = groups.filter((g) => g.enabled);
  if (enabledGroups.length === 0) return;

  const allAuthorMids = new Set<number>();
  for (const group of enabledGroups) {
    const feedCache = feedCacheMap[group.groupId];
    if (feedCache) {
      for (const mid of feedCache.authorMids) {
        allAuthorMids.add(mid);
      }
    }
  }

  if (allAuthorMids.size === 0) return;

  const staleTasks = collectStaleAuthors(authorCacheMap, allAuthorMids, settings);
  if (staleTasks.length === 0) return;

  // 计算批次间延迟
  const batchCount = Math.ceil(staleTasks.length / BG_REFRESH_BATCH_SIZE);
  const intervalMs = settings.backgroundRefreshIntervalMinutes * 60 * 1000;
  state.currentBatchDelay = Math.max(BG_REFRESH_MIN_BATCH_DELAY_MS, Math.floor(intervalMs / batchCount));

  state.queue.push(...staleTasks);
  void runLoop();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    handleAlarm().catch((error) => {
      console.warn('[BBE] alarm 处理失败:', error);
    });
  }
});
