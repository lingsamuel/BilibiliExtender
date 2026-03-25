import { AUTHOR_VIDEOS_PAGE_SIZE, DEFAULT_SETTINGS, VIRTUAL_GROUP_ID } from '@/shared/constants';
import {
  coinVideo,
  getMyCreatedFolders,
  getUserCard,
  modifyUserRelation
} from '@/shared/api/bilibili';
import type { MessageRequest, MessageResponse, ResponseMap } from '@/shared/messages';
import { ext } from '@/shared/platform/webext';
import {
  appendGroupReadMark,
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
  setVideoReviewedOverride,
  saveAuthorVideoCacheMap,
  saveFeedCacheMap,
  saveGroups,
  saveLastGroupId,
  saveRuntimeStateMap,
  saveSettings
} from '@/shared/storage/repository';
import type { GroupConfig, GroupReadMark } from '@/shared/types';
import {
  hasAuthorMorePages,
  increaseMixedTarget,
  makeSummary,
  markGroupRead,
  removeGroupState,
  toFeedResult,
  type MixedBuildDiagnostics
} from '@/background/feed-service';
import {
  enqueueBurst,
  enqueueLikeActionAndWait,
  enqueueLikeBatchAndWait,
  enqueuePriority,
  enqueuePriorityGroup,
  getAuthorCacheSnapshot,
  getStatus,
  reportAuthorPageUsage,
  runSchedulerNow,
  setupAlarm
} from '@/background/scheduler';
import { runWithFollowRequestHeaders } from '@/background/request-dnr';

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
  burst: Array<{ mid: number; name: string; pn: number; reason: 'first-page-refresh'; trigger: 'get-group-feed-missing-author-cache' }>;
  priority: Array<{ mid: number; name: string; pn: number; reason: 'first-page-refresh'; trigger: 'get-group-feed-missing-author-cache' }>;
}

const ALL_GROUP_ID = VIRTUAL_GROUP_ID.ALL;

/**
 * 判定某个分组内哪些作者还没有完成“至少一轮作者缓存”并按队列分流：
 * - 无缓存：进入 Burst；
 * - 有缓存但无 lastFetchedAt：进入常规优先队列。
 */
function splitMissingAuthorTasks(
  authorMids: number[],
  authorCacheMap: Awaited<ReturnType<typeof getAuthorCacheSnapshot>>
): MissingAuthorTaskBuckets {
  const burst: Array<{ mid: number; name: string; pn: number; reason: 'first-page-refresh'; trigger: 'get-group-feed-missing-author-cache' }> = [];
  const priority: Array<{ mid: number; name: string; pn: number; reason: 'first-page-refresh'; trigger: 'get-group-feed-missing-author-cache' }> = [];

  for (const mid of authorMids) {
    const cache = authorCacheMap[mid];
    if (cache?.lastFetchedAt) {
      continue;
    }

    const task = {
      mid,
      name: cache?.name?.trim() || String(mid),
      pn: 1,
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

  // 新增分组后立即触发一次该分组刷新，确保尽快生成首份缓存。
  if (index < 0) {
    enqueuePriorityGroup([incoming.groupId], 'group-created-auto-refresh');
  }

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
    summaries.unshift({
      groupId: ALL_GROUP_ID,
      title: '全部',
      unreadCount: totalUnreadCount,
      lastRefreshAt: allRuntime?.lastRefreshAt,
      enabled: true,
      savedMode: allRuntime?.savedMode,
      savedReadMarkTs: allRuntime?.savedReadMarkTs,
      savedOverviewFilter: allRuntime?.savedOverviewFilter,
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
      unreadCount: 0,
      hasMoreForMixed: false,
      readMarkTimestamps: [],
      graceReadMarkTs: 0,
      byAuthorPageSize: AUTHOR_VIDEOS_PAGE_SIZE,
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
  const selectedReadMarkTs = request.payload.selectedReadMarkTs ?? 0;
  const overviewFilter = request.payload.overviewFilter ?? 'none';

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
      selectedReadMarkTs,
      overviewFilter,
      request.payload.byAuthorSortByLatest,
      diagnostics
    ),
    warningMsg: undefined
  };

  if (diagnostics && diagnostics.usedPages.length > 0) {
    await reportAuthorPageUsage(group.groupId, diagnostics.usedPages);
    // 仅更新页级使用反馈，不改变本次读取返回的内容。
    authorCacheMap = await getAuthorCacheSnapshot();
  }

  const hasBoundaryIntent = Boolean(diagnostics && diagnostics.boundaryTasks.length > 0);
  if (hasBoundaryIntent) {
    enqueueBurst(
      diagnostics!.boundaryTasks.map((task) => ({
        ...task,
        reason: 'load-more-boundary',
        trigger: 'get-group-feed-boundary'
      }))
    );
  }

  const runtimeAfter = JSON.stringify(runtimeMap[group.groupId] ?? null);
  const runtimeChanged = runtimeBefore !== runtimeAfter;

  const missingAuthorTasks = splitMissingAuthorTasks(feedCache.authorMids, authorCacheMap);
  if (missingAuthorTasks.burst.length > 0 || missingAuthorTasks.priority.length > 0) {
    enqueueBurst(missingAuthorTasks.burst);
    enqueuePriority(missingAuthorTasks.priority);
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
  const marks = await appendGroupReadMark(request.payload.groupId, request.payload.readMarkTs);
  return { marks };
}

async function handleMarkAllGroupsRead(): Promise<ResponseMap['MARK_ALL_GROUPS_READ']> {
  const groups = await loadGroups();
  const enabledGroups = groups.filter((item) => item.enabled);
  const readMarkTs = Math.floor(Math.floor(Date.now() / 1000) / 60) * 60;
  const mergedMarks: Record<string, GroupReadMark> = {};

  for (const group of enabledGroups) {
    const marks = await appendGroupReadMark(group.groupId, readMarkTs);
    if (marks[group.groupId]) {
      mergedMarks[group.groupId] = marks[group.groupId];
    }
  }

  return {
    marks: mergedMarks,
    readMarkTs
  };
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
      successCount: 0,
      failedCount: 0,
      failedBvids: []
    };
  }

  const result = await enqueueLikeBatchAndWait(authorMid, videos, csrf, {
    tabId,
    pageOrigin,
    pageReferer
  });
  const failedBvids = new Set(result.failedBvids);
  const succeededVideos = videos.filter((video) => !failedBvids.has(video.bvid));
  await Promise.all(succeededVideos.map((video) => recordVideoLiked(video.bvid, Date.now())));
  return result;
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
  request: Extract<MessageRequest, { type: 'REQUEST_AUTHOR_PAGE' }>
): Promise<ResponseMap['REQUEST_AUTHOR_PAGE']> {
  const groupId = request.payload.groupId;
  const mid = Math.max(1, Number(request.payload.mid) || 0);
  const pn = Math.max(1, Number(request.payload.pn) || 1);
  if (!groupId) {
    throw new Error('分组参数不合法');
  }
  if (!mid) {
    throw new Error('作者参数不合法');
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

  const cache = authorCacheMap[mid];
  if (cache?.pageState[pn]) {
    return {
      accepted: true,
      status: 'cached',
      maxCachedPn: cache.maxCachedPn
    };
  }

  if (cache && !hasAuthorMorePages(cache) && pn > cache.maxCachedPn) {
    return {
      accepted: false,
      status: 'no-more',
      maxCachedPn: cache.maxCachedPn
    };
  }

  enqueueBurst([
    {
      mid,
      name: cache?.name?.trim() || String(mid),
      groupId,
      pn,
      reason: 'load-more-boundary',
      trigger: 'request-author-page',
      failFast: false
    }
  ]);

  return {
    accepted: true,
    status: 'queued',
    maxCachedPn: cache?.maxCachedPn
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

/**
 * 手动刷新：优先提交“收藏夹刷新任务”。
 * 收藏夹任务完成后会自动衔接作者任务，前台通过轮询 GET_GROUP_FEED 等待缓存就绪。
 */
async function handleManualRefresh(
  request: Extract<MessageRequest, { type: 'MANUAL_REFRESH' }>
): Promise<ResponseMap['MANUAL_REFRESH']> {
  const groups = await loadGroups();

  if (request.payload.groupId === ALL_GROUP_ID) {
    const enabledGroupIds = groups.filter((item) => item.enabled).map((item) => item.groupId);
    if (enabledGroupIds.length === 0) {
      throw new Error('当前没有可刷新的启用分组');
    }
    enqueuePriorityGroup(enabledGroupIds, 'manual-refresh');
    return { accepted: true };
  }

  const group = groups.find((item) => item.groupId === request.payload.groupId && item.enabled);
  if (!group) {
    throw new Error('分组不存在或已禁用');
  }

  enqueuePriorityGroup([group.groupId], 'manual-refresh');

  return { accepted: true };
}

async function handleGetSchedulerStatus(): Promise<ResponseMap['GET_SCHEDULER_STATUS']> {
  return getStatus();
}

async function handleRunSchedulerNow(): Promise<ResponseMap['RUN_SCHEDULER_NOW']> {
  return runSchedulerNow();
}

async function routeMessage(request: MessageRequest, sender: chrome.runtime.MessageSender): Promise<MessageResponse> {
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
    case 'MARK_GROUP_READ_MARK':
      return ok(await handleMarkGroupReadMark(request));
    case 'MARK_ALL_GROUPS_READ':
      return ok(await handleMarkAllGroupsRead());
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
    case 'CLEAR_AUTHOR_READ_MARK':
      return ok(await handleClearAuthorReadMark(request));
    case 'REQUEST_AUTHOR_PAGE':
      return ok(await handleRequestAuthorPage(request));
    case 'GET_AUTHOR_PREFERENCES':
      return ok(await handleGetAuthorPreferences(request));
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

ext.runtime.onInstalled.addListener(async () => {
  const settings = await loadSettings();
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  await saveSettings(merged);
  await Promise.all([cleanOrphanClicks(), cleanOrphanReviewedOverrides()]);
  await setupAlarm(merged);
});

ext.runtime.onMessage.addListener((request: MessageRequest, sender, sendResponse) => {
  routeMessage(request, sender)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse(fail(error)));

  return true;
});
