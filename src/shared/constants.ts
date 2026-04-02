import type { ExtensionSettings } from '@/shared/types';

export const AUTHOR_VIDEOS_PAGE_SIZE_DEFAULT = 24;
export const AUTHOR_VIDEOS_PAGE_SIZE_MAX = 42;
export const AUTHOR_CONTINUOUS_EXTRA_PAGE_COUNT_DEFAULT = 3;
export const AUTHOR_CONTINUOUS_EXTRA_PAGE_COUNT_MIN = 1;
export const AUTHOR_NON_CONTINUOUS_CACHE_PAGE_COUNT_DEFAULT = 3;
export const AUTHOR_NON_CONTINUOUS_CACHE_PAGE_COUNT_MIN = 1;

export const STORAGE_KEYS = {
  SETTINGS: 'bbe:settings',
  CURRENT_USER_SNAPSHOT: 'bbe:current-user-snapshot',
  FAVORITE_FOLDER_SNAPSHOT: 'bbe:favorite-folder-snapshot',
  GROUPS_LOCAL: 'bbe:groups:local',
  GROUPS_SYNC: 'bbe:groups:sync',
  RUNTIME: 'bbe:runtime',
  FEED_CACHE: 'bbe:feed:cache',
  AUTHOR_VIDEO_CACHE: 'bbe:author-video-cache',
  OPPORTUNISTIC_REFRESH_STATE: 'bbe:opportunistic-refresh-state',
  LAST_GROUP_ID: 'bbe:last:group',
  GROUP_READ_MARKS: 'bbe:group-read-marks',
  AUTHOR_PREFERENCES: 'bbe:author-preferences',
  LEGACY_AUTHOR_READ_MARKS: 'bbe:author-read-marks',
  CLICKED_VIDEOS: 'bbe:clicked-videos',
  LIKED_VIDEOS: 'bbe:liked-videos',
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
  authorVideosPageSize: AUTHOR_VIDEOS_PAGE_SIZE_DEFAULT,
  authorContinuousExtraPageCount: AUTHOR_CONTINUOUS_EXTRA_PAGE_COUNT_DEFAULT,
  authorNonContinuousCachePageCount: AUTHOR_NON_CONTINUOUS_CACHE_PAGE_COUNT_DEFAULT,
  defaultReadMarkDays: 7,
  enableAllGroup: true,
  useStorageSync: true,
  debugMode: false
};

export const MIXED_LOAD_INCREMENT = 20;

export const MAX_READ_MARK_COUNT = 10;
export const CLICKED_VIDEO_EXPIRE_DAYS = 30;
export const LIKED_VIDEO_EXPIRE_DAYS = 30;

// 调度器每批任务数的默认值（可被设置项覆盖）
export const BG_REFRESH_BATCH_SIZE_DEFAULT = 10;
// 同一批次内每个作者之间的请求间隔（ms）
export const BG_REFRESH_INTRA_DELAY_MS = 1000;
// 批次间延迟下限（ms）
export const BG_REFRESH_MIN_BATCH_DELAY_MS = 30_000;
// 标签页触发机会式刷新：全局防抖窗口（ms）。
export const OPPORTUNISTIC_REFRESH_DEBOUNCE_MS = 5_000;
// 标签页触发机会式刷新：30 分钟滑动窗口（ms）。
export const OPPORTUNISTIC_REFRESH_WINDOW_MS = 30 * 60 * 1000;
// 标签页触发机会式刷新：30 分钟内最多额外消耗的 HTTP 请求数。
export const OPPORTUNISTIC_REFRESH_MAX_REQUESTS_PER_WINDOW = 60;
// 单次机会式刷新允许消耗的预估请求预算。
export const OPPORTUNISTIC_REFRESH_REQUEST_BUDGET = 4;
// 同一作者进入机会式刷新的最小间隔（ms）。
export const OPPORTUNISTIC_REFRESH_AUTHOR_COOLDOWN_MS = 60_000;
// 收藏夹列表同步进入机会式刷新的最小间隔（ms）。
export const OPPORTUNISTIC_REFRESH_FOLDER_LIST_COOLDOWN_MS = 10 * 60 * 1000;
// 单个作者在一次机会式刷新里最多额外补取的连续窗口页块数。
export const OPPORTUNISTIC_AUTHOR_EXTRA_BLOCKS_PER_RUN = 1;

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
  UNREAD_CHANGED: 'bbe:unread-changed',
  OPEN_AUTHOR_GROUP_DIALOG: 'bbe:open-author-group-dialog',
  AUTHOR_GROUP_MEMBERSHIP_CHANGED: 'bbe:author-group-membership-changed'
} as const;

export const VIRTUAL_GROUP_ID = {
  ALL: '__bbe_all__'
} as const;
