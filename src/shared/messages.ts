import type {
  AllPostsFilterKey,
  AuthorPreference,
  ExtensionSettings,
  GroupConfig,
  GroupFeedResult,
  GroupReadMark,
  GroupOptionsData,
  GroupSummary,
  VideoItem,
  ViewMode
} from '@/shared/types';
import { ext } from '@/shared/platform/webext';

export type MessageRequest =
  | { type: 'PING' }
  | { type: 'GET_OPTIONS_DATA' }
  | { type: 'UPSERT_GROUP'; payload: { group: Omit<GroupConfig, 'createdAt' | 'updatedAt'> & Partial<Pick<GroupConfig, 'createdAt' | 'updatedAt'>> } }
  | { type: 'DELETE_GROUP'; payload: { groupId: string } }
  | { type: 'SAVE_SETTINGS'; payload: { settings: ExtensionSettings } }
  | { type: 'GET_GROUP_SUMMARY' }
  | { type: 'GET_AUTHOR_GROUP_MEMBERSHIP'; payload: { mid: number } }
  | {
      type: 'GET_GROUP_FEED';
      payload: {
        groupId: string;
        mode: ViewMode;
        loadMore?: boolean;
        recentDays?: number;
        activeReadMarkTs?: number;
        showAllForMixed?: boolean;
        allPostsFilter?: AllPostsFilterKey;
        byAuthorSortByLatest?: boolean;
      };
    }
  | {
      type: 'UPDATE_AUTHOR_GROUP_MEMBERSHIP';
      payload: {
        mid: number;
        groupId: string;
        action: 'add' | 'remove';
        csrf: string;
        pageOrigin: string;
        pageReferer: string;
        source: 'video' | 'space' | 'card';
        video?: {
          aid?: number;
          bvid?: string;
        };
      };
    }
  | { type: 'REFRESH_GROUP_POSTS'; payload: { groupId: string } }
  | { type: 'REFRESH_GROUP_FAV'; payload: { groupId: string } }
  | { type: 'MARK_GROUP_READ'; payload: { groupId: string } }
  | { type: 'MARK_GROUP_READ_MARK'; payload: { groupId: string; readMarkTs?: number } }
  | { type: 'UNDO_GROUP_READ_MARK'; payload: { groupId: string } }
  | { type: 'CLEAR_GROUP_READ_MARK'; payload: { groupId: string } }
  | {
      type: 'FOLLOW_AUTHOR';
      payload: {
        mid: number;
        follow: boolean;
        csrf: string;
        pageOrigin: string;
        pageReferer: string;
      };
    }
  | {
      type: 'LIKE_VIDEO';
      payload: {
        aid?: number;
        bvid?: string;
        authorMid: number;
        like: boolean;
        csrf: string;
        pageOrigin: string;
        pageReferer: string;
      };
    }
  | { type: 'COIN_VIDEO'; payload: { aid?: number; bvid?: string; multiply: number; selectLike?: boolean; csrf: string } }
  | {
      type: 'BATCH_LIKE_VIDEOS';
      payload: {
        authorMid: number;
        videos: Array<{ aid: number; bvid: string }>;
        csrf: string;
        pageOrigin: string;
        pageReferer: string;
      };
    }
  | { type: 'GET_GROUP_READ_MARKS'; payload: { groupIds: string[] } }
  | { type: 'RECORD_VIDEO_CLICK'; payload: { bvid: string } }
  | { type: 'GET_CLICKED_VIDEOS'; payload: { bvids: string[] } }
  | { type: 'GET_LIKED_VIDEOS'; payload: { bvids: string[] } }
  | { type: 'SET_VIDEO_REVIEWED'; payload: { bvid: string; reviewed: boolean } }
  | { type: 'GET_VIDEO_REVIEWED_OVERRIDES'; payload: { bvids: string[] } }
  | { type: 'SET_GROUP_EXCLUDE_UNREAD'; payload: { groupId: string; excludeFromUnreadCount: boolean } }
  | { type: 'SET_AUTHOR_IGNORE_UNREAD'; payload: { mid: number; ignoreUnreadCount: boolean } }
  | { type: 'SET_AUTHOR_READ_MARK'; payload: { mid: number; readMarkTs: number } }
  | { type: 'UNDO_AUTHOR_READ_MARK'; payload: { mid: number } }
  | { type: 'CLEAR_AUTHOR_READ_MARK'; payload: { mid: number } }
  | {
      type: 'REQUEST_AUTHOR_PAGE';
      payload: {
        groupId: string;
        mid: number;
        pn: number;
        ps: number;
        options?: {
          forceRefreshCurrentPage?: boolean;
          ensureContinuousFromHead?: boolean;
        };
      };
    }
  | { type: 'GET_AUTHOR_PAGE'; payload: { mid: number; pn: number; ps: number } }
  | { type: 'GET_AUTHOR_PREFERENCES'; payload: { mids: number[] } }
  | { type: 'GET_SCHEDULER_STATUS' }
  | { type: 'RUN_SCHEDULER_NOW' };

export type MessageResponse<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

export interface AuthorPageStatusPayload {
  groupId: string;
  mid: number;
  pn: number;
  ps: number;
  status: 'ready' | 'failed';
  error?: string;
}

export interface AuthorPageStatusMessage {
  type: 'AUTHOR_PAGE_STATUS';
  payload: AuthorPageStatusPayload;
}

export interface LikeTaskStatusPayload {
  authorMid: number;
  bvid: string;
  source: 'single-card-toggle' | 'author-batch-like';
  status: 'success' | 'failed';
  liked?: boolean;
  likedAt?: number;
  error?: string;
}

export interface LikeTaskStatusMessage {
  type: 'LIKE_TASK_STATUS';
  payload: LikeTaskStatusPayload;
}

export interface BatchLikeStatusPayload {
  authorMid: number;
  total: number;
  successCount: number;
  failedCount: number;
  failedBvids: string[];
}

export interface BatchLikeStatusMessage {
  type: 'BATCH_LIKE_STATUS';
  payload: BatchLikeStatusPayload;
}

export type RuntimeMessage =
  | AuthorPageStatusMessage
  | LikeTaskStatusMessage
  | BatchLikeStatusMessage;

export type SchedulerAuthorTaskReason =
  | 'first-page-refresh'
  | 'extend-continuous-window'
  | 'load-more-boundary'
  | 'request-author-page'
  | 'refresh-author-current-page';
export type SchedulerTaskReason =
  | SchedulerAuthorTaskReason
  | 'group-fav-refresh'
  | 'single-card-like'
  | 'single-card-unlike'
  | 'author-batch-like';
export type SchedulerTaskTrigger =
  | 'alarm-routine'
  | 'debug-run-now'
  | 'manual-click'
  | 'manual-refresh-posts'
  | 'manual-refresh-fav'
  | 'group-created-auto-refresh'
  | 'get-group-feed-missing-fav-cache'
  | 'get-group-feed-missing-author-cache'
  | 'get-group-feed-boundary'
  | 'request-author-page'
  | 'group-fav-chain';

export interface SchedulerStatusResponse {
  schedulerBatchSize: number;
  running: boolean;
  queueLength: number;
  currentTask: {
    mid: number;
    name: string;
    pn?: number;
    ps?: number;
    reason?: SchedulerAuthorTaskReason;
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
    ps?: number;
    reason?: SchedulerAuthorTaskReason;
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
  likeChannel: {
    running: boolean;
    queueLength: number;
    currentTask: {
      bvid: string;
      aid: number;
      action: 'like' | 'unlike';
      source: 'single-card-toggle' | 'author-batch-like';
      authorMid: number;
    } | null;
    batchCompleted: number;
    batchFailed: number;
    lastRunAt?: number;
    queue: Array<{
      bvid: string;
      aid: number;
      action: 'like' | 'unlike';
      source: 'single-card-toggle' | 'author-batch-like';
      authorMid: number;
    }>;
  };
  burst: {
    running: boolean;
    queueLength: number;
    currentTask: {
      mid: number;
      name?: string;
      pn?: number;
      ps?: number;
      reason?: SchedulerAuthorTaskReason;
      groupNames: string[];
    } | null;
    nextAllowedAt: number;
    cooldownReason: 'intra-delay' | 'error' | null;
    lastRunAt?: number;
    queue: Array<{
      mid: number;
      name?: string;
      pn?: number;
      ps?: number;
      reason?: SchedulerAuthorTaskReason;
      groupNames: string[];
    }>;
  };
  globalCooldown: {
    active: boolean;
    nextAllowedAt: number;
    reason: 'wbi-ratelimit' | null;
    lastTriggeredAt?: number;
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
    channel: 'author-video' | 'group-fav' | 'like-action';
    mid?: number;
    groupId?: string;
    bvid?: string;
    aid?: number;
    pn?: number;
    name: string;
    success: boolean;
    timestamp: number;
    error?: string;
    mode: 'regular' | 'burst';
    taskReason: SchedulerTaskReason;
    trigger: SchedulerTaskTrigger;
  }>;
}

export interface ResponseMap {
  PING: { pong: true };
  GET_OPTIONS_DATA: GroupOptionsData;
  UPSERT_GROUP: { groups: GroupConfig[] };
  DELETE_GROUP: { groups: GroupConfig[] };
  SAVE_SETTINGS: { settings: ExtensionSettings };
  GET_AUTHOR_GROUP_MEMBERSHIP: {
    mid: number;
    grouped: boolean;
    groups: Array<{
      groupId: string;
      title: string;
      mediaId: number;
      enabled: boolean;
      checked: boolean;
    }>;
  };
  GET_GROUP_SUMMARY: {
    summaries: GroupSummary[];
    hasUnread: boolean;
    unreadCount: number;
    lastGroupId?: string;
    settings: ExtensionSettings;
  };
  GET_GROUP_FEED: GroupFeedResult & { cacheStatus: 'ready' | 'generating' };
  UPDATE_AUTHOR_GROUP_MEMBERSHIP: {
    mid: number;
    grouped: boolean;
    groups: Array<{
      groupId: string;
      title: string;
      mediaId: number;
      enabled: boolean;
      checked: boolean;
    }>;
    action: 'add' | 'remove';
    groupId: string;
    message: string;
    affectedVideoCount?: number;
    latestVideoBvid?: string;
  };
  REFRESH_GROUP_POSTS: { accepted: boolean };
  REFRESH_GROUP_FAV: { accepted: boolean };
  MARK_GROUP_READ: { groupId: string; unreadCount: number };
  MARK_GROUP_READ_MARK: { marks: Record<string, GroupReadMark> };
  UNDO_GROUP_READ_MARK: { marks: Record<string, GroupReadMark>; removedReadMarkTs?: number };
  CLEAR_GROUP_READ_MARK: { marks: Record<string, GroupReadMark>; cleared: boolean };
  FOLLOW_AUTHOR: {
    mid: number;
    following: boolean;
    follower?: number;
    name?: string;
    face?: string;
  };
  LIKE_VIDEO: {
    aid?: number;
    bvid?: string;
    liked: boolean;
  };
  COIN_VIDEO: {
    aid?: number;
    bvid?: string;
    multiply: number;
    selectLike: boolean;
    like?: boolean;
  };
  BATCH_LIKE_VIDEOS: {
    authorMid: number;
    total: number;
    queuedCount: number;
    queuedBvids: string[];
    skippedBvids: string[];
  };
  GET_GROUP_READ_MARKS: { marks: Record<string, GroupReadMark> };
  RECORD_VIDEO_CLICK: { bvid: string };
  GET_CLICKED_VIDEOS: { clicked: Record<string, number> };
  GET_LIKED_VIDEOS: { liked: Record<string, number> };
  SET_VIDEO_REVIEWED: { bvid: string; reviewed: boolean };
  GET_VIDEO_REVIEWED_OVERRIDES: { overrides: Record<string, boolean> };
  SET_GROUP_EXCLUDE_UNREAD: { group: GroupConfig };
  SET_AUTHOR_IGNORE_UNREAD: { preference: AuthorPreference };
  SET_AUTHOR_READ_MARK: { preference: AuthorPreference };
  UNDO_AUTHOR_READ_MARK: { preference: AuthorPreference; removedReadMarkTs?: number };
  CLEAR_AUTHOR_READ_MARK: { preference: AuthorPreference };
  REQUEST_AUTHOR_PAGE: {
    accepted: boolean;
    status: 'queued' | 'no-more';
    maxPage?: number;
    requestedAt?: number;
  };
  GET_AUTHOR_PAGE: {
    available: boolean;
    mid: number;
    pn: number;
    ps: number;
    maxPage?: number;
    totalCount?: number;
    fetchedAt?: number;
    videos: VideoItem[];
  };
  GET_AUTHOR_PREFERENCES: { preferences: Record<number, AuthorPreference> };
  GET_SCHEDULER_STATUS: SchedulerStatusResponse;
  RUN_SCHEDULER_NOW: {
    accepted: true;
    triggeredAt: number;
    channels: Array<{
      name: 'author-video' | 'group-fav' | 'like-action';
      queued: number;
      nextAlarmAt?: number;
    }>;
  };
}

export async function sendMessage<T extends MessageRequest>(
  request: T
): Promise<MessageResponse<ResponseMap[T['type']]>> {
  return ext.runtime.sendMessage(request);
}
