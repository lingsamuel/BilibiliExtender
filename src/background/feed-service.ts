import { MIXED_LOAD_INCREMENT } from '@/shared/constants';
import { getAllFavVideos, getUploaderVideos, type FavMediaItem } from '@/shared/api/bilibili';
import type {
  AuthorFeed,
  ExtensionSettings,
  GroupConfig,
  GroupFeedCache,
  GroupFeedResult,
  GroupRuntimeState,
  VideoItem,
  ViewMode
} from '@/shared/types';

type RuntimeMap = Record<string, GroupRuntimeState>;
type CacheMap = Record<string, GroupFeedCache>;

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

function recomputeMixedVideos(cache: GroupFeedCache): void {
  const map = new Map<string, VideoItem>();
  Object.values(cache.videosByAuthor).forEach((videos) => {
    videos.forEach((video) => {
      map.set(video.bvid, video);
    });
  });

  cache.mixedVideos = Array.from(map.values()).sort((a, b) => b.pubdate - a.pubdate);
}

function hasMoreAuthors(cache: GroupFeedCache): boolean {
  return Object.values(cache.authorCursorMap).some((cursor) => cursor.hasMore);
}

function ensureRuntimeState(
  runtimeMap: RuntimeMap,
  groupId: string,
  settings: ExtensionSettings
): GroupRuntimeState {
  if (!runtimeMap[groupId]) {
    runtimeMap[groupId] = {
      groupId,
      unreadCount: 0,
      mixedTargetCount: settings.mixedInitialTargetCount
    };
  }

  if (!runtimeMap[groupId].mixedTargetCount) {
    runtimeMap[groupId].mixedTargetCount = settings.mixedInitialTargetCount;
  }

  return runtimeMap[groupId];
}

function calcUnreadCount(videos: VideoItem[], lastReadAt?: number): number {
  if (!lastReadAt) {
    return videos.length;
  }

  return videos.filter((video) => video.pubdate > lastReadAt).length;
}

async function fetchOneRound(cache: GroupFeedCache, pageSize: number): Promise<boolean> {
  let appended = false;

  for (const author of cache.authors) {
    const cursor = cache.authorCursorMap[author.mid];

    if (!cursor || !cursor.hasMore) {
      continue;
    }

    const { videos, hasMore } = await getUploaderVideos(author.mid, cursor.nextPn, pageSize);

    cursor.nextPn += 1;
    cursor.hasMore = hasMore;

    if (videos.length > 0) {
      cache.videosByAuthor[author.mid] = mergeVideos(cache.videosByAuthor[author.mid] ?? [], videos);
      appended = true;
    }
  }

  if (appended) {
    recomputeMixedVideos(cache);
  }

  cache.updatedAt = Date.now();
  return appended;
}

/**
 * 全量刷新分组缓存：重建作者集合和分页游标，并抓取首轮投稿数据。
 */
export async function refreshGroupCache(
  group: GroupConfig,
  settings: ExtensionSettings,
  runtimeMap: RuntimeMap,
  cacheMap: CacheMap
): Promise<GroupFeedCache> {
  const favVideos = await getAllFavVideos(group.mediaId);
  const authors = buildAuthorList(favVideos);

  const cache: GroupFeedCache = {
    groupId: group.groupId,
    authors,
    authorCursorMap: Object.fromEntries(
      authors.map((author) => [author.mid, { nextPn: 1, hasMore: true, name: author.name }])
    ),
    videosByAuthor: {},
    mixedVideos: [],
    updatedAt: Date.now()
  };

  const runtime = ensureRuntimeState(runtimeMap, group.groupId, settings);
  runtime.mixedTargetCount = settings.mixedInitialTargetCount;
  runtime.lastRefreshAt = Date.now();

  if (authors.length > 0) {
    await fetchOneRound(cache, Math.max(20, settings.authorPerCreatorCount));
  }

  runtime.unreadCount = calcUnreadCount(cache.mixedVideos, runtime.lastReadAt);
  cacheMap[group.groupId] = cache;

  return cache;
}

function shouldRefresh(runtime: GroupRuntimeState | undefined, settings: ExtensionSettings): boolean {
  if (!runtime?.lastRefreshAt) {
    return true;
  }

  const intervalMs = settings.refreshIntervalMinutes * 60 * 1000;
  return Date.now() - runtime.lastRefreshAt > intervalMs;
}

export async function ensureGroupCache(
  group: GroupConfig,
  settings: ExtensionSettings,
  runtimeMap: RuntimeMap,
  cacheMap: CacheMap,
  forceRefresh: boolean
): Promise<GroupFeedCache> {
  const runtime = runtimeMap[group.groupId];
  const cache = cacheMap[group.groupId];

  if (forceRefresh || !cache || shouldRefresh(runtime, settings)) {
    return refreshGroupCache(group, settings, runtimeMap, cacheMap);
  }

  return cache;
}

/**
 * 混合模式加载更多：按作者游标执行一轮轮追加，直到达到目标数量或无更多数据。
 */
export async function loadMoreForMixed(
  group: GroupConfig,
  settings: ExtensionSettings,
  runtimeMap: RuntimeMap,
  cacheMap: CacheMap,
  increaseTarget: boolean
): Promise<GroupFeedCache> {
  const runtime = ensureRuntimeState(runtimeMap, group.groupId, settings);
  const cache = await ensureGroupCache(group, settings, runtimeMap, cacheMap, false);

  if (increaseTarget) {
    runtime.mixedTargetCount += MIXED_LOAD_INCREMENT;
  }

  while (cache.mixedVideos.length < runtime.mixedTargetCount && hasMoreAuthors(cache)) {
    const appended = await fetchOneRound(cache, 20);
    if (!appended) {
      break;
    }
  }

  runtime.unreadCount = calcUnreadCount(cache.mixedVideos, runtime.lastReadAt);
  runtime.lastRefreshAt = Date.now();
  return cache;
}

/**
 * 作者模式要求每位作者至少达到配置条数；不足时继续按作者分页补齐。
 */
export async function ensureAuthorModePrepared(
  group: GroupConfig,
  settings: ExtensionSettings,
  runtimeMap: RuntimeMap,
  cacheMap: CacheMap
): Promise<GroupFeedCache> {
  const cache = await ensureGroupCache(group, settings, runtimeMap, cacheMap, false);
  const limit = settings.authorPerCreatorCount;

  for (const author of cache.authors) {
    while ((cache.videosByAuthor[author.mid]?.length ?? 0) < limit) {
      const cursor = cache.authorCursorMap[author.mid];
      if (!cursor?.hasMore) {
        break;
      }

      const { videos, hasMore } = await getUploaderVideos(author.mid, cursor.nextPn, Math.max(20, limit));
      cursor.nextPn += 1;
      cursor.hasMore = hasMore;

      if (videos.length === 0) {
        break;
      }

      cache.videosByAuthor[author.mid] = mergeVideos(cache.videosByAuthor[author.mid] ?? [], videos);
    }
  }

  recomputeMixedVideos(cache);
  cache.updatedAt = Date.now();

  const runtime = ensureRuntimeState(runtimeMap, group.groupId, settings);
  runtime.unreadCount = calcUnreadCount(cache.mixedVideos, runtime.lastReadAt);
  runtime.lastRefreshAt = Date.now();

  return cache;
}

export function toFeedResult(
  group: GroupConfig,
  mode: ViewMode,
  settings: ExtensionSettings,
  runtimeMap: RuntimeMap,
  cacheMap: CacheMap
): GroupFeedResult {
  const runtime = ensureRuntimeState(runtimeMap, group.groupId, settings);
  const cache = cacheMap[group.groupId];

  if (!cache) {
    throw new Error(`分组缓存不存在: ${getGroupTitle(group)}`);
  }

  const videosByAuthor: AuthorFeed[] = cache.authors.map((author) => ({
    authorMid: author.mid,
    authorName: author.name,
    videos: (cache.videosByAuthor[author.mid] ?? []).slice(0, settings.authorPerCreatorCount)
  }));

  runtime.unreadCount = calcUnreadCount(cache.mixedVideos, runtime.lastReadAt);

  return {
    groupId: group.groupId,
    mode,
    mixedVideos: cache.mixedVideos,
    videosByAuthor,
    lastRefreshAt: runtime.lastRefreshAt,
    lastReadAt: runtime.lastReadAt,
    unreadCount: runtime.unreadCount,
    hasMoreForMixed: hasMoreAuthors(cache)
  };
}

export function markGroupRead(groupId: string, settings: ExtensionSettings, runtimeMap: RuntimeMap): number {
  const runtime = ensureRuntimeState(runtimeMap, groupId, settings);
  runtime.lastReadAt = Date.now() / 1000;
  runtime.unreadCount = 0;
  return runtime.unreadCount;
}

export function makeSummary(
  groups: GroupConfig[],
  settings: ExtensionSettings,
  runtimeMap: RuntimeMap,
  cacheMap: CacheMap
): Array<{ groupId: string; title: string; unreadCount: number; lastRefreshAt?: number; enabled: boolean }> {
  return groups.map((group) => {
    const runtime = ensureRuntimeState(runtimeMap, group.groupId, settings);
    const cache = cacheMap[group.groupId];

    if (cache) {
      runtime.unreadCount = calcUnreadCount(cache.mixedVideos, runtime.lastReadAt);
    }

    return {
      groupId: group.groupId,
      title: getGroupTitle(group),
      unreadCount: runtime.unreadCount,
      lastRefreshAt: runtime.lastRefreshAt,
      enabled: group.enabled
    };
  });
}

export function removeGroupState(groupId: string, runtimeMap: RuntimeMap, cacheMap: CacheMap): void {
  delete runtimeMap[groupId];
  delete cacheMap[groupId];
}

export function isMixedMode(mode: ViewMode): boolean {
  return mode === 'mixed';
}

export function isStaleForAutoRefresh(
  groupId: string,
  settings: ExtensionSettings,
  runtimeMap: RuntimeMap
): boolean {
  return shouldRefresh(runtimeMap[groupId], settings);
}
