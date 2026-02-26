import { createApp } from 'vue';
import DrawerApp from '@/content/components/DrawerApp.vue';
import { EXTENSION_EVENT } from '@/shared/constants';
import '@/styles/content.css';

const ROOT_ID = 'bbe-root';
const NAV_ENTRY_ID = 'bbe-nav-entry';
let hasUnread = false;

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

// 将按钮插入到 container 的第 NAV_ENTRY_TARGET_INDEX 个子元素之前（即第三个位置）
function insertAtTargetPosition(container: Element, entry: HTMLElement): void {
  const children = container.children;
  const ref = children[NAV_ENTRY_TARGET_INDEX] ?? null;
  if (ref === entry) {
    return;
  }
  container.insertBefore(entry, ref);
}

// 分组动态图标：网格布局 SVG，表示分组/分类概念
const NAV_ICON_SVG = `<svg width="20" height="21" viewBox="0 0 20 21" fill="none" xmlns="http://www.w3.org/2000/svg" class="right-entry-icon">
  <rect x="2" y="2.5" width="7" height="7" rx="1.5" fill="currentColor"/>
  <rect x="11" y="2.5" width="7" height="7" rx="1.5" fill="currentColor"/>
  <rect x="2" y="11.5" width="7" height="7" rx="1.5" fill="currentColor"/>
  <rect x="11" y="11.5" width="7" height="7" rx="1.5" fill="currentColor"/>
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

  const dot = document.createElement('div');
  dot.className = 'bbe-nav-dot';
  dot.style.display = hasUnread ? 'block' : 'none';

  const anchor = document.createElement('a');
  anchor.className = 'right-entry__outside';
  anchor.href = 'javascript:void(0)';
  anchor.innerHTML = NAV_ICON_SVG;

  const text = document.createElement('span');
  text.className = 'right-entry-text';
  text.textContent = '分组动态';
  anchor.appendChild(text);

  li.appendChild(dot);
  li.appendChild(anchor);

  li.addEventListener('click', (e) => {
    e.preventDefault();
    window.dispatchEvent(new Event(EXTENSION_EVENT.TOGGLE_DRAWER));
  });

  insertAtTargetPosition(container, li);
  return li;
}

function findHeaderContainer(): Element | null {
  const selectors = [
    '.right-entry',
    '.mini-header__content .right-entry',
    '.bili-header__bar .right-entry',
    '.h .h-right',
    '.h .wrapper .right',
    'header .right'
  ];

  for (const selector of selectors) {
    const matched = document.querySelector(selector);
    if (matched) {
      return matched;
    }
  }

  const header = document.querySelector('header');
  return header;
}

function startInjectNavEntry(): void {
  const inject = () => {
    const container = findHeaderContainer();
    if (!container) {
      return;
    }

    ensureNavEntry(container);
  };

  inject();

  const observer = new MutationObserver(() => {
    inject();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  window.addEventListener('beforeunload', () => observer.disconnect(), { once: true });
}

function bindUnreadDot(): void {
  window.addEventListener(EXTENSION_EVENT.UNREAD_CHANGED, (event) => {
    hasUnread = Boolean((event as CustomEvent<{ hasUnread: boolean }>).detail?.hasUnread);
    const target = document.querySelector(`#${NAV_ENTRY_ID} .bbe-nav-dot`) as HTMLElement | null;
    if (!target) {
      return;
    }
    target.style.display = hasUnread ? 'block' : 'none';
  });
}

function bootstrap(): void {
  bindUnreadDot();
  const root = createRoot();
  createApp(DrawerApp).mount(root);
  startInjectNavEntry();
}

bootstrap();
