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

function createNavEntry(container: Element): HTMLDivElement {
  const existing = document.getElementById(NAV_ENTRY_ID) as HTMLDivElement | null;
  if (existing) {
    return existing;
  }

  const entry = document.createElement('div');
  entry.id = NAV_ENTRY_ID;
  entry.className = 'bbe-nav-entry';
  entry.textContent = '分组动态';

  const dot = document.createElement('span');
  dot.className = 'bbe-nav-dot';
  dot.style.display = hasUnread ? 'block' : 'none';
  entry.appendChild(dot);

  entry.addEventListener('click', () => {
    window.dispatchEvent(new Event(EXTENSION_EVENT.TOGGLE_DRAWER));
  });

  container.appendChild(entry);
  return entry;
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

    createNavEntry(container);
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
    const target = document.querySelector('#bbe-nav-entry .bbe-nav-dot') as HTMLElement | null;
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
