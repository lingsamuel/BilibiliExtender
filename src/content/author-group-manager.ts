import authorGroupButtonCssText from '@/styles/author-group-button.css?inline';
import { EXTENSION_EVENT } from '@/shared/constants';
import { sendMessage, type ResponseMap } from '@/shared/messages';

type MembershipState = ResponseMap['GET_AUTHOR_GROUP_MEMBERSHIP'];
type DialogData = ResponseMap['GET_AUTHOR_GROUP_DIALOG_DATA'];
type AuthorEntrySource = 'video' | 'space' | 'card' | 'drawer';
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
  availableFolders: DialogData['availableFolders'];
  error: string;
  pendingGroupIds: Set<string>;
  pendingFolderIds: Set<number>;
  creatingFolder: boolean;
  newFolderTitle: string;
}

const BUTTON_ATTR = 'data-bbe-author-group-button';
const BUTTON_CLASS = 'bbe-author-follow-btn';
const BUTTON_EXTRA_CLASS = 'bbe-injected-author-group-btn';
const VIDEO_ACTION_SELECTOR = '.up-detail-top';
const SPACE_ACTION_SELECTOR = '.interactions';
const CARD_ROOT_SELECTOR = '.usercard-wrap';
const CARD_ACTION_SELECTOR = '.btn-box';
const CARD_NAME_LINK_SELECTOR = '.user .name';
const PROFILE_CARD_HOST_SELECTOR = 'bili-user-profile';
const PROFILE_CARD_ACTION_SELECTOR = '#action';
const PROFILE_CARD_AVATAR_SELECTOR = '#avatar';

const membershipCache = new Map<number, MembershipState>();
const membershipPendingMap = new Map<number, Promise<MembershipState>>();
const buttonRegistry = new Map<number, Set<HTMLButtonElement>>();
const buttonContextMap = new WeakMap<HTMLButtonElement, AuthorEntryContext>();
const shadowRootObserverSet = new WeakSet<ShadowRoot>();
const shadowRootStyleSet = new WeakSet<ShadowRoot>();
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
  availableFolders: [],
  error: '',
  pendingGroupIds: new Set<string>(),
  pendingFolderIds: new Set<number>(),
  creatingFolder: false,
  newFolderTitle: ''
};

function getCheckedGroupCount(membership: Pick<MembershipState, 'groups'> | null | undefined): number {
  return membership?.groups.filter((group) => group.checked).length ?? 0;
}

function getAuthorGroupButtonLabel(membership: Pick<MembershipState, 'grouped' | 'groups'> | null | undefined): string {
  if (!membership?.grouped) {
    return '添加到分组';
  }
  const count = getCheckedGroupCount(membership);
  return count > 0 ? `已分组(${count})` : '已分组';
}

function dispatchMembershipChanged(mid: number, membership: MembershipState): void {
  window.dispatchEvent(new CustomEvent(EXTENSION_EVENT.AUTHOR_GROUP_MEMBERSHIP_CHANGED, {
    detail: {
      mid,
      grouped: membership.grouped,
      count: getCheckedGroupCount(membership)
    }
  }));
}

function syncMembershipCache(mid: number, membership: MembershipState): void {
  membershipCache.set(mid, membership);
  dispatchMembershipChanged(mid, membership);
  syncButtonsForMembership(mid, membership);
}

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

function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
  if (!match || !match[1]) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
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

function extractMidFromAnchor(anchor: Element | null): number | null {
  if (!(anchor instanceof HTMLAnchorElement)) {
    return null;
  }
  return extractMidFromUrl(anchor.href || anchor.getAttribute('href'));
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

function syncAuthorGroupButtonState(
  button: HTMLButtonElement,
  options: {
    grouped: boolean;
    pending: boolean;
  }
): void {
  button.classList.add(BUTTON_CLASS, BUTTON_EXTRA_CLASS);
  button.classList.toggle('followed', options.grouped);
  button.classList.toggle('loading', options.pending);
  button.disabled = options.pending;
}

function updateButtonText(button: HTMLButtonElement, label: string): void {
  button.textContent = label;
  button.setAttribute('aria-label', label);
  button.title = label;
}

function syncButtonsForMembership(mid: number, membership?: MembershipState): void {
  const buttons = cleanupButtonRegistry(mid);
  for (const button of buttons) {
    const grouped = membership?.grouped ?? membershipCache.get(mid)?.grouped ?? false;
    updateButtonText(button, getAuthorGroupButtonLabel(membership ?? membershipCache.get(mid) ?? null));
    syncAuthorGroupButtonState(button, {
      grouped,
      pending: false
    });
  }
}

function setButtonLoading(button: HTMLButtonElement): void {
  updateButtonText(button, '分组...');
  syncAuthorGroupButtonState(button, {
    grouped: false,
    pending: true
  });
}

function ensureShadowRootButtonStyles(shadowRoot: ShadowRoot): void {
  if (shadowRootStyleSet.has(shadowRoot)) {
    return;
  }

  const style = document.createElement('style');
  style.textContent = authorGroupButtonCssText;
  shadowRoot.appendChild(style);
  shadowRootStyleSet.add(shadowRoot);
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

    syncMembershipCache(mid, resp.data);
    return resp.data;
  })();

  membershipPendingMap.set(mid, task);
  try {
    return await task;
  } finally {
    membershipPendingMap.delete(mid);
  }
}

async function fetchDialogData(mid: number): Promise<DialogData> {
  const resp = await sendMessage({
    type: 'GET_AUTHOR_GROUP_DIALOG_DATA',
    payload: { mid }
  });

  if (!resp.ok || !resp.data) {
    throw new Error(resp.error || '读取作者分组弹框数据失败');
  }

  syncMembershipCache(mid, {
    mid: resp.data.mid,
    grouped: resp.data.grouped,
    groups: resp.data.groups
  });

  return resp.data;
}

function applyDialogData(data: DialogData): void {
  const membership: MembershipState = {
    mid: data.mid,
    grouped: data.grouped,
    groups: data.groups
  };
  syncMembershipCache(data.mid, membership);
  dialogState.membership = membership;
  dialogState.availableFolders = data.availableFolders;
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
    if (groupButton) {
      void onGroupItemClick(root, groupButton.dataset.bbeAuthorGroupId || '');
      return;
    }

    const folderButton = target.closest<HTMLButtonElement>('[data-bbe-author-group-folder-id]');
    if (!folderButton) {
      return;
    }
    void onCreateGroupFromFolderClick(root, Number(folderButton.dataset.bbeAuthorGroupFolderId));
  });

  dialogBackdrop.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.dataset.bbeAuthorGroupCreateInput !== '1') {
      return;
    }
    dialogState.newFolderTitle = target.value;
  });

  dialogBackdrop.addEventListener('submit', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLFormElement) || !target.classList.contains('bbe-author-group-create-form')) {
      return;
    }
    event.preventDefault();
    void onCreateFolderSubmit(root);
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
    bodyEl.innerHTML = '<div class="bbe-author-group-state">正在加载分组与收藏夹...</div>';
    return;
  }

  if (dialogState.error) {
    bodyEl.innerHTML = `<div class="bbe-author-group-state bbe-author-group-error">${escapeHtml(dialogState.error)}</div>`;
    return;
  }

  const membership = dialogState.membership;
  const availableFolders = dialogState.availableFolders;
  const hasGroups = (membership?.groups.length ?? 0) > 0;
  const hasAvailableFolders = availableFolders.length > 0;
  const hasNewFolderTitle = dialogState.newFolderTitle.trim().length > 0;

  bodyEl.innerHTML = `
    <div class="bbe-author-group-tip">
      点击已有分组即可切换当前作者的归属。你也可以直接从收藏夹创建分组，或新建私密收藏夹并创建分组；这些创建操作都不会自动把当前作者加入新分组。
    </div>
    <div class="bbe-author-group-section">
      <div class="bbe-author-group-section-title">已有插件分组</div>
      ${hasGroups ? `
        <div class="bbe-author-group-list">
          ${membership!.groups.map((group) => {
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
      ` : '<div class="bbe-author-group-state">还没有插件分组，可以直接从下方收藏夹创建。</div>'}
    </div>
    <div class="bbe-author-group-section">
      <div class="bbe-author-group-section-title">从已有收藏夹创建分组</div>
      ${hasAvailableFolders ? `
        <div class="bbe-author-group-list">
          ${availableFolders.map((folder) => {
            const pending = dialogState.pendingFolderIds.has(folder.id);
            return `
              <button
                type="button"
                class="bbe-author-group-item${pending ? ' pending' : ''}"
                data-bbe-author-group-folder-id="${folder.id}"
                ${pending || dialogState.creatingFolder ? 'disabled' : ''}
              >
                <span class="bbe-author-group-item-main">
                  <span class="bbe-author-group-item-title">${escapeHtml(folder.title)}</span>
                  <span class="bbe-author-group-item-tag">${folder.mediaCount} 个内容</span>
                </span>
                <span class="bbe-author-group-item-status">${pending ? '创建中...' : '创建为分组'}</span>
              </button>
            `;
          }).join('')}
        </div>
      ` : '<div class="bbe-author-group-state">没有可直接创建为分组的收藏夹。</div>'}
    </div>
    <div class="bbe-author-group-section">
      <div class="bbe-author-group-section-title">新建私密收藏夹并创建分组</div>
      <form class="bbe-author-group-create-form">
        <input
          type="text"
          class="bbe-author-group-create-input"
          data-bbe-author-group-create-input="1"
          maxlength="80"
          placeholder="输入收藏夹标题"
          value="${escapeHtml(dialogState.newFolderTitle)}"
          ${dialogState.creatingFolder ? 'disabled' : ''}
        />
        <button
          type="submit"
          class="bbe-author-group-create-submit${dialogState.creatingFolder ? ' pending' : ''}"
          ${dialogState.creatingFolder || !hasNewFolderTitle ? 'disabled' : ''}
        >
          ${dialogState.creatingFolder ? '创建中...' : '创建并生成分组'}
        </button>
      </form>
      <div class="bbe-author-group-tip bbe-author-group-tip-inline">
        新建的收藏夹默认私密，创建成功后只会新增分组，不会自动把当前作者加入进去。
      </div>
    </div>
  `;
}

function closeDialog(): void {
  dialogState.visible = false;
  dialogState.loading = false;
  dialogState.error = '';
  dialogState.pendingGroupIds.clear();
  dialogState.pendingFolderIds.clear();
  dialogState.creatingFolder = false;
  dialogState.newFolderTitle = '';
  dialogState.context = null;
  dialogState.membership = null;
  dialogState.availableFolders = [];
  renderDialog();
}

async function openDialog(root: HTMLElement, context: AuthorEntryContext): Promise<void> {
  dialogState.visible = true;
  dialogState.loading = true;
  dialogState.error = '';
  dialogState.context = context;
  dialogState.pendingGroupIds.clear();
  dialogState.pendingFolderIds.clear();
  dialogState.creatingFolder = false;
  dialogState.newFolderTitle = '';
  dialogState.membership = membershipCache.get(context.mid) ?? null;
  dialogState.availableFolders = [];
  renderDialog();

  const requestId = ++dialogRequestSeq;
  try {
    const dialogData = await fetchDialogData(context.mid);
    if (requestId !== dialogRequestSeq || dialogState.context?.mid !== context.mid) {
      return;
    }
    applyDialogData(dialogData);
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

  const csrf = getCsrfToken();
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

    syncMembershipCache(context.mid, {
      mid: resp.data.mid,
      grouped: resp.data.grouped,
      groups: resp.data.groups
    });
    dialogState.membership = membershipCache.get(context.mid) as MembershipState;
    pushToast(root, resp.data.message);
  } catch (error) {
    pushToast(root, error instanceof Error ? error.message : '分组操作失败');
  } finally {
    dialogState.pendingGroupIds.delete(groupId);
    renderDialog();
  }
}

async function onCreateGroupFromFolderClick(root: HTMLElement, mediaId: number): Promise<void> {
  const context = dialogState.context;
  if (!context || !mediaId || dialogState.pendingFolderIds.has(mediaId) || dialogState.creatingFolder) {
    return;
  }

  dialogState.pendingFolderIds.add(mediaId);
  renderDialog();

  try {
    const resp = await sendMessage({
      type: 'CREATE_AUTHOR_GROUP_FROM_FOLDER',
      payload: {
        mid: context.mid,
        mediaId
      }
    });

    if (!resp.ok || !resp.data) {
      throw new Error(resp.error || '创建分组失败');
    }

    applyDialogData(resp.data);
    pushToast(root, resp.data.message);
  } catch (error) {
    pushToast(root, error instanceof Error ? error.message : '创建分组失败');
  } finally {
    dialogState.pendingFolderIds.delete(mediaId);
    renderDialog();
  }
}

async function onCreateFolderSubmit(root: HTMLElement): Promise<void> {
  const context = dialogState.context;
  const title = dialogState.newFolderTitle.trim();
  if (!context || !title || dialogState.creatingFolder) {
    return;
  }

  const csrf = getCsrfToken();
  if (!csrf) {
    pushToast(root, '缺少 bili_jct，无法创建收藏夹');
    return;
  }

  dialogState.creatingFolder = true;
  renderDialog();

  try {
    const resp = await sendMessage({
      type: 'CREATE_FOLDER_AND_AUTHOR_GROUP',
      payload: {
        mid: context.mid,
        title,
        csrf,
        pageOrigin: window.location.origin,
        pageReferer: window.location.href
      }
    });

    if (!resp.ok || !resp.data) {
      throw new Error(resp.error || '创建收藏夹失败');
    }

    applyDialogData(resp.data);
    dialogState.newFolderTitle = '';
    pushToast(root, resp.data.message);
  } catch (error) {
    pushToast(root, error instanceof Error ? error.message : '创建收藏夹失败');
  } finally {
    dialogState.creatingFolder = false;
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
  button.classList.add(BUTTON_CLASS, BUTTON_EXTRA_CLASS);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const latestContext = buttonContextMap.get(button) ?? context;
    void openDialog(root, latestContext);
  });
  bindButtonContext(button, context);
  setButtonLoading(button);
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
    setButtonLoading(button);
    void fetchMembership(context.mid).catch(() => {
      updateButtonText(button, '添加到分组');
      syncAuthorGroupButtonState(button, {
        grouped: false,
        pending: false
      });
    });
  }

  // 对于 hover 卡片的 open shadow root，外部样式无法穿透；按钮样式以 inline 为准。
  if (host instanceof ShadowRoot) {
    ensureShadowRootButtonStyles(host);
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

function buildLegacyCardContext(cardRoot: HTMLElement, actionRoot: HTMLElement): AuthorEntryContext | null {
  const nameLink = cardRoot.querySelector(CARD_NAME_LINK_SELECTOR);
  const mid = extractMidFromAnchor(nameLink) ?? extractMidFromElement(cardRoot) ?? extractMidFromElement(actionRoot);
  if (!mid) {
    return null;
  }

  return {
    mid,
    source: 'card',
    name: normalizeText(nameLink?.textContent) || findAuthorName(cardRoot) || findAuthorName(actionRoot),
    face: findAvatarUrl(cardRoot) ?? findAvatarUrl(actionRoot)
  };
}

function buildProfileCardContext(shadowRoot: ShadowRoot, actionRoot: HTMLElement): AuthorEntryContext | null {
  const avatarLink = shadowRoot.querySelector(PROFILE_CARD_AVATAR_SELECTOR);
  const mid = extractMidFromAnchor(avatarLink) ?? extractMidFromElement(shadowRoot) ?? extractMidFromElement(actionRoot);
  if (!mid) {
    return null;
  }

  return {
    mid,
    source: 'card',
    name: normalizeText(avatarLink?.textContent) || findAuthorName(shadowRoot) || findAuthorName(actionRoot),
    face: findAvatarUrl(shadowRoot) ?? findAvatarUrl(actionRoot)
  };
}

function scanVideoPage(root: HTMLElement): void {
  if (!/\/video\//.test(window.location.pathname)) {
    return;
  }
  const actionRoot = document.querySelector(VIDEO_ACTION_SELECTOR);
  if (!(actionRoot instanceof HTMLElement)) {
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
  if (!(actionRoot instanceof HTMLElement)) {
    return;
  }
  const context = buildSpaceContext(actionRoot);
  if (!context) {
    return;
  }
  upsertButton(root, document, actionRoot, context);
}

function scanLegacyCardTargets(root: HTMLElement): void {
  const cardRoots = document.querySelectorAll(CARD_ROOT_SELECTOR);
  for (const cardRoot of cardRoots) {
    if (!(cardRoot instanceof HTMLElement) || !isElementVisible(cardRoot)) {
      continue;
    }

    const actionRoot = cardRoot.querySelector(CARD_ACTION_SELECTOR);
    if (!(actionRoot instanceof HTMLElement)) {
      continue;
    }

    const context = buildLegacyCardContext(cardRoot, actionRoot);
    if (!context) {
      continue;
    }

    upsertButton(root, cardRoot, actionRoot, context);
  }
}

function scanProfileCardTargets(root: HTMLElement): void {
  const hosts = document.querySelectorAll(PROFILE_CARD_HOST_SELECTOR);
  for (const host of hosts) {
    if (!(host instanceof HTMLElement) || !host.shadowRoot) {
      continue;
    }

    const shadowRoot = host.shadowRoot;
    if (!shadowRootObserverSet.has(shadowRoot)) {
      const observer = new MutationObserver(() => {
        scheduleScan(root);
      });
      observer.observe(shadowRoot, {
        childList: true,
        subtree: true,
        attributes: true
      });
      shadowRootObserverSet.add(shadowRoot);
    }

    const actionRoot = shadowRoot.querySelector(PROFILE_CARD_ACTION_SELECTOR);
    if (!(actionRoot instanceof HTMLElement) || !isElementVisible(actionRoot)) {
      continue;
    }

    const context = buildProfileCardContext(shadowRoot, actionRoot);
    if (!context) {
      continue;
    }

    upsertButton(root, shadowRoot, actionRoot, context);
  }
}

function runScan(root: HTMLElement): void {
  scanVideoPage(root);
  scanSpacePage(root);
  scanLegacyCardTargets(root);
  scanProfileCardTargets(root);
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

  window.addEventListener(EXTENSION_EVENT.OPEN_AUTHOR_GROUP_DIALOG, (event) => {
    const detail = (event as CustomEvent<AuthorEntryContext | null | undefined>).detail;
    if (!detail?.mid) {
      return;
    }
    void openDialog(root, detail);
  });

  const observer = new MutationObserver(() => {
    scheduleScan(root);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  patchHistory(root);
}
