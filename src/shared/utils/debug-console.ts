import { STORAGE_KEYS } from '@/shared/constants';
import { ext } from '@/shared/platform/webext';

type DebugConsoleMethod = 'log' | 'info' | 'warn' | 'error';

let debugConsoleEnabled = false;
let initPromise: Promise<boolean> | null = null;
let storageListenerBound = false;

function normalizeDebugConsoleEnabled(value: unknown): boolean {
  return value === true;
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
    const change = changes[STORAGE_KEYS.DEBUG_CONSOLE_ENABLED];
    if (!change) {
      return;
    }
    debugConsoleEnabled = normalizeDebugConsoleEnabled(change.newValue);
  });
}

/**
 * 统一维护运行时日志开关。
 * 开关通过 storage.local 在 content/background 间同步，
 * 但会在浏览器启动或扩展安装时被后台重置，避免长期保留调试输出。
 */
export async function initDebugConsoleState(): Promise<boolean> {
  bindStorageListener();
  if (!initPromise) {
    initPromise = ext.storage.local
      .get(STORAGE_KEYS.DEBUG_CONSOLE_ENABLED)
      .then((result) => {
        debugConsoleEnabled = normalizeDebugConsoleEnabled(result[STORAGE_KEYS.DEBUG_CONSOLE_ENABLED]);
        return debugConsoleEnabled;
      })
      .catch(() => {
        debugConsoleEnabled = false;
        return debugConsoleEnabled;
      });
  }
  return initPromise;
}

export function setDebugConsoleEnabledLocally(enabled: boolean): void {
  debugConsoleEnabled = enabled === true;
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
