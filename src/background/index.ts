import { DEFAULT_SETTINGS } from '@/shared/constants';
import { getMyCreatedFolders, getWatchHistory } from '@/shared/api/bilibili';
import type { MessageRequest, MessageResponse, ResponseMap } from '@/shared/messages';
import {
  appendReadMarks,
  cleanExpiredClicks,
  loadAuthorReadMarks,
  loadAuthorVideoCacheMap,
  loadClickedVideos,
  loadFeedCacheMap,
  loadGroups,
  loadLastGroupId,
  loadRuntimeStateMap,
  loadSettings,
  recordVideoClick,
  saveFeedCacheMap,
  saveGroups,
  saveLastGroupId,
  saveRuntimeStateMap,
  saveSettings
} from '@/shared/storage/repository';
import type { GroupConfig } from '@/shared/types';
import {
  increaseMixedTarget,
  makeSummary,
  markGroupRead,
  removeGroupState,
  toFeedResult
} from '@/background/feed-service';
import {
  enqueuePriorityGroup,
  getAuthorCacheSnapshot,
  getStatus,
  runSchedulerNow,
  setupAlarm
} from '@/background/scheduler';

function ok<T>(data: T): MessageResponse<T> {
  return { ok: true, data };
}

function fail(error: unknown): MessageResponse {
  if (error instanceof Error) {
    return { ok: false, error: error.message };
  }

  return { ok: false, error: '未知错误' };
}

function normalizeGroupInput(group: GroupConfig): GroupConfig {
  const now = Date.now();
  return {
    ...group,
    alias: group.alias?.trim() || undefined,
    createdAt: group.createdAt ?? now,
    updatedAt: now
  };
}

async function handleGetOptionsData(): Promise<ResponseMap['GET_OPTIONS_DATA']> {
  const [groups, settings, folders, feedCacheMap] = await Promise.all([
    loadGroups(),
    loadSettings(),
    getMyCreatedFolders(),
    loadFeedCacheMap()
  ]);

  const groupAuthorCounts: Record<string, number> = {};
  const allMids = new Set<number>();
  for (const group of groups) {
    const cache = feedCacheMap[group.groupId];
    const count = cache?.authorMids?.length ?? 0;
    groupAuthorCounts[group.groupId] = count;
    if (cache?.authorMids) {
      for (const mid of cache.authorMids) {
        allMids.add(mid);
      }
    }
  }

  return { groups, settings, folders, groupAuthorCounts, totalTrackedAuthors: allMids.size };
}

async function handleUpsertGroup(
  request: Extract<MessageRequest, { type: 'UPSERT_GROUP' }>
): Promise<ResponseMap['UPSERT_GROUP']> {
  const [groups, runtimeMap, feedCacheMap] = await Promise.all([
    loadGroups(),
    loadRuntimeStateMap(),
    loadFeedCacheMap()
  ]);

  const incoming = normalizeGroupInput(request.payload.group as GroupConfig);

  const mediaConflict = groups.find(
    (item) => item.mediaId === incoming.mediaId && item.groupId !== incoming.groupId
  );

  if (mediaConflict) {
    throw new Error('该收藏夹已被其他分组使用');
  }

  const index = groups.findIndex((item) => item.groupId === incoming.groupId);

  if (index >= 0) {
    const previous = groups[index];
    groups[index] = {
      ...previous,
      ...incoming,
      createdAt: previous.createdAt,
      updatedAt: Date.now()
    };

    if (previous.mediaId !== incoming.mediaId) {
      removeGroupState(previous.groupId, runtimeMap, feedCacheMap);
    }
  } else {
    groups.push(incoming);
  }

  await Promise.all([
    saveGroups(groups),
    saveRuntimeStateMap(runtimeMap),
    saveFeedCacheMap(feedCacheMap)
  ]);

  return { groups };
}

async function handleDeleteGroup(
  request: Extract<MessageRequest, { type: 'DELETE_GROUP' }>
): Promise<ResponseMap['DELETE_GROUP']> {
  const [groups, runtimeMap, feedCacheMap] = await Promise.all([
    loadGroups(),
    loadRuntimeStateMap(),
    loadFeedCacheMap()
  ]);

  const nextGroups = groups.filter((item) => item.groupId !== request.payload.groupId);
  removeGroupState(request.payload.groupId, runtimeMap, feedCacheMap);

  await Promise.all([
    saveGroups(nextGroups),
    saveRuntimeStateMap(runtimeMap),
    saveFeedCacheMap(feedCacheMap)
  ]);

  return { groups: nextGroups };
}

async function handleSaveSettings(
  request: Extract<MessageRequest, { type: 'SAVE_SETTINGS' }>
): Promise<ResponseMap['SAVE_SETTINGS']> {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...request.payload.settings
  };

  await saveSettings(settings);
  await setupAlarm(settings);

  return { settings };
}

async function handleGetGroupSummary(
  _request: Extract<MessageRequest, { type: 'GET_GROUP_SUMMARY' }>
): Promise<ResponseMap['GET_GROUP_SUMMARY']> {
  const [groups, settings, runtimeMap, feedCacheMap, authorCacheMap, lastGroupId] = await Promise.all([
    loadGroups(),
    loadSettings(),
    loadRuntimeStateMap(),
    loadFeedCacheMap(),
    getAuthorCacheSnapshot(),
    loadLastGroupId()
  ]);

  // 纯缓存读取，不再触发 API 请求；刷新由调度器 alarm 驱动
  const summaries = makeSummary(groups, settings, runtimeMap, feedCacheMap, authorCacheMap).filter((item) => item.enabled);

  await saveRuntimeStateMap(runtimeMap);

  return {
    summaries,
    hasUnread: summaries.some((item) => item.unreadCount > 0),
    lastGroupId,
    settings
  };
}

/**
 * 纯缓存读取 + 提交调度任务。
 * 无缓存时返回 cacheStatus: 'generating'，同时向调度器提交优先任务。
 * 有缓存时直接组装返回 cacheStatus: 'ready'。
 */
async function handleGetGroupFeed(
  request: Extract<MessageRequest, { type: 'GET_GROUP_FEED' }>
): Promise<ResponseMap['GET_GROUP_FEED']> {
  const [groups, settings, runtimeMap, feedCacheMap, authorCacheMap] = await Promise.all([
    loadGroups(),
    loadSettings(),
    loadRuntimeStateMap(),
    loadFeedCacheMap(),
    getAuthorCacheSnapshot()
  ]);

  const group = groups.find((item) => item.groupId === request.payload.groupId && item.enabled);

  if (!group) {
    throw new Error('分组不存在或已禁用');
  }

  const feedCache = feedCacheMap[group.groupId];

  // 无缓存：首次访问，提交收藏夹优先任务，等待调度器异步生成缓存。
  if (!feedCache) {
    enqueuePriorityGroup([group.groupId]);

    return {
      groupId: group.groupId,
      mode: request.payload.mode,
      mixedVideos: [],
      videosByAuthor: [],
      unreadCount: 0,
      hasMoreForMixed: false,
      readMarkTimestamps: [],
      graceReadMarkTs: 0,
      cacheStatus: 'generating'
    };
  }

  // 有缓存但作者视频数据为空（收藏夹已拉取但作者视频尚未刷新完成）
  const hasAnyAuthorData = feedCache.authorMids.some((mid) => authorCacheMap[mid]?.videos?.length > 0);
  if (!hasAnyAuthorData) {
    return {
      groupId: group.groupId,
      mode: request.payload.mode,
      mixedVideos: [],
      videosByAuthor: [],
      unreadCount: 0,
      hasMoreForMixed: false,
      readMarkTimestamps: [],
      graceReadMarkTs: 0,
      cacheStatus: 'generating'
    };
  }

  // 加载更多：仅增加目标数量，不发起 API 请求
  if (request.payload.loadMore) {
    increaseMixedTarget(group.groupId, settings, runtimeMap);
    await saveRuntimeStateMap(runtimeMap);
  }

  await saveLastGroupId(group.groupId);

  const readMarks = await loadAuthorReadMarks();
  const selectedReadMarkTs = request.payload.selectedReadMarkTs ?? 0;

  const result = toFeedResult(group, request.payload.mode, settings, runtimeMap, feedCacheMap, authorCacheMap, readMarks, selectedReadMarkTs);

  await saveRuntimeStateMap(runtimeMap);

  return { ...result, cacheStatus: 'ready' };
}

async function handleMarkGroupRead(
  request: Extract<MessageRequest, { type: 'MARK_GROUP_READ' }>
): Promise<ResponseMap['MARK_GROUP_READ']> {
  const [settings, runtimeMap] = await Promise.all([loadSettings(), loadRuntimeStateMap()]);
  const unreadCount = markGroupRead(request.payload.groupId, settings, runtimeMap);
  await Promise.all([saveRuntimeStateMap(runtimeMap), saveLastGroupId(request.payload.groupId)]);

  return {
    groupId: request.payload.groupId,
    unreadCount
  };
}

async function handleMarkAuthorsRead(
  request: Extract<MessageRequest, { type: 'MARK_AUTHORS_READ' }>
): Promise<ResponseMap['MARK_AUTHORS_READ']> {
  const marks = await appendReadMarks(request.payload.mids);
  return { marks };
}

async function handleGetAuthorReadMarks(
  request: Extract<MessageRequest, { type: 'GET_AUTHOR_READ_MARKS' }>
): Promise<ResponseMap['GET_AUTHOR_READ_MARKS']> {
  const allMarks = await loadAuthorReadMarks();
  const filtered: Record<number, typeof allMarks[number]> = {};

  for (const mid of request.payload.mids) {
    if (allMarks[mid]) {
      filtered[mid] = allMarks[mid];
    }
  }

  return { marks: filtered };
}

async function handleRecordVideoClick(
  request: Extract<MessageRequest, { type: 'RECORD_VIDEO_CLICK' }>
): Promise<ResponseMap['RECORD_VIDEO_CLICK']> {
  await recordVideoClick(request.payload.bvid);
  return { bvid: request.payload.bvid };
}

async function handleGetClickedVideos(
  request: Extract<MessageRequest, { type: 'GET_CLICKED_VIDEOS' }>
): Promise<ResponseMap['GET_CLICKED_VIDEOS']> {
  const allClicked = await loadClickedVideos();
  const clicked: Record<string, number> = {};

  for (const bvid of request.payload.bvids) {
    if (allClicked[bvid]) {
      clicked[bvid] = allClicked[bvid];
    }
  }

  return { clicked };
}

let watchHistoryCache: { data: ResponseMap['GET_WATCH_HISTORY']; expiredAt: number } | null = null;

async function handleGetWatchHistory(): Promise<ResponseMap['GET_WATCH_HISTORY']> {
  if (watchHistoryCache && watchHistoryCache.expiredAt > Date.now()) {
    return watchHistoryCache.data;
  }

  const settings = await loadSettings();
  const cacheTtlMs = settings.refreshIntervalMinutes * 60 * 1000;
  const history = await getWatchHistory();
  const result = { history };
  watchHistoryCache = { data: result, expiredAt: Date.now() + cacheTtlMs };
  return result;
}

/**
 * 手动刷新：优先提交“收藏夹刷新任务”。
 * 收藏夹任务完成后会自动衔接作者任务，前台通过轮询 GET_GROUP_FEED 等待缓存就绪。
 */
async function handleManualRefresh(
  request: Extract<MessageRequest, { type: 'MANUAL_REFRESH' }>
): Promise<ResponseMap['MANUAL_REFRESH']> {
  const groups = await loadGroups();

  const group = groups.find((item) => item.groupId === request.payload.groupId && item.enabled);
  if (!group) {
    throw new Error('分组不存在或已禁用');
  }

  enqueuePriorityGroup([group.groupId]);

  return { accepted: true };
}

async function handleGetSchedulerStatus(): Promise<ResponseMap['GET_SCHEDULER_STATUS']> {
  return getStatus();
}

async function handleRunSchedulerNow(): Promise<ResponseMap['RUN_SCHEDULER_NOW']> {
  return runSchedulerNow();
}

async function routeMessage(request: MessageRequest): Promise<MessageResponse> {
  switch (request.type) {
    case 'PING':
      return ok({ pong: true });
    case 'GET_OPTIONS_DATA':
      return ok(await handleGetOptionsData());
    case 'UPSERT_GROUP':
      return ok(await handleUpsertGroup(request));
    case 'DELETE_GROUP':
      return ok(await handleDeleteGroup(request));
    case 'SAVE_SETTINGS':
      return ok(await handleSaveSettings(request));
    case 'GET_GROUP_SUMMARY':
      return ok(await handleGetGroupSummary(request));
    case 'GET_GROUP_FEED':
      return ok(await handleGetGroupFeed(request));
    case 'MARK_GROUP_READ':
      return ok(await handleMarkGroupRead(request));
    case 'MARK_AUTHORS_READ':
      return ok(await handleMarkAuthorsRead(request));
    case 'GET_AUTHOR_READ_MARKS':
      return ok(await handleGetAuthorReadMarks(request));
    case 'RECORD_VIDEO_CLICK':
      return ok(await handleRecordVideoClick(request));
    case 'GET_CLICKED_VIDEOS':
      return ok(await handleGetClickedVideos(request));
    case 'GET_WATCH_HISTORY':
      return ok(await handleGetWatchHistory());
    case 'MANUAL_REFRESH':
      return ok(await handleManualRefresh(request));
    case 'GET_SCHEDULER_STATUS':
      return ok(await handleGetSchedulerStatus());
    case 'RUN_SCHEDULER_NOW':
      return ok(await handleRunSchedulerNow());
    default:
      return fail('不支持的消息类型');
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await loadSettings();
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  await saveSettings(merged);
  await cleanExpiredClicks();
  await setupAlarm(merged);
});

chrome.runtime.onMessage.addListener((request: MessageRequest, _sender, sendResponse) => {
  routeMessage(request)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse(fail(error)));

  return true;
});
