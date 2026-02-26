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
          :class="{ active: item.groupId === activeGroupId && !showSettings && !showDebug }"
          @click="selectGroup(item.groupId)"
        >
          <span>{{ item.title }}</span>
          <span v-if="item.unreadCount > 0" class="bbe-dot">{{ item.unreadCount > 99 ? '99+' : item.unreadCount }}</span>
        </div>
      </div>
      <div
        class="bbe-group-item bbe-sidebar-settings"
        :class="{ active: showSettings && !showDebug }"
        @click="toggleSettings"
      >
        <span>设置</span>
      </div>
      <div
        v-if="debugMode"
        class="bbe-group-item bbe-sidebar-settings"
        :class="{ active: showDebug }"
        @click="toggleDebug"
      >
        <span>调试</span>
      </div>
    </aside>

    <main class="bbe-main">
      <section v-if="showDebug" class="bbe-list bbe-settings-scroll">
        <DebugPanel />
      </section>

      <section v-else-if="showSettings" class="bbe-list bbe-settings-scroll">
        <SettingsPanel @group-created="onGroupListChanged" @settings-saved="onSettingsSaved" />
      </section>

      <template v-else>
      <header class="bbe-toolbar">
        <div class="bbe-toolbar-left">
          <button class="bbe-btn" :class="{ active: mode === 'mixed' }" @click="switchMode('mixed')">时间流</button>
          <button class="bbe-btn" :class="{ active: mode === 'byAuthor' }" @click="switchMode('byAuthor')">按作者</button>
          <span class="bbe-toolbar-sep" />
          <select v-model.number="selectedReadMarkTs" class="bbe-select-sm" @change="onReadMarkTsChange">
            <option :value="0">全部</option>
            <option v-if="graceReadMarkTs > 0" :value="-1">{{ graceLabel }}</option>
            <option v-for="ts in readMarkTimestamps" :key="ts" :value="ts">{{ formatReadMarkTs(ts) }}</option>
          </select>
          <button class="bbe-btn" :disabled="loading" @click="markAuthorsRead">标记已阅</button>
        </div>

        <div class="bbe-toolbar-right">
          <span>{{ refreshText }}</span>
          <button class="bbe-btn" :disabled="loading || refreshing || generating" @click="manualRefresh">手动刷新</button>
          <button class="bbe-btn" @click="closeDrawer">关闭</button>
        </div>
      </header>

      <section ref="listRef" class="bbe-list" @scroll="onListScroll">
        <div v-if="errorMsg" class="bbe-empty">{{ errorMsg }}</div>
        <div v-else-if="generating" class="bbe-empty">正在生成缓存，请稍候...</div>
        <div v-else-if="loading" class="bbe-empty">加载中...</div>
        <div v-else-if="!feed || (mode === 'mixed' && feed.mixedVideos.length === 0)" class="bbe-empty">
          当前分组暂无投稿
        </div>

        <template v-else-if="mode === 'mixed'">
          <div class="bbe-grid">
            <VideoCard
              v-for="video in feed.mixedVideos"
              :key="video.bvid"
              :video="video"
              :clicked="clickedMap[video.bvid] !== undefined"
              :watched="watchedMap[video.bvid]"
              @click="onVideoClick"
            />
          </div>
          <div v-if="loadingMore" class="bbe-empty">正在加载更多...</div>
          <div v-else-if="!feed.hasMoreForMixed" class="bbe-empty">没有更多内容了</div>
        </template>

        <template v-else>
          <section
            v-for="author in feed.videosByAuthor"
            :key="author.authorMid"
            class="bbe-author-section"
          >
            <h3 class="bbe-author-title">
              <img v-if="author.authorFace" class="bbe-avatar" :src="author.authorFace" alt="" />
              <span>{{ author.authorName }}</span>
            </h3>
            <div class="bbe-grid">
              <VideoCard
                v-for="video in author.videos"
                :key="video.bvid"
                :video="video"
                :clicked="clickedMap[video.bvid] !== undefined"
                :watched="watchedMap[video.bvid]"
                @click="onVideoClick"
              />
            </div>
          </section>
        </template>
      </section>
      </template>
    </main>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { EXTENSION_EVENT, POLL_INTERVAL_MS, POLL_MAX_GENERATING, POLL_MAX_REFRESHING } from '@/shared/constants';
import { sendMessage } from '@/shared/messages';
import type { GroupFeedResult, GroupSummary, ViewMode, WatchedVideo } from '@/shared/types';
import { formatReadMarkTs, formatRelativeMinutes } from '@/shared/utils/format';
import VideoCard from '@/content/components/VideoCard.vue';
import DebugPanel from '@/content/components/DebugPanel.vue';
import SettingsPanel from '@/shared/components/SettingsPanel.vue';

const DRAWER_WIDTH_KEY = 'bbe-drawer-width';
const MIN_DRAWER_WIDTH = 500;
const MAX_DRAWER_WIDTH_RATIO = 0.95;
const DEFAULT_DRAWER_WIDTH = 900;

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
const feed = ref<GroupFeedResult | null>(null);
const errorMsg = ref('');
const showSettings = ref(false);
const showDebug = ref(false);
const debugMode = ref(false);
const listRef = ref<HTMLElement | null>(null);
let summaryTimer: number | null = null;
let pollTimer: number | null = null;
let userExplicitlyChoseAll = false;

const selectedReadMarkTs = ref(0);
const readMarkTimestamps = ref<number[]>([]);
const graceReadMarkTs = ref(0);
const clickedMap = ref<Record<string, number>>({});
const watchedMap = ref<Record<string, WatchedVideo>>({});

const refreshText = computed(() => {
  if (generating.value) return '正在生成缓存...';
  if (refreshing.value) return '正在刷新...';
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

function emitUnreadChanged(): void {
  const hasUnread = summaries.value.some((item) => item.unreadCount > 0);
  window.dispatchEvent(
    new CustomEvent(EXTENSION_EVENT.UNREAD_CHANGED, {
      detail: { hasUnread }
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
  currentSettings.value = { defaultReadMarkDays: resp.data.settings.defaultReadMarkDays };
  debugMode.value = resp.data.settings.debugMode ?? false;
  emitUnreadChanged();

  if (!activeGroupId.value) {
    activeGroupId.value = resp.data.lastGroupId ?? summaries.value[0]?.groupId ?? '';
  }

  if (activeGroupId.value && !summaries.value.some((item) => item.groupId === activeGroupId.value)) {
    activeGroupId.value = summaries.value[0]?.groupId ?? '';
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

async function fetchClickedAndWatched(): Promise<void> {
  const bvids = collectAllBvids();
  if (bvids.length === 0) {
    return;
  }

  const [clickedResp, watchResp] = await Promise.all([
    sendMessage({ type: 'GET_CLICKED_VIDEOS', payload: { bvids } }),
    sendMessage({ type: 'GET_WATCH_HISTORY' })
  ]);

  if (clickedResp.ok && clickedResp.data) {
    clickedMap.value = clickedResp.data.clicked;
  }

  if (watchResp.ok && watchResp.data) {
    const map: Record<string, WatchedVideo> = {};
    for (const item of watchResp.data.history) {
      map[item.bvid] = item;
    }
    watchedMap.value = map;
  }
}

function stopPoll(): void {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
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
          selectedReadMarkTs: selectedReadMarkTs.value
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

        await markCurrentGroupRead();
        await fetchClickedAndWatched();
        await loadSummary();
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
        selectedReadMarkTs: selectedReadMarkTs.value
      }
    });

    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '加载分组内容失败');
    }

    // 缓存尚未就绪，启动轮询等待
    if (resp.data.cacheStatus === 'generating') {
      generating.value = true;
      feed.value = null;
      startPoll(POLL_MAX_GENERATING);
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

    if (!options?.loadMore) {
      await markCurrentGroupRead();
    }

    await fetchClickedAndWatched();
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
        selectedReadMarkTs: selectedReadMarkTs.value
      }
    });

    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '加载分组内容失败');
    }

    feed.value = resp.data;
    readMarkTimestamps.value = resp.data.readMarkTimestamps;
    graceReadMarkTs.value = resp.data.graceReadMarkTs;
    await markCurrentGroupRead();
    await fetchClickedAndWatched();
  } finally {
    loading.value = false;
  }
}

async function markCurrentGroupRead(): Promise<void> {
  if (!activeGroupId.value) {
    return;
  }

  await sendMessage({
    type: 'MARK_GROUP_READ',
    payload: { groupId: activeGroupId.value }
  });

  await loadSummary();
}

async function openDrawer(): Promise<void> {
  visible.value = true;
  clickedMap.value = {};
  watchedMap.value = {};
  userExplicitlyChoseAll = false;

  try {
    await loadSummary();

    // 无分组时自动切换到设置页
    if (summaries.value.length === 0) {
      showSettings.value = true;
      return;
    }
    showSettings.value = false;

    if (!activeGroupId.value) {
      return;
    }

    // 恢复记忆的 mode 和 selectedReadMarkTs
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

    await loadFeed();
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '加载失败';
  }
}

function closeDrawer(): void {
  visible.value = false;
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

async function selectGroup(groupId: string): Promise<void> {
  if (groupId === activeGroupId.value) {
    return;
  }

  stopPoll();
  generating.value = false;
  refreshing.value = false;
  showSettings.value = false;
  showDebug.value = false;
  activeGroupId.value = groupId;
  userExplicitlyChoseAll = false;

  // 从 summary 恢复记忆的 mode 和 selectedReadMarkTs
  const summary = summaries.value.find((s) => s.groupId === groupId);
  if (summary?.savedMode) {
    mode.value = summary.savedMode;
  }
  if (summary?.savedReadMarkTs !== undefined) {
    selectedReadMarkTs.value = summary.savedReadMarkTs;
    userExplicitlyChoseAll = summary.savedReadMarkTs === 0;
  } else {
    selectedReadMarkTs.value = 0;
  }

  try {
    await loadFeed();
    await loadSummary();
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

async function onListScroll(event: Event): Promise<void> {
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

function toggleSettings(): void {
  showSettings.value = !showSettings.value;
  if (showSettings.value) showDebug.value = false;
}

function toggleDebug(): void {
  showDebug.value = !showDebug.value;
  if (showDebug.value) showSettings.value = false;
}

// 分组列表变更（创建/删除），重新加载概要，无分组时留在设置页，有分组时自动切回
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
  if (!nextVisible && listRef.value) {
    listRef.value.scrollTop = 0;
  }
});

onMounted(() => {
  loadDrawerWidth();
  window.addEventListener(EXTENSION_EVENT.TOGGLE_DRAWER, onToggleDrawer);
  window.addEventListener(EXTENSION_EVENT.OPEN_DRAWER, onOpenDrawer);

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
  window.removeEventListener(EXTENSION_EVENT.TOGGLE_DRAWER, onToggleDrawer);
  window.removeEventListener(EXTENSION_EVENT.OPEN_DRAWER, onOpenDrawer);

  if (summaryTimer) {
    window.clearInterval(summaryTimer);
    summaryTimer = null;
  }
  stopPoll();
});
</script>
