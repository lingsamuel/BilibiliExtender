import type {
  AuthorPreference,
  ExtensionSettings,
  GroupConfig,
  GroupFeedResult,
  GroupReadMark,
  GroupOptionsData,
  GroupSummary,
  OverviewFilterKey,
  ViewMode
} from '@/shared/types';

export type MessageRequest =
  | { type: 'PING' }
  | { type: 'GET_OPTIONS_DATA' }
  | { type: 'UPSERT_GROUP'; payload: { group: Omit<GroupConfig, 'createdAt' | 'updatedAt'> & Partial<Pick<GroupConfig, 'createdAt' | 'updatedAt'>> } }
  | { type: 'DELETE_GROUP'; payload: { groupId: string } }
  | { type: 'SAVE_SETTINGS'; payload: { settings: ExtensionSettings } }
  | { type: 'GET_GROUP_SUMMARY' }
  | {
      type: 'GET_GROUP_FEED';
      payload: {
        groupId: string;
        mode: ViewMode;
        loadMore?: boolean;
        selectedReadMarkTs?: number;
        overviewFilter?: OverviewFilterKey;
        byAuthorSortByLatest?: boolean;
      };
    }
  | { type: 'MANUAL_REFRESH'; payload: { groupId: string } }
  | { type: 'MARK_GROUP_READ'; payload: { groupId: string } }
  | { type: 'MARK_GROUP_READ_MARK'; payload: { groupId: string; readMarkTs?: number } }
  | { type: 'FOLLOW_AUTHOR'; payload: { mid: number; follow: boolean; csrf: string } }
  | { type: 'GET_GROUP_READ_MARKS'; payload: { groupIds: string[] } }
  | { type: 'RECORD_VIDEO_CLICK'; payload: { bvid: string } }
  | { type: 'GET_CLICKED_VIDEOS'; payload: { bvids: string[] } }
  | { type: 'SET_VIDEO_REVIEWED'; payload: { bvid: string; reviewed: boolean } }
  | { type: 'GET_VIDEO_REVIEWED_OVERRIDES'; payload: { bvids: string[] } }
  | { type: 'SET_AUTHOR_IGNORE_UNREAD'; payload: { mid: number; ignoreUnreadCount: boolean } }
  | { type: 'SET_AUTHOR_READ_MARK'; payload: { mid: number; readMarkTs: number } }
  | { type: 'CLEAR_AUTHOR_READ_MARK'; payload: { mid: number } }
  | { type: 'GET_AUTHOR_PREFERENCES'; payload: { mids: number[] } }
  | { type: 'MARK_ALL_GROUPS_READ' }
  | { type: 'GET_SCHEDULER_STATUS' }
  | { type: 'RUN_SCHEDULER_NOW' };

export type MessageResponse<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

export interface SchedulerStatusResponse {
  schedulerBatchSize: number;
  running: boolean;
  queueLength: number;
  currentTask: {
    mid: number;
    name: string;
    pn?: number;
    reason?: 'first-page-refresh' | 'prefetch-next-page' | 'load-more-boundary';
  } | null;
  batchCompleted: number;
  batchFailed: number;
  lastRunAt?: number;
  nextAlarmAt?: number;
  queue: Array<{
    mid: number;
    name: string;
    groupId?: string;
    pn?: number;
    reason?: 'first-page-refresh' | 'prefetch-next-page' | 'load-more-boundary';
  }>;
  groupChannel: {
    running: boolean;
    queueLength: number;
    currentTask: { groupId: string } | null;
    batchCompleted: number;
    batchFailed: number;
    lastRunAt?: number;
    nextAlarmAt?: number;
    queue: Array<{ groupId: string }>;
  };
  burst: {
    running: boolean;
    queueLength: number;
    currentTask: {
      mid: number;
      name?: string;
      pn?: number;
      reason?: 'first-page-refresh' | 'prefetch-next-page' | 'load-more-boundary';
      groupNames: string[];
    } | null;
    nextAllowedAt: number;
    cooldownReason: 'intra-delay' | 'error' | null;
    lastRunAt?: number;
    queue: Array<{
      mid: number;
      name?: string;
      pn?: number;
      reason?: 'first-page-refresh' | 'prefetch-next-page' | 'load-more-boundary';
      groupNames: string[];
    }>;
  };
  // 已缓存的作者摘要
  authorCaches: Array<{
    mid: number;
    name: string;
    groupNames: string[];
    videoCount: number;
    lastFetchedAt: number;
    face?: string;
  }>;
  // 分组缓存摘要
  groupCaches: Array<{
    groupId: string;
    title: string;
    authorCount: number;
    updatedAt: number;
  }>;
  // 最近的调度历史（最新在前，最多保留 50 条）
  history: Array<{
    mid: number;
    name: string;
    success: boolean;
    timestamp: number;
    error?: string;
    mode: 'regular' | 'burst';
  }>;
}

export interface ResponseMap {
  PING: { pong: true };
  GET_OPTIONS_DATA: GroupOptionsData;
  UPSERT_GROUP: { groups: GroupConfig[] };
  DELETE_GROUP: { groups: GroupConfig[] };
  SAVE_SETTINGS: { settings: ExtensionSettings };
  GET_GROUP_SUMMARY: {
    summaries: GroupSummary[];
    hasUnread: boolean;
    unreadCount: number;
    lastGroupId?: string;
    settings: ExtensionSettings;
  };
  GET_GROUP_FEED: GroupFeedResult & { cacheStatus: 'ready' | 'generating' };
  MANUAL_REFRESH: { accepted: boolean };
  MARK_GROUP_READ: { groupId: string; unreadCount: number };
  MARK_GROUP_READ_MARK: { marks: Record<string, GroupReadMark> };
  FOLLOW_AUTHOR: {
    mid: number;
    following: boolean;
    follower?: number;
    name?: string;
    face?: string;
  };
  GET_GROUP_READ_MARKS: { marks: Record<string, GroupReadMark> };
  RECORD_VIDEO_CLICK: { bvid: string };
  GET_CLICKED_VIDEOS: { clicked: Record<string, number> };
  SET_VIDEO_REVIEWED: { bvid: string; reviewed: boolean };
  GET_VIDEO_REVIEWED_OVERRIDES: { overrides: Record<string, boolean> };
  SET_AUTHOR_IGNORE_UNREAD: { preference: AuthorPreference };
  SET_AUTHOR_READ_MARK: { preference: AuthorPreference };
  CLEAR_AUTHOR_READ_MARK: { preference: AuthorPreference };
  GET_AUTHOR_PREFERENCES: { preferences: Record<number, AuthorPreference> };
  MARK_ALL_GROUPS_READ: { marks: Record<string, GroupReadMark>; readMarkTs: number };
  GET_SCHEDULER_STATUS: SchedulerStatusResponse;
  RUN_SCHEDULER_NOW: {
    accepted: true;
    triggeredAt: number;
    channels: Array<{
      name: 'author-video' | 'group-fav';
      queued: number;
      nextAlarmAt?: number;
    }>;
  };
}

export async function sendMessage<T extends MessageRequest>(
  request: T
): Promise<MessageResponse<ResponseMap[T['type']]>> {
  return chrome.runtime.sendMessage(request);
}
