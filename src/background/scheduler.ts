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
  refreshAuthorCache,
  type AuthorCacheMap
} from '@/background/feed-service';
import { getMyCreatedFolders } from '@/shared/api/bilibili';

export interface SchedulerTask {
  mid: number;
  name: string;
  groupId?: string;
}

interface GroupFavTask {
  groupId: string;
}

const MAX_HISTORY = 50;
const BURST_RETRY_DELAY_MS = 60_000;

type AuthorTask = SchedulerTask;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function resolveAuthorName(name: string | undefined, videos: Array<{ authorName: string }>, mid: number): string {
  const cacheName = name?.trim();
  const isNumeric = !!cacheName && /^\d+$/.test(cacheName);
  const videoName = videos.find((item) => item.authorName?.trim())?.authorName?.trim();
  if (cacheName && !isNumeric) return cacheName;
  if (videoName) return videoName;
  if (cacheName) return cacheName;
  return String(mid);
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
  authorState.queue = authorState.queue.filter((task) => !taskKeys.has(String(task.mid)));
}

function markRoutineCompensationPending(): void {
  pendingAuthorRoutineAfterBurst = true;
  pendingGroupFavRoutineAfterBurst = true;
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
      stale.push({
        mid,
        name: cache.name ?? String(mid),
        lastFetchedAt: cache.lastFetchedAt ?? 0
      });
    }
  }

  stale.sort((a, b) => a.lastFetchedAt - b.lastFetchedAt);
  return stale.map(({ mid, name }) => ({ mid, name }));
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
    .map((mid) => ({ mid, name: String(mid) }));
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
      lastFetchedAt: cache.lastFetchedAt ?? 0
    });
  }

  oldest.sort((a, b) => a.lastFetchedAt - b.lastFetchedAt);
  return oldest.map(({ mid, name }) => ({ mid, name }));
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
  await refreshAuthorCache(task.mid, task.name, authorCacheMap);
}

/**
 * 刷新单个分组的收藏夹缓存：重建作者列表并同步收藏夹标题。
 * 完成后会把该分组作者任务优先插入作者通道。
 */
async function runGroupFavTask(task: GroupFavTask): Promise<void> {
  const [groups, feedCacheMap, authorCacheMap] = await Promise.all([
    loadGroups(),
    loadFeedCacheMap(),
    loadAuthorVideoCacheMap()
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

  const tasks: AuthorTask[] = authors.map((author) => ({
    mid: author.mid,
    name: authorCacheMap[author.mid]?.name ?? author.name,
    groupId: group.groupId
  }));

  const burstTasks: AuthorTask[] = [];
  const priorityTasks: AuthorTask[] = [];
  for (const task of tasks) {
    if (!authorCacheMap[task.mid]) {
      burstTasks.push(task);
    } else {
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
    } catch (error) {
      burstState.nextAllowedAt = Date.now() + BURST_RETRY_DELAY_MS;
      burstState.cooldownReason = 'error';
      pushHistory({
        mid: task.mid,
        name: task.name,
        mode: 'burst',
        success: false,
        timestamp: Date.now(),
        error: error instanceof Error ? error.message : String(error)
      });
      console.warn('[BBE] Burst 作者任务刷新失败 mid:', task.mid, error);
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
  const taskKeys = new Set(tasks.map((task) => String(task.mid)));
  const added = dedupeAndEnqueue(burstState, tasks, (task) => String(task.mid), false);
  if (taskKeys.size > 0) {
    // Burst 任务优先级高于常规作者队列，入列后清掉常规队列里的同目标，避免重复调用。
    removeAuthorTasksFromRegularQueue(taskKeys);
    markRoutineCompensationPending();
  }
  if (added > 0 && !hasRunningRegularTask()) {
    startBurstLoopIfIdle();
  }
  return added;
}

export function enqueuePriority(tasks: SchedulerTask[]): number {
  if (tasks.length === 0) {
    return 0;
  }

  const burstKeys = buildExistingTaskKeySet(burstState, (task) => String(task.mid));
  const filtered = tasks.filter((task) => !burstKeys.has(String(task.mid)));
  const added = dedupeAndEnqueue(authorState, filtered, (task) => String(task.mid), true);
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

  const [noCacheTasks, staleTasks] = await Promise.all([collectNoCacheAuthorTasks(), collectStaleAuthorTasks(settings)]);
  const burstQueued = enqueueBurst(noCacheTasks);
  authorState.currentBatchDelay = calcBatchDelay(staleTasks.length, interval, normalizeBatchSize(settings));
  const normalQueued = dedupeAndEnqueue(authorState, staleTasks, (task) => String(task.mid), false);
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
  const normalQueued = fillQueueToBatchSize(authorState, candidates, (task) => String(task.mid), batchSize);
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
 * 顶层字段保持与历史结构兼容，默认展示作者通道状态。
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

  const authorCurrentTask = burstState.currentTask ?? authorState.currentTask;
  const authorQueue = [
    ...burstState.queue.map((item) => ({ mid: item.mid, name: item.name, groupId: item.groupId })),
    ...authorState.queue.map((item) => ({ mid: item.mid, name: item.name, groupId: item.groupId }))
  ];
  const burstCurrentTask = burstState.currentTask
    ? { mid: burstState.currentTask.mid, groupNames: getGroupNamesForTask(burstState.currentTask.mid, burstState.currentTask.groupId) }
    : null;
  const burstQueue = burstState.queue.map((item) => ({
    mid: item.mid,
    groupNames: getGroupNamesForTask(item.mid, item.groupId)
  }));
  const burstCooldownReason: BurstCooldownReason = burstState.nextAllowedAt > Date.now() ? burstState.cooldownReason : null;

  return {
    schedulerBatchSize: normalizeBatchSize(settings),
    running: burstState.running || authorState.running,
    queueLength: burstState.queue.length + authorState.queue.length,
    currentTask: authorCurrentTask ? { mid: authorCurrentTask.mid, name: authorCurrentTask.name } : null,
    batchCompleted: authorState.batchCompleted,
    batchFailed: authorState.batchFailed.length,
    lastRunAt: burstState.lastRunAt ?? authorState.lastRunAt,
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
