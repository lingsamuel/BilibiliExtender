import { DEFAULT_SETTINGS, STORAGE_KEYS } from '@/shared/constants';
import { ext } from '@/shared/platform/webext';
import type { ExtensionSettings } from '@/shared/types';
import { normalizeExtensionSettings } from '@/shared/utils/settings';

/**
 * 内容脚本侧的设置通道。
 *
 * 背景：设置始终由 `SAVE_SETTINGS` 落在 `storage.local` 的 `bbe:settings`（与 useStorageSync 无关），
 * 因此内容脚本可以直接读取并用 `storage.onChanged` 订阅变更——这与 debug-console.ts 的既有做法一致，
 * 不需要为「入口开关」这类纯展示开关新增消息往返。
 *
 * 约定：
 * - 整份设置只读一次（多个订阅者共享同一个 Promise），避免每个模块各读一遍；
 * - 订阅时先同步回放一次当前值，模块内部不必再关心"首帧有没有值"；
 * - `storage.onChanged` 监听只注册一次。
 */

type EntrySettingsListener = (settings: ExtensionSettings) => void;

const listeners = new Set<EntrySettingsListener>();

let cachedSettings: ExtensionSettings | null = null;
let loadPromise: Promise<ExtensionSettings> | null = null;
let storageListenerBound = false;

function normalizeSettings(value: unknown): ExtensionSettings {
  const source = value && typeof value === 'object' ? (value as Partial<ExtensionSettings>) : {};
  return normalizeExtensionSettings({
    ...DEFAULT_SETTINGS,
    ...source
  });
}

function bindStorageListener(): void {
  if (storageListenerBound) {
    return;
  }
  storageListenerBound = true;
  ext.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') {
      return;
    }
    const change = changes[STORAGE_KEYS.SETTINGS];
    if (!change) {
      return;
    }
    cachedSettings = normalizeSettings(change.newValue);
    for (const listener of listeners) {
      listener(cachedSettings);
    }
  });
}

function loadEntrySettings(): Promise<ExtensionSettings> {
  if (!loadPromise) {
    loadPromise = ext.storage.local
      .get(STORAGE_KEYS.SETTINGS)
      .then((result) => normalizeSettings(result[STORAGE_KEYS.SETTINGS]))
      .catch(() => normalizeSettings(undefined))
      .then((settings) => {
        cachedSettings = settings;
        return settings;
      });
  }
  return loadPromise;
}

/**
 * 订阅内容脚本关心的设置。
 *
 * @returns 取消订阅函数
 */
export async function subscribeEntrySettings(listener: EntrySettingsListener): Promise<() => void> {
  bindStorageListener();
  listeners.add(listener);
  listener(cachedSettings ?? (await loadEntrySettings()));
  return () => {
    listeners.delete(listener);
  };
}
