import { DEFAULT_SETTINGS, STORAGE_KEYS } from '@/shared/constants';
import type {
  ExtensionSettings,
  GroupConfig,
  GroupFeedCache,
  GroupRuntimeState
} from '@/shared/types';

type RuntimeStateMap = Record<string, GroupRuntimeState>;
type FeedCacheMap = Record<string, GroupFeedCache>;

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
  const settings = await storageGet(chrome.storage.local, STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);
  return {
    ...DEFAULT_SETTINGS,
    ...settings
  };
}

async function setSettings(settings: ExtensionSettings): Promise<void> {
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
  const area = await getGroupsStorageArea();
  const key = area === chrome.storage.sync ? STORAGE_KEYS.GROUPS_SYNC : STORAGE_KEYS.GROUPS_LOCAL;

  try {
    return await storageGet(area, key, [] as GroupConfig[]);
  } catch (error) {
    // sync 读取失败时回退 local，避免配置不可用。
    console.warn('[BBE] loadGroups from preferred area failed, fallback to local:', error);
    return storageGet(chrome.storage.local, STORAGE_KEYS.GROUPS_LOCAL, [] as GroupConfig[]);
  }
}

/**
 * 写入分组配置：sync 超配额时自动切换到 local 并关闭 useStorageSync。
 */
export async function saveGroups(groups: GroupConfig[]): Promise<void> {
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
  return storageGet(chrome.storage.local, STORAGE_KEYS.RUNTIME, {} as RuntimeStateMap);
}

export async function saveRuntimeStateMap(stateMap: RuntimeStateMap): Promise<void> {
  await storageSet(chrome.storage.local, STORAGE_KEYS.RUNTIME, stateMap);
}

export async function loadFeedCacheMap(): Promise<FeedCacheMap> {
  return storageGet(chrome.storage.local, STORAGE_KEYS.FEED_CACHE, {} as FeedCacheMap);
}

export async function saveFeedCacheMap(cacheMap: FeedCacheMap): Promise<void> {
  await storageSet(chrome.storage.local, STORAGE_KEYS.FEED_CACHE, cacheMap);
}

export async function loadLastGroupId(): Promise<string | undefined> {
  return storageGet<string | undefined>(chrome.storage.local, STORAGE_KEYS.LAST_GROUP_ID, undefined);
}

export async function saveLastGroupId(groupId: string): Promise<void> {
  await storageSet(chrome.storage.local, STORAGE_KEYS.LAST_GROUP_ID, groupId);
}
