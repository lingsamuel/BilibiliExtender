import type {
  ExtensionSettings,
  GroupConfig,
  GroupFeedResult,
  GroupOptionsData,
  GroupSummary,
  ViewMode
} from '@/shared/types';

export type MessageRequest =
  | { type: 'PING' }
  | { type: 'GET_OPTIONS_DATA' }
  | { type: 'UPSERT_GROUP'; payload: { group: Omit<GroupConfig, 'createdAt' | 'updatedAt'> & Partial<Pick<GroupConfig, 'createdAt' | 'updatedAt'>> } }
  | { type: 'DELETE_GROUP'; payload: { groupId: string } }
  | { type: 'SAVE_SETTINGS'; payload: { settings: ExtensionSettings } }
  | { type: 'GET_GROUP_SUMMARY'; payload?: { allowRefresh?: boolean } }
  | { type: 'GET_GROUP_FEED'; payload: { groupId: string; mode: ViewMode; loadMore?: boolean; forceRefresh?: boolean } }
  | { type: 'MARK_GROUP_READ'; payload: { groupId: string } };

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
  GET_GROUP_SUMMARY: { summaries: GroupSummary[]; hasUnread: boolean; lastGroupId?: string };
  GET_GROUP_FEED: GroupFeedResult;
  MARK_GROUP_READ: { groupId: string; unreadCount: number };
}

export async function sendMessage<T extends MessageRequest>(
  request: T
): Promise<MessageResponse<ResponseMap[T['type']]>> {
  return chrome.runtime.sendMessage(request);
}
