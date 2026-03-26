export type ViewMode = 'mixed' | 'byAuthor' | 'overview';
export type AllPostsFilterKey = 'all' | 'd7' | 'd14' | 'd30' | 'n10' | 'n30';

export interface GroupConfig {
  groupId: string;
  mediaId: number;
  mediaTitle: string;
  alias?: string;
  enabled: boolean;
  // 勾选后该分组不参与 unread 计数（分组红点固定为 0）。
  excludeFromUnreadCount?: boolean;
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
  // 控制是否在侧栏展示默认“全部”聚合分组。
  enableAllGroup: boolean;
  useStorageSync: boolean;
  debugMode: boolean;
}

export interface GroupRuntimeState {
  groupId: string;
  lastRefreshAt?: number;
  lastReadAt?: number;
  unreadCount: number;
  mixedTargetCount: number;
  // 记忆用户上次选择的视图模式
  savedMode?: ViewMode;
  // 当前分组正在生效的具体日期基线；为空时回退到 savedRecentDays。
  savedReadMarkTs?: number;
  // 记忆“近期投稿/时间流”共用的 N 天基线，允许 1-30 任意整数。
  savedRecentDays?: number;
  // 记忆“全部投稿”筛选，仅影响展示，不参与 unread 计算。
  savedAllPostsFilter?: AllPostsFilterKey;
  // 记忆“近期投稿/全部投稿”按作者视图是否按最新更新时间倒序。
  savedByAuthorSortByLatest?: boolean;
}

export interface GroupSyncStatus {
  totalAuthors: number;
  staleAuthors: number;
  // 所有作者都新鲜时，取最老的一份首页缓存时间（ms）。
  oldestFreshFetchedAt?: number;
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
  playCount?: number;
  danmakuCount?: number;
  durationText?: string;
  playbackPosiiton?: number;
  // 分页缓存元信息：
  // - updatedAt: 当前这条视频元数据最后一次刷新时间；
  // - sourcePn: 该条数据来源页码（用于“页使用回报”统计）；
  // - pageFetchedAt: 来源页的抓取时间（跨页去重时作为次级比较项）。
  meta?: {
    updatedAt: number;
    sourcePn: number;
    pageFetchedAt: number;
  };
}

export interface AuthorFeed {
  authorMid: number;
  authorName: string;
  authorFace?: string;
  follower?: number;
  following?: boolean;
  // 作者级“不计数 unread count”开关（跨组共享）。
  ignoreUnreadCount?: boolean;
  // 当前作者是否存在“非默认值”的作者级已阅时间点。
  hasAuthorReadMarkOverride?: boolean;
  // 当前作者用于分割线与过滤的有效边界（秒级时间戳，0 表示无边界）。
  effectiveReadBoundaryTs?: number;
  // 该作者当前缓存里已拉取到的最大页码（至少为 1）。
  maxCachedPn?: number;
  // 当前已实际拉取并写入缓存的页码集合（可能不连续）。
  cachedPagePns?: number[];
  // 该作者是否仍有后续分页可拉取。
  hasMorePages?: boolean;
  // 作者投稿总量（来自投稿接口 page.count）。
  totalVideoCount?: number;
  // 作者投稿接口页大小（来自投稿接口 page.ps）。
  apiPageSize?: number;
  videos: VideoItem[];
  // 当前筛选结果是否“仅由已阅前额外视频构成”（没有已阅基线之后的新视频）
  hasOnlyExtraOlderVideos?: boolean;
  // 概览按天筛选无命中时，是否使用了“保底 1 条最新视频”兜底展示。
  hasOverviewFallbackLatestVideo?: boolean;
  // 该作者投稿缓存里的最新发布时间（秒级时间戳）
  latestPubdate?: number;
}

export interface GroupFeedResult {
  groupId: string;
  mode: ViewMode;
  mixedVideos: VideoItem[];
  videosByAuthor: AuthorFeed[];
  syncStatus: GroupSyncStatus;
  lastRefreshAt?: number;
  lastReadAt?: number;
  unreadCount: number;
  hasMoreForMixed: boolean;
  // 当前分组的已阅时间点（倒序）
  readMarkTimestamps: number[];
  // 无真实已阅记录时的 grace 默认时间点（秒级时间戳），0 表示不适用
  graceReadMarkTs: number;
  // 构造过程中的降级提示（如某些补页失败），前台可展示但不阻断内容渲染。
  warningMsg?: string;
  // 按作者模式分页大小（与投稿接口 ps 保持一致）。
  byAuthorPageSize: number;
}

export interface GroupSummary {
  groupId: string;
  title: string;
  unreadCount: number;
  excludeFromUnreadCount: boolean;
  syncStatus: GroupSyncStatus;
  lastRefreshAt?: number;
  enabled: boolean;
  savedMode?: ViewMode;
  savedReadMarkTs?: number;
  savedRecentDays?: number;
  savedAllPostsFilter?: AllPostsFilterKey;
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
  follower?: number;
  following?: boolean;
  faceFetchedAt?: number;
  videos: VideoItem[];
  // 每页缓存状态：用于页级预取推进与去重回放。
  pageState: Record<number, { fetchedAt: number; usedInMixed: boolean; lastUsedAt?: number }>;
  maxCachedPn: number;
  nextPn: number;
  hasMore: boolean;
  // 投稿接口返回的作者视频总量（page.count）
  totalCount?: number;
  // 投稿接口返回的页大小（page.ps）
  apiPageSize?: number;
  firstPageFetchedAt: number;
  secondPageFetchedAt?: number;
  lastFetchedAt: number;
}

// 分组仅持有作者引用，不直接持有视频数据
export interface GroupFeedCache {
  groupId: string;
  authorMids: number[];
  updatedAt: number;
}

// 每个分组的已阅记录，按 groupId 索引，不跨分组共享
export interface GroupReadMark {
  groupId: string;
  // 最多保留 10 条，按最近一次写入顺序倒序排列（栈顶在前），
  // 不按时间戳数值重新排序；这样撤销才能回到上一个用户操作的时间点。
  // 每条记录为 Unix 时间戳（秒），表示该时间点及之前的视频已阅
  timestamps: number[];
}

export interface AuthorPreference {
  mid: number;
  // 该作者视频是否不参与 unread 计数（跨组共享）。
  ignoreUnreadCount?: boolean;
  // 作者级已阅时间点（秒级，跨组共享）；等于 readMarkTimestamps[0]。
  readMarkTs?: number;
  // 作者级已阅历史栈，按最近一次写入顺序倒序排列（栈顶在前），
  // 同值允许重复入栈，撤销时按操作次数逐次回退。
  readMarkTimestamps?: number[];
  updatedAt?: number;
}

export interface GroupOptionsData {
  groups: GroupConfig[];
  settings: ExtensionSettings;
  folders: FavoriteFolder[];
  groupAuthorCounts: Record<string, number>;
  totalTrackedAuthors: number;
}
