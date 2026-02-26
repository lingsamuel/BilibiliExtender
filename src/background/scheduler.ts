import {
  ALARM_NAME,
  BG_REFRESH_BATCH_SIZE,
  BG_REFRESH_INTRA_DELAY_MS,
  BG_REFRESH_MIN_BATCH_DELAY_MS
} from '@/shared/constants';
import {
  loadAuthorVideoCacheMap,
  loadFeedCacheMap,
  loadGroups,
  loadRuntimeStateMap,
  loadSettings,
  saveAuthorVideoCacheMap,
  saveFeedCacheMap,
  saveRuntimeStateMap
} from '@/shared/storage/repository';
import type { ExtensionSettings } from '@/shared/types';
import {
  isAuthorCacheExpired,
  refreshAuthorCache,
  type AuthorCacheMap
} from '@/background/feed-service';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 注册或更新后台刷新 alarm。
 * 设置变更时调用以同步 alarm 周期。
 */
export async function setupAlarm(settings: ExtensionSettings): Promise<void> {
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: settings.backgroundRefreshIntervalMinutes,
    periodInMinutes: settings.backgroundRefreshIntervalMinutes
  });
}

/**
 * 从所有启用分组中收集全局唯一的作者集合，返回过期且需要刷新的作者列表。
 * 按 lastFetchedAt 升序排列（最旧优先）。
 */
function collectStaleAuthors(
  authorCacheMap: AuthorCacheMap,
  allAuthorMids: Set<number>,
  settings: ExtensionSettings
): Array<{ mid: number; name: string }> {
  const stale: Array<{ mid: number; name: string; lastFetchedAt: number }> = [];

  for (const mid of allAuthorMids) {
    const cache = authorCacheMap[mid];
    if (isAuthorCacheExpired(cache, settings)) {
      stale.push({
        mid,
        name: cache?.name ?? String(mid),
        lastFetchedAt: cache?.lastFetchedAt ?? 0
      });
    }
  }

  stale.sort((a, b) => a.lastFetchedAt - b.lastFetchedAt);
  return stale.map(({ mid, name }) => ({ mid, name }));
}

/**
 * alarm 触发时的核心处理逻辑：
 * 1. 收集所有启用分组的唯一作者
 * 2. 筛选过期作者，按最旧优先排序
 * 3. 分批串行刷新，批次间均匀延迟
 */
async function handleAlarm(): Promise<void> {
  const [settings, groups, feedCacheMap, authorCacheMap, runtimeMap] = await Promise.all([
    loadSettings(),
    loadGroups(),
    loadFeedCacheMap(),
    loadAuthorVideoCacheMap(),
    loadRuntimeStateMap()
  ]);

  const enabledGroups = groups.filter((g) => g.enabled);
  if (enabledGroups.length === 0) return;

  // 收集所有启用分组中的唯一作者 mid
  const allAuthorMids = new Set<number>();
  for (const group of enabledGroups) {
    const feedCache = feedCacheMap[group.groupId];
    if (feedCache) {
      for (const mid of feedCache.authorMids) {
        allAuthorMids.add(mid);
      }
    }
  }

  if (allAuthorMids.size === 0) return;

  const staleAuthors = collectStaleAuthors(authorCacheMap, allAuthorMids, settings);
  if (staleAuthors.length === 0) return;

  // 分批处理
  const batchCount = Math.ceil(staleAuthors.length / BG_REFRESH_BATCH_SIZE);
  const intervalMs = settings.backgroundRefreshIntervalMinutes * 60 * 1000;
  const batchDelay = Math.max(BG_REFRESH_MIN_BATCH_DELAY_MS, Math.floor(intervalMs / batchCount));

  for (let i = 0; i < staleAuthors.length; i += BG_REFRESH_BATCH_SIZE) {
    if (i > 0) {
      await sleep(batchDelay);
    }

    const batch = staleAuthors.slice(i, i + BG_REFRESH_BATCH_SIZE);

    for (let j = 0; j < batch.length; j++) {
      if (j > 0) {
        await sleep(BG_REFRESH_INTRA_DELAY_MS);
      }

      try {
        await refreshAuthorCache(batch[j].mid, batch[j].name, authorCacheMap);
      } catch (error) {
        console.warn('[BBE] background refresh failed for mid:', batch[j].mid, error);
      }
    }

    // 每批完成后持久化，避免 Service Worker 被终止时丢失进度
    await saveAuthorVideoCacheMap(authorCacheMap);
  }

  // 最终保存所有状态
  await Promise.all([
    saveAuthorVideoCacheMap(authorCacheMap),
    saveRuntimeStateMap(runtimeMap),
    saveFeedCacheMap(feedCacheMap)
  ]);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    handleAlarm().catch((error) => {
      console.warn('[BBE] background refresh alarm failed:', error);
    });
  }
});
