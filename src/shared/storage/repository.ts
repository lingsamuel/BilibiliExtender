import { DEFAULT_SETTINGS, MAX_READ_MARK_COUNT, STORAGE_KEYS } from '@/shared/constants';
import { ext, type StorageAreaLike } from '@/shared/platform/webext';
import type { SchedulerTaskReason, SchedulerTaskTrigger } from '@/shared/messages';
import type {
  AuthorPreference,
  AuthorVideoCache,
  ExtensionSettings,
  GroupConfig,
  GroupFeedCache,
  GroupReadMark,
  GroupRuntimeState,
  VideoItem
} from '@/shared/types';

type RuntimeStateMap = Record<string, GroupRuntimeState>;
type FeedCacheMap = Record<string, GroupFeedCache>;
type AuthorVideoCacheMap = Record<number, AuthorVideoCache>;
type AuthorPreferenceMap = Record<number, AuthorPreference>;
type SchedulerHistoryEntry = {
  channel: 'author-video' | 'group-fav';
  mid?: number;
  groupId?: string;
  pn?: number;
  name: string;
  success: boolean;
  timestamp: number;
  error?: string;
  mode: 'regular' | 'burst';
  taskReason: SchedulerTaskReason;
  trigger: SchedulerTaskTrigger;
};

/**
 * 进程内缓存：
 * - Service Worker 存活期间优先命中内存，减少频繁 storage I/O。
 * - Service Worker 被浏览器回收后，缓存自然失效并在下次请求时重新加载。
 */
const memoryCache: {
  settings?: ExtensionSettings;
  groups?: GroupConfig[];
  runtime?: RuntimeStateMap;
  feed?: FeedCacheMap;
  authorVideo?: AuthorVideoCacheMap;
  lastGroupId?: string;
  hasLastGroupId: boolean;
  groupReadMarks?: Record<string, GroupReadMark>;
  clickedVideos?: Record<string, number>;
  videoReviewedOverrides?: Record<string, boolean>;
  authorPreferences?: AuthorPreferenceMap;
  schedulerHistory?: SchedulerHistoryEntry[];
} = {
  hasLastGroupId: false
};

async function storageGet<T>(
  area: StorageAreaLike,
  key: string,
  fallback: T
): Promise<T> {
  const result = await area.get(key);
  return (result[key] as T | undefined) ?? fallback;
}

async function storageSet(area: StorageAreaLike, key: string, value: unknown): Promise<void> {
  await area.set({ [key]: value });
}

async function getSettings(): Promise<ExtensionSettings> {
  if (memoryCache.settings) {
    return memoryCache.settings;
  }

  const settings = await storageGet(ext.storage.local, STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);
  const merged = {
    ...DEFAULT_SETTINGS,
    ...settings
  };
  memoryCache.settings = merged;
  return merged;
}

async function setSettings(settings: ExtensionSettings): Promise<void> {
  memoryCache.settings = settings;
  await storageSet(ext.storage.local, STORAGE_KEYS.SETTINGS, settings);
}

async function getGroupsStorageArea(): Promise<StorageAreaLike> {
  const settings = await getSettings();
  return settings.useStorageSync ? ext.storage.sync : ext.storage.local;
}

/**
 * 读取分组配置：按设置优先从 sync 读取，失败时自动回退 local。
 */
export async function loadGroups(): Promise<GroupConfig[]> {
  if (memoryCache.groups) {
    return memoryCache.groups;
  }

  const area = await getGroupsStorageArea();
  const key = area === ext.storage.sync ? STORAGE_KEYS.GROUPS_SYNC : STORAGE_KEYS.GROUPS_LOCAL;

  try {
    const groups = await storageGet(area, key, [] as GroupConfig[]);
    memoryCache.groups = groups;
    return groups;
  } catch (error) {
    // sync 读取失败时回退 local，避免配置不可用。
    console.warn('[BBE] loadGroups from preferred area failed, fallback to local:', error);
    const groups = await storageGet(ext.storage.local, STORAGE_KEYS.GROUPS_LOCAL, [] as GroupConfig[]);
    memoryCache.groups = groups;
    return groups;
  }
}

/**
 * 写入分组配置：sync 超配额时自动切换到 local 并关闭 useStorageSync。
 */
export async function saveGroups(groups: GroupConfig[]): Promise<void> {
  memoryCache.groups = groups;
  const settings = await getSettings();
  const preferredArea = settings.useStorageSync ? ext.storage.sync : ext.storage.local;
  const preferredKey = settings.useStorageSync ? STORAGE_KEYS.GROUPS_SYNC : STORAGE_KEYS.GROUPS_LOCAL;

  try {
    await storageSet(preferredArea, preferredKey, groups);
    if (preferredArea === ext.storage.sync) {
      await storageSet(ext.storage.local, STORAGE_KEYS.GROUPS_LOCAL, groups);
    }
  } catch (error) {
    console.warn('[BBE] saveGroups failed in preferred area, fallback to local:', error);
    await storageSet(ext.storage.local, STORAGE_KEYS.GROUPS_LOCAL, groups);

    if (settings.useStorageSync) {
      await setSettings({
        ...settings,
        useStorageSync: false
      });
    }
  }
}

export async function loadSettings(): Promise<ExtensionSettings> {
  return getSettings();
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await setSettings(settings);
}

export async function loadRuntimeStateMap(): Promise<RuntimeStateMap> {
  if (memoryCache.runtime) {
    return memoryCache.runtime;
  }

  const runtime = await storageGet(ext.storage.local, STORAGE_KEYS.RUNTIME, {} as RuntimeStateMap);
  memoryCache.runtime = runtime;
  return runtime;
}

export async function saveRuntimeStateMap(stateMap: RuntimeStateMap): Promise<void> {
  memoryCache.runtime = stateMap;
  await storageSet(ext.storage.local, STORAGE_KEYS.RUNTIME, stateMap);
}

/**
 * 读取分组 feed 缓存，自动丢弃不含 authorMids 的旧格式条目。
 */
export async function loadFeedCacheMap(): Promise<FeedCacheMap> {
  if (memoryCache.feed) {
    return memoryCache.feed;
  }

  const raw = await storageGet(ext.storage.local, STORAGE_KEYS.FEED_CACHE, {} as FeedCacheMap);
  const cleaned: FeedCacheMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value && Array.isArray(value.authorMids)) {
      cleaned[key] = value;
    }
  }
  memoryCache.feed = cleaned;
  return cleaned;
}

export async function saveFeedCacheMap(cacheMap: FeedCacheMap): Promise<void> {
  memoryCache.feed = cacheMap;
  await storageSet(ext.storage.local, STORAGE_KEYS.FEED_CACHE, cacheMap);
}

export async function loadAuthorVideoCacheMap(): Promise<AuthorVideoCacheMap> {
  if (memoryCache.authorVideo) {
    return memoryCache.authorVideo;
  }

  const rawCacheMap = await storageGet(ext.storage.local, STORAGE_KEYS.AUTHOR_VIDEO_CACHE, {} as AuthorVideoCacheMap);
  const normalized: AuthorVideoCacheMap = {};
  const now = Date.now();

  function toPositiveNumber(value: unknown, fallback: number): number {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : fallback;
  }

  function normalizeVideoMeta(video: VideoItem, fallbackFetchedAt: number): VideoItem {
    const sourcePn = Math.max(1, toPositiveNumber(video.meta?.sourcePn, 1));
    const pageFetchedAt = toPositiveNumber(video.meta?.pageFetchedAt, fallbackFetchedAt);
    const updatedAt = toPositiveNumber(video.meta?.updatedAt, pageFetchedAt);
    return {
      ...video,
      meta: {
        updatedAt,
        sourcePn,
        pageFetchedAt
      }
    };
  }

  for (const [rawMid, rawCache] of Object.entries(rawCacheMap)) {
    if (!rawCache || !Array.isArray(rawCache.videos)) {
      continue;
    }

    const mid = Math.max(1, toPositiveNumber(rawCache.mid, Number(rawMid) || 0));
    if (!mid) {
      continue;
    }

    const lastFetchedAt = toPositiveNumber(rawCache.lastFetchedAt, now);
    const firstPageFetchedAt = toPositiveNumber(rawCache.firstPageFetchedAt, lastFetchedAt);
    const normalizedVideos = rawCache.videos.map((video) => normalizeVideoMeta(video, firstPageFetchedAt));

    const pageState: Record<number, { fetchedAt: number; usedInMixed: boolean; lastUsedAt?: number }> = {};
    if (rawCache.pageState && typeof rawCache.pageState === 'object') {
      for (const [rawPn, rawState] of Object.entries(rawCache.pageState)) {
        const pn = Math.max(1, toPositiveNumber(rawPn, 1));
        const fetchedAt = toPositiveNumber((rawState as { fetchedAt?: number }).fetchedAt, firstPageFetchedAt);
        const usedInMixed = Boolean((rawState as { usedInMixed?: boolean }).usedInMixed);
        const lastUsedAtRaw = (rawState as { lastUsedAt?: number }).lastUsedAt;
        const lastUsedAt = typeof lastUsedAtRaw === 'number' && lastUsedAtRaw > 0 ? lastUsedAtRaw : undefined;
        pageState[pn] = { fetchedAt, usedInMixed, lastUsedAt };
      }
    }

    if (!pageState[1]) {
      pageState[1] = { fetchedAt: firstPageFetchedAt, usedInMixed: false };
    }

    for (const video of normalizedVideos) {
      const pn = video.meta?.sourcePn ?? 1;
      if (!pageState[pn]) {
        pageState[pn] = {
          fetchedAt: video.meta?.pageFetchedAt ?? firstPageFetchedAt,
          usedInMixed: false
        };
      }
    }

    const pageNumbers = Object.keys(pageState).map((pn) => Math.max(1, Number(pn) || 1));
    const maxCachedPn = Math.max(1, toPositiveNumber(rawCache.maxCachedPn, pageNumbers.length > 0 ? Math.max(...pageNumbers) : 1));
    const nextPn = Math.max(maxCachedPn + 1, toPositiveNumber(rawCache.nextPn, maxCachedPn + 1));
    const secondPageFetchedAt =
      rawCache.secondPageFetchedAt && rawCache.secondPageFetchedAt > 0
        ? rawCache.secondPageFetchedAt
        : pageState[2]?.fetchedAt;
    const totalCountRaw = Number(rawCache.totalCount);
    const totalCount = Number.isFinite(totalCountRaw) && totalCountRaw >= 0 ? Math.floor(totalCountRaw) : undefined;
    const apiPageSizeRaw = Number(rawCache.apiPageSize);
    const apiPageSize = Number.isFinite(apiPageSizeRaw) && apiPageSizeRaw > 0 ? Math.floor(apiPageSizeRaw) : undefined;

    normalized[mid] = {
      ...rawCache,
      mid,
      videos: normalizedVideos,
      pageState,
      maxCachedPn,
      nextPn,
      hasMore: Boolean(rawCache.hasMore),
      totalCount,
      apiPageSize,
      firstPageFetchedAt,
      secondPageFetchedAt,
      lastFetchedAt
    };
  }

  memoryCache.authorVideo = normalized;
  return normalized;
}

export async function saveAuthorVideoCacheMap(cacheMap: AuthorVideoCacheMap): Promise<void> {
  memoryCache.authorVideo = cacheMap;
  await storageSet(ext.storage.local, STORAGE_KEYS.AUTHOR_VIDEO_CACHE, cacheMap);
}

export async function loadLastGroupId(): Promise<string | undefined> {
  if (memoryCache.hasLastGroupId) {
    return memoryCache.lastGroupId;
  }

  const lastGroupId = await storageGet<string | undefined>(ext.storage.local, STORAGE_KEYS.LAST_GROUP_ID, undefined);
  memoryCache.lastGroupId = lastGroupId;
  memoryCache.hasLastGroupId = true;
  return lastGroupId;
}

export async function saveLastGroupId(groupId: string): Promise<void> {
  memoryCache.lastGroupId = groupId;
  memoryCache.hasLastGroupId = true;
  await storageSet(ext.storage.local, STORAGE_KEYS.LAST_GROUP_ID, groupId);
}

type ReadMarkMap = Record<string, GroupReadMark>;
type ClickedVideoMap = Record<string, number>;
type VideoReviewedOverrideMap = Record<string, boolean>;

let legacyAuthorReadMarksDropped = false;

async function dropLegacyAuthorReadMarksIfNeeded(): Promise<void> {
  if (legacyAuthorReadMarksDropped) {
    return;
  }
  legacyAuthorReadMarksDropped = true;
  await ext.storage.local.remove(STORAGE_KEYS.LEGACY_AUTHOR_READ_MARKS);
}

export async function loadGroupReadMarks(): Promise<ReadMarkMap> {
  if (memoryCache.groupReadMarks) {
    return memoryCache.groupReadMarks;
  }

  await dropLegacyAuthorReadMarksIfNeeded();

  const marks = await storageGet(ext.storage.local, STORAGE_KEYS.GROUP_READ_MARKS, {} as ReadMarkMap);
  memoryCache.groupReadMarks = marks;
  return marks;
}

export async function saveGroupReadMarks(marks: ReadMarkMap): Promise<void> {
  memoryCache.groupReadMarks = marks;
  await storageSet(ext.storage.local, STORAGE_KEYS.GROUP_READ_MARKS, marks);
}

/**
 * 为指定分组追加已阅时间戳，每个分组最多保留 MAX_READ_MARK_COUNT 条。
 * 返回更新后的完整 ReadMarkMap。
 */
export async function appendGroupReadMark(groupId: string, readMarkTs?: number): Promise<ReadMarkMap> {
  const marks = await loadGroupReadMarks();
  const ts = Math.floor(readMarkTs ?? Date.now() / 1000);

  if (!marks[groupId]) {
    marks[groupId] = { groupId, timestamps: [] };
  }

  // 去重后将最新值插入头部，保证下拉列表与“最近一次已阅”语义一致。
  const deduped = marks[groupId].timestamps.filter((item) => item !== ts);
  marks[groupId].timestamps = [ts, ...deduped].slice(0, MAX_READ_MARK_COUNT);

  await saveGroupReadMarks(marks);
  return marks;
}

export async function loadClickedVideos(): Promise<ClickedVideoMap> {
  if (memoryCache.clickedVideos) {
    return memoryCache.clickedVideos;
  }

  const map = await storageGet(ext.storage.local, STORAGE_KEYS.CLICKED_VIDEOS, {} as ClickedVideoMap);
  memoryCache.clickedVideos = map;
  return map;
}

export async function saveClickedVideos(map: ClickedVideoMap): Promise<void> {
  memoryCache.clickedVideos = map;
  await storageSet(ext.storage.local, STORAGE_KEYS.CLICKED_VIDEOS, map);
}

export async function recordVideoClick(bvid: string): Promise<void> {
  const map = await loadClickedVideos();
  map[bvid] = Date.now();
  await saveClickedVideos(map);
}

export async function loadVideoReviewedOverrides(): Promise<VideoReviewedOverrideMap> {
  if (memoryCache.videoReviewedOverrides) {
    return memoryCache.videoReviewedOverrides;
  }

  const map = await storageGet(
    ext.storage.local,
    STORAGE_KEYS.VIDEO_REVIEWED_OVERRIDES,
    {} as VideoReviewedOverrideMap
  );
  memoryCache.videoReviewedOverrides = map;
  return map;
}

export async function saveVideoReviewedOverrides(map: VideoReviewedOverrideMap): Promise<void> {
  memoryCache.videoReviewedOverrides = map;
  await storageSet(ext.storage.local, STORAGE_KEYS.VIDEO_REVIEWED_OVERRIDES, map);
}

export async function setVideoReviewedOverride(bvid: string, reviewed: boolean): Promise<void> {
  const map = await loadVideoReviewedOverrides();
  map[bvid] = reviewed;
  await saveVideoReviewedOverrides(map);
}

export async function loadAuthorPreferences(): Promise<AuthorPreferenceMap> {
  if (memoryCache.authorPreferences) {
    return memoryCache.authorPreferences;
  }

  const map = await storageGet(ext.storage.local, STORAGE_KEYS.AUTHOR_PREFERENCES, {} as AuthorPreferenceMap);
  memoryCache.authorPreferences = map;
  return map;
}

export async function saveAuthorPreferences(map: AuthorPreferenceMap): Promise<void> {
  memoryCache.authorPreferences = map;
  await storageSet(ext.storage.local, STORAGE_KEYS.AUTHOR_PREFERENCES, map);
}

export async function loadSchedulerHistory(): Promise<SchedulerHistoryEntry[]> {
  if (memoryCache.schedulerHistory) {
    return memoryCache.schedulerHistory;
  }

  const history = await storageGet(ext.storage.local, STORAGE_KEYS.SCHEDULER_HISTORY, [] as SchedulerHistoryEntry[]);
  const rawList = Array.isArray(history) ? history : [];
  memoryCache.schedulerHistory = rawList
    .filter((item): item is Partial<SchedulerHistoryEntry> & { timestamp: number } => Boolean(item && typeof item.timestamp === 'number'))
    .map((item) => {
      const channel = item.channel === 'group-fav' ? 'group-fav' : 'author-video';
      const taskReason = item.taskReason
        ?? (channel === 'group-fav' ? 'group-fav-refresh' : 'first-page-refresh');
      return {
        channel,
        mid: typeof item.mid === 'number' ? item.mid : undefined,
        groupId: typeof item.groupId === 'string' ? item.groupId : undefined,
        pn: typeof item.pn === 'number' ? item.pn : undefined,
        name: typeof item.name === 'string' ? item.name : (channel === 'group-fav' ? (item.groupId || 'unknown-group') : String(item.mid || 0)),
        success: item.success === true,
        timestamp: item.timestamp,
        error: typeof item.error === 'string' ? item.error : undefined,
        mode: item.mode === 'burst' ? 'burst' : 'regular',
        taskReason,
        trigger: item.trigger ?? 'alarm-routine'
      };
    });
  return memoryCache.schedulerHistory;
}

export async function saveSchedulerHistory(history: SchedulerHistoryEntry[]): Promise<void> {
  memoryCache.schedulerHistory = history;
  await storageSet(ext.storage.local, STORAGE_KEYS.SCHEDULER_HISTORY, history);
}

function normalizeAuthorPreference(mid: number, prev?: AuthorPreference): AuthorPreference {
  return {
    mid,
    ignoreUnreadCount: prev?.ignoreUnreadCount,
    readMarkTs: prev?.readMarkTs,
    updatedAt: prev?.updatedAt
  };
}

export async function setAuthorIgnoreUnreadCount(mid: number, ignoreUnreadCount: boolean): Promise<AuthorPreference> {
  const map = await loadAuthorPreferences();
  const prev = normalizeAuthorPreference(mid, map[mid]);
  const next: AuthorPreference = {
    ...prev,
    ignoreUnreadCount,
    updatedAt: Date.now()
  };

  if (!next.ignoreUnreadCount && !next.readMarkTs) {
    delete map[mid];
    await saveAuthorPreferences(map);
    return { mid };
  }

  map[mid] = next;
  await saveAuthorPreferences(map);
  return next;
}

export async function setAuthorReadMark(mid: number, readMarkTs: number): Promise<AuthorPreference> {
  const map = await loadAuthorPreferences();
  const prev = normalizeAuthorPreference(mid, map[mid]);
  const next: AuthorPreference = {
    ...prev,
    readMarkTs: Math.floor(readMarkTs),
    updatedAt: Date.now()
  };
  map[mid] = next;
  await saveAuthorPreferences(map);
  return next;
}

export async function clearAuthorReadMark(mid: number): Promise<AuthorPreference> {
  const map = await loadAuthorPreferences();
  const prev = normalizeAuthorPreference(mid, map[mid]);
  const next: AuthorPreference = {
    ...prev,
    readMarkTs: undefined,
    updatedAt: Date.now()
  };

  if (!next.ignoreUnreadCount) {
    delete map[mid];
    await saveAuthorPreferences(map);
    return { mid, ignoreUnreadCount: false };
  }

  map[mid] = next;
  await saveAuthorPreferences(map);
  return next;
}

/**
 * 清理“孤儿点击记录”：
 * 仅当某个 bvid 已不在任意作者缓存中时，才删除对应点击记录。
 * 这样可保证“视频仍在缓存中”时点击状态不会因时间流逝丢失。
 */
export async function cleanOrphanClicks(authorVideoCacheMap?: AuthorVideoCacheMap): Promise<ClickedVideoMap> {
  const [map, cacheMap] = await Promise.all([
    loadClickedVideos(),
    authorVideoCacheMap ? Promise.resolve(authorVideoCacheMap) : loadAuthorVideoCacheMap()
  ]);
  const activeBvids = new Set<string>();

  for (const cache of Object.values(cacheMap)) {
    for (const video of cache.videos) {
      activeBvids.add(video.bvid);
    }
  }

  let changed = false;
  for (const bvid of Object.keys(map)) {
    if (!activeBvids.has(bvid)) {
      delete map[bvid];
      changed = true;
    }
  }

  if (changed) {
    await saveClickedVideos(map);
  }

  return map;
}

/**
 * 清理“孤儿已阅覆盖”：
 * 仅当某个 bvid 已不在任意作者缓存中时，才删除覆盖记录。
 */
export async function cleanOrphanReviewedOverrides(
  authorVideoCacheMap?: AuthorVideoCacheMap
): Promise<VideoReviewedOverrideMap> {
  const [map, cacheMap] = await Promise.all([
    loadVideoReviewedOverrides(),
    authorVideoCacheMap ? Promise.resolve(authorVideoCacheMap) : loadAuthorVideoCacheMap()
  ]);
  const activeBvids = new Set<string>();

  for (const cache of Object.values(cacheMap)) {
    for (const video of cache.videos) {
      activeBvids.add(video.bvid);
    }
  }

  let changed = false;
  for (const bvid of Object.keys(map)) {
    if (!activeBvids.has(bvid)) {
      delete map[bvid];
      changed = true;
    }
  }

  if (changed) {
    await saveVideoReviewedOverrides(map);
  }

  return map;
}

/**
 * 兼容旧调用方的别名：
 * 旧逻辑为“按时间过期”，现统一切换为“按缓存生命周期清理”。
 */
export async function cleanExpiredClicks(): Promise<void> {
  await Promise.all([cleanOrphanClicks(), cleanOrphanReviewedOverrides()]);
}
