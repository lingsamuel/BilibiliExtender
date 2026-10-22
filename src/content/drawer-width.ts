import { computed, onMounted, onUnmounted, ref } from 'vue';
import { STORAGE_KEYS } from '@/shared/constants';
import { ext } from '@/shared/platform/webext';
import { debugWarn } from '@/shared/utils/debug-console';

const LEGACY_DRAWER_WIDTH_KEY = 'bbe-drawer-width';
const MIN_DRAWER_WIDTH = 500;
const MAX_DRAWER_WIDTH_RATIO = 0.95;
const DEFAULT_DRAWER_WIDTH = 900;

function normalizeWidth(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_DRAWER_WIDTH
    ? Math.round(value)
    : null;
}

function readLegacyWidth(): number | null {
  try {
    return normalizeWidth(Number(localStorage.getItem(LEGACY_DRAWER_WIDTH_KEY)));
  } catch {
    // 某些站点会禁用页面存储；扩展共享存储仍可独立使用。
    return null;
  }
}

/**
 * 抽屉宽度使用扩展存储跨源共享，旧网页设置仅在没有共享值时迁移。
 * 必须在组件 setup 中调用，以便随组件清理存储与拖拽监听。
 */
export function useDrawerWidth() {
  const drawerWidth = ref(DEFAULT_DRAWER_WIDTH);
  const drawerStyle = computed(() => ({ width: `min(${drawerWidth.value}px, 88vw)` }));
  let revision = 0;
  let disposed = false;
  let stopResize: (() => void) | null = null;

  async function saveWidth(width: number): Promise<void> {
    try {
      await ext.storage.local.set({ [STORAGE_KEYS.DRAWER_WIDTH]: Math.round(width) });
    } catch (error) {
      debugWarn('[BBE] 保存抽屉宽度失败', error);
    }
  }

  async function loadWidth(): Promise<void> {
    const loadRevision = revision;
    try {
      const result = await ext.storage.local.get(STORAGE_KEYS.DRAWER_WIDTH);
      // 异步读取期间，拖拽或存储通知可能已带来更新，不能用旧快照覆盖。
      if (disposed || revision !== loadRevision) {
        return;
      }
      const saved = normalizeWidth(result[STORAGE_KEYS.DRAWER_WIDTH]);
      if (saved !== null) {
        drawerWidth.value = saved;
        return;
      }
      const legacy = readLegacyWidth();
      if (legacy !== null) {
        drawerWidth.value = legacy;
        await saveWidth(legacy);
      }
      // 没有旧值时不落盘默认值，给后续访问旧页面留下迁移机会。
    } catch (error) {
      debugWarn('[BBE] 读取抽屉宽度失败，保留当前宽度', error);
    }
  }

  function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, areaName: string): void {
    const change = changes[STORAGE_KEYS.DRAWER_WIDTH];
    if (disposed || areaName !== 'local' || !change || stopResize) {
      return;
    }
    revision += 1;
    drawerWidth.value = normalizeWidth(change.newValue) ?? DEFAULT_DRAWER_WIDTH;
  }

  function onResizeStart(event: MouseEvent): void {
    event.preventDefault();
    stopResize?.();
    revision += 1;
    const startX = event.clientX;
    const startWidth = drawerWidth.value;
    const maxWidth = window.innerWidth * MAX_DRAWER_WIDTH_RATIO;

    function onMouseMove(moveEvent: MouseEvent): void {
      // 抽屉位于右侧，向左拖拽会增大宽度。
      const delta = startX - moveEvent.clientX;
      drawerWidth.value = Math.max(MIN_DRAWER_WIDTH, Math.min(maxWidth, startWidth + delta));
    }

    function onMouseUp(): void {
      stopResize?.();
      stopResize = null;
      void saveWidth(drawerWidth.value);
    }

    stopResize = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  onMounted(() => {
    ext.storage.onChanged.addListener(onStorageChanged);
    void loadWidth();
  });
  onUnmounted(() => {
    disposed = true;
    ext.storage.onChanged.removeListener(onStorageChanged);
    stopResize?.();
  });

  return { drawerWidth, drawerStyle, onResizeStart };
}
