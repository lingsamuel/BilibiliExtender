import type { ExtensionSettings } from '@/shared/types';

export const STORAGE_KEYS = {
  SETTINGS: 'bbe:settings',
  GROUPS_LOCAL: 'bbe:groups:local',
  GROUPS_SYNC: 'bbe:groups:sync',
  RUNTIME: 'bbe:runtime',
  FEED_CACHE: 'bbe:feed:cache',
  LAST_GROUP_ID: 'bbe:last:group',
  AUTHOR_READ_MARKS: 'bbe:author-read-marks',
  CLICKED_VIDEOS: 'bbe:clicked-videos'
} as const;

export const DEFAULT_SETTINGS: ExtensionSettings = {
  refreshIntervalMinutes: 10,
  timelineMixedMaxCount: 50,
  extraOlderVideoCount: 1,
  defaultReadMarkDays: 7,
  useStorageSync: true
};

export const MIXED_LOAD_INCREMENT = 20;

export const MAX_READ_MARK_COUNT = 10;
export const CLICKED_VIDEO_EXPIRE_DAYS = 30;

export const EXTENSION_EVENT = {
  TOGGLE_DRAWER: 'bbe:toggle-drawer',
  OPEN_DRAWER: 'bbe:open-drawer',
  UNREAD_CHANGED: 'bbe:unread-changed'
} as const;
