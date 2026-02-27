import { MIXED_LOAD_INCREMENT } from '@/shared/constants';
import { getUploaderVideos, getUserCard, getAllFavVideos, type FavMediaItem } from '@/shared/api/bilibili';
import type {
  AuthorFeed,
  AuthorVideoCache,
  ExtensionSettings,
  GroupConfig,
  GroupFeedCache,
  GroupFeedResult,
  GroupReadMark,
  GroupRuntimeState,
  VideoItem,
  ViewMode
} from '@/shared/types';

export type RuntimeMap = Record<string, GroupRuntimeState>;
export type FeedCacheMap = Record<string, GroupFeedCache>;
export type AuthorCacheMap = Record<number, AuthorVideoCache>;
type ReadMarkMap = Record<string, GroupReadMark>;
type ClickedVideoMap = Record<string, number>;
const DEFAULT_BY_AUTHOR_SORT_BY_LATEST = true;

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

function mergeVideos(existing: VideoItem[], incoming: VideoItem[]): VideoItem[] {
  const map = new Map<string, VideoItem>();
  existing.forEach((video) => map.set(video.bvid, video));
  incoming.forEach((video) => map.set(video.bvid, video));
  return Array.from(map.values()).sort((a, b) => b.pubdate - a.pubdate);
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
  if (!cache?.lastFetchedAt) {
    return true;
  }
  // 缓存里还没有完整 Card 信息时，视为过期并优先补齐。
  if (!hasCardSnapshot(cache)) {
    return true;
  }
  return Date.now() - cache.lastFetchedAt > settings.refreshIntervalMinutes * 60 * 1000;
}

/**
 * 刷新单个作者的视频缓存：重置分页游标，拉取首页并与已有数据合并；
 * 并在同一轮请求中同步刷新 Card 信息（作者名、头像、粉丝数、关注状态）。
 * 仅由调度器调用，不应被前台路径直接使用。
 */
export async function refreshAuthorCache(
  mid: number,
  name: string,
  authorCacheMap: AuthorCacheMap
): Promise<AuthorVideoCache> {
  const existing = authorCacheMap[mid];
  const { videos, hasMore } = await getUploaderVideos(mid, 1, 20);

  const merged = existing ? mergeVideos(existing.videos, videos) : videos;

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

  const cache: AuthorVideoCache = {
    mid,
    name: resolvedName,
    face: resolvedFace,
    follower: resolvedFollower,
    following: resolvedFollowing,
    faceFetchedAt: resolvedFace ? Date.now() : existing?.faceFetchedAt,
    videos: merged,
    nextPn: 2,
    hasMore,
    lastFetchedAt: Date.now()
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

  return runtimeMap[groupId];
}

function getGraceReadMarkTs(settings: ExtensionSettings): number {
  if (settings.defaultReadMarkDays <= 0) {
    return 0;
  }
  return Math.floor(Date.now() / 1000) - settings.defaultReadMarkDays * 24 * 60 * 60;
}

/**
 * 解析分组用于未读计算的时间点：
 * - 0: 全部（红点固定 0）
 * - -1: 默认已阅天数（grace）
 * - >0: 具体已阅时间点
 *
 * 当分组没有记忆值时，优先回退到“该分组最新已阅时间点”，否则回退到 grace（-1）。
 */
function resolveGroupReadMarkTs(savedReadMarkTs: number | undefined, readMarkTimestamps: number[]): number {
  if (savedReadMarkTs === 0 || savedReadMarkTs === -1) {
    return savedReadMarkTs;
  }

  if (typeof savedReadMarkTs === 'number' && savedReadMarkTs > 0) {
    if (readMarkTimestamps.includes(savedReadMarkTs)) {
      return savedReadMarkTs;
    }
  }

  if (readMarkTimestamps.length > 0) {
    return readMarkTimestamps[0];
  }

  return -1;
}

/**
 * 计算“当前分组”在指定已阅选项下的统一基线时间戳。
 * 返回值为秒级时间戳：仅统计 pubdate > baseline 的视频。
 */
function resolveGroupUnreadBaselineTs(selectedReadMarkTs: number, graceReadMarkTs: number): number {
  if (selectedReadMarkTs === -1) {
    return graceReadMarkTs;
  }
  if (selectedReadMarkTs > 0) {
    return selectedReadMarkTs;
  }
  return 0;
}

function isVideoViewed(video: VideoItem, clickedVideos: ClickedVideoMap): boolean {
  // “已查看”与卡片展示规则保持一致：
  // 1) 点击记录命中；或 2) playback_position >= 10。
  return clickedVideos[video.bvid] !== undefined || (video.playbackPosiiton ?? 0) >= 10;
}

/**
 * 计算单个分组在指定已阅时间点下的未读数量（按 bvid 去重）。
 */
function calcGroupUnreadCount(
  authorMids: number[],
  authorCacheMap: AuthorCacheMap,
  selectedReadMarkTs: number,
  graceReadMarkTs: number,
  clickedVideos: ClickedVideoMap
): number {
  if (selectedReadMarkTs === 0) {
    return 0;
  }

  const baseline = resolveGroupUnreadBaselineTs(selectedReadMarkTs, graceReadMarkTs);

  const seenBvids = new Set<string>();
  let unreadCount = 0;

  for (const mid of authorMids) {
    const videos = authorCacheMap[mid]?.videos ?? [];
    for (const video of videos) {
      if (seenBvids.has(video.bvid)) {
        continue;
      }
      seenBvids.add(video.bvid);
      if (video.pubdate > baseline && !isVideoViewed(video, clickedVideos)) {
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
      map.set(video.bvid, video);
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

function collectReadMarkTimestamps(groupId: string, readMarks: ReadMarkMap): number[] {
  const timestamps = readMarks[groupId]?.timestamps ?? [];
  return [...timestamps].sort((a, b) => b - a);
}

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
  graceReadMarkTs: number,
  clickedVideos: ClickedVideoMap
): number {
  const authorBaselineMap = new Map<number, number>();
  const authorInNonAllGroups = new Set<number>();

  for (const group of groups) {
    if (!group.enabled) {
      continue;
    }

    const feedCache = feedCacheMap[group.groupId];
    if (!feedCache) {
      continue;
    }

    const runtime = runtimeMap[group.groupId];
    const readMarkTimestamps = collectReadMarkTimestamps(group.groupId, readMarks);
    const selectedTs = resolveGroupReadMarkTs(runtime?.savedReadMarkTs, readMarkTimestamps);

    // “全部”分组只影响自身红点，不参与全局作者基线聚合。
    if (selectedTs === 0) {
      continue;
    }

    for (const mid of feedCache.authorMids) {
      authorInNonAllGroups.add(mid);
      const baseline = resolveGroupUnreadBaselineTs(selectedTs, graceReadMarkTs);
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
      if (video.pubdate > baseline && !isVideoViewed(video, clickedVideos)) {
        unreadBvids.add(video.bvid);
      }
    }
  }

  return unreadBvids.size;
}

/**
 * 按已阅时间点过滤某位作者的视频列表。
 * selectedTs: 用户选中的已阅时间点（0 表示"全部"，不过滤）。
 * graceTs: 无真实已阅记录时的 grace 默认时间点。
 */
function filterVideosByReadMark(
  videos: VideoItem[],
  selectedTs: number,
  extraCount: number,
  graceTs: number
): VideoItem[] {
  if (selectedTs === 0) {
    return videos;
  }

  const baseline = resolveGroupUnreadBaselineTs(selectedTs, graceTs);
  if (baseline <= 0) {
    return videos;
  }

  const newVideos = videos.filter((v) => v.pubdate >= baseline);
  const olderVideos = videos.filter((v) => v.pubdate < baseline).slice(0, extraCount);
  return [...newVideos, ...olderVideos];
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
  selectedReadMarkTs: number,
  byAuthorSortByLatest?: boolean
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
  const graceReadMarkTs = getGraceReadMarkTs(settings);

  const effectiveTs = resolveGroupUnreadBaselineTs(selectedReadMarkTs, graceReadMarkTs);

  const byAuthorSortEnabled = byAuthorSortByLatest ?? runtime.savedByAuthorSortByLatest ?? DEFAULT_BY_AUTHOR_SORT_BY_LATEST;
  let videosByAuthor: AuthorFeed[] = authorMids.map((mid) => {
    const allVideos = authorCacheMap[mid]?.videos ?? [];
    const videos = filterVideosByReadMark(
      allVideos,
      selectedReadMarkTs,
      settings.extraOlderVideoCount,
      graceReadMarkTs
    );
    const baseline = resolveGroupUnreadBaselineTs(selectedReadMarkTs, graceReadMarkTs);
    const meta = authorMetaMap.get(mid);

    // 当当前展示列表全部落在基线之前时，说明该作者“仅显示已阅前额外视频”。
    return {
      authorMid: mid,
      authorName: meta?.name ?? String(mid),
      authorFace: meta?.face,
      follower: meta?.follower,
      following: meta?.following,
      videos: videos.map((video) => injectAuthorMetaIntoVideo(video, meta)),
      hasOnlyExtraOlderVideos:
        selectedReadMarkTs !== 0 &&
        baseline > 0 &&
        videos.length > 0 &&
        videos.every((video) => video.pubdate < baseline),
      latestPubdate: getLatestPubdate(allVideos) ?? undefined
    };
  });

  if (mode === 'byAuthor' && byAuthorSortEnabled) {
    videosByAuthor = sortAuthorsByLatestPubdate(videosByAuthor);
  }

  const injectAuthorMeta = (videos: VideoItem[]): VideoItem[] =>
    videos.map((video) => injectAuthorMetaIntoVideo(video, authorMetaMap.get(video.authorMid)));

  let mixedVideos: VideoItem[];
  if (effectiveTs === 0) {
    mixedVideos = injectAuthorMeta(aggregateMixedVideos(authorMids, authorCacheMap));
  } else {
    const allFiltered = videosByAuthor.flatMap((a) => a.videos);
    const deduped = new Map<string, VideoItem>();
    for (const v of allFiltered) {
      deduped.set(v.bvid, v);
    }
    mixedVideos = injectAuthorMeta(Array.from(deduped.values()).sort((a, b) => b.pubdate - a.pubdate));
  }

  // 时间流读取遵循 runtime 目标数量，避免一次返回过多数据导致渲染与消息传输变慢。
  const mixedTotalBeforeLimit = mixedVideos.length;
  const mixedLimit = Math.max(1, runtime.mixedTargetCount || settings.timelineMixedMaxCount);
  mixedVideos = mixedVideos.slice(0, mixedLimit);

  runtime.unreadCount = calcGroupUnreadCount(
    authorMids,
    authorCacheMap,
    selectedReadMarkTs,
    graceReadMarkTs,
    clickedVideos
  );

  runtime.savedMode = mode;
  runtime.savedReadMarkTs = selectedReadMarkTs;
  runtime.savedByAuthorSortByLatest = byAuthorSortEnabled;

  const hasMoreForMixed = mixedTotalBeforeLimit > mixedVideos.length || authorMids.some((mid) => authorCacheMap[mid]?.hasMore);

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
    graceReadMarkTs
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
  clickedVideos: ClickedVideoMap
): {
  summaries: Array<{
    groupId: string;
    title: string;
    unreadCount: number;
    lastRefreshAt?: number;
    enabled: boolean;
    savedMode?: ViewMode;
    savedReadMarkTs?: number;
    savedByAuthorSortByLatest?: boolean;
  }>;
  totalUnreadCount: number;
} {
  const graceReadMarkTs = getGraceReadMarkTs(settings);
  const summaries = groups.map((group) => {
    const runtime = ensureRuntimeState(runtimeMap, group.groupId, settings);
    const feedCache = feedCacheMap[group.groupId];
    let unreadCount = 0;

    if (feedCache) {
      const readMarkTimestamps = collectReadMarkTimestamps(group.groupId, readMarks);
      const selectedTs = resolveGroupReadMarkTs(runtime.savedReadMarkTs, readMarkTimestamps);
      unreadCount = calcGroupUnreadCount(
        feedCache.authorMids,
        authorCacheMap,
        selectedTs,
        graceReadMarkTs,
        clickedVideos
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
      savedReadMarkTs: runtime.savedReadMarkTs,
      savedByAuthorSortByLatest: runtime.savedByAuthorSortByLatest
    };
  });

  const totalUnreadCount = calcGlobalUnreadCount(
    groups,
    runtimeMap,
    feedCacheMap,
    authorCacheMap,
    readMarks,
    graceReadMarkTs,
    clickedVideos
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
