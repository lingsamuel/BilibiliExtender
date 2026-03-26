import { AUTHOR_VIDEOS_PAGE_SIZE, MIXED_LOAD_INCREMENT } from '@/shared/constants';
import { getUploaderVideos, getUserCard, getAllFavVideos, type FavMediaItem } from '@/shared/api/bilibili';
import { normalizeRecentPresetValue } from '@/shared/utils/settings';
import type {
  AllPostsFilterKey,
  AuthorPreference,
  AuthorFeed,
  AuthorVideoCache,
  ExtensionSettings,
  GroupConfig,
  GroupFeedCache,
  GroupFeedResult,
  GroupReadMark,
  GroupRuntimeState,
  RecentPresetKey,
  VideoItem,
  ViewMode
} from '@/shared/types';

export type RuntimeMap = Record<string, GroupRuntimeState>;
export type FeedCacheMap = Record<string, GroupFeedCache>;
export type AuthorCacheMap = Record<number, AuthorVideoCache>;
type ReadMarkMap = Record<string, GroupReadMark>;
type ClickedVideoMap = Record<string, number>;
type ReviewedOverrideMap = Record<string, boolean>;
type AuthorPreferenceMap = Record<number, AuthorPreference>;
const DEFAULT_BY_AUTHOR_SORT_BY_LATEST = true;
const DEFAULT_RECENT_PRESET_KEY: RecentPresetKey = 'd7';
const DEFAULT_ALL_POSTS_FILTER: AllPostsFilterKey = 'all';

function getGroupTitle(group: GroupConfig): string {
  return group.alias?.trim() || group.mediaTitle;
}

function buildAuthorList(favVideos: FavMediaItem[]): Array<{ mid: number; name: string }> {
  const authorMap = new Map<number, string>();

  favVideos.forEach((item) => {
    if (!item.upper?.mid) {
      return;
    }

    if (!authorMap.has(item.upper.mid)) {
      authorMap.set(item.upper.mid, item.upper.name);
    }
  });

  return Array.from(authorMap.entries()).map(([mid, name]) => ({ mid, name }));
}

function toPositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function withVideoMeta(video: VideoItem, pn: number, pageFetchedAt: number): VideoItem {
  const sourcePn = Math.max(1, toPositiveNumber(video.meta?.sourcePn, pn));
  const nextPageFetchedAt = toPositiveNumber(video.meta?.pageFetchedAt, pageFetchedAt);
  const updatedAt = toPositiveNumber(video.meta?.updatedAt, nextPageFetchedAt);
  return {
    ...video,
    meta: {
      updatedAt,
      sourcePn,
      pageFetchedAt: nextPageFetchedAt
    }
  };
}

function pickPreferVideo(left: VideoItem, right: VideoItem): VideoItem {
  const leftUpdatedAt = toPositiveNumber(left.meta?.updatedAt, 0);
  const rightUpdatedAt = toPositiveNumber(right.meta?.updatedAt, 0);
  if (leftUpdatedAt !== rightUpdatedAt) {
    return rightUpdatedAt > leftUpdatedAt ? right : left;
  }

  const leftPageFetchedAt = toPositiveNumber(left.meta?.pageFetchedAt, 0);
  const rightPageFetchedAt = toPositiveNumber(right.meta?.pageFetchedAt, 0);
  if (leftPageFetchedAt !== rightPageFetchedAt) {
    return rightPageFetchedAt > leftPageFetchedAt ? right : left;
  }

  return right;
}

function mergeVideos(existing: VideoItem[], incoming: VideoItem[]): VideoItem[] {
  const map = new Map<string, VideoItem>();

  for (const video of existing) {
    map.set(video.bvid, video);
  }

  for (const video of incoming) {
    const prev = map.get(video.bvid);
    if (!prev) {
      map.set(video.bvid, video);
      continue;
    }
    map.set(video.bvid, pickPreferVideo(prev, video));
  }

  return Array.from(map.values()).sort((a, b) => b.pubdate - a.pubdate);
}

function resolveMaxSourcePn(videos: VideoItem[]): number {
  let maxPn = 1;
  for (const video of videos) {
    const sourcePn = Math.max(1, Number(video.meta?.sourcePn) || 1);
    if (sourcePn > maxPn) {
      maxPn = sourcePn;
    }
  }
  return maxPn;
}

/**
 * 根据投稿接口返回的总量信息推导最大分页号。
 * 返回 null 表示当前缓存没有可用的总量口径（需回退到旧 hasMore）。
 */
function resolveMaxPageByCount(totalCount: number | undefined, pageSize: number | undefined): number | null {
  if (totalCount === undefined || pageSize === undefined) {
    return null;
  }

  const safeTotal = Math.max(0, Math.floor(totalCount));
  const safePageSize = Math.max(1, Math.floor(pageSize));
  return Math.max(1, Math.ceil(safeTotal / safePageSize));
}

/**
 * 作者是否仍可能存在下一页：
 * - 优先使用 totalCount/apiPageSize 推导（可自愈旧 hasMore 脏值）；
 * - 缺失总量信息时再回退到缓存 hasMore。
 */
export function hasAuthorMorePages(
  cache: Pick<AuthorVideoCache, 'maxCachedPn' | 'hasMore' | 'totalCount' | 'apiPageSize'>
): boolean {
  const maxPageByCount = resolveMaxPageByCount(cache.totalCount, cache.apiPageSize);
  if (maxPageByCount !== null) {
    return cache.maxCachedPn < maxPageByCount;
  }
  return cache.hasMore === true;
}

function isNumericName(value: string | undefined): boolean {
  return !!value && /^\d+$/.test(value.trim());
}

function hasCardSnapshot(cache: AuthorVideoCache | undefined): boolean {
  if (!cache) {
    return false;
  }
  return Boolean(cache.name?.trim()) && cache.follower !== undefined && cache.following !== undefined;
}

// ─── 作者级缓存操作 ───

function isAuthorCacheExpired(cache: AuthorVideoCache | undefined, settings: ExtensionSettings): boolean {
  if (!cache) {
    return true;
  }

  const firstPageFetchedAt = cache.firstPageFetchedAt || cache.lastFetchedAt;
  if (!firstPageFetchedAt) {
    return true;
  }
  // 缓存里还没有完整 Card 信息时，视为过期并优先补齐。
  if (!hasCardSnapshot(cache)) {
    return true;
  }
  return Date.now() - firstPageFetchedAt > settings.refreshIntervalMinutes * 60 * 1000;
}

/**
 * 刷新单个作者的视频缓存：
 * - pn=1: 首页刷新（用于过期修复与基础缓存维持）；
 * - pn>=2: 分页预取/按需补页（用于时间流扩展）。
 *
 * 同一轮会同步刷新 Card 信息，确保作者展示字段与缓存一致。
 */
export async function refreshAuthorCache(
  mid: number,
  name: string,
  authorCacheMap: AuthorCacheMap,
  options?: { pn?: number }
): Promise<AuthorVideoCache> {
  const existing = authorCacheMap[mid];
  const pn = Math.max(1, options?.pn ?? 1);
  const pageFetchedAt = Date.now();
  const { videos, hasMore, totalCount, pageSize } = await getUploaderVideos(mid, pn, AUTHOR_VIDEOS_PAGE_SIZE);
  const nextTotalCount = Number.isFinite(totalCount) && totalCount >= 0
    ? Math.floor(totalCount)
    : existing?.totalCount;
  const nextApiPageSize = Number.isFinite(pageSize) && pageSize > 0
    ? Math.floor(pageSize)
    : existing?.apiPageSize;
  const maxPageByCount = resolveMaxPageByCount(nextTotalCount, nextApiPageSize);
  const isOutOfRangeByCount = maxPageByCount !== null && pn > maxPageByCount;

  // 越界页请求不参与合并，避免把异常深页当成真实缓存页写入状态机。
  const effectiveVideos = isOutOfRangeByCount ? [] : videos.map((video) => withVideoMeta(video, pn, pageFetchedAt));
  const merged = existing ? mergeVideos(existing.videos, effectiveVideos) : effectiveVideos;

  const existingHasCardSnapshot = hasCardSnapshot(existing);
  let cardName: string | undefined;
  let cardFace: string | undefined;
  let cardFollower: number | undefined;
  let cardFollowing: boolean | undefined;

  try {
    const card = await getUserCard(mid);
    cardName = card.name?.trim() || undefined;
    cardFace = card.face;
    cardFollower = card.follower;
    cardFollowing = card.following;
  } catch {
    // Card 请求失败时按降级策略处理：
    // - 若已有 Card 缓存，继续沿用缓存；
    // - 若无 Card 缓存，允许回退视频接口作者名兜底展示。
  }

  // 作者名优先来源于 Card；仅在无 Card 缓存且本轮 Card 失败时回退视频作者名/任务名。
  const apiName = videos.find((item) => item.authorName?.trim())?.authorName?.trim();
  const existingName = existing?.name?.trim();
  const taskName = name?.trim();
  const resolvedName =
    cardName ||
    (existingHasCardSnapshot ? existingName : undefined) ||
    apiName ||
    (existingName && !isNumericName(existingName) ? existingName : undefined) ||
    (taskName && !isNumericName(taskName) ? taskName : undefined) ||
    existingName ||
    taskName ||
    String(mid);
  const resolvedFace = cardFace || existing?.face;
  const resolvedFollower = cardFollower ?? (existingHasCardSnapshot ? existing?.follower : undefined);
  const resolvedFollowing = cardFollowing ?? (existingHasCardSnapshot ? existing?.following : undefined);

  const nextPageState: AuthorVideoCache['pageState'] = {
    ...(existing?.pageState ?? {})
  };
  if (!isOutOfRangeByCount) {
    const prevPageState = nextPageState[pn];
    nextPageState[pn] = {
      fetchedAt: pageFetchedAt,
      usedInMixed: prevPageState?.usedInMixed ?? false,
      lastUsedAt: prevPageState?.lastUsedAt
    };
  }
  if (!nextPageState[1]) {
    nextPageState[1] = {
      fetchedAt: existing?.firstPageFetchedAt || existing?.lastFetchedAt || pageFetchedAt,
      usedInMixed: false
    };
  }

  const inferredMaxCachedPn = Math.max(
    1,
    resolveMaxSourcePn(merged),
    ...Object.keys(nextPageState).map((rawPn) => Math.max(1, Number(rawPn) || 1))
  );
  // 统一由“当前已缓存最深页 + 1”推导下一页，避免历史 nextPn 脏值导致跳到异常深页。
  const nextPn = Math.max(2, inferredMaxCachedPn + 1);
  const nextHasMore = maxPageByCount !== null
    ? inferredMaxCachedPn < maxPageByCount
    : (pn < inferredMaxCachedPn ? (existing ? hasAuthorMorePages(existing) : hasMore) : hasMore);
  const firstPageFetchedAt = pn === 1
    ? pageFetchedAt
    : (existing?.firstPageFetchedAt || nextPageState[1]?.fetchedAt || pageFetchedAt);
  const secondPageFetchedAt = pn === 2 && !isOutOfRangeByCount
    ? pageFetchedAt
    : (existing?.secondPageFetchedAt || nextPageState[2]?.fetchedAt);

  const cache: AuthorVideoCache = {
    mid,
    name: resolvedName,
    face: resolvedFace,
    follower: resolvedFollower,
    following: resolvedFollowing,
    faceFetchedAt: resolvedFace ? Date.now() : existing?.faceFetchedAt,
    videos: merged,
    pageState: nextPageState,
    maxCachedPn: inferredMaxCachedPn,
    nextPn,
    hasMore: nextHasMore,
    totalCount: nextTotalCount,
    apiPageSize: nextApiPageSize,
    firstPageFetchedAt,
    secondPageFetchedAt,
    lastFetchedAt: pageFetchedAt
  };

  authorCacheMap[mid] = cache;
  return cache;
}

/**
 * 从收藏夹拉取视频列表并提取作者列表，同时更新 feedCacheMap。
 * 返回作者列表供调度器生成任务。
 * 注意：此函数会发起 getAllFavVideos API 请求，仅由调度器/后台初始化调用。
 */
export async function buildAuthorListFromFav(
  group: GroupConfig,
  feedCacheMap: FeedCacheMap
): Promise<Array<{ mid: number; name: string }>> {
  const favVideos = await getAllFavVideos(group.mediaId);
  const authors = buildAuthorList(favVideos);
  if (authors.length === 0) {
    // 收藏夹返回空列表时保持原缓存不变，避免把已有分组信息覆盖为空。
    return [];
  }
  const authorMids = authors.map((a) => a.mid);

  feedCacheMap[group.groupId] = {
    groupId: group.groupId,
    authorMids,
    updatedAt: Date.now()
  };

  return authors;
}

// ─── 分组级纯函数 ───

function ensureRuntimeState(
  runtimeMap: RuntimeMap,
  groupId: string,
  settings: ExtensionSettings
): GroupRuntimeState {
  if (!runtimeMap[groupId]) {
    runtimeMap[groupId] = {
      groupId,
      unreadCount: 0,
      mixedTargetCount: settings.timelineMixedMaxCount
    };
  }

  if (!runtimeMap[groupId].mixedTargetCount) {
    runtimeMap[groupId].mixedTargetCount = settings.timelineMixedMaxCount;
  }

  if (runtimeMap[groupId].savedByAuthorSortByLatest === undefined) {
    runtimeMap[groupId].savedByAuthorSortByLatest = DEFAULT_BY_AUTHOR_SORT_BY_LATEST;
  }
  if (!runtimeMap[groupId].savedRecentPresetKey) {
    runtimeMap[groupId].savedRecentPresetKey = normalizeRecentPresetKey(settings.defaultReadMarkDays);
  }
  if (!runtimeMap[groupId].savedAllPostsFilter) {
    runtimeMap[groupId].savedAllPostsFilter = DEFAULT_ALL_POSTS_FILTER;
  }

  return runtimeMap[groupId];
}

function normalizeRecentPresetKey(value: RecentPresetKey | number | undefined): RecentPresetKey {
  return normalizeRecentPresetValue(value);
}

function normalizeAllPostsFilter(value: AllPostsFilterKey | undefined): AllPostsFilterKey {
  if (value === 'd7' || value === 'd14' || value === 'd30' || value === 'n10' || value === 'n30') {
    return value;
  }
  return 'all';
}

function resolveRecentPresetDays(recentPresetKey: RecentPresetKey): number {
  if (recentPresetKey === 'd14') {
    return 14;
  }
  if (recentPresetKey === 'd30') {
    return 30;
  }
  return 7;
}

function getRecentPresetTs(recentPresetKey: RecentPresetKey): number {
  return Math.floor(Date.now() / 1000) - resolveRecentPresetDays(recentPresetKey) * 24 * 60 * 60;
}

function collectReadMarkTimestamps(groupId: string, readMarks: ReadMarkMap): number[] {
  const timestamps = readMarks[groupId]?.timestamps ?? [];
  return [...timestamps].sort((a, b) => b - a);
}

function getLatestGroupReadMarkTs(groupId: string, readMarks: ReadMarkMap): number {
  return collectReadMarkTimestamps(groupId, readMarks)[0] ?? 0;
}

/**
 * 解析分组用于“近期追踪 / unread”的分组级基线：
 * - 若存在最新“上次看到”时间点，则优先使用；
 * - 否则回退到当前近期预设。
 */
function resolveGroupRecentBaselineTs(
  groupId: string,
  readMarks: ReadMarkMap,
  recentPresetKey: RecentPresetKey
): number {
  const latestReadMarkTs = getLatestGroupReadMarkTs(groupId, readMarks);
  if (latestReadMarkTs > 0) {
    return latestReadMarkTs;
  }
  return getRecentPresetTs(recentPresetKey);
}

function resolveAuthorUnreadBaselineTs(
  mid: number,
  groupBaselineTs: number,
  authorPreferences: AuthorPreferenceMap
): number {
  const pref = authorPreferences[mid];
  if (pref?.readMarkTs && pref.readMarkTs > 0) {
    // 作者级已阅时间点优先级绝对高于分组基线（与大小无关）。
    return pref.readMarkTs;
  }
  return groupBaselineTs;
}

/**
 * 时间流模式的可见下界：
 * - 不再按已阅时间做“硬截断”；
 * - 至少保留当前近期预设对应的窗口；
 * - 当用户显式选择了更早的已阅点时，向更旧数据延展。
 */
function resolveMixedVisibleLowerBoundTs(groupBaselineTs: number, recentPresetKey: RecentPresetKey): number {
  const presetTs = getRecentPresetTs(recentPresetKey);
  if (groupBaselineTs <= 0) {
    return presetTs;
  }
  return Math.min(groupBaselineTs, presetTs);
}

function isVideoReviewed(
  video: VideoItem,
  clickedVideos: ClickedVideoMap,
  reviewedOverrides: ReviewedOverrideMap
): boolean {
  if (Object.prototype.hasOwnProperty.call(reviewedOverrides, video.bvid)) {
    return reviewedOverrides[video.bvid] === true;
  }
  // “已查看”与卡片展示规则保持一致：
  // 1) 点击记录命中；或 2) playback_position >= 10。
  return clickedVideos[video.bvid] !== undefined || (video.playbackPosiiton ?? 0) >= 10;
}

/**
 * 计算单个分组在指定已阅时间点下的未读数量（按 bvid 去重）。
 */
function calcGroupUnreadCount(
  group: GroupConfig,
  authorMids: number[],
  authorCacheMap: AuthorCacheMap,
  groupBaselineTs: number,
  clickedVideos: ClickedVideoMap,
  reviewedOverrides: ReviewedOverrideMap,
  authorPreferences: AuthorPreferenceMap
): number {
  if (group.excludeFromUnreadCount) {
    return 0;
  }

  const seenBvids = new Set<string>();
  let unreadCount = 0;

  for (const mid of authorMids) {
    const pref = authorPreferences[mid];
    if (pref?.ignoreUnreadCount) {
      continue;
    }
    const baseline = resolveAuthorUnreadBaselineTs(mid, groupBaselineTs, authorPreferences);
    const videos = authorCacheMap[mid]?.videos ?? [];
    for (const video of videos) {
      if (seenBvids.has(video.bvid)) {
        continue;
      }
      seenBvids.add(video.bvid);
      if (video.pubdate > baseline && !isVideoReviewed(video, clickedVideos, reviewedOverrides)) {
        unreadCount++;
      }
    }
  }

  return unreadCount;
}

/**
 * 从全局作者缓存中聚合分组的混合视频列表。
 */
function aggregateMixedVideos(authorMids: number[], authorCacheMap: AuthorCacheMap): VideoItem[] {
  const map = new Map<string, VideoItem>();
  for (const mid of authorMids) {
    const cache = authorCacheMap[mid];
    if (!cache) continue;
    for (const video of cache.videos) {
      const prev = map.get(video.bvid);
      if (!prev) {
        map.set(video.bvid, video);
      } else {
        map.set(video.bvid, pickPreferVideo(prev, video));
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => b.pubdate - a.pubdate);
}

function aggregateMixedVideosByOverviewFilter(
  authorMids: number[],
  authorCacheMap: AuthorCacheMap,
  allPostsFilter: AllPostsFilterKey
): VideoItem[] {
  const map = new Map<string, VideoItem>();
  for (const mid of authorMids) {
    const cache = authorCacheMap[mid];
    if (!cache) continue;
    const scoped = applyOverviewFilterForAuthor(cache.videos, allPostsFilter);
    for (const video of scoped) {
      const prev = map.get(video.bvid);
      if (!prev) {
        map.set(video.bvid, video);
      } else {
        map.set(video.bvid, pickPreferVideo(prev, video));
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => b.pubdate - a.pubdate);
}

function getAuthorNames(authorMids: number[], authorCacheMap: AuthorCacheMap): Map<number, string> {
  const names = new Map<number, string>();
  for (const mid of authorMids) {
    const cache = authorCacheMap[mid];
    if (cache) {
      const cacheName = cache.name?.trim();
      const videoName = cache.videos.find((video) => video.authorName?.trim())?.authorName?.trim();
      const resolvedName =
        (hasCardSnapshot(cache) ? cacheName : undefined) ||
        (cacheName && !isNumericName(cacheName) ? cacheName : undefined) ||
        videoName ||
        cacheName ||
        String(mid);
      names.set(mid, resolvedName);
    }
  }
  return names;
}

function injectAuthorMetaIntoVideo(
  video: VideoItem,
  meta: { name: string; face?: string } | undefined
): VideoItem {
  if (!meta) {
    return video;
  }

  let next = video;
  if (meta.name && meta.name !== next.authorName) {
    next = { ...next, authorName: meta.name };
  }
  if (meta.face && meta.face !== next.authorFace) {
    next = { ...next, authorFace: meta.face };
  }
  return next;
}

// ─── 视图组装 ───

/**
 * 计算 Header 入口全局 unread count：
 * - 按作者聚合，不按分组未读简单求和；
 * - 同一作者在多个非“全部”分组时，采用最大已阅基线；
 * - 仅出现在“全部”分组的作者视作 unread=0。
 */
function calcGlobalUnreadCount(
  groups: GroupConfig[],
  runtimeMap: RuntimeMap,
  feedCacheMap: FeedCacheMap,
  authorCacheMap: AuthorCacheMap,
  readMarks: ReadMarkMap,
  settings: ExtensionSettings,
  clickedVideos: ClickedVideoMap,
  reviewedOverrides: ReviewedOverrideMap,
  authorPreferences: AuthorPreferenceMap
): number {
  const authorBaselineMap = new Map<number, number>();
  const authorInNonAllGroups = new Set<number>();

  for (const group of groups) {
    if (!group.enabled) {
      continue;
    }
    if (group.excludeFromUnreadCount) {
      continue;
    }

    const feedCache = feedCacheMap[group.groupId];
    if (!feedCache) {
      continue;
    }

    const runtime = runtimeMap[group.groupId];
    const recentPresetKey = normalizeRecentPresetKey(runtime?.savedRecentPresetKey ?? settings.defaultReadMarkDays);
    const groupBaselineTs = resolveGroupRecentBaselineTs(group.groupId, readMarks, recentPresetKey);

    for (const mid of feedCache.authorMids) {
      const pref = authorPreferences[mid];
      if (pref?.ignoreUnreadCount) {
        continue;
      }
      authorInNonAllGroups.add(mid);
      const baseline = resolveAuthorUnreadBaselineTs(mid, groupBaselineTs, authorPreferences);
      const prev = authorBaselineMap.get(mid);
      if (prev === undefined || baseline > prev) {
        authorBaselineMap.set(mid, baseline);
      }
    }
  }

  const unreadBvids = new Set<string>();
  for (const mid of authorInNonAllGroups) {
    const baseline = authorBaselineMap.get(mid);
    if (baseline === undefined) {
      continue;
    }
    const videos = authorCacheMap[mid]?.videos ?? [];
    for (const video of videos) {
      if (video.pubdate > baseline && !isVideoReviewed(video, clickedVideos, reviewedOverrides)) {
        unreadBvids.add(video.bvid);
      }
    }
  }

  return unreadBvids.size;
}

function resolveAllPostsDays(allPostsFilter: AllPostsFilterKey): number | null {
  if (allPostsFilter === 'd7') return 7;
  if (allPostsFilter === 'd14') return 14;
  if (allPostsFilter === 'd30') return 30;
  return null;
}

function resolveAllPostsPerAuthorCount(allPostsFilter: AllPostsFilterKey): number | null {
  if (allPostsFilter === 'n10') return 10;
  if (allPostsFilter === 'n30') return 30;
  return null;
}

interface OverviewAuthorSelection {
  videos: VideoItem[];
  usedLatestFallback: boolean;
}

/**
 * “全部投稿”作者列表筛选：
 * - `all` 直接返回全量缓存；
 * - `N条` 只按条数截断；
 * - `N天内` 先按时间窗口过滤，若完全无命中则保底返回最新 1 条。
 */
function selectOverviewVideosForAuthor(
  videos: VideoItem[],
  allPostsFilter: AllPostsFilterKey
): OverviewAuthorSelection {
  if (allPostsFilter === 'all') {
    return {
      videos,
      usedLatestFallback: false
    };
  }

  const perAuthorCount = resolveAllPostsPerAuthorCount(allPostsFilter);
  if (perAuthorCount !== null) {
    return {
      videos: videos.slice(0, perAuthorCount),
      usedLatestFallback: false
    };
  }

  const days = resolveAllPostsDays(allPostsFilter);
  if (days !== null) {
    const lowerBound = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    const scoped = videos.filter((video) => video.pubdate >= lowerBound);
    if (scoped.length > 0 || videos.length === 0) {
      return {
        videos: scoped,
        usedLatestFallback: false
      };
    }
    return {
      videos: videos.slice(0, 1),
      usedLatestFallback: true
    };
  }

  return {
    videos,
    usedLatestFallback: false
  };
}

function applyOverviewFilterForAuthor(
  videos: VideoItem[],
  allPostsFilter: AllPostsFilterKey
): VideoItem[] {
  return selectOverviewVideosForAuthor(videos, allPostsFilter).videos;
}

function hasAuthorPotentialMoreForMixed(
  mid: number,
  authorCacheMap: AuthorCacheMap,
  groupBaselineTs: number,
  recentPresetKey: RecentPresetKey,
  allPostsFilter: AllPostsFilterKey,
  authorPreferences: AuthorPreferenceMap
): boolean {
  const cache = authorCacheMap[mid];
  if (!cache || !hasAuthorMorePages(cache)) {
    return false;
  }

  if (allPostsFilter === 'all') {
    const lowerBound = resolveAuthorMixedLowerBoundTs(mid, groupBaselineTs, recentPresetKey, authorPreferences);
    if (lowerBound <= 0) {
      return true;
    }
    const oldestCached = cache.videos[cache.videos.length - 1];
    if (!oldestCached) {
      return true;
    }
    // 已经把缓存拉到可见下界之外时，继续翻页不会再贡献当前时间流可见数据。
    return oldestCached.pubdate >= lowerBound;
  }

  const overviewDays = resolveAllPostsDays(allPostsFilter);
  if (overviewDays !== null) {
    const lowerBound = Math.floor(Date.now() / 1000) - overviewDays * 24 * 60 * 60;
    const oldestCached = cache.videos[cache.videos.length - 1];
    if (!oldestCached) {
      return true;
    }
    return oldestCached.pubdate >= lowerBound;
  }

  const perAuthorCount = resolveAllPostsPerAuthorCount(allPostsFilter);
  if (perAuthorCount !== null) {
    return cache.videos.length < perAuthorCount;
  }

  return true;
}

function filterAuthorVideosByTracking(videos: VideoItem[], baseline: number, extraCount: number): VideoItem[] {
  if (baseline <= 0) {
    return videos;
  }
  const newVideos = videos.filter((v) => v.pubdate >= baseline);
  const olderVideos = videos.filter((v) => v.pubdate < baseline).slice(0, extraCount);
  return [...newVideos, ...olderVideos];
}

function resolveAuthorMixedLowerBoundTs(
  mid: number,
  groupBaselineTs: number,
  recentPresetKey: RecentPresetKey,
  authorPreferences: AuthorPreferenceMap
): number {
  const pref = authorPreferences[mid];
  const authorReadMarkTs = pref?.readMarkTs && pref.readMarkTs > 0 ? pref.readMarkTs : 0;
  if (authorReadMarkTs > 0) {
    const presetTs = getRecentPresetTs(recentPresetKey);
    if (presetTs > 0) {
      return Math.min(authorReadMarkTs, presetTs);
    }
    return authorReadMarkTs;
  }
  return resolveMixedVisibleLowerBoundTs(groupBaselineTs, recentPresetKey);
}

function filterMixedVideosByTracking(
  videos: VideoItem[],
  groupBaselineTs: number,
  recentPresetKey: RecentPresetKey,
  showAllForMixed: boolean,
  authorPreferences: AuthorPreferenceMap
): VideoItem[] {
  if (showAllForMixed) {
    return videos;
  }

  return videos.filter((video) => {
    const lowerBound = resolveAuthorMixedLowerBoundTs(video.authorMid, groupBaselineTs, recentPresetKey, authorPreferences);
    if (lowerBound <= 0) {
      return true;
    }
    return video.pubdate >= lowerBound;
  });
}

function getLatestPubdate(videos: VideoItem[]): number | null {
  if (videos.length === 0) {
    return null;
  }
  return videos.reduce((latest, video) => (video.pubdate > latest ? video.pubdate : latest), videos[0].pubdate);
}

/**
 * “按作者”模式可选排序：
 * - 有视频的作者按最新视频时间倒序。
 * - 当前筛选后无视频的作者统一放末尾。
 * - 时间相同按收藏夹原始顺序稳定排序。
 */
function sortAuthorsByLatestPubdate(videosByAuthor: AuthorFeed[]): AuthorFeed[] {
  return videosByAuthor
    .map((author, index) => ({
      author,
      index,
      latestPubdate: getLatestPubdate(author.videos)
    }))
    .sort((a, b) => {
      if (a.latestPubdate === null && b.latestPubdate === null) {
        return a.index - b.index;
      }
      if (a.latestPubdate === null) {
        return 1;
      }
      if (b.latestPubdate === null) {
        return -1;
      }
      if (a.latestPubdate !== b.latestPubdate) {
        return b.latestPubdate - a.latestPubdate;
      }
      return a.index - b.index;
    })
    .map((item) => item.author);
}

export interface MixedUsedPageItem {
  mid: number;
  usedMaxPn: number;
}

export interface MixedBoundaryTask {
  mid: number;
  name: string;
  pn: number;
}

export interface MixedBuildDiagnostics {
  usedPages: MixedUsedPageItem[];
  boundaryTasks: MixedBoundaryTask[];
}

export function markAuthorPageUsage(
  authorCacheMap: AuthorCacheMap,
  usedPages: MixedUsedPageItem[]
): boolean {
  if (usedPages.length === 0) {
    return false;
  }

  const now = Date.now();
  let changed = false;

  for (const item of usedPages) {
    const cache = authorCacheMap[item.mid];
    if (!cache) {
      continue;
    }

    const usedPn = Math.max(1, item.usedMaxPn);
    if (!cache.pageState[usedPn]) {
      cache.pageState[usedPn] = {
        fetchedAt: now,
        usedInMixed: true,
        lastUsedAt: now
      };
      changed = true;
      continue;
    }

    if (!cache.pageState[usedPn].usedInMixed || cache.pageState[usedPn].lastUsedAt !== now) {
      cache.pageState[usedPn].usedInMixed = true;
      cache.pageState[usedPn].lastUsedAt = now;
      changed = true;
    }
  }

  return changed;
}

/**
 * 纯缓存组装：从已有缓存数据构建前台展示所需的 GroupFeedResult。
 * 不发起任何 API 请求。
 */
export function toFeedResult(
  group: GroupConfig,
  mode: ViewMode,
  settings: ExtensionSettings,
  runtimeMap: RuntimeMap,
  feedCacheMap: FeedCacheMap,
  authorCacheMap: AuthorCacheMap,
  readMarks: ReadMarkMap,
  clickedVideos: ClickedVideoMap,
  reviewedOverrides: ReviewedOverrideMap,
  authorPreferences: AuthorPreferenceMap,
  recentPresetKey: RecentPresetKey,
  showAllForMixed: boolean,
  allPostsFilter: AllPostsFilterKey,
  byAuthorSortByLatest?: boolean,
  diagnostics?: MixedBuildDiagnostics
): GroupFeedResult {
  const runtime = ensureRuntimeState(runtimeMap, group.groupId, settings);
  const feedCache = feedCacheMap[group.groupId];

  if (!feedCache) {
    throw new Error(`分组缓存不存在: ${getGroupTitle(group)}`);
  }

  const authorMids = feedCache.authorMids;
  const authorNames = getAuthorNames(authorMids, authorCacheMap);
  const authorMetaMap = new Map<number, { name: string; face?: string; follower?: number; following?: boolean }>();
  for (const mid of authorMids) {
    const cache = authorCacheMap[mid];
    authorMetaMap.set(mid, {
      name: authorNames.get(mid) ?? String(mid),
      face: cache?.face,
      follower: cache?.follower,
      following: cache?.following
    });
  }
  const readMarkTimestamps = collectReadMarkTimestamps(group.groupId, readMarks);
  const normalizedRecentPresetKey = normalizeRecentPresetKey(recentPresetKey);
  const normalizedAllPostsFilter = normalizeAllPostsFilter(allPostsFilter);
  const latestGroupReadMarkTs = readMarkTimestamps[0] ?? 0;
  const trackingGroupBaselineTs = resolveGroupRecentBaselineTs(group.groupId, readMarks, normalizedRecentPresetKey);
  const effectiveAllPostsFilter: AllPostsFilterKey = mode === 'overview' ? normalizedAllPostsFilter : 'all';

  const byAuthorSortEnabled = byAuthorSortByLatest ?? runtime.savedByAuthorSortByLatest ?? DEFAULT_BY_AUTHOR_SORT_BY_LATEST;
  let videosByAuthor: AuthorFeed[] = authorMids.map((mid) => {
    const allVideos = authorCacheMap[mid]?.videos ?? [];
    const overviewSelection = selectOverviewVideosForAuthor(allVideos, effectiveAllPostsFilter);
    const pref = authorPreferences[mid];
    const hasAuthorReadMarkOverride = Boolean(pref?.readMarkTs && pref.readMarkTs > 0);
    const authorBoundaryTs = resolveAuthorUnreadBaselineTs(mid, trackingGroupBaselineTs, authorPreferences);
    const videos =
      mode === 'byAuthor'
        ? filterAuthorVideosByTracking(allVideos, authorBoundaryTs, settings.extraOlderVideoCount)
        : overviewSelection.videos;
    const meta = authorMetaMap.get(mid);

    // 当当前展示列表全部落在基线之前时，说明该作者“仅显示已阅前额外视频”。
    return {
      authorMid: mid,
      authorName: meta?.name ?? String(mid),
      authorFace: meta?.face,
      follower: meta?.follower,
      following: meta?.following,
      ignoreUnreadCount: pref?.ignoreUnreadCount === true,
      hasAuthorReadMarkOverride,
      // 概览模式仍返回作者边界，供“按作者”视图显示/调整已阅分界线使用。
      effectiveReadBoundaryTs: authorBoundaryTs,
      maxCachedPn: authorCacheMap[mid]?.maxCachedPn ?? 1,
      cachedPagePns: Array.from(
        new Set(allVideos.map((video) => Math.max(1, Number(video.meta?.sourcePn) || 1)))
      ).sort((a, b) => a - b),
      hasMorePages: authorCacheMap[mid] ? hasAuthorMorePages(authorCacheMap[mid]) : false,
      totalVideoCount: authorCacheMap[mid]?.totalCount,
      apiPageSize: authorCacheMap[mid]?.apiPageSize ?? AUTHOR_VIDEOS_PAGE_SIZE,
      videos: videos.map((video) => injectAuthorMetaIntoVideo(video, meta)),
      hasOnlyExtraOlderVideos:
        mode === 'byAuthor' &&
        authorBoundaryTs > 0 &&
        videos.length > 0 &&
        videos.every((video) => video.pubdate < authorBoundaryTs),
      hasOverviewFallbackLatestVideo:
        mode === 'overview' && overviewSelection.usedLatestFallback,
      latestPubdate: getLatestPubdate(allVideos) ?? undefined
    };
  });

  if (mode !== 'mixed' && byAuthorSortEnabled) {
    videosByAuthor = sortAuthorsByLatestPubdate(videosByAuthor);
  }

  const injectAuthorMeta = (videos: VideoItem[]): VideoItem[] =>
    videos.map((video) => injectAuthorMetaIntoVideo(video, authorMetaMap.get(video.authorMid)));

  const mixedAllVideos =
    mode !== 'overview'
      ? aggregateMixedVideos(authorMids, authorCacheMap)
      : effectiveAllPostsFilter === 'all'
        ? aggregateMixedVideos(authorMids, authorCacheMap)
        : aggregateMixedVideosByOverviewFilter(
          authorMids,
          authorCacheMap,
          effectiveAllPostsFilter
        );
  let mixedVideos = injectAuthorMeta(
    mode !== 'overview'
      ? filterMixedVideosByTracking(
          mixedAllVideos,
          trackingGroupBaselineTs,
          normalizedRecentPresetKey,
          showAllForMixed,
          authorPreferences
        )
      : mixedAllVideos
  );

  // 时间流读取遵循 runtime 目标数量，避免一次返回过多数据导致渲染与消息传输变慢。
  const mixedTotalBeforeLimit = mixedVideos.length;
  const mixedLimit = Math.max(1, runtime.mixedTargetCount || settings.timelineMixedMaxCount);
  mixedVideos = mixedVideos.slice(0, mixedLimit);

  if (diagnostics) {
    const usedPageMap = new Map<number, number>();
    const selectedMapByAuthor = new Map<number, Set<string>>();

    for (const video of mixedVideos) {
      const sourcePn = Math.max(1, video.meta?.sourcePn ?? 1);
      const prev = usedPageMap.get(video.authorMid) ?? 0;
      if (sourcePn > prev) {
        usedPageMap.set(video.authorMid, sourcePn);
      }

      const selectedSet = selectedMapByAuthor.get(video.authorMid) ?? new Set<string>();
      selectedSet.add(video.bvid);
      selectedMapByAuthor.set(video.authorMid, selectedSet);
    }

    const boundaryTaskMap = new Map<string, MixedBoundaryTask>();
    for (const mid of authorMids) {
      if (mode === 'overview') {
        continue;
      }
      const cache = authorCacheMap[mid];
      if (!cache || !hasAuthorMorePages(cache)) {
        continue;
      }
      const selectedSet = selectedMapByAuthor.get(mid);
      if (!selectedSet || selectedSet.size === 0) {
        continue;
      }

      const filteredByReadMark = filterMixedVideosByTracking(
        cache.videos,
        trackingGroupBaselineTs,
        normalizedRecentPresetKey,
        showAllForMixed,
        authorPreferences
      );
      if (filteredByReadMark.length === 0) {
        continue;
      }

      const mixedLowerBound = resolveAuthorMixedLowerBoundTs(
        mid,
        trackingGroupBaselineTs,
        normalizedRecentPresetKey,
        authorPreferences
      );
      const oldestCached = cache.videos[cache.videos.length - 1];
      // 已经跨过时间流可见下界时，不再向更旧分页推进，避免在已阅过滤场景下无限深翻页。
      if (mixedLowerBound > 0 && oldestCached && oldestCached.pubdate < mixedLowerBound) {
        continue;
      }

      const oldest = filteredByReadMark[filteredByReadMark.length - 1];
      if (!selectedSet.has(oldest.bvid)) {
        continue;
      }

      // 时间流补页只基于“当前缓存里实际存在的视频页”推进，防止继承到历史抬高的 nextPn。
      const pn = Math.max(2, resolveMaxSourcePn(cache.videos) + 1);
      const key = `${mid}:${pn}`;
      boundaryTaskMap.set(key, {
        mid,
        name: cache.name?.trim() || String(mid),
        pn
      });
    }

    diagnostics.usedPages = Array.from(usedPageMap.entries()).map(([mid, usedMaxPn]) => ({ mid, usedMaxPn }));
    diagnostics.boundaryTasks = Array.from(boundaryTaskMap.values());
  }

  runtime.unreadCount = calcGroupUnreadCount(
    group,
    authorMids,
    authorCacheMap,
    trackingGroupBaselineTs,
    clickedVideos,
    reviewedOverrides,
    authorPreferences
  );

  runtime.savedMode = mode;
  runtime.savedReadMarkTs = latestGroupReadMarkTs || undefined;
  runtime.savedRecentPresetKey = normalizedRecentPresetKey;
  runtime.savedAllPostsFilter = normalizedAllPostsFilter;
  runtime.savedByAuthorSortByLatest = byAuthorSortEnabled;

  const hasMoreForMixed = mixedTotalBeforeLimit > mixedVideos.length
    || authorMids.some((mid) => hasAuthorPotentialMoreForMixed(
      mid,
      authorCacheMap,
      trackingGroupBaselineTs,
      normalizedRecentPresetKey,
      effectiveAllPostsFilter,
      authorPreferences
    ));

  const result: GroupFeedResult = {
    groupId: group.groupId,
    mode,
    mixedVideos,
    videosByAuthor,
    lastRefreshAt: runtime.lastRefreshAt,
    lastReadAt: runtime.lastReadAt,
    unreadCount: runtime.unreadCount,
    hasMoreForMixed,
    readMarkTimestamps,
    graceReadMarkTs: getRecentPresetTs(normalizedRecentPresetKey),
    byAuthorPageSize: AUTHOR_VIDEOS_PAGE_SIZE
  };

  return result;
}

export function markGroupRead(groupId: string, settings: ExtensionSettings, runtimeMap: RuntimeMap): number {
  const runtime = ensureRuntimeState(runtimeMap, groupId, settings);
  runtime.lastReadAt = Date.now() / 1000;
  runtime.unreadCount = 0;
  return runtime.unreadCount;
}

/**
 * 生成所有分组的摘要信息，包含未读计数。
 * 基于全局作者缓存聚合视频数据计算未读数。
 */
export function makeSummary(
  groups: GroupConfig[],
  settings: ExtensionSettings,
  runtimeMap: RuntimeMap,
  feedCacheMap: FeedCacheMap,
  authorCacheMap: AuthorCacheMap,
  readMarks: ReadMarkMap,
  clickedVideos: ClickedVideoMap,
  reviewedOverrides: ReviewedOverrideMap,
  authorPreferences: AuthorPreferenceMap
): {
  summaries: Array<{
    groupId: string;
    title: string;
    unreadCount: number;
    lastRefreshAt?: number;
    enabled: boolean;
    savedMode?: ViewMode;
    savedReadMarkTs?: number;
    savedRecentPresetKey?: RecentPresetKey;
    savedAllPostsFilter?: AllPostsFilterKey;
    savedByAuthorSortByLatest?: boolean;
  }>;
  totalUnreadCount: number;
} {
  const summaries = groups.map((group) => {
    const runtime = ensureRuntimeState(runtimeMap, group.groupId, settings);
    const feedCache = feedCacheMap[group.groupId];
    let unreadCount = 0;

    if (feedCache) {
      const recentPresetKey = normalizeRecentPresetKey(runtime.savedRecentPresetKey ?? settings.defaultReadMarkDays);
      const groupBaselineTs = resolveGroupRecentBaselineTs(group.groupId, readMarks, recentPresetKey);
      unreadCount = calcGroupUnreadCount(
        group,
        feedCache.authorMids,
        authorCacheMap,
        groupBaselineTs,
        clickedVideos,
        reviewedOverrides,
        authorPreferences
      );
    }
    runtime.unreadCount = unreadCount;

    return {
      groupId: group.groupId,
      title: getGroupTitle(group),
      unreadCount,
      lastRefreshAt: runtime.lastRefreshAt,
      enabled: group.enabled,
      savedMode: runtime.savedMode,
      savedReadMarkTs: getLatestGroupReadMarkTs(group.groupId, readMarks) || undefined,
      savedRecentPresetKey: runtime.savedRecentPresetKey,
      savedAllPostsFilter: runtime.savedAllPostsFilter,
      savedByAuthorSortByLatest: runtime.savedByAuthorSortByLatest
    };
  });

  const totalUnreadCount = calcGlobalUnreadCount(
    groups,
    runtimeMap,
    feedCacheMap,
    authorCacheMap,
    readMarks,
    settings,
    clickedVideos,
    reviewedOverrides,
    authorPreferences
  );

  return {
    summaries,
    totalUnreadCount
  };
}

export function removeGroupState(groupId: string, runtimeMap: RuntimeMap, feedCacheMap: FeedCacheMap): void {
  delete runtimeMap[groupId];
  delete feedCacheMap[groupId];
}

export function isMixedMode(mode: ViewMode): boolean {
  return mode === 'mixed';
}

/**
 * 增加混合模式的目标数量（加载更多）。
 * 纯状态操作，不发起 API 请求。
 */
export function increaseMixedTarget(
  groupId: string,
  settings: ExtensionSettings,
  runtimeMap: RuntimeMap
): void {
  const runtime = ensureRuntimeState(runtimeMap, groupId, settings);
  runtime.mixedTargetCount += MIXED_LOAD_INCREMENT;
}

export { isAuthorCacheExpired };
