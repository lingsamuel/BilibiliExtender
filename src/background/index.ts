import { DEFAULT_SETTINGS } from '@/shared/constants';
import { getMyCreatedFolders, getWatchHistory } from '@/shared/api/bilibili';
import type { MessageRequest, MessageResponse, ResponseMap } from '@/shared/messages';
import {
  appendReadMarks,
  cleanExpiredClicks,
  loadAuthorReadMarks,
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
  ensureAuthorModePrepared,
  ensureGroupCache,
  isMixedMode,
  isStaleForAutoRefresh,
  loadMoreForMixed,
  makeSummary,
  markGroupRead,
  refreshGroupCache,
  removeGroupState,
  toFeedResult
} from '@/background/feed-service';

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
  const [groups, settings, folders] = await Promise.all([
    loadGroups(),
    loadSettings(),
    getMyCreatedFolders()
  ]);

  return {
    groups,
    settings,
    folders
  };
}

async function handleUpsertGroup(
  request: Extract<MessageRequest, { type: 'UPSERT_GROUP' }>
): Promise<ResponseMap['UPSERT_GROUP']> {
  const [groups, runtimeMap, cacheMap] = await Promise.all([
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
      removeGroupState(previous.groupId, runtimeMap, cacheMap);
    }
  } else {
    groups.push(incoming);
  }

  await Promise.all([
    saveGroups(groups),
    saveRuntimeStateMap(runtimeMap),
    saveFeedCacheMap(cacheMap)
  ]);

  return { groups };
}

async function handleDeleteGroup(
  request: Extract<MessageRequest, { type: 'DELETE_GROUP' }>
): Promise<ResponseMap['DELETE_GROUP']> {
  const [groups, runtimeMap, cacheMap] = await Promise.all([
    loadGroups(),
    loadRuntimeStateMap(),
    loadFeedCacheMap()
  ]);

  const nextGroups = groups.filter((item) => item.groupId !== request.payload.groupId);
  removeGroupState(request.payload.groupId, runtimeMap, cacheMap);

  await Promise.all([
    saveGroups(nextGroups),
    saveRuntimeStateMap(runtimeMap),
    saveFeedCacheMap(cacheMap)
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

  return { settings };
}

async function handleGetGroupSummary(
  request: Extract<MessageRequest, { type: 'GET_GROUP_SUMMARY' }>
): Promise<ResponseMap['GET_GROUP_SUMMARY']> {
  const [groups, settings, runtimeMap, cacheMap, lastGroupId] = await Promise.all([
    loadGroups(),
    loadSettings(),
    loadRuntimeStateMap(),
    loadFeedCacheMap(),
    loadLastGroupId()
  ]);

  for (const group of groups) {
    if (!group.enabled) {
      continue;
    }

    if (request.payload?.allowRefresh && isStaleForAutoRefresh(group.groupId, settings, runtimeMap)) {
      try {
        await refreshGroupCache(group, settings, runtimeMap, cacheMap);
      } catch (error) {
        console.warn('[BBE] auto refresh summary failed:', group.groupId, error);
      }
    }
  }

  const summaries = makeSummary(groups, settings, runtimeMap, cacheMap).filter((item) => item.enabled);

  await Promise.all([saveRuntimeStateMap(runtimeMap), saveFeedCacheMap(cacheMap)]);

  return {
    summaries,
    hasUnread: summaries.some((item) => item.unreadCount > 0),
    lastGroupId,
    settings
  };
}

async function handleGetGroupFeed(
  request: Extract<MessageRequest, { type: 'GET_GROUP_FEED' }>
): Promise<ResponseMap['GET_GROUP_FEED']> {
  const [groups, settings, runtimeMap, cacheMap] = await Promise.all([
    loadGroups(),
    loadSettings(),
    loadRuntimeStateMap(),
    loadFeedCacheMap()
  ]);

  const group = groups.find((item) => item.groupId === request.payload.groupId && item.enabled);

  if (!group) {
    throw new Error('分组不存在或已禁用');
  }

  if (request.payload.forceRefresh) {
    await refreshGroupCache(group, settings, runtimeMap, cacheMap);
  } else {
    await ensureGroupCache(group, settings, runtimeMap, cacheMap, false);
  }

  if (isMixedMode(request.payload.mode)) {
    await loadMoreForMixed(group, settings, runtimeMap, cacheMap, Boolean(request.payload.loadMore));
  } else {
    await ensureAuthorModePrepared(group, settings, runtimeMap, cacheMap);
  }

  await Promise.all([
    saveFeedCacheMap(cacheMap),
    saveLastGroupId(group.groupId)
  ]);

  const readMarks = await loadAuthorReadMarks();
  const selectedReadMarkTs = request.payload.selectedReadMarkTs ?? 0;

  const result = toFeedResult(group, request.payload.mode, settings, runtimeMap, cacheMap, readMarks, selectedReadMarkTs);

  // toFeedResult 会写入 runtime.savedMode / savedReadMarkTs，需要在之后持久化
  await saveRuntimeStateMap(runtimeMap);

  return result;
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

async function handleGetWatchHistory(): Promise<ResponseMap['GET_WATCH_HISTORY']> {
  const history = await getWatchHistory();
  return { history };
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
    default:
      return fail('不支持的消息类型');
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await loadSettings();
  await saveSettings({
    ...DEFAULT_SETTINGS,
    ...settings
  });

  await cleanExpiredClicks();
});

chrome.runtime.onMessage.addListener((request: MessageRequest, _sender, sendResponse) => {
  routeMessage(request)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse(fail(error)));

  return true;
});
