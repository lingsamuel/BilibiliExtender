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
        <svg viewBox="0 0 37 33" aria-hidden="true">
          <path
            fill-rule="evenodd"
            clip-rule="evenodd"
            d="M9.77234 30.8573V11.7471H7.54573C5.50932 11.7471 3.85742 13.3931 3.85742 15.425V27.1794C3.85742 29.2112 5.50932 30.8573 7.54573 30.8573H9.77234ZM11.9902 30.8573V11.7054C14.9897 10.627 16.6942 7.8853 17.1055 3.33591C17.2666 1.55463 18.9633 0.814421 20.5803 1.59505C22.1847 2.36964 23.243 4.32583 23.243 6.93947C23.243 8.50265 23.0478 10.1054 22.6582 11.7471H29.7324C31.7739 11.7471 33.4289 13.402 33.4289 15.4435C33.4289 15.7416 33.3928 16.0386 33.3215 16.328L30.9883 25.7957C30.2558 28.7683 27.5894 30.8573 24.528 30.8573H11.9911H11.9902Z"
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
