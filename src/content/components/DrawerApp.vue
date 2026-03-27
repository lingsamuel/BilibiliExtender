<template>
  <div v-show="visible" class="bbe-mask" @click="closeDrawer" />
  <section v-show="visible" class="bbe-drawer" :style="drawerStyle">
    <div class="bbe-resize-handle" @mousedown="onResizeStart" />
    <aside class="bbe-sidebar">
      <div class="bbe-sidebar-groups">
        <div
          v-for="item in summaries"
          :key="item.groupId"
          class="bbe-group-item"
          :class="{ active: item.groupId === activeEntryId }"
          @click="selectEntry(item.groupId)"
        >
          <span>{{ item.title }}</span>
          <span v-if="item.unreadCount > 0" class="bbe-dot">{{ item.unreadCount > 99 ? '99+' : item.unreadCount }}</span>
        </div>
      </div>
      <div
        class="bbe-group-item bbe-sidebar-settings"
        :class="{ active: isSettingsView }"
        @click="selectEntry(ENTRY_ID.SETTINGS)"
      >
        <span>设置</span>
      </div>
      <div
        v-if="debugMode"
        class="bbe-group-item bbe-sidebar-settings"
        :class="{ active: isDebugView }"
        @click="selectEntry(ENTRY_ID.DEBUG)"
      >
        <span>调试</span>
      </div>
    </aside>

    <main class="bbe-main">
      <div class="bbe-toast-stack" aria-live="polite" aria-atomic="false">
        <div v-for="toast in toasts" :key="toast.id" class="bbe-toast bbe-toast-error">
          {{ toast.message }}
        </div>
      </div>

      <section v-if="isDebugView" class="bbe-list bbe-settings-scroll">
        <DebugPanel />
      </section>

      <section v-else-if="isSettingsView" class="bbe-list bbe-settings-scroll">
        <SettingsPanel @group-created="onGroupListChanged" @settings-saved="onSettingsSaved" />
      </section>

      <template v-else>
      <header class="bbe-toolbar">
        <div class="bbe-toolbar-left">
          <button class="bbe-btn" :class="{ active: mode === 'mixed' }" @click="switchMode('mixed')">时间流</button>
          <button class="bbe-btn" :class="{ active: mode === 'byAuthor' }" @click="switchMode('byAuthor')">近期投稿</button>
          <button class="bbe-btn" :class="{ active: mode === 'overview' }" @click="switchMode('overview')">全部投稿</button>
          <label v-if="mode !== 'mixed'" class="bbe-toolbar-check">
            <input v-model="byAuthorSortByLatest" type="checkbox" @change="onByAuthorSortByLatestChange" />
            <span>按更新时间倒序</span>
          </label>
          <span class="bbe-toolbar-sep" />
          <select v-if="mode !== 'overview'" v-model="selectedReadFilterKey" class="bbe-select-sm" @change="onTrackingReadFilterChange">
            <option v-if="mode === 'mixed'" value="m:all">全部</option>
            <option v-for="option in trackingDayOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            <option v-if="activeTrackingReadMarkTs" value="r:mark">{{ formatReadMarkTs(activeTrackingReadMarkTs) }}</option>
          </select>
          <select v-else v-model="selectedReadFilterKey" class="bbe-select-sm" @change="onOverviewFilterChange">
            <option value="o:all">全部</option>
            <option value="o:d7">7天内</option>
            <option value="o:d14">14天内</option>
            <option value="o:d30">30天内</option>
            <option value="o:n10">10条</option>
            <option value="o:n30">30条</option>
          </select>
          <button v-if="mode === 'mixed' && hasLatestGroupReadMark && !isAllGroupEntry" class="bbe-btn" :disabled="loading" @click="undoLatestGroupReadMark">
            撤销上次看到
          </button>
          <button v-if="mode !== 'overview' && !isAllGroupEntry" class="bbe-btn" :disabled="loading" @click="markCurrentGroupRead">{{ markReadButtonText }}</button>
          <button
            v-if="activeGroupSummary && !isAllGroupEntry"
            type="button"
            class="bbe-toolbar-switch"
            :class="{ active: activeGroupSummary.excludeFromUnreadCount }"
            :aria-pressed="activeGroupSummary.excludeFromUnreadCount"
            :disabled="loading"
            @click="toggleGroupExcludeUnread"
          >
            <span class="bbe-toolbar-switch-track" aria-hidden="true">
              <span class="bbe-toolbar-switch-thumb" />
            </span>
            <span>{{ activeGroupSummary.excludeFromUnreadCount ? '不计算未读' : '不计算未读' }}</span>
          </button>
        </div>

        <div class="bbe-toolbar-right">
          <span class="bbe-refresh-status" :class="{ updating: isUpdating }">
            <span v-if="isUpdating" class="bbe-spinner" aria-hidden="true" />
            <span>{{ refreshText }}</span>
          </span>
          <button class="bbe-btn" :disabled="loading || refreshing || generating" @click="manualRefresh">手动刷新</button>
          <button class="bbe-btn" @click="closeDrawer">关闭</button>
        </div>
      </header>

      <section ref="listRef" class="bbe-list" @scroll="onListScroll">
        <div v-if="showGeneratingPlaceholder" class="bbe-empty">正在生成缓存，请稍候...</div>
        <div v-else-if="loading" class="bbe-empty">加载中...</div>
        <div v-else-if="!feed || (mode === 'mixed' && feed.mixedVideos.length === 0)" class="bbe-empty">
          当前分组暂无投稿
        </div>
        <template v-else-if="mode === 'mixed'">
          <div v-if="warningMsg" class="bbe-warning">{{ warningMsg }}</div>
          <div class="bbe-mixed-layout">
            <aside
              v-if="mixedTimelineItems.length > 0"
              ref="mixedTimelineRef"
              class="bbe-timeline"
              :style="mixedTimelineStyle"
              aria-label="时间轴"
            >
              <div class="bbe-timeline-line" />
              <div
                v-for="item in mixedTimelineItems"
                :key="item.dayKey"
                class="bbe-timeline-item"
                :class="{ 'is-in-view': item.isInView }"
                :style="{ top: `${item.topPx}px` }"
              >
                <button
                  type="button"
                  class="bbe-timeline-label"
                  :title="`跳转到${item.label}`"
                  @click.stop="scrollToMixedDay(item.dayKey)"
                >
                  {{ item.label }}
                </button>
                <button
                  v-if="!isAllGroupEntry"
                  type="button"
                  class="bbe-timeline-node-btn"
                  :class="{ 'is-read-active': item.isReadActive }"
                  :title="getMixedTimelineNodeTitle(item)"
                  @click.stop="markReadToMixedDay(item.dayKey)"
                  @contextmenu.prevent.stop="onMixedTimelineNodeContextMenu(item)"
                >
                  <span class="bbe-timeline-node" />
                  <span class="bbe-timeline-check" aria-hidden="true">✓</span>
                </button>
                <span v-else class="bbe-timeline-node-btn is-static" aria-hidden="true">
                  <span class="bbe-timeline-node" />
                </span>
              </div>
            </aside>

            <div ref="mixedSectionsRef" class="bbe-mixed-sections">
              <template v-for="day in mixedDayGroupsWithDivider" :key="day.dayKey">
                <section
                  :ref="(el) => bindMixedDaySection(day.dayKey, el)"
                  class="bbe-mixed-day-section"
                >
                  <div class="bbe-grid bbe-mixed-grid">
                    <template v-for="item in day.videos" :key="item.video.bvid">
                      <div v-if="item.showReadBoundaryBefore" class="bbe-read-boundary-row" aria-label="上次看到这里">
                        <span class="bbe-read-boundary-line" />
                        <span class="bbe-read-boundary-text">上次看到这里↓</span>
                        <span class="bbe-read-boundary-line" />
                      </div>
                      <div class="bbe-mixed-grid-item">
                        <button
                          v-if="item.globalIndex > 0 && !isAllGroupEntry"
                          type="button"
                          class="bbe-mixed-read-boundary"
                          title="将该分界设置为分组已阅时间"
                          @click.stop="setMixedReadMarkFromBoundaryIndex(item.globalIndex)"
                        />
                        <VideoCard
                          :video="item.video"
                          :clicked="clickedMap[item.video.bvid] !== undefined"
                          :liked="isVideoLiked(item.video.bvid)"
                          :like-pending="isVideoLikePending(item.video.bvid)"
                          :reviewed="isVideoReviewed(item.video)"
                          :dimmed="shouldDimMixedVideo(item.video)"
                          @click="onVideoClick"
                          @toggle-like="onToggleVideoLike(item.video, $event)"
                          @toggle-reviewed="onToggleVideoReviewed"
                        />
                      </div>
                    </template>
                  </div>
                </section>
              </template>
            </div>
          </div>
          <div v-if="!loading && !loadingMore && !generating && feed?.hasMoreForMixed" class="bbe-load-more-row">
            <button
              type="button"
              class="bbe-btn"
              :disabled="loadingMore || loading || generating"
              @click="onLoadMoreClick"
            >
              加载更多
            </button>
          </div>
          <div v-if="loadingMore" class="bbe-empty">正在加载更多...</div>
          <div v-else-if="!feed.hasMoreForMixed" class="bbe-empty">没有更多内容了</div>
        </template>

        <template v-else>
          <div v-if="warningMsg" class="bbe-warning">{{ warningMsg }}</div>
          <div class="bbe-by-author-layout" :class="{ 'no-nav': !hasByAuthorNav }">
            <aside
              v-if="hasByAuthorNav"
              class="bbe-by-author-nav"
              aria-label="作者导航"
            >
              <button
                v-for="item in byAuthorNavItems"
                :key="item.authorMid"
                :ref="(el) => bindByAuthorNavItem(item.authorMid, el)"
                type="button"
                class="bbe-by-author-nav-item"
                :class="{ active: item.authorMid === byAuthorActiveMid }"
                :title="`跳转到${item.authorName}`"
                @click.stop="scrollToAuthor(item.authorMid)"
              >
                <img v-if="item.authorFace" class="bbe-avatar-sm" :src="item.authorFace" alt="" />
                <span class="bbe-by-author-nav-name">{{ item.authorName }}</span>
              </button>
            </aside>

            <div ref="byAuthorSectionsRef" class="bbe-by-author-sections">
              <template v-for="(author, index) in byAuthorFeeds" :key="author.authorMid">
                <div v-if="index === byAuthorReadBoundaryAuthorIndex" class="bbe-read-boundary-row" aria-label="上次看到这里">
                  <span class="bbe-read-boundary-line" />
                  <span class="bbe-read-boundary-text">上次看到这里↓</span>
                  <span class="bbe-read-boundary-line" />
                </div>
                <section
                  :ref="(el) => bindByAuthorSection(author.authorMid, el)"
                  class="bbe-author-section"
                >
                  <div class="bbe-author-scroll-anchor" aria-hidden="true" />
                  <h3
                    class="bbe-author-title"
                    :class="{ 'is-stuck': isAuthorTitleStuck(author.authorMid) }"
                  >
                    <div class="bbe-author-title-main">
                      <div class="bbe-author-title-left">
                        <a
                          class="bbe-author-avatar-link"
                          :href="`https://space.bilibili.com/${author.authorMid}`"
                          target="_blank"
                          rel="noreferrer"
                        >
                          <img v-if="author.authorFace" class="bbe-avatar" :src="author.authorFace" alt="" />
                          <span v-else class="bbe-avatar bbe-avatar-placeholder" aria-hidden="true" />
                        </a>
                        <div class="bbe-author-info">
                          <a
                            class="bbe-author-name-link"
                            :href="`https://space.bilibili.com/${author.authorMid}`"
                            target="_blank"
                            rel="noreferrer"
                          >
                            <span class="bbe-author-name">{{ author.authorName }}</span>
                          </a>
                          <span v-if="shouldShowAuthorLatestUpdateNote(author)" class="bbe-author-title-note">
                            {{ getAuthorLatestUpdateNote(author) }}
                          </span>
                        </div>
                        <button
                          type="button"
                          class="bbe-author-follow-btn"
                          :class="{ followed: author.following, loading: isFollowPending(author.authorMid) }"
                          :disabled="isFollowPending(author.authorMid)"
                          @click="toggleAuthorFollow(author)"
                        >
                          {{ getFollowButtonText(author) }}
                        </button>
                        <button
                          type="button"
                          class="bbe-author-like-btn"
                          :class="{ loading: isAuthorLikePending(author.authorMid) }"
                          :disabled="isAuthorLikePending(author.authorMid)"
                          @click="batchLikeAuthorVisibleVideos(author)"
                        >
                          {{ isAuthorLikePending(author.authorMid) ? '点赞中...' : '一键点赞' }}
                        </button>
                      </div>
                      <div class="bbe-author-title-actions">
                        <button type="button" class="bbe-author-mark-read-btn" @click="markAuthorReadNow(author)">标记已阅</button>
                        <button
                          v-if="author.hasAuthorReadMarkOverride"
                          type="button"
                          class="bbe-author-mark-read-btn"
                          @click="undoAuthorReadMark(author.authorMid)"
                        >
                          撤销已阅
                        </button>
                        <button
                          type="button"
                          class="bbe-author-switch bbe-author-ignore-switch"
                          :class="{ active: author.ignoreUnreadCount }"
                          @click="toggleAuthorIgnoreUnread(author)"
                        >
                          <span class="bbe-author-switch-dot" aria-hidden="true" />
                          {{ getAuthorIgnoreUnreadButtonText(author) }}
                        </button>
                      </div>
                    </div>
                  </h3>
                  <div class="bbe-grid bbe-author-grid">
                    <div
                      v-for="(video, index) in getAuthorVisibleVideos(author)"
                      :key="video.bvid"
                      class="bbe-author-grid-item"
                      :class="{
                        'has-read-boundary': isAuthorBoundaryIndex(author, index),
                        'has-author-read-mark': author.hasAuthorReadMarkOverride
                      }"
                    >
                      <button
                        v-if="index > 0"
                        type="button"
                        class="bbe-author-read-boundary"
                        :class="{
                          'is-active': isAuthorBoundaryIndex(author, index),
                          'is-author-mark': author.hasAuthorReadMarkOverride && isAuthorBoundaryIndex(author, index)
                        }"
                        :title="
                          isAuthorBoundaryIndex(author, index)
                            ? '左键设置作者已阅，右键清除'
                            : '左键将该分界设置为作者已阅时间'
                        "
                        @click.stop="setAuthorReadMarkFromBoundaryIndex(author, index)"
                        @contextmenu.prevent.stop="onAuthorBoundaryContextMenu(author, index)"
                      />
                      <VideoCard
                        :video="video"
                        :clicked="clickedMap[video.bvid] !== undefined"
                        :liked="isVideoLiked(video.bvid)"
                        :like-pending="isVideoLikePending(video.bvid)"
                        :reviewed="isVideoReviewed(video)"
                        @click="onVideoClick"
                        @toggle-like="onToggleVideoLike(video, $event)"
                        @toggle-reviewed="onToggleVideoReviewed"
                      />
                    </div>
                  </div>
                  <div v-if="shouldShowAuthorPagination(author)" class="bbe-author-pagination">
                    <div class="bbe-author-pagination-btns">
                      <button
                        type="button"
                        class="bbe-author-pagination-btn bbe-author-pagination-btn-side"
                        :disabled="isAuthorPageLoading(author.authorMid) || getAuthorCurrentPage(author) <= 1"
                        @click="goToAuthorPage(author, getAuthorCurrentPage(author) - 1)"
                      >
                        上一页
                      </button>
                      <template v-for="(pagerItem, pagerIndex) in getAuthorPagerItems(author)" :key="`${author.authorMid}-${pagerIndex}-${pagerItem}`">
                        <button
                          v-if="typeof pagerItem === 'number'"
                          type="button"
                          class="bbe-author-pagination-btn bbe-author-pagination-btn-num"
                          :class="{ active: pagerItem === getAuthorCurrentPage(author) }"
                          :disabled="isAuthorPageLoading(author.authorMid)"
                          @click="goToAuthorPage(author, pagerItem)"
                        >
                          {{ pagerItem }}
                        </button>
                        <span v-else class="bbe-author-pagination-more">...</span>
                      </template>
                      <button
                        type="button"
                        class="bbe-author-pagination-btn bbe-author-pagination-btn-side"
                        :disabled="
                          isAuthorPageLoading(author.authorMid) ||
                          getAuthorCurrentPage(author) >= getAuthorTotalPages(author)
                        "
                        @click="goToAuthorPage(author, getAuthorCurrentPage(author) + 1)"
                      >
                        下一页
                      </button>
                    </div>
                    <div class="bbe-author-pagination-go">
                      <span class="bbe-author-pagination-go-count">
                        共 {{ getAuthorTotalPages(author) }} 页 / {{ getAuthorTotalCount(author) }} 个，跳至
                      </span>
                      <input
                        type="number"
                        class="bbe-author-pagination-go-input"
                        min="1"
                        :max="getAuthorTotalPages(author)"
                        :value="getAuthorJumpPageInput(author.authorMid)"
                        @input="onAuthorPageJumpInput(author.authorMid, $event)"
                        @keydown.enter.prevent="submitAuthorPageJump(author)"
                      />
                      <span class="bbe-author-pagination-go-page">页</span>
                    </div>
                  </div>
                </section>
              </template>
            </div>
          </div>
        </template>
      </section>
      </template>
    </main>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type ComponentPublicInstance } from 'vue';
import {
  AUTHOR_VIDEOS_PAGE_SIZE_DEFAULT,
  EXTENSION_EVENT,
  POLL_INTERVAL_MS,
  POLL_MAX_REFRESHING,
  VIRTUAL_GROUP_ID
} from '@/shared/constants';
import {
  sendMessage,
  type AuthorPageStatusMessage,
  type BatchLikeStatusMessage,
  type LikeTaskStatusMessage
} from '@/shared/messages';
import { ext } from '@/shared/platform/webext';
import type {
  AllPostsFilterKey,
  AuthorFeed,
  GroupFeedResult,
  GroupSummary,
  VideoItem,
  ViewMode
} from '@/shared/types';
import { formatGroupSyncStatus, formatReadMarkTs } from '@/shared/utils/format';
import { isBuiltInRecentDay, normalizeDefaultReadMarkDays, RECENT_PRESET_DAY_VALUES } from '@/shared/utils/settings';
import { formatRelativePublishedAt, getRecentDaysBoundaryTs } from '@/shared/utils/time';
import VideoCard from '@/content/components/VideoCard.vue';
import DebugPanel from '@/content/components/DebugPanel.vue';
import {
  buildMixedDayGroups,
  buildTimelineWindow,
  getDayKeyFromSeconds,
  getNextDayStartSecondsFromDayKey
} from '@/content/utils/timeline';
import SettingsPanel from '@/shared/components/SettingsPanel.vue';

const DRAWER_WIDTH_KEY = 'bbe-drawer-width';
const MIN_DRAWER_WIDTH = 500;
const MAX_DRAWER_WIDTH_RATIO = 0.95;
const DEFAULT_DRAWER_WIDTH = 900;
const PAGE_SCROLL_LOCK_CLASS = 'bbe-page-scroll-lock';
const MIXED_TIMELINE_WINDOW_RADIUS = 2;
const MIXED_TIMELINE_EDGE_PADDING = 12;
const MIXED_TIMELINE_OUTSIDE_GAP = 18;
const MIXED_TIMELINE_VISIBLE_RATIO_THRESHOLD = 0.2;
const MIXED_TIMELINE_READ_BOUNDARY_CENTER_OFFSET = 4; // 分隔符高24px，圆圈高16px。中心对齐，左边8px右边12px，实际差4px
const BY_AUTHOR_VISIBLE_RATIO_THRESHOLD = 0.2;
const BY_AUTHOR_FALLBACK_VISIBLE_RATIO_THRESHOLD = 0.1;
const AUTHOR_TITLE_STICKY_TOP_OFFSET_PX = 8;
const AUTHOR_TITLE_STICKY_EPSILON_PX = 1;
const AUTHOR_TITLE_STICKY_SCROLLTOP_EPSILON_PX = 1;
const AUTHOR_PAGE_POLL_FAST_ATTEMPTS = 3;
const AUTHOR_PAGE_POLL_FAST_INTERVAL_MS = 500;
const AUTHOR_PAGE_POLL_SLOW_INTERVAL_MS = 1000;
const ENTRY_ID = {
  ALL: VIRTUAL_GROUP_ID.ALL,
  SETTINGS: '__bbe_settings__',
  DEBUG: '__bbe_debug__'
} as const;

function isVirtualEntryId(entryId: string): boolean {
  return entryId === ENTRY_ID.SETTINGS || entryId === ENTRY_ID.DEBUG;
}

const drawerWidth = ref(DEFAULT_DRAWER_WIDTH);
const drawerStyle = computed(() => ({
  width: `min(${drawerWidth.value}px, 88vw)`
}));

function loadDrawerWidth(): void {
  try {
    const saved = localStorage.getItem(DRAWER_WIDTH_KEY);
    if (saved) {
      const parsed = Number(saved);
      if (parsed >= MIN_DRAWER_WIDTH) {
        drawerWidth.value = parsed;
      }
    }
  } catch {
    // localStorage 不可用时静默忽略
  }
}

function saveDrawerWidth(): void {
  try {
    localStorage.setItem(DRAWER_WIDTH_KEY, String(Math.round(drawerWidth.value)));
  } catch {
    // 静默忽略
  }
}

function onResizeStart(e: MouseEvent): void {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = drawerWidth.value;
  const maxWidth = window.innerWidth * MAX_DRAWER_WIDTH_RATIO;

  function onMouseMove(ev: MouseEvent): void {
    // 抽屉在右侧，鼠标左移 = 宽度增大
    const delta = startX - ev.clientX;
    drawerWidth.value = Math.max(MIN_DRAWER_WIDTH, Math.min(maxWidth, startWidth + delta));
  }

  function onMouseUp(): void {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    saveDrawerWidth();
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

const visible = ref(false);
const loading = ref(false);
const loadingMore = ref(false);
const refreshing = ref(false);
const generating = ref(false);
const mode = ref<ViewMode>('mixed');
const summaries = ref<GroupSummary[]>([]);
const activeGroupId = ref('');
const activeEntryId = ref('');
const feed = ref<GroupFeedResult | null>(null);
const warningMsg = ref('');
const debugMode = ref(false);
const listRef = ref<HTMLElement | null>(null);
const toasts = ref<Array<{ id: number; message: string }>>([]);
let toastSeq = 0;
let summaryTimer: number | null = null;
let pollTimer: number | null = null;
let authorPagePollTimer: number | null = null;
const lastGroupIdFromSummary = ref('');

const selectedRecentDays = ref(7);
const activeTrackingReadMarkTs = ref<number | undefined>(undefined);
const selectedAllPostsFilter = ref<AllPostsFilterKey>('all');
const mixedShowAll = ref(false);
const selectedReadFilterKey = ref('r:days:7');
const byAuthorSortByLatest = ref(true);
const readMarkTimestamps = ref<number[]>([]);
const graceReadMarkTs = ref(0);
const clickedMap = ref<Record<string, number>>({});
const reviewedOverrideMap = ref<Record<string, boolean>>({});
const likedStateMap = ref<Record<string, VideoLikeState>>({});
const followPendingMap = ref<Record<number, boolean>>({});
const authorLikePendingMap = ref<Record<number, boolean>>({});
const byAuthorPageMap = ref<Record<number, number>>({});
const byAuthorPageJumpInputMap = ref<Record<number, string>>({});
const byAuthorPageLoadingMap = ref<Record<number, boolean>>({});
const pendingAuthorPageTargetMap = ref<Record<number, number>>({});
const byAuthorExactPageVideosMap = ref<Record<number, Record<number, VideoItem[]>>>({});
const mixedDaySectionElements = new Map<string, HTMLElement>();
const mixedTimelineRef = ref<HTMLElement | null>(null);
const mixedSectionsRef = ref<HTMLElement | null>(null);
const mixedDayInViewMap = ref<Record<string, boolean>>({});
const mixedTimelineNodeTopMap = ref<Record<string, number>>({});
const mixedTimelineHeight = ref(0);
const mixedTimelineWindow = ref<{ start: number; end: number }>({ start: 0, end: -1 });
const mixedTimelineFocusIndex = ref(0);
let mixedTimelineResizeObserver: ResizeObserver | null = null;
const byAuthorSectionElements = new Map<number, HTMLElement>();
const byAuthorNavItemElements = new Map<number, HTMLElement>();
const byAuthorSectionsRef = ref<HTMLElement | null>(null);
const byAuthorActiveMid = ref<number | null>(null);
const byAuthorStickyTitleMap = ref<Record<number, boolean>>({});
const isSettingsView = computed(() => activeEntryId.value === ENTRY_ID.SETTINGS);
const isDebugView = computed(() => activeEntryId.value === ENTRY_ID.DEBUG);

interface MixedTimelineItem {
  dayKey: string;
  label: string;
  isInView: boolean;
  isReadActive: boolean;
  topPx: number;
}

interface ByAuthorNavItem {
  authorMid: number;
  authorName: string;
  authorFace?: string;
}

interface VideoLikeState {
  liked: boolean;
  pending?: boolean;
  likedAt?: number;
}

interface MixedVideoWithBoundary {
  video: VideoItem;
  globalIndex: number;
  showReadBoundaryBefore: boolean;
}

interface MixedDayGroupWithDivider {
  dayKey: string;
  label: string;
  videos: MixedVideoWithBoundary[];
}

/**
 * 前台统一错误提示入口：只弹通知，不覆盖主内容。
 * 这样即使接口失败，也能保留当前可用缓存内容，避免“整页不可用”。
 * 同时把 toast 文本额外打到 console，便于排查那些来不及手动复制的瞬时错误。
 */
function showErrorToast(message: string): void {
  const text = message.trim();
  if (!text) {
    return;
  }
  console.error('[BBE][Toast]', text);
  const id = ++toastSeq;
  const next = [...toasts.value, { id, message: text }];
  toasts.value = next.slice(-4);
  window.setTimeout(() => {
    toasts.value = toasts.value.filter((item) => item.id !== id);
  }, 3200);
}

function buildAllPostsFilterKey(filter: AllPostsFilterKey): string {
  return `o:${filter}`;
}

function buildRecentDaysFilterKey(days: number): string {
  return `r:days:${normalizeRecentDays(days)}`;
}

function normalizeAllPostsFilter(filter: AllPostsFilterKey | undefined): AllPostsFilterKey {
  if (filter === 'all' || filter === 'd7' || filter === 'd14' || filter === 'd30' || filter === 'n10' || filter === 'n30') {
    return filter;
  }
  return 'all';
}

const latestGroupReadMarkTs = computed(() => readMarkTimestamps.value[0] ?? 0);
const hasLatestGroupReadMark = computed(() => latestGroupReadMarkTs.value > 0);
const currentSettings = ref<{ defaultReadMarkDays: number } | null>(null);

function normalizeRecentDays(days: number | undefined): number {
  return normalizeDefaultReadMarkDays(days);
}

function getDefaultRecentDays(): number {
  return normalizeRecentDays(currentSettings.value?.defaultReadMarkDays);
}

function resolveRecentDaysTs(days: number): number {
  return getRecentDaysBoundaryTs(normalizeRecentDays(days));
}

const activeAllPostsFilter = computed<AllPostsFilterKey>(() => {
  if (mode.value !== 'overview') {
    return 'all';
  }
  return normalizeAllPostsFilter(selectedAllPostsFilter.value);
});

const trackingDayOptions = computed<Array<{ value: string; label: string }>>(() => {
  const options = RECENT_PRESET_DAY_VALUES.map((days) => ({
    value: buildRecentDaysFilterKey(days),
    label: `${days}天内`
  }));
  const customDays = new Set<number>();
  const defaultDays = normalizeRecentDays(currentSettings.value?.defaultReadMarkDays);
  if (!isBuiltInRecentDay(defaultDays)) {
    customDays.add(defaultDays);
  }
  const activeDays = normalizeRecentDays(selectedRecentDays.value);
  if (!isBuiltInRecentDay(activeDays)) {
    customDays.add(activeDays);
  }
  for (const days of Array.from(customDays).sort((left, right) => left - right)) {
    options.unshift({
      value: buildRecentDaysFilterKey(days),
      label: `${days}天内`
    });
  }
  return options;
});

function syncSelectedReadFilterKey(): void {
  if (mode.value === 'overview') {
    selectedReadFilterKey.value = buildAllPostsFilterKey(normalizeAllPostsFilter(selectedAllPostsFilter.value));
    return;
  }
  if (mode.value === 'mixed' && mixedShowAll.value) {
    selectedReadFilterKey.value = 'm:all';
    return;
  }
  if (activeTrackingReadMarkTs.value && activeTrackingReadMarkTs.value > 0) {
    selectedReadFilterKey.value = 'r:mark';
    return;
  }
  selectedReadFilterKey.value = buildRecentDaysFilterKey(selectedRecentDays.value);
}

function parseRecentFilterKey(key: string): { showAllForMixed: boolean; recentDays?: number; useLatestReadMark: boolean } {
  if (key === 'm:all') {
    return {
      showAllForMixed: true,
      useLatestReadMark: false
    };
  }
  if (key === 'r:mark') {
    return {
      showAllForMixed: false,
      useLatestReadMark: true
    };
  }
  const raw = key.startsWith('r:days:') ? Number(key.slice('r:days:'.length)) : selectedRecentDays.value;
  return {
    showAllForMixed: false,
    recentDays: normalizeRecentDays(raw),
    useLatestReadMark: false
  };
}

function parseAllPostsFilterKey(key: string): AllPostsFilterKey {
  if (!key.startsWith('o:')) {
    return normalizeAllPostsFilter(selectedAllPostsFilter.value);
  }
  const raw = key.slice(2) as AllPostsFilterKey;
  return normalizeAllPostsFilter(raw);
}

function getAllPostsFilterForRequest(): AllPostsFilterKey {
  return normalizeAllPostsFilter(selectedAllPostsFilter.value);
}

const mixedDayGroups = computed(() => {
  if (!feed.value) {
    return [];
  }
  return buildMixedDayGroups(feed.value.mixedVideos);
});

const effectiveReadBoundaryTs = computed(() => {
  if (isAllGroupEntry.value) {
    return 0;
  }
  if (mode.value === 'overview') {
    return 0;
  }
  if (mode.value === 'mixed' && mixedShowAll.value) {
    return 0;
  }
  if (activeTrackingReadMarkTs.value && activeTrackingReadMarkTs.value > 0) {
    return activeTrackingReadMarkTs.value;
  }
  return resolveRecentDaysTs(selectedRecentDays.value);
});

/**
 * 在可见时间流里定位“上次看到这里”横向分割线的插入点：
 * 命中第一条严格早于已阅时间点的视频，并在其前方插入分割线。
 */
const mixedReadBoundaryVideoIndex = computed<number>(() => {
  const boundaryTs = effectiveReadBoundaryTs.value;
  const videos = feed.value?.mixedVideos ?? [];
  if (boundaryTs <= 0 || videos.length === 0) {
    return -1;
  }
  for (let index = 0; index < videos.length; index++) {
    if (videos[index].pubdate < boundaryTs) {
      return index;
    }
  }
  return -1;
});

const activeTimelineDayKey = computed<string | null>(() => {
  const boundaryIndex = mixedReadBoundaryVideoIndex.value;
  const videos = feed.value?.mixedVideos ?? [];
  if (boundaryIndex < 0 || boundaryIndex >= videos.length) {
    return null;
  }
  return getDayKeyFromSeconds(videos[boundaryIndex].pubdate);
});

const mixedDayGroupsWithDivider = computed<MixedDayGroupWithDivider[]>(() => {
  let globalIndex = 0;
  const boundaryIndex = mixedReadBoundaryVideoIndex.value;
  return mixedDayGroups.value.map((day) => {
    const videos = day.videos.map((video) => {
      const index = globalIndex;
      globalIndex += 1;
      return {
        video,
        globalIndex: index,
        showReadBoundaryBefore: index === boundaryIndex
      };
    });
    return {
      dayKey: day.dayKey,
      label: day.label,
      videos
    };
  });
});

const mixedTimelineItems = computed<MixedTimelineItem[]>(() => {
  const groups = mixedDayGroups.value;
  if (groups.length === 0) {
    return [];
  }

  let { start, end } = mixedTimelineWindow.value;
  if (end < start) {
    ({ start, end } = buildTimelineWindow(groups.length, mixedTimelineFocusIndex.value, MIXED_TIMELINE_WINDOW_RADIUS));
  }
  if (end < start) {
    return [];
  }

  const timelineHeight = Math.max(1, mixedTimelineHeight.value || listRef.value?.clientHeight || 0);
  const range = Math.max(1, end - start);
  const availableHeight = Math.max(0, timelineHeight - MIXED_TIMELINE_EDGE_PADDING * 2);

  return groups.slice(start, end + 1).map((group, offset) => {
    const index = start + offset;
    const ratio = (index - start) / range;
    const fallbackTop = MIXED_TIMELINE_EDGE_PADDING + availableHeight * ratio;
    return {
      dayKey: group.dayKey,
      label: group.label,
      isInView: mixedDayInViewMap.value[group.dayKey] === true,
      isReadActive: activeTimelineDayKey.value === group.dayKey,
      topPx: mixedTimelineNodeTopMap.value[group.dayKey] ?? fallbackTop
    };
  });
});

const mixedTimelineStyle = computed(() => {
  if (mixedTimelineHeight.value <= 0) {
    return {};
  }
  return {
    height: `${mixedTimelineHeight.value}px`
  };
});

/**
 * 统一提取作者“最近更新时间”用于前端排序。
 * 优先使用后端给出的 latestPubdate（全量缓存维度），
 * 缺失时回退到当前展示视频里的最大 pubdate，确保排序稳定。
 */
function resolveAuthorLatestPubdate(author: AuthorFeed): number | null {
  if (typeof author.latestPubdate === 'number' && author.latestPubdate > 0) {
    return author.latestPubdate;
  }
  if (author.videos.length === 0) {
    return null;
  }
  return author.videos.reduce((latest, video) => (video.pubdate > latest ? video.pubdate : latest), author.videos[0].pubdate);
}

const byAuthorFeeds = computed<AuthorFeed[]>(() => {
  if (!feed.value) {
    return [];
  }
  const rawAuthors = feed.value.videosByAuthor;
  if (!byAuthorSortByLatest.value) {
    return rawAuthors;
  }
  return rawAuthors
    .map((author, index) => ({
      author,
      index,
      latestPubdate: resolveAuthorLatestPubdate(author)
    }))
    .sort((a, b) => {
      if (a.latestPubdate === null && b.latestPubdate === null) {
        return a.index - b.index;
      }
      if (a.latestPubdate === null) {
        return 1;
      }
      if (b.latestPubdate === null) {
        return -1;
      }
      if (a.latestPubdate !== b.latestPubdate) {
        return b.latestPubdate - a.latestPubdate;
      }
      return a.index - b.index;
    })
    .map((item) => item.author);
});

/**
 * “近期投稿”勾选按更新时间倒序时，复用时间流的共享基线分割语义：
 * 在排序后的作者列表里，定位第一位“最新投稿已早于当前基线”的作者。
 */
const byAuthorReadBoundaryAuthorIndex = computed<number>(() => {
  if (mode.value !== 'byAuthor' || !byAuthorSortByLatest.value) {
    return -1;
  }
  const boundaryTs = effectiveReadBoundaryTs.value;
  if (boundaryTs <= 0) {
    return -1;
  }
  const authors = byAuthorFeeds.value;
  for (let index = 0; index < authors.length; index++) {
    const latestPubdate = resolveAuthorLatestPubdate(authors[index]);
    if (latestPubdate !== null && latestPubdate < boundaryTs) {
      return index;
    }
  }
  return -1;
});

function isAllPostsDayFilter(filter: AllPostsFilterKey): boolean {
  return filter === 'd7' || filter === 'd14' || filter === 'd30';
}

const isByAuthorPaginationEnabled = computed(() => {
  return mode.value === 'overview' && activeAllPostsFilter.value === 'all';
});

function getAuthorApiPageSize(author: AuthorFeed): number {
  return Math.max(1, Number(author.apiPageSize) || feed.value?.byAuthorPageSize || AUTHOR_VIDEOS_PAGE_SIZE_DEFAULT);
}

function getAuthorTotalPages(author: AuthorFeed): number {
  const pageSize = getAuthorApiPageSize(author);
  const knownTotalCount = Number(author.totalVideoCount);
  if (Number.isFinite(knownTotalCount) && knownTotalCount >= 0) {
    return Math.max(1, Math.ceil(knownTotalCount / pageSize));
  }
  const exactPages = Object.keys(byAuthorExactPageVideosMap.value[author.authorMid] ?? {}).map((rawPage) => Math.max(1, Number(rawPage) || 1));
  const maxExactPage = exactPages.length > 0 ? Math.max(...exactPages) : 1;
  return Math.max(maxExactPage, Math.max(1, Math.ceil(author.videos.length / pageSize)));
}

function getAuthorTotalCount(author: AuthorFeed): number {
  const knownTotalCount = Number(author.totalVideoCount);
  if (Number.isFinite(knownTotalCount) && knownTotalCount >= 0) {
    return Math.max(author.videos.length, Math.floor(knownTotalCount));
  }
  return Math.max(author.videos.length, getAuthorTotalPages(author) * getAuthorApiPageSize(author));
}

function getAuthorCurrentPage(author: AuthorFeed): number {
  const raw = Number(byAuthorPageMap.value[author.authorMid]) || 1;
  const totalPages = getAuthorTotalPages(author);
  return Math.min(totalPages, Math.max(1, raw));
}

const byAuthorVisibleVideosMap = computed<Record<number, VideoItem[]>>(() => {
  const result: Record<number, VideoItem[]> = {};
  for (const author of byAuthorFeeds.value) {
    if (!isByAuthorPaginationEnabled.value) {
      result[author.authorMid] = author.videos;
      continue;
    }
    const currentPage = getAuthorCurrentPage(author);
    const exactPageVideos = byAuthorExactPageVideosMap.value[author.authorMid]?.[currentPage];
    if (Array.isArray(exactPageVideos) && exactPageVideos.length > 0) {
      result[author.authorMid] = exactPageVideos;
      continue;
    }
    if (currentPage === 1) {
      result[author.authorMid] = author.videos.slice(0, getAuthorApiPageSize(author));
      continue;
    }
    result[author.authorMid] = [];
  }
  return result;
});

function getAuthorVisibleVideos(author: AuthorFeed): VideoItem[] {
  return byAuthorVisibleVideosMap.value[author.authorMid] ?? [];
}

function shouldShowAuthorPagination(author: AuthorFeed): boolean {
  return isByAuthorPaginationEnabled.value && getAuthorTotalPages(author) > 1;
}

function shouldShowAuthorLatestUpdateNote(author: AuthorFeed): boolean {
  if (!author.latestPubdate) {
    return false;
  }
  if (author.hasOnlyExtraOlderVideos) {
    return true;
  }
  return mode.value === 'overview'
    && isAllPostsDayFilter(activeAllPostsFilter.value)
    && author.hasOverviewFallbackLatestVideo === true;
}

function getAuthorLatestUpdateNote(author: AuthorFeed): string {
  if (!author.latestPubdate) {
    return '';
  }
  return `${formatRelativePublishedAt(author.latestPubdate)}更新`;
}

function isAuthorPageLoading(authorMid: number): boolean {
  return byAuthorPageLoadingMap.value[authorMid] === true || pendingAuthorPageTargetMap.value[authorMid] !== undefined;
}

function setPendingAuthorPageTarget(authorMid: number, targetPage?: number): void {
  if (!targetPage || targetPage <= 0) {
    const next = { ...pendingAuthorPageTargetMap.value };
    delete next[authorMid];
    pendingAuthorPageTargetMap.value = next;
    return;
  }
  pendingAuthorPageTargetMap.value = {
    ...pendingAuthorPageTargetMap.value,
    [authorMid]: Math.max(1, Math.floor(targetPage))
  };
}

function setAuthorPageLoading(authorMid: number, loadingState: boolean): void {
  if (loadingState) {
    byAuthorPageLoadingMap.value = { ...byAuthorPageLoadingMap.value, [authorMid]: true };
    return;
  }
  const next = { ...byAuthorPageLoadingMap.value };
  delete next[authorMid];
  byAuthorPageLoadingMap.value = next;
}

function getAuthorJumpPageInput(authorMid: number): string {
  return byAuthorPageJumpInputMap.value[authorMid] ?? '';
}

function onAuthorPageJumpInput(authorMid: number, event: Event): void {
  const input = event.target as HTMLInputElement;
  byAuthorPageJumpInputMap.value = {
    ...byAuthorPageJumpInputMap.value,
    [authorMid]: input.value
  };
}

function clearAuthorPageJumpInput(authorMid: number): void {
  const next = { ...byAuthorPageJumpInputMap.value };
  delete next[authorMid];
  byAuthorPageJumpInputMap.value = next;
}

function setAuthorExactPageVideos(authorMid: number, page: number, videos: VideoItem[]): void {
  const nextPages = {
    ...(byAuthorExactPageVideosMap.value[authorMid] ?? {}),
    [page]: videos
  };
  byAuthorExactPageVideosMap.value = {
    ...byAuthorExactPageVideosMap.value,
    [authorMid]: nextPages
  };
}

async function loadAuthorExactPage(authorMid: number, page: number, pageSize: number): Promise<boolean> {
  const resp = await sendMessage({
    type: 'GET_AUTHOR_PAGE',
    payload: {
      mid: authorMid,
      pn: page,
      ps: pageSize
    }
  });
  if (!resp.ok || !resp.data) {
    throw new Error(resp.error ?? '读取作者分页缓存失败');
  }
  if (!resp.data.available) {
    return false;
  }
  setAuthorExactPageVideos(authorMid, page, resp.data.videos);
  return true;
}

function getAuthorPagerItems(author: AuthorFeed): Array<number | '...'> {
  const total = getAuthorTotalPages(author);
  const current = getAuthorCurrentPage(author);
  if (total <= 9) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }

  const items: Array<number | '...'> = [1];
  const start = Math.max(2, current - 2);
  const end = Math.min(total - 1, current + 2);
  if (start > 2) {
    items.push('...');
  }
  for (let pn = start; pn <= end; pn++) {
    items.push(pn);
  }
  if (end < total - 1) {
    items.push('...');
  }
  items.push(total);
  return items;
}

async function goToAuthorPage(author: AuthorFeed, targetPage: number): Promise<void> {
  if (!isByAuthorPaginationEnabled.value || isAuthorPageLoading(author.authorMid) || !activeGroupId.value) {
    return;
  }

  const totalPages = getAuthorTotalPages(author);
  const nextPage = Math.min(totalPages, Math.max(1, Math.floor(targetPage)));
  const currentPage = getAuthorCurrentPage(author);
  if (nextPage === currentPage) {
    return;
  }

  const pageSize = getAuthorApiPageSize(author);
  setAuthorPageLoading(author.authorMid, true);
  try {
    if (nextPage === 1 || byAuthorExactPageVideosMap.value[author.authorMid]?.[nextPage]) {
      if (nextPage > 1) {
        await loadAuthorExactPage(author.authorMid, nextPage, pageSize);
      }
      byAuthorPageMap.value = {
        ...byAuthorPageMap.value,
        [author.authorMid]: nextPage
      };
      setPendingAuthorPageTarget(author.authorMid);
      clearAuthorPageJumpInput(author.authorMid);
      await nextTick();
      updateByAuthorNavState();
      return;
    }

    const resp = await sendMessage({
      type: 'REQUEST_AUTHOR_PAGE',
      payload: {
        groupId: activeGroupId.value,
        mid: author.authorMid,
        pn: nextPage,
        ps: pageSize
      }
    });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '提交分页任务失败');
    }

    if (resp.data.status === 'no-more') {
      const maxPage = Math.max(1, Number(resp.data.maxPage) || 1);
      showErrorToast(`该作者暂无第 ${nextPage} 页（当前最多 ${maxPage} 页）`);
      setPendingAuthorPageTarget(author.authorMid);
      return;
    }

    if (resp.data.status === 'cached') {
      const available = await loadAuthorExactPage(author.authorMid, nextPage, pageSize);
      if (available) {
        byAuthorPageMap.value = {
          ...byAuthorPageMap.value,
          [author.authorMid]: nextPage
        };
        setPendingAuthorPageTarget(author.authorMid);
        clearAuthorPageJumpInput(author.authorMid);
        await nextTick();
        updateByAuthorNavState();
        return;
      }
    }

    setPendingAuthorPageTarget(author.authorMid, nextPage);
    showErrorToast(`第 ${nextPage} 页缓存中，已提交分页任务`);
    startAuthorPagePoll(POLL_MAX_REFRESHING);
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '作者分页切换失败');
  } finally {
    setAuthorPageLoading(author.authorMid, false);
  }
}

async function submitAuthorPageJump(author: AuthorFeed): Promise<void> {
  const rawInput = byAuthorPageJumpInputMap.value[author.authorMid];
  const parsed = Number(rawInput);
  if (!Number.isFinite(parsed)) {
    clearAuthorPageJumpInput(author.authorMid);
    return;
  }
  await goToAuthorPage(author, Math.floor(parsed));
}

const byAuthorNavItems = computed<ByAuthorNavItem[]>(() => {
  if (mode.value === 'mixed') {
    return [];
  }
  return byAuthorFeeds.value.map((author) => ({
    authorMid: author.authorMid,
    authorName: author.authorName,
    authorFace: author.authorFace
  }));
});

const hasByAuthorNav = computed(() => byAuthorNavItems.value.length > 0);

function isFollowPending(mid: number): boolean {
  return followPendingMap.value[mid] === true;
}

function isAuthorLikePending(mid: number): boolean {
  return authorLikePendingMap.value[mid] === true;
}

function clearAuthorLikePending(mid: number): void {
  if (!(mid in authorLikePendingMap.value)) {
    return;
  }
  const next = { ...authorLikePendingMap.value };
  delete next[mid];
  authorLikePendingMap.value = next;
}

function isVideoLiked(bvid: string): boolean {
  return likedStateMap.value[bvid]?.liked === true;
}

function isVideoLikePending(bvid: string): boolean {
  return likedStateMap.value[bvid]?.pending === true;
}

/**
 * 点赞态只认插件本地写入的结果：
 * - 成功点赞/批量点赞后写入 storage.local，并保留 30 天；
 * - 取消点赞后删除本地记录；
 * - 读取链路不主动补远端查询。
 */
function patchVideoLikeStates(
  patches: Array<{ bvid: string; liked?: boolean; pending?: boolean; likedAt?: number }>
): void {
  if (patches.length === 0) {
    return;
  }

  const next = { ...likedStateMap.value };
  for (const patch of patches) {
    const bvid = patch.bvid?.trim();
    if (!bvid) {
      continue;
    }

    const prev = next[bvid];
    const liked = patch.liked ?? prev?.liked ?? false;
    const pending = patch.pending ?? false;
    const likedAt = patch.likedAt ?? (liked ? (prev?.likedAt ?? Date.now()) : undefined);

    if (!liked && !pending) {
      delete next[bvid];
      continue;
    }

    next[bvid] = {
      liked,
      pending,
      likedAt
    };
  }
  likedStateMap.value = next;
}

function formatFollowerWan(follower: number | undefined): string {
  if (typeof follower !== 'number' || Number.isNaN(follower) || follower < 0) {
    return '--';
  }

  if (follower < 10000) {
    return String(Math.floor(follower));
  }

  const wan = follower / 10000;
  if (wan >= 100) {
    return `${Math.round(wan)}万`;
  }

  const fixed = wan.toFixed(1).replace(/\.0$/, '');
  return `${fixed}万`;
}

function getFollowButtonText(author: AuthorFeed): string {
  const followerText = formatFollowerWan(author.follower);
  if (author.following) {
    return `已关注 ${followerText}`;
  }
  return `+ 关注 ${followerText}`;
}

function getAuthorIgnoreUnreadButtonText(author: AuthorFeed): string {
  return author.ignoreUnreadCount ? '不计算未读' : '不计算未读';
}

function getCsrfFromCookie(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
  if (!match || !match[1]) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * 将关注操作结果回写到当前 feed，保持“按作者标题 + 视频卡片作者信息”一致。
 */
function patchAuthorInFeed(
  mid: number,
  patch: {
    following?: boolean;
    follower?: number;
    name?: string;
    face?: string;
  }
): void {
  if (!feed.value) {
    return;
  }

  for (const author of feed.value.videosByAuthor) {
    if (author.authorMid !== mid) {
      continue;
    }
    if (patch.following !== undefined) {
      author.following = patch.following;
    }
    if (patch.follower !== undefined) {
      author.follower = patch.follower;
    }
    if (patch.name) {
      author.authorName = patch.name;
    }
    if (patch.face) {
      author.authorFace = patch.face;
    }
    for (const video of author.videos) {
      if (patch.name) {
        video.authorName = patch.name;
      }
      if (patch.face) {
        video.authorFace = patch.face;
      }
    }
  }

  for (const video of feed.value.mixedVideos) {
    if (video.authorMid !== mid) {
      continue;
    }
    if (patch.name) {
      video.authorName = patch.name;
    }
    if (patch.face) {
      video.authorFace = patch.face;
    }
  }
}

async function toggleAuthorFollow(author: AuthorFeed): Promise<void> {
  const mid = author.authorMid;
  if (!mid || isFollowPending(mid)) {
    return;
  }

  const csrf = getCsrfFromCookie();
  if (!csrf) {
    showErrorToast('未获取到 CSRF，请确认当前页面登录态有效');
    return;
  }

  const nextFollowing = !Boolean(author.following);
  const prevFollowing = author.following;
  const prevFollower = author.follower;
  const optimisticFollower =
    typeof prevFollower === 'number'
      ? Math.max(0, prevFollower + (nextFollowing ? 1 : -1))
      : prevFollower;

  followPendingMap.value = { ...followPendingMap.value, [mid]: true };
  patchAuthorInFeed(mid, {
    following: nextFollowing,
    follower: optimisticFollower
  });

  try {
    const resp = await sendMessage({
      type: 'FOLLOW_AUTHOR',
      payload: {
        mid,
        follow: nextFollowing,
        csrf,
        pageOrigin: window.location.origin,
        pageReferer: window.location.href
      }
    });

    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? (nextFollowing ? '关注失败' : '取消关注失败'));
    }

    patchAuthorInFeed(mid, {
      following: resp.data.following,
      follower: resp.data.follower,
      name: resp.data.name,
      face: resp.data.face
    });
  } catch (error) {
    patchAuthorInFeed(mid, {
      following: prevFollowing,
      follower: prevFollower
    });
    showErrorToast(error instanceof Error ? error.message : (nextFollowing ? '关注失败' : '取消关注失败'));
  } finally {
    const nextMap = { ...followPendingMap.value };
    delete nextMap[mid];
    followPendingMap.value = nextMap;
  }
}

async function batchLikeAuthorVisibleVideos(author: AuthorFeed): Promise<void> {
  const authorMid = author.authorMid;
  if (!authorMid || isAuthorLikePending(authorMid)) {
    return;
  }

  const csrf = getCsrfFromCookie();
  if (!csrf) {
    showErrorToast('未获取到 CSRF，请确认当前页面登录态有效');
    return;
  }

  const videos = getAuthorVisibleVideos(author).filter((video) => !isVideoLiked(video.bvid) && !isVideoLikePending(video.bvid));
  if (videos.length === 0) {
    showErrorToast('当前没有可点赞的视频');
    return;
  }

  const prevStateMap = new Map(videos.map((video) => [video.bvid, likedStateMap.value[video.bvid]]));
  authorLikePendingMap.value = { ...authorLikePendingMap.value, [authorMid]: true };
  patchVideoLikeStates(videos.map((video) => ({ bvid: video.bvid, pending: true, liked: isVideoLiked(video.bvid) })));
  try {
    const resp = await sendMessage({
      type: 'BATCH_LIKE_VIDEOS',
      payload: {
        authorMid,
        videos: videos.map((video) => ({
          aid: video.aid,
          bvid: video.bvid
        })),
        csrf,
        pageOrigin: window.location.origin,
        pageReferer: window.location.href
      }
    });

    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '一键点赞失败');
    }
    const skippedBvids = new Set(resp.data.skippedBvids);
    if (skippedBvids.size > 0) {
      patchVideoLikeStates(
        videos
          .filter((video) => skippedBvids.has(video.bvid))
          .map((video) => {
            const prevState = prevStateMap.get(video.bvid);
            return {
              bvid: video.bvid,
              liked: prevState?.liked ?? false,
              pending: false,
              likedAt: prevState?.likedAt
            };
          })
      );
    }

    if (resp.data.queuedCount === 0) {
      clearAuthorLikePending(authorMid);
      if (resp.data.total > 0) {
        showErrorToast('当前视频正在切换点赞状态，请稍后再试');
      }
    }
  } catch (error) {
    patchVideoLikeStates(videos.map((video) => ({ bvid: video.bvid, pending: false, liked: false })));
    clearAuthorLikePending(authorMid);
    showErrorToast(error instanceof Error ? error.message : '一键点赞失败');
  }
}

async function onToggleVideoLike(video: VideoItem, payload: { bvid: string; liked: boolean }): Promise<void> {
  if (isVideoLikePending(video.bvid)) {
    return;
  }

  const csrf = getCsrfFromCookie();
  if (!csrf) {
    showErrorToast('未获取到 CSRF，请确认当前页面登录态有效');
    return;
  }

  const prevState = likedStateMap.value[video.bvid];
  patchVideoLikeStates([
    {
      bvid: video.bvid,
      liked: prevState?.liked ?? false,
      pending: true,
      likedAt: prevState?.likedAt
    }
  ]);

  try {
    const resp = await sendMessage({
      type: 'LIKE_VIDEO',
      payload: {
        aid: video.aid,
        bvid: video.bvid,
        authorMid: video.authorMid,
        like: payload.liked,
        csrf,
        pageOrigin: window.location.origin,
        pageReferer: window.location.href
      }
    });

    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? (payload.liked ? '点赞失败' : '取消点赞失败'));
    }

    patchVideoLikeStates([
      {
        bvid: video.bvid,
        liked: resp.data.liked,
        pending: false,
        likedAt: resp.data.liked ? Date.now() : undefined
      }
    ]);
  } catch (error) {
    patchVideoLikeStates([
      {
        bvid: video.bvid,
        liked: prevState?.liked ?? false,
        pending: false,
        likedAt: prevState?.likedAt
      }
    ]);
    showErrorToast(error instanceof Error ? error.message : (payload.liked ? '点赞失败' : '取消点赞失败'));
  }
}

/**
 * 判断当前响应里是否已经有可展示的视频。
 * 这里以“至少存在一个视频卡片”为准，避免作者占位为空时误判为可展示。
 */
function hasRenderableFeedData(data: GroupFeedResult | null | undefined): boolean {
  if (!data) {
    return false;
  }
  if (data.mixedVideos.length > 0) {
    return true;
  }
  return data.videosByAuthor.some((author) => author.videos.length > 0);
}

function applyFeedWarning(data: GroupFeedResult | null | undefined): void {
  warningMsg.value = data?.warningMsg?.trim() || '';
}

function applyFeedSnapshot(data: GroupFeedResult): void {
  feed.value = data;
  syncAuthorPaginationStateWithFeed();
  applyFeedWarning(data);
  readMarkTimestamps.value = data.readMarkTimestamps;
  graceReadMarkTs.value = data.graceReadMarkTs;
  syncSelectedReadFilterKey();
}

function hasPendingAuthorPageTargets(): boolean {
  return Object.keys(pendingAuthorPageTargetMap.value).length > 0;
}

function getAuthorPagePollDelay(attempt: number): number {
  if (attempt < AUTHOR_PAGE_POLL_FAST_ATTEMPTS) {
    return AUTHOR_PAGE_POLL_FAST_INTERVAL_MS;
  }
  return AUTHOR_PAGE_POLL_SLOW_INTERVAL_MS;
}

const hasRenderableFeed = computed(() => hasRenderableFeedData(feed.value));
const showGeneratingPlaceholder = computed(() => generating.value && !hasRenderableFeed.value);
const isUpdating = computed(() => refreshing.value || (generating.value && hasRenderableFeed.value));
const activeGroupSummary = computed(() => summaries.value.find((item) => item.groupId === activeGroupId.value));

const refreshText = computed(() => {
  if (isUpdating.value) return '正在更新中';
  if (generating.value) return '正在生成缓存...';
  return formatGroupSyncStatus(feed.value?.syncStatus ?? activeGroupSummary.value?.syncStatus);
});

const isAllGroupEntry = computed(() => activeGroupId.value === ENTRY_ID.ALL);
const markReadButtonText = computed(() => {
  return mode.value === 'byAuthor' ? '全部标记已阅' : '标记已阅';
});

function restoreGroupViewState(summary?: GroupSummary): void {
  if (summary?.savedMode) {
    mode.value = summary.savedMode;
  }
  const isAllGroupSummary = summary?.groupId === ENTRY_ID.ALL;
  selectedRecentDays.value = isAllGroupSummary
    ? getDefaultRecentDays()
    : normalizeRecentDays(summary?.savedRecentDays ?? currentSettings.value?.defaultReadMarkDays);
  activeTrackingReadMarkTs.value = isAllGroupSummary
    ? undefined
    : (summary?.savedReadMarkTs && summary.savedReadMarkTs > 0 ? summary.savedReadMarkTs : undefined);
  selectedAllPostsFilter.value = normalizeAllPostsFilter(summary?.savedAllPostsFilter);
  mixedShowAll.value = false;
  if (summary?.savedByAuthorSortByLatest !== undefined) {
    byAuthorSortByLatest.value = summary.savedByAuthorSortByLatest;
  } else {
    byAuthorSortByLatest.value = true;
  }
  syncSelectedReadFilterKey();
}

const globalUnreadCount = ref(0);

function emitUnreadChanged(): void {
  const unreadCount = globalUnreadCount.value;
  const hasUnread = unreadCount > 0;
  window.dispatchEvent(
    new CustomEvent(EXTENSION_EVENT.UNREAD_CHANGED, {
      detail: { hasUnread, unreadCount }
    })
  );
}

async function loadSummary(): Promise<void> {
  const resp = await sendMessage({
    type: 'GET_GROUP_SUMMARY'
  });

  if (!resp.ok || !resp.data) {
    throw new Error(resp.error ?? '读取分组概要失败');
  }

  summaries.value = resp.data.summaries;
  globalUnreadCount.value = resp.data.unreadCount;
  currentSettings.value = { defaultReadMarkDays: normalizeRecentDays(resp.data.settings.defaultReadMarkDays) };
  debugMode.value = resp.data.settings.debugMode ?? false;
  lastGroupIdFromSummary.value = resp.data.lastGroupId ?? '';
  emitUnreadChanged();

  if (summaries.value.length === 0) {
    activeGroupId.value = '';
    activeEntryId.value = ENTRY_ID.SETTINGS;
    return;
  }

  const hasActiveGroup = summaries.value.some((item) => item.groupId === activeGroupId.value);
  if (!hasActiveGroup) {
    const preferredLastGroupId = summaries.value.some((item) => item.groupId === lastGroupIdFromSummary.value)
      ? lastGroupIdFromSummary.value
      : '';
    activeGroupId.value = preferredLastGroupId || summaries.value[0]?.groupId || '';
  }

  if (!activeEntryId.value) {
    activeEntryId.value = activeGroupId.value || ENTRY_ID.SETTINGS;
    return;
  }

  // 当前条目是分组但该分组已不存在时，回退到可用分组（或设置页）。
  if (!isVirtualEntryId(activeEntryId.value) && !summaries.value.some((item) => item.groupId === activeEntryId.value)) {
    activeEntryId.value = activeGroupId.value || ENTRY_ID.SETTINGS;
  }

}

function collectAllBvids(): string[] {
  if (!feed.value) {
    return [];
  }
  const bvids = new Set<string>();
  feed.value.mixedVideos.forEach((v) => bvids.add(v.bvid));
  feed.value.videosByAuthor.forEach((a) => a.videos.forEach((v) => bvids.add(v.bvid)));
  return Array.from(bvids);
}

async function restoreLikeProgressState(currentBvids: string[]): Promise<void> {
  if (currentBvids.length === 0) {
    authorLikePendingMap.value = {};
    return;
  }

  const resp = await sendMessage({ type: 'GET_SCHEDULER_STATUS' });
  if (!resp.ok || !resp.data) {
    return;
  }

  const pendingTasks = [
    ...(resp.data.likeChannel.currentTask ? [resp.data.likeChannel.currentTask] : []),
    ...resp.data.likeChannel.queue
  ];
  const keepBvids = new Set(currentBvids);
  const nextAuthorLikePendingMap: Record<number, boolean> = {};
  const patches: Array<{ bvid: string; liked?: boolean; pending?: boolean; likedAt?: number }> = [];

  for (const task of pendingTasks) {
    if (!keepBvids.has(task.bvid)) {
      continue;
    }

    const prevState = likedStateMap.value[task.bvid];
    patches.push({
      bvid: task.bvid,
      liked: prevState?.liked ?? false,
      pending: true,
      likedAt: prevState?.likedAt
    });

    if (task.source === 'author-batch-like' && task.action === 'like') {
      nextAuthorLikePendingMap[task.authorMid] = true;
    }
  }

  authorLikePendingMap.value = nextAuthorLikePendingMap;
  patchVideoLikeStates(patches);
}

async function fetchClickedVideos(): Promise<void> {
  const bvids = collectAllBvids();
  if (bvids.length === 0) {
    clickedMap.value = {};
    reviewedOverrideMap.value = {};
    likedStateMap.value = {};
    authorLikePendingMap.value = {};
    return;
  }

  const [clickedResp, reviewedResp, likedResp] = await Promise.all([
    sendMessage({ type: 'GET_CLICKED_VIDEOS', payload: { bvids } }),
    sendMessage({ type: 'GET_VIDEO_REVIEWED_OVERRIDES', payload: { bvids } }),
    sendMessage({ type: 'GET_LIKED_VIDEOS', payload: { bvids } })
  ]);

  if (clickedResp.ok && clickedResp.data) {
    clickedMap.value = clickedResp.data.clicked;
  }
  if (reviewedResp.ok && reviewedResp.data) {
    reviewedOverrideMap.value = reviewedResp.data.overrides;
  }
  if (likedResp.ok && likedResp.data) {
    const keepBvids = new Set(bvids);
    const nextLikedStateMap: Record<string, VideoLikeState> = {};
    for (const bvid of bvids) {
      const prevState = likedStateMap.value[bvid];
      if (prevState?.pending) {
        nextLikedStateMap[bvid] = prevState;
        continue;
      }

      const likedAt = likedResp.data.liked[bvid];
      if (typeof likedAt === 'number' && keepBvids.has(bvid)) {
        nextLikedStateMap[bvid] = {
          liked: true,
          pending: false,
          likedAt
        };
      }
    }
    likedStateMap.value = nextLikedStateMap;
  }
  await restoreLikeProgressState(bvids);
}

function stopPoll(): void {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function stopAuthorPagePoll(): void {
  if (authorPagePollTimer) {
    window.clearTimeout(authorPagePollTimer);
    authorPagePollTimer = null;
  }
}

async function refreshFeedForPendingAuthorPages(): Promise<void> {
  if (!hasPendingAuthorPageTargets()) {
    return;
  }

  const resolvedPending: number[] = [];
  for (const [rawMid, rawTarget] of Object.entries(pendingAuthorPageTargetMap.value)) {
    const mid = Math.max(1, Number(rawMid) || 0);
    const targetPage = Math.max(1, Number(rawTarget) || 0);
    if (!mid || !targetPage) {
      continue;
    }
    const author = byAuthorFeeds.value.find((item) => item.authorMid === mid);
    if (!author) {
      continue;
    }
    const pageSize = getAuthorApiPageSize(author);
    const available = await loadAuthorExactPage(mid, targetPage, pageSize);
    if (!available) {
      continue;
    }
    byAuthorPageMap.value = {
      ...byAuthorPageMap.value,
      [mid]: targetPage
    };
    setPendingAuthorPageTarget(mid);
    setAuthorPageLoading(mid, false);
    resolvedPending.push(mid);
  }

  if (resolvedPending.length > 0) {
    await nextTick();
    updateByAuthorNavState();
    await fetchClickedVideos();
  }

  if (!hasPendingAuthorPageTargets()) {
    stopAuthorPagePoll();
  }
}

/**
 * 记录每个日期分段对应的 DOM 节点，供滚动时判断“是否在可视区”以及“当前焦点日期”。
 */
function bindMixedDaySection(dayKey: string, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement) {
    mixedDaySectionElements.set(dayKey, el);
    return;
  }
  mixedDaySectionElements.delete(dayKey);
}

function bindByAuthorSection(authorMid: number, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement) {
    byAuthorSectionElements.set(authorMid, el);
    return;
  }
  byAuthorSectionElements.delete(authorMid);
}

function bindByAuthorNavItem(authorMid: number, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement) {
    byAuthorNavItemElements.set(authorMid, el);
    return;
  }
  byAuthorNavItemElements.delete(authorMid);
}

function resetMixedTimelineState(): void {
  mixedDayInViewMap.value = {};
  mixedTimelineNodeTopMap.value = {};
  mixedTimelineHeight.value = 0;
  mixedTimelineWindow.value = { start: 0, end: -1 };
  mixedTimelineFocusIndex.value = 0;
}

function resetByAuthorNavState(): void {
  byAuthorActiveMid.value = null;
  byAuthorStickyTitleMap.value = {};
}

function resetAuthorPaginationState(): void {
  stopAuthorPagePoll();
  byAuthorPageMap.value = {};
  byAuthorPageJumpInputMap.value = {};
  byAuthorPageLoadingMap.value = {};
  pendingAuthorPageTargetMap.value = {};
  byAuthorExactPageVideosMap.value = {};
}

function syncAuthorPaginationStateWithFeed(): void {
  if (!feed.value) {
    resetAuthorPaginationState();
    return;
  }

  const mids = new Set(feed.value.videosByAuthor.map((author) => author.authorMid));
  const nextPendingMap: Record<number, number> = {};
  for (const [rawMid, rawTarget] of Object.entries(pendingAuthorPageTargetMap.value)) {
    const mid = Number(rawMid);
    const target = Math.max(1, Math.floor(Number(rawTarget) || 1));
    if (mids.has(mid)) {
      nextPendingMap[mid] = target;
    }
  }

  const nextPageMap: Record<number, number> = {};
  let hasPendingApplied = false;
  const nextExactPageVideosMap: Record<number, Record<number, VideoItem[]>> = {};
  for (const author of feed.value.videosByAuthor) {
    const current = Number(byAuthorPageMap.value[author.authorMid]) || 1;
    const totalPages = getAuthorTotalPages(author);
    const pendingTarget = nextPendingMap[author.authorMid];
    const normalizedPendingTarget = pendingTarget ? Math.min(totalPages, Math.max(1, pendingTarget)) : undefined;
    nextExactPageVideosMap[author.authorMid] = {
      ...(byAuthorExactPageVideosMap.value[author.authorMid] ?? {}),
      1: author.videos.slice(0, getAuthorApiPageSize(author))
    };

    if (normalizedPendingTarget && nextExactPageVideosMap[author.authorMid][normalizedPendingTarget]) {
      nextPageMap[author.authorMid] = normalizedPendingTarget;
      delete nextPendingMap[author.authorMid];
      hasPendingApplied = true;
      continue;
    }

    nextPageMap[author.authorMid] = Math.min(totalPages, Math.max(1, current));
  }
  byAuthorPageMap.value = nextPageMap;
  pendingAuthorPageTargetMap.value = nextPendingMap;
  byAuthorExactPageVideosMap.value = nextExactPageVideosMap;

  const nextJumpMap: Record<number, string> = {};
  for (const [rawMid, rawValue] of Object.entries(byAuthorPageJumpInputMap.value)) {
    const mid = Number(rawMid);
    if (mids.has(mid)) {
      nextJumpMap[mid] = rawValue;
    }
  }
  byAuthorPageJumpInputMap.value = nextJumpMap;

  const nextLoadingMap: Record<number, boolean> = {};
  for (const [rawMid, rawLoading] of Object.entries(byAuthorPageLoadingMap.value)) {
    const mid = Number(rawMid);
    if (mids.has(mid) && rawLoading === true) {
      nextLoadingMap[mid] = true;
    }
  }
  byAuthorPageLoadingMap.value = nextLoadingMap;

  if (hasPendingApplied) {
    void nextTick().then(() => {
      updateByAuthorNavState();
    });
  }
}

function disconnectMixedTimelineResizeObserver(): void {
  if (!mixedTimelineResizeObserver) {
    return;
  }
  mixedTimelineResizeObserver.disconnect();
  mixedTimelineResizeObserver = null;
}

function ensureMixedTimelineResizeObserver(): void {
  disconnectMixedTimelineResizeObserver();

  if (!visible.value || mode.value !== 'mixed' || typeof ResizeObserver === 'undefined') {
    return;
  }

  const listEl = listRef.value;
  const sectionsEl = mixedSectionsRef.value;
  if (!listEl || !sectionsEl) {
    return;
  }

  mixedTimelineResizeObserver = new ResizeObserver(() => {
    updateMixedTimelineState();
  });
  mixedTimelineResizeObserver.observe(listEl);
  mixedTimelineResizeObserver.observe(sectionsEl);
}

/**
 * 计算时间轴状态：
 * 1) 每个日期分段是否在当前可视区域内（决定空心圆/小黑点）；
 * 2) 时间轴窗口只渲染“可视区全部日期 + 上下各两天（有投稿日期）”。
 */
function updateMixedTimelineState(): void {
  if (!visible.value || mode.value !== 'mixed') {
    resetMixedTimelineState();
    return;
  }

  const container = listRef.value;
  const timelineEl = mixedTimelineRef.value;
  const groups = mixedDayGroups.value;
  if (!container || !timelineEl || groups.length === 0) {
    resetMixedTimelineState();
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const timelineRect = timelineEl.getBoundingClientRect();
  const timelineHeight = Math.max(container.clientHeight, MIXED_TIMELINE_EDGE_PADDING * 2 + 1);
  const viewTopPx = containerRect.top;
  const viewBottomPx = containerRect.bottom;
  /**
   * 时间线节点最终写入的是“相对 sticky 盒子自身顶部”的坐标。
   * 当 sticky 在列表底部被浏览器上推时，盒子 top 会发生位移，
   * 因此必须基于真实 DOM 几何，而不能继续假设它始终贴着滚动容器顶部。
   */
  const visibleTimelineTopInBox = Math.max(0, viewTopPx - timelineRect.top);
  const visibleTimelineBottomInBox = Math.max(
    visibleTimelineTopInBox + 1,
    Math.min(timelineHeight, viewBottomPx - timelineRect.top)
  );
  const nextInViewMap: Record<string, boolean> = {};
  const nextNodeTopMap: Record<string, number> = {};
  const inViewIndexes: number[] = [];
  const inViewTopMap = new Map<number, number>();
  let focusIndex = -1;
  let measuredCount = 0;

  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    const sectionEl = mixedDaySectionElements.get(group.dayKey);
    if (!sectionEl) {
      continue;
    }
    measuredCount++;

    const sectionRect = sectionEl.getBoundingClientRect();
    const visibleTop = Math.max(sectionRect.top, viewTopPx);
    const visibleBottom = Math.min(sectionRect.bottom, viewBottomPx);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    const sectionHeight = Math.max(1, sectionRect.height);
    const visibleRatio = visibleHeight / sectionHeight;
    const inView = visibleRatio > MIXED_TIMELINE_VISIBLE_RATIO_THRESHOLD;
    nextInViewMap[group.dayKey] = inView;
    if (inView) {
      // “上次看到这里”分隔符插在日期 section 内部时，视觉锚点是分隔符中线而不是 section 顶部。
      // 这里先按当前样式做最小修正：仅对命中分隔符的那一天下移半个分隔符高度。
      const readBoundaryOffset = activeTimelineDayKey.value === group.dayKey
        ? MIXED_TIMELINE_READ_BOUNDARY_CENTER_OFFSET
        : 0;
      inViewIndexes.push(index);
      inViewTopMap.set(index, sectionRect.top - timelineRect.top + 8 + readBoundaryOffset);
    }

    // 以“可视区域顶部遇到的第一个日期段”为主日期，驱动时间轴压缩窗口。
    if (focusIndex < 0 && sectionRect.bottom > viewTopPx + 1) {
      focusIndex = index;
    }
  }

  if (measuredCount === 0) {
    mixedDayInViewMap.value = {};
    mixedTimelineHeight.value = timelineHeight;
    const { start: fallbackStart, end: fallbackEnd } = buildTimelineWindow(
      groups.length,
      mixedTimelineFocusIndex.value,
      MIXED_TIMELINE_WINDOW_RADIUS
    );
    const range = Math.max(1, fallbackEnd - fallbackStart);
    const availableHeight = Math.max(
      0,
      visibleTimelineBottomInBox - visibleTimelineTopInBox - MIXED_TIMELINE_EDGE_PADDING * 2
    );
    const fallbackNodeTopMap: Record<string, number> = {};
    for (let index = fallbackStart; index <= fallbackEnd; index++) {
      const ratio = (index - fallbackStart) / range;
      fallbackNodeTopMap[groups[index].dayKey] =
        visibleTimelineTopInBox + MIXED_TIMELINE_EDGE_PADDING + ratio * availableHeight;
    }
    mixedTimelineNodeTopMap.value = fallbackNodeTopMap;
    mixedTimelineWindow.value = { start: fallbackStart, end: fallbackEnd };
    requestAnimationFrame(() => {
      updateMixedTimelineState();
    });
    return;
  }
  if (measuredCount < groups.length) {
    requestAnimationFrame(() => {
      updateMixedTimelineState();
    });
  }

  if (focusIndex < 0) {
    focusIndex = groups.length - 1;
  }

  const firstVisibleIndex = inViewIndexes.length > 0 ? inViewIndexes[0] : focusIndex;
  const lastVisibleIndex = inViewIndexes.length > 0 ? inViewIndexes[inViewIndexes.length - 1] : focusIndex;
  const start = Math.max(0, firstVisibleIndex - MIXED_TIMELINE_WINDOW_RADIUS);
  const end = Math.min(groups.length - 1, lastVisibleIndex + MIXED_TIMELINE_WINDOW_RADIUS);

  if (inViewIndexes.length > 0) {
    const topCompressedCount = Math.max(0, firstVisibleIndex - start);
    const bottomCompressedCount = Math.max(0, end - lastVisibleIndex);

    const topDockStart = visibleTimelineTopInBox + MIXED_TIMELINE_EDGE_PADDING;
    const topDockEnd =
      topCompressedCount > 0
        ? topDockStart + (topCompressedCount - 1) * MIXED_TIMELINE_OUTSIDE_GAP
        : topDockStart;
    const bottomDockStart =
      bottomCompressedCount > 0
        ? visibleTimelineBottomInBox - MIXED_TIMELINE_EDGE_PADDING - (bottomCompressedCount - 1) * MIXED_TIMELINE_OUTSIDE_GAP
        : visibleTimelineBottomInBox - MIXED_TIMELINE_EDGE_PADDING;

    const topInViewBound =
      topCompressedCount > 0 ? topDockEnd + MIXED_TIMELINE_OUTSIDE_GAP : visibleTimelineTopInBox + MIXED_TIMELINE_EDGE_PADDING;
    const bottomInViewBound =
      bottomCompressedCount > 0
        ? bottomDockStart - MIXED_TIMELINE_OUTSIDE_GAP
        : visibleTimelineBottomInBox - MIXED_TIMELINE_EDGE_PADDING;
    let minInViewTop = topInViewBound;
    let maxInViewTop = bottomInViewBound;
    if (minInViewTop > maxInViewTop) {
      const mid = (minInViewTop + maxInViewTop) / 2;
      minInViewTop = mid;
      maxInViewTop = mid;
    }

    for (let index = start; index < firstVisibleIndex; index++) {
      const offset = index - start;
      nextNodeTopMap[groups[index].dayKey] = topDockStart + offset * MIXED_TIMELINE_OUTSIDE_GAP;
    }

    for (const index of inViewIndexes) {
      if (index < start || index > end) {
        continue;
      }
      const rawTop = inViewTopMap.get(index);
      if (rawTop !== undefined) {
        nextNodeTopMap[groups[index].dayKey] = Math.max(minInViewTop, Math.min(maxInViewTop, rawTop));
      }
    }

    for (let index = lastVisibleIndex + 1; index <= end; index++) {
      const offset = index - (lastVisibleIndex + 1);
      nextNodeTopMap[groups[index].dayKey] = bottomDockStart + offset * MIXED_TIMELINE_OUTSIDE_GAP;
    }
  } else {
    // 尚未测量到可视节点时，按焦点日期做均匀占位，避免时间轴空白跳动。
    const { start: fallbackStart, end: fallbackEnd } = buildTimelineWindow(
      groups.length,
      focusIndex,
      MIXED_TIMELINE_WINDOW_RADIUS
    );
    const range = Math.max(1, fallbackEnd - fallbackStart);
    const availableHeight = Math.max(
      0,
      visibleTimelineBottomInBox - visibleTimelineTopInBox - MIXED_TIMELINE_EDGE_PADDING * 2
    );
    for (let index = fallbackStart; index <= fallbackEnd; index++) {
      const ratio = (index - fallbackStart) / range;
      nextNodeTopMap[groups[index].dayKey] =
        visibleTimelineTopInBox + MIXED_TIMELINE_EDGE_PADDING + ratio * availableHeight;
    }
  }

  mixedDayInViewMap.value = nextInViewMap;
  mixedTimelineNodeTopMap.value = nextNodeTopMap;
  mixedTimelineHeight.value = timelineHeight;
  mixedTimelineWindow.value = { start, end };
  mixedTimelineFocusIndex.value = focusIndex;
}

/**
 * 计算“按作者”子侧栏高亮状态：
 * - 以作者分段在可视区域内的可见比例判定；
 * - 高亮可视区域内最靠上的作者；
 * - 无可视作者时回退到当前滚动位置下的首个作者。
 */
function updateByAuthorNavState(): void {
  if (!visible.value || mode.value === 'mixed') {
    resetByAuthorNavState();
    return;
  }

  const container = listRef.value;
  const sections = byAuthorNavItems.value;
  if (!container || sections.length === 0) {
    resetByAuthorNavState();
    return;
  }

  const mainEl = container.closest('.bbe-main');
  const toolbarEl = mainEl?.querySelector('.bbe-toolbar');
  const listRect = container.getBoundingClientRect();
  const toolbarRect = toolbarEl instanceof HTMLElement ? toolbarEl.getBoundingClientRect() : null;
  const viewTopPx = Math.max(listRect.top, toolbarRect?.bottom ?? listRect.top);
  const viewBottomPx = listRect.bottom;
  const hasScrolledIntoByAuthorList = container.scrollTop > AUTHOR_TITLE_STICKY_SCROLLTOP_EPSILON_PX;

  let activeMid: number | null = null;
  let fallbackMid: number | null = null;
  let nextMid: number | null = null;
  let measuredCount = 0;
  const nextStickyTitleMap: Record<number, boolean> = {};

  for (const author of sections) {
    const sectionEl = byAuthorSectionElements.get(author.authorMid);
    if (!sectionEl) {
      continue;
    }
    measuredCount++;

    const sectionRect = sectionEl.getBoundingClientRect();
    const sectionTopPx = sectionRect.top;
    const sectionBottomPx = sectionRect.bottom;
    const visibleTopPx = Math.max(sectionTopPx, viewTopPx);
    const visibleBottomPx = Math.min(sectionBottomPx, viewBottomPx);
    const visibleHeight = Math.max(0, visibleBottomPx - visibleTopPx);
    const sectionHeight = Math.max(1, sectionRect.height);
    const visibleRatio = visibleHeight / sectionHeight;
    const titleEl = sectionEl.querySelector('.bbe-author-title');
    const anchorEl = sectionEl.querySelector('.bbe-author-scroll-anchor');
    if (titleEl instanceof HTMLElement && anchorEl instanceof HTMLElement) {
      const titleRect = titleEl.getBoundingClientRect();
      const anchorRect = anchorEl.getBoundingClientRect();
      /**
       * sticky 视觉态直接比较“静态锚点”和“标题当前 rect”：
       * - 未 sticky 时，标题 top 应与锚点 top 基本重合；
       * - 进入 sticky 后，标题会相对锚点被向下钉住，因此 title.top > anchor.top；
       * - 但首个作者在 scrollTop=0 时会被浏览器原生 sticky 机制立即下压到 top:8px，
       *   这不应算作“用户感知到的 sticky 态”，因此还要额外要求列表已经发生实际滚动；
       * - 只要标题仍有一部分可见，就继续保留 sticky 样式，直到完全离开可视区。
       */
      const titleDetachedFromAnchor = titleRect.top > anchorRect.top + AUTHOR_TITLE_STICKY_EPSILON_PX;
      const titleStillVisible = titleRect.bottom > viewTopPx + AUTHOR_TITLE_STICKY_EPSILON_PX;
      nextStickyTitleMap[author.authorMid] = hasScrolledIntoByAuthorList && titleDetachedFromAnchor && titleStillVisible;
    }

    if (activeMid === null && visibleRatio > BY_AUTHOR_VISIBLE_RATIO_THRESHOLD) {
      activeMid = author.authorMid;
    }

    // 只剩下 10% 可见时不再继续占据 active，优先切换到后续作者。
    if (
      fallbackMid === null &&
      sectionBottomPx > viewTopPx + 1 &&
      visibleRatio > BY_AUTHOR_FALLBACK_VISIBLE_RATIO_THRESHOLD
    ) {
      fallbackMid = author.authorMid;
    }
    if (nextMid === null && sectionTopPx >= viewTopPx + 1) {
      nextMid = author.authorMid;
    }
  }

  if (measuredCount === 0) {
    // 初始渲染时 section 引用可能尚未挂载，先稳定选第一个，下一帧再按真实可见比例重算。
    byAuthorActiveMid.value = byAuthorActiveMid.value ?? sections[0]?.authorMid ?? null;
    byAuthorStickyTitleMap.value = {};
    requestAnimationFrame(() => {
      if (visible.value && mode.value !== 'mixed') {
        updateByAuthorNavState();
      }
    });
    return;
  }

  if (activeMid === null) {
    activeMid = fallbackMid ?? nextMid ?? sections[sections.length - 1]?.authorMid ?? null;
  }
  byAuthorActiveMid.value = activeMid;
  byAuthorStickyTitleMap.value = nextStickyTitleMap;
}

function isAuthorTitleStuck(authorMid: number): boolean {
  return byAuthorStickyTitleMap.value[authorMid] === true;
}

/**
 * 统一计算“按作者”标题真正的 sticky 停靠线：
 * - 先扣除工具栏遮挡；
 * - 再加上滚动容器自身的 padding-top；
 * - 最后叠加标题的 sticky top 偏移。
 */
function resolveByAuthorStickyTopPx(container: HTMLElement, toolbarEl: Element | null): number {
  const listRect = container.getBoundingClientRect();
  const listPaddingTopPx = Number.parseFloat(window.getComputedStyle(container).paddingTop) || 0;
  const toolbarRect = toolbarEl instanceof HTMLElement ? toolbarEl.getBoundingClientRect() : null;
  const visibleTopPx = Math.max(listRect.top, toolbarRect?.bottom ?? listRect.top);
  return visibleTopPx + listPaddingTopPx + AUTHOR_TITLE_STICKY_TOP_OFFSET_PX;
}

function startAuthorPagePoll(maxAttempts: number): void {
  stopAuthorPagePoll();

  let attempts = 0;

  const scheduleNext = (): void => {
    if (!hasPendingAuthorPageTargets()) {
      stopAuthorPagePoll();
      return;
    }

    if (attempts >= maxAttempts) {
      stopAuthorPagePoll();
      pendingAuthorPageTargetMap.value = {};
      byAuthorPageLoadingMap.value = {};
      showErrorToast('分页任务仍在执行，请稍后重试目标页');
      return;
    }

    authorPagePollTimer = window.setTimeout(() => {
      authorPagePollTimer = null;
      attempts += 1;

      void refreshFeedForPendingAuthorPages()
        .catch(() => {
          // 分页兜底轮询中的错误静默忽略，等待下一次重试或后台通知。
        })
        .finally(() => {
          scheduleNext();
        });
    }, getAuthorPagePollDelay(attempts));
  };

  scheduleNext();
}

function handleAuthorPageStatusMessage(message: AuthorPageStatusMessage): void {
  if (!visible.value) {
    return;
  }

  const { groupId, mid, pn, status, error } = message.payload;
  if (activeGroupId.value !== groupId) {
    return;
  }

  const pendingTarget = pendingAuthorPageTargetMap.value[mid];
  if (pendingTarget !== pn) {
    return;
  }

  if (status === 'failed') {
    setPendingAuthorPageTarget(mid);
    setAuthorPageLoading(mid, false);
    if (!hasPendingAuthorPageTargets()) {
      stopAuthorPagePoll();
    }
    showErrorToast(error ?? `第 ${pn} 页加载失败`);
    return;
  }

  void refreshFeedForPendingAuthorPages().catch(() => {
    // 通知到达后的即时刷新失败时，保留兜底轮询继续等待。
  });
}

/**
 * 启动轮询：每 POLL_INTERVAL_MS 重新拉取 feed，直到 cacheStatus 变为 ready 或达到最大次数。
 */
function startPoll(maxAttempts: number): void {
  stopPoll();
  let attempts = 0;

  pollTimer = window.setInterval(async () => {
    attempts++;
    if (attempts >= maxAttempts) {
      stopPoll();
      generating.value = false;
      refreshing.value = false;
      if (Object.keys(pendingAuthorPageTargetMap.value).length > 0) {
        pendingAuthorPageTargetMap.value = {};
        showErrorToast('分页任务仍在执行，请稍后重试目标页');
      }
      return;
    }

    try {
      const resp = await sendMessage({
        type: 'GET_GROUP_FEED',
        payload: {
          groupId: activeGroupId.value,
          mode: mode.value,
          recentDays: selectedRecentDays.value,
          activeReadMarkTs: activeTrackingReadMarkTs.value,
          showAllForMixed: mode.value === 'mixed' && mixedShowAll.value,
          allPostsFilter: getAllPostsFilterForRequest(),
          byAuthorSortByLatest: byAuthorSortByLatest.value
        }
      });

      if (!resp.ok || !resp.data) return;

      if (resp.data.cacheStatus === 'ready') {
        stopPoll();
        generating.value = false;
        refreshing.value = false;
        feed.value = resp.data;
        syncAuthorPaginationStateWithFeed();
        applyFeedWarning(resp.data);
        readMarkTimestamps.value = resp.data.readMarkTimestamps;
        graceReadMarkTs.value = resp.data.graceReadMarkTs;
        syncSelectedReadFilterKey();

        await fetchClickedVideos();
        await loadSummary();
        return;
      }

      // 刷新尚未完成时，若已出现部分可展示内容，则先展示增量结果并继续轮询。
      if (hasRenderableFeedData(resp.data)) {
        feed.value = resp.data;
        syncAuthorPaginationStateWithFeed();
        applyFeedWarning(resp.data);
        readMarkTimestamps.value = resp.data.readMarkTimestamps;
        graceReadMarkTs.value = resp.data.graceReadMarkTs;
      }
    } catch {
      // 轮询中的错误静默忽略
    }
  }, POLL_INTERVAL_MS);
}

async function loadFeed(options?: { loadMore?: boolean }): Promise<void> {
  if (!activeGroupId.value) {
    return;
  }

  const isLoadMore = Boolean(options?.loadMore);
  if (isLoadMore) {
    loadingMore.value = true;
  } else {
    loading.value = true;
  }

  try {
    const resp = await sendMessage({
      type: 'GET_GROUP_FEED',
      payload: {
        groupId: activeGroupId.value,
        mode: mode.value,
        loadMore: options?.loadMore,
        recentDays: selectedRecentDays.value,
        activeReadMarkTs: activeTrackingReadMarkTs.value,
        showAllForMixed: mode.value === 'mixed' && mixedShowAll.value,
        allPostsFilter: getAllPostsFilterForRequest(),
        byAuthorSortByLatest: byAuthorSortByLatest.value
      }
    });

    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '加载分组内容失败');
    }

    // 缓存尚未就绪，启动轮询等待
    if (resp.data.cacheStatus === 'generating') {
      generating.value = true;
      if (hasRenderableFeedData(resp.data)) {
        feed.value = resp.data;
        syncAuthorPaginationStateWithFeed();
        applyFeedWarning(resp.data);
        readMarkTimestamps.value = resp.data.readMarkTimestamps;
        graceReadMarkTs.value = resp.data.graceReadMarkTs;
      } else {
        feed.value = null;
        syncAuthorPaginationStateWithFeed();
        applyFeedWarning(null);
      }
      await loadSummary();
      startPoll(POLL_MAX_REFRESHING);
      return;
    }

    // 加载更多时增量追加，避免整体替换导致列表跳动
    if (isLoadMore && feed.value) {
      const existingBvids = new Set(feed.value.mixedVideos.map((v) => v.bvid));
      const newVideos = resp.data.mixedVideos.filter((v) => !existingBvids.has(v.bvid));
      feed.value.mixedVideos.push(...newVideos);
      feed.value.hasMoreForMixed = resp.data.hasMoreForMixed;
      feed.value.warningMsg = resp.data.warningMsg;
    } else {
      feed.value = resp.data;
    }
    syncAuthorPaginationStateWithFeed();
    applyFeedWarning(resp.data);

    readMarkTimestamps.value = resp.data.readMarkTimestamps;
    graceReadMarkTs.value = resp.data.graceReadMarkTs;
    syncSelectedReadFilterKey();

    await fetchClickedVideos();
    if (!options?.loadMore) {
      await loadSummary();
    }
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

async function reloadFeedWithReadMark(options?: { silent?: boolean }): Promise<void> {
  const silent = options?.silent === true;
  if (!silent) {
    loading.value = true;
  }
  try {
    const resp = await sendMessage({
      type: 'GET_GROUP_FEED',
      payload: {
        groupId: activeGroupId.value,
        mode: mode.value,
        recentDays: selectedRecentDays.value,
        activeReadMarkTs: activeTrackingReadMarkTs.value,
        showAllForMixed: mode.value === 'mixed' && mixedShowAll.value,
        allPostsFilter: getAllPostsFilterForRequest(),
        byAuthorSortByLatest: byAuthorSortByLatest.value
      }
    });

    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '加载分组内容失败');
    }

    feed.value = resp.data;
    syncAuthorPaginationStateWithFeed();
    applyFeedWarning(resp.data);
    readMarkTimestamps.value = resp.data.readMarkTimestamps;
    graceReadMarkTs.value = resp.data.graceReadMarkTs;
    syncSelectedReadFilterKey();
    await fetchClickedVideos();
    await loadSummary();
  } finally {
    if (!silent) {
      loading.value = false;
    }
  }
}

async function openDrawer(): Promise<void> {
  visible.value = true;
  clickedMap.value = {};
  reviewedOverrideMap.value = {};
  likedStateMap.value = {};
  followPendingMap.value = {};
  authorLikePendingMap.value = {};
  resetAuthorPaginationState();
  warningMsg.value = '';

  try {
    await loadSummary();

    // 无分组时自动切换到设置页
    if (summaries.value.length === 0) {
      activeEntryId.value = ENTRY_ID.SETTINGS;
      return;
    }

    if (!activeGroupId.value) {
      const preferredLastGroupId = summaries.value.some((item) => item.groupId === lastGroupIdFromSummary.value)
        ? lastGroupIdFromSummary.value
        : '';
      activeGroupId.value = preferredLastGroupId || summaries.value[0]?.groupId || '';
    }

    if (!activeGroupId.value) {
      activeEntryId.value = ENTRY_ID.SETTINGS;
      return;
    }
    activeEntryId.value = activeGroupId.value;

    const summary = summaries.value.find((s) => s.groupId === activeGroupId.value);
    restoreGroupViewState(summary);

    await loadFeed();
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '加载失败');
  }
}

function closeDrawer(): void {
  visible.value = false;
  likedStateMap.value = {};
  followPendingMap.value = {};
  authorLikePendingMap.value = {};
  resetAuthorPaginationState();
  warningMsg.value = '';
}

/**
 * 抽屉打开期间锁定页面滚动：
 * - 同时作用于 html 与 body，兼容站点把滚动容器挂在不同节点上的情况。
 * - 通过 class 切换，避免直接改写内联样式导致状态难以恢复。
 */
function setPageScrollLock(locked: boolean): void {
  const html = document.documentElement;
  const body = document.body;

  if (locked) {
    html.classList.add(PAGE_SCROLL_LOCK_CLASS);
    body.classList.add(PAGE_SCROLL_LOCK_CLASS);
    return;
  }

  html.classList.remove(PAGE_SCROLL_LOCK_CLASS);
  body.classList.remove(PAGE_SCROLL_LOCK_CLASS);
}

async function manualRefresh(): Promise<void> {
  if (!activeGroupId.value) return;

  try {
    refreshing.value = true;
    const resp = await sendMessage({
      type: 'MANUAL_REFRESH',
      payload: { groupId: activeGroupId.value }
    });

    if (!resp.ok) {
      throw new Error(resp.error ?? '刷新请求失败');
    }

    // 提交成功，启动轮询等待刷新完成
    startPoll(POLL_MAX_REFRESHING);
  } catch (error) {
    refreshing.value = false;
    showErrorToast(error instanceof Error ? error.message : '刷新失败');
  }
}

async function selectEntry(entryId: string): Promise<void> {
  if (entryId === activeEntryId.value) {
    return;
  }

  stopPoll();
  generating.value = false;
  refreshing.value = false;
  activeEntryId.value = entryId;

  if (isVirtualEntryId(entryId)) {
    return;
  }

  activeGroupId.value = entryId;
  followPendingMap.value = {};
  authorLikePendingMap.value = {};
  likedStateMap.value = {};
  resetAuthorPaginationState();
  warningMsg.value = '';

  const summary = summaries.value.find((s) => s.groupId === entryId);
  restoreGroupViewState(summary);

  try {
    await loadFeed();
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '切换分组失败');
  }
}

async function switchMode(nextMode: ViewMode): Promise<void> {
  if (mode.value === nextMode) {
    return;
  }

  mode.value = nextMode;
  syncSelectedReadFilterKey();

  try {
    await loadFeed();
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '切换视图失败');
  }
}

async function onTrackingReadFilterChange(): Promise<void> {
  const next = parseRecentFilterKey(selectedReadFilterKey.value);
  mixedShowAll.value = mode.value === 'mixed' && next.showAllForMixed;
  if (next.recentDays) {
    selectedRecentDays.value = next.recentDays;
    activeTrackingReadMarkTs.value = undefined;
  }
  if (next.useLatestReadMark) {
    mixedShowAll.value = false;
    activeTrackingReadMarkTs.value = latestGroupReadMarkTs.value > 0 ? latestGroupReadMarkTs.value : undefined;
  }
  resetAuthorPaginationState();
  try {
    await refreshMixedTimelineAfterReadBoundaryChange();
    await reloadFeedWithReadMark({ silent: true });
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '切换近期范围失败');
  }
}

async function onOverviewFilterChange(): Promise<void> {
  selectedAllPostsFilter.value = parseAllPostsFilterKey(selectedReadFilterKey.value);
  resetAuthorPaginationState();
  try {
    await reloadFeedWithReadMark({ silent: true });
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '切换全部投稿筛选失败');
  }
}

async function onByAuthorSortByLatestChange(): Promise<void> {
  try {
    await loadFeed();
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '切换作者排序失败');
  }
}

const byAuthorBoundaryIndexMap = computed<Record<number, number>>(() => {
  const result: Record<number, number> = {};
  for (const author of byAuthorFeeds.value) {
    const boundaryTs = author.effectiveReadBoundaryTs ?? 0;
    const visibleVideos = getAuthorVisibleVideos(author);
    if (boundaryTs <= 0) {
      result[author.authorMid] = -1;
      continue;
    }
    if (author.hasOnlyExtraOlderVideos || visibleVideos.length < 2) {
      result[author.authorMid] = -1;
      continue;
    }

    let boundaryIndex = -1;
    for (let index = 1; index < visibleVideos.length; index++) {
      // 视频按发布时间倒序排列：第一次从“>=边界”跨到“<边界”的位置就是分界点。
      if (visibleVideos[index - 1].pubdate >= boundaryTs && visibleVideos[index].pubdate < boundaryTs) {
        boundaryIndex = index;
        break;
      }
    }
    result[author.authorMid] = boundaryIndex;
  }

  return result;
});

function isAuthorBoundaryIndex(author: AuthorFeed, index: number): boolean {
  return byAuthorBoundaryIndexMap.value[author.authorMid] === index;
}

const mixedAuthorReadMarkBoundaryMap = computed<Record<number, number>>(() => {
  if (!feed.value) {
    return {};
  }
  const result: Record<number, number> = {};
  for (const author of feed.value.videosByAuthor) {
    if (author.hasAuthorReadMarkOverride !== true) {
      continue;
    }
    const boundaryTs = author.effectiveReadBoundaryTs ?? 0;
    if (boundaryTs > 0) {
      result[author.authorMid] = boundaryTs;
    }
  }
  return result;
});

/**
 * 时间流下命中“作者级逻辑已阅”的视频卡片默认半透明。
 * hover 时由样式恢复为不透明，避免影响快速扫读。
 */
function shouldDimMixedVideo(video: VideoItem): boolean {
  if (mode.value !== 'mixed') {
    return false;
  }
  const boundaryTs = mixedAuthorReadMarkBoundaryMap.value[video.authorMid];
  return typeof boundaryTs === 'number' && boundaryTs > 0 && video.pubdate <= boundaryTs;
}

async function markCurrentGroupRead(): Promise<void> {
  if (!activeGroupId.value || isAllGroupEntry.value) {
    return;
  }

  try {
    const resp = await sendMessage({
      type: 'MARK_GROUP_READ_MARK',
      payload: { groupId: activeGroupId.value }
    });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '标记已阅失败');
    }

    const latestTs = resp.data.marks[activeGroupId.value]?.timestamps[0];
    if (typeof latestTs === 'number' && latestTs > 0) {
      readMarkTimestamps.value = resp.data.marks[activeGroupId.value]?.timestamps ?? [];
      activeTrackingReadMarkTs.value = latestTs;
    }
    syncSelectedReadFilterKey();
    await refreshMixedTimelineAfterReadBoundaryChange();
    await reloadFeedWithReadMark({ silent: true });
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '标记已阅失败');
  }
}

async function markReadToMixedDay(dayKey: string): Promise<void> {
  if (isAllGroupEntry.value) {
    return;
  }
  const readMarkTs = getNextDayStartSecondsFromDayKey(dayKey);
  if (!readMarkTs || readMarkTs <= 0) {
    return;
  }
  await setGroupReadMarkByTs(readMarkTs, '设置按日已阅失败');
}

function getMixedTimelineNodeTitle(item: MixedTimelineItem): string {
  if (
    item.isReadActive &&
    activeTrackingReadMarkTs.value &&
    activeTrackingReadMarkTs.value > 0
  ) {
    return `左键设为已阅到${item.label}，右键清除已阅基线`;
  }
  return `设为已阅到${item.label}`;
}

function resolveMixedReadMarkTsByBoundaryIndex(boundaryIndex: number): number {
  const videos = feed.value?.mixedVideos ?? [];
  if (boundaryIndex <= 0 || boundaryIndex >= videos.length) {
    return 0;
  }
  const newerTs = videos[boundaryIndex - 1]?.pubdate ?? 0;
  const olderTs = videos[boundaryIndex]?.pubdate ?? 0;
  if (newerTs <= 0 || olderTs <= 0) {
    return 0;
  }

  // 分组已阅会被后端归一化到“分钟精度（秒归零）”，因此这里要优先选择“older 所在分钟的下一分钟”。
  // 这样在多数场景下可确保最终落库值满足：newerTs >= readMarkTs > olderTs，
  // 从而让“上次看到这里”横线稳定落在用户点击的两张卡片之间。
  const nextMinuteBoundary = Math.floor(olderTs / 60) * 60 + 60;
  if (nextMinuteBoundary <= newerTs) {
    return nextMinuteBoundary;
  }

  // 当两条视频处于同一分钟（不存在可用分钟边界）时，退化为旧策略。
  if (olderTs >= newerTs) {
    return newerTs;
  }
  return Math.min(newerTs, olderTs + 1);
}

async function setMixedReadMarkFromBoundaryIndex(boundaryIndex: number): Promise<void> {
  if (isAllGroupEntry.value) {
    return;
  }
  const readMarkTs = resolveMixedReadMarkTsByBoundaryIndex(boundaryIndex);
  await setGroupReadMarkByTs(readMarkTs, '设置时间流已阅失败');
}

async function setGroupReadMarkByTs(readMarkTs: number, fallbackErrorMessage: string): Promise<void> {
  if (!activeGroupId.value || isAllGroupEntry.value || readMarkTs <= 0) {
    return;
  }

  try {
    const resp = await sendMessage({
      type: 'MARK_GROUP_READ_MARK',
      payload: {
        groupId: activeGroupId.value,
        readMarkTs
      }
    });
    if (!resp.ok) {
      throw new Error(resp.error ?? fallbackErrorMessage);
    }
    // 后端会把分组已阅时间点归一化到分钟精度，这里必须以实际落库值回填，
    // 否则会出现 select 无法匹配选项（下拉空白）与筛选基线偏移的问题。
    const latestTs = resp.data?.marks?.[activeGroupId.value]?.timestamps?.[0];
    if (typeof latestTs === 'number' && latestTs > 0) {
      readMarkTimestamps.value = resp.data?.marks?.[activeGroupId.value]?.timestamps ?? [];
      activeTrackingReadMarkTs.value = latestTs;
    }
    syncSelectedReadFilterKey();
    await refreshMixedTimelineAfterReadBoundaryChange();
    await reloadFeedWithReadMark({ silent: true });
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : fallbackErrorMessage);
  }
}

async function clearCurrentGroupReadMark(fallbackErrorMessage: string): Promise<void> {
  if (!activeGroupId.value || isAllGroupEntry.value) {
    return;
  }

  try {
    const resp = await sendMessage({
      type: 'CLEAR_GROUP_READ_MARK',
      payload: { groupId: activeGroupId.value }
    });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? fallbackErrorMessage);
    }
    readMarkTimestamps.value = resp.data.marks[activeGroupId.value]?.timestamps ?? [];
    activeTrackingReadMarkTs.value = undefined;
    syncSelectedReadFilterKey();
    await refreshMixedTimelineAfterReadBoundaryChange();
    await reloadFeedWithReadMark({ silent: true });
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : fallbackErrorMessage);
  }
}

async function onMixedTimelineNodeContextMenu(item: MixedTimelineItem): Promise<void> {
  if (
    isAllGroupEntry.value ||
    item.isReadActive !== true ||
    !activeTrackingReadMarkTs.value ||
    activeTrackingReadMarkTs.value <= 0
  ) {
    return;
  }
  await clearCurrentGroupReadMark('清除时间流已阅失败');
}

async function undoLatestGroupReadMark(): Promise<void> {
  if (!activeGroupId.value || activeGroupId.value === ENTRY_ID.ALL) {
    return;
  }

  try {
    const resp = await sendMessage({
      type: 'UNDO_GROUP_READ_MARK',
      payload: { groupId: activeGroupId.value }
    });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '撤销上次看到失败');
    }
    readMarkTimestamps.value = resp.data.marks[activeGroupId.value]?.timestamps ?? [];
    activeTrackingReadMarkTs.value = readMarkTimestamps.value[0] ?? undefined;
    syncSelectedReadFilterKey();
    await refreshMixedTimelineAfterReadBoundaryChange();
    await reloadFeedWithReadMark({ silent: true });
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '撤销上次看到失败');
  }
}

async function onVideoClick(bvid: string): Promise<void> {
  clickedMap.value = { ...clickedMap.value, [bvid]: Date.now() };
  try {
    await sendMessage({ type: 'RECORD_VIDEO_CLICK', payload: { bvid } });
  } catch {
    // 静默失败
  }
}

function isVideoReviewed(video: VideoItem): boolean {
  if (Object.prototype.hasOwnProperty.call(reviewedOverrideMap.value, video.bvid)) {
    return reviewedOverrideMap.value[video.bvid] === true;
  }
  return clickedMap.value[video.bvid] !== undefined || (video.playbackPosiiton ?? 0) >= 10;
}

async function onToggleVideoReviewed(payload: { bvid: string; reviewed: boolean }): Promise<void> {
  const prevMap = reviewedOverrideMap.value;
  reviewedOverrideMap.value = {
    ...reviewedOverrideMap.value,
    [payload.bvid]: payload.reviewed
  };
  try {
    const resp = await sendMessage({
      type: 'SET_VIDEO_REVIEWED',
      payload
    });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '设置视频已阅状态失败');
    }
    await reloadFeedWithReadMark({ silent: true });
  } catch (error) {
    reviewedOverrideMap.value = prevMap;
    showErrorToast(error instanceof Error ? error.message : '设置视频已阅状态失败');
  }
}

async function toggleAuthorIgnoreUnread(author: AuthorFeed): Promise<void> {
  const nextIgnore = author.ignoreUnreadCount !== true;
  try {
    const resp = await sendMessage({
      type: 'SET_AUTHOR_IGNORE_UNREAD',
      payload: {
        mid: author.authorMid,
        ignoreUnreadCount: nextIgnore
      }
    });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '设置作者不计算未读失败');
    }
    await reloadFeedWithReadMark({ silent: true });
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '设置作者不计算未读失败');
  }
}

async function toggleGroupExcludeUnread(): Promise<void> {
  const summary = activeGroupSummary.value;
  if (!summary || isAllGroupEntry.value) {
    return;
  }

  try {
    const resp = await sendMessage({
      type: 'SET_GROUP_EXCLUDE_UNREAD',
      payload: {
        groupId: summary.groupId,
        excludeFromUnreadCount: summary.excludeFromUnreadCount !== true
      }
    });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '设置分组不计算未读失败');
    }
    await reloadFeedWithReadMark({ silent: true });
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '设置分组不计算未读失败');
  }
}

async function markAuthorReadNow(author: AuthorFeed): Promise<void> {
  const nowTs = Math.floor(Date.now() / 1000);
  await setAuthorReadMark(author.authorMid, nowTs);
}

function resolveAuthorReadMarkTsByBoundaryIndex(authorMid: number, boundaryIndex: number): number {
  const visibleVideos = byAuthorVisibleVideosMap.value[authorMid] ?? [];
  if (boundaryIndex <= 0 || boundaryIndex >= visibleVideos.length) {
    return 0;
  }

  const newerVideo = visibleVideos[boundaryIndex - 1];
  const olderVideo = visibleVideos[boundaryIndex];
  const newerTs = newerVideo?.pubdate ?? 0;
  const olderTs = olderVideo?.pubdate ?? 0;
  if (newerTs <= 0 || olderTs <= 0) {
    return 0;
  }

  /**
   * 目标是把边界稳定放在“newer 与 older”之间：
   * - 常规情况下取 olderTs + 1，可保证 newer >= 边界 且 older < 边界；
   * - 当出现同秒投稿等无法精确切分的情况，退化为 newerTs，至少保证可落盘为作者级已阅点。
   */
  if (olderTs >= newerTs) {
    return newerTs;
  }
  return Math.min(newerTs, olderTs + 1);
}

async function setAuthorReadMark(authorMid: number, readMarkTs: number): Promise<void> {
  if (readMarkTs <= 0) {
    return;
  }

  try {
    const resp = await sendMessage({
      type: 'SET_AUTHOR_READ_MARK',
      payload: {
        mid: authorMid,
        readMarkTs
      }
    });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '设置作者已阅失败');
    }
    await reloadFeedWithReadMark({ silent: true });
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '设置作者已阅失败');
  }
}

async function undoAuthorReadMark(authorMid: number): Promise<void> {
  try {
    const resp = await sendMessage({
      type: 'UNDO_AUTHOR_READ_MARK',
      payload: {
        mid: authorMid
      }
    });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '撤销作者已阅失败');
    }
    await reloadFeedWithReadMark({ silent: true });
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '撤销作者已阅失败');
  }
}

async function setAuthorReadMarkFromBoundaryIndex(author: AuthorFeed, boundaryIndex: number): Promise<void> {
  const readMarkTs = resolveAuthorReadMarkTsByBoundaryIndex(author.authorMid, boundaryIndex);
  await setAuthorReadMark(author.authorMid, readMarkTs);
}

function onAuthorBoundaryContextMenu(author: AuthorFeed, boundaryIndex: number): void {
  if (!isAuthorBoundaryIndex(author, boundaryIndex)) {
    return;
  }
  void clearAuthorReadMarkFromBoundary(author);
}

async function clearAuthorReadMarkFromBoundary(author: AuthorFeed): Promise<void> {
  if (!author.hasAuthorReadMarkOverride) {
    return;
  }
  await clearAuthorReadMark(author.authorMid);
}

async function clearAuthorReadMark(authorMid: number): Promise<void> {
  try {
    const resp = await sendMessage({
      type: 'CLEAR_AUTHOR_READ_MARK',
      payload: {
        mid: authorMid
      }
    });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '清除作者已阅失败');
    }
    await reloadFeedWithReadMark({ silent: true });
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '清除作者已阅失败');
  }
}

function scrollToMixedDay(dayKey: string): void {
  const container = listRef.value;
  const sectionEl = mixedDaySectionElements.get(dayKey);
  if (!container || !sectionEl) {
    return;
  }

  const sectionsOffsetTop = mixedSectionsRef.value?.offsetTop ?? 0;
  const targetTop = Math.max(0, sectionsOffsetTop + sectionEl.offsetTop - 8);
  container.scrollTo({ top: targetTop, behavior: 'smooth' });

  requestAnimationFrame(() => {
    updateMixedTimelineState();
  });
}

function scrollToAuthor(authorMid: number): void {
  const container = listRef.value;
  const sectionEl = byAuthorSectionElements.get(authorMid);
  if (!container || !sectionEl) {
    return;
  }

  const mainEl = container.closest('.bbe-main');
  const toolbarEl = mainEl?.querySelector('.bbe-toolbar');
  const anchorEl = sectionEl.querySelector('.bbe-author-scroll-anchor');
  if (!(anchorEl instanceof HTMLElement)) {
    return;
  }
  /**
   * 作者导航跳转不能再读取 sticky 标题当前坐标：
   * 一旦标题进入过 sticky，它的 rect 就不再代表自然文档位置。
   * 这里改为对齐一个零高度的静态锚点，保证无论标题是否曾 sticky，
   * 跳转都落到“标题应当吸附到的位置”。
   */
  const anchorRect = anchorEl.getBoundingClientRect();
  const stickyTopPx = resolveByAuthorStickyTopPx(container, toolbarEl);
  const delta = anchorRect.top - stickyTopPx;
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const targetTop = Math.max(0, Math.min(maxScrollTop, container.scrollTop + delta));
  container.scrollTo({ top: targetTop, behavior: 'smooth' });
  byAuthorActiveMid.value = authorMid;
}

async function refreshMixedTimelineAfterReadBoundaryChange(): Promise<void> {
  if (!visible.value || mode.value !== 'mixed') {
    return;
  }
  await nextTick();
  updateMixedTimelineState();
}

async function onListScroll(event: Event): Promise<void> {
  if (mode.value === 'mixed') {
    updateMixedTimelineState();
  } else {
    updateByAuthorNavState();
  }

  if (mode.value !== 'mixed' || loadingMore.value || loading.value || !feed.value?.hasMoreForMixed) {
    return;
  }

  const target = event.target as HTMLElement;
  const nearBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 48;

  if (!nearBottom) {
    return;
  }

  try {
    await loadFeed({ loadMore: true });
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '加载更多失败');
  }
}

async function onLoadMoreClick(): Promise<void> {
  if (mode.value !== 'mixed' || loadingMore.value || loading.value || generating.value) {
    return;
  }
  if (!feed.value?.hasMoreForMixed) {
    return;
  }

  try {
    await loadFeed({ loadMore: true });
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '加载更多失败');
  }
}

function onWindowResize(): void {
  updateMixedTimelineState();
  updateByAuthorNavState();
}

// 分组列表变更（创建/删除）后重新加载概要，当前条目合法性由 loadSummary 内部统一修正。
async function onGroupListChanged(): Promise<void> {
  try {
    await loadSummary();
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '刷新分组失败');
  }
}

async function onSettingsSaved(): Promise<void> {
  try {
    await loadSummary();
  } catch {
    // 静默忽略
  }
}

function onToggleDrawer(): void {
  if (visible.value) {
    closeDrawer();
    return;
  }

  void openDrawer();
}

function onOpenDrawer(): void {
  void openDrawer();
}

function onDocumentVisibilityChange(): void {
  if (document.hidden || !visible.value) {
    return;
  }
  void fetchClickedVideos().catch(() => {
    // 浏览器标签切回前台后的点赞态恢复失败时静默忽略，下次交互或刷新仍会再次收敛。
  });
}

function handleLikeTaskStatusMessage(message: LikeTaskStatusMessage): void {
  const { bvid, status, liked, likedAt } = message.payload;
  if (status === 'success') {
    patchVideoLikeStates([
      {
        bvid,
        liked: liked === true,
        pending: false,
        likedAt: liked === true ? (likedAt ?? Date.now()) : undefined
      }
    ]);
    return;
  }

  const prevState = likedStateMap.value[bvid];
  patchVideoLikeStates([
    {
      bvid,
      liked: prevState?.liked ?? false,
      pending: false,
      likedAt: prevState?.likedAt
    }
  ]);
}

function handleBatchLikeStatusMessage(message: BatchLikeStatusMessage): void {
  clearAuthorLikePending(message.payload.authorMid);
  if (message.payload.failedCount > 0) {
    showErrorToast(`一键点赞完成：成功 ${message.payload.successCount}，失败 ${message.payload.failedCount}`);
  }
}

function onRuntimeMessage(message: unknown): void {
  if (!message || typeof message !== 'object') {
    return;
  }

  const nextMessage = message as Partial<AuthorPageStatusMessage | LikeTaskStatusMessage | BatchLikeStatusMessage>;
  if (!nextMessage.type || !nextMessage.payload) {
    return;
  }

  if (nextMessage.type === 'AUTHOR_PAGE_STATUS') {
    handleAuthorPageStatusMessage(nextMessage as AuthorPageStatusMessage);
    return;
  }
  if (nextMessage.type === 'LIKE_TASK_STATUS') {
    handleLikeTaskStatusMessage(nextMessage as LikeTaskStatusMessage);
    return;
  }
  if (nextMessage.type === 'BATCH_LIKE_STATUS') {
    handleBatchLikeStatusMessage(nextMessage as BatchLikeStatusMessage);
  }
}

watch(visible, (nextVisible) => {
  setPageScrollLock(nextVisible);
  if (!nextVisible && listRef.value) {
    listRef.value.scrollTop = 0;
  }
  if (!nextVisible) {
    resetMixedTimelineState();
    resetByAuthorNavState();
    resetAuthorPaginationState();
    disconnectMixedTimelineResizeObserver();
  }
});

watch(
  [mixedDayGroups, byAuthorNavItems, byAuthorVisibleVideosMap, mode, visible, byAuthorSortByLatest, loading, showGeneratingPlaceholder],
  async () => {
    if (!visible.value) {
      disconnectMixedTimelineResizeObserver();
      return;
    }

    if (mode.value !== 'mixed') {
      disconnectMixedTimelineResizeObserver();
    }

    await nextTick();
    if (loading.value || showGeneratingPlaceholder.value) {
      return;
    }
    if (mode.value === 'mixed') {
      ensureMixedTimelineResizeObserver();
      updateMixedTimelineState();
    }
    if (mode.value !== 'mixed') {
      updateByAuthorNavState();
    }
    requestAnimationFrame(() => {
      if (mode.value === 'mixed') {
        updateMixedTimelineState();
      }
      if (mode.value !== 'mixed') {
        updateByAuthorNavState();
      }
    });
  },
  { flush: 'post' }
);

watch(byAuthorActiveMid, (mid) => {
  if (mid === null || mode.value === 'mixed') {
    return;
  }
  const navItemEl = byAuthorNavItemElements.get(mid);
  if (!navItemEl) {
    return;
  }
  navItemEl.scrollIntoView({ block: 'nearest' });
});

onMounted(() => {
  loadDrawerWidth();
  window.addEventListener(EXTENSION_EVENT.TOGGLE_DRAWER, onToggleDrawer);
  window.addEventListener(EXTENSION_EVENT.OPEN_DRAWER, onOpenDrawer);
  window.addEventListener('resize', onWindowResize);
  document.addEventListener('visibilitychange', onDocumentVisibilityChange);
  ext.runtime.onMessage.addListener(onRuntimeMessage);

  void loadSummary().catch((error) => {
    console.warn('[BBE] preload summary failed:', error);
  });

  summaryTimer = window.setInterval(() => {
    void loadSummary().catch((error) => {
      console.warn('[BBE] periodic summary failed:', error);
    });
  }, 60 * 1000);
});

onUnmounted(() => {
  setPageScrollLock(false);
  window.removeEventListener(EXTENSION_EVENT.TOGGLE_DRAWER, onToggleDrawer);
  window.removeEventListener(EXTENSION_EVENT.OPEN_DRAWER, onOpenDrawer);
  window.removeEventListener('resize', onWindowResize);
  document.removeEventListener('visibilitychange', onDocumentVisibilityChange);
  ext.runtime.onMessage.removeListener(onRuntimeMessage);
  disconnectMixedTimelineResizeObserver();

  if (summaryTimer) {
    window.clearInterval(summaryTimer);
    summaryTimer = null;
  }
  stopPoll();
  stopAuthorPagePoll();
});
</script>
