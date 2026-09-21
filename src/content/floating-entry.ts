import { subscribeEntrySettings } from '@/content/entry-settings';
import type { NavEntryController, NavEntryInjectionState } from '@/content/nav-entry';
import {
  EXTENSION_EVENT,
  FLOATING_ENTRY_COLLAPSED_SIZE_PX,
  FLOATING_ENTRY_DEFAULT_TOP_RATIO,
  FLOATING_ENTRY_DRAG_THRESHOLD_PX,
  FLOATING_ENTRY_EDGE_MARGIN_PX,
  FLOATING_ENTRY_SNAP_THRESHOLD_PX,
  STORAGE_KEYS
} from '@/shared/constants';
import { ext } from '@/shared/platform/webext';
import { debugWarn } from '@/shared/utils/debug-console';
import { resolveFloatingEntryAlwaysVisible } from '@/shared/utils/settings';

/**
 * 悬浮框入口：Header 注入不可用（或用户要求常驻）时的兜底入口。
 *
 * 关键设计：
 * - 位置以「锚定边缘 + 偏移」记录，而不是绝对 left：
 *   吸附到右边缘时，若记录 left，窗口变宽后悬浮框会从右边缘漂走；
 *   记录 `side` 与 `offset` 后，无论视口如何变化都稳定贴边。
 * - 展开方向由 `side` 决定（右锚定向左展开、左锚定向右展开），
 *   因此 hover 展开永远朝视口内侧生长，不会越界。
 * - 显隐完全由「注入状态 + 常驻开关 + 抽屉可见性」推导，模块自身不持有业务状态。
 */

type FloatingEntrySide = 'left' | 'right';

interface FloatingEntryPosition {
  side: FloatingEntrySide;
  /** 折叠态靠近锚定边缘的一侧到该边缘的距离（px） */
  offset: number;
  /** 折叠态顶边到视口顶部的距离（px） */
  top: number;
  updatedAt: number;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  startLeft: number;
  startTop: number;
  /** 折叠态实测尺寸，用于拖拽期间的视口钳制 */
  width: number;
  height: number;
  moved: boolean;
}

const ROOT_ID = 'bbe-root';
const ENTRY_ATTR = 'data-bbe-floating-entry';
const BADGE_ATTR = 'data-bbe-floating-badge';

const FLOATING_ICON_SVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="2" y="2" width="7" height="7" rx="1.5" fill="currentColor"/>
  <rect x="11" y="2" width="7" height="7" rx="1.5" fill="currentColor"/>
  <rect x="2" y="11" width="7" height="7" rx="1.5" fill="currentColor"/>
  <rect x="11" y="11" width="7" height="7" rx="1.5" fill="currentColor"/>
</svg>`;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatBadgeText(count: number): string {
  if (count <= 0) {
    return '';
  }
  return count > 99 ? '99+' : String(count);
}

function createDefaultPosition(): FloatingEntryPosition {
  return {
    side: 'right',
    offset: FLOATING_ENTRY_EDGE_MARGIN_PX,
    top: Math.round(window.innerHeight * FLOATING_ENTRY_DEFAULT_TOP_RATIO),
    updatedAt: 0
  };
}

function normalizePosition(raw: unknown): FloatingEntryPosition | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const source = raw as Partial<FloatingEntryPosition>;
  if (source.side !== 'left' && source.side !== 'right') {
    return null;
  }
  const offset = Number(source.offset);
  const top = Number(source.top);
  if (!Number.isFinite(offset) || !Number.isFinite(top)) {
    return null;
  }
  return {
    side: source.side,
    offset: Math.max(FLOATING_ENTRY_EDGE_MARGIN_PX, offset),
    top: Math.max(FLOATING_ENTRY_EDGE_MARGIN_PX, top),
    updatedAt: Number(source.updatedAt) || 0
  };
}

async function loadPosition(): Promise<FloatingEntryPosition> {
  try {
    const result = await ext.storage.local.get(STORAGE_KEYS.FLOATING_ENTRY_POSITION);
    return normalizePosition(result[STORAGE_KEYS.FLOATING_ENTRY_POSITION]) ?? createDefaultPosition();
  } catch (error) {
    debugWarn('[BBE] 读取悬浮框位置失败，回退默认位置', error);
    return createDefaultPosition();
  }
}

function savePosition(position: FloatingEntryPosition): void {
  void ext.storage.local
    .set({
      [STORAGE_KEYS.FLOATING_ENTRY_POSITION]: { ...position, updatedAt: Date.now() }
    })
    .catch((error) => {
      debugWarn('[BBE] 保存悬浮框位置失败', error);
    });
}

function createFloatingEntryElement(): HTMLElement {
  const entry = document.createElement('div');
  entry.setAttribute(ENTRY_ATTR, '1');
  entry.className = 'bbe-floating-entry';
  entry.setAttribute('role', 'button');
  entry.setAttribute('tabindex', '0');
  entry.setAttribute('aria-label', '分组动态');
  entry.title = '分组动态';
  entry.innerHTML = `
    <span class="bbe-floating-entry-icon">${FLOATING_ICON_SVG}</span>
    <span class="bbe-floating-entry-text">分组动态</span>
    <span class="bbe-floating-entry-badge" ${BADGE_ATTR}="1" hidden></span>
  `;
  return entry;
}

function syncBadge(entry: HTMLElement, unreadCount: number): void {
  const badge = entry.querySelector<HTMLElement>(`[${BADGE_ATTR}="1"]`);
  if (!badge) {
    return;
  }
  const text = formatBadgeText(unreadCount);
  badge.textContent = text;
  badge.hidden = text === '';
}

/**
 * 按锚定侧写入位置。
 * 折叠态尺寸恒定（36px），因此这里同时把钳制后的值回写到内存中的 position，
 * 保证后续拖拽 / resize 计算始终基于同一份口径（持久化只在拖拽结束时发生）。
 */
function applyPosition(entry: HTMLElement, position: FloatingEntryPosition): void {
  const margin = FLOATING_ENTRY_EDGE_MARGIN_PX;
  const size = FLOATING_ENTRY_COLLAPSED_SIZE_PX;
  const maxOffset = Math.max(margin, window.innerWidth - size - margin);
  const maxTop = Math.max(margin, window.innerHeight - size - margin);

  position.offset = clamp(position.offset, margin, maxOffset);
  position.top = clamp(position.top, margin, maxTop);

  entry.style.top = `${position.top}px`;
  if (position.side === 'right') {
    entry.style.right = `${position.offset}px`;
    entry.style.left = 'auto';
  } else {
    entry.style.left = `${position.offset}px`;
    entry.style.right = 'auto';
  }
}

function openDrawer(): void {
  window.dispatchEvent(new Event(EXTENSION_EVENT.TOGGLE_DRAWER));
}

function bindDrag(entry: HTMLElement, position: FloatingEntryPosition): void {
  let drag: DragState | null = null;

  /** 拖拽期间统一折叠并用 left/top 定位，保证跟手且宽度变化不影响吸附判定 */
  function beginDrag(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    entry.classList.add('is-dragging');
    // 先折叠再测量：折叠态尺寸以实测为准，避免样式调整后与常量脱节
    const rect = entry.getBoundingClientRect();
    const width = rect.width || FLOATING_ENTRY_COLLAPSED_SIZE_PX;
    const height = rect.height || FLOATING_ENTRY_COLLAPSED_SIZE_PX;
    // 右锚定时右边缘是稳定参照，折叠后宽度变小只会影响左边缘
    const collapsedLeft = position.side === 'right' ? rect.right - width : rect.left;

    entry.style.left = `${collapsedLeft}px`;
    entry.style.right = 'auto';
    entry.style.top = `${rect.top}px`;

    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: collapsedLeft,
      startTop: rect.top,
      width,
      height,
      moved: false
    };
    // 指针捕获可能因指针已失效而抛错（例如指针在按下后立刻被系统回收），
    // 这里失败不影响后续基于元素自身监听的拖拽逻辑。
    try {
      entry.setPointerCapture(event.pointerId);
    } catch {
      // 忽略：未捕获到指针时仍可在元素上继续接收 pointermove
    }
    event.preventDefault();
  }

  function moveDrag(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < FLOATING_ENTRY_DRAG_THRESHOLD_PX) {
      return;
    }
    drag.moved = true;

    const left = clamp(drag.startLeft + dx, 0, Math.max(0, window.innerWidth - drag.width));
    const top = clamp(drag.startTop + dy, 0, Math.max(0, window.innerHeight - drag.height));
    entry.style.left = `${left}px`;
    entry.style.top = `${top}px`;
  }

  function endDrag(event: PointerEvent, cancelled: boolean): void {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const state = drag;
    drag = null;
    // 吸附判定必须用折叠态几何：此时 is-dragging 尚未摘除，宽度仍是折叠宽度
    const rect = entry.getBoundingClientRect();
    entry.classList.remove('is-dragging');
    try {
      if (entry.hasPointerCapture(event.pointerId)) {
        entry.releasePointerCapture(event.pointerId);
      }
    } catch {
      // 忽略：捕获已失效时无需释放
    }

    // 位移未超过阈值视为点击：打开抽屉
    if (!state.moved) {
      if (!cancelled) {
        openDrawer();
      } else {
        applyPosition(entry, position);
      }
      return;
    }

    const center = rect.left + rect.width / 2;
    const side: FloatingEntrySide = center < window.innerWidth / 2 ? 'left' : 'right';
    const rawOffset = side === 'left' ? rect.left : window.innerWidth - rect.right;
    // 距边缘足够近才吸附，否则保留自由停放的位置
    const offset = rawOffset <= FLOATING_ENTRY_SNAP_THRESHOLD_PX
      ? FLOATING_ENTRY_EDGE_MARGIN_PX
      : Math.round(rawOffset);

    position.side = side;
    position.offset = offset;
    position.top = Math.round(rect.top);

    applyPosition(entry, position);
    savePosition(position);
  }

  entry.addEventListener('pointerdown', beginDrag);
  entry.addEventListener('pointermove', moveDrag);
  entry.addEventListener('pointerup', (event) => endDrag(event, false));
  entry.addEventListener('pointercancel', (event) => endDrag(event, true));
  entry.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    openDrawer();
  });
}

/**
 * 挂载悬浮框入口。
 *
 * 必须在 `createApp(DrawerApp).mount(root)` 之后调用：Vue 挂载时会清空容器，
 * 早于挂载插入的节点会被一并清掉。
 */
export function startFloatingEntry(nav: NavEntryController): void {
  const root = document.getElementById(ROOT_ID);
  if (!root) {
    debugWarn('[BBE] 未找到内容脚本根节点，跳过悬浮框入口挂载');
    return;
  }

  const entry = createFloatingEntryElement();
  // 放在最前，保证图层位于抽屉遮罩与抽屉面板之下
  root.insertBefore(entry, root.firstChild);

  const position = createDefaultPosition();
  let positionLoaded = false;
  let injectionState: NavEntryInjectionState = nav.getState();
  let alwaysVisible = false;
  let drawerVisible = false;

  function updateVisibility(): void {
    const shouldShow = positionLoaded
      && (injectionState === 'unavailable' || alwaysVisible)
      && !drawerVisible;
    entry.classList.toggle('is-visible', shouldShow);
    entry.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
    if (shouldShow) {
      applyPosition(entry, position);
    }
  }

  nav.subscribe((next) => {
    injectionState = next;
    updateVisibility();
  });

  void subscribeEntrySettings((settings) => {
    alwaysVisible = resolveFloatingEntryAlwaysVisible(settings);
    updateVisibility();
  });

  window.addEventListener(EXTENSION_EVENT.UNREAD_CHANGED, (event) => {
    const detail = (event as CustomEvent<{ hasUnread?: boolean; unreadCount?: number }>).detail;
    const count = typeof detail?.unreadCount === 'number'
      ? detail.unreadCount
      : detail?.hasUnread ? 1 : 0;
    syncBadge(entry, count);
  });

  window.addEventListener(EXTENSION_EVENT.DRAWER_VISIBILITY_CHANGED, (event) => {
    const detail = (event as CustomEvent<{ visible?: boolean }>).detail;
    drawerVisible = detail?.visible === true;
    updateVisibility();
  });

  window.addEventListener('resize', () => {
    applyPosition(entry, position);
  });

  bindDrag(entry, position);

  void loadPosition().then((loaded) => {
    position.side = loaded.side;
    position.offset = loaded.offset;
    position.top = loaded.top;
    positionLoaded = true;
    updateVisibility();
  });
}
