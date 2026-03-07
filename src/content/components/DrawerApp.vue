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
          <button class="bbe-btn" :class="{ active: mode === 'byAuthor' }" @click="switchMode('byAuthor')">未观看</button>
          <button class="bbe-btn" :class="{ active: mode === 'overview' }" @click="switchMode('overview')">概览</button>
          <label v-if="mode !== 'mixed'" class="bbe-toolbar-check">
            <input v-model="byAuthorSortByLatest" type="checkbox" @change="onByAuthorSortByLatestChange" />
            <span>按更新时间倒序</span>
          </label>
          <span class="bbe-toolbar-sep" />
          <select v-if="mode !== 'overview'" v-model="selectedReadFilterKey" class="bbe-select-sm" @change="onTrackingReadFilterChange">
            <option value="t:0">全部</option>
            <option value="t:-1">{{ graceLabel }}</option>
            <option v-for="ts in readMarkTimestamps" :key="ts" :value="`t:${ts}`">{{ formatReadMarkTs(ts) }}</option>
          </select>
          <select v-else v-model="selectedReadFilterKey" class="bbe-select-sm" @change="onOverviewFilterChange">
            <option value="o:all">全部</option>
            <option value="o:gd">{{ graceLabel }}</option>
            <option value="o:d14">14天内</option>
            <option value="o:d30">30天内</option>
            <option value="o:n10">10条</option>
            <option value="o:n30">30条</option>
          </select>
          <button v-if="mode !== 'overview'" class="bbe-btn" :disabled="loading" @click="markCurrentGroupRead">{{ markReadButtonText }}</button>
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
                  type="button"
                  class="bbe-timeline-node-btn"
                  :class="{ 'is-read-active': item.isReadActive }"
                  :title="`设为已阅到${item.label}`"
                  @click.stop="markReadToMixedDay(item.dayKey)"
                >
                  <span class="bbe-timeline-node" />
                  <span class="bbe-timeline-check" aria-hidden="true">✓</span>
                </button>
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
                          v-if="item.globalIndex > 0"
                          type="button"
                          class="bbe-mixed-read-boundary"
                          title="将该分界设置为分组已阅时间"
                          @click.stop="setMixedReadMarkFromBoundaryIndex(item.globalIndex)"
                        />
                        <VideoCard
                          :video="item.video"
                          :clicked="clickedMap[item.video.bvid] !== undefined"
                          :reviewed="isVideoReviewed(item.video)"
                          :dimmed="shouldDimMixedVideo(item.video)"
                          @click="onVideoClick"
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
              <section
                v-for="author in byAuthorFeeds"
                :key="author.authorMid"
                :ref="(el) => bindByAuthorSection(author.authorMid, el)"
                class="bbe-author-section"
              >
                <h3 class="bbe-author-title">
                  <div class="bbe-author-title-main">
                    <div class="bbe-author-title-left">
                      <a
                        class="bbe-author-link"
                        :href="`https://space.bilibili.com/${author.authorMid}`"
                        target="_blank"
                        rel="noreferrer"
                      >
                        <img v-if="author.authorFace" class="bbe-avatar" :src="author.authorFace" alt="" />
                        <span v-else class="bbe-avatar bbe-avatar-placeholder" aria-hidden="true" />
                        <span>{{ author.authorName }}</span>
                      </a>
                      <button
                        type="button"
                        class="bbe-author-follow-btn"
                        :class="{ followed: author.following, loading: isFollowPending(author.authorMid) }"
                        :disabled="isFollowPending(author.authorMid)"
                        @click="toggleAuthorFollow(author)"
                      >
                        {{ getFollowButtonText(author) }}
                      </button>
                    </div>
                    <div class="bbe-author-title-actions">
                      <button type="button" class="bbe-author-mark-read-btn" @click="markAuthorReadNow(author)">
                        标记已阅
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
                  <span
                    v-if="author.hasOnlyExtraOlderVideos && author.latestPubdate"
                    class="bbe-author-title-note"
                  >
                    最近更新：{{ formatDaysAgo(author.latestPubdate) }}
                  </span>
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
                      :reviewed="isVideoReviewed(video)"
                      @click="onVideoClick"
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
  AUTHOR_VIDEOS_PAGE_SIZE,
  EXTENSION_EVENT,
  POLL_INTERVAL_MS,
  POLL_MAX_REFRESHING,
  VIRTUAL_GROUP_ID
} from '@/shared/constants';
import { sendMessage } from '@/shared/messages';
import type { AuthorFeed, GroupFeedResult, GroupSummary, OverviewFilterKey, VideoItem, ViewMode } from '@/shared/types';
import { formatDaysAgo, formatReadMarkTs, formatRelativeMinutes } from '@/shared/utils/format';
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
const BY_AUTHOR_VISIBLE_RATIO_THRESHOLD = 0.2;
const BY_AUTHOR_FALLBACK_VISIBLE_RATIO_THRESHOLD = 0.1;
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
let userExplicitlyChoseAll = false;
const lastGroupIdFromSummary = ref('');

const selectedReadMarkTs = ref(0);
const selectedOverviewFilter = ref<OverviewFilterKey>('all');
const selectedReadFilterKey = ref('t:0');
const byAuthorSortByLatest = ref(true);
const readMarkTimestamps = ref<number[]>([]);
const graceReadMarkTs = ref(0);
const clickedMap = ref<Record<string, number>>({});
const reviewedOverrideMap = ref<Record<string, boolean>>({});
const followPendingMap = ref<Record<number, boolean>>({});
const byAuthorPageMap = ref<Record<number, number>>({});
const byAuthorPageJumpInputMap = ref<Record<number, string>>({});
const byAuthorPageLoadingMap = ref<Record<number, boolean>>({});
const mixedDaySectionElements = new Map<string, HTMLElement>();
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
 */
function showErrorToast(message: string): void {
  const text = message.trim();
  if (!text) {
    return;
  }
  const id = ++toastSeq;
  const next = [...toasts.value, { id, message: text }];
  toasts.value = next.slice(-4);
  window.setTimeout(() => {
    toasts.value = toasts.value.filter((item) => item.id !== id);
  }, 3200);
}

function buildTrackingFilterKey(ts: number): string {
  return `t:${ts}`;
}

function buildOverviewFilterKey(filter: OverviewFilterKey): string {
  return `o:${filter}`;
}

function normalizeOverviewFilter(filter: OverviewFilterKey | undefined): OverviewFilterKey {
  if (filter === 'all' || filter === 'gd' || filter === 'd14' || filter === 'd30' || filter === 'n10' || filter === 'n30') {
    return filter;
  }
  return 'all';
}

const activeOverviewFilter = computed<OverviewFilterKey>(() => {
  if (mode.value !== 'overview') {
    return 'none';
  }
  return normalizeOverviewFilter(selectedOverviewFilter.value);
});

function syncSelectedReadFilterKey(): void {
  if (mode.value === 'overview') {
    selectedReadFilterKey.value = buildOverviewFilterKey(normalizeOverviewFilter(selectedOverviewFilter.value));
    return;
  }
  selectedReadFilterKey.value = buildTrackingFilterKey(selectedReadMarkTs.value);
}

function parseTrackingFilterKey(key: string): number {
  const ts = Number(key.slice(2));
  return Number.isFinite(ts) ? ts : 0;
}

function parseOverviewFilterKey(key: string): OverviewFilterKey {
  if (!key.startsWith('o:')) {
    return normalizeOverviewFilter(selectedOverviewFilter.value);
  }
  const raw = key.slice(2) as OverviewFilterKey;
  return normalizeOverviewFilter(raw);
}

function getOverviewFilterForRequest(): OverviewFilterKey {
  return normalizeOverviewFilter(selectedOverviewFilter.value);
}

const mixedDayGroups = computed(() => {
  if (!feed.value) {
    return [];
  }
  return buildMixedDayGroups(feed.value.mixedVideos);
});

const effectiveReadBoundaryTs = computed(() => {
  if (activeOverviewFilter.value !== 'none') {
    return 0;
  }
  if (selectedReadMarkTs.value === 0) {
    return 0;
  }
  if (selectedReadMarkTs.value === -1) {
    return graceReadMarkTs.value;
  }
  return selectedReadMarkTs.value > 0 ? selectedReadMarkTs.value : 0;
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

const isByAuthorPaginationEnabled = computed(
  () => mode.value === 'byAuthor' && selectedReadMarkTs.value === 0
);

function getAuthorApiPageSize(author: AuthorFeed): number {
  return Math.max(1, Number(author.apiPageSize) || feed.value?.byAuthorPageSize || AUTHOR_VIDEOS_PAGE_SIZE);
}

function getAuthorTotalPages(author: AuthorFeed): number {
  const pageSize = getAuthorApiPageSize(author);
  const cachedMaxPn = Math.max(1, Number(author.maxCachedPn) || 1);
  const cachedPageByVideoCount = Math.max(1, Math.ceil(author.videos.length / pageSize));
  const knownTotalCount = Number(author.totalVideoCount);
  if (Number.isFinite(knownTotalCount) && knownTotalCount >= 0) {
    return Math.max(1, Math.ceil(knownTotalCount / pageSize));
  }
  if (author.hasMorePages) {
    return Math.max(cachedMaxPn + 1, cachedPageByVideoCount);
  }
  return Math.max(cachedMaxPn, cachedPageByVideoCount);
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

function normalizeVideoSourcePn(video: VideoItem): number {
  return Math.max(1, Number(video.meta?.sourcePn) || 1);
}

const byAuthorVisibleVideosMap = computed<Record<number, VideoItem[]>>(() => {
  const result: Record<number, VideoItem[]> = {};
  for (const author of byAuthorFeeds.value) {
    if (!isByAuthorPaginationEnabled.value) {
      result[author.authorMid] = author.videos;
      continue;
    }
    const currentPage = getAuthorCurrentPage(author);
    result[author.authorMid] = author.videos.filter((video) => normalizeVideoSourcePn(video) === currentPage);
  }
  return result;
});

function getAuthorVisibleVideos(author: AuthorFeed): VideoItem[] {
  return byAuthorVisibleVideosMap.value[author.authorMid] ?? [];
}

function shouldShowAuthorPagination(author: AuthorFeed): boolean {
  return isByAuthorPaginationEnabled.value && getAuthorTotalPages(author) > 1;
}

function isAuthorPageLoading(authorMid: number): boolean {
  return byAuthorPageLoadingMap.value[authorMid] === true;
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
  if (!isByAuthorPaginationEnabled.value || isAuthorPageLoading(author.authorMid)) {
    return;
  }

  const totalPages = getAuthorTotalPages(author);
  const nextPage = Math.min(totalPages, Math.max(1, Math.floor(targetPage)));
  const currentPage = getAuthorCurrentPage(author);
  if (nextPage === currentPage) {
    return;
  }

  setAuthorPageLoading(author.authorMid, true);
  try {
    // 作者分页按“页号”按需补齐：仅当目标页尚未缓存时才触发后台 Burst 拉取，避免每次翻页都全量重载。
    const cachedPages = new Set(author.cachedPagePns ?? []);
    const hasCachedPage = cachedPages.has(nextPage);
    if (!hasCachedPage) {
      const resp = await sendMessage({
        type: 'ENSURE_AUTHOR_PAGE',
        payload: {
          mid: author.authorMid,
          pn: nextPage
        }
      });
      if (!resp.ok || !resp.data) {
        throw new Error(resp.error ?? '作者分页加载失败');
      }
      if (resp.data.warningMsg) {
        warningMsg.value = resp.data.warningMsg;
      }
      await reloadFeedWithReadMark({ silent: true });
    }

    byAuthorPageMap.value = {
      ...byAuthorPageMap.value,
      [author.authorMid]: nextPage
    };
    clearAuthorPageJumpInput(author.authorMid);
    await nextTick();
    updateByAuthorNavState();
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
  return author.ignoreUnreadCount ? '不计算未读（开）' : '不计算未读';
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
        csrf
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

const hasRenderableFeed = computed(() => hasRenderableFeedData(feed.value));
const showGeneratingPlaceholder = computed(() => generating.value && !hasRenderableFeed.value);
const isUpdating = computed(() => refreshing.value || (generating.value && hasRenderableFeed.value));

const refreshText = computed(() => {
  if (isUpdating.value) return '正在更新中';
  if (generating.value) return '正在生成缓存...';
  return formatRelativeMinutes(feed.value?.lastRefreshAt);
});

const graceLabel = computed(() => {
  const settings = currentSettings.value;
  if (!settings) {
    return '7天内';
  }
  return `${settings.defaultReadMarkDays}天内`;
});

const isAllGroupEntry = computed(() => activeGroupId.value === ENTRY_ID.ALL);
const markReadButtonText = computed(() => {
  if (isAllGroupEntry.value) {
    return '标记全部分组为已阅';
  }
  return mode.value === 'byAuthor' ? '全部标记已阅' : '标记已阅';
});

const currentSettings = ref<{ defaultReadMarkDays: number } | null>(null);
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
  currentSettings.value = { defaultReadMarkDays: resp.data.settings.defaultReadMarkDays };
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

async function fetchClickedVideos(): Promise<void> {
  const bvids = collectAllBvids();
  if (bvids.length === 0) {
    clickedMap.value = {};
    reviewedOverrideMap.value = {};
    return;
  }

  const [clickedResp, reviewedResp] = await Promise.all([
    sendMessage({ type: 'GET_CLICKED_VIDEOS', payload: { bvids } }),
    sendMessage({ type: 'GET_VIDEO_REVIEWED_OVERRIDES', payload: { bvids } })
  ]);

  if (clickedResp.ok && clickedResp.data) {
    clickedMap.value = clickedResp.data.clicked;
  }
  if (reviewedResp.ok && reviewedResp.data) {
    reviewedOverrideMap.value = reviewedResp.data.overrides;
  }
}

function stopPoll(): void {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
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
}

function resetAuthorPaginationState(): void {
  byAuthorPageMap.value = {};
  byAuthorPageJumpInputMap.value = {};
  byAuthorPageLoadingMap.value = {};
}

function syncAuthorPaginationStateWithFeed(): void {
  if (!feed.value) {
    resetAuthorPaginationState();
    return;
  }

  const mids = new Set(feed.value.videosByAuthor.map((author) => author.authorMid));
  const nextPageMap: Record<number, number> = {};
  for (const author of feed.value.videosByAuthor) {
    const current = Number(byAuthorPageMap.value[author.authorMid]) || 1;
    const totalPages = getAuthorTotalPages(author);
    nextPageMap[author.authorMid] = Math.min(totalPages, Math.max(1, current));
  }
  byAuthorPageMap.value = nextPageMap;

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
  const groups = mixedDayGroups.value;
  if (!container || groups.length === 0) {
    resetMixedTimelineState();
    return;
  }

  const scrollTop = container.scrollTop;
  const timelineHeight = Math.max(container.clientHeight, MIXED_TIMELINE_EDGE_PADDING * 2 + 1);
  const viewBottom = scrollTop + timelineHeight;
  const sectionsOffsetTop = mixedSectionsRef.value?.offsetTop ?? 0;
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

    const sectionTop = sectionsOffsetTop + sectionEl.offsetTop;
    const sectionBottom = sectionTop + sectionEl.offsetHeight;
    const visibleTop = Math.max(sectionTop, scrollTop);
    const visibleBottom = Math.min(sectionBottom, viewBottom);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    const sectionHeight = Math.max(1, sectionEl.offsetHeight);
    const visibleRatio = visibleHeight / sectionHeight;
    const inView = visibleRatio > MIXED_TIMELINE_VISIBLE_RATIO_THRESHOLD;
    nextInViewMap[group.dayKey] = inView;
    if (inView) {
      inViewIndexes.push(index);
      inViewTopMap.set(index, sectionTop - scrollTop + 8);
    }

    // 以“可视区域顶部遇到的第一个日期段”为主日期，驱动时间轴压缩窗口。
    if (focusIndex < 0 && sectionBottom > scrollTop + 1) {
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
    const fallbackNodeTopMap: Record<string, number> = {};
    for (let index = fallbackStart; index <= fallbackEnd; index++) {
      const ratio = (index - fallbackStart) / range;
      fallbackNodeTopMap[groups[index].dayKey] =
        MIXED_TIMELINE_EDGE_PADDING + ratio * (timelineHeight - MIXED_TIMELINE_EDGE_PADDING * 2);
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

    const topDockStart = MIXED_TIMELINE_EDGE_PADDING;
    const topDockEnd =
      topCompressedCount > 0
        ? topDockStart + (topCompressedCount - 1) * MIXED_TIMELINE_OUTSIDE_GAP
        : topDockStart;
    const bottomDockStart =
      bottomCompressedCount > 0
        ? timelineHeight - MIXED_TIMELINE_EDGE_PADDING - (bottomCompressedCount - 1) * MIXED_TIMELINE_OUTSIDE_GAP
        : timelineHeight - MIXED_TIMELINE_EDGE_PADDING;

    const topInViewBound = topCompressedCount > 0 ? topDockEnd + MIXED_TIMELINE_OUTSIDE_GAP : MIXED_TIMELINE_EDGE_PADDING;
    const bottomInViewBound =
      bottomCompressedCount > 0
        ? bottomDockStart - MIXED_TIMELINE_OUTSIDE_GAP
        : timelineHeight - MIXED_TIMELINE_EDGE_PADDING;
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
    for (let index = fallbackStart; index <= fallbackEnd; index++) {
      const ratio = (index - fallbackStart) / range;
      nextNodeTopMap[groups[index].dayKey] =
        MIXED_TIMELINE_EDGE_PADDING + ratio * (timelineHeight - MIXED_TIMELINE_EDGE_PADDING * 2);
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

  const listRect = container.getBoundingClientRect();
  const mainEl = container.closest('.bbe-main');
  const toolbarEl = mainEl?.querySelector('.bbe-toolbar');
  const toolbarRect = toolbarEl instanceof HTMLElement ? toolbarEl.getBoundingClientRect() : null;
  const viewTopPx = Math.max(listRect.top, toolbarRect?.bottom ?? listRect.top);
  const viewBottomPx = listRect.bottom;

  let activeMid: number | null = null;
  let fallbackMid: number | null = null;
  let nextMid: number | null = null;
  let measuredCount = 0;

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
      return;
    }

    try {
      const resp = await sendMessage({
        type: 'GET_GROUP_FEED',
        payload: {
          groupId: activeGroupId.value,
          mode: mode.value,
          selectedReadMarkTs: selectedReadMarkTs.value,
          overviewFilter: getOverviewFilterForRequest(),
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

        // 首次加载自动选择默认时间点
        if (
          activeOverviewFilter.value === 'none' &&
          selectedReadMarkTs.value === 0 &&
          !userExplicitlyChoseAll
        ) {
          if (readMarkTimestamps.value.length > 0) {
            selectedReadMarkTs.value = readMarkTimestamps.value[0];
          } else {
            selectedReadMarkTs.value = -1;
          }
          syncSelectedReadFilterKey();
          if (selectedReadMarkTs.value !== 0) {
            await reloadFeedWithReadMark();
            return;
          }
        }

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
        selectedReadMarkTs: selectedReadMarkTs.value,
        overviewFilter: getOverviewFilterForRequest(),
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

    // 首次加载（selectedReadMarkTs 为 0 且非用户主动选择"全部"）：自动选择默认时间点
    if (
      activeOverviewFilter.value === 'none' &&
      selectedReadMarkTs.value === 0 &&
      !userExplicitlyChoseAll
    ) {
      if (readMarkTimestamps.value.length > 0) {
        selectedReadMarkTs.value = readMarkTimestamps.value[0];
      } else {
        selectedReadMarkTs.value = -1;
      }
      syncSelectedReadFilterKey();
      if (selectedReadMarkTs.value !== 0) {
        await reloadFeedWithReadMark();
        return;
      }
    }

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
        selectedReadMarkTs: selectedReadMarkTs.value,
        overviewFilter: getOverviewFilterForRequest(),
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
  followPendingMap.value = {};
  resetAuthorPaginationState();
  userExplicitlyChoseAll = false;
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

    // 恢复记忆的 mode、已阅时间点和作者排序方式
    const summary = summaries.value.find((s) => s.groupId === activeGroupId.value);
    if (summary?.savedMode) {
      mode.value = summary.savedMode;
    }
    if (summary?.savedReadMarkTs !== undefined) {
      selectedReadMarkTs.value = summary.savedReadMarkTs;
      userExplicitlyChoseAll = summary.savedReadMarkTs === 0;
    } else {
      selectedReadMarkTs.value = 0;
    }
    selectedOverviewFilter.value = normalizeOverviewFilter(summary?.savedOverviewFilter);
    if (summary?.savedByAuthorSortByLatest !== undefined) {
      byAuthorSortByLatest.value = summary.savedByAuthorSortByLatest;
    } else {
      byAuthorSortByLatest.value = true;
    }
    syncSelectedReadFilterKey();

    await loadFeed();
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '加载失败');
  }
}

function closeDrawer(): void {
  visible.value = false;
  followPendingMap.value = {};
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
  resetAuthorPaginationState();
  userExplicitlyChoseAll = false;
  warningMsg.value = '';

  // 从 summary 恢复记忆的 mode、已阅时间点和作者排序方式
  const summary = summaries.value.find((s) => s.groupId === entryId);
  if (summary?.savedMode) {
    mode.value = summary.savedMode;
  }
  if (summary?.savedReadMarkTs !== undefined) {
    selectedReadMarkTs.value = summary.savedReadMarkTs;
    userExplicitlyChoseAll = summary.savedReadMarkTs === 0;
  } else {
    selectedReadMarkTs.value = 0;
  }
  selectedOverviewFilter.value = normalizeOverviewFilter(summary?.savedOverviewFilter);
  if (summary?.savedByAuthorSortByLatest !== undefined) {
    byAuthorSortByLatest.value = summary.savedByAuthorSortByLatest;
  } else {
    byAuthorSortByLatest.value = true;
  }
  syncSelectedReadFilterKey();

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
  selectedReadMarkTs.value = parseTrackingFilterKey(selectedReadFilterKey.value);
  userExplicitlyChoseAll = selectedReadMarkTs.value === 0;
  resetAuthorPaginationState();
  try {
    await reloadFeedWithReadMark({ silent: true });
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '切换已阅时间点失败');
  }
}

async function onOverviewFilterChange(): Promise<void> {
  selectedOverviewFilter.value = parseOverviewFilterKey(selectedReadFilterKey.value);
  resetAuthorPaginationState();
  try {
    await reloadFeedWithReadMark({ silent: true });
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '切换概览筛选失败');
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
  if (!activeGroupId.value) {
    return;
  }

  try {
    if (activeGroupId.value === ENTRY_ID.ALL) {
      const resp = await sendMessage({ type: 'MARK_ALL_GROUPS_READ' });
      if (!resp.ok || !resp.data) {
        throw new Error(resp.error ?? '标记全部分组为已阅失败');
      }
      if (resp.data.readMarkTs > 0) {
        selectedReadMarkTs.value = resp.data.readMarkTs;
        userExplicitlyChoseAll = false;
      }
    } else {
      const resp = await sendMessage({
        type: 'MARK_GROUP_READ_MARK',
        payload: { groupId: activeGroupId.value }
      });
      if (!resp.ok || !resp.data) {
        throw new Error(resp.error ?? '标记已阅失败');
      }

      const latestTs = resp.data.marks[activeGroupId.value]?.timestamps[0];
      if (typeof latestTs === 'number' && latestTs > 0) {
        selectedReadMarkTs.value = latestTs;
        userExplicitlyChoseAll = false;
      }
    }
    syncSelectedReadFilterKey();
    await reloadFeedWithReadMark({ silent: true });
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : '标记已阅失败');
  }
}

async function markReadToMixedDay(dayKey: string): Promise<void> {
  const readMarkTs = getNextDayStartSecondsFromDayKey(dayKey);
  if (!readMarkTs || readMarkTs <= 0 || selectedReadMarkTs.value === readMarkTs) {
    return;
  }
  await setGroupReadMarkByTs(readMarkTs, '设置按日已阅失败');
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
  const readMarkTs = resolveMixedReadMarkTsByBoundaryIndex(boundaryIndex);
  await setGroupReadMarkByTs(readMarkTs, '设置时间流已阅失败');
}

async function setGroupReadMarkByTs(readMarkTs: number, fallbackErrorMessage: string): Promise<void> {
  if (!activeGroupId.value || readMarkTs <= 0) {
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
    selectedReadMarkTs.value =
      typeof latestTs === 'number' && latestTs > 0
        ? latestTs
        : Math.floor(readMarkTs / 60) * 60;
    userExplicitlyChoseAll = false;
    syncSelectedReadFilterKey();
    await reloadFeedWithReadMark({ silent: true });
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : fallbackErrorMessage);
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

  const titleEl = sectionEl.querySelector('.bbe-author-title');
  const anchorEl = titleEl instanceof HTMLElement ? titleEl : sectionEl;
  const listRect = container.getBoundingClientRect();
  const mainEl = container.closest('.bbe-main');
  const toolbarEl = mainEl?.querySelector('.bbe-toolbar');
  /**
   * 修正“按作者跳转”被工具栏遮挡的问题：
   * - 不依赖 offsetTop 链路，直接使用实时几何坐标计算目标滚动量；
   * - 可见区顶部取 max(list 顶部, toolbar 底部)，自动兼容“重叠/不重叠”两种布局；
   * - 以作者标题为锚点，保证跳转后标题落在真实可见区。
   */
  const toolbarRect = toolbarEl instanceof HTMLElement ? toolbarEl.getBoundingClientRect() : null;
  const anchorRect = anchorEl.getBoundingClientRect();
  const visibleTop = Math.max(listRect.top, toolbarRect?.bottom ?? listRect.top) + 8;
  const delta = anchorRect.top - visibleTop;
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const targetTop = Math.max(0, Math.min(maxScrollTop, container.scrollTop + delta));
  container.scrollTo({ top: targetTop, behavior: 'smooth' });
  byAuthorActiveMid.value = authorMid;
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
  [mixedDayGroups, byAuthorNavItems, byAuthorVisibleVideosMap, mode, visible, byAuthorSortByLatest],
  async () => {
    if (!visible.value) {
      disconnectMixedTimelineResizeObserver();
      return;
    }

    if (mode.value !== 'mixed') {
      disconnectMixedTimelineResizeObserver();
    }

    await nextTick();
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
  disconnectMixedTimelineResizeObserver();

  if (summaryTimer) {
    window.clearInterval(summaryTimer);
    summaryTimer = null;
  }
  stopPoll();
});
</script>
