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
  loadSchedulerHistory,
  loadSettings,
  saveAuthorVideoCacheMap,
  saveFeedCacheMap,
  saveGroups,
  saveSchedulerHistory
} from '@/shared/storage/repository';
import { ext } from '@/shared/platform/webext';
import type { ExtensionSettings, GroupConfig } from '@/shared/types';
import type {
  SchedulerAuthorTaskReason,
  SchedulerStatusResponse,
  SchedulerTaskReason,
  SchedulerTaskTrigger
} from '@/shared/messages';
import {
  buildAuthorListFromFav,
  canReconnectContinuousHead,
  getAuthorPageCount,
  hasAuthorMorePages,
  isAuthorCacheExpired,
  refreshAuthorCache,
  type AuthorCacheMap,
  type MixedUsedPageItem
} from '@/background/feed-service';
import { BilibiliApiError, getMyCreatedFolders, likeVideo } from '@/shared/api/bilibili';
import { runWithLikeRequestHeaders } from '@/background/request-dnr';
import { WbiExpiredError } from '@/shared/utils/wbi';

export interface SchedulerTask {
  mid: number;
  name: string;
  groupId?: string;
  pn?: number;
  ps?: number;
  reason?: SchedulerAuthorTaskReason;
  trigger?: SchedulerTaskTrigger;
  staleAt?: number;
  queueOrderClass?: number;
  requestContext?: SchedulerRequestContext;
  requestSeq?: number;
  forceRefreshCurrentPage?: boolean;
  ensureContinuousFromHead?: boolean;
  // 仅用于“前台同步等待”的补页任务：失败后不重试，直接回传错误。
  failFast?: boolean;
}

export interface SchedulerRequestContext {
  requestAt: number;
  requestBatchId: string;
}

interface SchedulerOrderMeta {
  requestAt: number;
  requestBatchId: string;
  requestSeq: number;
  enqueueSeq: number;
}

interface QueueOrderMeta extends SchedulerOrderMeta {
  queueOrderClass: number;
  staleAt: number;
}

interface GroupFavTaskInput {
  groupId: string;
  trigger: SchedulerTaskTrigger;
  authorRefreshMode: 'stale' | 'force' | 'none';
  staleAt?: number;
  queueOrderClass?: number;
  requestContext?: SchedulerRequestContext;
  requestSeq?: number;
}

interface GroupFavTask extends Omit<GroupFavTaskInput, 'staleAt' | 'queueOrderClass' | 'requestContext' | 'requestSeq'>, QueueOrderMeta {}

interface LikePageContext {
  tabId: number;
  pageOrigin: string;
  pageReferer: string;
}

interface LikeActionTask {
  key: `like:${string}`;
  aid: number;
  bvid: string;
  authorMid: number;
  csrf: string;
  action: 'like' | 'unlike';
  source: 'single-card-toggle' | 'author-batch-like';
  trigger: 'manual-click';
  pageContext: LikePageContext;
}

const MAX_HISTORY = 50;
const BURST_RETRY_DELAY_MS = 60_000;
const GLOBAL_WBI_RETRY_DELAY_MS = 60_000;

type AuthorTask =
  Required<Pick<SchedulerTask, 'mid' | 'name' | 'pn' | 'ps' | 'reason' | 'failFast' | 'trigger'>>
  & Required<Pick<SchedulerTask, 'staleAt' | 'queueOrderClass' | 'requestSeq'>>
  & Pick<SchedulerTask, 'groupId' | 'forceRefreshCurrentPage' | 'ensureContinuousFromHead'>
  & SchedulerOrderMeta;
type BurstCooldownReason = 'intra-delay' | 'error' | null;

export interface LikeTaskResult {
  aid: number;
  bvid: string;
  liked: boolean;
  authorMid: number;
  source: 'single-card-toggle' | 'author-batch-like';
}

export interface LikeBatchResult {
  authorMid: number;
  total: number;
  successCount: number;
  failedCount: number;
  failedBvids: string[];
}

export interface EnqueuedLikeBatch {
  authorMid: number;
  total: number;
  queuedCount: number;
  queuedBvids: string[];
  skippedBvids: string[];
  completion: Promise<LikeBatchResult>;
}

interface HistoryEntry {
  channel: 'author-video' | 'group-fav' | 'like-action';
  mid?: number;
  groupId?: string;
  bvid?: string;
  aid?: number;
  pn?: number;
  name: string;
  mode: 'regular' | 'burst';
  success: boolean;
  timestamp: number;
  taskReason: SchedulerTaskReason;
  trigger: SchedulerTaskTrigger;
  error?: string;
}

interface LikeTaskWaiterResult {
  ok: boolean;
  result?: LikeTaskResult;
  error?: string;
}

interface GlobalCooldownState {
  nextAllowedAt: number;
  reason: 'wbi-ratelimit' | null;
  lastTriggeredAt?: number;
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
const likeActionState = createChannelState<LikeActionTask>();
const burstState = createBurstState();
const history: HistoryEntry[] = [];
let historyHydrated = false;
let historyPersistTimer: ReturnType<typeof setTimeout> | null = null;
let requestBatchCounter = 0;
let enqueueSequence = 0;
// 全局风控冷却门：命中 WBI 重试失败后，所有通道统一暂停请求一段时间。
const globalCooldownState: GlobalCooldownState = {
  nextAllowedAt: 0,
  reason: null
};

let pendingAuthorRoutineAfterBurst = false;
let pendingGroupFavRoutineAfterBurst = false;

// 作者通道运行期间暴露内存引用，避免调试面板读到过时快照。
let liveAuthorCacheMap: AuthorCacheMap | null = null;
const burstTaskWaiters = new Map<string, Array<(result: { ok: boolean; error?: string }) => void>>();
const burstTaskFirstResultListeners = new Map<string, Array<(result: { ok: boolean; error?: string }) => void>>();
const likeTaskWaiters = new Map<string, Array<(result: LikeTaskWaiterResult) => void>>();
void ensureHistoryHydrated();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWbiRatelimitError(error: unknown): error is WbiExpiredError {
  return error instanceof WbiExpiredError;
}

function triggerGlobalWbiCooldown(): void {
  const now = Date.now();
  globalCooldownState.nextAllowedAt = now + GLOBAL_WBI_RETRY_DELAY_MS;
  globalCooldownState.reason = 'wbi-ratelimit';
  globalCooldownState.lastTriggeredAt = now;
}

/**
 * 请求发起前统一经过全局冷却门，避免多通道在风控窗口内继续冲击 API。
 */
async function waitForGlobalCooldownIfNeeded(): Promise<void> {
  while (true) {
    const waitMs = globalCooldownState.nextAllowedAt - Date.now();
    if (waitMs <= 0) {
      return;
    }
    await sleep(waitMs);
  }
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

function notifyBurstTaskFirstResult(task: AuthorTask, result: { ok: boolean; error?: string }): void {
  const key = keyOfAuthorTask(task);
  const listeners = burstTaskFirstResultListeners.get(key);
  if (!listeners || listeners.length === 0) {
    return;
  }
  burstTaskFirstResultListeners.delete(key);
  for (const listener of listeners) {
    listener(result);
  }
}

function notifyLikeTaskFinished(task: LikeActionTask, result: LikeTaskWaiterResult): void {
  const key = keyOfLikeTask(task);
  const waiters = likeTaskWaiters.get(key);
  if (!waiters || waiters.length === 0) {
    return;
  }
  likeTaskWaiters.delete(key);
  for (const waiter of waiters) {
    waiter(result);
  }
}

function waitForLikeTask(task: LikeActionTask): Promise<LikeTaskWaiterResult> {
  const key = keyOfLikeTask(task);
  return new Promise((resolve) => {
    const waiters = likeTaskWaiters.get(key) ?? [];
    waiters.push(resolve);
    likeTaskWaiters.set(key, waiters);
  });
}

async function ensureHistoryHydrated(): Promise<void> {
  if (historyHydrated) {
    return;
  }
  historyHydrated = true;
  try {
    const persisted = await loadSchedulerHistory();
    if (persisted.length > 0) {
      history.splice(0, history.length, ...persisted.slice(0, MAX_HISTORY));
    }
  } catch (error) {
    console.warn('[BBE] 读取调度历史失败:', error);
  }
}

function schedulePersistHistory(): void {
  if (historyPersistTimer) {
    return;
  }
  historyPersistTimer = setTimeout(() => {
    historyPersistTimer = null;
    void saveSchedulerHistory(history).catch((error) => {
      console.warn('[BBE] 保存调度历史失败:', error);
    });
  }, 200);
}

function pushHistory(entry: HistoryEntry): void {
  history.unshift(entry);
  if (history.length > MAX_HISTORY) {
    history.length = MAX_HISTORY;
  }
  schedulePersistHistory();
}

function getGroupTitle(group: GroupConfig): string {
  return group.alias?.trim() || group.mediaTitle || group.groupId;
}

export function createSchedulerRequestContext(): SchedulerRequestContext {
  const requestAt = Date.now();
  requestBatchCounter += 1;
  return {
    requestAt,
    requestBatchId: `req:${requestAt}:${requestBatchCounter}`
  };
}

function inheritSchedulerRequestContext(task: Pick<SchedulerOrderMeta, 'requestAt' | 'requestBatchId'>): SchedulerRequestContext {
  return {
    requestAt: task.requestAt,
    requestBatchId: task.requestBatchId
  };
}

function keyOfAuthorTask(task: Pick<SchedulerTask, 'mid' | 'pn' | 'ps'>): string {
  return `${task.mid}:${Math.max(1, Number(task.pn) || 1)}:${Math.max(1, Number(task.ps) || 1)}`;
}

function keyOfLikeTask(task: Pick<LikeActionTask, 'bvid'>): LikeActionTask['key'] {
  return `like:${task.bvid}`;
}

function buildAuthorTaskBase(task: SchedulerTask): Omit<AuthorTask, keyof SchedulerOrderMeta | 'staleAt' | 'queueOrderClass' | 'requestSeq'> {
  return {
    mid: task.mid,
    name: task.name?.trim() || String(task.mid),
    groupId: task.groupId,
    pn: Math.max(1, Number(task.pn) || 1),
    ps: Math.max(1, Number(task.ps) || 1),
    reason: task.reason ?? 'first-page-refresh',
    trigger: task.trigger ?? 'alarm-routine',
    forceRefreshCurrentPage: task.forceRefreshCurrentPage === true,
    ensureContinuousFromHead: task.ensureContinuousFromHead === true,
    failFast: task.failFast === true
  };
}

function resolveRegularAuthorQueueOrderClass(task: SchedulerTask): number {
  if (typeof task.queueOrderClass === 'number') {
    return task.queueOrderClass;
  }
  if (task.reason === 'extend-continuous-window') {
    return 2;
  }
  if (task.trigger === 'debug-run-now') {
    return 3;
  }
  if (task.trigger === 'alarm-routine') {
    return 1;
  }
  return 0;
}

function resolveBurstQueueOrderClass(task: SchedulerTask): number {
  if (typeof task.queueOrderClass === 'number') {
    return task.queueOrderClass;
  }
  if (task.trigger === 'request-author-page' || task.reason === 'request-author-page' || task.reason === 'refresh-author-current-page') {
    return 1;
  }
  return 2;
}

function normalizeRegularAuthorTask(task: SchedulerTask, requestContext: SchedulerRequestContext, requestSeq: number): AuthorTask {
  return {
    ...buildAuthorTaskBase(task),
    staleAt: Math.max(0, Number(task.staleAt) || 0),
    queueOrderClass: resolveRegularAuthorQueueOrderClass(task),
    requestAt: task.requestContext?.requestAt ?? requestContext.requestAt,
    requestBatchId: task.requestContext?.requestBatchId ?? requestContext.requestBatchId,
    requestSeq: task.requestSeq ?? requestSeq,
    enqueueSeq: ++enqueueSequence
  };
}

function normalizeBurstAuthorTask(task: SchedulerTask, requestContext: SchedulerRequestContext, requestSeq: number): AuthorTask {
  return {
    ...buildAuthorTaskBase(task),
    staleAt: Math.max(0, Number(task.staleAt) || 0),
    queueOrderClass: resolveBurstQueueOrderClass(task),
    requestAt: task.requestContext?.requestAt ?? requestContext.requestAt,
    requestBatchId: task.requestContext?.requestBatchId ?? requestContext.requestBatchId,
    requestSeq: task.requestSeq ?? requestSeq,
    enqueueSeq: ++enqueueSequence
  };
}

function resolveGroupFavQueueOrderClass(task: GroupFavTaskInput): number {
  if (typeof task.queueOrderClass === 'number') {
    return task.queueOrderClass;
  }
  if (task.trigger === 'manual-refresh-posts' || task.trigger === 'manual-refresh-fav') {
    return 0;
  }
  if (task.trigger === 'get-group-feed-missing-fav-cache' || task.trigger === 'group-created-auto-refresh') {
    return 1;
  }
  if (task.trigger === 'alarm-routine') {
    return 2;
  }
  if (task.trigger === 'debug-run-now') {
    return 3;
  }
  return 1;
}

function normalizeGroupFavTask(task: GroupFavTaskInput, requestContext: SchedulerRequestContext, requestSeq: number): GroupFavTask {
  return {
    groupId: task.groupId,
    trigger: task.trigger,
    authorRefreshMode: task.authorRefreshMode,
    staleAt: Math.max(0, Number(task.staleAt) || 0),
    queueOrderClass: resolveGroupFavQueueOrderClass(task),
    requestAt: task.requestContext?.requestAt ?? requestContext.requestAt,
    requestBatchId: task.requestContext?.requestBatchId ?? requestContext.requestBatchId,
    requestSeq: task.requestSeq ?? requestSeq,
    enqueueSeq: ++enqueueSequence
  };
}

function compareTaskRequestPriority(
  left: Pick<QueueOrderMeta, 'queueOrderClass' | 'requestAt' | 'requestSeq'>,
  right: Pick<QueueOrderMeta, 'queueOrderClass' | 'requestAt' | 'requestSeq'>
): number {
  return left.queueOrderClass - right.queueOrderClass
    || left.requestAt - right.requestAt
    || left.requestSeq - right.requestSeq;
}

function compareQueueOrderedTask(
  left: Pick<QueueOrderMeta, 'queueOrderClass' | 'requestAt' | 'staleAt' | 'requestSeq' | 'enqueueSeq'>,
  right: Pick<QueueOrderMeta, 'queueOrderClass' | 'requestAt' | 'staleAt' | 'requestSeq' | 'enqueueSeq'>
): number {
  return left.queueOrderClass - right.queueOrderClass
    || left.requestAt - right.requestAt
    || left.staleAt - right.staleAt
    || left.requestSeq - right.requestSeq
    || left.enqueueSeq - right.enqueueSeq;
}

function mergeQueueOrderMeta(target: QueueOrderMeta, incoming: QueueOrderMeta): void {
  if (compareTaskRequestPriority(incoming, target) < 0) {
    target.queueOrderClass = incoming.queueOrderClass;
    target.requestAt = incoming.requestAt;
    target.requestBatchId = incoming.requestBatchId;
    target.requestSeq = incoming.requestSeq;
  }
  target.staleAt = Math.min(target.staleAt, incoming.staleAt);
}

function mergeAuthorTaskCapabilities(target: AuthorTask, incoming: AuthorTask): void {
  target.groupId = target.groupId || incoming.groupId;
  target.name = target.name || incoming.name;
  if (incoming.reason === 'refresh-author-current-page') {
    target.reason = incoming.reason;
  }
  if (incoming.forceRefreshCurrentPage) {
    target.forceRefreshCurrentPage = true;
  }
  if (incoming.ensureContinuousFromHead) {
    target.ensureContinuousFromHead = true;
  }
  if (incoming.failFast) {
    target.failFast = true;
  }
  mergeQueueOrderMeta(target, incoming);
}

function normalizeLikePageContext(pageContext: LikePageContext): LikePageContext {
  return {
    tabId: Number(pageContext.tabId),
    pageOrigin: pageContext.pageOrigin?.trim() || '',
    pageReferer: pageContext.pageReferer?.trim() || ''
  };
}

function normalizeLikeActionTask(task: LikeActionTask): LikeActionTask {
  const aid = Math.max(0, Math.floor(Number(task.aid) || 0));
  const bvid = task.bvid?.trim() || '';
  const authorMid = Math.max(1, Math.floor(Number(task.authorMid) || 0));
  if (!aid || !bvid || !authorMid) {
    throw new Error('点赞任务参数不完整');
  }

  return {
    key: keyOfLikeTask({ bvid }),
    aid,
    bvid,
    authorMid,
    csrf: task.csrf?.trim() || '',
    action: task.action === 'unlike' ? 'unlike' : 'like',
    source: task.source,
    trigger: 'manual-click',
    pageContext: normalizeLikePageContext(task.pageContext)
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

function dedupeMergeAndSort<TTask>(
  state: QueueState<TTask>,
  tasks: TTask[],
  keyOf: (task: TTask) => string,
  mergeExisting: (target: TTask, incoming: TTask) => void,
  compare: (left: TTask, right: TTask) => number
): number {
  const queuedMap = new Map<string, TTask>();
  for (const item of state.queue) {
    queuedMap.set(keyOf(item), item);
  }

  let added = 0;
  for (const task of tasks) {
    const key = keyOf(task);
    if (state.currentTask && keyOf(state.currentTask) === key) {
      mergeExisting(state.currentTask, task);
      continue;
    }
    const existing = queuedMap.get(key);
    if (existing) {
      mergeExisting(existing, task);
      continue;
    }
    state.queue.push(task);
    queuedMap.set(key, task);
    added += 1;
  }

  if (state.queue.length > 1) {
    // 队列内统一按排序键重排，保证“旧请求优先”与“同批更旧缓存优先”稳定生效。
    state.queue.sort(compare);
  }
  return added;
}

/**
 * 调试页“立刻发起调度”使用的补齐策略：
 * 仅挑出要补的候选任务，不在这里直接改队列，后续仍统一走正常入队与排序逻辑。
 */
function pickTasksToBatchSize<TTask>(
  state: QueueState<TTask>,
  candidates: TTask[],
  keyOf: (task: TTask) => string,
  batchSize: number
): TTask[] {
  const need = Math.max(0, batchSize - state.queue.length);
  if (need === 0 || candidates.length === 0) {
    return [];
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

  return picked;
}

function getExistingLikeActionByBvid(bvid: string): LikeActionTask | null {
  if (likeActionState.currentTask?.bvid === bvid) {
    return likeActionState.currentTask;
  }
  return likeActionState.queue.find((task) => task.bvid === bvid) ?? null;
}

function isBurstActive(): boolean {
  return burstState.running || burstState.queue.length > 0;
}

function hasRunningRegularTask(): boolean {
  return authorState.running || groupFavState.running;
}

function getGroupFavAuthorRefreshModePriority(mode: GroupFavTask['authorRefreshMode']): number {
  if (mode === 'force') return 2;
  if (mode === 'stale') return 1;
  return 0;
}

function mergeGroupFavTask(target: GroupFavTask, incoming: GroupFavTask): void {
  if (getGroupFavAuthorRefreshModePriority(incoming.authorRefreshMode) > getGroupFavAuthorRefreshModePriority(target.authorRefreshMode)) {
    target.authorRefreshMode = incoming.authorRefreshMode;
    target.trigger = incoming.trigger;
  }
  mergeQueueOrderMeta(target, incoming);
}

function removeAuthorTasksFromRegularQueue(taskKeys: Set<string>): void {
  if (taskKeys.size === 0 || authorState.queue.length === 0) {
    return;
  }
  authorState.queue = authorState.queue.filter((task) => !taskKeys.has(keyOfAuthorTask(task)));
}

function enqueueRegularAuthorTasks(tasks: SchedulerTask[], requestContext?: SchedulerRequestContext): number {
  if (tasks.length === 0) {
    return 0;
  }
  const context = requestContext ?? createSchedulerRequestContext();
  const normalizedTasks = tasks.map((task, index) => normalizeRegularAuthorTask(task, context, index));
  return dedupeMergeAndSort(authorState, normalizedTasks, keyOfAuthorTask, mergeAuthorTaskCapabilities, compareQueueOrderedTask);
}

function enqueueBurstTasks(tasks: SchedulerTask[], requestContext?: SchedulerRequestContext): number {
  if (tasks.length === 0) {
    return 0;
  }
  const context = requestContext ?? createSchedulerRequestContext();
  const normalizedTasks = tasks.map((task, index) => normalizeBurstAuthorTask(task, context, index));
  return dedupeMergeAndSort(burstState, normalizedTasks, keyOfAuthorTask, mergeAuthorTaskCapabilities, compareQueueOrderedTask);
}

function enqueueGroupFavTasks(tasks: GroupFavTaskInput[], requestContext?: SchedulerRequestContext): number {
  if (tasks.length === 0) {
    return 0;
  }
  const context = requestContext ?? createSchedulerRequestContext();
  const normalizedTasks = tasks.map((task, index) => normalizeGroupFavTask(task, context, index));
  return dedupeMergeAndSort(groupFavState, normalizedTasks, (task) => task.groupId, mergeGroupFavTask, compareQueueOrderedTask);
}

async function resetAlarm(alarmName: string, intervalMinutes: number): Promise<number | undefined> {
  await ext.alarms.clear(alarmName);
  ext.alarms.create(alarmName, {
    delayInMinutes: intervalMinutes,
    periodInMinutes: intervalMinutes
  });
  const alarm = await ext.alarms.get(alarmName);
  return alarm?.scheduledTime;
}

async function collectStaleAuthorTasks(
  settings: ExtensionSettings,
  trigger: SchedulerTaskTrigger
): Promise<SchedulerTask[]> {
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
      const firstFetchedAt = cache.lastFirstPageFetchedAt || cache.firstPageFetchedAt || cache.lastFetchedAt || 0;
      stale.push({
        mid,
        name: cache.name ?? String(mid),
        lastFetchedAt: firstFetchedAt
      });
    }
  }

  stale.sort((a, b) => a.lastFetchedAt - b.lastFetchedAt);
  return stale.map(({ mid, name, lastFetchedAt }) => ({
    mid,
    name,
    pn: 1,
    ps: settings.authorVideosPageSize,
    staleAt: lastFetchedAt,
    reason: 'first-page-refresh',
    trigger,
    failFast: false
  }));
}

async function collectNoCacheAuthorTasks(
  settings: ExtensionSettings,
  trigger: SchedulerTaskTrigger
): Promise<SchedulerTask[]> {
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
      ps: settings.authorVideosPageSize,
      staleAt: 0,
      reason: 'first-page-refresh',
      trigger,
      failFast: false
    }));
}

async function collectOldestAuthorTasks(
  settings: ExtensionSettings,
  trigger: SchedulerTaskTrigger
): Promise<SchedulerTask[]> {
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
      lastFetchedAt: cache.lastFirstPageFetchedAt || cache.firstPageFetchedAt || cache.lastFetchedAt || 0
    });
  }

  oldest.sort((a, b) => a.lastFetchedAt - b.lastFetchedAt);
  return oldest.map(({ mid, name, lastFetchedAt }) => ({
    mid,
    name,
    pn: 1,
    ps: settings.authorVideosPageSize,
    staleAt: lastFetchedAt,
    reason: 'first-page-refresh',
    trigger,
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
  cache: AuthorCacheMap[number],
  settings: ExtensionSettings
): number | null {
  if (!hasAuthorMorePages(cache)) {
    return null;
  }

  if (!isPageFresh(cache.lastFirstPageFetchedAt || cache.firstPageFetchedAt, settings)) {
    return null;
  }

  const pageSize = Math.max(1, settings.authorVideosPageSize);
  const targetLength = (2 + Math.max(1, settings.authorContinuousExtraPageCount)) * pageSize;
  if ((cache.continuousVideos?.length ?? 0) >= targetLength) {
    return null;
  }

  const nextStartIndex = cache.continuousVideos?.length ?? 0;
  return Math.max(2, Math.floor(nextStartIndex / pageSize) + 1);
}

async function collectPrefetchAuthorTasks(
  settings: ExtensionSettings,
  trigger: SchedulerTaskTrigger
): Promise<SchedulerTask[]> {
  const authorCacheMap = await loadAuthorVideoCacheMap();
  const tasks: SchedulerTask[] = [];

  for (const cache of Object.values(authorCacheMap)) {
    const pn = resolveNextPrefetchPn(cache, settings);
    if (!pn) {
      continue;
    }
    tasks.push({
      mid: cache.mid,
      name: cache.name ?? String(cache.mid),
      pn,
      ps: settings.authorVideosPageSize,
      staleAt: cache.lastFirstPageFetchedAt || cache.firstPageFetchedAt || cache.lastFetchedAt || 0,
      reason: 'extend-continuous-window',
      trigger,
      failFast: false
    });
  }

  tasks.sort((a, b) => a.mid - b.mid || (Number(a.pn) || 1) - (Number(b.pn) || 1));
  return tasks;
}

async function collectStaleGroupFavTasks(
  settings: ExtensionSettings,
  trigger: SchedulerTaskTrigger
): Promise<GroupFavTaskInput[]> {
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
  return stale.map((item) => ({
    groupId: item.groupId,
    staleAt: item.updatedAt,
    trigger,
    authorRefreshMode: 'stale'
  }));
}

async function collectOldestGroupFavTasks(trigger: SchedulerTaskTrigger): Promise<GroupFavTaskInput[]> {
  const [groups, feedCacheMap] = await Promise.all([loadGroups(), loadFeedCacheMap()]);
  const oldest: Array<{ groupId: string; updatedAt: number }> = [];

  for (const group of groups) {
    if (!group.enabled) continue;
    const cache = feedCacheMap[group.groupId];
    oldest.push({ groupId: group.groupId, updatedAt: cache?.updatedAt ?? 0 });
  }

  oldest.sort((a, b) => a.updatedAt - b.updatedAt);
  return oldest.map((item) => ({
    groupId: item.groupId,
    staleAt: item.updatedAt,
    trigger,
    authorRefreshMode: 'stale'
  }));
}

async function runAuthorTask(task: AuthorTask, authorCacheMap: AuthorCacheMap): Promise<void> {
  const settings = await loadSettings();
  const previousContinuous = (authorCacheMap[task.mid]?.continuousVideos ?? []).slice();
  const fetchCard = task.reason !== 'request-author-page' && task.reason !== 'refresh-author-current-page';
  let latestCache = await refreshAuthorCache(task.mid, task.name, authorCacheMap, settings, {
    pn: task.pn,
    ps: task.ps,
    // 用户主动翻页/作者级局部刷新只需要页数据，不要顺带请求 Card API。
    fetchCard
  });

  if (!task.ensureContinuousFromHead || task.pn !== 1 || previousContinuous.length === 0) {
    return;
  }
  if (canReconnectContinuousHead(latestCache.continuousVideos, previousContinuous)) {
    return;
  }

  let nextPage = 2;
  while (true) {
    // “近期投稿”作者级刷新要求从首页继续顺序补抓，
    // 直到新头部连续段重新接上旧连续缓存，或明确确认没有更多页为止。
    const maxPage = getAuthorPageCount(latestCache, task.ps);
    if (typeof maxPage === 'number' && nextPage > maxPage) {
      return;
    }
    if (typeof maxPage !== 'number' && !hasAuthorMorePages(latestCache)) {
      return;
    }

    latestCache = await refreshAuthorCache(task.mid, task.name, authorCacheMap, settings, {
      pn: nextPage,
      ps: task.ps,
      fetchCard: false
    });

    if (canReconnectContinuousHead(latestCache.continuousVideos, previousContinuous)) {
      return;
    }
    if (!hasAuthorMorePages(latestCache)) {
      return;
    }
    nextPage += 1;
  }
}

/**
 * 刷新单个分组的收藏夹缓存：重建作者列表并同步收藏夹标题。
 * 是否继续衔接作者投稿刷新，由任务上的 authorRefreshMode 显式决定。
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

  if (task.authorRefreshMode === 'none') {
    return;
  }

  const requestContext = inheritSchedulerRequestContext(task);
  const burstTasks: SchedulerTask[] = [];
  const priorityTasks: SchedulerTask[] = [];
  const forceAuthorRefresh = task.authorRefreshMode === 'force';
  for (const author of authors) {
    const cache = authorCacheMap[author.mid];
    const authorTask: SchedulerTask = {
      mid: author.mid,
      name: cache?.name ?? author.name,
      groupId: group.groupId,
      pn: 1,
      ps: settings.authorVideosPageSize,
      staleAt: cache?.lastFirstPageFetchedAt || cache?.firstPageFetchedAt || cache?.lastFetchedAt || 0,
      reason: 'first-page-refresh',
      trigger: forceAuthorRefresh ? 'manual-refresh-posts' : 'group-fav-chain',
      failFast: false
    };

    if (!cache) {
      burstTasks.push(authorTask);
      continue;
    }

    // “刷新投稿列表”需要强制刷新该分组作者首页；其他链路只补“已有缓存但已过期”的目标。
    if (forceAuthorRefresh || isAuthorCacheExpired(cache, settings)) {
      priorityTasks.push(authorTask);
    }
  }

  enqueueBurst(burstTasks, requestContext);
  enqueuePriority(priorityTasks, requestContext);
}

async function runLikeTask(task: LikeActionTask): Promise<LikeTaskResult> {
  const csrf = task.csrf?.trim();
  if (!csrf) {
    throw new Error('点赞参数不完整');
  }

  try {
    await runWithLikeRequestHeaders(task.pageContext.pageOrigin, task.pageContext.pageReferer, async () => {
      await likeVideo(
        {
          aid: task.aid,
          bvid: task.bvid
        },
        task.action === 'like',
        csrf
      );
    });
  } catch (error) {
    // 65006 表示服务端已经处于“已点赞”状态。这里直接回写 liked=true，
    // 避免把用户当前的“点赞”意图误处理成一次取消赞。
    if (task.action === 'like' && error instanceof BilibiliApiError && error.code === 65006) {
      return {
        aid: task.aid,
        bvid: task.bvid,
        liked: true,
        authorMid: task.authorMid,
        source: task.source
      };
    }
    throw error;
  }

  return {
    aid: task.aid,
    bvid: task.bvid,
    liked: task.action === 'like',
    authorMid: task.authorMid,
    source: task.source
  };
}

async function runLikeActionLoop(): Promise<void> {
  if (likeActionState.running) return;

  likeActionState.running = true;
  likeActionState.lastRunAt = Date.now();

  while (likeActionState.queue.length > 0) {
    const task = likeActionState.queue.shift()!;
    likeActionState.currentTask = task;

    try {
      const result = await runLikeTask(task);
      likeActionState.batchCompleted++;
      pushHistory({
        channel: 'like-action',
        mid: task.authorMid,
        bvid: task.bvid,
        aid: task.aid,
        name: task.bvid,
        mode: 'regular',
        success: true,
        timestamp: Date.now(),
        taskReason: task.action === 'like'
          ? (task.source === 'single-card-toggle' ? 'single-card-like' : 'author-batch-like')
          : 'single-card-unlike',
        trigger: task.trigger
      });
      notifyLikeTaskFinished(task, { ok: true, result });
    } catch (error) {
      likeActionState.batchFailed.push(task);
      pushHistory({
        channel: 'like-action',
        mid: task.authorMid,
        bvid: task.bvid,
        aid: task.aid,
        name: task.bvid,
        mode: 'regular',
        success: false,
        timestamp: Date.now(),
        taskReason: task.action === 'like'
          ? (task.source === 'single-card-toggle' ? 'single-card-like' : 'author-batch-like')
          : 'single-card-unlike',
        trigger: task.trigger,
        error: error instanceof Error ? error.message : String(error)
      });
      notifyLikeTaskFinished(task, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
      console.warn('[BBE] 点赞任务执行失败 bvid:', task.bvid, error);
    } finally {
      likeActionState.currentTask = null;
    }

    if (likeActionState.queue.length > 0) {
      await sleep(BG_REFRESH_INTRA_DELAY_MS);
    }
  }

  likeActionState.batchFailed = [];
  likeActionState.batchCompleted = 0;
  likeActionState.running = false;
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

    await waitForGlobalCooldownIfNeeded();
    if (isBurstActive()) {
      break;
    }
    if (authorState.queue.length === 0) {
      break;
    }

    const task = authorState.queue.shift()!;
    authorState.currentTask = task;

    try {
      await runAuthorTask(task, authorCacheMap);
      authorState.batchCompleted++;
      pushHistory({
        channel: 'author-video',
        mid: task.mid,
        pn: task.pn,
        name: task.name,
        mode: 'regular',
        success: true,
        timestamp: Date.now(),
        taskReason: task.reason,
        trigger: task.trigger
      });
    } catch (error) {
      authorState.batchFailed.push(task);
      if (isWbiRatelimitError(error)) {
        triggerGlobalWbiCooldown();
      }
      pushHistory({
        channel: 'author-video',
        mid: task.mid,
        pn: task.pn,
        name: task.name,
        mode: 'regular',
        success: false,
        timestamp: Date.now(),
        taskReason: task.reason,
        trigger: task.trigger,
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

    await waitForGlobalCooldownIfNeeded();
    if (isBurstActive()) {
      break;
    }
    if (groupFavState.queue.length === 0) {
      break;
    }

    const task = groupFavState.queue.shift()!;
    groupFavState.currentTask = task;
    const groupDisplayName = task.groupId;

    try {
      await runGroupFavTask(task);
      groupFavState.batchCompleted++;
      pushHistory({
        channel: 'group-fav',
        groupId: task.groupId,
        name: groupDisplayName,
        mode: 'regular',
        success: true,
        timestamp: Date.now(),
        taskReason: 'group-fav-refresh',
        trigger: task.trigger
      });
    } catch (error) {
      groupFavState.batchFailed.push(task);
      if (isWbiRatelimitError(error)) {
        triggerGlobalWbiCooldown();
      }
      pushHistory({
        channel: 'group-fav',
        groupId: task.groupId,
        name: groupDisplayName,
        mode: 'regular',
        success: false,
        timestamp: Date.now(),
        taskReason: 'group-fav-refresh',
        trigger: task.trigger,
        error: error instanceof Error ? error.message : String(error)
      });
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
    const waitMs = Math.max(burstState.nextAllowedAt, globalCooldownState.nextAllowedAt) - Date.now();
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
      pushHistory({
        channel: 'author-video',
        mid: task.mid,
        pn: task.pn,
        name: task.name,
        mode: 'burst',
        success: true,
        timestamp: Date.now(),
        taskReason: task.reason,
        trigger: task.trigger
      });
      await saveAuthorVideoCacheMap(authorCacheMap);
      notifyBurstTaskFirstResult(task, { ok: true });
      notifyBurstTaskFinished(task, { ok: true });
    } catch (error) {
      if (isWbiRatelimitError(error)) {
        triggerGlobalWbiCooldown();
      }
      pushHistory({
        channel: 'author-video',
        mid: task.mid,
        pn: task.pn,
        name: task.name,
        mode: 'burst',
        success: false,
        timestamp: Date.now(),
        taskReason: task.reason,
        trigger: task.trigger,
        error: error instanceof Error ? error.message : String(error)
      });
      console.warn('[BBE] Burst 作者任务刷新失败 mid:', task.mid, error);
      notifyBurstTaskFirstResult(task, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });

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

function startLikeActionLoopIfIdle(): void {
  if (!likeActionState.running && likeActionState.queue.length > 0) {
    void runLikeActionLoop();
  }
}

export function enqueueBurst(tasks: SchedulerTask[], requestContext?: SchedulerRequestContext): number {
  const previewContext = requestContext ?? tasks[0]?.requestContext ?? createSchedulerRequestContext();
  const previewTasks = tasks.map((task, index) => normalizeBurstAuthorTask(task, previewContext, index));
  const taskKeys = new Set(previewTasks.map((task) => keyOfAuthorTask(task)));
  const added = enqueueBurstTasks(tasks, previewContext);
  if (taskKeys.size > 0) {
    // Burst 任务优先级高于常规作者队列，入列后清掉常规队列里的同目标，避免重复调用。
    removeAuthorTasksFromRegularQueue(taskKeys);
  }
  if (added > 0 && !hasRunningRegularTask()) {
    startBurstLoopIfIdle();
  }
  return added;
}

export function observeBurstTaskFirstResult(
  task: SchedulerTask,
  listener: (result: { ok: boolean; error?: string }) => void
): () => void {
  const normalizedTask = buildAuthorTaskBase(task);
  const key = keyOfAuthorTask(normalizedTask);
  const listeners = burstTaskFirstResultListeners.get(key) ?? [];
  listeners.push(listener);
  burstTaskFirstResultListeners.set(key, listeners);

  return () => {
    const nextListeners = burstTaskFirstResultListeners.get(key);
    if (!nextListeners || nextListeners.length === 0) {
      return;
    }
    const index = nextListeners.indexOf(listener);
    if (index < 0) {
      return;
    }
    nextListeners.splice(index, 1);
    if (nextListeners.length === 0) {
      burstTaskFirstResultListeners.delete(key);
    }
  };
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
  tasks: SchedulerTask[],
  requestContext?: SchedulerRequestContext
): Promise<{ success: Array<{ mid: number; pn: number }>; failed: Array<{ mid: number; pn: number; error: string }> }> {
  if (tasks.length === 0) {
    return { success: [], failed: [] };
  }

  const context = requestContext ?? createSchedulerRequestContext();
  const normalizedTasks = tasks.map((task, index) => normalizeBurstAuthorTask({
    ...task,
    queueOrderClass: 0
  }, context, index));
  const failFastTasks = normalizedTasks.map((task) => ({
    ...task,
    failFast: true,
    reason: 'load-more-boundary' as const
  }));
  const taskKeys = new Set(failFastTasks.map((task) => keyOfAuthorTask(task)));
  markBurstTaskFailFastByKeys(taskKeys);

  const waitJobs = failFastTasks.map(async (task) => {
    const key = keyOfAuthorTask(task);
    const waiter = waitForBurstTask(task);
    const added = dedupeMergeAndSort(burstState, [task], keyOfAuthorTask, mergeAuthorTaskCapabilities, compareQueueOrderedTask);
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

export function enqueuePriority(tasks: SchedulerTask[], requestContext?: SchedulerRequestContext): number {
  if (tasks.length === 0) {
    return 0;
  }

  const context = requestContext ?? tasks[0]?.requestContext ?? createSchedulerRequestContext();
  const normalizedTasks = tasks.map((task, index) => normalizeRegularAuthorTask(task, context, index));
  const burstKeys = buildExistingTaskKeySet(burstState, keyOfAuthorTask);
  const filtered = normalizedTasks.filter((task) => !burstKeys.has(keyOfAuthorTask(task)));
  const added = dedupeMergeAndSort(authorState, filtered, keyOfAuthorTask, mergeAuthorTaskCapabilities, compareQueueOrderedTask);
  if (added > 0) {
    startAuthorLoopIfIdle();
  }
  return added;
}

export function enqueuePriorityGroup(
  groupIds: string[],
  trigger: SchedulerTaskTrigger = 'manual-refresh-posts',
  authorRefreshMode: GroupFavTask['authorRefreshMode'] = 'stale',
  requestContext?: SchedulerRequestContext
): number {
  const tasks: GroupFavTaskInput[] = groupIds.map((groupId) => ({
    groupId,
    trigger,
    authorRefreshMode
  }));
  const added = enqueueGroupFavTasks(tasks, requestContext);
  if (added > 0) {
    startGroupFavLoopIfIdle();
  }
  return added;
}

export async function enqueueLikeActionAndWait(input: {
  aid: number;
  bvid: string;
  authorMid: number;
  csrf: string;
  like: boolean;
  pageContext: LikePageContext;
}): Promise<LikeTaskResult> {
  const task = normalizeLikeActionTask({
    key: keyOfLikeTask({ bvid: input.bvid }),
    aid: input.aid,
    bvid: input.bvid,
    authorMid: input.authorMid,
    csrf: input.csrf,
    action: input.like ? 'like' : 'unlike',
    source: 'single-card-toggle',
    trigger: 'manual-click',
    pageContext: input.pageContext
  });

  const existing = getExistingLikeActionByBvid(task.bvid);
  if (existing && existing.action !== task.action) {
    throw new Error('当前视频正在切换点赞状态，请稍后再试');
  }

  const waiter = waitForLikeTask(task);
  dedupeAndEnqueue(likeActionState, [task], keyOfLikeTask, true);
  startLikeActionLoopIfIdle();

  const result = await waiter;
  if (!result.ok || !result.result) {
    throw new Error(result.error ?? '点赞失败');
  }
  return result.result;
}

export function enqueueLikeBatch(
  authorMid: number,
  videos: Array<{ aid: number; bvid: string }>,
  csrf: string,
  pageContext: LikePageContext,
  options?: {
    onTaskFinished?: (item: { task: LikeActionTask; result: LikeTaskWaiterResult }) => void | Promise<void>;
  }
): EnqueuedLikeBatch {
  const normalizedVideos = new Map<string, { aid: number; bvid: string }>();
  for (const video of videos) {
    const aid = Math.max(0, Math.floor(Number(video.aid) || 0));
    const bvid = video.bvid?.trim() || '';
    if (!aid || !bvid) {
      continue;
    }
    if (!normalizedVideos.has(bvid)) {
      normalizedVideos.set(bvid, { aid, bvid });
    }
  }

  if (normalizedVideos.size === 0) {
    return {
      authorMid,
      total: 0,
      queuedCount: 0,
      queuedBvids: [],
      skippedBvids: [],
      completion: Promise.resolve({
        authorMid,
        total: 0,
        successCount: 0,
        failedCount: 0,
        failedBvids: []
      })
    };
  }

  const tasks: LikeActionTask[] = [];
  const failedBvids = new Set<string>();
  for (const video of normalizedVideos.values()) {
    const task = normalizeLikeActionTask({
      key: keyOfLikeTask({ bvid: video.bvid }),
      aid: video.aid,
      bvid: video.bvid,
      authorMid,
      csrf,
      action: 'like',
      source: 'author-batch-like',
      trigger: 'manual-click',
      pageContext
    });
    const existing = getExistingLikeActionByBvid(task.bvid);
    if (existing && existing.action !== task.action) {
      failedBvids.add(task.bvid);
      continue;
    }
    tasks.push(task);
  }

  const waitJobs = tasks.map(async (task) => {
    const result = await waitForLikeTask(task);
    if (options?.onTaskFinished) {
      void Promise.resolve(options.onTaskFinished({ task, result })).catch((error) => {
        console.warn('[BBE] 点赞任务进度回调失败 bvid:', task.bvid, error);
      });
    }
    return { task, result };
  });
  dedupeAndEnqueue(likeActionState, tasks, keyOfLikeTask, true);
  startLikeActionLoopIfIdle();

  const completion = Promise.all(waitJobs).then((settled) => {
    let successCount = 0;
    for (const item of settled) {
      if (item.result.ok) {
        successCount += 1;
        continue;
      }
      failedBvids.add(item.task.bvid);
    }

    return {
      authorMid,
      total: normalizedVideos.size,
      successCount,
      failedCount: failedBvids.size,
      failedBvids: Array.from(failedBvids)
    };
  });

  return {
    authorMid,
    total: normalizedVideos.size,
    queuedCount: tasks.length,
    queuedBvids: tasks.map((task) => task.bvid),
    skippedBvids: Array.from(failedBvids),
    completion
  };
}

export async function enqueueLikeBatchAndWait(
  authorMid: number,
  videos: Array<{ aid: number; bvid: string }>,
  csrf: string,
  pageContext: LikePageContext
): Promise<LikeBatchResult> {
  const batch = enqueueLikeBatch(authorMid, videos, csrf, pageContext);
  return batch.completion;
}

async function triggerAuthorRoutine(options?: { resetAlarmSchedule: boolean }): Promise<{ queued: number; nextAlarmAt?: number }> {
  const settings = await loadSettings();
  const interval = normalizeInterval(settings.backgroundRefreshIntervalMinutes, 10);
  const requestContext = createSchedulerRequestContext();

  let nextAlarmAt: number | undefined;
  if (options?.resetAlarmSchedule) {
    nextAlarmAt = await resetAlarm(ALARM_NAMES.AUTHOR_VIDEO, interval);
  }

  const [noCacheTasks, staleTasks, prefetchTasks] = await Promise.all([
    collectNoCacheAuthorTasks(settings, 'alarm-routine'),
    collectStaleAuthorTasks(settings, 'alarm-routine'),
    collectPrefetchAuthorTasks(settings, 'alarm-routine')
  ]);
  const burstQueued = enqueueBurst(noCacheTasks, requestContext);
  const routineTasks = [...staleTasks, ...prefetchTasks];
  authorState.currentBatchDelay = calcBatchDelay(routineTasks.length, interval, normalizeBatchSize(settings));
  const normalQueued = enqueueRegularAuthorTasks(routineTasks, requestContext);
  startAuthorLoopIfIdle();

  if (!nextAlarmAt) {
    const alarm = await ext.alarms.get(ALARM_NAMES.AUTHOR_VIDEO);
    nextAlarmAt = alarm?.scheduledTime;
  }

  return { queued: burstQueued + normalQueued, nextAlarmAt };
}

async function triggerAuthorRoutineNow(options?: { resetAlarmSchedule: boolean }): Promise<{ queued: number; nextAlarmAt?: number }> {
  const settings = await loadSettings();
  const interval = normalizeInterval(settings.backgroundRefreshIntervalMinutes, 10);
  const batchSize = normalizeBatchSize(settings);
  const requestContext = createSchedulerRequestContext();

  let nextAlarmAt: number | undefined;
  if (options?.resetAlarmSchedule) {
    nextAlarmAt = await resetAlarm(ALARM_NAMES.AUTHOR_VIDEO, interval);
  }

  const [noCacheTasks, candidates] = await Promise.all([
    collectNoCacheAuthorTasks(settings, 'debug-run-now'),
    collectOldestAuthorTasks(settings, 'debug-run-now')
  ]);
  const burstQueued = enqueueBurst(noCacheTasks, requestContext);
  const targetTotal = Math.max(batchSize, authorState.queue.length);
  authorState.currentBatchDelay = calcBatchDelay(targetTotal, interval, batchSize);
  const picked = pickTasksToBatchSize(authorState, candidates, keyOfAuthorTask, batchSize);
  const normalQueued = enqueueRegularAuthorTasks(picked, requestContext);
  startAuthorLoopIfIdle();

  if (!nextAlarmAt) {
    const alarm = await ext.alarms.get(ALARM_NAMES.AUTHOR_VIDEO);
    nextAlarmAt = alarm?.scheduledTime;
  }

  return { queued: burstQueued + normalQueued, nextAlarmAt };
}

async function triggerGroupFavRoutine(options?: { resetAlarmSchedule: boolean }): Promise<{ queued: number; nextAlarmAt?: number }> {
  const settings = await loadSettings();
  const interval = normalizeInterval(settings.groupFavRefreshIntervalMinutes, 10);
  const requestContext = createSchedulerRequestContext();

  let nextAlarmAt: number | undefined;
  if (options?.resetAlarmSchedule) {
    nextAlarmAt = await resetAlarm(ALARM_NAMES.GROUP_FAV, interval);
  }

  const tasks = await collectStaleGroupFavTasks(settings, 'alarm-routine');
  groupFavState.currentBatchDelay = calcBatchDelay(tasks.length, interval, normalizeBatchSize(settings));
  const queued = enqueueGroupFavTasks(tasks, requestContext);
  startGroupFavLoopIfIdle();

  if (!nextAlarmAt) {
    const alarm = await ext.alarms.get(ALARM_NAMES.GROUP_FAV);
    nextAlarmAt = alarm?.scheduledTime;
  }

  return { queued, nextAlarmAt };
}

async function triggerGroupFavRoutineNow(options?: { resetAlarmSchedule: boolean }): Promise<{ queued: number; nextAlarmAt?: number }> {
  const settings = await loadSettings();
  const interval = normalizeInterval(settings.groupFavRefreshIntervalMinutes, 10);
  const batchSize = normalizeBatchSize(settings);
  const requestContext = createSchedulerRequestContext();

  let nextAlarmAt: number | undefined;
  if (options?.resetAlarmSchedule) {
    nextAlarmAt = await resetAlarm(ALARM_NAMES.GROUP_FAV, interval);
  }

  const candidates = await collectOldestGroupFavTasks('debug-run-now');
  const targetTotal = Math.max(batchSize, groupFavState.queue.length);
  groupFavState.currentBatchDelay = calcBatchDelay(targetTotal, interval, batchSize);
  const picked = pickTasksToBatchSize(groupFavState, candidates, (task) => task.groupId, batchSize);
  const queued = enqueueGroupFavTasks(picked, requestContext);
  startGroupFavLoopIfIdle();

  if (!nextAlarmAt) {
    const alarm = await ext.alarms.get(ALARM_NAMES.GROUP_FAV);
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
  channels: Array<{ name: 'author-video' | 'group-fav' | 'like-action'; queued: number; nextAlarmAt?: number }>;
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
      { name: 'group-fav', queued: groupFav.queued, nextAlarmAt: groupFav.nextAlarmAt },
      { name: 'like-action', queued: likeActionState.queue.length }
    ]
  };
}

/**
 * 获取调度器状态（调试用）。
 * 顶层作者字段仅表示“常规更新队列”；Burst 明细在 burst 字段单独展示。
 */
export async function getStatus(): Promise<SchedulerStatusResponse> {
  await ensureHistoryHydrated();
  const [settings, authorCacheMap, feedCacheMap, groups, authorAlarm, groupFavAlarm] = await Promise.all([
    loadSettings(),
    liveAuthorCacheMap ?? loadAuthorVideoCacheMap(),
    loadFeedCacheMap(),
    loadGroups(),
    ext.alarms.get(ALARM_NAMES.AUTHOR_VIDEO),
    ext.alarms.get(ALARM_NAMES.GROUP_FAV)
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
      name: resolveAuthorName(item.name, item.continuousVideos ?? item.videos ?? [], item.mid),
      groupNames: Array.from(authorGroupNamesMap.get(item.mid) ?? []).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
      videoCount: (item.continuousVideos ?? item.videos ?? []).length,
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
    ps: item.ps,
    reason: item.reason
  }));
  const burstCurrentTask = burstState.currentTask
    ? {
        mid: burstState.currentTask.mid,
        name: resolveDisplayName(burstState.currentTask.name),
        pn: burstState.currentTask.pn,
        ps: burstState.currentTask.ps,
        reason: burstState.currentTask.reason,
        groupNames: getGroupNamesForTask(burstState.currentTask.mid, burstState.currentTask.groupId)
      }
    : null;
  const burstQueue = burstState.queue.map((item) => ({
    mid: item.mid,
    name: resolveDisplayName(item.name),
    pn: item.pn,
    ps: item.ps,
    reason: item.reason,
    groupNames: getGroupNamesForTask(item.mid, item.groupId)
  }));
  const burstCooldownReason: BurstCooldownReason = burstState.nextAllowedAt > Date.now() ? burstState.cooldownReason : null;
  const globalCooldownActive = globalCooldownState.nextAllowedAt > Date.now();
  const globalCooldownReason = globalCooldownActive || globalCooldownState.lastTriggeredAt
    ? 'wbi-ratelimit'
    : null;

  return {
    schedulerBatchSize: normalizeBatchSize(settings),
    running: authorState.running,
    queueLength: authorState.queue.length,
    currentTask: authorCurrentTask
      ? {
          mid: authorCurrentTask.mid,
          name: authorCurrentTask.name,
          pn: authorCurrentTask.pn,
          ps: authorCurrentTask.ps,
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
    likeChannel: {
      running: likeActionState.running,
      queueLength: likeActionState.queue.length,
      currentTask: likeActionState.currentTask
        ? {
            bvid: likeActionState.currentTask.bvid,
            aid: likeActionState.currentTask.aid,
            action: likeActionState.currentTask.action,
            source: likeActionState.currentTask.source,
            authorMid: likeActionState.currentTask.authorMid
          }
        : null,
      batchCompleted: likeActionState.batchCompleted,
      batchFailed: likeActionState.batchFailed.length,
      lastRunAt: likeActionState.lastRunAt,
      queue: likeActionState.queue.map((item) => ({
        bvid: item.bvid,
        aid: item.aid,
        action: item.action,
        source: item.source,
        authorMid: item.authorMid
      }))
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
    globalCooldown: {
      active: globalCooldownActive,
      nextAllowedAt: globalCooldownState.nextAllowedAt,
      reason: globalCooldownReason,
      lastTriggeredAt: globalCooldownState.lastTriggeredAt
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
  _usedPages: MixedUsedPageItem[]
): Promise<void> {
  // 旧的页级使用反馈已废弃；连续窗口维护改为直接基于连续缓存长度判断。
}

/**
 * 提供给前台读取路径的作者缓存快照：
 * 调度器运行中优先返回内存实时缓存，避免读到 storage 的滞后数据。
 */
export async function getAuthorCacheSnapshot(): Promise<AuthorCacheMap> {
  return liveAuthorCacheMap ?? loadAuthorVideoCacheMap();
}

ext.alarms.onAlarm.addListener((alarm) => {
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
