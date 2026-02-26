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
  mixedInitialTargetCount: number;
  authorPerCreatorCount: number;
  useStorageSync: boolean;
}

export interface GroupRuntimeState {
  groupId: string;
  lastRefreshAt?: number;
  lastReadAt?: number;
  unreadCount: number;
  mixedTargetCount: number;
}

export interface VideoItem {
  bvid: string;
  aid: number;
  title: string;
  cover: string;
  pubdate: number;
  authorMid: number;
  authorName: string;
}

export interface AuthorFeed {
  authorMid: number;
  authorName: string;
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
}

export interface GroupSummary {
  groupId: string;
  title: string;
  unreadCount: number;
  lastRefreshAt?: number;
  enabled: boolean;
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

export interface GroupFeedCache {
  groupId: string;
  authors: Array<{ mid: number; name: string }>;
  authorCursorMap: Record<number, { nextPn: number; hasMore: boolean; name: string }>;
  videosByAuthor: Record<number, VideoItem[]>;
  mixedVideos: VideoItem[];
  updatedAt: number;
}

export interface GroupOptionsData {
  groups: GroupConfig[];
  settings: ExtensionSettings;
  folders: FavoriteFolder[];
}
