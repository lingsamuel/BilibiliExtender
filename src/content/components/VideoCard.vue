<template>
  <article class="bbe-card">
    <a
      class="bbe-card-cover-link"
      :href="videoUrl"
      target="_blank"
      rel="noreferrer"
      @click="onVideoLinkClick"
      @auxclick="onVideoLinkAuxClick"
    >
      <div class="bbe-card-cover">
        <img :src="video.cover" :alt="video.title" />
        <span v-if="watchFinished" class="bbe-tag-finished">已看完</span>
        <div v-if="playbackPercent > 0" class="bbe-progress-bar">
          <div class="bbe-progress-fill" :style="{ width: playbackPercent + '%' }" />
        </div>
      </div>
    </a>
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
  reviewed?: boolean;
}>();

const emit = defineEmits<{
  (e: 'click', bvid: string): void;
  (e: 'toggle-reviewed', payload: { bvid: string; reviewed: boolean }): void;
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
</script>
