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
      <button class="bbe-btn" :disabled="isRefreshingFolders" @click="reloadOptionsData">
        {{ isRefreshingFolders ? '刷新中...' : '刷新收藏夹列表' }}
      </button>
    </div>
    <p class="bbe-setting-hint">仅显示"你创建的收藏夹"，每个收藏夹只能绑定一个分组。</p>
    <p class="bbe-setting-hint">{{ folderSnapshotHint }}</p>
  </section>

  <section class="bbe-panel">
    <h2 class="bbe-panel-title">分组列表<span v-if="totalTrackedAuthors > 0" class="bbe-setting-hint" style="margin-left: 8px; font-size: 13px; font-weight: normal">共追踪 {{ totalTrackedAuthors }} 位作者</span></h2>
    <div v-if="groups.length === 0" class="bbe-sub">暂无分组</div>
    <div v-else class="bbe-settings-table-wrap">
      <table class="bbe-settings-table">
        <thead>
          <tr>
            <th scope="col">收藏夹</th>
            <th scope="col">别名</th>
            <th scope="col" class="bbe-settings-table-count">作者数</th>
            <th scope="col" class="bbe-settings-table-enable">启用</th>
            <th scope="col" class="bbe-settings-table-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="group in groups" :key="group.groupId">
            <td class="bbe-settings-table-group-title">{{ group.mediaTitle }}</td>
            <td class="bbe-settings-table-alias">
              <input
                v-model="group.alias"
                class="bbe-input"
                type="text"
                maxlength="30"
                placeholder="未设置时使用收藏夹名"
                @input="scheduleGroupSave(group.groupId)"
                @blur="flushGroupSave(group.groupId)"
              />
            </td>
            <td class="bbe-settings-table-count">{{ groupAuthorCounts[group.groupId] ?? '-' }}</td>
            <td class="bbe-settings-table-enable">
              <button
                type="button"
                class="bbe-settings-switch bbe-settings-switch-compact"
                :class="{ active: group.enabled }"
                :aria-pressed="group.enabled"
                :aria-label="group.enabled ? `停用分组 ${group.mediaTitle}` : `启用分组 ${group.mediaTitle}`"
                :title="group.enabled ? '已启用' : '未启用'"
                @click="toggleGroupEnabled(group)"
              >
                <span class="bbe-settings-switch-track" aria-hidden="true">
                  <span class="bbe-settings-switch-thumb" />
                </span>
              </button>
            </td>
            <td class="bbe-settings-table-actions">
              <div class="bbe-group-actions">
                <button
                  class="bbe-btn"
                  :disabled="!group.enabled || isGroupRefreshing(group.groupId)"
                  @click="refreshGroupPosts(group.groupId)"
                >
                  {{ isGroupRefreshing(group.groupId) ? '提交中...' : '刷新投稿列表' }}
                </button>
                <button
                  class="bbe-btn"
                  :disabled="!group.enabled || isGroupRefreshing(group.groupId)"
                  @click="refreshGroupFav(group.groupId)"
                >
                  刷新收藏夹
                </button>
                <button class="bbe-btn danger" @click="removeGroup(group.groupId)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
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
          作者投稿每页数量
          <div class="bbe-setting-hint">控制作者投稿接口的每页请求数量，默认 24，最大 42</div>
        </div>
        <input
          v-model.number="settings.authorVideosPageSize"
          class="bbe-input"
          type="number"
          min="1"
          :max="AUTHOR_VIDEOS_PAGE_SIZE_MAX"
        />
      </div>
      <div class="bbe-setting-row">
        <div>
          连续缓存额外页数
          <div class="bbe-setting-hint">在固定保留 2 页之外，额外保留多少页的连续作者投稿缓存</div>
        </div>
        <input
          v-model.number="settings.authorContinuousExtraPageCount"
          class="bbe-input"
          type="number"
          min="1"
          max="10"
        />
      </div>
      <div class="bbe-setting-row">
        <div>
          非连续缓存页数
          <div class="bbe-setting-hint">手动翻页、跳页等产生的候选块缓存上限，按页数折算</div>
        </div>
        <input
          v-model.number="settings.authorNonContinuousCachePageCount"
          class="bbe-input"
          type="number"
          min="1"
          max="10"
        />
      </div>
      <div class="bbe-setting-row">
        <div>
          调试模式
          <div class="bbe-setting-hint">开启后侧边栏显示调试入口，并允许在控制台打印调试日志</div>
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
import {
  AUTHOR_CONTINUOUS_EXTRA_PAGE_COUNT_DEFAULT,
  AUTHOR_NON_CONTINUOUS_CACHE_PAGE_COUNT_DEFAULT,
  AUTHOR_VIDEOS_PAGE_SIZE_DEFAULT,
  AUTHOR_VIDEOS_PAGE_SIZE_MAX
} from '@/shared/constants';
import { sendMessage, type ResponseMap } from '@/shared/messages';
import { ext } from '@/shared/platform/webext';
import type { ExtensionSettings, FavoriteFolder, FavoriteFolderSnapshot, GroupConfig } from '@/shared/types';
import { formatRelativeMinutes } from '@/shared/utils/format';
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
const folderSnapshot = ref<FavoriteFolderSnapshot | null>(null);
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
  authorVideosPageSize: AUTHOR_VIDEOS_PAGE_SIZE_DEFAULT,
  authorContinuousExtraPageCount: AUTHOR_CONTINUOUS_EXTRA_PAGE_COUNT_DEFAULT,
  authorNonContinuousCachePageCount: AUTHOR_NON_CONTINUOUS_CACHE_PAGE_COUNT_DEFAULT,
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
const isRefreshingFolders = ref(false);
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

const folderSnapshotHint = computed(() => {
  if (!folderSnapshot.value) {
    return '当前还没有收藏夹列表缓存；首次使用时会自动初始化一次，之后默认只读取缓存。';
  }
  return `当前显示缓存快照，${formatRelativeMinutes(folderSnapshot.value.fetchedAt)}。`;
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

function applyOptionsData(data: ResponseMap['GET_OPTIONS_DATA']): void {
  folders.value = data.folders;
  folderSnapshot.value = data.folderSnapshot ?? null;
  groups.value = data.groups;
  snapshotGroups();
  applySettingsSnapshot(data.settings);
  groupAuthorCounts.value = data.groupAuthorCounts;
  totalTrackedAuthors.value = data.totalTrackedAuthors;
}

async function loadOptionsData(options?: {
  refreshFolders?: boolean;
  showNotice?: boolean;
  successMessage?: string;
}): Promise<FavoriteFolderSnapshot | null> {
  try {
    const resp = await sendMessage({
      type: 'GET_OPTIONS_DATA',
      payload: options?.refreshFolders ? { refreshFolders: true } : undefined
    });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '读取设置数据失败');
    }
    applyOptionsData(resp.data);
    if (options?.showNotice) {
      setNotice(options.successMessage ?? '已加载最新数据');
    }
    return resp.data.folderSnapshot ?? null;
  } catch (error) {
    setError(error instanceof Error ? error.message : '加载失败，请检查登录状态');
    return null;
  }
}

async function reloadOptionsData(): Promise<void> {
  if (isRefreshingFolders.value) {
    return;
  }
  isRefreshingFolders.value = true;
  try {
    await loadOptionsData({
      refreshFolders: true,
      showNotice: true,
      successMessage: '已刷新收藏夹列表'
    });
  } finally {
    isRefreshingFolders.value = false;
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

function toggleGroupEnabled(group: GroupConfig): void {
  group.enabled = group.enabled !== true;
  void saveGroup(group);
}

async function submitGroupRefresh(
  groupId: string,
  type: 'REFRESH_GROUP_POSTS' | 'REFRESH_GROUP_FAV',
  successMessage: string
): Promise<void> {
  if (refreshingGroups.value.has(groupId)) return;

  refreshingGroups.value.add(groupId);
  try {
    const resp = await sendMessage({
      type,
      payload: { groupId }
    });
    if (!resp.ok || !resp.data?.accepted) {
      throw new Error(resp.error ?? '提交刷新失败');
    }
    setNotice(successMessage);
  } catch (error) {
    setError(error instanceof Error ? error.message : '提交刷新失败');
  } finally {
    refreshingGroups.value.delete(groupId);
  }
}

/**
 * “刷新投稿列表”会继续衔接作者投稿刷新，请先明确确认，避免误触发大量请求。
 */
async function refreshGroupPosts(groupId: string): Promise<void> {
  const confirmed = window.confirm('确认刷新投稿列表吗？这会同时刷新当前分组的收藏夹作者列表，并继续为相关作者发起投稿刷新请求。');
  if (!confirmed) {
    return;
  }
  await submitGroupRefresh(groupId, 'REFRESH_GROUP_POSTS', '已提交投稿列表刷新任务，请稍后查看结果');
}

/**
 * “刷新收藏夹”只更新分组标题与作者列表，不继续刷新作者投稿缓存。
 */
async function refreshGroupFav(groupId: string): Promise<void> {
  await submitGroupRefresh(groupId, 'REFRESH_GROUP_FAV', '已提交收藏夹刷新任务，请稍后查看结果');
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
  void (async () => {
    await loadAdvancedSettingsVisibility();
    const snapshot = await loadOptionsData();
    if (!snapshot) {
      isRefreshingFolders.value = true;
      try {
        await loadOptionsData({ refreshFolders: true });
      } finally {
        isRefreshingFolders.value = false;
      }
    }
  })();
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
  color: #0077b6;
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
  background: #00a1d6;
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

.bbe-settings-switch-compact {
  padding: 0;
  gap: 0;
}
</style>
