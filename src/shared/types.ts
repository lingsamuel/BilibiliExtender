export type ViewMode = 'mixed' | 'byAuthor';

export interface GroupConfig {
  groupId: string;
  mediaId: number;
  mediaTitle: string;
  alias?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ExtensionSettings {
  refreshIntervalMinutes: number;
  backgroundRefreshIntervalMinutes: number;
  groupFavRefreshIntervalMinutes: number;
  schedulerBatchSize: number;
  timelineMixedMaxCount: number;
  extraOlderVideoCount: number;
  defaultReadMarkDays: number;
  useStorageSync: boolean;
  debugMode: boolean;
}

export interface GroupRuntimeState {
  groupId: string;
  lastRefreshAt?: number;
  lastReadAt?: number;
  unreadCount: number;
  mixedTargetCount: number;
  // 记忆用户上次选择的视图模式和已阅时间点
  savedMode?: ViewMode;
  savedReadMarkTs?: number;
  // 记忆“按作者”模式下是否按最新更新时间倒序
  savedByAuthorSortByLatest?: boolean;
}

export interface VideoItem {
  bvid: string;
  aid: number;
  title: string;
  cover: string;
  pubdate: number;
  authorMid: number;
  authorName: string;
  authorFace?: string;
  playbackPosiiton?: number;
}

export interface AuthorFeed {
  authorMid: number;
  authorName: string;
  authorFace?: string;
  videos: VideoItem[];
}

export interface GroupFeedResult {
  groupId: string;
  mode: ViewMode;
  mixedVideos: VideoItem[];
  videosByAuthor: AuthorFeed[];
  lastRefreshAt?: number;
  lastReadAt?: number;
  unreadCount: number;
  hasMoreForMixed: boolean;
  // 当前分组内所有作者的已阅时间点并集（去重、倒序）
  readMarkTimestamps: number[];
  // 无真实已阅记录时的 grace 默认时间点（秒级时间戳），0 表示不适用
  graceReadMarkTs: number;
}

export interface GroupSummary {
  groupId: string;
  title: string;
  unreadCount: number;
  lastRefreshAt?: number;
  enabled: boolean;
  savedMode?: ViewMode;
  savedReadMarkTs?: number;
  savedByAuthorSortByLatest?: boolean;
}

export interface FavoriteFolder {
  id: number;
  title: string;
  mediaCount: number;
}

export interface CurrentUser {
  mid: number;
  uname: string;
}

// 按作者缓存视频数据，跨分组共享
export interface AuthorVideoCache {
  mid: number;
  name: string;
  face?: string;
  faceFetchedAt?: number;
  videos: VideoItem[];
  nextPn: number;
  hasMore: boolean;
  lastFetchedAt: number;
}

// 分组仅持有作者引用，不直接持有视频数据
export interface GroupFeedCache {
  groupId: string;
  authorMids: number[];
  updatedAt: number;
}

// 每位作者的已阅记录，按作者 mid 索引，跨分组共享
export interface AuthorReadMark {
  mid: number;
  // 最多保留 10 条，按时间倒序排列（最新在前）
  // 每条记录为 Unix 时间戳（秒），表示该时间点及之前的视频已阅
  timestamps: number[];
}

export interface WatchedVideo {
  bvid: string;
  // 观看进度（秒），-1 表示已看完
  progress: number;
  // 视频总时长（秒）
  duration: number;
}

export interface GroupOptionsData {
  groups: GroupConfig[];
  settings: ExtensionSettings;
  folders: FavoriteFolder[];
  groupAuthorCounts: Record<string, number>;
  totalTrackedAuthors: number;
}
