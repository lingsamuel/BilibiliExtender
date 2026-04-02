import { DEFAULT_SETTINGS, VIRTUAL_GROUP_ID } from '@/shared/constants';
import {
  addVideoToFavorites,
  batchDeleteFavoriteResources,
  coinVideo,
  createFavoriteFolder,
  getAllFavVideos,
  getUploaderVideos,
  getUserCard,
  modifyUserRelation
} from '@/shared/api/bilibili';
import type {
  AuthorPageStatusMessage,
  BatchLikeStatusMessage,
  LikeTaskStatusMessage,
  MessageRequest,
  MessageResponse,
  ResponseMap,
  RuntimeMessage
} from '@/shared/messages';
import { ext } from '@/shared/platform/webext';
import {
  appendGroupReadMark,
  clearGroupReadMark,
  clearAuthorReadMark,
  clearVideoLiked,
  cleanOrphanClicks,
  cleanOrphanReviewedOverrides,
  loadAuthorPreferences,
  loadLikedVideos,
  loadVideoReviewedOverrides,
  loadGroupReadMarks,
  loadClickedVideos,
  loadFeedCacheMap,
  loadGroups,
  loadLastGroupId,
  loadRuntimeStateMap,
  loadSettings,
  recordVideoLiked,
  recordVideoClick,
  setAuthorIgnoreUnreadCount,
  setAuthorReadMark,
  undoAuthorReadMark,
  setVideoReviewedOverride,
  saveAuthorVideoCacheMap,
  saveFeedCacheMap,
  saveGroups,
  saveLastGroupId,
  saveRuntimeStateMap,
  saveSettings,
  undoLatestGroupReadMark
} from '@/shared/storage/repository';
import type { FavoriteFolder, FavoriteFolderSnapshot, GroupConfig, GroupReadMark } from '@/shared/types';
import {
  buildGroupSyncStatus,
  getAuthorPageCount,
  getCachedAuthorPageSnapshot,
  hasAuthorMorePages,
  increaseMixedTarget,
  makeSummary,
  markGroupRead,
  removeGroupState,
  toFeedResult,
  type MixedBuildDiagnostics
} from '@/background/feed-service';
import {
  createSchedulerRequestContext,
  enqueueBurst,
  enqueueLikeBatch,
  enqueueLikeActionAndWait,
  enqueuePriority,
  enqueuePriorityGroup,
  getAuthorCacheSnapshot,
  observeBurstTaskFirstResult,
  getStatus,
  runSchedulerNow,
  runTabOpenOpportunisticRefresh,
  setupAlarm
} from '@/background/scheduler';
import {
  forceRefreshFavoriteFolderSnapshot,
  mergeCreatedFavoriteFolderIntoSnapshot,
  readFavoriteFolderSnapshot
} from '@/background/favorite-folder-snapshot';
import { runWithFavRequestHeaders, runWithFollowRequestHeaders } from '@/background/request-dnr';
import {
  debugWarn,
  initDebugConsoleState
} from '@/shared/utils/debug-console';
import { normalizeExtensionSettings } from '@/shared/utils/settings';

void initDebugConsoleState();

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
    excludeFromUnreadCount: group.excludeFromUnreadCount === true,
    createdAt: group.createdAt ?? now,
    updatedAt: now
  };
}

interface MissingAuthorTaskBuckets {
  burst: Array<{ mid: number; name: string; pn: number; ps: number; staleAt: number; reason: 'first-page-refresh'; trigger: 'get-group-feed-missing-author-cache' }>;
  priority: Array<{ mid: number; name: string; pn: number; ps: number; staleAt: number; reason: 'first-page-refresh'; trigger: 'get-group-feed-missing-author-cache' }>;
}

const ALL_GROUP_ID = VIRTUAL_GROUP_ID.ALL;

async function sendRuntimeMessage(
  sender: chrome.runtime.MessageSender,
  message: RuntimeMessage
): Promise<void> {
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number') {
    return;
  }

  try {
    if (typeof sender.frameId === 'number') {
      await ext.tabs.sendMessage(tabId, message, { frameId: sender.frameId });
      return;
    }
    await ext.tabs.sendMessage(tabId, message);
  } catch {
    // 页面已关闭、content script 不在场等情况直接忽略，前台仍有轮询兜底。
  }
}

async function sendAuthorPageStatusMessage(
  sender: chrome.runtime.MessageSender,
  message: AuthorPageStatusMessage
): Promise<void> {
  await sendRuntimeMessage(sender, message);
}

async function sendLikeTaskStatusMessage(
  sender: chrome.runtime.MessageSender,
  message: LikeTaskStatusMessage
): Promise<void> {
  await sendRuntimeMessage(sender, message);
}

async function sendBatchLikeStatusMessage(
  sender: chrome.runtime.MessageSender,
  message: BatchLikeStatusMessage
): Promise<void> {
  await sendRuntimeMessage(sender, message);
}

/**
 * 判定某个分组内哪些作者还没有完成“至少一轮首页缓存”并按队列分流：
 * - 无缓存：进入 Burst；
 * - 有缓存但仍缺少首页抓取时间：进入常规优先队列。
 */
function splitMissingAuthorTasks(
  authorMids: number[],
  authorCacheMap: Awaited<ReturnType<typeof getAuthorCacheSnapshot>>,
  pageSize: number
): MissingAuthorTaskBuckets {
  const burst: Array<{ mid: number; name: string; pn: number; ps: number; staleAt: number; reason: 'first-page-refresh'; trigger: 'get-group-feed-missing-author-cache' }> = [];
  const priority: Array<{ mid: number; name: string; pn: number; ps: number; staleAt: number; reason: 'first-page-refresh'; trigger: 'get-group-feed-missing-author-cache' }> = [];

  for (const mid of authorMids) {
    const cache = authorCacheMap[mid];
    if (cache?.lastFirstPageFetchedAt || cache?.firstPageFetchedAt) {
      continue;
    }

    const task = {
      mid,
      name: cache?.name?.trim() || String(mid),
      pn: 1,
      ps: pageSize,
      staleAt: cache?.lastFirstPageFetchedAt || cache?.firstPageFetchedAt || cache?.lastFetchedAt || 0,
      reason: 'first-page-refresh' as const,
      trigger: 'get-group-feed-missing-author-cache' as const
    };

    if (!cache) {
      burst.push(task);
    } else {
      priority.push(task);
    }
  }

  return { burst, priority };
}

function normalizeVideoTarget(payload: { aid?: number; bvid?: string }): { aid?: number; bvid?: string } {
  const aid = Number(payload.aid);
  if (aid > 0) {
    return { aid: Math.floor(aid) };
  }
  const bvid = payload.bvid?.trim();
  if (bvid) {
    return { bvid };
  }
  throw new Error('视频参数不完整');
}

function getGroupDisplayTitle(group: GroupConfig): string {
  return group.alias?.trim() || group.mediaTitle || group.groupId;
}

function buildAuthorGroupMembership(
  mid: number,
  groups: GroupConfig[],
  feedCacheMap: Awaited<ReturnType<typeof loadFeedCacheMap>>
): ResponseMap['GET_AUTHOR_GROUP_MEMBERSHIP'] {
  const items = groups.map((group) => ({
    groupId: group.groupId,
    title: getGroupDisplayTitle(group),
    mediaId: group.mediaId,
    enabled: group.enabled,
    checked: (feedCacheMap[group.groupId]?.authorMids ?? []).includes(mid)
  }));

  return {
    mid,
    grouped: items.some((item) => item.checked),
    groups: items
  };
}

function buildAvailableFolders(
  groups: GroupConfig[],
  folders: FavoriteFolder[]
): FavoriteFolder[] {
  const usedMediaIds = new Set(groups.map((group) => group.mediaId));
  return folders.filter((folder) => !usedMediaIds.has(folder.id));
}

function buildAuthorGroupDialogData(
  mid: number,
  groups: GroupConfig[],
  feedCacheMap: Awaited<ReturnType<typeof loadFeedCacheMap>>,
  folderSnapshot: FavoriteFolderSnapshot | null
): ResponseMap['GET_AUTHOR_GROUP_DIALOG_DATA'] {
  const membership = buildAuthorGroupMembership(mid, groups, feedCacheMap);
  return {
    ...membership,
    availableFolders: buildAvailableFolders(groups, folderSnapshot?.folders ?? []),
    folderSnapshot: folderSnapshot ?? undefined
  };
}

async function resolveFavoriteFolderSnapshot(forceRefresh: boolean): Promise<FavoriteFolderSnapshot | null> {
  if (forceRefresh) {
    return forceRefreshFavoriteFolderSnapshot();
  }
  return readFavoriteFolderSnapshot();
}

function createGroupConfigFromFolder(folder: { id: number; title: string }): GroupConfig {
  return {
    groupId: crypto.randomUUID(),
    mediaId: folder.id,
    mediaTitle: folder.title,
    enabled: true,
    excludeFromUnreadCount: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

/**
 * 统一维护分组创建/更新规则，避免设置页与作者弹框走出两套冲突校验和刷新语义。
 */
async function upsertGroupConfig(
  groupInput: GroupConfig
): Promise<{
    groups: GroupConfig[];
    runtimeMap: Awaited<ReturnType<typeof loadRuntimeStateMap>>;
    feedCacheMap: Awaited<ReturnType<typeof loadFeedCacheMap>>;
    group: GroupConfig;
    created: boolean;
  }> {
  const [groups, runtimeMap, feedCacheMap] = await Promise.all([
    loadGroups(),
    loadRuntimeStateMap(),
    loadFeedCacheMap()
  ]);

  const incoming = normalizeGroupInput(groupInput);

  const mediaConflict = groups.find(
    (item) => item.mediaId === incoming.mediaId && item.groupId !== incoming.groupId
  );

  if (mediaConflict) {
    throw new Error('该收藏夹已被其他分组使用');
  }

  const index = groups.findIndex((item) => item.groupId === incoming.groupId);
  let nextGroup = incoming;

  if (index >= 0) {
    const previous = groups[index];
    nextGroup = {
      ...previous,
      ...incoming,
      createdAt: previous.createdAt,
      updatedAt: Date.now()
    };
    groups[index] = nextGroup;

    if (previous.mediaId !== incoming.mediaId) {
      removeGroupState(previous.groupId, runtimeMap, feedCacheMap);
    }
  } else {
    groups.push(nextGroup);
  }

  await Promise.all([
    saveGroups(groups),
    saveRuntimeStateMap(runtimeMap),
    saveFeedCacheMap(feedCacheMap)
  ]);

  if (index < 0) {
    enqueuePriorityGroup([nextGroup.groupId], 'group-created-auto-refresh');
  }

  return {
    groups,
    runtimeMap,
    feedCacheMap,
    group: nextGroup,
    created: index < 0
  };
}

/**
 * 直接改写分组作者缓存，让作者分组按钮与弹框状态即时收敛到用户刚完成的操作。
 * 后续仍会补一次收藏夹刷新，请求远端真相重新校正。
 */
function patchAuthorGroupMembershipCache(
  feedCacheMap: Awaited<ReturnType<typeof loadFeedCacheMap>>,
  groupId: string,
  mid: number,
  checked: boolean
): boolean {
  const existing = feedCacheMap[groupId];
  if (!existing) {
    if (!checked) {
      return false;
    }

    feedCacheMap[groupId] = {
      groupId,
      authorMids: [mid],
      updatedAt: Date.now()
    };
    return true;
  }

  const current = Array.isArray(existing.authorMids) ? existing.authorMids : [];
  const next = checked
    ? current.includes(mid)
      ? current
      : [...current, mid]
    : current.filter((item) => item !== mid);

  if (next === current || (next.length === current.length && next.every((item, index) => item === current[index]))) {
    return false;
  }

  feedCacheMap[groupId] = {
    ...existing,
    authorMids: next,
    updatedAt: Date.now()
  };
  return true;
}

async function handleGetAuthorGroupMembership(
  request: Extract<MessageRequest, { type: 'GET_AUTHOR_GROUP_MEMBERSHIP' }>
): Promise<ResponseMap['GET_AUTHOR_GROUP_MEMBERSHIP']> {
  const mid = Math.max(1, Number(request.payload.mid) || 0);
  if (!mid) {
    throw new Error('作者参数不完整');
  }

  const [groups, feedCacheMap] = await Promise.all([
    loadGroups(),
    loadFeedCacheMap()
  ]);

  return buildAuthorGroupMembership(mid, groups, feedCacheMap);
}

async function handleGetAuthorGroupDialogData(
  request: Extract<MessageRequest, { type: 'GET_AUTHOR_GROUP_DIALOG_DATA' }>
): Promise<ResponseMap['GET_AUTHOR_GROUP_DIALOG_DATA']> {
  const mid = Math.max(1, Number(request.payload.mid) || 0);
  if (!mid) {
    throw new Error('作者参数不完整');
  }

  const [groups, feedCacheMap, folderSnapshot] = await Promise.all([
    loadGroups(),
    loadFeedCacheMap(),
    resolveFavoriteFolderSnapshot(request.payload.refreshFolders === true)
  ]);

  return buildAuthorGroupDialogData(mid, groups, feedCacheMap, folderSnapshot);
}

async function handleUpdateAuthorGroupMembership(
  request: Extract<MessageRequest, { type: 'UPDATE_AUTHOR_GROUP_MEMBERSHIP' }>
): Promise<ResponseMap['UPDATE_AUTHOR_GROUP_MEMBERSHIP']> {
  const mid = Math.max(1, Number(request.payload.mid) || 0);
  const groupId = request.payload.groupId?.trim() || '';
  const action = request.payload.action === 'remove' ? 'remove' : 'add';
  const csrf = request.payload.csrf?.trim();
  const pageOrigin = request.payload.pageOrigin?.trim();
  const pageReferer = request.payload.pageReferer?.trim();
  if (!mid || !groupId || !csrf || !pageOrigin || !pageReferer) {
    throw new Error('分组操作参数不完整');
  }

  const [groups, feedCacheMap, settings, authorCacheMap] = await Promise.all([
    loadGroups(),
    loadFeedCacheMap(),
    loadSettings(),
    getAuthorCacheSnapshot()
  ]);
  const group = groups.find((item) => item.groupId === groupId);
  if (!group) {
    throw new Error('分组不存在');
  }

  let message = '';
  let affectedVideoCount = 0;
  let latestVideoBvid: string | undefined;
  let preferredAuthorName: string | undefined;

  if (action === 'add') {
    if (request.payload.source === 'video') {
      const target = normalizeVideoTarget(request.payload.video ?? {});
      await runWithFavRequestHeaders(pageOrigin, pageReferer, async () => {
        await addVideoToFavorites(target, group.mediaId, csrf);
      });
      affectedVideoCount = 1;
      latestVideoBvid = target.bvid;
      message = `已将当前视频加入「${getGroupDisplayTitle(group)}」`;
    } else {
      const latest = await getUploaderVideos(mid, 1, 1);
      const latestVideo = latest.videos[0];
      if (!latestVideo) {
        throw new Error('该作者暂无可加入收藏夹的视频');
      }
      await runWithFavRequestHeaders(pageOrigin, pageReferer, async () => {
        await addVideoToFavorites(
          {
            aid: latestVideo.aid,
            bvid: latestVideo.bvid
          },
          group.mediaId,
          csrf
        );
      });
      affectedVideoCount = 1;
      latestVideoBvid = latestVideo.bvid;
      preferredAuthorName = latestVideo.authorName?.trim() || undefined;
      message = `已将该作者的最新视频加入「${getGroupDisplayTitle(group)}」`;
    }

    patchAuthorGroupMembershipCache(feedCacheMap, groupId, mid, true);
  } else {
    const favVideos = await getAllFavVideos(group.mediaId);
    const matchedResources = favVideos
      .filter((item) => Number(item.upper?.mid) === mid)
      .map((item) => ({
        id: Math.max(0, Math.floor(Number(item.id) || 0)),
        type: 2
      }))
      .filter((item) => item.id > 0);

    if (matchedResources.length > 0) {
      await runWithFavRequestHeaders(pageOrigin, pageReferer, async () => {
        await batchDeleteFavoriteResources(group.mediaId, matchedResources, csrf);
      });
    }

    affectedVideoCount = matchedResources.length;
    patchAuthorGroupMembershipCache(feedCacheMap, groupId, mid, false);
    message = matchedResources.length > 0
      ? `已从「${getGroupDisplayTitle(group)}」移除该作者的 ${matchedResources.length} 个投稿`
      : `该作者当前没有可移除的视频，已从「${getGroupDisplayTitle(group)}」移除分组归属`;
  }

  await saveFeedCacheMap(feedCacheMap);
  enqueuePriorityGroup([groupId], 'manual-refresh-fav', 'none');

  if (action === 'add') {
    const missingAuthorTasks = splitMissingAuthorTasks([mid], authorCacheMap, settings.authorVideosPageSize);
    if (preferredAuthorName) {
      missingAuthorTasks.burst.forEach((task) => {
        task.name = preferredAuthorName;
      });
      missingAuthorTasks.priority.forEach((task) => {
        task.name = preferredAuthorName;
      });
    }

    if (missingAuthorTasks.burst.length > 0 || missingAuthorTasks.priority.length > 0) {
      const requestContext = createSchedulerRequestContext();
      enqueueBurst(missingAuthorTasks.burst, requestContext);
      enqueuePriority(missingAuthorTasks.priority, requestContext);
    }
  }

  const membership = buildAuthorGroupMembership(mid, groups, feedCacheMap);
  return {
    ...membership,
    action,
    groupId,
    message,
    affectedVideoCount,
    latestVideoBvid
  };
}


async function handleGetOptionsData(
  request: Extract<MessageRequest, { type: 'GET_OPTIONS_DATA' }>
): Promise<ResponseMap['GET_OPTIONS_DATA']> {
  const [groups, settings, folderSnapshot, feedCacheMap] = await Promise.all([
    loadGroups(),
    loadSettings(),
    resolveFavoriteFolderSnapshot(request.payload?.refreshFolders === true),
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

  return {
    groups,
    settings,
    folders: folderSnapshot?.folders ?? [],
    folderSnapshot: folderSnapshot ?? undefined,
    groupAuthorCounts,
    totalTrackedAuthors: allMids.size
  };
}

async function handleUpsertGroup(
  request: Extract<MessageRequest, { type: 'UPSERT_GROUP' }>
): Promise<ResponseMap['UPSERT_GROUP']> {
  const { groups } = await upsertGroupConfig(request.payload.group as GroupConfig);
  return { groups };
}

async function handleCreateAuthorGroupFromFolder(
  request: Extract<MessageRequest, { type: 'CREATE_AUTHOR_GROUP_FROM_FOLDER' }>
): Promise<ResponseMap['CREATE_AUTHOR_GROUP_FROM_FOLDER']> {
  const mid = Math.max(1, Number(request.payload.mid) || 0);
  const mediaId = Math.max(1, Number(request.payload.mediaId) || 0);
  if (!mid || !mediaId) {
    throw new Error('创建分组参数不完整');
  }

  const folderSnapshot = await readFavoriteFolderSnapshot();
  const folder = folderSnapshot?.folders.find((item) => item.id === mediaId);
  if (!folder) {
    throw new Error('收藏夹不存在或不可用');
  }

  const { groups, feedCacheMap, group } = await upsertGroupConfig(createGroupConfigFromFolder(folder));
  const dialogData = buildAuthorGroupDialogData(mid, groups, feedCacheMap, folderSnapshot);

  return {
    ...dialogData,
    groupId: group.groupId,
    mediaId: group.mediaId,
    message: `已将收藏夹「${folder.title}」创建为分组`
  };
}

async function handleCreateFolderAndAuthorGroup(
  request: Extract<MessageRequest, { type: 'CREATE_FOLDER_AND_AUTHOR_GROUP' }>
): Promise<ResponseMap['CREATE_FOLDER_AND_AUTHOR_GROUP']> {
  const mid = Math.max(1, Number(request.payload.mid) || 0);
  const title = request.payload.title?.trim() || '';
  const csrf = request.payload.csrf?.trim();
  const pageOrigin = request.payload.pageOrigin?.trim();
  const pageReferer = request.payload.pageReferer?.trim();
  if (!mid || !title || !csrf || !pageOrigin || !pageReferer) {
    throw new Error('新建收藏夹参数不完整');
  }

  const createdFolder = await runWithFavRequestHeaders(pageOrigin, pageReferer, async () => (
    createFavoriteFolder(title, csrf)
  ));

  try {
    const { groups, feedCacheMap, group } = await upsertGroupConfig(createGroupConfigFromFolder(createdFolder));
    const folderSnapshot = await mergeCreatedFavoriteFolderIntoSnapshot(createdFolder);
    const dialogData = buildAuthorGroupDialogData(mid, groups, feedCacheMap, folderSnapshot);
    return {
      ...dialogData,
      groupId: group.groupId,
      mediaId: group.mediaId,
      message: `已创建私密收藏夹并生成分组「${createdFolder.title}」`
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '创建分组失败';
    throw new Error(`收藏夹已创建成功，但创建插件分组失败：${reason}`);
  }
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

async function handleSetGroupExcludeUnread(
  request: Extract<MessageRequest, { type: 'SET_GROUP_EXCLUDE_UNREAD' }>
): Promise<ResponseMap['SET_GROUP_EXCLUDE_UNREAD']> {
  const groups = await loadGroups();
  const index = groups.findIndex((item) => item.groupId === request.payload.groupId);
  if (index < 0) {
    throw new Error('分组不存在');
  }

  const previous = groups[index];
  const nextGroup: GroupConfig = {
    ...previous,
    excludeFromUnreadCount: request.payload.excludeFromUnreadCount === true,
    updatedAt: Date.now()
  };
  groups[index] = nextGroup;
  await saveGroups(groups);
  return { group: nextGroup };
}

function normalizeManualAuthorOrder(authorMids: number[]): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  for (const rawMid of authorMids) {
    const mid = Math.max(1, Number(rawMid) || 0);
    if (!mid || seen.has(mid)) {
      continue;
    }
    seen.add(mid);
    result.push(mid);
  }
  return result;
}

function mergeVisibleManualOrder(
  previousOrder: number[] | undefined,
  nextVisibleOrder: number[]
): number[] {
  const normalizedNextVisibleOrder = normalizeManualAuthorOrder(nextVisibleOrder);
  const normalizedPreviousOrder = normalizeManualAuthorOrder(previousOrder ?? []);
  if (normalizedPreviousOrder.length === 0) {
    return normalizedNextVisibleOrder;
  }

  const nextVisibleSet = new Set(normalizedNextVisibleOrder);
  const merged: number[] = [];
  let visibleCursor = 0;

  for (const mid of normalizedPreviousOrder) {
    if (!nextVisibleSet.has(mid)) {
      merged.push(mid);
      continue;
    }

    const replacement = normalizedNextVisibleOrder[visibleCursor];
    if (replacement) {
      merged.push(replacement);
      visibleCursor += 1;
    }
  }

  while (visibleCursor < normalizedNextVisibleOrder.length) {
    merged.push(normalizedNextVisibleOrder[visibleCursor]);
    visibleCursor += 1;
  }

  return normalizeManualAuthorOrder(merged);
}

async function handleSetGroupManualAuthorOrder(
  request: Extract<MessageRequest, { type: 'SET_GROUP_MANUAL_AUTHOR_ORDER' }>
): Promise<ResponseMap['SET_GROUP_MANUAL_AUTHOR_ORDER']> {
  const groupId = request.payload.groupId;
  if (!groupId) {
    throw new Error('分组参数不合法');
  }

  const [groups, settings, runtimeMap] = await Promise.all([
    loadGroups(),
    loadSettings(),
    loadRuntimeStateMap()
  ]);

  if (groupId === ALL_GROUP_ID) {
    if (!settings.enableAllGroup) {
      throw new Error('“全部”分组已关闭');
    }
  } else {
    const group = groups.find((item) => item.groupId === groupId && item.enabled);
    if (!group) {
      throw new Error('分组不存在或已禁用');
    }
  }

  const runtime = runtimeMap[groupId] ?? {
    groupId,
    unreadCount: 0,
    mixedTargetCount: settings.timelineMixedMaxCount
  };
  runtime.manualAuthorOrderMids = mergeVisibleManualOrder(runtime.manualAuthorOrderMids, request.payload.authorMids);
  runtimeMap[groupId] = runtime;
  await saveRuntimeStateMap(runtimeMap);

  return {
    groupId,
    authorMids: [...runtime.manualAuthorOrderMids]
  };
}

async function handleSaveSettings(
  request: Extract<MessageRequest, { type: 'SAVE_SETTINGS' }>
): Promise<ResponseMap['SAVE_SETTINGS']> {
  const settings = normalizeExtensionSettings({
    ...DEFAULT_SETTINGS,
    ...request.payload.settings
  });

  await saveSettings(settings);
  await setupAlarm(settings);

  return { settings };
}

async function handleGetGroupSummary(
  _request: Extract<MessageRequest, { type: 'GET_GROUP_SUMMARY' }>
): Promise<ResponseMap['GET_GROUP_SUMMARY']> {
  const [groups, settings, runtimeMap, feedCacheMap, authorCacheMap, readMarks, lastGroupId, authorPreferences] = await Promise.all([
    loadGroups(),
    loadSettings(),
    loadRuntimeStateMap(),
    loadFeedCacheMap(),
    getAuthorCacheSnapshot(),
    loadGroupReadMarks(),
    loadLastGroupId(),
    loadAuthorPreferences()
  ]);
  const [clickedVideos, reviewedOverrides] = await Promise.all([
    cleanOrphanClicks(authorCacheMap),
    cleanOrphanReviewedOverrides(authorCacheMap)
  ]);

  // 纯缓存读取，不再触发 API 请求；刷新由调度器 alarm 驱动
  const { summaries: allSummaries, totalUnreadCount } = makeSummary(
    groups,
    settings,
    runtimeMap,
    feedCacheMap,
    authorCacheMap,
    readMarks,
    clickedVideos,
    reviewedOverrides,
    authorPreferences
  );
  const summaries = allSummaries.filter((item) => item.enabled);
  if (settings.enableAllGroup && summaries.length > 0) {
    const allRuntime = runtimeMap[ALL_GROUP_ID];
    const allAuthorMids = Array.from(new Set(
      groups
        .filter((item) => item.enabled)
        .flatMap((item) => feedCacheMap[item.groupId]?.authorMids ?? [])
    ));
    summaries.unshift({
      groupId: ALL_GROUP_ID,
      title: '全部',
      unreadCount: totalUnreadCount,
      excludeFromUnreadCount: false,
      syncStatus: buildGroupSyncStatus(allAuthorMids, authorCacheMap, settings),
      lastRefreshAt: allRuntime?.lastRefreshAt,
      enabled: true,
      savedMode: allRuntime?.savedMode,
      savedReadMarkTs: undefined,
      savedRecentDays: undefined,
      savedAllPostsFilter: allRuntime?.savedAllPostsFilter,
      savedByAuthorSortByLatest: allRuntime?.savedByAuthorSortByLatest
    });
  }
  await saveRuntimeStateMap(runtimeMap);

  return {
    summaries,
    hasUnread: totalUnreadCount > 0,
    unreadCount: totalUnreadCount,
    lastGroupId,
    settings
  };
}

/**
 * 纯缓存读取 + 提交调度任务。
 * 无缓存时返回 cacheStatus: 'generating'，同时向调度器提交优先任务。
 * 有缓存但作者缓存不完整时：
 * - 立即优先入列缺失作者任务；
 * - 返回 cacheStatus: 'generating'，并携带当前可展示的缓存结果（不清空）。
 */
async function handleGetGroupFeed(
  request: Extract<MessageRequest, { type: 'GET_GROUP_FEED' }>
): Promise<ResponseMap['GET_GROUP_FEED']> {
  const [
    groups,
    settings,
    runtimeMap,
    feedCacheMap,
    initialAuthorCacheMap,
    clickedVideos,
    reviewedOverrides,
    authorPreferences
  ] = await Promise.all([
    loadGroups(),
    loadSettings(),
    loadRuntimeStateMap(),
    loadFeedCacheMap(),
    getAuthorCacheSnapshot(),
    loadClickedVideos(),
    loadVideoReviewedOverrides(),
    loadAuthorPreferences()
  ]);

  const isAllGroup = request.payload.groupId === ALL_GROUP_ID;
  const missingFavGroupIds: string[] = [];
  let mergedFeedCacheMap = feedCacheMap;
  let group: GroupConfig | undefined;

  if (isAllGroup) {
    if (!settings.enableAllGroup) {
      throw new Error('“全部”分组已关闭');
    }

    const allAuthorMids = new Set<number>();
    for (const item of groups) {
      if (!item.enabled) {
        continue;
      }
      const cache = feedCacheMap[item.groupId];
      if (!cache) {
        missingFavGroupIds.push(item.groupId);
        continue;
      }
      for (const mid of cache.authorMids) {
        allAuthorMids.add(mid);
      }
    }

    if (missingFavGroupIds.length > 0) {
      enqueuePriorityGroup(missingFavGroupIds, 'get-group-feed-missing-fav-cache');
    }

    group = {
      groupId: ALL_GROUP_ID,
      mediaId: 0,
      mediaTitle: '全部',
      alias: '全部',
      enabled: true,
      excludeFromUnreadCount: false,
      createdAt: 0,
      updatedAt: Date.now()
    };
    mergedFeedCacheMap = {
      ...feedCacheMap,
      [ALL_GROUP_ID]: {
        groupId: ALL_GROUP_ID,
        authorMids: Array.from(allAuthorMids),
        updatedAt: Date.now()
      }
    };
  } else {
    group = groups.find((item) => item.groupId === request.payload.groupId && item.enabled);
    if (!group) {
      throw new Error('分组不存在或已禁用');
    }
  }
  if (!group) {
    throw new Error('分组不存在或已禁用');
  }

  const feedCache = mergedFeedCacheMap[group.groupId];
  let runtimeMutatedByLoadMore = false;

  // 无缓存：首次访问，提交收藏夹优先任务，等待调度器异步生成缓存。
  if (!feedCache) {
    if (!isAllGroup) {
      enqueuePriorityGroup([group.groupId], 'get-group-feed-missing-fav-cache');
    }

    return {
      groupId: group.groupId,
      mode: request.payload.mode,
      mixedVideos: [],
      videosByAuthor: [],
      syncStatus: { totalAuthors: 0, staleAuthors: 0 },
      unreadCount: 0,
      hasMoreForMixed: false,
      readMarkTimestamps: [],
      graceReadMarkTs: 0,
      byAuthorPageSize: settings.authorVideosPageSize,
      cacheStatus: 'generating'
    };
  }

  // 加载更多：仅增加目标数量，不发起 API 请求
  if (request.payload.loadMore) {
    increaseMixedTarget(group.groupId, settings, runtimeMap);
    runtimeMutatedByLoadMore = true;
  }

  await saveLastGroupId(group.groupId);

  const readMarks = await loadGroupReadMarks();
  const recentDays = request.payload.recentDays ?? settings.defaultReadMarkDays;
  const activeReadMarkTs = isAllGroup ? undefined : request.payload.activeReadMarkTs;
  const showAllForMixed = request.payload.showAllForMixed === true;
  const allPostsFilter = request.payload.allPostsFilter ?? 'all';

  const runtimeBefore = JSON.stringify(runtimeMap[group.groupId] ?? null);
  let authorCacheMap = initialAuthorCacheMap;
  const diagnostics: MixedBuildDiagnostics | undefined = request.payload.mode === 'mixed'
    ? { usedPages: [], boundaryTasks: [] }
    : undefined;
  const result: Omit<ResponseMap['GET_GROUP_FEED'], 'cacheStatus'> = {
    ...toFeedResult(
      group,
      request.payload.mode,
      settings,
      runtimeMap,
      mergedFeedCacheMap,
      authorCacheMap,
      readMarks,
      clickedVideos,
      reviewedOverrides,
      authorPreferences,
      recentDays,
      activeReadMarkTs,
      showAllForMixed,
      allPostsFilter,
      request.payload.byAuthorSortByLatest,
      diagnostics
    ),
    warningMsg: undefined
  };

  const hasBoundaryIntent = Boolean(diagnostics && diagnostics.boundaryTasks.length > 0);
  if (hasBoundaryIntent) {
    enqueueBurst(
      diagnostics!.boundaryTasks.map((task) => ({
        ...task,
        staleAt: authorCacheMap[task.mid]?.lastFirstPageFetchedAt
          || authorCacheMap[task.mid]?.firstPageFetchedAt
          || authorCacheMap[task.mid]?.lastFetchedAt
          || 0,
        reason: 'load-more-boundary',
        trigger: 'get-group-feed-boundary'
      }))
    );
  }

  const runtimeAfter = JSON.stringify(runtimeMap[group.groupId] ?? null);
  const runtimeChanged = runtimeBefore !== runtimeAfter;

  const missingAuthorTasks = splitMissingAuthorTasks(feedCache.authorMids, authorCacheMap, settings.authorVideosPageSize);
  if (missingAuthorTasks.burst.length > 0 || missingAuthorTasks.priority.length > 0) {
    const requestContext = createSchedulerRequestContext();
    enqueueBurst(missingAuthorTasks.burst, requestContext);
    enqueuePriority(missingAuthorTasks.priority, requestContext);
    if (runtimeChanged || runtimeMutatedByLoadMore) {
      await saveRuntimeStateMap(runtimeMap);
    }
    return { ...result, cacheStatus: 'generating' };
  }

  if (isAllGroup && missingFavGroupIds.length > 0) {
    if (runtimeChanged || runtimeMutatedByLoadMore) {
      await saveRuntimeStateMap(runtimeMap);
    }
    return { ...result, cacheStatus: 'generating' };
  }

  if (hasBoundaryIntent) {
    if (runtimeChanged || runtimeMutatedByLoadMore) {
      await saveRuntimeStateMap(runtimeMap);
    }
    return { ...result, cacheStatus: 'generating' };
  }

  if (runtimeChanged || runtimeMutatedByLoadMore) {
    await saveRuntimeStateMap(runtimeMap);
  }

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

async function handleMarkGroupReadMark(
  request: Extract<MessageRequest, { type: 'MARK_GROUP_READ_MARK' }>
): Promise<ResponseMap['MARK_GROUP_READ_MARK']> {
  if (request.payload.groupId === ALL_GROUP_ID) {
    throw new Error('“全部”分组不支持设置分组已阅基线');
  }
  const [marks, settings, runtimeMap] = await Promise.all([
    appendGroupReadMark(request.payload.groupId, request.payload.readMarkTs),
    loadSettings(),
    loadRuntimeStateMap()
  ]);
  const latestTs = marks[request.payload.groupId]?.timestamps?.[0];
  const runtime = runtimeMap[request.payload.groupId] ?? {
    groupId: request.payload.groupId,
    unreadCount: 0,
    mixedTargetCount: settings.timelineMixedMaxCount
  };
  runtime.savedReadMarkTs = typeof latestTs === 'number' && latestTs > 0 ? latestTs : undefined;
  runtime.savedRecentDays = runtime.savedRecentDays ?? settings.defaultReadMarkDays;
  runtimeMap[request.payload.groupId] = runtime;
  await saveRuntimeStateMap(runtimeMap);
  return { marks };
}

async function handleUndoGroupReadMark(
  request: Extract<MessageRequest, { type: 'UNDO_GROUP_READ_MARK' }>
): Promise<ResponseMap['UNDO_GROUP_READ_MARK']> {
  if (request.payload.groupId === ALL_GROUP_ID) {
    throw new Error('“全部”分组不支持撤销分组已阅基线');
  }
  const [result, settings, runtimeMap] = await Promise.all([
    undoLatestGroupReadMark(request.payload.groupId),
    loadSettings(),
    loadRuntimeStateMap()
  ]);
  const runtime = runtimeMap[request.payload.groupId] ?? {
    groupId: request.payload.groupId,
    unreadCount: 0,
    mixedTargetCount: settings.timelineMixedMaxCount
  };
  const nextLatestTs = result.marks[request.payload.groupId]?.timestamps?.[0];
  runtime.savedReadMarkTs = typeof nextLatestTs === 'number' && nextLatestTs > 0 ? nextLatestTs : undefined;
  runtime.savedRecentDays = runtime.savedRecentDays ?? settings.defaultReadMarkDays;
  runtimeMap[request.payload.groupId] = runtime;
  await saveRuntimeStateMap(runtimeMap);
  return result;
}

async function handleClearGroupReadMark(
  request: Extract<MessageRequest, { type: 'CLEAR_GROUP_READ_MARK' }>
): Promise<ResponseMap['CLEAR_GROUP_READ_MARK']> {
  if (request.payload.groupId === ALL_GROUP_ID) {
    throw new Error('“全部”分组不支持清除分组已阅基线');
  }
  const [result, runtimeMap] = await Promise.all([
    clearGroupReadMark(request.payload.groupId),
    loadRuntimeStateMap()
  ]);
  const runtime = runtimeMap[request.payload.groupId];
  if (runtime) {
    runtime.savedReadMarkTs = undefined;
    runtimeMap[request.payload.groupId] = runtime;
    await saveRuntimeStateMap(runtimeMap);
  }
  return result;
}

async function handleGetGroupReadMarks(
  request: Extract<MessageRequest, { type: 'GET_GROUP_READ_MARKS' }>
): Promise<ResponseMap['GET_GROUP_READ_MARKS']> {
  const allMarks = await loadGroupReadMarks();
  const filtered: Record<string, (typeof allMarks)[string]> = {};

  for (const groupId of request.payload.groupIds) {
    if (allMarks[groupId]) {
      filtered[groupId] = allMarks[groupId];
    }
  }

  return { marks: filtered };
}

/**
 * 关注/取消关注作者，并尽量同步回写 AuthorVideoCache 中的 Card 信息。
 */
async function handleFollowAuthor(
  request: Extract<MessageRequest, { type: 'FOLLOW_AUTHOR' }>,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMap['FOLLOW_AUTHOR']> {
  const mid = request.payload.mid;
  const follow = request.payload.follow;
  const csrf = request.payload.csrf?.trim();
  const pageOrigin = request.payload.pageOrigin?.trim();
  const pageReferer = request.payload.pageReferer?.trim();
  if (!mid || !csrf || !pageOrigin || !pageReferer || !sender.tab?.id) {
    throw new Error('关注参数不完整');
  }

  await runWithFollowRequestHeaders(pageOrigin, pageReferer, async () => {
    await modifyUserRelation(mid, follow, csrf);
  });

  const authorCacheMap = await getAuthorCacheSnapshot();
  const existing = authorCacheMap[mid];
  const patch: ResponseMap['FOLLOW_AUTHOR'] = {
    mid,
    following: follow
  };

  try {
    const card = await getUserCard(mid);
    patch.following = card.following ?? follow;
    patch.follower = card.follower;
    patch.name = card.name;
    patch.face = card.face;

    if (existing) {
      authorCacheMap[mid] = {
        ...existing,
        name: card.name || existing.name,
        face: card.face || existing.face,
        follower: card.follower ?? existing.follower,
        following: card.following ?? follow
      };
      await saveAuthorVideoCacheMap(authorCacheMap);
    }
  } catch {
    // Card 同步失败不影响关注主流程，前台可继续使用乐观状态。
    if (existing) {
      const currentFollower = existing.follower;
      authorCacheMap[mid] = {
        ...existing,
        following: follow,
        follower:
          typeof currentFollower === 'number'
            ? Math.max(0, currentFollower + (follow ? 1 : -1))
            : currentFollower
      };
      await saveAuthorVideoCacheMap(authorCacheMap);
      patch.follower = authorCacheMap[mid].follower;
      patch.name = authorCacheMap[mid].name;
      patch.face = authorCacheMap[mid].face;
    }
  }

  return patch;
}

/**
 * 点赞/取消点赞视频。
 */
async function handleLikeVideo(
  request: Extract<MessageRequest, { type: 'LIKE_VIDEO' }>,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMap['LIKE_VIDEO']> {
  const csrf = request.payload.csrf?.trim();
  const pageOrigin = request.payload.pageOrigin?.trim();
  const pageReferer = request.payload.pageReferer?.trim();
  const authorMid = Math.max(1, Number(request.payload.authorMid) || 0);
  const tabId = sender.tab?.id;
  const aid = Math.max(0, Math.floor(Number(request.payload.aid) || 0));
  const bvid = request.payload.bvid?.trim() || '';
  if (!csrf || !pageOrigin || !pageReferer || !authorMid || typeof tabId !== 'number' || !aid || !bvid) {
    throw new Error('点赞参数不完整');
  }
  const like = request.payload.like === true;
  const result = await enqueueLikeActionAndWait({
    aid,
    bvid,
    authorMid,
    csrf,
    like,
    pageContext: {
      tabId,
      pageOrigin,
      pageReferer
    }
  });
  if (result.liked) {
    await recordVideoLiked(result.bvid, Date.now());
  } else {
    await clearVideoLiked(result.bvid);
  }
  return {
    aid: result.aid,
    bvid: result.bvid,
    liked: result.liked
  };
}

/**
 * 给视频投币。
 */
async function handleCoinVideo(
  request: Extract<MessageRequest, { type: 'COIN_VIDEO' }>
): Promise<ResponseMap['COIN_VIDEO']> {
  const csrf = request.payload.csrf?.trim();
  if (!csrf) {
    throw new Error('投币参数不完整');
  }
  const target = normalizeVideoTarget(request.payload);
  const multiply = Number(request.payload.multiply) >= 2 ? 2 : 1;
  const selectLike = request.payload.selectLike === true;
  const result = await coinVideo(target, multiply, selectLike, csrf);
  return {
    aid: target.aid,
    bvid: target.bvid,
    multiply,
    selectLike,
    like: result.like
  };
}

/**
 * 作者级批量点赞：按当前前台可见视频入队，后台串行执行并汇总结果。
 */
async function handleBatchLikeVideos(
  request: Extract<MessageRequest, { type: 'BATCH_LIKE_VIDEOS' }>,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMap['BATCH_LIKE_VIDEOS']> {
  const authorMid = Math.max(1, Number(request.payload.authorMid) || 0);
  if (!authorMid) {
    throw new Error('作者参数不完整');
  }
  const csrf = request.payload.csrf?.trim();
  const pageOrigin = request.payload.pageOrigin?.trim();
  const pageReferer = request.payload.pageReferer?.trim();
  const tabId = sender.tab?.id;
  if (!csrf || !pageOrigin || !pageReferer || typeof tabId !== 'number') {
    throw new Error('点赞参数不完整');
  }

  const videos = (request.payload.videos ?? [])
    .map((video) => ({
      aid: Math.max(0, Math.floor(Number(video.aid) || 0)),
      bvid: video.bvid?.trim() || ''
    }))
    .filter((video) => video.aid > 0 && video.bvid);

  if (videos.length === 0) {
    return {
      authorMid,
      total: 0,
      queuedCount: 0,
      queuedBvids: [],
      skippedBvids: []
    };
  }

  const batch = enqueueLikeBatch(authorMid, videos, csrf, {
    tabId,
    pageOrigin,
    pageReferer
  }, {
    onTaskFinished: async ({ task, result }) => {
      if (result.ok && result.result) {
        const likedAt = result.result.liked ? Date.now() : undefined;
        if (result.result.liked && likedAt) {
          await recordVideoLiked(result.result.bvid, likedAt);
        } else {
          await clearVideoLiked(result.result.bvid);
        }
        await sendLikeTaskStatusMessage(sender, {
          type: 'LIKE_TASK_STATUS',
          payload: {
            authorMid: result.result.authorMid,
            bvid: result.result.bvid,
            source: result.result.source,
            status: 'success',
            liked: result.result.liked,
            likedAt
          }
        });
        return;
      }

      await sendLikeTaskStatusMessage(sender, {
        type: 'LIKE_TASK_STATUS',
        payload: {
          authorMid: task.authorMid,
          bvid: task.bvid,
          source: task.source,
          status: 'failed',
          error: result.error
        }
      });
    }
  });
  void batch.completion
    .then(async (result) => {
      await sendBatchLikeStatusMessage(sender, {
        type: 'BATCH_LIKE_STATUS',
        payload: {
          authorMid: result.authorMid,
          total: result.total,
          successCount: result.successCount,
          failedCount: result.failedCount,
          failedBvids: result.failedBvids
        }
      });
    })
    .catch((error) => {
      debugWarn('[BBE] 批量点赞完成通知失败:', error);
    });

  return {
    authorMid: batch.authorMid,
    total: batch.total,
    queuedCount: batch.queuedCount,
    queuedBvids: batch.queuedBvids,
    skippedBvids: batch.skippedBvids
  };
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

async function handleGetLikedVideos(
  request: Extract<MessageRequest, { type: 'GET_LIKED_VIDEOS' }>
): Promise<ResponseMap['GET_LIKED_VIDEOS']> {
  const allLiked = await loadLikedVideos();
  const liked: Record<string, number> = {};

  for (const bvid of request.payload.bvids) {
    if (allLiked[bvid]) {
      liked[bvid] = allLiked[bvid];
    }
  }

  return { liked };
}

async function handleSetVideoReviewed(
  request: Extract<MessageRequest, { type: 'SET_VIDEO_REVIEWED' }>
): Promise<ResponseMap['SET_VIDEO_REVIEWED']> {
  await setVideoReviewedOverride(request.payload.bvid, request.payload.reviewed);
  return {
    bvid: request.payload.bvid,
    reviewed: request.payload.reviewed
  };
}

async function handleGetVideoReviewedOverrides(
  request: Extract<MessageRequest, { type: 'GET_VIDEO_REVIEWED_OVERRIDES' }>
): Promise<ResponseMap['GET_VIDEO_REVIEWED_OVERRIDES']> {
  const all = await loadVideoReviewedOverrides();
  const overrides: Record<string, boolean> = {};

  for (const bvid of request.payload.bvids) {
    if (Object.prototype.hasOwnProperty.call(all, bvid)) {
      overrides[bvid] = all[bvid] === true;
    }
  }

  return { overrides };
}

async function handleSetAuthorIgnoreUnread(
  request: Extract<MessageRequest, { type: 'SET_AUTHOR_IGNORE_UNREAD' }>
): Promise<ResponseMap['SET_AUTHOR_IGNORE_UNREAD']> {
  const preference = await setAuthorIgnoreUnreadCount(request.payload.mid, request.payload.ignoreUnreadCount);
  return { preference };
}

async function handleSetAuthorReadMark(
  request: Extract<MessageRequest, { type: 'SET_AUTHOR_READ_MARK' }>
): Promise<ResponseMap['SET_AUTHOR_READ_MARK']> {
  const preference = await setAuthorReadMark(request.payload.mid, request.payload.readMarkTs);
  return { preference };
}

async function handleUndoAuthorReadMark(
  request: Extract<MessageRequest, { type: 'UNDO_AUTHOR_READ_MARK' }>
): Promise<ResponseMap['UNDO_AUTHOR_READ_MARK']> {
  return undoAuthorReadMark(request.payload.mid);
}

async function handleClearAuthorReadMark(
  request: Extract<MessageRequest, { type: 'CLEAR_AUTHOR_READ_MARK' }>
): Promise<ResponseMap['CLEAR_AUTHOR_READ_MARK']> {
  const preference = await clearAuthorReadMark(request.payload.mid);
  return { preference };
}

/**
 * 提交“作者分页意图”到调度器：
 * - 前台可表达“希望查看某作者某页”；
 * - 具体拉取时机/顺序由调度器决定，接口本身不等待执行完成。
 */
async function handleRequestAuthorPage(
  request: Extract<MessageRequest, { type: 'REQUEST_AUTHOR_PAGE' }>,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMap['REQUEST_AUTHOR_PAGE']> {
  const groupId = request.payload.groupId;
  const mid = Math.max(1, Number(request.payload.mid) || 0);
  const pn = Math.max(1, Number(request.payload.pn) || 1);
  const ps = Math.max(1, Number(request.payload.ps) || 0);
  if (!groupId) {
    throw new Error('分组参数不合法');
  }
  if (!mid) {
    throw new Error('作者参数不合法');
  }
  if (!ps) {
    throw new Error('分页大小参数不合法');
  }

  const [groups, settings, authorCacheMap] = await Promise.all([
    loadGroups(),
    loadSettings(),
    getAuthorCacheSnapshot()
  ]);

  if (groupId === ALL_GROUP_ID) {
    if (!settings.enableAllGroup) {
      throw new Error('“全部”分组已关闭');
    }
  } else {
    const group = groups.find((item) => item.groupId === groupId && item.enabled);
    if (!group) {
      throw new Error('分组不存在或已禁用');
    }
  }

  const forceRefreshCurrentPage = request.payload.options?.forceRefreshCurrentPage === true;
  const ensureContinuousFromHead = request.payload.options?.ensureContinuousFromHead === true;
  const cache = authorCacheMap[mid];
  const maxPage = getAuthorPageCount(cache, ps);

  if (typeof maxPage === 'number' && pn > maxPage) {
    return {
      accepted: false,
      status: 'no-more',
      maxPage
    };
  }

  const requestedAt = Date.now();

  observeBurstTaskFirstResult(
    {
      mid,
      name: cache?.name?.trim() || String(mid),
      groupId,
      pn,
      ps,
      staleAt: cache?.lastFirstPageFetchedAt || cache?.firstPageFetchedAt || cache?.lastFetchedAt || 0,
      reason: forceRefreshCurrentPage ? 'refresh-author-current-page' : 'request-author-page',
      trigger: 'request-author-page',
      forceRefreshCurrentPage,
      ensureContinuousFromHead,
      failFast: false
    },
    (result) => {
      void sendAuthorPageStatusMessage(sender, {
        type: 'AUTHOR_PAGE_STATUS',
        payload: {
          groupId,
          mid,
          pn,
          ps,
          status: result.ok ? 'ready' : 'failed',
          error: result.error
        }
      });
    }
  );

  enqueueBurst([
    {
      mid,
      name: cache?.name?.trim() || String(mid),
      groupId,
      pn,
      ps,
      staleAt: cache?.lastFirstPageFetchedAt || cache?.firstPageFetchedAt || cache?.lastFetchedAt || 0,
      reason: forceRefreshCurrentPage ? 'refresh-author-current-page' : 'request-author-page',
      trigger: 'request-author-page',
      forceRefreshCurrentPage,
      ensureContinuousFromHead,
      failFast: false
    }
  ]);

  return {
    accepted: true,
    status: 'queued',
    maxPage,
    requestedAt
  };
}

async function handleGetAuthorPage(
  request: Extract<MessageRequest, { type: 'GET_AUTHOR_PAGE' }>
): Promise<ResponseMap['GET_AUTHOR_PAGE']> {
  const mid = Math.max(1, Number(request.payload.mid) || 0);
  const pn = Math.max(1, Number(request.payload.pn) || 1);
  const ps = Math.max(1, Number(request.payload.ps) || 0);
  if (!mid || !ps) {
    throw new Error('作者分页参数不合法');
  }

  const authorCacheMap = await getAuthorCacheSnapshot();
  const cache = authorCacheMap[mid];
  const snapshot = getCachedAuthorPageSnapshot(cache, pn, ps);
  return {
    available: snapshot.videos.length > 0,
    mid,
    pn,
    ps,
    maxPage: getAuthorPageCount(cache, ps),
    totalCount: cache?.latestKnownTotalCount ?? cache?.latestKnownVersion?.totalCount,
    fetchedAt: snapshot.fetchedAt,
    videos: snapshot.videos
  };
}

async function handleGetAuthorPreferences(
  request: Extract<MessageRequest, { type: 'GET_AUTHOR_PREFERENCES' }>
): Promise<ResponseMap['GET_AUTHOR_PREFERENCES']> {
  const all = await loadAuthorPreferences();
  const preferences: Record<number, (typeof all)[number]> = {};
  for (const mid of request.payload.mids) {
    if (all[mid]) {
      preferences[mid] = all[mid];
    }
  }
  return { preferences };
}

async function handleGroupRefreshRequest(input: {
  groupId: string;
  trigger: 'manual-refresh-posts' | 'manual-refresh-fav';
  authorRefreshMode: 'force' | 'none';
}): Promise<{ accepted: boolean }> {
  const groups = await loadGroups();

  if (input.groupId === ALL_GROUP_ID) {
    const enabledGroupIds = groups.filter((item) => item.enabled).map((item) => item.groupId);
    if (enabledGroupIds.length === 0) {
      throw new Error('当前没有可刷新的启用分组');
    }
    enqueuePriorityGroup(enabledGroupIds, input.trigger, input.authorRefreshMode);
    return { accepted: true };
  }

  const group = groups.find((item) => item.groupId === input.groupId && item.enabled);
  if (!group) {
    throw new Error('分组不存在或已禁用');
  }

  enqueuePriorityGroup([group.groupId], input.trigger, input.authorRefreshMode);

  return { accepted: true };
}

/**
 * “刷新投稿列表”：先刷新收藏夹缓存，再强制刷新该分组作者首页。
 */
async function handleRefreshGroupPosts(
  request: Extract<MessageRequest, { type: 'REFRESH_GROUP_POSTS' }>
): Promise<ResponseMap['REFRESH_GROUP_POSTS']> {
  return handleGroupRefreshRequest({
    groupId: request.payload.groupId,
    trigger: 'manual-refresh-posts',
    authorRefreshMode: 'force'
  });
}

/**
 * “刷新收藏夹”：只刷新分组标题与作者列表，不继续刷新作者投稿缓存。
 */
async function handleRefreshGroupFav(
  request: Extract<MessageRequest, { type: 'REFRESH_GROUP_FAV' }>
): Promise<ResponseMap['REFRESH_GROUP_FAV']> {
  return handleGroupRefreshRequest({
    groupId: request.payload.groupId,
    trigger: 'manual-refresh-fav',
    authorRefreshMode: 'none'
  });
}

async function handleGetSchedulerStatus(): Promise<ResponseMap['GET_SCHEDULER_STATUS']> {
  return getStatus();
}

async function handleRunSchedulerNow(): Promise<ResponseMap['RUN_SCHEDULER_NOW']> {
  return runSchedulerNow();
}

async function handleReportBilibiliTabOpen(): Promise<ResponseMap['REPORT_BILIBILI_TAB_OPEN']> {
  return runTabOpenOpportunisticRefresh();
}

async function routeMessage(request: MessageRequest, sender: chrome.runtime.MessageSender): Promise<MessageResponse> {
  switch (request.type) {
    case 'PING':
      return ok({ pong: true });
    case 'REPORT_BILIBILI_TAB_OPEN':
      return ok(await handleReportBilibiliTabOpen());
    case 'GET_OPTIONS_DATA':
      return ok(await handleGetOptionsData(request));
    case 'GET_AUTHOR_GROUP_MEMBERSHIP':
      return ok(await handleGetAuthorGroupMembership(request));
    case 'GET_AUTHOR_GROUP_DIALOG_DATA':
      return ok(await handleGetAuthorGroupDialogData(request));
    case 'UPSERT_GROUP':
      return ok(await handleUpsertGroup(request));
    case 'CREATE_AUTHOR_GROUP_FROM_FOLDER':
      return ok(await handleCreateAuthorGroupFromFolder(request));
    case 'CREATE_FOLDER_AND_AUTHOR_GROUP':
      return ok(await handleCreateFolderAndAuthorGroup(request));
    case 'DELETE_GROUP':
      return ok(await handleDeleteGroup(request));
    case 'SET_GROUP_EXCLUDE_UNREAD':
      return ok(await handleSetGroupExcludeUnread(request));
    case 'SET_GROUP_MANUAL_AUTHOR_ORDER':
      return ok(await handleSetGroupManualAuthorOrder(request));
    case 'SAVE_SETTINGS':
      return ok(await handleSaveSettings(request));
    case 'GET_GROUP_SUMMARY':
      return ok(await handleGetGroupSummary(request));
    case 'GET_GROUP_FEED':
      return ok(await handleGetGroupFeed(request));
    case 'UPDATE_AUTHOR_GROUP_MEMBERSHIP':
      return ok(await handleUpdateAuthorGroupMembership(request));
    case 'MARK_GROUP_READ':
      return ok(await handleMarkGroupRead(request));
    case 'MARK_GROUP_READ_MARK':
      return ok(await handleMarkGroupReadMark(request));
    case 'UNDO_GROUP_READ_MARK':
      return ok(await handleUndoGroupReadMark(request));
    case 'CLEAR_GROUP_READ_MARK':
      return ok(await handleClearGroupReadMark(request));
    case 'FOLLOW_AUTHOR':
      return ok(await handleFollowAuthor(request, sender));
    case 'LIKE_VIDEO':
      return ok(await handleLikeVideo(request, sender));
    case 'COIN_VIDEO':
      return ok(await handleCoinVideo(request));
    case 'BATCH_LIKE_VIDEOS':
      return ok(await handleBatchLikeVideos(request, sender));
    case 'GET_GROUP_READ_MARKS':
      return ok(await handleGetGroupReadMarks(request));
    case 'RECORD_VIDEO_CLICK':
      return ok(await handleRecordVideoClick(request));
    case 'GET_CLICKED_VIDEOS':
      return ok(await handleGetClickedVideos(request));
    case 'GET_LIKED_VIDEOS':
      return ok(await handleGetLikedVideos(request));
    case 'SET_VIDEO_REVIEWED':
      return ok(await handleSetVideoReviewed(request));
    case 'GET_VIDEO_REVIEWED_OVERRIDES':
      return ok(await handleGetVideoReviewedOverrides(request));
    case 'SET_AUTHOR_IGNORE_UNREAD':
      return ok(await handleSetAuthorIgnoreUnread(request));
    case 'SET_AUTHOR_READ_MARK':
      return ok(await handleSetAuthorReadMark(request));
    case 'UNDO_AUTHOR_READ_MARK':
      return ok(await handleUndoAuthorReadMark(request));
    case 'CLEAR_AUTHOR_READ_MARK':
      return ok(await handleClearAuthorReadMark(request));
    case 'REQUEST_AUTHOR_PAGE':
      return ok(await handleRequestAuthorPage(request, sender));
    case 'GET_AUTHOR_PAGE':
      return ok(await handleGetAuthorPage(request));
    case 'GET_AUTHOR_PREFERENCES':
      return ok(await handleGetAuthorPreferences(request));
    case 'REFRESH_GROUP_POSTS':
      return ok(await handleRefreshGroupPosts(request));
    case 'REFRESH_GROUP_FAV':
      return ok(await handleRefreshGroupFav(request));
    case 'GET_SCHEDULER_STATUS':
      return ok(await handleGetSchedulerStatus());
    case 'RUN_SCHEDULER_NOW':
      return ok(await handleRunSchedulerNow());
    default:
      return fail('不支持的消息类型');
  }
}

ext.runtime.onInstalled.addListener(() => {
  void (async () => {
    const settings = await loadSettings();
    const merged = normalizeExtensionSettings({ ...DEFAULT_SETTINGS, ...settings });
    await saveSettings(merged);
    await Promise.all([cleanOrphanClicks(), cleanOrphanReviewedOverrides()]);
    await setupAlarm(merged);
  })();
});

ext.runtime.onMessage.addListener((request: MessageRequest, sender, sendResponse) => {
  routeMessage(request, sender)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse(fail(error)));

  return true;
});
