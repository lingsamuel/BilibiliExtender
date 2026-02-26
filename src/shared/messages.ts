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
  | { type: 'GET_GROUP_SUMMARY'; payload?: { allowRefresh?: boolean } }
  | { type: 'GET_GROUP_FEED'; payload: { groupId: string; mode: ViewMode; loadMore?: boolean; forceRefresh?: boolean; selectedReadMarkTs?: number } }
  | { type: 'MARK_GROUP_READ'; payload: { groupId: string } }
  | { type: 'MARK_AUTHORS_READ'; payload: { mids: number[] } }
  | { type: 'GET_AUTHOR_READ_MARKS'; payload: { mids: number[] } }
  | { type: 'RECORD_VIDEO_CLICK'; payload: { bvid: string } }
  | { type: 'GET_CLICKED_VIDEOS'; payload: { bvids: string[] } }
  | { type: 'GET_WATCH_HISTORY' };

export type MessageResponse<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

export interface ResponseMap {
  PING: { pong: true };
  GET_OPTIONS_DATA: GroupOptionsData;
  UPSERT_GROUP: { groups: GroupConfig[] };
  DELETE_GROUP: { groups: GroupConfig[] };
  SAVE_SETTINGS: { settings: ExtensionSettings };
  GET_GROUP_SUMMARY: { summaries: GroupSummary[]; hasUnread: boolean; lastGroupId?: string; settings: ExtensionSettings };
  GET_GROUP_FEED: GroupFeedResult;
  MARK_GROUP_READ: { groupId: string; unreadCount: number };
  MARK_AUTHORS_READ: { marks: Record<number, AuthorReadMark> };
  GET_AUTHOR_READ_MARKS: { marks: Record<number, AuthorReadMark> };
  RECORD_VIDEO_CLICK: { bvid: string };
  GET_CLICKED_VIDEOS: { clicked: Record<string, number> };
  GET_WATCH_HISTORY: { history: WatchedVideo[] };
}

export async function sendMessage<T extends MessageRequest>(
  request: T
): Promise<MessageResponse<ResponseMap[T['type']]>> {
  return chrome.runtime.sendMessage(request);
}
