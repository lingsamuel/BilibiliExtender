import { EXTENSION_EVENT } from '@/shared/constants';

const API_BASE = 'https://api.bilibili.com';
const RELATION_SPMID = '333.1387';
const RELATION_STATISTICS = JSON.stringify({
  appId: 100,
  platform: 5
});
const RELATION_DEVICE_REQ = JSON.stringify({
  platform: 'web',
  device: 'pc',
  spmid: RELATION_SPMID
});

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

declare global {
  interface Window {
    __bbePageBridgeInstalled?: boolean;
  }
}

function emitResponse(detail: PageBridgeResponse): void {
  window.dispatchEvent(new CustomEvent<PageBridgeResponse>(EXTENSION_EVENT.PAGE_BRIDGE_RESPONSE, {
    detail
  }));
}

async function handleFollowAuthorRequest(detail: FollowAuthorPageRequest): Promise<void> {
  const mid = Math.max(1, Math.floor(Number(detail.payload.mid) || 0));
  const csrf = detail.payload.csrf?.trim();
  if (!mid || !csrf) {
    throw new Error('关注参数不完整');
  }

  const url = new URL('/x/relation/modify', API_BASE);
  url.searchParams.set('statistics', RELATION_STATISTICS);
  url.searchParams.set('x-bili-device-req-json', RELATION_DEVICE_REQ);

  const form = new URLSearchParams();
  form.set('fid', String(mid));
  form.set('act', detail.payload.follow ? '1' : '2');
  form.set('re_src', '11');
  form.set('gaia_source', 'web_main');
  form.set('spmid', RELATION_SPMID);
  form.set('extend_content', JSON.stringify({
    entity: 'user',
    entity_id: mid
  }));
  form.set('is_from_frontend_component', 'true');
  form.set('csrf', csrf);

  const response = await fetch(url.toString(), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });

  if (!response.ok) {
    throw new Error(`请求失败: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    code?: number;
    message?: string;
  };
  if (payload.code !== 0) {
    throw new Error(`接口错误: ${payload.code} ${payload.message ?? ''}`.trim());
  }
}

function bindPageBridge(): void {
  if (window.__bbePageBridgeInstalled) {
    return;
  }

  window.__bbePageBridgeInstalled = true;
  window.addEventListener(EXTENSION_EVENT.PAGE_BRIDGE_REQUEST, (event) => {
    const detail = (event as CustomEvent<FollowAuthorPageRequest>).detail;
    if (!detail || detail.type !== 'follow-author') {
      return;
    }

    void handleFollowAuthorRequest(detail)
      .then(() => {
        emitResponse({
          id: detail.id,
          ok: true
        });
      })
      .catch((error) => {
        emitResponse({
          id: detail.id,
          ok: false,
          error: error instanceof Error ? error.message : '页面侧关注请求失败'
        });
      });
  });
}

bindPageBridge();
