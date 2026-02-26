<template>
  <section class="bbe-panel bbe-debug-panel">
    <h2 class="bbe-panel-title">调度器状态</h2>
    <div class="bbe-debug-grid">
      <span>状态</span>
      <span>{{ status?.running ? '运行中' : '空闲' }}</span>
      <span>当前任务</span>
      <span>{{ status?.currentTask ? `${status.currentTask.name} (${status.currentTask.mid})` : '无' }}</span>
      <span>队列长度</span>
      <span>{{ status?.queueLength ?? 0 }}</span>
      <span>批次进度</span>
      <span>{{ status?.batchCompleted ?? 0 }} / {{ BATCH_SIZE }}</span>
      <span>失败任务</span>
      <span>{{ status?.batchFailed ?? 0 }}</span>
      <span>上次调度</span>
      <span>{{ lastRunText }}</span>
      <span>下次刷新</span>
      <span>{{ nextAlarmText }}</span>
    </div>

    <h3 v-if="status && status.queue.length > 0" class="bbe-debug-subtitle">队列详情</h3>
    <div v-if="status && status.queue.length > 0" class="bbe-debug-queue">
      <div v-for="(task, i) in status.queue" :key="task.mid" class="bbe-debug-queue-item">
        {{ i + 1 }}. {{ task.name }} ({{ task.mid }})
      </div>
    </div>
  </section>

  <section class="bbe-panel bbe-debug-panel">
    <h2 class="bbe-panel-title">分组缓存</h2>
    <div v-if="!status || status.groupCaches.length === 0" class="bbe-sub">暂无缓存</div>
    <div v-else class="bbe-debug-table">
      <div class="bbe-debug-table-header">
        <span>分组 ID</span>
        <span>作者数</span>
        <span>更新时间</span>
      </div>
      <div v-for="g in status.groupCaches" :key="g.groupId" class="bbe-debug-table-row">
        <span class="bbe-debug-mono">{{ g.groupId.slice(0, 8) }}</span>
        <span>{{ g.authorCount }}</span>
        <span>{{ formatTime(g.updatedAt) }}</span>
      </div>
    </div>
  </section>

  <section class="bbe-panel bbe-debug-panel">
    <h2 class="bbe-panel-title">作者缓存 ({{ status?.authorCaches.length ?? 0 }})</h2>
    <div v-if="!status || status.authorCaches.length === 0" class="bbe-sub">暂无缓存</div>
    <div v-else class="bbe-debug-table">
      <div class="bbe-debug-table-header">
        <span>作者</span>
        <span>缓存视频数</span>
        <span>上次拉取</span>
      </div>
      <div v-for="a in status.authorCaches" :key="a.mid" class="bbe-debug-table-row">
        <span>{{ a.name }}</span>
        <span>{{ a.videoCount }}</span>
        <span>{{ formatTime(a.lastFetchedAt) }}</span>
      </div>
    </div>
  </section>

  <section class="bbe-panel bbe-debug-panel">
    <h2 class="bbe-panel-title">调度历史 ({{ status?.history.length ?? 0 }})</h2>
    <div v-if="!status || status.history.length === 0" class="bbe-sub">暂无记录</div>
    <div v-else class="bbe-debug-table">
      <div class="bbe-debug-table-header">
        <span>作者</span>
        <span>时间</span>
        <span>结果</span>
      </div>
      <div v-for="(h, i) in status.history" :key="i" class="bbe-debug-table-row" :class="{ 'bbe-debug-fail': !h.success }">
        <span>{{ h.name }}</span>
        <span>{{ formatTime(h.timestamp) }}</span>
        <span>{{ h.success ? '成功' : h.error || '失败' }}</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { sendMessage } from '@/shared/messages';
import type { SchedulerStatusResponse } from '@/shared/messages';
import { BG_REFRESH_BATCH_SIZE as BATCH_SIZE } from '@/shared/constants';
import { formatRelativeMinutes } from '@/shared/utils/format';

const status = ref<SchedulerStatusResponse | null>(null);
let timer: number | null = null;

const lastRunText = computed(() => {
  if (!status.value?.lastRunAt) return '从未';
  return formatRelativeMinutes(status.value.lastRunAt);
});

const nextAlarmText = computed(() => {
  if (!status.value?.nextAlarmAt) return '未注册';
  const diff = status.value.nextAlarmAt - Date.now();
  if (diff <= 0) return '即将触发';
  const mins = Math.ceil(diff / 60_000);
  return `${formatTime(status.value.nextAlarmAt)}（${mins} 分钟后）`;
});

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  const ss = `${d.getSeconds()}`.padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

async function fetchStatus(): Promise<void> {
  try {
    const resp = await sendMessage({ type: 'GET_SCHEDULER_STATUS' });
    if (resp.ok && resp.data) {
      status.value = resp.data;
    }
  } catch {
    // 静默忽略
  }
}

onMounted(() => {
  void fetchStatus();
  timer = window.setInterval(fetchStatus, 2000);
});

onUnmounted(() => {
  if (timer) {
    window.clearInterval(timer);
    timer = null;
  }
});
</script>
