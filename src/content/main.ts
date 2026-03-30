import { createApp } from 'vue';
import DrawerApp from '@/content/components/DrawerApp.vue';
import { startAuthorGroupManager } from '@/content/author-group-manager';
import { EXTENSION_EVENT } from '@/shared/constants';
import '@/styles/content.css';

const ROOT_ID = 'bbe-root';
const NAV_ENTRY_ID = 'bbe-nav-entry';
let unreadCount = 0;

function logBootstrapBadge(): void {
  const version = chrome.runtime?.getManifest?.().version ?? 'dev';
  console.log(
    '%c bilibili-extender %c v%s ',
    'background:#ff4f91;color:#ffffff;border-radius:2px 0 0 2px;padding:2px 10px;font-weight:700;',
    'background:#ffb7bf;color:#ffffff;border-radius:0 2px 2px 0;padding:2px 10px;font-weight:700;',
    version
  );
}

function formatUnreadText(count: number): string {
  if (count <= 0) {
    return '';
  }
  return count > 99 ? '99+' : String(count);
}

function createRoot(): HTMLElement {
  const existing = document.getElementById(ROOT_ID);
  if (existing) {
    return existing;
  }

  const root = document.createElement('div');
  root.id = ROOT_ID;
  document.body.appendChild(root);
  return root;
}

const NAV_ENTRY_TARGET_INDEX = 2;
const RIGHT_ENTRY_SVG_HEIGHT = 20;

// 将按钮插入到 container 的第 NAV_ENTRY_TARGET_INDEX 个子元素之前（即第三个位置）
function insertAtTargetPosition(container: Element, entry: HTMLElement): void {
  const children = container.children;
  const ref = children[NAV_ENTRY_TARGET_INDEX] ?? null;
  if (ref === entry) {
    return;
  }
  container.insertBefore(entry, ref);
}

/**
 * 直接规范 right-entry 下所有 SVG 的高度，避免依赖样式层被站点覆盖。
 * 同时写入属性和内联样式，尽可能兼容不同来源的图标实现。
 */
function normalizeRightEntrySvgHeight(container: Element): void {
  const svgs = container.querySelectorAll('svg');

  svgs.forEach((svg) => {
    svg.setAttribute('height', String(RIGHT_ENTRY_SVG_HEIGHT));
    svg.style.height = `${RIGHT_ENTRY_SVG_HEIGHT}px`;
  });
}

// 分组动态图标：网格布局 SVG，表示分组/分类概念
const NAV_ICON_SVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="right-entry-icon">
  <rect x="2" y="2" width="7" height="7" rx="1.5" fill="currentColor"/>
  <rect x="11" y="2" width="7" height="7" rx="1.5" fill="currentColor"/>
  <rect x="2" y="11" width="7" height="7" rx="1.5" fill="currentColor"/>
  <rect x="11" y="11" width="7" height="7" rx="1.5" fill="currentColor"/>
</svg>`;

function ensureNavEntry(container: Element): HTMLLIElement {
  const existing = document.getElementById(NAV_ENTRY_ID) as HTMLLIElement | null;
  if (existing) {
    insertAtTargetPosition(container, existing);
    return existing;
  }

  const li = document.createElement('li');
  li.id = NAV_ENTRY_ID;
  li.className = 'right-entry-item';
  li.style.marginRight = '0';
  li.style.position = 'relative';

  const anchor = document.createElement('a');
  anchor.className = 'right-entry__outside';
  anchor.href = 'javascript:void(0)';
  anchor.innerHTML = NAV_ICON_SVG;

  const text = document.createElement('span');
  text.className = 'right-entry-text';
  text.textContent = '分组动态';
  anchor.appendChild(text);

  if (unreadCount > 0) {
    const dot = document.createElement('div');
    dot.className = 'red-num--message';
    dot.textContent = formatUnreadText(unreadCount);
    li.appendChild(dot);
  }
  li.appendChild(anchor);

  li.addEventListener('click', (e) => {
    e.preventDefault();
    window.dispatchEvent(new Event(EXTENSION_EVENT.TOGGLE_DRAWER));
  });

  insertAtTargetPosition(container, li);
  return li;
}

/**
 * 判断 .right-entry 是否已完成渲染。
 * B 站 header 渲染完成后，.right-entry 下至少包含 5 个 .right-entry-text 元素
 * （消息、动态、收藏、历史、创作中心等），以此作为就绪信号，
 * 避免在 header 半渲染状态下注入导致额外 DOM 抖动。
 */
const NAV_READY_MIN_ENTRY_TEXT_COUNT = 5;

function isHeaderReady(container: Element): boolean {
  return container.querySelectorAll('.right-entry-text').length >= NAV_READY_MIN_ENTRY_TEXT_COUNT;
}

function findReadyHeaderContainer(): Element | null {
  const selectors = [
    '.right-entry',
    '.mini-header__content .right-entry',
    '.bili-header__bar .right-entry'
  ];

  for (const selector of selectors) {
    const matched = document.querySelector(selector);
    if (matched && isHeaderReady(matched)) {
      return matched;
    }
  }

  return null;
}

const INJECT_INITIAL_DELAY_MS = 300;
const INJECT_FAST_RETRIES = 5;
const INJECT_MAX_DELAY_MS = 5000;
const INJECT_MAX_TOTAL_MS = 30_000;

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

/**
 * 尝试注入导航入口按钮。
 * 采用指数退避重试，等待 .right-entry 渲染就绪后再注入，
 * 避免在视频播放页等 DOM 高频变化的场景下引发性能雪崩。
 */
function startInjectNavEntry(): void {
  const tryInject = (): boolean => {
    const container = findReadyHeaderContainer();
    if (!container) {
      return false;
    }
    ensureNavEntry(container);
    normalizeRightEntrySvgHeight(container);
    return true;
  };

  if (tryInject()) {
    return;
  }

  let attempt = 0;
  let elapsed = 0;

  const scheduleNext = () => {
    const delay = retryDelay(attempt);
    elapsed += delay;
    if (elapsed > INJECT_MAX_TOTAL_MS) {
      return;
    }
    setTimeout(() => {
      attempt++;
      if (!tryInject()) {
        scheduleNext();
      }
    }, delay);
  };

  scheduleNext();
}

function bindUnreadDot(): void {
  window.addEventListener(EXTENSION_EVENT.UNREAD_CHANGED, (event) => {
    const detail = (event as CustomEvent<{ hasUnread?: boolean; unreadCount?: number }>).detail;
    if (typeof detail?.unreadCount === 'number') {
      unreadCount = detail.unreadCount;
    } else {
      unreadCount = detail?.hasUnread ? 1 : 0;
    }
    const entry = document.getElementById(NAV_ENTRY_ID) as HTMLLIElement | null;
    if (!entry) {
      return;
    }
    const text = formatUnreadText(unreadCount);
    const target = entry.querySelector('.red-num--message') as HTMLElement | null;

    if (!text) {
      target?.remove();
      return;
    }

    if (target) {
      target.textContent = text;
      return;
    }

    const dot = document.createElement('div');
    dot.className = 'red-num--message';
    dot.textContent = text;
    entry.insertBefore(dot, entry.firstChild);
  });
}

function bootstrap(): void {
  logBootstrapBadge();
  bindUnreadDot();
  const root = createRoot();
  createApp(DrawerApp).mount(root);
  startInjectNavEntry();
  startAuthorGroupManager(root);
}

bootstrap();
