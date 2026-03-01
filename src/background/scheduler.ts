import {
  ALARM_NAMES,
  BG_REFRESH_BATCH_SIZE_DEFAULT,
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
  saveGroups
} from '@/shared/storage/repository';
import type { ExtensionSettings, GroupConfig } from '@/shared/types';
import type { SchedulerStatusResponse } from '@/shared/messages';
import {
  buildAuthorListFromFav,
  isAuthorCacheExpired,
  markAuthorPageUsage,
  refreshAuthorCache,
  type AuthorCacheMap,
  type MixedUsedPageItem
} from '@/background/feed-service';
import { getMyCreatedFolders } from '@/shared/api/bilibili';

export interface SchedulerTask {
  mid: number;
  name: string;
  groupId?: string;
  pn?: number;
  reason?: 'first-page-refresh' | 'prefetch-next-page' | 'load-more-boundary';
  // 仅用于“前台同步等待”的补页任务：失败后不重试，直接回传错误。
  failFast?: boolean;
}

interface GroupFavTask {
  groupId: string;
}

const MAX_HISTORY = 50;
const BURST_RETRY_DELAY_MS = 60_000;

type AuthorTask = Required<Pick<SchedulerTask, 'mid' | 'name' | 'pn' | 'reason' | 'failFast'>> & Pick<SchedulerTask, 'groupId'>;
type BurstCooldownReason = 'intra-delay' | 'error' | null;

interface HistoryEntry {
  mid: number;
  name: string;
  mode: 'regular' | 'burst';
  success: boolean;
  timestamp: number;
  error?: string;
}

interface ChannelState<TTask> {
  queue: TTask[];
  currentTask: TTask | null;
  batchCompleted: number;
  batchFailed: TTask[];
  running: boolean;
  lastRunAt?: number;
  currentBatchDelay: number;
}

interface QueueState<TTask> {
  queue: TTask[];
  currentTask: TTask | null;
}

interface BurstState extends QueueState<AuthorTask> {
  running: boolean;
  lastRunAt?: number;
  nextAllowedAt: number;
  cooldownReason: BurstCooldownReason;
}

function createChannelState<TTask>(): ChannelState<TTask> {
  return {
    queue: [],
    currentTask: null,
    batchCompleted: 0,
    batchFailed: [],
    running: false,
    currentBatchDelay: BG_REFRESH_MIN_BATCH_DELAY_MS
  };
}

function createBurstState(): BurstState {
  return {
    queue: [],
    currentTask: null,
    running: false,
    nextAllowedAt: 0,
    cooldownReason: null
  };
}

const authorState = createChannelState<AuthorTask>();
const groupFavState = createChannelState<GroupFavTask>();
const burstState = createBurstState();
const history: HistoryEntry[] = [];

let pendingAuthorRoutineAfterBurst = false;
let pendingGroupFavRoutineAfterBurst = false;

// 作者通道运行期间暴露内存引用，避免调试面板读到过时快照。
let liveAuthorCacheMap: AuthorCacheMap | null = null;
const burstTaskWaiters = new Map<string, Array<(result: { ok: boolean; error?: string }) => void>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notifyBurstTaskFinished(task: AuthorTask, result: { ok: boolean; error?: string }): void {
  const key = keyOfAuthorTask(task);
  const waiters = burstTaskWaiters.get(key);
  if (!waiters || waiters.length === 0) {
    return;
  }
  burstTaskWaiters.delete(key);
  for (const waiter of waiters) {
    waiter(result);
  }
}

function pushHistory(entry: HistoryEntry): void {
  history.unshift(entry);
  if (history.length > MAX_HISTORY) {
    history.length = MAX_HISTORY;
  }
}

function getGroupTitle(group: GroupConfig): string {
  return group.alias?.trim() || group.mediaTitle || group.groupId;
}

function keyOfAuthorTask(task: Pick<AuthorTask, 'mid' | 'pn'>): string {
  return `${task.mid}:${task.pn}`;
}

function normalizeAuthorTask(task: SchedulerTask): AuthorTask {
  return {
    mid: task.mid,
    name: task.name?.trim() || String(task.mid),
    groupId: task.groupId,
    pn: Math.max(1, Number(task.pn) || 1),
    reason: task.reason ?? 'first-page-refresh',
    failFast: task.failFast === true
  };
}

function resolveAuthorName(name: string | undefined, videos: Array<{ authorName: string }>, mid: number): string {
  const cacheName = name?.trim();
  const isNumeric = !!cacheName && /^\d+$/.test(cacheName);
  const videoName = videos.find((item) => item.authorName?.trim())?.authorName?.trim();
  if (cacheName && !isNumeric) return cacheName;
  if (videoName) return videoName;
  if (cacheName) return cacheName;
  return String(mid);
}

/**
 * 调试展示中仅将“非空且非纯数字”的作者名视为有效名称。
 */
function resolveDisplayName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed || /^\d+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function normalizeBatchSize(settings: ExtensionSettings): number {
  const raw = Number(settings.schedulerBatchSize) || BG_REFRESH_BATCH_SIZE_DEFAULT;
  return Math.min(50, Math.max(1, raw));
}

function normalizeInterval(mins: number, fallback: number): number {
  const value = Number(mins) || fallback;
  return Math.min(120, Math.max(5, value));
}

function calcBatchDelay(totalTasks: number, intervalMinutes: number, batchSize: number): number {
  const safeBatchSize = Math.max(1, batchSize);
  const batchCount = Math.max(1, Math.ceil(totalTasks / safeBatchSize));
  const intervalMs = intervalMinutes * 60 * 1000;
  return Math.max(BG_REFRESH_MIN_BATCH_DELAY_MS, Math.floor(intervalMs / batchCount));
}

function buildExistingTaskKeySet<TTask>(state: QueueState<TTask>, keyOf: (task: TTask) => string): Set<string> {
  const existing = new Set<string>();
  if (state.currentTask) {
    existing.add(keyOf(state.currentTask));
  }
  for (const task of state.queue) {
    existing.add(keyOf(task));
  }
  return existing;
}

function dedupeAndEnqueue<TTask>(
  state: QueueState<TTask>,
  tasks: TTask[],
  keyOf: (task: TTask) => string,
  priority: boolean
): number {
  const existing = buildExistingTaskKeySet(state, keyOf);
  const newTasks: TTask[] = [];
  for (const task of tasks) {
    const key = keyOf(task);
    if (existing.has(key)) {
      continue;
    }
    existing.add(key);
    newTasks.push(task);
  }
  if (newTasks.length === 0) {
    return 0;
  }

  if (priority) {
    state.queue.unshift(...newTasks);
  } else {
    state.queue.push(...newTasks);
  }

  return newTasks.length;
}

/**
 * 调试页“立刻发起调度”使用的补齐策略：
 * 仅补到 batchSize，不做全量入队，且按候选列表顺序（最旧优先）补齐。
 */
function fillQueueToBatchSize<TTask>(
  state: QueueState<TTask>,
  candidates: TTask[],
  keyOf: (task: TTask) => string,
  batchSize: number
): number {
  const need = Math.max(0, batchSize - state.queue.length);
  if (need === 0 || candidates.length === 0) {
    return 0;
  }

  const existing = buildExistingTaskKeySet(state, keyOf);
  const picked: TTask[] = [];
  for (const task of candidates) {
    const key = keyOf(task);
    if (existing.has(key)) {
      continue;
    }
    existing.add(key);
    picked.push(task);
    if (picked.length >= need) {
      break;
    }
  }

  if (picked.length === 0) {
    return 0;
  }

  state.queue.push(...picked);
  return picked.length;
}

function isBurstActive(): boolean {
  return burstState.running || burstState.queue.length > 0;
}

function hasRunningRegularTask(): boolean {
  return authorState.running || groupFavState.running;
}

function removeAuthorTasksFromRegularQueue(taskKeys: Set<string>): void {
  if (taskKeys.size === 0 || authorState.queue.length === 0) {
    return;
  }
  authorState.queue = authorState.queue.filter((task) => !taskKeys.has(keyOfAuthorTask(task)));
}

async function resetAlarm(alarmName: string, intervalMinutes: number): Promise<number | undefined> {
  await chrome.alarms.clear(alarmName);
  chrome.alarms.create(alarmName, {
    delayInMinutes: intervalMinutes,
    periodInMinutes: intervalMinutes
  });
  const alarm = await chrome.alarms.get(alarmName);
  return alarm?.scheduledTime;
}

async function collectStaleAuthorTasks(settings: ExtensionSettings): Promise<AuthorTask[]> {
  const [groups, feedCacheMap, authorCacheMap] = await Promise.all([
    loadGroups(),
    loadFeedCacheMap(),
    loadAuthorVideoCacheMap()
  ]);

  const enabledGroups = groups.filter((g) => g.enabled);
  if (enabledGroups.length === 0) return [];

  const mids = new Set<number>();
  for (const group of enabledGroups) {
    const cache = feedCacheMap[group.groupId];
    if (!cache) continue;
    for (const mid of cache.authorMids) {
      mids.add(mid);
    }
  }

  const stale: Array<{ mid: number; name: string; lastFetchedAt: number }> = [];
  for (const mid of mids) {
    const cache = authorCacheMap[mid];
    if (!cache) {
      continue;
    }
    if (isAuthorCacheExpired(cache, settings)) {
      const firstFetchedAt = cache.firstPageFetchedAt || cache.lastFetchedAt || 0;
      stale.push({
        mid,
        name: cache.name ?? String(mid),
        lastFetchedAt: firstFetchedAt
      });
    }
  }

  stale.sort((a, b) => a.lastFetchedAt - b.lastFetchedAt);
  return stale.map(({ mid, name }) => ({
    mid,
    name,
    pn: 1,
    reason: 'first-page-refresh',
    failFast: false
  }));
}

async function collectNoCacheAuthorTasks(): Promise<AuthorTask[]> {
  const [groups, feedCacheMap, authorCacheMap] = await Promise.all([
    loadGroups(),
    loadFeedCacheMap(),
    loadAuthorVideoCacheMap()
  ]);

  const enabledGroups = groups.filter((g) => g.enabled);
  if (enabledGroups.length === 0) return [];

  const mids = new Set<number>();
  for (const group of enabledGroups) {
    const cache = feedCacheMap[group.groupId];
    if (!cache) continue;
    for (const mid of cache.authorMids) {
      if (!authorCacheMap[mid]) {
        mids.add(mid);
      }
    }
  }

  return Array.from(mids)
    .sort((a, b) => a - b)
    .map((mid) => ({
      mid,
      name: String(mid),
      pn: 1,
      reason: 'first-page-refresh',
      failFast: false
    }));
}

async function collectOldestAuthorTasks(): Promise<AuthorTask[]> {
  const [groups, feedCacheMap, authorCacheMap] = await Promise.all([
    loadGroups(),
    loadFeedCacheMap(),
    loadAuthorVideoCacheMap()
  ]);

  const enabledGroups = groups.filter((g) => g.enabled);
  if (enabledGroups.length === 0) return [];

  const mids = new Set<number>();
  for (const group of enabledGroups) {
    const cache = feedCacheMap[group.groupId];
    if (!cache) continue;
    for (const mid of cache.authorMids) {
      mids.add(mid);
    }
  }

  const oldest: Array<{ mid: number; name: string; lastFetchedAt: number }> = [];
  for (const mid of mids) {
    const cache = authorCacheMap[mid];
    if (!cache) {
      continue;
    }
    oldest.push({
      mid,
      name: cache.name ?? String(mid),
      lastFetchedAt: cache.firstPageFetchedAt || cache.lastFetchedAt || 0
    });
  }

  oldest.sort((a, b) => a.lastFetchedAt - b.lastFetchedAt);
  return oldest.map(({ mid, name }) => ({
    mid,
    name,
    pn: 1,
    reason: 'first-page-refresh',
    failFast: false
  }));
}

function isPageFresh(
  fetchedAt: number | undefined,
  settings: ExtensionSettings
): boolean {
  if (!fetchedAt || fetchedAt <= 0) {
    return false;
  }
  return Date.now() - fetchedAt <= settings.refreshIntervalMinutes * 60 * 1000;
}

function resolveNextPrefetchPn(
  cache: {
    pageState: Record<number, { fetchedAt: number; usedInMixed: boolean }>;
    hasMore: boolean;
    firstPageFetchedAt: number;
    maxCachedPn: number;
  },
  settings: ExtensionSettings
): number | null {
  if (!cache.hasMore) {
    return null;
  }

  if (!isPageFresh(cache.firstPageFetchedAt, settings)) {
    return null;
  }

  const page2 = cache.pageState[2];
  if (!page2 || !isPageFresh(page2.fetchedAt, settings)) {
    return 2;
  }

  let k = 2;
  while (true) {
    const state = cache.pageState[k];
    if (!state || !isPageFresh(state.fetchedAt, settings) || !state.usedInMixed) {
      break;
    }
    k++;
  }

  if (k <= 2) {
    return null;
  }

  const nextPn = k;
  const alreadyFetched = cache.pageState[nextPn];
  if (alreadyFetched) {
    return null;
  }
  if (nextPn <= cache.maxCachedPn) {
    return null;
  }
  return nextPn;
}

async function collectPrefetchAuthorTasks(settings: ExtensionSettings): Promise<AuthorTask[]> {
  const authorCacheMap = await loadAuthorVideoCacheMap();
  const tasks: AuthorTask[] = [];

  for (const cache of Object.values(authorCacheMap)) {
    const pn = resolveNextPrefetchPn(cache, settings);
    if (!pn) {
      continue;
    }
    tasks.push({
      mid: cache.mid,
      name: cache.name ?? String(cache.mid),
      pn,
      reason: 'prefetch-next-page',
      failFast: false
    });
  }

  tasks.sort((a, b) => a.mid - b.mid || a.pn - b.pn);
  return tasks;
}

async function collectStaleGroupFavTasks(settings: ExtensionSettings): Promise<GroupFavTask[]> {
  const [groups, feedCacheMap] = await Promise.all([loadGroups(), loadFeedCacheMap()]);
  const intervalMs = normalizeInterval(settings.groupFavRefreshIntervalMinutes, 10) * 60 * 1000;
  const now = Date.now();

  const stale: Array<{ groupId: string; updatedAt: number }> = [];

  for (const group of groups) {
    if (!group.enabled) continue;

    const cache = feedCacheMap[group.groupId];
    const updatedAt = cache?.updatedAt ?? 0;

    if (!cache || now - updatedAt > intervalMs) {
      stale.push({ groupId: group.groupId, updatedAt });
    }
  }

  stale.sort((a, b) => a.updatedAt - b.updatedAt);
  return stale.map((item) => ({ groupId: item.groupId }));
}

async function collectOldestGroupFavTasks(): Promise<GroupFavTask[]> {
  const [groups, feedCacheMap] = await Promise.all([loadGroups(), loadFeedCacheMap()]);
  const oldest: Array<{ groupId: string; updatedAt: number }> = [];

  for (const group of groups) {
    if (!group.enabled) continue;
    const cache = feedCacheMap[group.groupId];
    oldest.push({ groupId: group.groupId, updatedAt: cache?.updatedAt ?? 0 });
  }

  oldest.sort((a, b) => a.updatedAt - b.updatedAt);
  return oldest.map((item) => ({ groupId: item.groupId }));
}

async function runAuthorTask(task: AuthorTask, authorCacheMap: AuthorCacheMap): Promise<void> {
  await refreshAuthorCache(task.mid, task.name, authorCacheMap, { pn: task.pn });
}

/**
 * 刷新单个分组的收藏夹缓存：重建作者列表并同步收藏夹标题。
 * 完成后会把该分组作者任务优先插入作者通道。
 */
async function runGroupFavTask(task: GroupFavTask): Promise<void> {
  const [groups, feedCacheMap, authorCacheMap, settings] = await Promise.all([
    loadGroups(),
    loadFeedCacheMap(),
    loadAuthorVideoCacheMap(),
    loadSettings()
  ]);

  const group = groups.find((item) => item.groupId === task.groupId && item.enabled);
  if (!group) {
    return;
  }

  const authors = await buildAuthorListFromFav(group, feedCacheMap);
  if (authors.length === 0) {
    // 收藏夹不存在/不可访问时 getAllFavVideos 可能返回空；此时保持旧分组信息不变。
    console.warn('[BBE] 收藏夹作者列表为空，已跳过缓存覆盖 groupId:', group.groupId);
    return;
  }

  // 同步收藏夹标题：别名 alias 独立保存，不会受此更新影响。
  let groupChanged = false;
  try {
    const folders = await getMyCreatedFolders();
    const folder = folders.find((item) => item.id === group.mediaId);
    if (folder && folder.title !== group.mediaTitle) {
      group.mediaTitle = folder.title;
      group.updatedAt = Date.now();
      groupChanged = true;
    }
  } catch (error) {
    console.warn('[BBE] 同步收藏夹标题失败:', error);
  }

  await saveFeedCacheMap(feedCacheMap);
  if (groupChanged) {
    await saveGroups(groups);
  }

  const burstTasks: AuthorTask[] = [];
  const priorityTasks: AuthorTask[] = [];
  for (const author of authors) {
    const cache = authorCacheMap[author.mid];
    const task: AuthorTask = {
      mid: author.mid,
      name: cache?.name ?? author.name,
      groupId: group.groupId,
      pn: 1,
      reason: 'first-page-refresh',
      failFast: false
    };

    if (!cache) {
      burstTasks.push(task);
      continue;
    }

    // group-fav 衔接作者任务时，只补“已有缓存但已过期”的目标，避免把未过期作者大量挤入常规队列。
    if (isAuthorCacheExpired(cache, settings)) {
      priorityTasks.push(task);
    }
  }

  enqueueBurst(burstTasks);
  enqueuePriority(priorityTasks);
}

async function runAuthorLoop(): Promise<void> {
  if (authorState.running) return;

  authorState.running = true;
  authorState.lastRunAt = Date.now();

  const settings = await loadSettings();
  const batchSize = normalizeBatchSize(settings);
  const authorCacheMap = await loadAuthorVideoCacheMap();
  liveAuthorCacheMap = authorCacheMap;

  while (authorState.queue.length > 0) {
    if (isBurstActive()) {
      break;
    }

    const task = authorState.queue.shift()!;
    authorState.currentTask = task;

    try {
      await runAuthorTask(task, authorCacheMap);
      authorState.batchCompleted++;
      pushHistory({ mid: task.mid, name: task.name, mode: 'regular', success: true, timestamp: Date.now() });
    } catch (error) {
      authorState.batchFailed.push(task);
      pushHistory({
        mid: task.mid,
        name: task.name,
        mode: 'regular',
        success: false,
        timestamp: Date.now(),
        error: error instanceof Error ? error.message : String(error)
      });
      console.warn('[BBE] 作者任务刷新失败 mid:', task.mid, error);
    }

    authorState.currentTask = null;

    if (isBurstActive()) {
      continue;
    }

    if (authorState.batchCompleted >= batchSize) {
      if (authorState.batchFailed.length > 0) {
        authorState.queue.push(...authorState.batchFailed);
        authorState.batchFailed = [];
      }
      authorState.batchCompleted = 0;

      await saveAuthorVideoCacheMap(authorCacheMap);

      if (authorState.queue.length > 0) {
        await sleep(authorState.currentBatchDelay);
      }
    } else if (authorState.queue.length > 0) {
      await sleep(BG_REFRESH_INTRA_DELAY_MS);
    }
  }

  if (authorState.batchFailed.length > 0) {
    authorState.queue.push(...authorState.batchFailed);
    authorState.batchFailed = [];
  }
  authorState.batchCompleted = 0;

  await saveAuthorVideoCacheMap(authorCacheMap);

  authorState.running = false;
  liveAuthorCacheMap = null;

  if (isBurstActive()) {
    startBurstLoopIfIdle();
  }
}

async function runGroupFavLoop(): Promise<void> {
  if (groupFavState.running) return;

  groupFavState.running = true;
  groupFavState.lastRunAt = Date.now();

  const settings = await loadSettings();
  const batchSize = normalizeBatchSize(settings);

  while (groupFavState.queue.length > 0) {
    if (isBurstActive()) {
      break;
    }

    const task = groupFavState.queue.shift()!;
    groupFavState.currentTask = task;

    try {
      await runGroupFavTask(task);
      groupFavState.batchCompleted++;
    } catch (error) {
      groupFavState.batchFailed.push(task);
      console.warn('[BBE] 收藏夹任务刷新失败 groupId:', task.groupId, error);
    }

    groupFavState.currentTask = null;

    if (isBurstActive()) {
      continue;
    }

    if (groupFavState.batchCompleted >= batchSize) {
      if (groupFavState.batchFailed.length > 0) {
        groupFavState.queue.push(...groupFavState.batchFailed);
        groupFavState.batchFailed = [];
      }
      groupFavState.batchCompleted = 0;

      if (groupFavState.queue.length > 0) {
        await sleep(groupFavState.currentBatchDelay);
      }
    } else if (groupFavState.queue.length > 0) {
      await sleep(BG_REFRESH_INTRA_DELAY_MS);
    }
  }

  if (groupFavState.batchFailed.length > 0) {
    groupFavState.queue.push(...groupFavState.batchFailed);
    groupFavState.batchFailed = [];
  }
  groupFavState.batchCompleted = 0;

  groupFavState.running = false;

  if (isBurstActive()) {
    startBurstLoopIfIdle();
  }
}

async function flushPendingRoutineAfterBurst(): Promise<void> {
  if (!pendingAuthorRoutineAfterBurst && !pendingGroupFavRoutineAfterBurst) {
    return;
  }

  const shouldRunAuthor = pendingAuthorRoutineAfterBurst;
  const shouldRunGroupFav = pendingGroupFavRoutineAfterBurst;
  pendingAuthorRoutineAfterBurst = false;
  pendingGroupFavRoutineAfterBurst = false;

  try {
    const jobs: Array<Promise<unknown>> = [];
    if (shouldRunAuthor) {
      jobs.push(triggerAuthorRoutine({ resetAlarmSchedule: false }));
    }
    if (shouldRunGroupFav) {
      jobs.push(triggerGroupFavRoutine({ resetAlarmSchedule: false }));
    }
    await Promise.all(jobs);
  } catch (error) {
    console.warn('[BBE] Burst 结束后补偿调度失败:', error);
  }
}

async function runBurstLoop(): Promise<void> {
  if (burstState.running) return;

  burstState.running = true;
  burstState.lastRunAt = Date.now();

  const authorCacheMap = await loadAuthorVideoCacheMap();
  liveAuthorCacheMap = authorCacheMap;

  while (burstState.queue.length > 0) {
    const waitMs = burstState.nextAllowedAt - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    if (burstState.queue.length === 0) {
      break;
    }

    const task = burstState.queue[0]!;
    burstState.currentTask = task;

    try {
      await runAuthorTask(task, authorCacheMap);
      burstState.queue.shift();
      burstState.nextAllowedAt = Date.now() + BG_REFRESH_INTRA_DELAY_MS;
      burstState.cooldownReason = 'intra-delay';
      pushHistory({ mid: task.mid, name: task.name, mode: 'burst', success: true, timestamp: Date.now() });
      await saveAuthorVideoCacheMap(authorCacheMap);
      notifyBurstTaskFinished(task, { ok: true });
    } catch (error) {
      pushHistory({
        mid: task.mid,
        name: task.name,
        mode: 'burst',
        success: false,
        timestamp: Date.now(),
        error: error instanceof Error ? error.message : String(error)
      });
      console.warn('[BBE] Burst 作者任务刷新失败 mid:', task.mid, error);

      if (task.failFast) {
        burstState.queue.shift();
        burstState.nextAllowedAt = Date.now() + BG_REFRESH_INTRA_DELAY_MS;
        burstState.cooldownReason = 'error';
        notifyBurstTaskFinished(task, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      } else {
        burstState.nextAllowedAt = Date.now() + BURST_RETRY_DELAY_MS;
        burstState.cooldownReason = 'error';
      }
    } finally {
      burstState.currentTask = null;
    }
  }

  await saveAuthorVideoCacheMap(authorCacheMap);

  burstState.running = false;
  liveAuthorCacheMap = null;

  if (burstState.queue.length > 0) {
    startBurstLoopIfIdle();
    return;
  }

  await flushPendingRoutineAfterBurst();
  if (!isBurstActive()) {
    startAuthorLoopIfIdle();
    startGroupFavLoopIfIdle();
  }
}

function startBurstLoopIfIdle(): void {
  if (!burstState.running && burstState.queue.length > 0) {
    void runBurstLoop();
  }
}

function startAuthorLoopIfIdle(): void {
  if (isBurstActive()) {
    startBurstLoopIfIdle();
    return;
  }

  if (!authorState.running && authorState.queue.length > 0) {
    void runAuthorLoop();
  }
}

function startGroupFavLoopIfIdle(): void {
  if (isBurstActive()) {
    return;
  }

  if (!groupFavState.running && groupFavState.queue.length > 0) {
    void runGroupFavLoop();
  }
}

export function enqueueBurst(tasks: SchedulerTask[]): number {
  const normalizedTasks = tasks.map(normalizeAuthorTask);
  const taskKeys = new Set(normalizedTasks.map((task) => keyOfAuthorTask(task)));
  const added = dedupeAndEnqueue(burstState, normalizedTasks, keyOfAuthorTask, false);
  if (taskKeys.size > 0) {
    // Burst 任务优先级高于常规作者队列，入列后清掉常规队列里的同目标，避免重复调用。
    removeAuthorTasksFromRegularQueue(taskKeys);
  }
  if (added > 0 && !hasRunningRegularTask()) {
    startBurstLoopIfIdle();
  }
  return added;
}

function waitForBurstTask(task: AuthorTask): Promise<{ ok: boolean; error?: string }> {
  const key = keyOfAuthorTask(task);
  return new Promise((resolve) => {
    const waiters = burstTaskWaiters.get(key) ?? [];
    waiters.push(resolve);
    burstTaskWaiters.set(key, waiters);
  });
}

function markBurstTaskFailFastByKeys(taskKeys: Set<string>): void {
  if (taskKeys.size === 0) {
    return;
  }

  if (burstState.currentTask && taskKeys.has(keyOfAuthorTask(burstState.currentTask))) {
    burstState.currentTask.failFast = true;
  }

  for (const task of burstState.queue) {
    if (taskKeys.has(keyOfAuthorTask(task))) {
      task.failFast = true;
    }
  }
}

export async function enqueueBurstHeadAndWait(
  tasks: SchedulerTask[]
): Promise<{ success: Array<{ mid: number; pn: number }>; failed: Array<{ mid: number; pn: number; error: string }> }> {
  if (tasks.length === 0) {
    return { success: [], failed: [] };
  }

  const normalizedTasks = tasks.map((task) => ({
    ...normalizeAuthorTask(task),
    failFast: true,
    reason: 'load-more-boundary' as const
  }));
  const taskKeys = new Set(normalizedTasks.map((task) => keyOfAuthorTask(task)));
  markBurstTaskFailFastByKeys(taskKeys);

  const waitJobs = normalizedTasks.map(async (task) => {
    const key = keyOfAuthorTask(task);
    const waiter = waitForBurstTask(task);
    const added = dedupeAndEnqueue(burstState, [task], keyOfAuthorTask, true);
    if (added > 0) {
      removeAuthorTasksFromRegularQueue(new Set([key]));
    }
    startBurstLoopIfIdle();
    const result = await waiter;
    if (result.ok) {
      return { ok: true as const, mid: task.mid, pn: task.pn };
    }
    return { ok: false as const, mid: task.mid, pn: task.pn, error: result.error ?? 'Burst 补页失败' };
  });

  const settled = await Promise.all(waitJobs);
  const success = settled.filter((item) => item.ok).map((item) => ({ mid: item.mid, pn: item.pn }));
  const failed = settled
    .filter((item) => !item.ok)
    .map((item) => ({ mid: item.mid, pn: item.pn, error: item.error }));
  return { success, failed };
}

export function enqueuePriority(tasks: SchedulerTask[]): number {
  if (tasks.length === 0) {
    return 0;
  }

  const normalizedTasks = tasks.map(normalizeAuthorTask);
  const burstKeys = buildExistingTaskKeySet(burstState, keyOfAuthorTask);
  const filtered = normalizedTasks.filter((task) => !burstKeys.has(keyOfAuthorTask(task)));
  const added = dedupeAndEnqueue(authorState, filtered, keyOfAuthorTask, true);
  if (added > 0) {
    startAuthorLoopIfIdle();
  }
  return added;
}

export function enqueuePriorityGroup(groupIds: string[]): number {
  const tasks: GroupFavTask[] = groupIds.map((groupId) => ({ groupId }));
  const added = dedupeAndEnqueue(groupFavState, tasks, (task) => task.groupId, true);
  if (added > 0) {
    startGroupFavLoopIfIdle();
  }
  return added;
}

async function triggerAuthorRoutine(options?: { resetAlarmSchedule: boolean }): Promise<{ queued: number; nextAlarmAt?: number }> {
  const settings = await loadSettings();
  const interval = normalizeInterval(settings.backgroundRefreshIntervalMinutes, 10);

  let nextAlarmAt: number | undefined;
  if (options?.resetAlarmSchedule) {
    nextAlarmAt = await resetAlarm(ALARM_NAMES.AUTHOR_VIDEO, interval);
  }

  const [noCacheTasks, staleTasks, prefetchTasks] = await Promise.all([
    collectNoCacheAuthorTasks(),
    collectStaleAuthorTasks(settings),
    collectPrefetchAuthorTasks(settings)
  ]);
  const burstQueued = enqueueBurst(noCacheTasks);
  const routineTasks = [...staleTasks, ...prefetchTasks];
  authorState.currentBatchDelay = calcBatchDelay(routineTasks.length, interval, normalizeBatchSize(settings));
  const normalQueued = dedupeAndEnqueue(authorState, routineTasks, keyOfAuthorTask, false);
  startAuthorLoopIfIdle();

  if (!nextAlarmAt) {
    const alarm = await chrome.alarms.get(ALARM_NAMES.AUTHOR_VIDEO);
    nextAlarmAt = alarm?.scheduledTime;
  }

  return { queued: burstQueued + normalQueued, nextAlarmAt };
}

async function triggerAuthorRoutineNow(options?: { resetAlarmSchedule: boolean }): Promise<{ queued: number; nextAlarmAt?: number }> {
  const settings = await loadSettings();
  const interval = normalizeInterval(settings.backgroundRefreshIntervalMinutes, 10);
  const batchSize = normalizeBatchSize(settings);

  let nextAlarmAt: number | undefined;
  if (options?.resetAlarmSchedule) {
    nextAlarmAt = await resetAlarm(ALARM_NAMES.AUTHOR_VIDEO, interval);
  }

  const [noCacheTasks, candidates] = await Promise.all([collectNoCacheAuthorTasks(), collectOldestAuthorTasks()]);
  const burstQueued = enqueueBurst(noCacheTasks);
  const targetTotal = Math.max(batchSize, authorState.queue.length);
  authorState.currentBatchDelay = calcBatchDelay(targetTotal, interval, batchSize);
  const normalQueued = fillQueueToBatchSize(authorState, candidates, keyOfAuthorTask, batchSize);
  startAuthorLoopIfIdle();

  if (!nextAlarmAt) {
    const alarm = await chrome.alarms.get(ALARM_NAMES.AUTHOR_VIDEO);
    nextAlarmAt = alarm?.scheduledTime;
  }

  return { queued: burstQueued + normalQueued, nextAlarmAt };
}

async function triggerGroupFavRoutine(options?: { resetAlarmSchedule: boolean }): Promise<{ queued: number; nextAlarmAt?: number }> {
  const settings = await loadSettings();
  const interval = normalizeInterval(settings.groupFavRefreshIntervalMinutes, 10);

  let nextAlarmAt: number | undefined;
  if (options?.resetAlarmSchedule) {
    nextAlarmAt = await resetAlarm(ALARM_NAMES.GROUP_FAV, interval);
  }

  const tasks = await collectStaleGroupFavTasks(settings);
  groupFavState.currentBatchDelay = calcBatchDelay(tasks.length, interval, normalizeBatchSize(settings));
  const queued = dedupeAndEnqueue(groupFavState, tasks, (task) => task.groupId, false);
  startGroupFavLoopIfIdle();

  if (!nextAlarmAt) {
    const alarm = await chrome.alarms.get(ALARM_NAMES.GROUP_FAV);
    nextAlarmAt = alarm?.scheduledTime;
  }

  return { queued, nextAlarmAt };
}

async function triggerGroupFavRoutineNow(options?: { resetAlarmSchedule: boolean }): Promise<{ queued: number; nextAlarmAt?: number }> {
  const settings = await loadSettings();
  const interval = normalizeInterval(settings.groupFavRefreshIntervalMinutes, 10);
  const batchSize = normalizeBatchSize(settings);

  let nextAlarmAt: number | undefined;
  if (options?.resetAlarmSchedule) {
    nextAlarmAt = await resetAlarm(ALARM_NAMES.GROUP_FAV, interval);
  }

  const candidates = await collectOldestGroupFavTasks();
  const targetTotal = Math.max(batchSize, groupFavState.queue.length);
  groupFavState.currentBatchDelay = calcBatchDelay(targetTotal, interval, batchSize);
  const queued = fillQueueToBatchSize(groupFavState, candidates, (task) => task.groupId, batchSize);
  startGroupFavLoopIfIdle();

  if (!nextAlarmAt) {
    const alarm = await chrome.alarms.get(ALARM_NAMES.GROUP_FAV);
    nextAlarmAt = alarm?.scheduledTime;
  }

  return { queued, nextAlarmAt };
}

/**
 * 注册或更新后台刷新 alarm。
 */
export async function setupAlarm(settings: ExtensionSettings): Promise<void> {
  const authorInterval = normalizeInterval(settings.backgroundRefreshIntervalMinutes, 10);
  const groupFavInterval = normalizeInterval(settings.groupFavRefreshIntervalMinutes, 10);

  await Promise.all([
    resetAlarm(ALARM_NAMES.AUTHOR_VIDEO, authorInterval),
    resetAlarm(ALARM_NAMES.GROUP_FAV, groupFavInterval)
  ]);
}

/**
 * 调试页立即触发调度：
 * 每个通道只补齐到 batchSize（不足时按“最旧优先”补齐），不会全量入队。
 */
export async function runSchedulerNow(): Promise<{
  accepted: true;
  triggeredAt: number;
  channels: Array<{ name: 'author-video' | 'group-fav'; queued: number; nextAlarmAt?: number }>;
}> {
  const [author, groupFav] = await Promise.all([
    triggerAuthorRoutineNow({ resetAlarmSchedule: true }),
    triggerGroupFavRoutineNow({ resetAlarmSchedule: true })
  ]);

  return {
    accepted: true,
    triggeredAt: Date.now(),
    channels: [
      { name: 'author-video', queued: author.queued, nextAlarmAt: author.nextAlarmAt },
      { name: 'group-fav', queued: groupFav.queued, nextAlarmAt: groupFav.nextAlarmAt }
    ]
  };
}

/**
 * 获取调度器状态（调试用）。
 * 顶层作者字段仅表示“常规更新队列”；Burst 明细在 burst 字段单独展示。
 */
export async function getStatus(): Promise<SchedulerStatusResponse> {
  const [settings, authorCacheMap, feedCacheMap, groups, authorAlarm, groupFavAlarm] = await Promise.all([
    loadSettings(),
    liveAuthorCacheMap ?? loadAuthorVideoCacheMap(),
    loadFeedCacheMap(),
    loadGroups(),
    chrome.alarms.get(ALARM_NAMES.AUTHOR_VIDEO),
    chrome.alarms.get(ALARM_NAMES.GROUP_FAV)
  ]);

  const groupTitleMap = new Map<string, string>();
  for (const group of groups) {
    groupTitleMap.set(group.groupId, getGroupTitle(group));
  }

  const authorGroupNamesMap = new Map<number, Set<string>>();
  for (const cache of Object.values(feedCacheMap)) {
    const groupTitle = groupTitleMap.get(cache.groupId) ?? cache.groupId;
    for (const mid of cache.authorMids) {
      const names = authorGroupNamesMap.get(mid) ?? new Set<string>();
      names.add(groupTitle);
      authorGroupNamesMap.set(mid, names);
    }
  }

  function getGroupNamesForTask(mid: number, groupId?: string): string[] {
    const names = new Set<string>(authorGroupNamesMap.get(mid) ?? []);
    if (groupId) {
      names.add(groupTitleMap.get(groupId) ?? groupId);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }

  const authorCaches = Object.values(authorCacheMap)
    .map((item) => ({
      mid: item.mid,
      name: resolveAuthorName(item.name, item.videos, item.mid),
      groupNames: Array.from(authorGroupNamesMap.get(item.mid) ?? []).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
      videoCount: item.videos.length,
      lastFetchedAt: item.lastFetchedAt,
      face: item.face
    }))
    .sort((a, b) => b.lastFetchedAt - a.lastFetchedAt);

  const groupCaches = Object.values(feedCacheMap)
    .map((item) => ({
      groupId: item.groupId,
      title: groupTitleMap.get(item.groupId) ?? item.groupId,
      authorCount: item.authorMids.length,
      updatedAt: item.updatedAt
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const authorCurrentTask = authorState.currentTask;
  const authorQueue = authorState.queue.map((item) => ({
    mid: item.mid,
    name: item.name,
    groupId: item.groupId,
    pn: item.pn,
    reason: item.reason
  }));
  const burstCurrentTask = burstState.currentTask
    ? {
        mid: burstState.currentTask.mid,
        name: resolveDisplayName(burstState.currentTask.name),
        pn: burstState.currentTask.pn,
        reason: burstState.currentTask.reason,
        groupNames: getGroupNamesForTask(burstState.currentTask.mid, burstState.currentTask.groupId)
      }
    : null;
  const burstQueue = burstState.queue.map((item) => ({
    mid: item.mid,
    name: resolveDisplayName(item.name),
    pn: item.pn,
    reason: item.reason,
    groupNames: getGroupNamesForTask(item.mid, item.groupId)
  }));
  const burstCooldownReason: BurstCooldownReason = burstState.nextAllowedAt > Date.now() ? burstState.cooldownReason : null;

  return {
    schedulerBatchSize: normalizeBatchSize(settings),
    running: authorState.running,
    queueLength: authorState.queue.length,
    currentTask: authorCurrentTask
      ? {
          mid: authorCurrentTask.mid,
          name: authorCurrentTask.name,
          pn: authorCurrentTask.pn,
          reason: authorCurrentTask.reason
        }
      : null,
    batchCompleted: authorState.batchCompleted,
    batchFailed: authorState.batchFailed.length,
    lastRunAt: authorState.lastRunAt,
    nextAlarmAt: authorAlarm?.scheduledTime,
    queue: authorQueue,
    groupChannel: {
      running: groupFavState.running,
      queueLength: groupFavState.queue.length,
      currentTask: groupFavState.currentTask ? { groupId: groupFavState.currentTask.groupId } : null,
      batchCompleted: groupFavState.batchCompleted,
      batchFailed: groupFavState.batchFailed.length,
      lastRunAt: groupFavState.lastRunAt,
      nextAlarmAt: groupFavAlarm?.scheduledTime,
      queue: groupFavState.queue.map((item) => ({ groupId: item.groupId }))
    },
    burst: {
      running: burstState.running,
      queueLength: burstState.queue.length,
      currentTask: burstCurrentTask,
      nextAllowedAt: burstState.nextAllowedAt,
      cooldownReason: burstCooldownReason,
      lastRunAt: burstState.lastRunAt,
      queue: burstQueue
    },
    authorCaches,
    groupCaches,
    history
  };
}

/**
 * 记录“时间流构造实际使用到的页码”：
 * - 仅用于驱动后续常规预取推进；
 * - 不触发即时 API 请求。
 */
export async function reportAuthorPageUsage(
  _groupId: string,
  usedPages: MixedUsedPageItem[]
): Promise<void> {
  if (usedPages.length === 0) {
    return;
  }

  const authorCacheMap = liveAuthorCacheMap ?? await loadAuthorVideoCacheMap();
  const changed = markAuthorPageUsage(authorCacheMap, usedPages);
  if (changed) {
    await saveAuthorVideoCacheMap(authorCacheMap);
  }
}

/**
 * 提供给前台读取路径的作者缓存快照：
 * 调度器运行中优先返回内存实时缓存，避免读到 storage 的滞后数据。
 */
export async function getAuthorCacheSnapshot(): Promise<AuthorCacheMap> {
  return liveAuthorCacheMap ?? loadAuthorVideoCacheMap();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAMES.AUTHOR_VIDEO) {
    if (isBurstActive()) {
      pendingAuthorRoutineAfterBurst = true;
      return;
    }

    triggerAuthorRoutine({ resetAlarmSchedule: false }).catch((error) => {
      console.warn('[BBE] 作者 alarm 处理失败:', error);
    });
    return;
  }

  if (alarm.name === ALARM_NAMES.GROUP_FAV) {
    if (isBurstActive()) {
      pendingGroupFavRoutineAfterBurst = true;
      return;
    }

    triggerGroupFavRoutine({ resetAlarmSchedule: false }).catch((error) => {
      console.warn('[BBE] 收藏夹 alarm 处理失败:', error);
    });
  }
});
