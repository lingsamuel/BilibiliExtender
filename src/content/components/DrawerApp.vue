<template>
  <div v-if="visible" class="bbe-mask" @click="closeDrawer" />
  <section v-if="visible" class="bbe-drawer">
    <aside class="bbe-sidebar">
      <div v-if="summaries.length === 0" class="bbe-empty">
        还没有分组
        <button class="bbe-link-btn" @click="openOptions">去设置页创建</button>
      </div>

      <div
        v-for="item in summaries"
        :key="item.groupId"
        class="bbe-group-item"
        :class="{ active: item.groupId === activeGroupId }"
        @click="selectGroup(item.groupId)"
      >
        <span>{{ item.title }}</span>
        <span v-if="item.unreadCount > 0" class="bbe-dot">{{ item.unreadCount > 99 ? '99+' : item.unreadCount }}</span>
      </div>
    </aside>

    <main class="bbe-main">
      <header class="bbe-toolbar">
        <div class="bbe-toolbar-left">
          <button class="bbe-btn" :class="{ active: mode === 'mixed' }" @click="switchMode('mixed')">时间流</button>
          <button class="bbe-btn" :class="{ active: mode === 'byAuthor' }" @click="switchMode('byAuthor')">按作者</button>
        </div>

        <div class="bbe-toolbar-right">
          <span>{{ refreshText }}</span>
          <button class="bbe-btn" :disabled="loading" @click="manualRefresh">手动刷新</button>
          <button class="bbe-btn" @click="closeDrawer">关闭</button>
        </div>
      </header>

      <section ref="listRef" class="bbe-list" @scroll="onListScroll">
        <div v-if="errorMsg" class="bbe-empty">{{ errorMsg }}</div>
        <div v-else-if="loading" class="bbe-empty">加载中...</div>
        <div v-else-if="!feed || (mode === 'mixed' && feed.mixedVideos.length === 0)" class="bbe-empty">
          当前分组暂无投稿
        </div>

        <template v-else-if="mode === 'mixed'">
          <div class="bbe-grid">
            <VideoCard v-for="video in feed.mixedVideos" :key="video.bvid" :video="video" />
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
            <h3 class="bbe-author-title">{{ author.authorName }}</h3>
            <div class="bbe-grid">
              <VideoCard v-for="video in author.videos" :key="video.bvid" :video="video" />
            </div>
          </section>
        </template>
      </section>
    </main>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { EXTENSION_EVENT } from '@/shared/constants';
import { sendMessage } from '@/shared/messages';
import type { GroupFeedResult, GroupSummary, ViewMode } from '@/shared/types';
import { formatRelativeMinutes } from '@/shared/utils/format';
import VideoCard from '@/content/components/VideoCard.vue';

const visible = ref(false);
const loading = ref(false);
const loadingMore = ref(false);
const mode = ref<ViewMode>('mixed');
const summaries = ref<GroupSummary[]>([]);
const activeGroupId = ref('');
const feed = ref<GroupFeedResult | null>(null);
const errorMsg = ref('');
const listRef = ref<HTMLElement | null>(null);
let summaryTimer: number | null = null;

const refreshText = computed(() => formatRelativeMinutes(feed.value?.lastRefreshAt));

function emitUnreadChanged(): void {
  const hasUnread = summaries.value.some((item) => item.unreadCount > 0);
  window.dispatchEvent(
    new CustomEvent(EXTENSION_EVENT.UNREAD_CHANGED, {
      detail: { hasUnread }
    })
  );
}

async function loadSummary(allowRefresh: boolean): Promise<void> {
  const resp = await sendMessage({
    type: 'GET_GROUP_SUMMARY',
    payload: { allowRefresh }
  });

  if (!resp.ok || !resp.data) {
    throw new Error(resp.error ?? '读取分组概要失败');
  }

  summaries.value = resp.data.summaries;
  emitUnreadChanged();

  if (!activeGroupId.value) {
    activeGroupId.value = resp.data.lastGroupId ?? summaries.value[0]?.groupId ?? '';
  }

  if (activeGroupId.value && !summaries.value.some((item) => item.groupId === activeGroupId.value)) {
    activeGroupId.value = summaries.value[0]?.groupId ?? '';
  }
}

async function loadFeed(options?: { loadMore?: boolean; forceRefresh?: boolean }): Promise<void> {
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
        forceRefresh: options?.forceRefresh
      }
    });

    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '加载分组内容失败');
    }

    feed.value = resp.data;

    if (!options?.loadMore) {
      await markCurrentGroupRead();
    }
  } finally {
    loading.value = false;
    loadingMore.value = false;
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

  await loadSummary(false);
}

async function openDrawer(): Promise<void> {
  visible.value = true;

  try {
    await loadSummary(true);

    if (!activeGroupId.value) {
      return;
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
  try {
    await loadFeed({ forceRefresh: true });
    await loadSummary(false);
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '刷新失败';
  }
}

async function selectGroup(groupId: string): Promise<void> {
  if (groupId === activeGroupId.value) {
    return;
  }

  activeGroupId.value = groupId;

  try {
    await loadFeed();
    await loadSummary(false);
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

function openOptions(): void {
  chrome.runtime.openOptionsPage();
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
  window.addEventListener(EXTENSION_EVENT.TOGGLE_DRAWER, onToggleDrawer);
  window.addEventListener(EXTENSION_EVENT.OPEN_DRAWER, onOpenDrawer);

  void loadSummary(false).catch((error) => {
    console.warn('[BBE] preload summary failed:', error);
  });

  summaryTimer = window.setInterval(() => {
    void loadSummary(true).catch((error) => {
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
});
</script>
