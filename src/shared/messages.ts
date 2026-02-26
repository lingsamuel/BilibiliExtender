import type {
  AuthorReadMark,
  ExtensionSettings,
  GroupConfig,
  GroupFeedResult,
  GroupOptionsData,
  GroupSummary,
  ViewMode,
  WatchedVideo
} from '@/shared/types';

export type MessageRequest =
  | { type: 'PING' }
  | { type: 'GET_OPTIONS_DATA' }
  | { type: 'UPSERT_GROUP'; payload: { group: Omit<GroupConfig, 'createdAt' | 'updatedAt'> & Partial<Pick<GroupConfig, 'createdAt' | 'updatedAt'>> } }
  | { type: 'DELETE_GROUP'; payload: { groupId: string } }
  | { type: 'SAVE_SETTINGS'; payload: { settings: ExtensionSettings } }
  | { type: 'GET_GROUP_SUMMARY' }
  | { type: 'GET_GROUP_FEED'; payload: { groupId: string; mode: ViewMode; loadMore?: boolean; selectedReadMarkTs?: number } }
  | { type: 'MANUAL_REFRESH'; payload: { groupId: string } }
  | { type: 'MARK_GROUP_READ'; payload: { groupId: string } }
  | { type: 'MARK_AUTHORS_READ'; payload: { mids: number[] } }
  | { type: 'GET_AUTHOR_READ_MARKS'; payload: { mids: number[] } }
  | { type: 'RECORD_VIDEO_CLICK'; payload: { bvid: string } }
  | { type: 'GET_CLICKED_VIDEOS'; payload: { bvids: string[] } }
  | { type: 'GET_WATCH_HISTORY' }
  | { type: 'GET_SCHEDULER_STATUS' };

export type MessageResponse<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

export interface SchedulerStatusResponse {
  running: boolean;
  queueLength: number;
  currentTask: { mid: number; name: string } | null;
  batchCompleted: number;
  batchFailed: number;
  lastRunAt?: number;
  queue: Array<{ mid: number; name: string; groupId?: string }>;
  // 已缓存的作者摘要
  authorCaches: Array<{
    mid: number;
    name: string;
    videoCount: number;
    lastFetchedAt: number;
    face?: string;
  }>;
  // 分组缓存摘要
  groupCaches: Array<{
    groupId: string;
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
  }>;
}

export interface ResponseMap {
  PING: { pong: true };
  GET_OPTIONS_DATA: GroupOptionsData;
  UPSERT_GROUP: { groups: GroupConfig[] };
  DELETE_GROUP: { groups: GroupConfig[] };
  SAVE_SETTINGS: { settings: ExtensionSettings };
  GET_GROUP_SUMMARY: { summaries: GroupSummary[]; hasUnread: boolean; lastGroupId?: string; settings: ExtensionSettings };
  GET_GROUP_FEED: GroupFeedResult & { cacheStatus: 'ready' | 'generating' };
  MANUAL_REFRESH: { accepted: boolean };
  MARK_GROUP_READ: { groupId: string; unreadCount: number };
  MARK_AUTHORS_READ: { marks: Record<number, AuthorReadMark> };
  GET_AUTHOR_READ_MARKS: { marks: Record<number, AuthorReadMark> };
  RECORD_VIDEO_CLICK: { bvid: string };
  GET_CLICKED_VIDEOS: { clicked: Record<string, number> };
  GET_WATCH_HISTORY: { history: WatchedVideo[] };
  GET_SCHEDULER_STATUS: SchedulerStatusResponse;
}

export async function sendMessage<T extends MessageRequest>(
  request: T
): Promise<MessageResponse<ResponseMap[T['type']]>> {
  return chrome.runtime.sendMessage(request);
}
