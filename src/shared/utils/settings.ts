import type { ExtensionSettings, RecentPresetKey } from '@/shared/types';

export const RECENT_PRESET_DAY_VALUES = [7, 14, 30] as const;

type RecentPresetDayValue = (typeof RECENT_PRESET_DAY_VALUES)[number];

export function normalizeDefaultReadMarkDays(value: unknown): RecentPresetDayValue {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 7;
  }
  if (parsed <= 10.5) {
    return 7;
  }
  if (parsed <= 22) {
    return 14;
  }
  return 30;
}

export function normalizeRecentPresetValue(value: RecentPresetKey | number | undefined): RecentPresetKey {
  if (value === 'd14') {
    return 'd14';
  }
  if (value === 'd30') {
    return 'd30';
  }
  const days = normalizeDefaultReadMarkDays(value);
  if (days === 14) {
    return 'd14';
  }
  if (days === 30) {
    return 'd30';
  }
  return 'd7';
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
    defaultReadMarkDays: normalizeDefaultReadMarkDays(source.defaultReadMarkDays),
    enableAllGroup: source.enableAllGroup === true,
    useStorageSync: source.useStorageSync === true,
    debugMode: source.debugMode === true
  };
}
