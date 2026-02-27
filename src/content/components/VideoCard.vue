<template>
  <article
    class="bbe-card"
    role="link"
    tabindex="0"
    @click="onCardClick"
    @auxclick="onCardAuxClick"
    @keydown.enter.prevent="openVideoLink"
    @keydown.space.prevent="openVideoLink"
  >
    <div class="bbe-card-cover">
      <img :src="video.cover" :alt="video.title" />
      <span v-if="showViewedTag" class="bbe-tag-clicked">已查看</span>
      <span v-if="watchFinished" class="bbe-tag-finished">已看完</span>
      <div v-if="playbackPercent > 0" class="bbe-progress-bar">
        <div class="bbe-progress-fill" :style="{ width: playbackPercent + '%' }" />
      </div>
    </div>
    <div class="bbe-card-body">
      <div class="bbe-card-title" :title="video.title">{{ video.title }}</div>
      <div class="bbe-card-author">
        <a
          v-if="video.authorFace"
          class="bbe-card-author-avatar-link"
          :href="authorSpaceUrl"
          target="_blank"
          rel="noreferrer"
          @click.stop
          @auxclick.stop
        >
          <img class="bbe-avatar-sm" :src="video.authorFace" alt="" />
        </a>
        <div class="bbe-card-author-info">
          <a
            class="bbe-card-author-link"
            :href="authorSpaceUrl"
            target="_blank"
            rel="noreferrer"
            @click.stop
            @auxclick.stop
          >
            <span class="bbe-card-author-name">{{ video.authorName }}</span>
          </a>
          <span class="bbe-card-author-date">{{ formatPubdate(video.pubdate) }}</span>
        </div>
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
}>();

const emit = defineEmits<{
  (e: 'click', bvid: string): void;
}>();

const playbackPercent = computed(() => props.video.playbackPosiiton ?? 0);
const watchFinished = computed(() => playbackPercent.value >= 90);
/**
 * “已查看”由两类信号共同决定：
 * 1) 用户在扩展内点击过视频；
 * 2) 投稿接口返回的播放进度达到阈值（>=10）。
 * 若已达到“已看完”阈值（>=90），隐藏“已查看”避免语义重复。
 */
const showViewedTag = computed(
  () => !watchFinished.value && (Boolean(props.clicked) || playbackPercent.value >= 10)
);

const videoUrl = computed(() => `https://www.bilibili.com/video/${props.video.bvid}`);
const authorSpaceUrl = computed(() => `https://space.bilibili.com/${props.video.authorMid}`);

/**
 * 统一由脚本打开视频链接，保证卡片与键盘交互保持一致，
 * 并且不会影响卡片内作者链接的独立跳转行为。
 */
function openVideoLink(): void {
  window.open(videoUrl.value, '_blank', 'noopener,noreferrer');
  emit('click', props.video.bvid);
}

function onCardClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0) {
    return;
  }
  openVideoLink();
}

function onCardAuxClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 1) {
    return;
  }
  event.preventDefault();
  openVideoLink();
}
</script>
