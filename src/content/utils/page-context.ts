import { EXTENSION_EVENT } from '@/shared/constants';
import { ext } from '@/shared/platform/webext';

const PAGE_BRIDGE_SCRIPT_ID = 'bbe-page-bridge-script';
const PAGE_BRIDGE_SCRIPT_PATH = 'assets/page-bridge.js';
const PAGE_BRIDGE_TIMEOUT_MS = 15_000;

interface FollowAuthorPageRequest {
  id: string;
  type: 'follow-author';
  payload: {
    mid: number;
    follow: boolean;
    csrf: string;
  };
}

interface PageBridgeResponse {
  id: string;
  ok: boolean;
  error?: string;
}

let requestSeq = 0;
let bridgeReadyPromise: Promise<void> | null = null;

/**
 * 注入页面主世界桥接脚本，使关注请求由站点上下文发起。
 */
export function ensurePageBridgeReady(): Promise<void> {
  if (bridgeReadyPromise) {
    return bridgeReadyPromise;
  }

  bridgeReadyPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById(PAGE_BRIDGE_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing?.dataset.loaded === 'true') {
      resolve();
      return;
    }

    const script = existing ?? document.createElement('script');
    script.id = PAGE_BRIDGE_SCRIPT_ID;
    script.src = ext.runtime.getURL(PAGE_BRIDGE_SCRIPT_PATH);
    script.async = false;

    const cleanup = () => {
      script.removeEventListener('load', handleLoad);
      script.removeEventListener('error', handleError);
    };

    const handleLoad = () => {
      script.dataset.loaded = 'true';
      cleanup();
      resolve();
    };

    const handleError = () => {
      cleanup();
      bridgeReadyPromise = null;
      reject(new Error('页面桥接脚本注入失败'));
    };

    script.addEventListener('load', handleLoad, { once: true });
    script.addEventListener('error', handleError, { once: true });

    if (!existing) {
      (document.head ?? document.documentElement).appendChild(script);
    }
  });

  return bridgeReadyPromise;
}

/**
 * 通过页面主世界桥接脚本发起关注/取关，避免扩展后台请求暴露扩展来源上下文。
 */
export async function followAuthorViaPageContext(
  mid: number,
  follow: boolean,
  csrf: string
): Promise<void> {
  await ensurePageBridgeReady();

  const id = `${Date.now()}-${++requestSeq}`;
  const detail: FollowAuthorPageRequest = {
    id,
    type: 'follow-author',
    payload: {
      mid,
      follow,
      csrf
    }
  };

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener(EXTENSION_EVENT.PAGE_BRIDGE_RESPONSE, handleResponse as EventListener);
    };

    const handleResponse = (event: Event) => {
      const response = (event as CustomEvent<PageBridgeResponse>).detail;
      if (!response || response.id !== id) {
        return;
      }

      cleanup();
      if (response.ok) {
        resolve();
        return;
      }

      reject(new Error(response.error ?? (follow ? '关注失败' : '取消关注失败')));
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error(follow ? '页面侧关注请求超时' : '页面侧取消关注请求超时'));
    }, PAGE_BRIDGE_TIMEOUT_MS);

    window.addEventListener(EXTENSION_EVENT.PAGE_BRIDGE_RESPONSE, handleResponse as EventListener);
    window.dispatchEvent(new CustomEvent<FollowAuthorPageRequest>(EXTENSION_EVENT.PAGE_BRIDGE_REQUEST, {
      detail
    }));
  });
}
