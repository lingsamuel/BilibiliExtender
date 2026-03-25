<template>
  <article class="bbe-card" :class="{ 'is-dimmed': dimmed }">
    <div class="bbe-card-cover">
      <a
        class="bbe-card-cover-link"
        :href="videoUrl"
        target="_blank"
        rel="noreferrer"
        @click="onVideoLinkClick"
        @auxclick="onVideoLinkAuxClick"
      >
        <img :src="video.cover" :alt="video.title" />
        <span v-if="watchFinished" class="bbe-tag-finished">已看完</span>
        <div v-if="playbackPercent > 0" class="bbe-progress-bar">
          <div class="bbe-progress-fill" :style="{ width: playbackPercent + '%' }" />
        </div>
      </a>
      <button
        type="button"
        class="bbe-like-toggle"
        :class="{ liked: liked === true, pending: likePending === true }"
        :title="likeButtonTitle"
        :aria-label="likeButtonTitle"
        :disabled="likePending === true"
        @click.stop.prevent="onToggleLikeClick"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M2 21h4V9H2v12zm20-11a2 2 0 0 0-2-2h-6.31l.95-4.57.03-.32a1.5 1.5 0 0 0-.44-1.06L13 1 6.59 7.41A2 2 0 0 0 6 8.83V19a2 2 0 0 0 2 2h8a2 2 0 0 0 1.85-1.24l3.02-7.05A2 2 0 0 0 22 11v-1z"
          />
        </svg>
      </button>
    </div>
    <div class="bbe-card-body">
      <a
        class="bbe-card-title-link"
        :href="videoUrl"
        target="_blank"
        rel="noreferrer"
        @click="onVideoLinkClick"
        @auxclick="onVideoLinkAuxClick"
      >
        <div class="bbe-card-title" :title="video.title">{{ video.title }}</div>
      </a>
      <div class="bbe-card-author">
        <a
          v-if="video.authorFace"
          class="bbe-card-author-avatar-link"
          :href="authorSpaceUrl"
          target="_blank"
          rel="noreferrer"
        >
          <img class="bbe-avatar-sm" :src="video.authorFace" alt="" />
        </a>
        <div class="bbe-card-author-info">
          <a class="bbe-card-author-link" :href="authorSpaceUrl" target="_blank" rel="noreferrer">
            <span class="bbe-card-author-name">{{ video.authorName }}</span>
          </a>
          <span class="bbe-card-author-date">{{ formatPubdate(video.pubdate) }}</span>
        </div>
        <button
          type="button"
          class="bbe-reviewed-check"
          :class="{ reviewed: reviewedState }"
          :title="reviewedState ? '已阅（点击取消）' : '未阅（点击设为已阅）'"
          @click.stop.prevent="onToggleReviewedClick"
        >
          ✓
        </button>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { VideoItem } from '@/shared/types';
import { formatPubdate } from '@/shared/utils/format';

const props = defineProps<{
  video: VideoItem;
  clicked?: boolean;
  liked?: boolean;
  likePending?: boolean;
  reviewed?: boolean;
  dimmed?: boolean;
}>();

const emit = defineEmits<{
  (e: 'click', bvid: string): void;
  (e: 'toggle-reviewed', payload: { bvid: string; reviewed: boolean }): void;
  (e: 'toggle-like', payload: { bvid: string; liked: boolean }): void;
}>();

const playbackPercent = computed(() => props.video.playbackPosiiton ?? 0);
const watchFinished = computed(() => playbackPercent.value >= 90);
const reviewedState = computed(() => {
  if (props.reviewed !== undefined) {
    return props.reviewed;
  }
  return Boolean(props.clicked) || playbackPercent.value >= 10;
});

const videoUrl = computed(() => `https://www.bilibili.com/video/${props.video.bvid}`);
const authorSpaceUrl = computed(() => `https://space.bilibili.com/${props.video.authorMid}`);
const likeButtonTitle = computed(() => {
  if (props.likePending) {
    return props.liked === true ? '取消点赞中...' : '点赞中...';
  }
  return props.liked === true ? '已点赞（点击取消）' : '未点赞（点击点赞）';
});

function onVideoLinkClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0) {
    return;
  }
  emit('click', props.video.bvid);
}

function onVideoLinkAuxClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 1) {
    return;
  }
  emit('click', props.video.bvid);
}

function onToggleReviewedClick(): void {
  emit('toggle-reviewed', {
    bvid: props.video.bvid,
    reviewed: !reviewedState.value
  });
}

function onToggleLikeClick(): void {
  if (props.likePending) {
    return;
  }
  emit('toggle-like', {
    bvid: props.video.bvid,
    liked: !(props.liked === true)
  });
}
</script>
