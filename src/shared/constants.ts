import type { ExtensionSettings } from '@/shared/types';

export const STORAGE_KEYS = {
  SETTINGS: 'bbe:settings',
  GROUPS_LOCAL: 'bbe:groups:local',
  GROUPS_SYNC: 'bbe:groups:sync',
  RUNTIME: 'bbe:runtime',
  FEED_CACHE: 'bbe:feed:cache',
  LAST_GROUP_ID: 'bbe:last:group'
} as const;

export const DEFAULT_SETTINGS: ExtensionSettings = {
  refreshIntervalMinutes: 10,
  mixedInitialTargetCount: 50,
  authorPerCreatorCount: 10,
  useStorageSync: true
};

export const MIXED_LOAD_INCREMENT = 20;

export const EXTENSION_EVENT = {
  TOGGLE_DRAWER: 'bbe:toggle-drawer',
  OPEN_DRAWER: 'bbe:open-drawer',
  UNREAD_CHANGED: 'bbe:unread-changed'
} as const;
