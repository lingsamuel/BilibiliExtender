import type { ExtensionSettings } from '@/shared/types';

export const STORAGE_KEYS = {
  SETTINGS: 'bbe:settings',
  GROUPS_LOCAL: 'bbe:groups:local',
  GROUPS_SYNC: 'bbe:groups:sync',
  RUNTIME: 'bbe:runtime',
  FEED_CACHE: 'bbe:feed:cache',
  AUTHOR_VIDEO_CACHE: 'bbe:author-video-cache',
  LAST_GROUP_ID: 'bbe:last:group',
  GROUP_READ_MARKS: 'bbe:group-read-marks',
  AUTHOR_PREFERENCES: 'bbe:author-preferences',
  LEGACY_AUTHOR_READ_MARKS: 'bbe:author-read-marks',
  CLICKED_VIDEOS: 'bbe:clicked-videos',
  VIDEO_REVIEWED_OVERRIDES: 'bbe:video-reviewed-overrides',
  SCHEDULER_HISTORY: 'bbe:scheduler:history'
} as const;

export const DEFAULT_SETTINGS: ExtensionSettings = {
  refreshIntervalMinutes: 30,
  backgroundRefreshIntervalMinutes: 10,
  groupFavRefreshIntervalMinutes: 10,
  schedulerBatchSize: 10,
  timelineMixedMaxCount: 50,
  extraOlderVideoCount: 1,
  defaultReadMarkDays: 7,
  enableAllGroup: true,
  useStorageSync: true,
  debugMode: false
};

export const MIXED_LOAD_INCREMENT = 20;

export const MAX_READ_MARK_COUNT = 10;
export const CLICKED_VIDEO_EXPIRE_DAYS = 30;
// 作者投稿接口每页条数（对应 getUploaderVideos 的 ps 参数）
export const AUTHOR_VIDEOS_PAGE_SIZE = 24;

// 调度器每批任务数的默认值（可被设置项覆盖）
export const BG_REFRESH_BATCH_SIZE_DEFAULT = 10;
// 同一批次内每个作者之间的请求间隔（ms）
export const BG_REFRESH_INTRA_DELAY_MS = 1000;
// 批次间延迟下限（ms）
export const BG_REFRESH_MIN_BATCH_DELAY_MS = 30_000;

// 前台轮询间隔（ms）
export const POLL_INTERVAL_MS = 3000;
export const POLL_MAX_GENERATING = 10;
export const POLL_MAX_REFRESHING = 20;

export const ALARM_NAMES = {
  AUTHOR_VIDEO: 'bbe:background-refresh:author-video',
  GROUP_FAV: 'bbe:background-refresh:group-fav'
} as const;

export const EXTENSION_EVENT = {
  TOGGLE_DRAWER: 'bbe:toggle-drawer',
  OPEN_DRAWER: 'bbe:open-drawer',
  UNREAD_CHANGED: 'bbe:unread-changed'
} as const;

export const VIRTUAL_GROUP_ID = {
  ALL: '__bbe_all__'
} as const;
