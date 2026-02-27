import { CLICKED_VIDEO_EXPIRE_DAYS, DEFAULT_SETTINGS, MAX_READ_MARK_COUNT, STORAGE_KEYS } from '@/shared/constants';
import type {
  AuthorReadMark,
  AuthorVideoCache,
  ExtensionSettings,
  GroupConfig,
  GroupFeedCache,
  GroupRuntimeState
} from '@/shared/types';

type RuntimeStateMap = Record<string, GroupRuntimeState>;
type FeedCacheMap = Record<string, GroupFeedCache>;
type AuthorVideoCacheMap = Record<number, AuthorVideoCache>;

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
  authorReadMarks?: Record<number, AuthorReadMark>;
  clickedVideos?: Record<string, number>;
} = {
  hasLastGroupId: false
};

async function storageGet<T>(
  area: chrome.storage.StorageArea,
  key: string,
  fallback: T
): Promise<T> {
  const result = await area.get(key);
  return (result[key] as T | undefined) ?? fallback;
}

async function storageSet(area: chrome.storage.StorageArea, key: string, value: unknown): Promise<void> {
  await area.set({ [key]: value });
}

async function getSettings(): Promise<ExtensionSettings> {
  if (memoryCache.settings) {
    return memoryCache.settings;
  }

  const settings = await storageGet(chrome.storage.local, STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);
  const merged = {
    ...DEFAULT_SETTINGS,
    ...settings
  };
  memoryCache.settings = merged;
  return merged;
}

async function setSettings(settings: ExtensionSettings): Promise<void> {
  memoryCache.settings = settings;
  await storageSet(chrome.storage.local, STORAGE_KEYS.SETTINGS, settings);
}

async function getGroupsStorageArea(): Promise<chrome.storage.StorageArea> {
  const settings = await getSettings();
  return settings.useStorageSync ? chrome.storage.sync : chrome.storage.local;
}

/**
 * 读取分组配置：按设置优先从 sync 读取，失败时自动回退 local。
 */
export async function loadGroups(): Promise<GroupConfig[]> {
  if (memoryCache.groups) {
    return memoryCache.groups;
  }

  const area = await getGroupsStorageArea();
  const key = area === chrome.storage.sync ? STORAGE_KEYS.GROUPS_SYNC : STORAGE_KEYS.GROUPS_LOCAL;

  try {
    const groups = await storageGet(area, key, [] as GroupConfig[]);
    memoryCache.groups = groups;
    return groups;
  } catch (error) {
    // sync 读取失败时回退 local，避免配置不可用。
    console.warn('[BBE] loadGroups from preferred area failed, fallback to local:', error);
    const groups = await storageGet(chrome.storage.local, STORAGE_KEYS.GROUPS_LOCAL, [] as GroupConfig[]);
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
  const preferredArea = settings.useStorageSync ? chrome.storage.sync : chrome.storage.local;
  const preferredKey = settings.useStorageSync ? STORAGE_KEYS.GROUPS_SYNC : STORAGE_KEYS.GROUPS_LOCAL;

  try {
    await storageSet(preferredArea, preferredKey, groups);
    if (preferredArea === chrome.storage.sync) {
      await storageSet(chrome.storage.local, STORAGE_KEYS.GROUPS_LOCAL, groups);
    }
  } catch (error) {
    console.warn('[BBE] saveGroups failed in preferred area, fallback to local:', error);
    await storageSet(chrome.storage.local, STORAGE_KEYS.GROUPS_LOCAL, groups);

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

  const runtime = await storageGet(chrome.storage.local, STORAGE_KEYS.RUNTIME, {} as RuntimeStateMap);
  memoryCache.runtime = runtime;
  return runtime;
}

export async function saveRuntimeStateMap(stateMap: RuntimeStateMap): Promise<void> {
  memoryCache.runtime = stateMap;
  await storageSet(chrome.storage.local, STORAGE_KEYS.RUNTIME, stateMap);
}

/**
 * 读取分组 feed 缓存，自动丢弃不含 authorMids 的旧格式条目。
 */
export async function loadFeedCacheMap(): Promise<FeedCacheMap> {
  if (memoryCache.feed) {
    return memoryCache.feed;
  }

  const raw = await storageGet(chrome.storage.local, STORAGE_KEYS.FEED_CACHE, {} as FeedCacheMap);
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
  await storageSet(chrome.storage.local, STORAGE_KEYS.FEED_CACHE, cacheMap);
}

export async function loadAuthorVideoCacheMap(): Promise<AuthorVideoCacheMap> {
  if (memoryCache.authorVideo) {
    return memoryCache.authorVideo;
  }

  const cacheMap = await storageGet(chrome.storage.local, STORAGE_KEYS.AUTHOR_VIDEO_CACHE, {} as AuthorVideoCacheMap);
  memoryCache.authorVideo = cacheMap;
  return cacheMap;
}

export async function saveAuthorVideoCacheMap(cacheMap: AuthorVideoCacheMap): Promise<void> {
  memoryCache.authorVideo = cacheMap;
  await storageSet(chrome.storage.local, STORAGE_KEYS.AUTHOR_VIDEO_CACHE, cacheMap);
}

export async function loadLastGroupId(): Promise<string | undefined> {
  if (memoryCache.hasLastGroupId) {
    return memoryCache.lastGroupId;
  }

  const lastGroupId = await storageGet<string | undefined>(chrome.storage.local, STORAGE_KEYS.LAST_GROUP_ID, undefined);
  memoryCache.lastGroupId = lastGroupId;
  memoryCache.hasLastGroupId = true;
  return lastGroupId;
}

export async function saveLastGroupId(groupId: string): Promise<void> {
  memoryCache.lastGroupId = groupId;
  memoryCache.hasLastGroupId = true;
  await storageSet(chrome.storage.local, STORAGE_KEYS.LAST_GROUP_ID, groupId);
}

type ReadMarkMap = Record<number, AuthorReadMark>;
type ClickedVideoMap = Record<string, number>;

export async function loadAuthorReadMarks(): Promise<ReadMarkMap> {
  if (memoryCache.authorReadMarks) {
    return memoryCache.authorReadMarks;
  }

  const marks = await storageGet(chrome.storage.local, STORAGE_KEYS.AUTHOR_READ_MARKS, {} as ReadMarkMap);
  memoryCache.authorReadMarks = marks;
  return marks;
}

export async function saveAuthorReadMarks(marks: ReadMarkMap): Promise<void> {
  memoryCache.authorReadMarks = marks;
  await storageSet(chrome.storage.local, STORAGE_KEYS.AUTHOR_READ_MARKS, marks);
}

/**
 * 为指定作者列表追加已阅时间戳，每位作者最多保留 MAX_READ_MARK_COUNT 条。
 * 返回更新后的完整 ReadMarkMap。
 */
export async function appendReadMarks(mids: number[]): Promise<ReadMarkMap> {
  const marks = await loadAuthorReadMarks();
  const now = Math.floor(Date.now() / 1000);

  for (const mid of mids) {
    if (!marks[mid]) {
      marks[mid] = { mid, timestamps: [] };
    }

    marks[mid].timestamps.unshift(now);

    if (marks[mid].timestamps.length > MAX_READ_MARK_COUNT) {
      marks[mid].timestamps = marks[mid].timestamps.slice(0, MAX_READ_MARK_COUNT);
    }
  }

  await saveAuthorReadMarks(marks);
  return marks;
}

export async function loadClickedVideos(): Promise<ClickedVideoMap> {
  if (memoryCache.clickedVideos) {
    return memoryCache.clickedVideos;
  }

  const map = await storageGet(chrome.storage.local, STORAGE_KEYS.CLICKED_VIDEOS, {} as ClickedVideoMap);
  memoryCache.clickedVideos = map;
  return map;
}

export async function saveClickedVideos(map: ClickedVideoMap): Promise<void> {
  memoryCache.clickedVideos = map;
  await storageSet(chrome.storage.local, STORAGE_KEYS.CLICKED_VIDEOS, map);
}

export async function recordVideoClick(bvid: string): Promise<void> {
  const map = await loadClickedVideos();
  map[bvid] = Date.now();
  await saveClickedVideos(map);
}

/**
 * 清理超过过期天数的点击记录。
 */
export async function cleanExpiredClicks(): Promise<void> {
  const map = await loadClickedVideos();
  const expireMs = CLICKED_VIDEO_EXPIRE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let changed = false;

  for (const bvid of Object.keys(map)) {
    if (now - map[bvid] > expireMs) {
      delete map[bvid];
      changed = true;
    }
  }

  if (changed) {
    await saveClickedVideos(map);
  }
}
