<template>
  <div class="bbe-debug-status-layout">
    <section class="bbe-panel bbe-debug-panel bbe-debug-status-card">
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
        <span>{{ status?.currentTask ? `${status.currentTask.name} (${status.currentTask.mid}, p${status.currentTask.pn ?? 1})` : '无' }}</span>
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
        <div v-for="(task, i) in status.queue" :key="`${task.mid}-${task.pn ?? 1}-${i}`" class="bbe-debug-queue-item">
          {{ i + 1 }}. {{ task.name }} ({{ task.mid }}, p{{ task.pn ?? 1 }})
        </div>
      </div>
    </section>

    <section class="bbe-panel bbe-debug-panel bbe-debug-status-card">
      <h2 class="bbe-panel-title">Burst 通道状态</h2>
      <div class="bbe-debug-grid">
        <span>manual 状态</span>
        <span>{{ status?.manualChannel.running ? '运行中' : '空闲' }}</span>
        <span>manual 当前任务</span>
        <span>{{ manualCurrentTaskText }}</span>
        <span>manual 队列长度</span>
        <span>{{ status?.manualChannel.queueLength ?? 0 }}</span>
        <span>manual 上次执行</span>
        <span>{{ manualLastRunText }}</span>
        <span>manual-burst 当前任务</span>
        <span>{{ manualBurstCurrentTaskText }}</span>
        <span>manual-burst 队列长度</span>
        <span>{{ status?.manualBurstChannel.queueLength ?? 0 }}</span>
        <span>manual-burst 上次执行</span>
        <span>{{ manualBurstLastRunText }}</span>
        <span>auto-burst 当前任务</span>
        <span>{{ autoBurstCurrentTaskText }}</span>
        <span>auto-burst 队列长度</span>
        <span>{{ status?.autoBurstChannel.queueLength ?? 0 }}</span>
        <span>auto-burst 上次执行</span>
        <span>{{ autoBurstLastRunText }}</span>
      </div>

      <h3 class="bbe-debug-subtitle">共享 Burst 状态机</h3>
      <div class="bbe-debug-grid">
        <span>状态</span>
        <span>{{ status?.burstBudget.running ? '运行中' : '空闲' }}</span>
        <span>当前阶段</span>
        <span>{{ burstPhaseText }}</span>
        <span>阶段进度</span>
        <span>{{ burstPhaseProgressText }}</span>
        <span>剩余预算</span>
        <span>{{ status?.burstBudget.remainingBudget ?? 0 }}</span>
        <span>活跃通道</span>
        <span>{{ burstActiveChannelText }}</span>
        <span>下一次可执行</span>
        <span>{{ burstNextAllowedText }}</span>
        <span>阻塞状态</span>
        <span>{{ burstBlockerText }}</span>
      </div>

      <h3 v-if="status && status.manualChannel.queue.length > 0" class="bbe-debug-subtitle">manual 队列</h3>
      <div v-if="status && status.manualChannel.queue.length > 0" class="bbe-debug-queue">
        <div v-for="(task, i) in status.manualChannel.queue" :key="`manual-${task.mid}-${i}`" class="bbe-debug-queue-item">
          {{ i + 1 }}. {{ formatBurstTaskLabel(task.name, task.mid) }} / p{{ task.pn ?? 1 }}（{{ task.groupNames.length > 0 ? task.groupNames.join(' / ') : '未知分组' }}）
        </div>
      </div>

      <h3 v-if="status && status.manualBurstChannel.queue.length > 0" class="bbe-debug-subtitle">manual-burst 队列</h3>
      <div v-if="status && status.manualBurstChannel.queue.length > 0" class="bbe-debug-queue">
        <div v-for="(task, i) in status.manualBurstChannel.queue" :key="`manual-burst-${task.mid}-${i}`" class="bbe-debug-queue-item">
          {{ i + 1 }}. {{ formatBurstTaskLabel(task.name, task.mid) }} / p{{ task.pn ?? 1 }}（{{ task.groupNames.length > 0 ? task.groupNames.join(' / ') : '未知分组' }}）
        </div>
      </div>

      <h3 v-if="status && status.autoBurstChannel.queue.length > 0" class="bbe-debug-subtitle">auto-burst 队列</h3>
      <div v-if="status && status.autoBurstChannel.queue.length > 0" class="bbe-debug-queue">
        <div v-for="(task, i) in status.autoBurstChannel.queue" :key="`auto-burst-${task.mid}-${i}`" class="bbe-debug-queue-item">
          {{ i + 1 }}. {{ formatBurstTaskLabel(task.name, task.mid) }} / p{{ task.pn ?? 1 }}（{{ task.groupNames.length > 0 ? task.groupNames.join(' / ') : '未知分组' }}）
        </div>
      </div>
    </section>

    <section class="bbe-panel bbe-debug-panel bbe-debug-status-card">
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

    <section class="bbe-panel bbe-debug-panel bbe-debug-status-card">
      <h2 class="bbe-panel-title">点赞通道状态</h2>
      <div class="bbe-debug-grid">
        <span>状态</span>
        <span>{{ status?.likeChannel.running ? '运行中' : '空闲' }}</span>
        <span>当前任务</span>
        <span>{{ likeCurrentTaskText }}</span>
        <span>队列长度</span>
        <span>{{ status?.likeChannel.queueLength ?? 0 }}</span>
        <span>批次进度</span>
        <span>{{ status?.likeChannel.batchCompleted ?? 0 }}</span>
        <span>失败任务</span>
        <span>{{ status?.likeChannel.batchFailed ?? 0 }}</span>
        <span>上次执行</span>
        <span>{{ likeLastRunText }}</span>
      </div>

      <h3 v-if="status && status.likeChannel.queue.length > 0" class="bbe-debug-subtitle">队列详情</h3>
      <div v-if="status && status.likeChannel.queue.length > 0" class="bbe-debug-queue">
        <div v-for="(task, i) in status.likeChannel.queue" :key="`${task.bvid}-${i}`" class="bbe-debug-queue-item">
          {{ i + 1 }}. {{ task.bvid }} / {{ task.action === 'like' ? '点赞' : '取消点赞' }} / {{ task.source === 'author-batch-like' ? '批量' : '单卡' }}
        </div>
      </div>
    </section>

    <section class="bbe-panel bbe-debug-panel bbe-debug-status-card">
      <h2 class="bbe-panel-title">全局冷却状态</h2>
      <div class="bbe-debug-grid">
        <span>状态</span>
        <span>{{ globalCooldownStatusText }}</span>
        <span>原因</span>
        <span>{{ globalCooldownReasonText }}</span>
        <span>下次可执行</span>
        <span>{{ globalCooldownNextAllowedText }}</span>
        <span>剩余时间</span>
        <span>{{ globalCooldownRemainText }}</span>
        <span>最近触发</span>
        <span>{{ globalCooldownLastTriggeredText }}</span>
      </div>
    </section>
  </div>

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
    <div v-else class="bbe-debug-table bbe-debug-table-history">
      <div class="bbe-debug-table-header">
        <span>目标</span>
        <span>通道</span>
        <span>模式</span>
        <span>Reason</span>
        <span>时间</span>
        <span>结果</span>
      </div>
      <div v-for="(h, i) in status.history" :key="i" class="bbe-debug-table-row" :class="{ 'bbe-debug-fail': !h.success }">
        <span>{{ h.name }}</span>
        <span>{{ formatHistoryChannel(h.channel) }}</span>
        <span>{{ formatHistoryMode(h.mode) }}</span>
        <span :title="`${h.trigger}${h.taskReason ? ` / ${h.taskReason}` : ''}`">{{ formatHistoryReason(h) }}</span>
        <span>{{ formatTime(h.timestamp) }}</span>
        <span>{{ h.success ? '成功' : h.error || '失败' }}</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { sendMessage } from '@/shared/messages';
import type {
  SchedulerStatusResponse,
  SchedulerTaskReason,
  SchedulerTaskTrigger
} from '@/shared/messages';
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

const likeLastRunText = computed(() => {
  if (!status.value?.likeChannel.lastRunAt) return '从未';
  return formatRelativeMinutes(status.value.likeChannel.lastRunAt);
});

const likeCurrentTaskText = computed(() => {
  const task = status.value?.likeChannel.currentTask;
  if (!task) return '无';
  return `${task.bvid} / ${task.action === 'like' ? '点赞' : '取消点赞'} / ${task.source === 'author-batch-like' ? '批量' : '单卡'}`;
});

function formatAuthorTaskText(task: {
  mid: number;
  name?: string;
  pn?: number;
  groupNames: string[];
} | null | undefined): string {
  if (!task) return '无';
  const groups = task.groupNames.length > 0 ? task.groupNames.join(' / ') : '未知分组';
  return `${formatBurstTaskLabel(task.name, task.mid)} / p${task.pn ?? 1}（${groups}）`;
}

const manualLastRunText = computed(() => {
  if (!status.value?.manualChannel.lastRunAt) return '从未';
  return formatRelativeMinutes(status.value.manualChannel.lastRunAt);
});

const manualCurrentTaskText = computed(() => formatAuthorTaskText(status.value?.manualChannel.currentTask));

const manualBurstLastRunText = computed(() => {
  if (!status.value?.manualBurstChannel.lastRunAt) return '从未';
  return formatRelativeMinutes(status.value.manualBurstChannel.lastRunAt);
});

const manualBurstCurrentTaskText = computed(() => formatAuthorTaskText(status.value?.manualBurstChannel.currentTask));

const autoBurstLastRunText = computed(() => {
  if (!status.value?.autoBurstChannel.lastRunAt) return '从未';
  return formatRelativeMinutes(status.value.autoBurstChannel.lastRunAt);
});

const autoBurstCurrentTaskText = computed(() => formatAuthorTaskText(status.value?.autoBurstChannel.currentTask));

const burstPhaseText = computed(() => {
  const phase = status.value?.burstBudget.phase;
  if (!phase) return '无';
  if (phase === 'fast') return '快速';
  if (phase === 'slow') return '慢速';
  return '冷却';
});

const burstPhaseProgressText = computed(() => {
  const burst = status.value?.burstBudget;
  if (!burst) return '0 / 0';
  if (burst.phase === 'cooldown') {
    return '冷却中';
  }
  return `${burst.phaseConsumed} / ${burst.phaseBudget}`;
});

const burstActiveChannelText = computed(() => {
  const channel = status.value?.burstBudget.activeChannel;
  if (!channel) return '无';
  return channel;
});

const burstNextAllowedText = computed(() => {
  const nextAllowedAt = status.value?.burstBudget.nextAllowedAt ?? 0;
  if (!nextAllowedAt) return '无';
  if (nextAllowedAt <= Date.now()) {
    return `${formatTime(nextAllowedAt)}（已就绪）`;
  }
  return formatAlarmText(nextAllowedAt);
});

const burstBlockerText = computed(() => {
  const blocker = status.value?.burstBudget.blocker;
  if (!blocker) return '无';
  return `${blocker.channel} / ${blocker.error}`;
});

const globalCooldownStatusText = computed(() => {
  if (status.value?.globalCooldown.active) {
    return '冷却中';
  }
  return status.value?.globalCooldown.lastTriggeredAt ? '空闲（曾触发）' : '空闲';
});

const globalCooldownReasonText = computed(() => {
  const reason = status.value?.globalCooldown.reason;
  if (!reason) return '无';
  return reason === 'wbi-ratelimit' ? 'wbi-ratelimit' : reason;
});

const globalCooldownNextAllowedText = computed(() => {
  const nextAllowedAt = status.value?.globalCooldown.nextAllowedAt ?? 0;
  if (!nextAllowedAt) return '无';
  if (nextAllowedAt <= Date.now()) {
    return `${formatTime(nextAllowedAt)}（已结束）`;
  }
  return formatAlarmText(nextAllowedAt);
});

const globalCooldownRemainText = computed(() => {
  const cooldown = status.value?.globalCooldown;
  if (!cooldown?.active) return '0 秒';
  const diff = cooldown.nextAllowedAt - Date.now();
  if (diff <= 0) return '0 秒';
  return `${Math.ceil(diff / 1000)} 秒`;
});

const globalCooldownLastTriggeredText = computed(() => {
  const ts = status.value?.globalCooldown.lastTriggeredAt;
  if (!ts) return '从未';
  return formatRelativeMinutes(ts);
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

function formatHistoryChannel(channel: 'author-video' | 'group-fav' | 'like-action'): string {
  if (channel === 'group-fav') return 'group-fav';
  if (channel === 'like-action') return 'like-action';
  return 'author-video';
}

function formatHistoryMode(mode: 'regular' | 'manual' | 'manual-burst' | 'auto-burst' | 'opportunistic'): string {
  if (mode === 'manual') return '手动';
  if (mode === 'manual-burst') return '手动批量';
  if (mode === 'auto-burst') return '自动批量';
  if (mode === 'opportunistic') return '机会式';
  return '常规';
}

function formatHistoryReason(item: {
  trigger: SchedulerTaskTrigger;
  taskReason: SchedulerTaskReason;
  channel: 'author-video' | 'group-fav' | 'like-action';
  mid?: number;
  groupId?: string;
  bvid?: string;
  aid?: number;
  pn?: number;
}): string {
  const params: string[] = [];
  if (item.channel === 'group-fav') {
    if (item.groupId) {
      params.push(`groupId=${item.groupId}`);
    }
  } else if (item.channel === 'like-action') {
    if (item.bvid) {
      params.push(`bvid=${item.bvid}`);
    }
    if (typeof item.aid === 'number') {
      params.push(`aid=${item.aid}`);
    }
  } else {
    if (typeof item.mid === 'number') {
      params.push(`mid=${item.mid}`);
    }
    if (typeof item.pn === 'number') {
      params.push(`pn=${item.pn}`);
    }
  }
  const paramText = params.length > 0 ? `(${params.join(',')})` : '';
  return `${item.trigger}${paramText} / ${item.taskReason}`;
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
