<template>
  <section class="bbe-panel bbe-debug-panel">
    <h2 class="bbe-panel-title">常规更新队列</h2>
    <div class="bbe-row" style="margin-bottom: 10px">
      <button class="bbe-btn primary" :disabled="runNowLoading" @click="runNow">
        {{ runNowLoading ? '触发中...' : '立刻发起调度' }}
      </button>
      <span v-if="runNowMsg" class="bbe-setting-hint">{{ runNowMsg }}</span>
    </div>
    <div class="bbe-debug-grid">
      <span>状态</span>
      <span>{{ status?.running ? '运行中' : '空闲' }}</span>
      <span>当前任务</span>
      <span>{{ status?.currentTask ? `${status.currentTask.name} (${status.currentTask.mid})` : '无' }}</span>
      <span>队列长度</span>
      <span>{{ status?.queueLength ?? 0 }}</span>
      <span>批次进度</span>
      <span>{{ status?.batchCompleted ?? 0 }} / {{ status?.schedulerBatchSize ?? 10 }}</span>
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
    <h2 class="bbe-panel-title">Burst 状态</h2>
    <div class="bbe-debug-grid">
      <span>状态</span>
      <span>{{ status?.burst.running ? '运行中' : '空闲' }}</span>
      <span>当前任务</span>
      <span>{{ burstCurrentTaskText }}</span>
      <span>队列长度</span>
      <span>{{ status?.burst.queueLength ?? 0 }}</span>
      <span>上次执行</span>
      <span>{{ burstLastRunText }}</span>
      <span>下一次可执行</span>
      <span>{{ burstNextAllowedText }}</span>
      <span>冷却状态</span>
      <span>{{ burstCooldownText }}</span>
    </div>

    <h3 v-if="status && status.burst.queue.length > 0" class="bbe-debug-subtitle">队列详情</h3>
    <div v-if="status && status.burst.queue.length > 0" class="bbe-debug-queue">
      <div v-for="(task, i) in status.burst.queue" :key="`${task.mid}-${i}`" class="bbe-debug-queue-item">
        {{ i + 1 }}. {{ formatBurstTaskLabel(task.name, task.mid) }}（{{ task.groupNames.length > 0 ? task.groupNames.join(' / ') : '未知分组' }}）
      </div>
    </div>
  </section>

  <section class="bbe-panel bbe-debug-panel">
    <h2 class="bbe-panel-title">收藏夹通道状态</h2>
    <div class="bbe-debug-grid">
      <span>状态</span>
      <span>{{ status?.groupChannel.running ? '运行中' : '空闲' }}</span>
      <span>当前任务</span>
      <span>{{ status?.groupChannel.currentTask ? status.groupChannel.currentTask.groupId : '无' }}</span>
      <span>队列长度</span>
      <span>{{ status?.groupChannel.queueLength ?? 0 }}</span>
      <span>批次进度</span>
      <span>{{ status?.groupChannel.batchCompleted ?? 0 }} / {{ status?.schedulerBatchSize ?? 10 }}</span>
      <span>失败任务</span>
      <span>{{ status?.groupChannel.batchFailed ?? 0 }}</span>
      <span>上次调度</span>
      <span>{{ groupLastRunText }}</span>
      <span>下次刷新</span>
      <span>{{ groupNextAlarmText }}</span>
    </div>

    <h3 v-if="status && status.groupChannel.queue.length > 0" class="bbe-debug-subtitle">队列详情</h3>
    <div v-if="status && status.groupChannel.queue.length > 0" class="bbe-debug-queue">
      <div v-for="(task, i) in status.groupChannel.queue" :key="`${task.groupId}-${i}`" class="bbe-debug-queue-item">
        {{ i + 1 }}. {{ task.groupId }}
      </div>
    </div>
  </section>

  <section class="bbe-panel bbe-debug-panel">
    <h2 class="bbe-panel-title">分组缓存</h2>
    <div v-if="!status || status.groupCaches.length === 0" class="bbe-sub">暂无缓存</div>
    <div v-else class="bbe-debug-table bbe-debug-table-groups">
      <div class="bbe-debug-table-header">
        <span>分组名</span>
        <span>分组 ID</span>
        <span>作者数</span>
        <span>更新时间</span>
      </div>
      <div v-for="g in status.groupCaches" :key="g.groupId" class="bbe-debug-table-row">
        <span :title="g.title">{{ g.title }}</span>
        <span class="bbe-debug-mono">{{ g.groupId.slice(0, 8) }}</span>
        <span>{{ g.authorCount }}</span>
        <span>{{ formatTime(g.updatedAt) }}</span>
      </div>
    </div>
  </section>

  <section class="bbe-panel bbe-debug-panel">
    <h2 class="bbe-panel-title">作者缓存 ({{ status?.authorCaches.length ?? 0 }})</h2>
    <div v-if="!status || status.authorCaches.length === 0" class="bbe-sub">暂无缓存</div>
    <div v-else class="bbe-debug-table bbe-debug-table-authors">
      <div class="bbe-debug-table-header">
        <span>作者</span>
        <span>所属分组</span>
        <span>缓存视频数</span>
        <span>上次拉取</span>
      </div>
      <div v-for="a in status.authorCaches" :key="a.mid" class="bbe-debug-table-row">
        <span>{{ a.name }}</span>
        <span class="bbe-debug-group-list">
          <template v-if="a.groupNames.length > 0">
            <span v-for="groupName in a.groupNames" :key="`${a.mid}-${groupName}`" class="bbe-debug-chip" :title="groupName">
              {{ groupName }}
            </span>
          </template>
          <span v-else class="bbe-debug-empty">-</span>
        </span>
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
        <span>模式</span>
        <span>时间</span>
        <span>结果</span>
      </div>
      <div v-for="(h, i) in status.history" :key="i" class="bbe-debug-table-row" :class="{ 'bbe-debug-fail': !h.success }">
        <span>{{ h.name }}</span>
        <span>{{ h.mode === 'burst' ? 'Burst' : '常规' }}</span>
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
import { formatRelativeMinutes } from '@/shared/utils/format';

const status = ref<SchedulerStatusResponse | null>(null);
const runNowLoading = ref(false);
const runNowMsg = ref('');
let timer: number | null = null;

const lastRunText = computed(() => {
  if (!status.value?.lastRunAt) return '从未';
  return formatRelativeMinutes(status.value.lastRunAt);
});

const nextAlarmText = computed(() => {
  if (!status.value?.nextAlarmAt) return '未注册';
  return formatAlarmText(status.value.nextAlarmAt);
});

const groupLastRunText = computed(() => {
  if (!status.value?.groupChannel.lastRunAt) return '从未';
  return formatRelativeMinutes(status.value.groupChannel.lastRunAt);
});

const groupNextAlarmText = computed(() => {
  if (!status.value?.groupChannel.nextAlarmAt) return '未注册';
  return formatAlarmText(status.value.groupChannel.nextAlarmAt);
});

const burstLastRunText = computed(() => {
  if (!status.value?.burst.lastRunAt) return '从未';
  return formatRelativeMinutes(status.value.burst.lastRunAt);
});

const burstCurrentTaskText = computed(() => {
  const task = status.value?.burst.currentTask;
  if (!task) return '无';
  const groups = task.groupNames.length > 0 ? task.groupNames.join(' / ') : '未知分组';
  return `${formatBurstTaskLabel(task.name, task.mid)}（${groups}）`;
});

const burstNextAllowedText = computed(() => {
  const nextAllowedAt = status.value?.burst.nextAllowedAt ?? 0;
  if (!nextAllowedAt) return '无';
  return formatAlarmText(nextAllowedAt);
});

const burstCooldownText = computed(() => {
  const burst = status.value?.burst;
  if (!burst || !burst.cooldownReason) return '无';

  const diff = burst.nextAllowedAt - Date.now();
  if (diff <= 0) {
    return burst.cooldownReason === 'error' ? '错误冷却结束' : '间隔冷却结束';
  }

  const secs = Math.ceil(diff / 1000);
  if (burst.cooldownReason === 'error') {
    return `错误冷却中（剩余 ${secs} 秒）`;
  }
  return `间隔冷却中（剩余 ${secs} 秒）`;
});

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  const ss = `${d.getSeconds()}`.padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatAlarmText(targetMs: number): string {
  const diff = targetMs - Date.now();
  if (diff <= 0) return '即将触发';
  const mins = Math.ceil(diff / 60_000);
  return `${formatTime(targetMs)}（${mins} 分钟后）`;
}

function formatBurstTaskLabel(name: string | undefined, mid: number): string {
  const normalized = name?.trim();
  if (!normalized || /^\d+$/.test(normalized)) {
    return `MID ${mid}`;
  }
  return normalized;
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

async function runNow(): Promise<void> {
  if (runNowLoading.value) return;

  runNowLoading.value = true;
  runNowMsg.value = '';
  try {
    const resp = await sendMessage({ type: 'RUN_SCHEDULER_NOW' });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '触发调度失败');
    }

    const parts = resp.data.channels.map((item) => `${item.name}: +${item.queued}`);
    runNowMsg.value = `已触发：${parts.join('，')}`;
    await fetchStatus();
  } catch (error) {
    runNowMsg.value = error instanceof Error ? error.message : '触发调度失败';
  } finally {
    runNowLoading.value = false;
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
