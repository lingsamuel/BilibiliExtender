import { subscribeEntrySettings } from '@/content/entry-settings';
import { EXTENSION_EVENT } from '@/shared/constants';

/**
 * 站点 Header「分组动态」入口注入。
 *
 * 依赖的站点结构（2025 年 Header 前端重构后）：
 *   <div class="right-entry">
 *     <div class="right-entry__main">              <- 真正的 flex 条目容器
 *       <div class="right-entry__item">
 *         <a class="right-entry__item-trigger">
 *           <div class="trigger-icon-wrap"><svg class="trigger-icon" /></div>
 *           <span class="trigger-text">动态</span>
 *         </a>
 *       </div>
 *       ...
 *     </div>
 *   </div>
 *
 * 重构前的 .right-entry-item / .right-entry-text / .right-entry-icon 等类名
 * 已从站点 CSS 与 JS 中彻底移除，因此这里不再保留旧结构分支。
 * 若站点再次调整结构，只需同步本文件顶部的常量与 detectNavContainer。
 *
 * 注入状态机（对外的三种状态）：
 * - `pending`：初始等待条目容器就绪（重试预算内），此阶段不显示悬浮框，避免首屏闪烁；
 * - `injected`：入口已挂在容器中；
 * - `unavailable`：用户关闭了注入，或重试预算耗尽仍未成功。悬浮框由此状态驱动显示。
 * 进入 `unavailable` 后仍会做低成本恢复尝试，但**保持** `unavailable` 不变，
 * 只有真正注入成功才切到 `injected`，因此悬浮框不会反复显隐。
 */

const NAV_ENTRY_ID = 'bbe-nav-entry';
const NAV_ENTRY_LABEL = '分组动态';
/** 未读数字节点标记：站点类名只用于视觉，查找一律走该属性，避免站点改类名后失联 */
const NAV_DOT_ATTR = 'data-bbe-nav-dot';

/** Header 外壳类名（新旧版一致，未随本次重构变化） */
const NAV_ROOT_SELECTOR = '.right-entry';
/** 条目容器：重构后条目统一挂在 .right-entry__main（display:flex）下 */
const NAV_MAIN_CONTAINER_SELECTOR = ':scope > .right-entry__main';
const NAV_ITEM_SELECTOR = ':scope > .right-entry__item';
const NAV_ITEM_TEXT_SELECTOR = '.trigger-text';
/** 红点容器：站点把它做成 position:relative 的定位参照 */
const NAV_ICON_WRAP_CLASS = 'trigger-icon-wrap';

/**
 * 判定条目容器是否已渲染完成。
 * 登录态下该容器最终会产出 7~8 个条目，这里以 5 个作为下限，
 * 避免在骨架/半渲染状态下注入造成 DOM 抖动。
 */
const NAV_READY_MIN_ITEM_COUNT = 5;

/** 入口插入参照：站点「消息」条目的识别文案与 data-idx（兼容英文站） */
const MESSAGE_ITEM_LABELS = new Set(['消息', 'message']);
const MESSAGE_ITEM_IDX = 'message';
/**
 * 找不到「消息」条目时的兜底插入下标。
 * 对应“插到第 3 个位置”的行为，登录态下即「大会员」与「消息」之间。
 */
const NAV_ENTRY_FALLBACK_INDEX = 2;

const INJECT_INITIAL_DELAY_MS = 300;
const INJECT_FAST_RETRIES = 5;
const INJECT_MAX_DELAY_MS = 5000;
const INJECT_MAX_TOTAL_MS = 30_000;

const RIGHT_ENTRY_SVG_HEIGHT = 20;

export type NavEntryInjectionState = 'pending' | 'injected' | 'unavailable';

export interface NavEntryController {
  /** 应用「关闭 Header 入口注入」开关（幂等） */
  setDisabled(disabled: boolean): void;
  getState(): NavEntryInjectionState;
  /** 订阅注入状态变化，返回取消订阅函数 */
  subscribe(listener: (state: NavEntryInjectionState) => void): () => void;
}

let unreadCount = 0;

/** 分组动态图标：网格布局 SVG，表示分组/分类概念 */
const NAV_ICON_SVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="trigger-icon">
  <rect x="2" y="2" width="7" height="7" rx="1.5" fill="currentColor"/>
  <rect x="11" y="2" width="7" height="7" rx="1.5" fill="currentColor"/>
  <rect x="2" y="11" width="7" height="7" rx="1.5" fill="currentColor"/>
  <rect x="11" y="11" width="7" height="7" rx="1.5" fill="currentColor"/>
</svg>`;

function formatUnreadText(count: number): string {
  if (count <= 0) {
    return '';
  }
  return count > 99 ? '99+' : String(count);
}

function normalizeText(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** 条目容器是否已经产出足够多的站点原生条目 */
function isContainerReady(container: Element): boolean {
  return container.querySelectorAll(NAV_ITEM_SELECTOR).length >= NAV_READY_MIN_ITEM_COUNT;
}

/**
 * 定位承载导航条目的容器。
 * `.right-entry` 本身在重构后只是外壳，真正的 flex 容器是 `.right-entry__main`；
 * 若将来条目又被直接挂回 `.right-entry`，第二个分支仍可命中。
 */
function detectNavContainer(): Element | null {
  const roots = document.querySelectorAll(NAV_ROOT_SELECTOR);
  for (const root of roots) {
    const main = root.querySelector(NAV_MAIN_CONTAINER_SELECTOR);
    if (main && isContainerReady(main)) {
      return main;
    }
    if (isContainerReady(root)) {
      return root;
    }
  }
  return null;
}

/**
 * 找到站点的「消息」条目，入口需插在它前面（即「大会员」之后、「消息」之前）。
 * 未登录分支会给触发节点输出 `data-idx`，登录分支没有，因此以触发文案兜底：
 * 窄屏下 `.trigger-text` 只是被 CSS 隐藏，textContent 依旧可读。
 */
function findMessageItem(container: Element): Element | null {
  const items = Array.from(container.children);

  const byIndex = items.find((item) => {
    const own = item.getAttribute('data-idx');
    const inner = item.querySelector('[data-idx]')?.getAttribute('data-idx');
    return own === MESSAGE_ITEM_IDX || inner === MESSAGE_ITEM_IDX;
  });
  if (byIndex) {
    return byIndex;
  }

  for (const item of items) {
    const label = normalizeText(item.querySelector(NAV_ITEM_TEXT_SELECTOR)?.textContent);
    if (label && MESSAGE_ITEM_LABELS.has(label.toLowerCase())) {
      return item;
    }
  }

  return null;
}

/**
 * 直接规范入口内 SVG 的高度，避免依赖样式层被站点覆盖。
 * 只作用于插件自己的条目，不触碰站点其它导航图标。
 */
function normalizeEntryIconHeight(entry: HTMLElement): void {
  entry.querySelectorAll('svg').forEach((svg) => {
    svg.setAttribute('height', String(RIGHT_ENTRY_SVG_HEIGHT));
    svg.style.height = `${RIGHT_ENTRY_SVG_HEIGHT}px`;
  });
}

function createNavEntry(): HTMLElement {
  // 条目外壳沿用站点类名，才能继承 header 的 flex 布局与间距规则
  const item = document.createElement('div');
  item.id = NAV_ENTRY_ID;
  item.className = 'right-entry__item';

  const anchor = document.createElement('a');
  anchor.className = 'right-entry__item-trigger';
  anchor.href = 'javascript:void(0)';

  // 站点把图标包在 .trigger-icon-wrap 中，红点正是相对它做绝对定位
  const iconWrap = document.createElement('div');
  iconWrap.className = NAV_ICON_WRAP_CLASS;
  iconWrap.innerHTML = NAV_ICON_SVG;

  const text = document.createElement('span');
  text.className = 'trigger-text';
  text.textContent = NAV_ENTRY_LABEL;

  anchor.appendChild(iconWrap);
  anchor.appendChild(text);

  item.appendChild(anchor);
  item.addEventListener('click', (event) => {
    event.preventDefault();
    window.dispatchEvent(new Event(EXTENSION_EVENT.TOGGLE_DRAWER));
  });

  return item;
}

/**
 * 幂等插入入口。
 * 站点局部重渲染会把节点摘掉，因此每次尝试都重新确认位置，
 * 已就位时 insertBefore 为无副作用操作。
 */
function insertNavEntry(container: Element, entry: HTMLElement): void {
  const reference = findMessageItem(container)
    ?? container.children[NAV_ENTRY_FALLBACK_INDEX]
    ?? null;

  if (reference === entry) {
    return;
  }
  container.insertBefore(entry, reference);
}

function ensureNavEntry(container: Element): HTMLElement {
  const existing = document.getElementById(NAV_ENTRY_ID);
  const entry = existing instanceof HTMLElement ? existing : createNavEntry();
  insertNavEntry(container, entry);
  normalizeEntryIconHeight(entry);
  return entry;
}

/**
 * 写入未读数字。
 * 站点类名为空文本时仍会渲染成色块，所以数量归零时直接移除节点；
 * 非零时只更新文本，不通过 display 切换显隐。
 */
function syncNavDot(entry: HTMLElement, text: string): void {
  const dot = entry.querySelector<HTMLElement>(`[${NAV_DOT_ATTR}="1"]`);
  if (!text) {
    dot?.remove();
    return;
  }

  if (dot) {
    dot.textContent = text;
    return;
  }

  // 红点必须挂在 .trigger-icon-wrap 内：站点的绝对定位是相对它计算的
  const host = entry.querySelector<HTMLElement>(`.${NAV_ICON_WRAP_CLASS}`) ?? entry;
  const next = document.createElement('div');
  next.setAttribute(NAV_DOT_ATTR, '1');
  next.className = 'red-num';
  next.textContent = text;
  host.insertBefore(next, host.firstChild);
}

function syncUnreadDot(): void {
  const entry = document.getElementById(NAV_ENTRY_ID);
  if (!(entry instanceof HTMLElement)) {
    return;
  }
  syncNavDot(entry, formatUnreadText(unreadCount));
}

function bindUnreadDot(): void {
  window.addEventListener(EXTENSION_EVENT.UNREAD_CHANGED, (event) => {
    const detail = (event as CustomEvent<{ hasUnread?: boolean; unreadCount?: number }>).detail;
    if (typeof detail?.unreadCount === 'number') {
      unreadCount = detail.unreadCount;
    } else {
      unreadCount = detail?.hasUnread ? 1 : 0;
    }
    syncUnreadDot();
  });
}

/**
 * 计算第 n 次重试的延迟（指数退避）。
 * 前 INJECT_FAST_RETRIES 次使用固定短间隔，之后每次翻倍，上限 INJECT_MAX_DELAY_MS。
 */
function retryDelay(attempt: number): number {
  if (attempt < INJECT_FAST_RETRIES) {
    return INJECT_INITIAL_DELAY_MS;
  }
  return Math.min(INJECT_INITIAL_DELAY_MS * 2 ** (attempt - INJECT_FAST_RETRIES), INJECT_MAX_DELAY_MS);
}

function createNavEntryController(): NavEntryController {
  let state: NavEntryInjectionState = 'pending';
  let disabled: boolean | null = null;
  let observedContainer: Element | null = null;
  let retryTimer: number | null = null;
  let attempt = 0;
  let elapsed = 0;
  let keepAliveObserver: MutationObserver | null = null;
  let recoveryBound = false;

  const stateListeners = new Set<(next: NavEntryInjectionState) => void>();

  function setState(next: NavEntryInjectionState): void {
    if (state === next) {
      return;
    }
    state = next;
    for (const listener of stateListeners) {
      listener(next);
    }
  }

  function cancelRetries(): void {
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function teardownKeepAlive(): void {
    keepAliveObserver?.disconnect();
    keepAliveObserver = null;
    observedContainer = null;
  }

  /**
   * 保活观察：只监听容器自身的直接子节点变化（`subtree: false`），
   * 用于覆盖站点局部重渲染把入口摘掉的情况，避免在视频页等高频 DOM 变化场景引入性能风险。
   */
  function attachKeepAlive(container: Element): void {
    teardownKeepAlive();
    observedContainer = container;
    keepAliveObserver = new MutationObserver(() => {
      if (disabled) {
        return;
      }
      if (!observedContainer?.isConnected) {
        // Header 整体被替换：先落到 unavailable（悬浮框接管），再在预算内尝试恢复
        teardownKeepAlive();
        setState('unavailable');
        beginRetries('recover');
        return;
      }
      if (!document.getElementById(NAV_ENTRY_ID)?.isConnected) {
        ensureNavEntry(observedContainer);
        syncUnreadDot();
      }
    });
    keepAliveObserver.observe(container, { childList: true });
  }

  /** 单次注入尝试；成功即进入 injected 并挂上保活观察 */
  function attemptInject(): boolean {
    const container = detectNavContainer();
    if (!container) {
      return false;
    }
    if (observedContainer !== container) {
      attachKeepAlive(container);
    }
    ensureNavEntry(container);
    syncUnreadDot();
    setState('injected');
    return true;
  }

  /**
   * 启动重试循环。
   * - `initial`：从 pending 开始，预算耗尽后落到 unavailable；
   * - `recover`：保持当前状态（通常是 unavailable），只在真正成功时切到 injected。
   */
  function beginRetries(mode: 'initial' | 'recover'): void {
    cancelRetries();
    attempt = 0;
    elapsed = 0;
    if (mode === 'initial') {
      setState('pending');
    }

    const scheduleNext = () => {
      const delay = retryDelay(attempt);
      elapsed += delay;
      if (elapsed > INJECT_MAX_TOTAL_MS) {
        if (mode === 'initial') {
          setState('unavailable');
        }
        return;
      }
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (disabled) {
          return;
        }
        attempt++;
        if (!attemptInject()) {
          scheduleNext();
        }
      }, delay);
    };

    if (!attemptInject()) {
      scheduleNext();
    }
  }

  /** 事件驱动的恢复尝试：仅在没有入口时触发一次，不做轮询 */
  function tryRecover(): void {
    if (disabled || state === 'injected') {
      return;
    }
    attemptInject();
  }

  function bindRecoveryTriggers(): void {
    if (recoveryBound) {
      return;
    }
    recoveryBound = true;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      tryRecover();
    });

    // 软导航：站点在 SPA 内跳转时可能整体重渲染 header
    const { pushState, replaceState } = window.history;
    window.history.pushState = function (...args) {
      const result = pushState.apply(this, args);
      tryRecover();
      return result;
    };
    window.history.replaceState = function (...args) {
      const result = replaceState.apply(this, args);
      tryRecover();
      return result;
    };
    window.addEventListener('popstate', tryRecover);
  }

  function setDisabled(next: boolean): void {
    if (disabled === next) {
      return;
    }
    disabled = next;

    if (disabled) {
      cancelRetries();
      teardownKeepAlive();
      document.getElementById(NAV_ENTRY_ID)?.remove();
      setState('unavailable');
      return;
    }

    beginRetries('initial');
  }

  bindRecoveryTriggers();

  return {
    setDisabled,
    getState: () => state,
    subscribe: (listener) => {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    }
  };
}

/**
 * 启动 Header 入口注入，并把「关闭 Header 入口注入」开关接入设置变更通道。
 *
 * 返回的 controller 供悬浮框入口订阅注入状态。
 */
export function startNavEntry(): NavEntryController {
  bindUnreadDot();
  const controller = createNavEntryController();
  void subscribeEntrySettings((settings) => {
    controller.setDisabled(settings.disableHeaderEntryInjection === true);
  });
  return controller;
}
