<template>
  <a class="bbe-card" :href="`https://www.bilibili.com/video/${video.bvid}`" target="_blank" rel="noreferrer">
    <img :src="video.cover" :alt="video.title" />
    <div class="bbe-card-body">
      <div class="bbe-card-title" :title="video.title">{{ video.title }}</div>
      <div class="bbe-card-meta">{{ video.authorName }}</div>
      <div class="bbe-card-meta">{{ formatPubdate(video.pubdate) }}</div>
    </div>
  </a>
</template>

<script setup lang="ts">
import type { VideoItem } from '@/shared/types';
import { formatPubdate } from '@/shared/utils/format';

defineProps<{
  video: VideoItem;
}>();
</script>
