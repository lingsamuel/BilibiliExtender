import { MIXED_LOAD_INCREMENT, VIRTUAL_GROUP_ID } from '@/shared/constants';
import {
  getUploaderVideos,
  getUserCard,
  getAllFavVideos,
  type ApiRequestTracker,
  type FavMediaItem
} from '@/shared/api/bilibili';
import { normalizeDefaultReadMarkDays } from '@/shared/utils/settings';
import { getRecentDaysBoundaryTs, isWithinRecentDays } from '@/shared/utils/time';
import type {
  AllPostsFilterKey,
  AuthorPreference,
  AuthorFeed,
  AuthorVideoBlock,
  AuthorVideoCache,
  AuthorVideoVersionFingerprint,
  ExtensionSettings,
  GroupConfig,
  GroupFeedCache,
  GroupFeedResult,
  GroupReadMark,
  GroupRuntimeState,
  GroupSummary,
  GroupSyncStatus,
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

function buildVersionKey(version: AuthorVideoVersionFingerprint | undefined): string {
  if (!version) {
    return '';
  }
  const tagKey = version.tagCounts
    .map((item) => `${item.tid}:${item.count}`)
    .join('|');
  return `${version.totalCount}#${tagKey}`;
}

function isSameVersion(
  left: AuthorVideoVersionFingerprint | undefined,
  right: AuthorVideoVersionFingerprint | undefined
): boolean {
  return buildVersionKey(left) !== '' && buildVersionKey(left) === buildVersionKey(right);
}

function getContinuousVideos(cache: AuthorVideoCache | undefined): VideoItem[] {
  if (!cache) {
    return [];
  }
  if (Array.isArray(cache.continuousVideos) && cache.continuousVideos.length > 0) {
    return cache.continuousVideos;
  }
  return Array.isArray(cache.videos) ? cache.videos : [];
}

function getLatestKnownTotalCount(cache: AuthorVideoCache | undefined): number | undefined {
  if (!cache) {
    return undefined;
  }
  const candidates = [
    cache.latestKnownTotalCount,
    cache.latestKnownVersion?.totalCount,
    cache.continuousVersion?.totalCount,
    cache.totalCount
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      return Math.floor(candidate);
    }
  }
  return undefined;
}

function getCacheFirstPageFetchedAt(cache: AuthorVideoCache | undefined): number | undefined {
  if (!cache) {
    return undefined;
  }
  return cache.lastFirstPageFetchedAt || cache.firstPageFetchedAt || cache.lastFetchedAt || undefined;
}

function getPageBlock(
  cache: AuthorVideoCache | undefined,
  pn: number,
  ps: number
): AuthorVideoBlock | undefined {
  if (!cache?.blocks?.length) {
    return undefined;
  }
  return cache.blocks
    .filter((block) => block.pageNum === pn && block.pageSize === ps)
    .sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
}

function getCachedAuthorPageFetchedAt(
  cache: AuthorVideoCache | undefined,
  pn: number,
  ps: number
): number | undefined {
  const exactBlock = getPageBlock(cache, pn, ps);
  if (exactBlock) {
    return exactBlock.fetchedAt;
  }
  if (pn === 1) {
    return getCacheFirstPageFetchedAt(cache);
  }
  return undefined;
}

function getAuthorMaxPage(cache: AuthorVideoCache | undefined, pageSize: number): number | undefined {
  const totalCount = getLatestKnownTotalCount(cache);
  if (totalCount === undefined) {
    return undefined;
  }
  return resolveMaxPageByCount(totalCount, pageSize) ?? undefined;
}

function getPreferredAuthorPageSize(
  cache: AuthorVideoCache | undefined,
  fallbackPageSize: number
): number {
  const firstPageBlock = cache?.blocks
    ?.filter((block) => block.pageNum === 1)
    .sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
  return Math.max(1, firstPageBlock?.pageSize || cache?.apiPageSize || fallbackPageSize);
}

function normalizeBlockVersion(
  version: AuthorVideoVersionFingerprint
): AuthorVideoVersionFingerprint {
  return {
    totalCount: Math.max(0, Math.floor(version.totalCount)),
    tagCounts: version.tagCounts
      .map((item) => ({
        tid: Math.max(0, Math.floor(item.tid)),
        count: Math.max(0, Math.floor(item.count))
      }))
      .sort((a, b) => a.tid - b.tid)
  };
}

function createAuthorVideoBlock(
  pageNum: number,
  pageSize: number,
  fetchedAt: number,
  version: AuthorVideoVersionFingerprint,
  videos: VideoItem[]
): AuthorVideoBlock {
  const normalizedPageNum = Math.max(1, Math.floor(pageNum));
  const normalizedPageSize = Math.max(1, Math.floor(pageSize));
  const normalizedVideos = videos.map((video) => withVideoMeta(video, normalizedPageNum, fetchedAt));
  const startIndex = Math.max(0, (normalizedPageNum - 1) * normalizedPageSize);
  return {
    pageNum: normalizedPageNum,
    pageSize: normalizedPageSize,
    startIndex,
    endExclusive: startIndex + normalizedVideos.length,
    fetchedAt,
    version: normalizeBlockVersion(version),
    videos: normalizedVideos
  };
}

function trimBlocksByCapacity(blocks: AuthorVideoBlock[], maxItems: number): AuthorVideoBlock[] {
  const limit = Math.max(1, maxItems);
  const byFreshness = [...blocks].sort((a, b) => b.fetchedAt - a.fetchedAt);
  const kept: AuthorVideoBlock[] = [];
  let currentItems = 0;
  for (const block of byFreshness) {
    const nextItems = currentItems + block.videos.length;
    if (kept.length > 0 && nextItems > limit) {
      continue;
    }
    kept.push(block);
    currentItems = nextItems;
  }
  return kept.sort((a, b) => {
    if (a.startIndex !== b.startIndex) {
      return a.startIndex - b.startIndex;
    }
    return b.fetchedAt - a.fetchedAt;
  });
}

function mergeBlocks(
  existingBlocks: AuthorVideoBlock[],
  incomingBlock: AuthorVideoBlock,
  settings: Pick<ExtensionSettings, 'authorVideosPageSize' | 'authorNonContinuousCachePageCount'>
): AuthorVideoBlock[] {
  const next = [
    incomingBlock,
    ...existingBlocks.filter((block) => !(block.pageNum === incomingBlock.pageNum && block.pageSize === incomingBlock.pageSize))
  ];
  const maxItems = Math.max(1, settings.authorVideosPageSize)
    * Math.max(1, settings.authorNonContinuousCachePageCount);
  return trimBlocksByCapacity(next, maxItems);
}

function appendOlderVideos(baseVideos: VideoItem[], extraVideos: VideoItem[]): VideoItem[] {
  if (extraVideos.length === 0) {
    return baseVideos;
  }
  const seen = new Set(baseVideos.map((video) => video.bvid));
  const appended: VideoItem[] = [];
  for (const video of extraVideos) {
    if (seen.has(video.bvid)) {
      continue;
    }
    seen.add(video.bvid);
    appended.push(video);
  }
  return [...baseVideos, ...appended].sort((a, b) => b.pubdate - a.pubdate);
}

function stitchVideoSequences(
  headVideos: VideoItem[],
  tailVideos: VideoItem[],
  options?: { allowIntervalFallback?: boolean }
): VideoItem[] | null {
  if (headVideos.length === 0) {
    return tailVideos.slice();
  }
  if (tailVideos.length === 0) {
    return headVideos.slice();
  }

  const tailIndexByBvid = new Map<string, number>();
  tailVideos.forEach((video, index) => {
    tailIndexByBvid.set(video.bvid, index);
  });

  // 优先使用相同 bvid 作为强锚点验证顺序。
  for (let headIndex = 0; headIndex < headVideos.length; headIndex++) {
    const tailStartIndex = tailIndexByBvid.get(headVideos[headIndex].bvid);
    if (tailStartIndex === undefined) {
      continue;
    }

    let matched = 0;
    while (
      headIndex + matched < headVideos.length &&
      tailStartIndex + matched < tailVideos.length &&
      headVideos[headIndex + matched].bvid === tailVideos[tailStartIndex + matched].bvid
    ) {
      matched++;
    }

    if (matched === 0) {
      continue;
    }

    if (headIndex + matched === headVideos.length) {
      return appendOlderVideos(headVideos, tailVideos.slice(tailStartIndex + matched));
    }
  }

  // 其次允许时间戳交叉，把它视为块确实触碰到了同一段时间区间。
  const headOldest = headVideos[headVideos.length - 1];
  const tailNewest = tailVideos[0];
  if (headOldest && tailNewest && tailNewest.pubdate <= headOldest.pubdate) {
    return mergeVideos(headVideos, tailVideos);
  }

  if (options?.allowIntervalFallback) {
    return appendOlderVideos(headVideos, tailVideos);
  }

  return null;
}

export function canReconnectContinuousHead(
  headVideos: VideoItem[],
  tailVideos: VideoItem[]
): boolean {
  if (tailVideos.length === 0) {
    return true;
  }
  return stitchVideoSequences(headVideos, tailVideos, { allowIntervalFallback: false }) !== null;
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
  cache: Pick<
    AuthorVideoCache,
    'continuousVideos' | 'latestKnownTotalCount' | 'latestKnownVersion' | 'totalCount' | 'videos' | 'hasMore'
  >
): boolean {
  const totalCount = getLatestKnownTotalCount(cache as AuthorVideoCache);
  if (totalCount !== undefined) {
    return getContinuousVideos(cache as AuthorVideoCache).length < totalCount;
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

  const firstPageFetchedAt = getCacheFirstPageFetchedAt(cache);
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
  settings: Pick<
    ExtensionSettings,
    'authorVideosPageSize' | 'authorContinuousExtraPageCount' | 'authorNonContinuousCachePageCount'
  >,
  options?: { pn?: number; ps?: number; fetchCard?: boolean; requestTracker?: ApiRequestTracker }
): Promise<AuthorVideoCache> {
  const existing = authorCacheMap[mid];
  const pn = Math.max(1, options?.pn ?? 1);
  const ps = Math.max(1, options?.ps ?? settings.authorVideosPageSize);
  const fetchCard = options?.fetchCard !== false;
  const pageFetchedAt = Date.now();
  const { videos, totalCount, pageSize, version } = await getUploaderVideos(mid, pn, ps, {
    requestTracker: options?.requestTracker
  });
  const nextTotalCount = Number.isFinite(totalCount) && totalCount >= 0
    ? Math.floor(totalCount)
    : getLatestKnownTotalCount(existing);
  const normalizedVersion = normalizeBlockVersion({
    ...version,
    totalCount: nextTotalCount ?? version.totalCount
  });
  const incomingBlock = createAuthorVideoBlock(pn, pageSize, pageFetchedAt, normalizedVersion, videos);

  const existingHasCardSnapshot = hasCardSnapshot(existing);
  let cardName: string | undefined;
  let cardFace: string | undefined;
  let cardFollower: number | undefined;
  let cardFollowing: boolean | undefined;

  if (fetchCard) {
    try {
      const card = await getUserCard(mid, options?.requestTracker);
      cardName = card.name?.trim() || undefined;
      cardFace = card.face;
      cardFollower = card.follower;
      cardFollowing = card.following;
    } catch {
      // Card 请求失败时按降级策略处理：
      // - 若已有 Card 缓存，继续沿用缓存；
      // - 若无 Card 缓存，允许回退视频接口作者名兜底展示。
    }
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
  const nextBlocks = mergeBlocks(existing?.blocks ?? [], incomingBlock, settings);
  const desiredContinuousLength = Math.max(
    settings.authorVideosPageSize,
    (2 + Math.max(1, settings.authorContinuousExtraPageCount)) * settings.authorVideosPageSize
  );

  const sameVersionBlocks = nextBlocks
    .filter((block) => isSameVersion(block.version, normalizedVersion))
    .sort((a, b) => {
      if (a.startIndex !== b.startIndex) {
        return a.startIndex - b.startIndex;
      }
      return b.fetchedAt - a.fetchedAt;
    });

  let rebuiltContinuous: VideoItem[] = [];
  for (const candidate of sameVersionBlocks) {
    if (rebuiltContinuous.length === 0) {
      if (candidate.startIndex === 0) {
        rebuiltContinuous = candidate.videos.slice();
      }
      continue;
    }

    const stitched = stitchVideoSequences(rebuiltContinuous, candidate.videos, {
      allowIntervalFallback: candidate.startIndex <= rebuiltContinuous.length
    });
    if (stitched && stitched.length >= rebuiltContinuous.length) {
      rebuiltContinuous = stitched;
    }
    if (rebuiltContinuous.length >= desiredContinuousLength) {
      break;
    }
  }

  const oldContinuous = getContinuousVideos(existing);
  if (!isSameVersion(existing?.continuousVersion, normalizedVersion) && rebuiltContinuous.length > 0 && oldContinuous.length > 0) {
    const bridged = stitchVideoSequences(rebuiltContinuous, oldContinuous, { allowIntervalFallback: false });
    if (bridged && bridged.length >= rebuiltContinuous.length) {
      rebuiltContinuous = bridged;
    }
  }

  if (rebuiltContinuous.length === 0 && oldContinuous.length > 0) {
    rebuiltContinuous = oldContinuous.slice();
  }

  rebuiltContinuous = rebuiltContinuous.slice(0, desiredContinuousLength);

  const cache: AuthorVideoCache = {
    mid,
    name: resolvedName,
    face: resolvedFace,
    follower: resolvedFollower,
    following: resolvedFollowing,
    faceFetchedAt: resolvedFace ? Date.now() : existing?.faceFetchedAt,
    continuousVideos: rebuiltContinuous,
    continuousVersion: rebuiltContinuous.length > 0 ? normalizedVersion : existing?.continuousVersion,
    continuousUpdatedAt: pageFetchedAt,
    blocks: nextBlocks,
    latestKnownVersion: normalizedVersion,
    latestKnownTotalCount: nextTotalCount,
    lastFirstPageFetchedAt: pn === 1
      ? pageFetchedAt
      : (existing?.lastFirstPageFetchedAt || existing?.firstPageFetchedAt || pageFetchedAt),
    lastFetchedAt: pageFetchedAt
  };

  authorCacheMap[mid] = cache;
  return cache;
}

export function getCachedAuthorPageVideos(
  cache: AuthorVideoCache | undefined,
  pn: number,
  ps: number
): VideoItem[] {
  const exactBlock = getPageBlock(cache, pn, ps);
  if (exactBlock) {
    return exactBlock.videos.slice();
  }
  if (pn === 1) {
    return getContinuousVideos(cache).slice(0, Math.max(1, ps));
  }
  return [];
}

export function getAuthorPageCount(
  cache: AuthorVideoCache | undefined,
  ps: number
): number | undefined {
  return getAuthorMaxPage(cache, ps);
}

function getCachedAuthorMeta(
  cache: AuthorVideoCache | undefined
): { name: string; face?: string } | undefined {
  if (!cache) {
    return undefined;
  }

  const name = cache.name?.trim() || '';
  if (!name && !cache.face) {
    return undefined;
  }

  return {
    name,
    face: cache.face
  };
}

export function getCachedAuthorPageSnapshot(
  cache: AuthorVideoCache | undefined,
  pn: number,
  ps: number
): { videos: VideoItem[]; fetchedAt?: number } {
  const meta = getCachedAuthorMeta(cache);
  return {
    videos: getCachedAuthorPageVideos(cache, pn, ps).map((video) => injectAuthorMetaIntoVideo(video, meta)),
    fetchedAt: getCachedAuthorPageFetchedAt(cache, pn, ps)
  };
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
  const isAllGroup = groupId === VIRTUAL_GROUP_ID.ALL;
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
  if (!isAllGroup && !runtimeMap[groupId].savedRecentDays) {
    runtimeMap[groupId].savedRecentDays = normalizeRecentDays(settings.defaultReadMarkDays);
  }
  if (!runtimeMap[groupId].savedAllPostsFilter) {
    runtimeMap[groupId].savedAllPostsFilter = DEFAULT_ALL_POSTS_FILTER;
  }

  return runtimeMap[groupId];
}

function normalizeRecentDays(value: number | undefined): number {
  return normalizeDefaultReadMarkDays(value);
}

function normalizeAllPostsFilter(value: AllPostsFilterKey | undefined): AllPostsFilterKey {
  if (value === 'd7' || value === 'd14' || value === 'd30' || value === 'n10' || value === 'n30') {
    return value;
  }
  return 'all';
}

/**
 * 最近 N 天基线使用排除性边界：
 * - `pubdate > baselineTs` 仍算命中 N 天窗口；
 * - 这样可把 “N天内” 统一成 “N天23小时59分钟” 这一档内都算命中。
 */
function getRecentDaysBaselineTs(recentDays: number): number {
  return getRecentDaysBoundaryTs(normalizeRecentDays(recentDays));
}

interface TrackingLowerBound {
  ts: number;
  inclusive: boolean;
}

function buildReadMarkLowerBound(ts: number): TrackingLowerBound {
  return {
    ts,
    inclusive: true
  };
}

function buildRecentDaysLowerBound(recentDays: number): TrackingLowerBound {
  return {
    ts: getRecentDaysBaselineTs(recentDays),
    inclusive: false
  };
}

function isWithinTrackingLowerBound(pubdate: number, lowerBound: TrackingLowerBound): boolean {
  if (lowerBound.inclusive) {
    return pubdate >= lowerBound.ts;
  }
  return pubdate > lowerBound.ts;
}

function isFreshByFirstPageFetchedAt(
  fetchedAt: number | undefined,
  settings: ExtensionSettings
): boolean {
  if (!fetchedAt || fetchedAt <= 0) {
    return false;
  }
  return Date.now() - fetchedAt <= settings.refreshIntervalMinutes * 60 * 1000;
}

export function buildGroupSyncStatus(
  authorMids: number[],
  authorCacheMap: AuthorCacheMap,
  settings: ExtensionSettings
): GroupSyncStatus {
  let staleAuthors = 0;
  let oldestFreshFetchedAt: number | undefined;

  for (const mid of authorMids) {
    const cache = authorCacheMap[mid];
    const fetchedAt = getCacheFirstPageFetchedAt(cache);
    if (!isFreshByFirstPageFetchedAt(fetchedAt, settings)) {
      staleAuthors++;
      continue;
    }

    if (typeof fetchedAt === 'number' && (!oldestFreshFetchedAt || fetchedAt < oldestFreshFetchedAt)) {
      oldestFreshFetchedAt = fetchedAt;
    }
  }

  return {
    totalAuthors: authorMids.length,
    staleAuthors,
    oldestFreshFetchedAt
  };
}

function collectReadMarkTimestamps(groupId: string, readMarks: ReadMarkMap): number[] {
  const timestamps = readMarks[groupId]?.timestamps ?? [];
  // 这里必须保留“最近一次写入在前”的栈顺序：
  // 用户重新选择更早的时间点时，会把该时间点移回栈顶；
  // 若按数值重新排序，会破坏撤销语义，并导致前端误判“当前最新时间点”。
  return [...timestamps];
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
  savedReadMarkTs: number | undefined,
  recentDays: number
): number {
  if (savedReadMarkTs && savedReadMarkTs > 0) {
    return savedReadMarkTs;
  }
  return getRecentDaysBaselineTs(recentDays);
}

function resolveGroupTrackingLowerBound(
  savedReadMarkTs: number | undefined,
  recentDays: number
): TrackingLowerBound {
  if (savedReadMarkTs && savedReadMarkTs > 0) {
    return buildReadMarkLowerBound(savedReadMarkTs);
  }
  return buildRecentDaysLowerBound(recentDays);
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

function resolveAuthorTrackingLowerBound(
  mid: number,
  groupReadMarkTs: number | undefined,
  recentDays: number,
  authorPreferences: AuthorPreferenceMap
): TrackingLowerBound {
  const pref = authorPreferences[mid];
  if (pref?.readMarkTs && pref.readMarkTs > 0) {
    return buildReadMarkLowerBound(pref.readMarkTs);
  }
  return resolveGroupTrackingLowerBound(groupReadMarkTs, recentDays);
}

/**
 * 时间流模式的可见下界：
 * - 不再按已阅时间做“硬截断”；
 * - 至少保留当前近期预设对应的窗口；
 * - 当用户显式选择了更早的已阅点时，向更旧数据延展。
 */
function resolveMixedVisibleLowerBoundTs(
  savedReadMarkTs: number | undefined,
  recentDays: number
): TrackingLowerBound {
  const recentLowerBound = buildRecentDaysLowerBound(recentDays);
  if (!savedReadMarkTs || savedReadMarkTs <= 0) {
    return recentLowerBound;
  }
  if (savedReadMarkTs <= recentLowerBound.ts) {
    return buildReadMarkLowerBound(savedReadMarkTs);
  }
  return recentLowerBound;
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
    const videos = getContinuousVideos(authorCacheMap[mid]);
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
    for (const video of getContinuousVideos(cache)) {
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
    const scoped = applyOverviewFilterForAuthor(getContinuousVideos(cache), allPostsFilter);
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
      const videoName = getContinuousVideos(cache).find((video) => video.authorName?.trim())?.authorName?.trim();
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
    const recentDays = normalizeRecentDays(runtime?.savedRecentDays ?? settings.defaultReadMarkDays);
    const groupBaselineTs = resolveGroupRecentBaselineTs(runtime?.savedReadMarkTs, recentDays);

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
    const videos = getContinuousVideos(authorCacheMap[mid]);
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
    const scoped = videos.filter((video) => isWithinRecentDays(video.pubdate, days));
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
  groupReadMarkTs: number | undefined,
  recentDays: number,
  allPostsFilter: AllPostsFilterKey,
  authorPreferences: AuthorPreferenceMap
): boolean {
  const cache = authorCacheMap[mid];
  if (!cache || !hasAuthorMorePages(cache)) {
    return false;
  }

  if (allPostsFilter === 'all') {
    const lowerBound = resolveAuthorMixedLowerBoundTs(mid, groupReadMarkTs, recentDays, authorPreferences);
    const continuousVideos = getContinuousVideos(cache);
    const oldestCached = continuousVideos[continuousVideos.length - 1];
    if (!oldestCached) {
      return true;
    }
    // 已经把缓存拉到可见下界之外时，继续翻页不会再贡献当前时间流可见数据。
    return isWithinTrackingLowerBound(oldestCached.pubdate, lowerBound);
  }

  const overviewDays = resolveAllPostsDays(allPostsFilter);
  if (overviewDays !== null) {
    const lowerBound = getRecentDaysBaselineTs(overviewDays);
    const continuousVideos = getContinuousVideos(cache);
    const oldestCached = continuousVideos[continuousVideos.length - 1];
    if (!oldestCached) {
      return true;
    }
    return oldestCached.pubdate > lowerBound;
  }

  const perAuthorCount = resolveAllPostsPerAuthorCount(allPostsFilter);
  if (perAuthorCount !== null) {
    return getContinuousVideos(cache).length < perAuthorCount;
  }

  return true;
}

function filterAuthorVideosByTracking(
  videos: VideoItem[],
  lowerBound: TrackingLowerBound,
  extraCount: number
): VideoItem[] {
  const newVideos = videos.filter((video) => isWithinTrackingLowerBound(video.pubdate, lowerBound));
  const olderVideos = videos.filter((video) => !isWithinTrackingLowerBound(video.pubdate, lowerBound)).slice(0, extraCount);
  return [...newVideos, ...olderVideos];
}

function resolveAuthorMixedLowerBoundTs(
  mid: number,
  groupReadMarkTs: number | undefined,
  recentDays: number,
  authorPreferences: AuthorPreferenceMap
): TrackingLowerBound {
  const pref = authorPreferences[mid];
  const authorReadMarkTs = pref?.readMarkTs && pref.readMarkTs > 0 ? pref.readMarkTs : 0;
  const recentLowerBound = buildRecentDaysLowerBound(recentDays);
  if (authorReadMarkTs > 0) {
    if (authorReadMarkTs <= recentLowerBound.ts) {
      return buildReadMarkLowerBound(authorReadMarkTs);
    }
    return recentLowerBound;
  }
  return resolveMixedVisibleLowerBoundTs(groupReadMarkTs, recentDays);
}

function filterMixedVideosByTracking(
  videos: VideoItem[],
  groupReadMarkTs: number | undefined,
  recentDays: number,
  showAllForMixed: boolean,
  authorPreferences: AuthorPreferenceMap
): VideoItem[] {
  if (showAllForMixed) {
    return videos;
  }

  return videos.filter((video) => {
    const lowerBound = resolveAuthorMixedLowerBoundTs(video.authorMid, groupReadMarkTs, recentDays, authorPreferences);
    return isWithinTrackingLowerBound(video.pubdate, lowerBound);
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

function normalizeManualAuthorOrder(authorMids: number[] | undefined): number[] {
  if (!Array.isArray(authorMids)) {
    return [];
  }

  const deduped: number[] = [];
  const seen = new Set<number>();
  for (const rawMid of authorMids) {
    const mid = Math.max(1, Number(rawMid) || 0);
    if (!mid || seen.has(mid)) {
      continue;
    }
    seen.add(mid);
    deduped.push(mid);
  }
  return deduped;
}

function composeManualAuthorOrder(baseAuthorMids: number[], manualOrderMids: number[] | undefined): number[] {
  const normalizedManualOrder = normalizeManualAuthorOrder(manualOrderMids);
  if (normalizedManualOrder.length === 0) {
    return [...baseAuthorMids];
  }

  const currentAuthorSet = new Set(baseAuthorMids);
  const ordered: number[] = [];
  const seen = new Set<number>();

  for (const mid of normalizedManualOrder) {
    if (!currentAuthorSet.has(mid) || seen.has(mid)) {
      continue;
    }
    seen.add(mid);
    ordered.push(mid);
  }

  for (const mid of baseAuthorMids) {
    if (seen.has(mid)) {
      continue;
    }
    seen.add(mid);
    ordered.push(mid);
  }

  return ordered;
}

export interface MixedUsedPageItem {
  mid: number;
  usedMaxPn: number;
}

export interface MixedBoundaryTask {
  mid: number;
  name: string;
  pn: number;
  ps: number;
}

export interface MixedBuildDiagnostics {
  usedPages: MixedUsedPageItem[];
  boundaryTasks: MixedBoundaryTask[];
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
  recentDays: number,
  activeReadMarkTs: number | undefined,
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

  const authorMids = composeManualAuthorOrder(feedCache.authorMids, runtime.manualAuthorOrderMids);
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
  const isAllGroup = group.groupId === VIRTUAL_GROUP_ID.ALL;
  const normalizedRecentDays = normalizeRecentDays(recentDays);
  const normalizedActiveReadMarkTs = activeReadMarkTs && activeReadMarkTs > 0 ? activeReadMarkTs : undefined;
  const normalizedAllPostsFilter = normalizeAllPostsFilter(allPostsFilter);
  const trackingGroupBaselineTs = resolveGroupRecentBaselineTs(normalizedActiveReadMarkTs, normalizedRecentDays);
  const effectiveAllPostsFilter: AllPostsFilterKey = mode === 'overview' ? normalizedAllPostsFilter : 'all';

  const byAuthorSortEnabled = byAuthorSortByLatest ?? runtime.savedByAuthorSortByLatest ?? DEFAULT_BY_AUTHOR_SORT_BY_LATEST;
  let videosByAuthor: AuthorFeed[] = authorMids.map((mid) => {
    const cache = authorCacheMap[mid];
    const allVideos = getContinuousVideos(cache);
    const overviewSelection = selectOverviewVideosForAuthor(allVideos, effectiveAllPostsFilter);
    const pref = authorPreferences[mid];
    const hasAuthorReadMarkOverride = Boolean(pref?.readMarkTs && pref.readMarkTs > 0);
    const authorTrackingLowerBound = resolveAuthorTrackingLowerBound(
      mid,
      normalizedActiveReadMarkTs,
      normalizedRecentDays,
      authorPreferences
    );
    const authorBoundaryTs = resolveAuthorUnreadBaselineTs(mid, trackingGroupBaselineTs, authorPreferences);
    const videos =
      mode === 'byAuthor'
        ? filterAuthorVideosByTracking(allVideos, authorTrackingLowerBound, settings.extraOlderVideoCount)
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
      beforeVideoBvid: pref?.beforeVideoBvid,
      afterVideoBvid: pref?.afterVideoBvid,
      totalVideoCount: getLatestKnownTotalCount(cache),
      apiPageSize: getPreferredAuthorPageSize(cache, settings.authorVideosPageSize),
      videos: videos.map((video) => injectAuthorMetaIntoVideo(video, meta)),
      hasOnlyExtraOlderVideos:
        mode === 'byAuthor' &&
        authorBoundaryTs > 0 &&
        videos.length > 0 &&
        videos.every((video) => !isWithinTrackingLowerBound(video.pubdate, authorTrackingLowerBound)),
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
          normalizedActiveReadMarkTs,
          normalizedRecentDays,
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
    const selectedMapByAuthor = new Map<number, Set<string>>();

    for (const video of mixedVideos) {
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
        getContinuousVideos(cache),
        normalizedActiveReadMarkTs,
        normalizedRecentDays,
        showAllForMixed,
        authorPreferences
      );
      if (filteredByReadMark.length === 0) {
        continue;
      }

      const mixedLowerBound = resolveAuthorMixedLowerBoundTs(
        mid,
        normalizedActiveReadMarkTs,
        normalizedRecentDays,
        authorPreferences
      );
      const continuousVideos = getContinuousVideos(cache);
      const oldestCached = continuousVideos[continuousVideos.length - 1];
      // 已经跨过时间流可见下界时，不再向更旧分页推进，避免在已阅过滤场景下无限深翻页。
      if (oldestCached && !isWithinTrackingLowerBound(oldestCached.pubdate, mixedLowerBound)) {
        continue;
      }

      const oldest = filteredByReadMark[filteredByReadMark.length - 1];
      if (!selectedSet.has(oldest.bvid)) {
        continue;
      }

      const pageSize = getPreferredAuthorPageSize(cache, settings.authorVideosPageSize);
      const nextStartIndex = continuousVideos.length;
      const pn = Math.max(2, Math.floor(nextStartIndex / pageSize) + 1);
      const key = `${mid}:${pn}:${pageSize}`;
      boundaryTaskMap.set(key, {
        mid,
        name: cache.name?.trim() || String(mid),
        pn,
        ps: pageSize
      });
    }

    diagnostics.usedPages = [];
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
  if (mode !== 'overview' && !isAllGroup) {
    runtime.savedReadMarkTs = normalizedActiveReadMarkTs;
    runtime.savedRecentDays = normalizedRecentDays;
  } else if (isAllGroup) {
    runtime.savedReadMarkTs = undefined;
    runtime.savedRecentDays = undefined;
  }
  runtime.savedAllPostsFilter = normalizedAllPostsFilter;
  runtime.savedByAuthorSortByLatest = byAuthorSortEnabled;

  const hasMoreForMixed = mixedTotalBeforeLimit > mixedVideos.length
    || authorMids.some((mid) => hasAuthorPotentialMoreForMixed(
      mid,
      authorCacheMap,
      normalizedActiveReadMarkTs,
      normalizedRecentDays,
      effectiveAllPostsFilter,
      authorPreferences
    ));

  const result: GroupFeedResult = {
    groupId: group.groupId,
    mode,
    mixedVideos,
    videosByAuthor,
    syncStatus: buildGroupSyncStatus(authorMids, authorCacheMap, settings),
    lastRefreshAt: runtime.lastRefreshAt,
    lastReadAt: runtime.lastReadAt,
    unreadCount: runtime.unreadCount,
    hasMoreForMixed,
    readMarkTimestamps: isAllGroup ? [] : readMarkTimestamps,
    graceReadMarkTs: getRecentDaysBaselineTs(normalizedRecentDays),
    byAuthorPageSize: settings.authorVideosPageSize
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
  summaries: GroupSummary[];
  totalUnreadCount: number;
} {
  const summaries = groups.map((group) => {
    const runtime = ensureRuntimeState(runtimeMap, group.groupId, settings);
    const feedCache = feedCacheMap[group.groupId];
    const authorMids = feedCache?.authorMids ?? [];
    let unreadCount = 0;

    if (feedCache) {
      const recentDays = normalizeRecentDays(runtime.savedRecentDays ?? settings.defaultReadMarkDays);
      const groupBaselineTs = resolveGroupRecentBaselineTs(runtime.savedReadMarkTs, recentDays);
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
      excludeFromUnreadCount: group.excludeFromUnreadCount === true,
      syncStatus: buildGroupSyncStatus(authorMids, authorCacheMap, settings),
      lastRefreshAt: runtime.lastRefreshAt,
      enabled: group.enabled,
      savedMode: runtime.savedMode,
      savedReadMarkTs: runtime.savedReadMarkTs,
      savedRecentDays: runtime.savedRecentDays,
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
