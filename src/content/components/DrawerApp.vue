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
          <button class="bbe-btn" :class="{ active: mode === 'byAuthor' }" @click="switchMode('byAuthor')">按作者</button>
          <label v-if="mode === 'byAuthor'" class="bbe-toolbar-check">
            <input v-model="byAuthorSortByLatest" type="checkbox" @change="onByAuthorSortByLatestChange" />
            <span>按更新时间倒序</span>
          </label>
          <span class="bbe-toolbar-sep" />
          <select v-model.number="selectedReadMarkTs" class="bbe-select-sm" @change="onReadMarkTsChange">
            <option :value="0">全部</option>
            <option v-if="graceReadMarkTs > 0" :value="-1">{{ graceLabel }}</option>
            <option v-for="ts in readMarkTimestamps" :key="ts" :value="ts">{{ formatReadMarkTs(ts) }}</option>
          </select>
          <button class="bbe-btn" :disabled="loading" @click="markAuthorsRead">标记已阅</button>
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
        <div v-if="errorMsg" class="bbe-empty">{{ errorMsg }}</div>
        <div v-else-if="showGeneratingPlaceholder" class="bbe-empty">正在生成缓存，请稍候...</div>
        <div v-else-if="loading" class="bbe-empty">加载中...</div>
        <div v-else-if="!feed || (mode === 'mixed' && feed.mixedVideos.length === 0)" class="bbe-empty">
          当前分组暂无投稿
        </div>

        <template v-else-if="mode === 'mixed'">
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
                <span class="bbe-timeline-node" />
              </div>
            </aside>

            <div ref="mixedSectionsRef" class="bbe-mixed-sections">
              <section
                v-for="day in mixedDayGroups"
                :key="day.dayKey"
                :ref="(el) => bindMixedDaySection(day.dayKey, el)"
                class="bbe-mixed-day-section"
              >
                <div class="bbe-grid">
                  <VideoCard
                    v-for="video in day.videos"
                    :key="video.bvid"
                    :video="video"
                    :clicked="clickedMap[video.bvid] !== undefined"
                    @click="onVideoClick"
                  />
                </div>
              </section>
            </div>
          </div>
          <div v-if="loadingMore" class="bbe-empty">正在加载更多...</div>
          <div v-else-if="!feed.hasMoreForMixed" class="bbe-empty">没有更多内容了</div>
        </template>

        <template v-else>
          <div class="bbe-by-author-layout">
            <aside
              v-if="byAuthorNavItems.length > 0"
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
                    <a
                      class="bbe-author-link"
                      :href="`https://space.bilibili.com/${author.authorMid}`"
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img v-if="author.authorFace" class="bbe-avatar" :src="author.authorFace" alt="" />
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
                  <span
                    v-if="author.hasOnlyExtraOlderVideos && author.latestPubdate"
                    class="bbe-author-title-note"
                  >
                    最近更新：{{ formatDaysAgo(author.latestPubdate) }}
                  </span>
                </h3>
                <div class="bbe-grid">
                  <VideoCard
                    v-for="video in author.videos"
                    :key="video.bvid"
                    :video="video"
                    :clicked="clickedMap[video.bvid] !== undefined"
                    hide-author-name
                    @click="onVideoClick"
                  />
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
import { EXTENSION_EVENT, POLL_INTERVAL_MS, POLL_MAX_REFRESHING } from '@/shared/constants';
import { sendMessage } from '@/shared/messages';
import type { AuthorFeed, GroupFeedResult, GroupSummary, ViewMode } from '@/shared/types';
import { formatDaysAgo, formatReadMarkTs, formatRelativeMinutes } from '@/shared/utils/format';
import VideoCard from '@/content/components/VideoCard.vue';
import DebugPanel from '@/content/components/DebugPanel.vue';
import { buildMixedDayGroups, buildTimelineWindow } from '@/content/utils/timeline';
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
const errorMsg = ref('');
const debugMode = ref(false);
const listRef = ref<HTMLElement | null>(null);
let summaryTimer: number | null = null;
let pollTimer: number | null = null;
let userExplicitlyChoseAll = false;
const lastGroupIdFromSummary = ref('');

const selectedReadMarkTs = ref(0);
const byAuthorSortByLatest = ref(true);
const readMarkTimestamps = ref<number[]>([]);
const graceReadMarkTs = ref(0);
const clickedMap = ref<Record<string, number>>({});
const followPendingMap = ref<Record<number, boolean>>({});
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
  topPx: number;
}

interface ByAuthorNavItem {
  authorMid: number;
  authorName: string;
  authorFace?: string;
}

const mixedDayGroups = computed(() => {
  if (!feed.value) {
    return [];
  }
  return buildMixedDayGroups(feed.value.mixedVideos);
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

const byAuthorNavItems = computed<ByAuthorNavItem[]>(() => {
  if (mode.value !== 'byAuthor') {
    return [];
  }
  return byAuthorFeeds.value.map((author) => ({
    authorMid: author.authorMid,
    authorName: author.authorName,
    authorFace: author.authorFace
  }));
});

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
    errorMsg.value = '未获取到 CSRF，请确认当前页面登录态有效';
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
    errorMsg.value = error instanceof Error ? error.message : (nextFollowing ? '关注失败' : '取消关注失败');
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
    return '7天前';
  }
  return `${settings.defaultReadMarkDays}天前`;
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
    return;
  }

  const clickedResp = await sendMessage({ type: 'GET_CLICKED_VIDEOS', payload: { bvids } });

  if (clickedResp.ok && clickedResp.data) {
    clickedMap.value = clickedResp.data.clicked;
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
  if (!visible.value || mode.value !== 'byAuthor') {
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
      if (visible.value && mode.value === 'byAuthor') {
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
          byAuthorSortByLatest: byAuthorSortByLatest.value
        }
      });

      if (!resp.ok || !resp.data) return;

      if (resp.data.cacheStatus === 'ready') {
        stopPoll();
        generating.value = false;
        refreshing.value = false;
        feed.value = resp.data;
        readMarkTimestamps.value = resp.data.readMarkTimestamps;
        graceReadMarkTs.value = resp.data.graceReadMarkTs;

        // 首次加载自动选择默认时间点
        if (selectedReadMarkTs.value === 0 && !userExplicitlyChoseAll) {
          if (readMarkTimestamps.value.length > 0) {
            selectedReadMarkTs.value = readMarkTimestamps.value[0];
          } else if (graceReadMarkTs.value > 0) {
            selectedReadMarkTs.value = -1;
          }
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

  errorMsg.value = '';

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
        readMarkTimestamps.value = resp.data.readMarkTimestamps;
        graceReadMarkTs.value = resp.data.graceReadMarkTs;
      } else {
        feed.value = null;
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
    } else {
      feed.value = resp.data;
    }

    readMarkTimestamps.value = resp.data.readMarkTimestamps;
    graceReadMarkTs.value = resp.data.graceReadMarkTs;

    // 首次加载（selectedReadMarkTs 为 0 且非用户主动选择"全部"）：自动选择默认时间点
    if (selectedReadMarkTs.value === 0 && !userExplicitlyChoseAll) {
      if (readMarkTimestamps.value.length > 0) {
        selectedReadMarkTs.value = readMarkTimestamps.value[0];
      } else if (graceReadMarkTs.value > 0) {
        selectedReadMarkTs.value = -1;
      }
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

async function reloadFeedWithReadMark(): Promise<void> {
  loading.value = true;
  try {
    const resp = await sendMessage({
      type: 'GET_GROUP_FEED',
      payload: {
        groupId: activeGroupId.value,
        mode: mode.value,
        selectedReadMarkTs: selectedReadMarkTs.value,
        byAuthorSortByLatest: byAuthorSortByLatest.value
      }
    });

    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '加载分组内容失败');
    }

    feed.value = resp.data;
    readMarkTimestamps.value = resp.data.readMarkTimestamps;
    graceReadMarkTs.value = resp.data.graceReadMarkTs;
    await fetchClickedVideos();
    await loadSummary();
  } finally {
    loading.value = false;
  }
}

async function openDrawer(): Promise<void> {
  visible.value = true;
  clickedMap.value = {};
  followPendingMap.value = {};
  userExplicitlyChoseAll = false;

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
    if (summary?.savedByAuthorSortByLatest !== undefined) {
      byAuthorSortByLatest.value = summary.savedByAuthorSortByLatest;
    } else {
      byAuthorSortByLatest.value = true;
    }

    await loadFeed();
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '加载失败';
  }
}

function closeDrawer(): void {
  visible.value = false;
  followPendingMap.value = {};
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
    errorMsg.value = error instanceof Error ? error.message : '刷新失败';
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
  userExplicitlyChoseAll = false;

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
  if (summary?.savedByAuthorSortByLatest !== undefined) {
    byAuthorSortByLatest.value = summary.savedByAuthorSortByLatest;
  } else {
    byAuthorSortByLatest.value = true;
  }

  try {
    await loadFeed();
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '切换分组失败';
  }
}

async function switchMode(nextMode: ViewMode): Promise<void> {
  if (mode.value === nextMode) {
    return;
  }

  mode.value = nextMode;

  try {
    await loadFeed();
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '切换视图失败';
  }
}

async function onReadMarkTsChange(): Promise<void> {
  userExplicitlyChoseAll = selectedReadMarkTs.value === 0;
  try {
    await reloadFeedWithReadMark();
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '切换已阅时间点失败';
  }
}

async function onByAuthorSortByLatestChange(): Promise<void> {
  try {
    await loadFeed();
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '切换作者排序失败';
  }
}

async function markAuthorsRead(): Promise<void> {
  if (!feed.value) {
    return;
  }

  const mids = feed.value.videosByAuthor.map((a) => a.authorMid);
  if (mids.length === 0) {
    return;
  }

  try {
    await sendMessage({ type: 'MARK_AUTHORS_READ', payload: { mids } });
    await loadFeed();
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '标记已阅失败';
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
  } else if (mode.value === 'byAuthor') {
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
    errorMsg.value = error instanceof Error ? error.message : '加载更多失败';
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
    errorMsg.value = error instanceof Error ? error.message : '刷新分组失败';
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
    disconnectMixedTimelineResizeObserver();
  }
});

watch(
  [mixedDayGroups, byAuthorNavItems, mode, visible, byAuthorSortByLatest],
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
    if (mode.value === 'byAuthor') {
      updateByAuthorNavState();
    }
    requestAnimationFrame(() => {
      if (mode.value === 'mixed') {
        updateMixedTimelineState();
      }
      if (mode.value === 'byAuthor') {
        updateByAuthorNavState();
      }
    });
  },
  { flush: 'post' }
);

watch(byAuthorActiveMid, (mid) => {
  if (mid === null || mode.value !== 'byAuthor') {
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
