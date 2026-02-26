<template>
  <h1 class="bbe-title">Bilibili Extender 设置</h1>
  <p class="bbe-sub">将你的收藏夹映射为分组动态，按分组查看作者投稿更新。</p>

  <section class="bbe-panel">
    <h2 class="bbe-panel-title">新增分组</h2>
    <div class="bbe-row">
      <select v-model="selectedMediaId" class="bbe-select">
        <option value="">请选择收藏夹</option>
        <option v-for="folder in availableFolders" :key="folder.id" :value="String(folder.id)">
          {{ folder.title }}（{{ folder.mediaCount }}）
        </option>
      </select>

      <input
        v-model="newAlias"
        class="bbe-input"
        type="text"
        maxlength="30"
        placeholder="分组别名（可选）"
      />
      <button class="bbe-btn primary" @click="createGroup">创建分组</button>
      <button class="bbe-btn" @click="reloadOptionsData">刷新收藏夹列表</button>
    </div>
    <p class="bbe-setting-hint">仅显示“你创建的收藏夹”，每个收藏夹只能绑定一个分组。</p>
  </section>

  <section class="bbe-panel">
    <h2 class="bbe-panel-title">分组列表</h2>

    <div class="bbe-grid bbe-grid-header">
      <div>收藏夹</div>
      <div>别名</div>
      <div>启用</div>
      <div>操作</div>
    </div>

    <div v-if="groups.length === 0" class="bbe-sub">暂无分组</div>

    <div v-for="group in groups" :key="group.groupId" class="bbe-grid bbe-grid-row">
      <div>{{ group.mediaTitle }}</div>
      <div>
        <input
          v-model="group.alias"
          class="bbe-input"
          type="text"
          maxlength="30"
          placeholder="未设置时使用收藏夹名"
          @blur="saveGroup(group)"
        />
      </div>
      <div>
        <label>
          <input type="checkbox" v-model="group.enabled" @change="saveGroup(group)" />
          启用
        </label>
      </div>
      <div>
        <button class="bbe-btn danger" @click="removeGroup(group.groupId)">删除</button>
      </div>
    </div>
  </section>

  <section class="bbe-panel">
    <h2 class="bbe-panel-title">行为设置</h2>

    <div class="bbe-setting-row">
      <div>
        请求缓存时长（分钟）
        <div class="bbe-setting-hint">API 请求结果的缓存有效期，过期后才会重新请求</div>
      </div>
      <input v-model.number="settings.refreshIntervalMinutes" class="bbe-input" type="number" min="1" max="120" />
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
        默认已阅天数
        <div class="bbe-setting-hint">无已阅记录时，默认只显示最近 N 天的视频（0 表示不限制）</div>
      </div>
      <input v-model.number="settings.defaultReadMarkDays" class="bbe-input" type="number" min="0" max="90" />
    </div>

    <div class="bbe-setting-row">
      <div>
        使用同步存储（storage.sync）
        <div class="bbe-setting-hint">超限会自动回退到本地存储</div>
      </div>
      <label>
        <input v-model="settings.useStorageSync" type="checkbox" /> 启用
      </label>
    </div>

    <div class="bbe-row" style="margin-top: 14px">
      <button class="bbe-btn primary" @click="saveSettingsOnly">保存设置</button>
    </div>
  </section>

  <p v-if="message" class="bbe-message">{{ message }}</p>
  <p v-if="errorMsg" class="bbe-error">{{ errorMsg }}</p>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { sendMessage } from '@/shared/messages';
import type { ExtensionSettings, FavoriteFolder, GroupConfig } from '@/shared/types';

const folders = ref<FavoriteFolder[]>([]);
const groups = ref<GroupConfig[]>([]);
const settings = ref<ExtensionSettings>({
  refreshIntervalMinutes: 10,
  timelineMixedMaxCount: 50,
  extraOlderVideoCount: 1,
  defaultReadMarkDays: 7,
  useStorageSync: true
});

const selectedMediaId = ref('');
const newAlias = ref('');
const message = ref('');
const errorMsg = ref('');

const availableFolders = computed(() => {
  const usedIds = new Set(groups.value.map((item) => item.mediaId));
  return folders.value.filter((folder) => !usedIds.has(folder.id));
});

function setNotice(msg: string): void {
  message.value = msg;
  errorMsg.value = '';
}

function setError(msg: string): void {
  errorMsg.value = msg;
  message.value = '';
}

async function reloadOptionsData(): Promise<void> {
  try {
    const resp = await sendMessage({ type: 'GET_OPTIONS_DATA' });
    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '读取设置数据失败');
    }

    folders.value = resp.data.folders;
    groups.value = resp.data.groups.sort((a, b) => b.updatedAt - a.updatedAt);
    settings.value = resp.data.settings;
    setNotice('已加载最新数据');
  } catch (error) {
    setError(error instanceof Error ? error.message : '加载失败，请检查登录状态');
  }
}

/**
 * 创建分组：只允许从“我的收藏夹列表”选择，并由后台再次校验 1:1 约束。
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
          alias: newAlias.value.trim() || undefined,
          enabled: true
        }
      }
    });

    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '创建分组失败');
    }

    groups.value = resp.data.groups.sort((a, b) => b.updatedAt - a.updatedAt);
    selectedMediaId.value = '';
    newAlias.value = '';
    setNotice('分组创建成功');
  } catch (error) {
    setError(error instanceof Error ? error.message : '创建失败');
  }
}

async function saveGroup(group: GroupConfig): Promise<void> {
  try {
    const resp = await sendMessage({
      type: 'UPSERT_GROUP',
      payload: {
        group
      }
    });

    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '保存分组失败');
    }

    groups.value = resp.data.groups.sort((a, b) => b.updatedAt - a.updatedAt);
    setNotice('分组已保存');
  } catch (error) {
    setError(error instanceof Error ? error.message : '保存失败');
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

    groups.value = resp.data.groups.sort((a, b) => b.updatedAt - a.updatedAt);
    setNotice('分组已删除');
  } catch (error) {
    setError(error instanceof Error ? error.message : '删除失败');
  }
}

async function saveSettingsOnly(): Promise<void> {
  const normalized = {
    ...settings.value,
    refreshIntervalMinutes: Math.min(120, Math.max(1, Number(settings.value.refreshIntervalMinutes) || 10)),
    timelineMixedMaxCount: Math.min(500, Math.max(10, Number(settings.value.timelineMixedMaxCount) || 50)),
    extraOlderVideoCount: Math.min(20, Math.max(0, Number(settings.value.extraOlderVideoCount) || 1)),
    defaultReadMarkDays: Math.min(90, Math.max(0, Number(settings.value.defaultReadMarkDays) || 7))
  };

  try {
    const resp = await sendMessage({
      type: 'SAVE_SETTINGS',
      payload: {
        settings: normalized
      }
    });

    if (!resp.ok || !resp.data) {
      throw new Error(resp.error ?? '保存设置失败');
    }

    settings.value = resp.data.settings;
    setNotice('设置已保存');
  } catch (error) {
    setError(error instanceof Error ? error.message : '保存设置失败');
  }
}

onMounted(() => {
  void reloadOptionsData();
});
</script>
