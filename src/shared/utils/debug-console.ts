import { DEFAULT_SETTINGS, STORAGE_KEYS } from '@/shared/constants';
import { ext } from '@/shared/platform/webext';
import type { ExtensionSettings } from '@/shared/types';
import { normalizeExtensionSettings } from '@/shared/utils/settings';

type DebugConsoleMethod = 'log' | 'info' | 'warn' | 'error';

let debugConsoleEnabled = false;
let initPromise: Promise<boolean> | null = null;
let storageListenerBound = false;

function normalizeDebugConsoleEnabled(value: unknown): boolean {
  const source = value && typeof value === 'object' ? value as Partial<ExtensionSettings> : {};
  return normalizeExtensionSettings({
    ...DEFAULT_SETTINGS,
    ...source
  }).debugMode === true;
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
    debugConsoleEnabled = normalizeDebugConsoleEnabled(change.newValue);
  });
}

/**
 * 统一维护运行时日志开关。
 * 直接复用设置里的 debugMode：
 * - 开启后允许打印控制台调试日志；
 * - content/background 通过 storage.onChanged 自动同步。
 */
export async function initDebugConsoleState(): Promise<boolean> {
  bindStorageListener();
  if (!initPromise) {
    initPromise = ext.storage.local
      .get(STORAGE_KEYS.SETTINGS)
      .then((result) => {
        debugConsoleEnabled = normalizeDebugConsoleEnabled(result[STORAGE_KEYS.SETTINGS]);
        return debugConsoleEnabled;
      })
      .catch(() => {
        debugConsoleEnabled = false;
        return debugConsoleEnabled;
      });
  }
  return initPromise;
}

function printDebugConsole(method: DebugConsoleMethod, args: unknown[]): void {
  if (!debugConsoleEnabled) {
    return;
  }
  const target = console[method] as ((...values: unknown[]) => void) | undefined;
  target?.apply(console, args);
}

export function debugLog(...args: unknown[]): void {
  printDebugConsole('log', args);
}

export function debugInfo(...args: unknown[]): void {
  printDebugConsole('info', args);
}

export function debugWarn(...args: unknown[]): void {
  printDebugConsole('warn', args);
}

export function debugError(...args: unknown[]): void {
  printDebugConsole('error', args);
}
