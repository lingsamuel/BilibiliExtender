<template>
  <a
    class="bbe-card"
    :href="`https://www.bilibili.com/video/${video.bvid}`"
    target="_blank"
    rel="noreferrer"
    @click="onCardClick"
  >
    <div class="bbe-card-cover">
      <img :src="video.cover" :alt="video.title" />
      <span v-if="clicked" class="bbe-tag-clicked">已查看</span>
      <span v-if="watchFinished" class="bbe-tag-finished">已看完</span>
      <div v-if="watchProgress > 0" class="bbe-progress-bar">
        <div class="bbe-progress-fill" :style="{ width: watchProgress + '%' }" />
      </div>
    </div>
    <div class="bbe-card-body">
      <div class="bbe-card-title" :title="video.title">{{ video.title }}</div>
      <div class="bbe-card-meta">{{ video.authorName }}</div>
      <div class="bbe-card-meta">{{ formatPubdate(video.pubdate) }}</div>
    </div>
  </a>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { VideoItem, WatchedVideo } from '@/shared/types';
import { formatPubdate } from '@/shared/utils/format';

const props = defineProps<{
  video: VideoItem;
  clicked?: boolean;
  watched?: WatchedVideo;
}>();

const emit = defineEmits<{
  (e: 'click', bvid: string): void;
}>();

const watchFinished = computed(() => props.watched?.progress === -1);

const watchProgress = computed(() => {
  if (!props.watched || props.watched.progress <= 0 || props.watched.duration <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((props.watched.progress / props.watched.duration) * 100));
});

function onCardClick(): void {
  emit('click', props.video.bvid);
}
</script>
