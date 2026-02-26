import { MIXED_LOAD_INCREMENT } from '@/shared/constants';
import { getAllFavVideos, getUploaderVideos, type FavMediaItem } from '@/shared/api/bilibili';
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

// ─── 作者级缓存操作 ───

function isAuthorCacheExpired(cache: AuthorVideoCache | undefined, settings: ExtensionSettings): boolean {
  if (!cache?.lastFetchedAt) {
    return true;
  }
  return Date.now() - cache.lastFetchedAt > settings.refreshIntervalMinutes * 60 * 1000;
}

/**
 * 刷新单个作者的视频缓存：重置分页游标，拉取首页并与已有数据合并。
 */
export async function refreshAuthorCache(
  mid: number,
  name: string,
  authorCacheMap: AuthorCacheMap
): Promise<AuthorVideoCache> {
  const existing = authorCacheMap[mid];
  const { videos, hasMore } = await getUploaderVideos(mid, 1, 20);

  const merged = existing ? mergeVideos(existing.videos, videos) : videos;

  const cache: AuthorVideoCache = {
    mid,
    name,
    videos: merged,
    nextPn: 2,
    hasMore,
    lastFetchedAt: Date.now()
  };

  authorCacheMap[mid] = cache;
  return cache;
}

/**
 * 确保作者缓存可用：未过期直接返回，过期则刷新。
 */
async function ensureAuthorCache(
  mid: number,
  name: string,
  authorCacheMap: AuthorCacheMap,
  settings: ExtensionSettings,
  forceRefresh: boolean
): Promise<AuthorVideoCache> {
  const existing = authorCacheMap[mid];
  if (!forceRefresh && existing && !isAuthorCacheExpired(existing, settings)) {
    return existing;
  }
  return refreshAuthorCache(mid, name, authorCacheMap);
}

/**
 * 为作者追加拉取更多视频（翻页），用于混合模式加载更多和作者模式补全。
 */
async function fetchMoreForAuthor(
  mid: number,
  authorCacheMap: AuthorCacheMap,
  pageSize: number
): Promise<boolean> {
  const cache = authorCacheMap[mid];
  if (!cache || !cache.hasMore) {
    return false;
  }

  const { videos, hasMore } = await getUploaderVideos(mid, cache.nextPn, pageSize);
  cache.nextPn += 1;
  cache.hasMore = hasMore;

  if (videos.length > 0) {
    cache.videos = mergeVideos(cache.videos, videos);
    return true;
  }
  return false;
}

// ─── 分组级操作 ───

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

/**
 * 获取分组内所有作者的名称映射。
 */
function getAuthorNames(authorMids: number[], authorCacheMap: AuthorCacheMap): Map<number, string> {
  const names = new Map<number, string>();
  for (const mid of authorMids) {
    const cache = authorCacheMap[mid];
    if (cache) {
      names.set(mid, cache.name);
    }
  }
  return names;
}

/**
 * 全量刷新分组缓存：从收藏夹重建作者列表，刷新所有作者的视频缓存。
 */
export async function refreshGroupCache(
  group: GroupConfig,
  settings: ExtensionSettings,
  runtimeMap: RuntimeMap,
  feedCacheMap: FeedCacheMap,
  authorCacheMap: AuthorCacheMap
): Promise<void> {
  const favVideos = await getAllFavVideos(group.mediaId);
  const authors = buildAuthorList(favVideos);
  const authorMids = authors.map((a) => a.mid);

  feedCacheMap[group.groupId] = {
    groupId: group.groupId,
    authorMids,
    updatedAt: Date.now()
  };

  for (const author of authors) {
    await ensureAuthorCache(author.mid, author.name, authorCacheMap, settings, true);
  }

  const runtime = ensureRuntimeState(runtimeMap, group.groupId, settings);
  runtime.mixedTargetCount = settings.timelineMixedMaxCount;
  runtime.lastRefreshAt = Date.now();

  const mixedVideos = aggregateMixedVideos(authorMids, authorCacheMap);
  runtime.unreadCount = calcUnreadCount(mixedVideos, runtime.lastReadAt);
}

/**
 * 确保分组缓存可用：检查分组内作者是否有过期的，有则刷新。
 */
export async function ensureGroupCache(
  group: GroupConfig,
  settings: ExtensionSettings,
  runtimeMap: RuntimeMap,
  feedCacheMap: FeedCacheMap,
  authorCacheMap: AuthorCacheMap,
  forceRefresh: boolean
): Promise<void> {
  const feedCache = feedCacheMap[group.groupId];

  if (forceRefresh || !feedCache) {
    await refreshGroupCache(group, settings, runtimeMap, feedCacheMap, authorCacheMap);
    return;
  }

  for (const mid of feedCache.authorMids) {
    const existing = authorCacheMap[mid];
    const name = existing?.name ?? String(mid);
    await ensureAuthorCache(mid, name, authorCacheMap, settings, false);
  }

  const runtime = ensureRuntimeState(runtimeMap, group.groupId, settings);
  // 走缓存路径时不更新 lastRefreshAt，保留上次真正刷新的时间
  if (!runtime.lastRefreshAt) {
    runtime.lastRefreshAt = feedCache.updatedAt;
  }
}

/**
 * 混合模式加载更多：逐作者翻页追加，直到达到目标数量或无更多数据。
 */
export async function loadMoreForMixed(
  group: GroupConfig,
  settings: ExtensionSettings,
  runtimeMap: RuntimeMap,
  feedCacheMap: FeedCacheMap,
  authorCacheMap: AuthorCacheMap,
  increaseTarget: boolean
): Promise<void> {
  const runtime = ensureRuntimeState(runtimeMap, group.groupId, settings);
  await ensureGroupCache(group, settings, runtimeMap, feedCacheMap, authorCacheMap, false);

  if (increaseTarget) {
    runtime.mixedTargetCount += MIXED_LOAD_INCREMENT;
  }

  const feedCache = feedCacheMap[group.groupId];
  if (!feedCache) return;

  let mixedVideos = aggregateMixedVideos(feedCache.authorMids, authorCacheMap);
  const hasMoreAuthors = () => feedCache.authorMids.some((mid) => authorCacheMap[mid]?.hasMore);

  while (mixedVideos.length < runtime.mixedTargetCount && hasMoreAuthors()) {
    let appended = false;
    for (const mid of feedCache.authorMids) {
      const didAppend = await fetchMoreForAuthor(mid, authorCacheMap, 20);
      if (didAppend) appended = true;
    }
    if (!appended) break;
    mixedVideos = aggregateMixedVideos(feedCache.authorMids, authorCacheMap);
  }

  runtime.unreadCount = calcUnreadCount(mixedVideos, runtime.lastReadAt);
}

/**
 * 作者模式：确保每位作者至少有 20 条视频数据用于已阅过滤展示。
 */
export async function ensureAuthorModePrepared(
  group: GroupConfig,
  settings: ExtensionSettings,
  runtimeMap: RuntimeMap,
  feedCacheMap: FeedCacheMap,
  authorCacheMap: AuthorCacheMap
): Promise<void> {
  await ensureGroupCache(group, settings, runtimeMap, feedCacheMap, authorCacheMap, false);

  const feedCache = feedCacheMap[group.groupId];
  if (!feedCache) return;

  const limit = 20;
  for (const mid of feedCache.authorMids) {
    while ((authorCacheMap[mid]?.videos.length ?? 0) < limit) {
      if (!authorCacheMap[mid]?.hasMore) break;
      const didAppend = await fetchMoreForAuthor(mid, authorCacheMap, Math.max(20, limit));
      if (!didAppend) break;
    }
  }

  const runtime = ensureRuntimeState(runtimeMap, group.groupId, settings);
  const mixedVideos = aggregateMixedVideos(feedCache.authorMids, authorCacheMap);
  runtime.unreadCount = calcUnreadCount(mixedVideos, runtime.lastReadAt);
}

// ─── 视图组装 ───

/**
 * 收集当前分组内所有作者的已阅时间点并集（去重、倒序）。
 */
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

export function toFeedResult(
  group: GroupConfig,
  mode: ViewMode,
  settings: ExtensionSettings,
  runtimeMap: RuntimeMap,
  feedCacheMap: FeedCacheMap,
  authorCacheMap: AuthorCacheMap,
  readMarks: ReadMarkMap,
  selectedReadMarkTs: number
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

  const videosByAuthor: AuthorFeed[] = authorMids.map((mid) => ({
    authorMid: mid,
    authorName: authorNames.get(mid) ?? String(mid),
    videos: filterVideosByReadMark(
      authorCacheMap[mid]?.videos ?? [],
      mid,
      effectiveTs,
      readMarks,
      settings.extraOlderVideoCount,
      graceReadMarkTs
    )
  }));

  let mixedVideos: VideoItem[];
  if (effectiveTs === 0) {
    mixedVideos = aggregateMixedVideos(authorMids, authorCacheMap);
  } else {
    const allFiltered = videosByAuthor.flatMap((a) => a.videos);
    const deduped = new Map<string, VideoItem>();
    for (const v of allFiltered) {
      deduped.set(v.bvid, v);
    }
    mixedVideos = Array.from(deduped.values()).sort((a, b) => b.pubdate - a.pubdate);
  }

  const allMixedVideos = aggregateMixedVideos(authorMids, authorCacheMap);
  runtime.unreadCount = calcUnreadCount(allMixedVideos, runtime.lastReadAt);

  runtime.savedMode = mode;
  runtime.savedReadMarkTs = selectedReadMarkTs;

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
): Array<{ groupId: string; title: string; unreadCount: number; lastRefreshAt?: number; enabled: boolean; savedMode?: ViewMode; savedReadMarkTs?: number }> {
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
      savedReadMarkTs: runtime.savedReadMarkTs
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
 * 判断分组内是否有作者缓存已过期，用于自动刷新判定。
 */
export function isStaleForAutoRefresh(
  groupId: string,
  settings: ExtensionSettings,
  feedCacheMap: FeedCacheMap,
  authorCacheMap: AuthorCacheMap
): boolean {
  const feedCache = feedCacheMap[groupId];
  if (!feedCache || !feedCache.authorMids) return true;

  return feedCache.authorMids.some((mid) => isAuthorCacheExpired(authorCacheMap[mid], settings));
}

export { isAuthorCacheExpired };

