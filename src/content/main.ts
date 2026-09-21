import { createApp } from 'vue';
import DrawerApp from '@/content/components/DrawerApp.vue';
import { startAuthorGroupManager } from '@/content/author-group-manager';
import { startFloatingEntry } from '@/content/floating-entry';
import { startNavEntry } from '@/content/nav-entry';
import { sendMessage } from '@/shared/messages';
import { debugLog, initDebugConsoleState } from '@/shared/utils/debug-console';
import '@/styles/content.css';

const ROOT_ID = 'bbe-root';

function logBootstrapBadge(): void {
  const version = chrome.runtime?.getManifest?.().version ?? 'dev';
  debugLog(
    '%c bilibili-extender %c v%s ',
    'background:#ff4f91;color:#ffffff;border-radius:2px 0 0 2px;padding:2px 10px;font-weight:700;',
    'background:#ffb7bf;color:#ffffff;border-radius:0 2px 2px 0;padding:2px 10px;font-weight:700;',
    version
  );
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

function bootstrap(): void {
  void initDebugConsoleState().then(() => {
    logBootstrapBadge();
  });
  const root = createRoot();
  createApp(DrawerApp).mount(root);
  // 悬浮框必须挂载在 Vue 应用之后：Vue 挂载时会清空容器
  startFloatingEntry(startNavEntry());
  startAuthorGroupManager(root);
  // 每个匹配站点标签页在 content script 首次完成初始化后只上报一次，
  // 作为“标签页初次打开”机会式刷新的触发信号。
  void sendMessage({ type: 'REPORT_BILIBILI_TAB_OPEN' }).catch(() => {
    // 机会式刷新失败不影响页面主功能。
  });
}

bootstrap();
