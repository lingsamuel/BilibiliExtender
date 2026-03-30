import { sendMessage, type ResponseMap } from '@/shared/messages';

type MembershipState = ResponseMap['GET_AUTHOR_GROUP_MEMBERSHIP'];
type MembershipUpdateState = ResponseMap['UPDATE_AUTHOR_GROUP_MEMBERSHIP'];
type AuthorEntrySource = 'video' | 'space' | 'card';
type QueryRoot = Document | ShadowRoot | HTMLElement;

interface AuthorEntryContext {
  mid: number;
  source: AuthorEntrySource;
  name?: string;
  face?: string;
  video?: {
    aid?: number;
    bvid?: string;
  };
}

interface DialogState {
  visible: boolean;
  loading: boolean;
  context: AuthorEntryContext | null;
  membership: MembershipState | null;
  error: string;
  pendingGroupIds: Set<string>;
}

const BUTTON_ATTR = 'data-bbe-author-group-button';
const VIDEO_ACTION_SELECTOR = '.up-detail-top';
const SPACE_ACTION_SELECTOR = '.interactions';

const membershipCache = new Map<number, MembershipState>();
const membershipPendingMap = new Map<number, Promise<MembershipState>>();
const buttonRegistry = new Map<number, Set<HTMLButtonElement>>();
const buttonContextMap = new WeakMap<HTMLButtonElement, AuthorEntryContext>();
let pageToastHost: HTMLElement | null = null;
let dialogBackdrop: HTMLDivElement | null = null;
let dialogRequestSeq = 0;
let scanScheduled = false;
let historyPatched = false;
let toastSeq = 0;

const dialogState: DialogState = {
  visible: false,
  loading: false,
  context: null,
  membership: null,
  error: '',
  pendingGroupIds: new Set<string>()
};

function normalizeText(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(text: string | undefined): string {
  return (text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractMidFromUrl(url: string | null | undefined): number | null {
  const match = (url ?? '').match(/space\.bilibili\.com\/(\d+)/);
  if (!match) {
    return null;
  }
  const mid = Math.max(1, Number(match[1]) || 0);
  return mid || null;
}

function extractMidFromElement(root: ParentNode): number | null {
  const anchors = root.querySelectorAll('a[href*="space.bilibili.com/"], a[href*="//space.bilibili.com/"]');
  for (const anchor of anchors) {
    const mid = extractMidFromUrl((anchor as HTMLAnchorElement).href || anchor.getAttribute('href'));
    if (mid) {
      return mid;
    }
  }
  return null;
}

function parseSpaceMidFromLocation(): number | null {
  const match = window.location.pathname.match(/^\/(\d+)(?:\/|$)/);
  if (!match) {
    return null;
  }
  const mid = Math.max(1, Number(match[1]) || 0);
  return mid || null;
}

function parseVideoBvidFromLocation(): string | undefined {
  const match = window.location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
  return match?.[1];
}

function queryFirst(root: QueryRoot, selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    const matched = root.querySelector(selector);
    if (matched instanceof HTMLElement) {
      return matched;
    }
  }
  return null;
}

function findAvatarUrl(root: QueryRoot): string | undefined {
  const selectors = [
    '.up-avatar img',
    '.header-face img',
    '.bili-user-profile-view__avatar img',
    '.h-avatar img',
    '.avatar img',
    'a[href*="space.bilibili.com/"] img'
  ];

  for (const selector of selectors) {
    const img = root.querySelector(selector);
    if (!(img instanceof HTMLImageElement)) {
      continue;
    }
    const src = img.currentSrc || img.src || '';
    if (src) {
      return src;
    }
  }

  return undefined;
}

function findAuthorName(root: QueryRoot): string | undefined {
  const selectors = [
    '.up-name',
    '.username',
    '.h-name',
    '#h-name',
    '.nickname',
    '.bili-user-profile-view__info__uname',
    '.bili-user-profile-view__info__name',
    'a[href*="space.bilibili.com/"]'
  ];

  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (!(element instanceof HTMLElement)) {
      continue;
    }
    const text = normalizeText(element.textContent);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function isElementVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  return element.getClientRects().length > 0;
}

function findFollowActionElement(root: QueryRoot): HTMLElement | null {
  const candidates = root.querySelectorAll('button, a, [role="button"], .follow-btn, .vui_button');
  for (const candidate of candidates) {
    if (!(candidate instanceof HTMLElement)) {
      continue;
    }
    if (candidate.getAttribute(BUTTON_ATTR) === '1') {
      continue;
    }
    const text = normalizeText(candidate.textContent);
    if (!text) {
      continue;
    }
    if (/关注/.test(text) && isElementVisible(candidate)) {
      return candidate;
    }
  }
  return null;
}

function registerButton(mid: number, button: HTMLButtonElement): void {
  const bucket = buttonRegistry.get(mid) ?? new Set<HTMLButtonElement>();
  bucket.add(button);
  buttonRegistry.set(mid, bucket);
}

function bindButtonContext(button: HTMLButtonElement, context: AuthorEntryContext): void {
  const previous = buttonContextMap.get(button);
  if (previous && previous.mid !== context.mid) {
    const oldBucket = buttonRegistry.get(previous.mid);
    oldBucket?.delete(button);
    if (oldBucket && oldBucket.size === 0) {
      buttonRegistry.delete(previous.mid);
    }
  }

  buttonContextMap.set(button, context);
  registerButton(context.mid, button);
}

function cleanupButtonRegistry(mid: number): Set<HTMLButtonElement> {
  const bucket = buttonRegistry.get(mid) ?? new Set<HTMLButtonElement>();
  const next = new Set(Array.from(bucket).filter((button) => button.isConnected));
  if (next.size === 0) {
    buttonRegistry.delete(mid);
    return next;
  }
  buttonRegistry.set(mid, next);
  return next;
}

function applyAuthorGroupButtonStyle(
  button: HTMLButtonElement,
  options: {
    grouped: boolean;
    pending: boolean;
    source: AuthorEntrySource;
  }
): void {
  const compact = options.source === 'card';
  button.style.display = 'inline-flex';
  button.style.alignItems = 'center';
  button.style.justifyContent = 'center';
  button.style.flex = '0 0 auto';
  button.style.gap = '6px';
  button.style.padding = compact ? '0 12px' : '0 14px';
  button.style.height = compact ? '30px' : '32px';
  button.style.minWidth = compact ? '88px' : '96px';
  button.style.marginLeft = '8px';
  button.style.borderRadius = '999px';
  button.style.border = options.grouped ? '1px solid #f8b9cb' : '1px solid #c8d2dc';
  button.style.background = options.grouped ? '#fff1f5' : '#ffffff';
  button.style.color = options.grouped ? '#d94873' : '#516175';
  button.style.fontSize = compact ? '12px' : '13px';
  button.style.fontWeight = '600';
  button.style.lineHeight = '1';
  button.style.cursor = options.pending ? 'wait' : 'pointer';
  button.style.opacity = options.pending ? '0.7' : '1';
  button.style.boxSizing = 'border-box';
  button.style.whiteSpace = 'nowrap';
  button.style.pointerEvents = 'auto';
}

function updateButtonText(button: HTMLButtonElement, label: string): void {
  button.textContent = label;
  button.setAttribute('aria-label', label);
  button.title = label;
}

function syncButtonsForMembership(mid: number, membership?: MembershipState): void {
  const buttons = cleanupButtonRegistry(mid);
  for (const button of buttons) {
    const context = buttonContextMap.get(button);
    if (!context) {
      continue;
    }
    const grouped = membership?.grouped ?? membershipCache.get(mid)?.grouped ?? false;
    button.disabled = false;
    updateButtonText(button, grouped ? '已分组' : '添加到分组');
    applyAuthorGroupButtonStyle(button, {
      grouped,
      pending: false,
      source: context.source
    });
  }
}

function setButtonLoading(button: HTMLButtonElement, context: AuthorEntryContext): void {
  button.disabled = true;
  updateButtonText(button, '分组...');
  applyAuthorGroupButtonStyle(button, {
    grouped: false,
    pending: true,
    source: context.source
  });
}

async function fetchMembership(mid: number, force = false): Promise<MembershipState> {
  if (!force && membershipCache.has(mid)) {
    return membershipCache.get(mid) as MembershipState;
  }

  const pending = membershipPendingMap.get(mid);
  if (pending) {
    return pending;
  }

  const task = (async () => {
    const resp = await sendMessage({
      type: 'GET_AUTHOR_GROUP_MEMBERSHIP',
      payload: { mid }
    });

    if (!resp.ok || !resp.data) {
      throw new Error(resp.error || '读取作者分组状态失败');
    }

    membershipCache.set(mid, resp.data);
    syncButtonsForMembership(mid, resp.data);
    return resp.data;
  })();

  membershipPendingMap.set(mid, task);
  try {
    return await task;
  } finally {
    membershipPendingMap.delete(mid);
  }
}

function pushToast(root: HTMLElement, message: string): void {
  if (!pageToastHost) {
    pageToastHost = document.createElement('div');
    pageToastHost.className = 'bbe-page-toast-stack';
    root.appendChild(pageToastHost);
  }

  const toast = document.createElement('div');
  toast.className = 'bbe-toast bbe-toast-error';
  toast.textContent = message;
  toast.dataset.toastId = String(++toastSeq);
  pageToastHost.appendChild(toast);

  const overflow = pageToastHost.children.length - 4;
  for (let i = 0; i < overflow; i++) {
    pageToastHost.firstElementChild?.remove();
  }

  window.setTimeout(() => {
    toast.remove();
  }, 2600);
}

function ensureDialog(root: HTMLElement): void {
  if (dialogBackdrop) {
    return;
  }

  dialogBackdrop = document.createElement('div');
  dialogBackdrop.className = 'bbe-author-group-backdrop';
  dialogBackdrop.style.display = 'none';
  dialogBackdrop.setAttribute('aria-hidden', 'true');
  dialogBackdrop.innerHTML = `
    <section class="bbe-author-group-dialog" role="dialog" aria-modal="true" aria-labelledby="bbe-author-group-dialog-title">
      <div class="bbe-author-group-dialog-head">
        <div class="bbe-author-group-author">
          <div class="bbe-author-group-author-face" aria-hidden="true"></div>
          <div class="bbe-author-group-author-meta">
            <div id="bbe-author-group-dialog-title" class="bbe-author-group-author-name"></div>
            <div class="bbe-author-group-author-subtitle"></div>
          </div>
        </div>
        <button type="button" class="bbe-author-group-close" aria-label="关闭">×</button>
      </div>
      <div class="bbe-author-group-body"></div>
    </section>
  `;

  dialogBackdrop.addEventListener('click', (event) => {
    if (event.target === dialogBackdrop) {
      closeDialog();
    }
  });

  dialogBackdrop.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.classList.contains('bbe-author-group-close')) {
      closeDialog();
      return;
    }

    const groupButton = target.closest<HTMLButtonElement>('[data-bbe-author-group-id]');
    if (!groupButton) {
      return;
    }
    void onGroupItemClick(root, groupButton.dataset.bbeAuthorGroupId || '');
  });

  root.appendChild(dialogBackdrop);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dialogState.visible) {
      closeDialog();
    }
  });
}

function renderDialog(): void {
  if (!dialogBackdrop) {
    return;
  }

  dialogBackdrop.style.display = dialogState.visible ? 'flex' : 'none';
  dialogBackdrop.setAttribute('aria-hidden', dialogState.visible ? 'false' : 'true');
  const dialog = dialogBackdrop.querySelector('.bbe-author-group-dialog');
  const faceEl = dialogBackdrop.querySelector('.bbe-author-group-author-face');
  const nameEl = dialogBackdrop.querySelector('.bbe-author-group-author-name');
  const subtitleEl = dialogBackdrop.querySelector('.bbe-author-group-author-subtitle');
  const bodyEl = dialogBackdrop.querySelector('.bbe-author-group-body');

  if (!(dialog instanceof HTMLElement) || !(faceEl instanceof HTMLElement) || !(nameEl instanceof HTMLElement)
    || !(subtitleEl instanceof HTMLElement) || !(bodyEl instanceof HTMLElement)) {
    return;
  }

  if (!dialogState.visible || !dialogState.context) {
    bodyEl.innerHTML = '';
    return;
  }

  const context = dialogState.context;
  const displayName = context.name?.trim() || `UID ${context.mid}`;
  nameEl.textContent = displayName;
  subtitleEl.textContent = `UID ${context.mid}`;

  if (context.face) {
    faceEl.innerHTML = `<img src="${escapeHtml(context.face)}" alt="" />`;
  } else {
    faceEl.textContent = (displayName[0] || 'UP').toUpperCase();
  }

  if (dialogState.loading) {
    bodyEl.innerHTML = '<div class="bbe-author-group-state">正在加载分组...</div>';
    return;
  }

  if (dialogState.error) {
    bodyEl.innerHTML = `<div class="bbe-author-group-state bbe-author-group-error">${escapeHtml(dialogState.error)}</div>`;
    return;
  }

  const membership = dialogState.membership;
  if (!membership || membership.groups.length === 0) {
    bodyEl.innerHTML = '<div class="bbe-author-group-state">还没有配置分组，请先到插件设置中创建分组。</div>';
    return;
  }

  bodyEl.innerHTML = `
    <div class="bbe-author-group-tip">
      点击分组即可切换当前作者的归属。已选中表示该作者当前已经属于该分组。
    </div>
    <div class="bbe-author-group-list">
      ${membership.groups.map((group) => {
        const pending = dialogState.pendingGroupIds.has(group.groupId);
        const statusText = pending
          ? '处理中...'
          : group.checked
            ? '已在分组中'
            : '添加到分组';
        return `
          <button
            type="button"
            class="bbe-author-group-item${group.checked ? ' checked' : ''}${pending ? ' pending' : ''}"
            data-bbe-author-group-id="${escapeHtml(group.groupId)}"
            ${pending ? 'disabled' : ''}
          >
            <span class="bbe-author-group-item-main">
              <span class="bbe-author-group-item-title">${escapeHtml(group.title)}</span>
              ${group.enabled ? '' : '<span class="bbe-author-group-item-tag">已停用</span>'}
            </span>
            <span class="bbe-author-group-item-status">${escapeHtml(statusText)}</span>
          </button>
        `;
      }).join('')}
    </div>
  `;
}

function closeDialog(): void {
  dialogState.visible = false;
  dialogState.loading = false;
  dialogState.error = '';
  dialogState.pendingGroupIds.clear();
  dialogState.context = null;
  dialogState.membership = null;
  renderDialog();
}

async function openDialog(root: HTMLElement, context: AuthorEntryContext): Promise<void> {
  dialogState.visible = true;
  dialogState.loading = true;
  dialogState.error = '';
  dialogState.context = context;
  dialogState.pendingGroupIds.clear();
  dialogState.membership = membershipCache.get(context.mid) ?? null;
  renderDialog();

  const requestId = ++dialogRequestSeq;
  try {
    const membership = await fetchMembership(context.mid, true);
    if (requestId !== dialogRequestSeq || dialogState.context?.mid !== context.mid) {
      return;
    }
    dialogState.membership = membership;
    dialogState.loading = false;
    renderDialog();
  } catch (error) {
    if (requestId !== dialogRequestSeq || dialogState.context?.mid !== context.mid) {
      return;
    }
    dialogState.loading = false;
    dialogState.error = error instanceof Error ? error.message : '读取作者分组状态失败';
    renderDialog();
  }
}

async function onGroupItemClick(root: HTMLElement, groupId: string): Promise<void> {
  const membership = dialogState.membership;
  const context = dialogState.context;
  if (!membership || !context || !groupId || dialogState.pendingGroupIds.has(groupId)) {
    return;
  }

  const group = membership.groups.find((item) => item.groupId === groupId);
  if (!group) {
    return;
  }

  const csrf = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/)?.[1];
  if (!csrf) {
    pushToast(root, '缺少 bili_jct，无法操作分组');
    return;
  }

  dialogState.pendingGroupIds.add(groupId);
  renderDialog();

  try {
    const resp = await sendMessage({
      type: 'UPDATE_AUTHOR_GROUP_MEMBERSHIP',
      payload: {
        mid: context.mid,
        groupId,
        action: group.checked ? 'remove' : 'add',
        csrf,
        pageOrigin: window.location.origin,
        pageReferer: window.location.href,
        source: context.source,
        video: context.video
      }
    });

    if (!resp.ok || !resp.data) {
      throw new Error(resp.error || '分组操作失败');
    }

    membershipCache.set(context.mid, {
      mid: resp.data.mid,
      grouped: resp.data.grouped,
      groups: resp.data.groups
    });
    dialogState.membership = membershipCache.get(context.mid) as MembershipState;
    syncButtonsForMembership(context.mid, dialogState.membership);
    pushToast(root, resp.data.message);
  } catch (error) {
    pushToast(root, error instanceof Error ? error.message : '分组操作失败');
  } finally {
    dialogState.pendingGroupIds.delete(groupId);
    renderDialog();
  }
}

function insertAfter(target: Element, node: HTMLElement): void {
  const parent = target.parentElement;
  if (!parent) {
    return;
  }
  if (target.nextSibling) {
    parent.insertBefore(node, target.nextSibling);
  } else {
    parent.appendChild(node);
  }
}

function createButton(root: HTMLElement, context: AuthorEntryContext): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute(BUTTON_ATTR, '1');
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const latestContext = buttonContextMap.get(button) ?? context;
    void openDialog(root, latestContext);
  });
  bindButtonContext(button, context);
  setButtonLoading(button, context);
  return button;
}

function upsertButton(root: HTMLElement, host: QueryRoot, actionRoot: HTMLElement, context: AuthorEntryContext): void {
  const existing = actionRoot.querySelector<HTMLButtonElement>(`button[${BUTTON_ATTR}="1"]`);
  const button = existing ?? createButton(root, context);

  bindButtonContext(button, context);

  if (!existing) {
    const followButton = findFollowActionElement(actionRoot);
    if (followButton) {
      insertAfter(followButton, button);
    } else {
      actionRoot.appendChild(button);
    }
  }

  const cached = membershipCache.get(context.mid);
  if (cached) {
    syncButtonsForMembership(context.mid, cached);
  } else {
    setButtonLoading(button, context);
    void fetchMembership(context.mid).catch(() => {
      button.disabled = false;
      updateButtonText(button, '添加到分组');
      applyAuthorGroupButtonStyle(button, {
        grouped: false,
        pending: false,
        source: context.source
      });
    });
  }

  // 对于 hover 卡片的 open shadow root，外部样式无法穿透；按钮样式以 inline 为准。
  if (host instanceof ShadowRoot) {
    button.style.pointerEvents = 'auto';
  }
}

function buildVideoContext(actionRoot: HTMLElement): AuthorEntryContext | null {
  const mid = extractMidFromElement(actionRoot) ?? extractMidFromElement(document);
  const bvid = parseVideoBvidFromLocation();
  if (!mid || !bvid) {
    return null;
  }

  return {
    mid,
    source: 'video',
    name: findAuthorName(actionRoot) ?? findAuthorName(document),
    face: findAvatarUrl(actionRoot) ?? findAvatarUrl(document),
    video: {
      bvid
    }
  };
}

function buildSpaceContext(actionRoot: HTMLElement): AuthorEntryContext | null {
  const mid = parseSpaceMidFromLocation();
  if (!mid) {
    return null;
  }

  return {
    mid,
    source: 'space',
    name: findAuthorName(document) ?? findAuthorName(actionRoot),
    face: findAvatarUrl(document) ?? findAvatarUrl(actionRoot)
  };
}

function buildCardContext(root: QueryRoot, actionRoot: HTMLElement): AuthorEntryContext | null {
  const mid = extractMidFromElement(root) ?? extractMidFromElement(actionRoot);
  if (!mid) {
    return null;
  }

  return {
    mid,
    source: 'card',
    name: findAuthorName(root) ?? findAuthorName(actionRoot),
    face: findAvatarUrl(root) ?? findAvatarUrl(actionRoot)
  };
}

function scanVideoPage(root: HTMLElement): void {
  if (!/\/video\//.test(window.location.pathname)) {
    return;
  }
  const actionRoot = document.querySelector(VIDEO_ACTION_SELECTOR);
  if (!actionRoot) {
    return;
  }
  const context = buildVideoContext(actionRoot);
  if (!context) {
    return;
  }
  upsertButton(root, document, actionRoot, context);
}

function scanSpacePage(root: HTMLElement): void {
  if (window.location.host !== 'space.bilibili.com') {
    return;
  }
  const actionRoot = document.querySelector(SPACE_ACTION_SELECTOR);
  if (!actionRoot) {
    return;
  }
  const context = buildSpaceContext(actionRoot);
  if (!context) {
    return;
  }
  upsertButton(root, document, actionRoot, context);
}

function runScan(root: HTMLElement): void {
  scanVideoPage(root);
  scanSpacePage(root);
}

function scheduleScan(root: HTMLElement): void {
  if (scanScheduled) {
    return;
  }
  scanScheduled = true;
  window.setTimeout(() => {
    scanScheduled = false;
    runScan(root);
  }, 60);
}

function patchHistory(root: HTMLElement): void {
  if (historyPatched) {
    return;
  }
  historyPatched = true;
  const { pushState, replaceState } = window.history;

  window.history.pushState = function (...args) {
    const result = pushState.apply(this, args);
    scheduleScan(root);
    return result;
  };

  window.history.replaceState = function (...args) {
    const result = replaceState.apply(this, args);
    scheduleScan(root);
    return result;
  };

  window.addEventListener('popstate', () => {
    scheduleScan(root);
  });
}

export function startAuthorGroupManager(root: HTMLElement): void {
  ensureDialog(root);
  runScan(root);

  const observer = new MutationObserver(() => {
    scheduleScan(root);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  patchHistory(root);
}
