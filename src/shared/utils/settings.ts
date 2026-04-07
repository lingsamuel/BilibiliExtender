import type { ExtensionSettings } from '@/shared/types';
import {
  AUTHOR_CONTINUOUS_EXTRA_PAGE_COUNT_DEFAULT,
  AUTHOR_CONTINUOUS_EXTRA_PAGE_COUNT_MIN,
  AUTHOR_NON_CONTINUOUS_CACHE_PAGE_COUNT_DEFAULT,
  AUTHOR_NON_CONTINUOUS_CACHE_PAGE_COUNT_MIN,
  BURST_COOLDOWN_MS_DEFAULT,
  BURST_ERROR_RETRY_MS_DEFAULT,
  BURST_FAST_BUDGET_TASKS_DEFAULT,
  BURST_FAST_INTERVAL_MS_DEFAULT,
  BURST_SLOW_BUDGET_TASKS_DEFAULT,
  BURST_SLOW_INTERVAL_MS_DEFAULT,
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

function normalizePositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export function normalizeExtensionSettings(source: ExtensionSettings): ExtensionSettings {
  return {
    ...source,
    refreshIntervalMinutes: Math.min(120, Math.max(1, Number(source.refreshIntervalMinutes) || 30)),
    backgroundRefreshIntervalMinutes: Math.min(120, Math.max(5, Number(source.backgroundRefreshIntervalMinutes) || 10)),
    groupFavRefreshIntervalMinutes: Math.min(120, Math.max(5, Number(source.groupFavRefreshIntervalMinutes) || 10)),
    schedulerBatchSize: Math.min(50, Math.max(1, Number(source.schedulerBatchSize) || 10)),
    burstFastIntervalMs: normalizePositiveInteger(source.burstFastIntervalMs, BURST_FAST_INTERVAL_MS_DEFAULT, 100, 60_000),
    burstFastBudgetTasks: normalizePositiveInteger(source.burstFastBudgetTasks, BURST_FAST_BUDGET_TASKS_DEFAULT, 1, 500),
    burstSlowIntervalMs: normalizePositiveInteger(source.burstSlowIntervalMs, BURST_SLOW_INTERVAL_MS_DEFAULT, 100, 60_000),
    burstSlowBudgetTasks: normalizePositiveInteger(source.burstSlowBudgetTasks, BURST_SLOW_BUDGET_TASKS_DEFAULT, 1, 500),
    burstCooldownMs: normalizePositiveInteger(source.burstCooldownMs, BURST_COOLDOWN_MS_DEFAULT, 1_000, 30 * 60 * 1000),
    burstErrorRetryMs: normalizePositiveInteger(source.burstErrorRetryMs, BURST_ERROR_RETRY_MS_DEFAULT, 1_000, 30 * 60 * 1000),
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
