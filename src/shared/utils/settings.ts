import type { ExtensionSettings } from '@/shared/types';
import {
  AUTHOR_CONTINUOUS_EXTRA_PAGE_COUNT_DEFAULT,
  AUTHOR_CONTINUOUS_EXTRA_PAGE_COUNT_MIN,
  AUTHOR_NON_CONTINUOUS_CACHE_PAGE_COUNT_DEFAULT,
  AUTHOR_NON_CONTINUOUS_CACHE_PAGE_COUNT_MIN,
  AUTHOR_VIDEOS_PAGE_SIZE_DEFAULT,
  AUTHOR_VIDEOS_PAGE_SIZE_MAX
} from '@/shared/constants';

export const RECENT_PRESET_DAY_VALUES = [7, 14, 30] as const;

export function normalizeDefaultReadMarkDays(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) {
    return 7;
  }
  return Math.min(30, Math.max(1, parsed));
}

export function isBuiltInRecentDay(days: number): boolean {
  return RECENT_PRESET_DAY_VALUES.includes(days as (typeof RECENT_PRESET_DAY_VALUES)[number]);
}

export function normalizeAuthorVideosPageSize(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) {
    return AUTHOR_VIDEOS_PAGE_SIZE_DEFAULT;
  }
  return Math.min(AUTHOR_VIDEOS_PAGE_SIZE_MAX, Math.max(1, parsed));
}

export function normalizeAuthorContinuousExtraPageCount(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) {
    return AUTHOR_CONTINUOUS_EXTRA_PAGE_COUNT_DEFAULT;
  }
  return Math.min(10, Math.max(AUTHOR_CONTINUOUS_EXTRA_PAGE_COUNT_MIN, parsed));
}

export function normalizeAuthorNonContinuousCachePageCount(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) {
    return AUTHOR_NON_CONTINUOUS_CACHE_PAGE_COUNT_DEFAULT;
  }
  return Math.min(10, Math.max(AUTHOR_NON_CONTINUOUS_CACHE_PAGE_COUNT_MIN, parsed));
}

export function normalizeExtensionSettings(source: ExtensionSettings): ExtensionSettings {
  return {
    ...source,
    refreshIntervalMinutes: Math.min(120, Math.max(1, Number(source.refreshIntervalMinutes) || 30)),
    backgroundRefreshIntervalMinutes: Math.min(120, Math.max(5, Number(source.backgroundRefreshIntervalMinutes) || 10)),
    groupFavRefreshIntervalMinutes: Math.min(120, Math.max(5, Number(source.groupFavRefreshIntervalMinutes) || 10)),
    schedulerBatchSize: Math.min(50, Math.max(1, Number(source.schedulerBatchSize) || 10)),
    timelineMixedMaxCount: Math.min(500, Math.max(10, Number(source.timelineMixedMaxCount) || 50)),
    extraOlderVideoCount: Math.min(20, Math.max(0, Number(source.extraOlderVideoCount) || 1)),
    authorVideosPageSize: normalizeAuthorVideosPageSize(source.authorVideosPageSize),
    authorContinuousExtraPageCount: normalizeAuthorContinuousExtraPageCount(source.authorContinuousExtraPageCount),
    authorNonContinuousCachePageCount: normalizeAuthorNonContinuousCachePageCount(source.authorNonContinuousCachePageCount),
    defaultReadMarkDays: normalizeDefaultReadMarkDays(source.defaultReadMarkDays),
    enableAllGroup: source.enableAllGroup === true,
    useStorageSync: source.useStorageSync === true,
    debugMode: source.debugMode === true
  };
}
