import { MIXED_LOAD_INCREMENT } from '@/shared/constants';
import { getUploaderVideos, getUserFace, getAllFavVideos, type FavMediaItem } from '@/shared/api/bilibili';
import type {
  AuthorFeed,
  AuthorReadMark,
  AuthorVideoCache,
  ExtensionSettings,
  GroupConfig,
  GroupFeedCache,
  GroupFeedResult,
  GroupRuntimeState,
  VideoItem,
  ViewMode
} from '@/shared/types';

export type RuntimeMap = Record<string, GroupRuntimeState>;
export type FeedCacheMap = Record<string, GroupFeedCache>;
export type AuthorCacheMap = Record<number, AuthorVideoCache>;
type ReadMarkMap = Record<number, AuthorReadMark>;
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

// ─── 作者级缓存操作 ───

function isAuthorCacheExpired(cache: AuthorVideoCache | undefined, settings: ExtensionSettings): boolean {
  if (!cache?.lastFetchedAt) {
    return true;
  }
  return Date.now() - cache.lastFetchedAt > settings.refreshIntervalMinutes * 60 * 1000;
}

const FACE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isFaceExpired(cache: AuthorVideoCache | undefined): boolean {
  if (!cache?.face || !cache.faceFetchedAt) return true;
  return Date.now() - cache.faceFetchedAt > FACE_CACHE_TTL_MS;
}

/**
 * 刷新单个作者的视频缓存：重置分页游标，拉取首页并与已有数据合并。
 * 同时在头像缓存过期时拉取头像。
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

  let face = existing?.face;
  let faceFetchedAt = existing?.faceFetchedAt;

  if (isFaceExpired(existing)) {
    try {
      face = await getUserFace(mid);
      faceFetchedAt = Date.now();
    } catch {
      // 头像拉取失败不影响主流程
    }
  }

  // 作者名优先使用接口返回的真实名称；若拿不到再回退缓存/任务入参。
  const apiName = videos.find((item) => item.authorName?.trim())?.authorName?.trim();
  const existingName = existing?.name?.trim();
  const taskName = name?.trim();
  const resolvedName =
    apiName ||
    (existingName && !isNumericName(existingName) ? existingName : undefined) ||
    (taskName && !isNumericName(taskName) ? taskName : undefined) ||
    existingName ||
    taskName ||
    String(mid);

  const cache: AuthorVideoCache = {
    mid,
    name: resolvedName,
    face,
    faceFetchedAt,
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

function calcUnreadCount(videos: VideoItem[], lastReadAt?: number): number {
  if (!lastReadAt) {
    return videos.length;
  }
  return videos.filter((video) => video.pubdate > lastReadAt).length;
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
        (cacheName && !isNumericName(cacheName) ? cacheName : undefined) ||
        videoName ||
        cacheName ||
        String(mid);
      names.set(mid, resolvedName);
    }
  }
  return names;
}

// ─── 视图组装 ───

function collectReadMarkTimestamps(authorMids: number[], readMarks: ReadMarkMap): number[] {
  const tsSet = new Set<number>();

  for (const mid of authorMids) {
    const mark = readMarks[mid];
    if (mark) {
      for (const ts of mark.timestamps) {
        tsSet.add(ts);
      }
    }
  }

  return Array.from(tsSet).sort((a, b) => b - a);
}

/**
 * 按已阅时间点过滤某位作者的视频列表。
 * selectedTs: 用户选中的已阅时间点（0 表示"全部"，不过滤）。
 * graceTs: 无真实已阅记录时的 grace 默认时间点。
 */
function filterVideosByReadMark(
  videos: VideoItem[],
  authorMid: number,
  selectedTs: number,
  readMarks: ReadMarkMap,
  extraCount: number,
  graceTs: number
): VideoItem[] {
  if (selectedTs === 0) {
    return videos;
  }

  const mark = readMarks[authorMid];

  if (mark && mark.timestamps.length > 0) {
    const authorTs = mark.timestamps.find((ts) => ts <= selectedTs);
    if (authorTs === undefined) {
      return videos;
    }

    const newVideos = videos.filter((v) => v.pubdate >= authorTs);
    const olderVideos = videos.filter((v) => v.pubdate < authorTs).slice(0, extraCount);
    return [...newVideos, ...olderVideos];
  }

  if (graceTs > 0) {
    const newVideos = videos.filter((v) => v.pubdate >= graceTs);
    const olderVideos = videos.filter((v) => v.pubdate < graceTs).slice(0, extraCount);
    return [...newVideos, ...olderVideos];
  }

  return videos;
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
  const readMarkTimestamps = collectReadMarkTimestamps(authorMids, readMarks);

  let graceReadMarkTs = 0;
  if (settings.defaultReadMarkDays > 0) {
    graceReadMarkTs = Math.floor(Date.now() / 1000) - settings.defaultReadMarkDays * 24 * 60 * 60;
  }

  const effectiveTs = selectedReadMarkTs === -1 ? graceReadMarkTs : selectedReadMarkTs;

  const byAuthorSortEnabled = byAuthorSortByLatest ?? runtime.savedByAuthorSortByLatest ?? DEFAULT_BY_AUTHOR_SORT_BY_LATEST;
  let videosByAuthor: AuthorFeed[] = authorMids.map((mid) => ({
    authorMid: mid,
    authorName: authorNames.get(mid) ?? String(mid),
    authorFace: authorCacheMap[mid]?.face,
    videos: filterVideosByReadMark(
      authorCacheMap[mid]?.videos ?? [],
      mid,
      effectiveTs,
      readMarks,
      settings.extraOlderVideoCount,
      graceReadMarkTs
    )
  }));

  if (mode === 'byAuthor' && byAuthorSortEnabled) {
    videosByAuthor = sortAuthorsByLatestPubdate(videosByAuthor);
  }

  // 为混合视频注入作者头像
  const faceMap = new Map<number, string>();
  for (const mid of authorMids) {
    const face = authorCacheMap[mid]?.face;
    if (face) faceMap.set(mid, face);
  }
  const injectFace = (videos: VideoItem[]): VideoItem[] =>
    videos.map((v) => (faceMap.has(v.authorMid) ? { ...v, authorFace: faceMap.get(v.authorMid) } : v));

  let mixedVideos: VideoItem[];
  if (effectiveTs === 0) {
    mixedVideos = injectFace(aggregateMixedVideos(authorMids, authorCacheMap));
  } else {
    const allFiltered = videosByAuthor.flatMap((a) => a.videos);
    const deduped = new Map<string, VideoItem>();
    for (const v of allFiltered) {
      deduped.set(v.bvid, v);
    }
    mixedVideos = injectFace(Array.from(deduped.values()).sort((a, b) => b.pubdate - a.pubdate));
  }

  const allMixedVideos = aggregateMixedVideos(authorMids, authorCacheMap);
  runtime.unreadCount = calcUnreadCount(allMixedVideos, runtime.lastReadAt);

  runtime.savedMode = mode;
  runtime.savedReadMarkTs = selectedReadMarkTs;
  runtime.savedByAuthorSortByLatest = byAuthorSortEnabled;

  const hasMoreForMixed = authorMids.some((mid) => authorCacheMap[mid]?.hasMore);

  return {
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
  authorCacheMap: AuthorCacheMap
): Array<{
  groupId: string;
  title: string;
  unreadCount: number;
  lastRefreshAt?: number;
  enabled: boolean;
  savedMode?: ViewMode;
  savedReadMarkTs?: number;
  savedByAuthorSortByLatest?: boolean;
}> {
  return groups.map((group) => {
    const runtime = ensureRuntimeState(runtimeMap, group.groupId, settings);
    const feedCache = feedCacheMap[group.groupId];

    if (feedCache) {
      const mixedVideos = aggregateMixedVideos(feedCache.authorMids, authorCacheMap);
      runtime.unreadCount = calcUnreadCount(mixedVideos, runtime.lastReadAt);
    }

    return {
      groupId: group.groupId,
      title: getGroupTitle(group),
      unreadCount: runtime.unreadCount,
      lastRefreshAt: runtime.lastRefreshAt,
      enabled: group.enabled,
      savedMode: runtime.savedMode,
      savedReadMarkTs: runtime.savedReadMarkTs,
      savedByAuthorSortByLatest: runtime.savedByAuthorSortByLatest
    };
  });
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
