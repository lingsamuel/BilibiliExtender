<template>
  <section class="bbe-panel">
    <h2 class="bbe-panel-title">新增分组</h2>
    <div class="bbe-row">
      <select v-model="selectedMediaId" class="bbe-select">
        <option value="">请选择收藏夹</option>
        <option v-for="folder in availableFolders" :key="folder.id" :value="String(folder.id)">
          {{ folder.title }}（{{ folder.mediaCount }}）
        </option>
      </select>
      <button class="bbe-btn primary" @click="createGroup">创建分组</button>
      <button class="bbe-btn" @click="reloadOptionsData">刷新收藏夹列表</button>
    </div>
    <p class="bbe-setting-hint">仅显示"你创建的收藏夹"，每个收藏夹只能绑定一个分组。</p>
  </section>

  <section class="bbe-panel">
    <h2 class="bbe-panel-title">分组列表<span v-if="totalTrackedAuthors > 0" class="bbe-setting-hint" style="margin-left: 8px; font-size: 13px; font-weight: normal">共追踪 {{ totalTrackedAuthors }} 位作者</span></h2>
    <div class="bbe-settings-grid bbe-settings-grid-header">
      <div>收藏夹</div>
      <div>别名</div>
      <div>作者数</div>
      <div>启用</div>
      <div>操作</div>
    </div>
    <div v-if="groups.length === 0" class="bbe-sub">暂无分组</div>
    <div v-for="group in groups" :key="group.groupId" class="bbe-settings-grid bbe-settings-grid-row">
      <div>{{ group.mediaTitle }}</div>
      <div>
        <input
          v-model="group.alias"
          class="bbe-input"
          type="text"
          maxlength="30"
          placeholder="未设置时使用收藏夹名"
          @input="scheduleGroupSave(group.groupId)"
          @blur="flushGroupSave(group.groupId)"
        />
      </div>
      <div>{{ groupAuthorCounts[group.groupId] ?? '-' }}</div>
      <div>
        <label>
          <input type="checkbox" v-model="group.enabled" @change="saveGroup(group)" />
          启用
        </label>
      </div>
      <div>
        <button
          class="bbe-btn"
          :disabled="!group.enabled || isGroupRefreshing(group.groupId)"
          @click="refreshGroupNow(group.groupId)"
        >
          {{ isGroupRefreshing(group.groupId) ? '刷新中...' : '立即刷新' }}
        </button>
        <button class="bbe-btn danger" @click="removeGroup(group.groupId)">删除</button>
      </div>
    </div>
  </section>

  <section class="bbe-panel">
    <h2 class="bbe-panel-title">行为设置</h2>
    <div class="bbe-setting-row">
      <div>
        我是高级用户，给我显示所有设置
      </div>
      <button
        type="button"
        class="bbe-settings-switch"
        :class="{ active: showAdvancedSettings }"
        :aria-pressed="showAdvancedSettings"
        @click="toggleAdvancedSettings"
      >
        <span class="bbe-settings-switch-track" aria-hidden="true">
          <span class="bbe-settings-switch-thumb" />
        </span>
        <span>{{ showAdvancedSettings ? '已开启' : '未开启' }}</span>
      </button>
    </div>
    <section class="bbe-settings-subsection">
      <div class="bbe-setting-row">
        <div>
          默认近期范围
          <div class="bbe-setting-hint">时间流与近期投稿的默认近期范围，支持 1-30 天</div>
        </div>
        <input v-model.number="settings.defaultReadMarkDays" class="bbe-input" type="number" min="1" max="30" />
      </div>
      <div class="bbe-setting-row">
        <div>
          显示“全部”聚合分组
          <div class="bbe-setting-hint">关闭后侧栏将隐藏默认“全部”分组入口</div>
        </div>
        <label>
          <input v-model="settings.enableAllGroup" type="checkbox" /> 启用
        </label>
      </div>
      <div class="bbe-setting-row">
        <div>
          开启同步存储
          <div class="bbe-setting-hint">超限会自动回退到本地存储</div>
        </div>
        <label>
          <input v-model="settings.useStorageSync" type="checkbox" /> 启用
        </label>
      </div>
    </section>
    <section v-if="showAdvancedSettings" class="bbe-settings-subsection">
      <h3 class="bbe-settings-subtitle">高级配置</h3>
      <div class="bbe-setting-row">
        <div>
          请求缓存时长（分钟）
          <div class="bbe-setting-hint">API 请求结果的缓存有效期</div>
        </div>
        <input v-model.number="settings.refreshIntervalMinutes" class="bbe-input" type="number" min="1" max="120" />
      </div>
      <div class="bbe-setting-row">
        <div>
          后台刷新间隔（分钟）
          <div class="bbe-setting-hint">后台自动刷新作者投稿缓存的周期</div>
        </div>
        <input v-model.number="settings.backgroundRefreshIntervalMinutes" class="bbe-input" type="number" min="5" max="120" />
      </div>
      <div class="bbe-setting-row">
        <div>
          收藏夹缓存刷新间隔（分钟）
          <div class="bbe-setting-hint">后台自动刷新收藏夹标题与作者列表的周期</div>
        </div>
        <input v-model.number="settings.groupFavRefreshIntervalMinutes" class="bbe-input" type="number" min="5" max="120" />
      </div>
      <div class="bbe-setting-row">
        <div>
          调度批大小
          <div class="bbe-setting-hint">所有调度通道共享的每批最大任务数</div>
        </div>
        <input v-model.number="settings.schedulerBatchSize" class="bbe-input" type="number" min="1" max="50" />
      </div>
      <div class="bbe-setting-row">
        <div>
          时间流模式最大加载数量
          <div class="bbe-setting-hint">时间流模式下最多加载的视频总数上限</div>
        </div>
        <input v-model.number="settings.timelineMixedMaxCount" class="bbe-input" type="number" min="10" max="500" />
      </div>
      <div class="bbe-setting-row">
        <div>
          已阅前额外显示数量
          <div class="bbe-setting-hint">选中已阅时间点后，每位作者额外显示已阅之前最新的 N 个视频</div>
        </div>
        <input v-model.number="settings.extraOlderVideoCount" class="bbe-input" type="number" min="0" max="20" />
      </div>
      <div class="bbe-setting-row">
        <div>
          调试模式
          <div class="bbe-setting-hint">开启后侧边栏显示调试入口，可查看调度器状态</div>
        </div>
        <label>
          <input v-model="settings.debugMode" type="checkbox" /> 启用
        </label>
      </div>
    </section>
  </section>

  <p v-if="message" class="bbe-message">{{ message }}</p>
  <p v-if="errorMsg" class="bbe-error">{{ errorMsg }}</p>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { sendMessage } from '@/shared/messages';
import { ext } from '@/shared/platform/webext';
import type { ExtensionSettings, FavoriteFolder, GroupConfig } from '@/shared/types';
import { normalizeExtensionSettings } from '@/shared/utils/settings';

const emit = defineEmits<{
  (e: 'group-created'): void;
  (e: 'settings-saved'): void;
}>();

const NOTICE_DURATION_MS = 3000;
const SETTINGS_AUTO_SAVE_DELAY_MS = 400;
const GROUP_ALIAS_AUTO_SAVE_DELAY_MS = 400;
const ADVANCED_SETTINGS_VISIBILITY_KEY = 'settingsPanel.showAdvancedSettings';

const folders = ref<FavoriteFolder[]>([]);
const groups = ref<GroupConfig[]>([]);
// 保存各分组的原始快照，用于脏检查
const groupSnapshots = ref<Record<string, { alias?: string; enabled: boolean; excludeFromUnreadCount: boolean }>>({})
const settings = ref<ExtensionSettings>({
  refreshIntervalMinutes: 30,
  backgroundRefreshIntervalMinutes: 10,
  groupFavRefreshIntervalMinutes: 10,
  schedulerBatchSize: 10,
  timelineMixedMaxCount: 50,
  extraOlderVideoCount: 1,
  defaultReadMarkDays: 7,
  enableAllGroup: true,
  useStorageSync: true,
  debugMode: false
});

const selectedMediaId = ref('');
const message = ref('');
const errorMsg = ref('');
const groupAuthorCounts = ref<Record<string, number>>({});
const totalTrackedAuthors = ref(0);
const refreshingGroups = ref<Set<string>>(new Set());
const settingsSnapshot = ref('');
const showAdvancedSettings = ref(false);
const groupSaveTimers = new Map<string, number>();
let noticeTimer: number | null = null;
let settingsSaveTimer: number | null = null;
let isApplyingSettings = false;
let isSavingSettings = false;
let hasPendingSettingsSave = false;
let isApplyingAdvancedSettingsVisibility = false;

const availableFolders = computed(() => {
  const usedIds = new Set(groups.value.map((item) => item.mediaId));
  return folders.value.filter((folder) => !usedIds.has(folder.id));
});

function setNotice(msg: string): void {
  if (noticeTimer !== null) {
    window.clearTimeout(noticeTimer);
  }
  message.value = msg;
  errorMsg.value = '';
  noticeTimer = window.setTimeout(() => {
    if (message.value === msg) {
      message.value = '';
    }
    noticeTimer = null;
  }, NOTICE_DURATION_MS);
}

function setError(msg: string): void {
  if (noticeTimer !== null) {
    window.clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  errorMsg.value = msg;
  message.value = '';
}

function normalizeSettings(source: ExtensionSettings): ExtensionSettings {
  return normalizeExtensionSettings(source);
}

function serializeSettings(source: ExtensionSettings): string {
  return JSON.stringify(normalizeSettings(source));
}

function snapshotSettings(source: ExtensionSettings): void {
  settingsSnapshot.value = serializeSettings(source);
}

function applySettingsSnapshot(nextSettings: ExtensionSettings): void {
  isApplyingSettings = true;
  settings.value = { ...nextSettings };
  snapshotSettings(nextSettings);
  queueMicrotask(() => {
    isApplyingSettings = false;
  });
}

function isSettingsDirty(): boolean {
  return serializeSettings(settings.value) !== settingsSnapshot.value;
}

async function loadAdvancedSettingsVisibility(): Promise<void> {
  try {
    const stored = await ext.storage.local.get(ADVANCED_SETTINGS_VISIBILITY_KEY);
    isApplyingAdvancedSettingsVisibility = true;
    showAdvancedSettings.value = stored[ADVANCED_SETTINGS_VISIBILITY_KEY] === true;
  } catch {
    // 高级设置显隐仅影响界面呈现，读取失败时保持默认关闭即可。
  } finally {
    queueMicrotask(() => {
      isApplyingAdvancedSettingsVisibility = false;
    });
  }
}

function toggleAdvancedSettings(): void {
  showAdvancedSettings.value = !showAdvancedSettings.value;
}

async function reloadOptionsData(): Promise<void> {
  try {
    const resp = await sendMessage({ type: 'GET_OPTIONS_DATA' });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '读取设置数据失败');
    }
    folders.value = resp.data.folders;
    groups.value = resp.data.groups;
    snapshotGroups();
    applySettingsSnapshot(resp.data.settings);
    groupAuthorCounts.value = resp.data.groupAuthorCounts;
    totalTrackedAuthors.value = resp.data.totalTrackedAuthors;
    setNotice('已加载最新数据');
  } catch (error) {
    setError(error instanceof Error ? error.message : '加载失败，请检查登录状态');
  }
}

/**
 * 创建分组：只允许从"我的收藏夹列表"选择，并由后台再次校验 1:1 约束。
 */
async function createGroup(): Promise<void> {
  const mediaId = Number(selectedMediaId.value);
  if (!mediaId) {
    setError('请先选择收藏夹');
    return;
  }
  const folder = folders.value.find((item) => item.id === mediaId);
  if (!folder) {
    setError('收藏夹不存在或不可用');
    return;
  }
  try {
    const resp = await sendMessage({
      type: 'UPSERT_GROUP',
      payload: {
        group: {
          groupId: crypto.randomUUID(),
          mediaId,
          mediaTitle: folder.title,
          enabled: true,
          excludeFromUnreadCount: false
        }
      }
    });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '创建分组失败');
    }
    groups.value = resp.data.groups;
    snapshotGroups();
    selectedMediaId.value = '';
    setNotice('分组创建成功');
    emit('group-created');
  } catch (error) {
    setError(error instanceof Error ? error.message : '创建失败');
  }
}

function snapshotGroups(): void {
  const map: Record<string, { alias?: string; enabled: boolean; excludeFromUnreadCount: boolean }> = {};
  for (const g of groups.value) {
    const normalizedGroup = normalizeGroupPayload(g);
    map[g.groupId] = {
      alias: normalizedGroup.alias,
      enabled: normalizedGroup.enabled === true,
      excludeFromUnreadCount: normalizedGroup.excludeFromUnreadCount === true
    };
  }
  groupSnapshots.value = map;
}

function updateGroupSnapshot(groupId: string, snapshot: { alias?: string; enabled: boolean; excludeFromUnreadCount: boolean }): void {
  groupSnapshots.value = {
    ...groupSnapshots.value,
    [groupId]: snapshot
  };
}

// 脏检查：只有实际修改了才发请求
function isGroupDirty(group: GroupConfig): boolean {
  const snap = groupSnapshots.value[group.groupId];
  if (!snap) return true;
  const normalizedGroup = normalizeGroupPayload(group);
  return (
    snap.alias !== normalizedGroup.alias ||
    snap.enabled !== (normalizedGroup.enabled === true) ||
    snap.excludeFromUnreadCount !== (normalizedGroup.excludeFromUnreadCount === true)
  );
}

/**
 * 将分组对象序列化为“可结构化克隆”的普通对象。
 * 不能把 Vue Proxy 直接传给 runtime.sendMessage，否则会触发
 * `Proxy object could not be cloned`。
 */
function normalizeGroupPayload(
  group: GroupConfig
): Omit<GroupConfig, 'createdAt' | 'updatedAt'> & Partial<Pick<GroupConfig, 'createdAt' | 'updatedAt'>> {
  return {
    groupId: String(group.groupId),
    mediaId: Number(group.mediaId),
    mediaTitle: String(group.mediaTitle),
    alias: group.alias?.trim() || undefined,
    enabled: group.enabled === true,
    excludeFromUnreadCount: group.excludeFromUnreadCount === true,
    createdAt: Number(group.createdAt) || undefined,
    updatedAt: Number(group.updatedAt) || undefined
  };
}

function scheduleGroupSave(groupId: string, delay = GROUP_ALIAS_AUTO_SAVE_DELAY_MS): void {
  const existing = groupSaveTimers.get(groupId);
  if (existing !== undefined) {
    window.clearTimeout(existing);
  }
  const timer = window.setTimeout(() => {
    groupSaveTimers.delete(groupId);
    void saveGroupById(groupId);
  }, delay);
  groupSaveTimers.set(groupId, timer);
}

function flushGroupSave(groupId: string): void {
  const existing = groupSaveTimers.get(groupId);
  if (existing !== undefined) {
    window.clearTimeout(existing);
    groupSaveTimers.delete(groupId);
  }
  void saveGroupById(groupId);
}

async function saveGroupById(groupId: string): Promise<void> {
  const group = groups.value.find((item) => item.groupId === groupId);
  if (!group) return;
  await saveGroup(group);
}

async function saveGroup(group: GroupConfig): Promise<void> {
  if (!isGroupDirty(group)) return;
  try {
    const normalizedGroup = normalizeGroupPayload(group);
    const resp = await sendMessage({
      type: 'UPSERT_GROUP',
      payload: { group: normalizedGroup }
    });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '保存分组失败');
    }
    updateGroupSnapshot(group.groupId, {
      alias: normalizedGroup.alias,
      enabled: normalizedGroup.enabled === true,
      excludeFromUnreadCount: normalizedGroup.excludeFromUnreadCount === true
    });
    setNotice('分组已保存');
    emit('group-created');
  } catch (error) {
    setError(error instanceof Error ? error.message : '保存失败');
  }
}

function isGroupRefreshing(groupId: string): boolean {
  return refreshingGroups.value.has(groupId);
}

/**
 * 设置页中的“立即刷新”与抽屉手动刷新保持同语义：
 * 始终提交 MANUAL_REFRESH，由后台先刷新收藏夹缓存，再强制刷新该分组作者首页。
 */
async function refreshGroupNow(groupId: string): Promise<void> {
  if (refreshingGroups.value.has(groupId)) return;

  refreshingGroups.value.add(groupId);
  try {
    const resp = await sendMessage({
      type: 'MANUAL_REFRESH',
      payload: { groupId }
    });
    if (!resp.ok || !resp.data?.accepted) {
      throw new Error(resp.error ?? '提交刷新失败');
    }
    setNotice('已提交刷新任务，请稍后查看结果');
  } catch (error) {
    setError(error instanceof Error ? error.message : '提交刷新失败');
  } finally {
    refreshingGroups.value.delete(groupId);
  }
}

async function removeGroup(groupId: string): Promise<void> {
  try {
    const resp = await sendMessage({
      type: 'DELETE_GROUP',
      payload: { groupId }
    });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '删除分组失败');
    }
    groups.value = resp.data.groups;
    snapshotGroups();
    setNotice('分组已删除');
    emit('group-created');
  } catch (error) {
    setError(error instanceof Error ? error.message : '删除失败');
  }
}

async function saveSettingsOnly(): Promise<void> {
  if (!isSettingsDirty()) return;
  if (isSavingSettings) {
    hasPendingSettingsSave = true;
    return;
  }

  isSavingSettings = true;
  try {
    const normalized = normalizeSettings(settings.value);
    const resp = await sendMessage({
      type: 'SAVE_SETTINGS',
      payload: { settings: normalized }
    });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '保存设置失败');
    }
    snapshotSettings(normalized);
    setNotice('设置已保存');
    emit('settings-saved');
  } catch (error) {
    setError(error instanceof Error ? error.message : '保存设置失败');
  } finally {
    isSavingSettings = false;
    if (hasPendingSettingsSave) {
      hasPendingSettingsSave = false;
      scheduleSettingsSave(0);
    }
  }
}

function scheduleSettingsSave(delay = SETTINGS_AUTO_SAVE_DELAY_MS): void {
  if (settingsSaveTimer !== null) {
    window.clearTimeout(settingsSaveTimer);
  }
  settingsSaveTimer = window.setTimeout(() => {
    settingsSaveTimer = null;
    void saveSettingsOnly();
  }, delay);
}

watch(
  settings,
  () => {
    if (isApplyingSettings) return;
    if (!settingsSnapshot.value) return;
    scheduleSettingsSave();
  },
  { deep: true }
);

watch(showAdvancedSettings, (value) => {
  if (isApplyingAdvancedSettingsVisibility) return;
  void ext.storage.local.set({
    [ADVANCED_SETTINGS_VISIBILITY_KEY]: value
  });
});

onBeforeUnmount(() => {
  if (noticeTimer !== null) {
    window.clearTimeout(noticeTimer);
  }
  if (settingsSaveTimer !== null) {
    window.clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    void saveSettingsOnly();
  }
  for (const [groupId, timer] of groupSaveTimers.entries()) {
    window.clearTimeout(timer);
    void saveGroupById(groupId);
  }
  groupSaveTimers.clear();
});

onMounted(() => {
  void loadAdvancedSettingsVisibility();
  void reloadOptionsData();
});
</script>

<style scoped>
.bbe-settings-subsection + .bbe-settings-subsection {
  margin-top: 18px;
  padding-top: 18px;
  border-top: 1px solid rgba(148, 163, 184, 0.22);
}

.bbe-settings-subtitle {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: #334155;
}

.bbe-settings-subhint {
  margin: 0 0 12px;
}

.bbe-settings-switch {
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: #5d6c83;
  padding: 4px 12px 4px 8px;
  font-size: 12px;
  line-height: 1.5;
  cursor: pointer;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  transition: border-color 0.16s ease, background-color 0.16s ease, color 0.16s ease;
}

.bbe-settings-switch:hover {
  color: #42526a;
}

.bbe-settings-switch.active {
  color: #9b6c00;
}

.bbe-settings-switch-track {
  width: 32px;
  height: 18px;
  border-radius: 999px;
  background: #d6deec;
  padding: 2px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  transition: background-color 0.16s ease;
}

.bbe-settings-switch.active .bbe-settings-switch-track {
  background: #f6cf73;
}

.bbe-settings-switch-thumb {
  width: 14px;
  height: 14px;
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.18);
  transition: transform 0.16s ease;
}

.bbe-settings-switch.active .bbe-settings-switch-thumb {
  transform: translateX(14px);
}
</style>
