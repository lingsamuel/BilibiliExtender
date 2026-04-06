import authorGroupButtonCssText from '@/styles/author-group-button.css?inline';
import { EXTENSION_EVENT } from '@/shared/constants';
import { sendMessage, type ResponseMap } from '@/shared/messages';
import { formatRelativeMinutes } from '@/shared/utils/format';

type MembershipState = ResponseMap['GET_AUTHOR_GROUP_MEMBERSHIP'];
type DialogData = ResponseMap['GET_AUTHOR_GROUP_DIALOG_DATA'];
type AuthorEntrySource = 'video-page' | 'space-page' | 'video-author-hover-card' | 'comment-hover-card' | 'drawer-panel';
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
  folderSnapshot: DialogData['folderSnapshot'];
  availableFolders: DialogData['availableFolders'];
  createPanelVisible: boolean;
  selectedFolderId: string;
  createFolderFormVisible: boolean;
  error: string;
  pendingGroupIds: Set<string>;
  pendingFolderIds: Set<number>;
  creatingFolder: boolean;
  newFolderTitle: string;
}

const BUTTON_ATTR = 'data-bbe-author-group-button';
const BUTTON_CLASS = 'bbe-author-follow-btn';
const BUTTON_EXTRA_CLASS = 'bbe-injected-author-group-btn';
// 作者入口的 DOM 结构按场景分别约定，避免跨场景复用“猜测式”选择器。
const VIDEO_ROOT_SELECTOR = '.up-info-container';
const VIDEO_ACTION_SELECTOR = '.up-detail-top';
const VIDEO_NAME_SELECTOR = 'a.up-name';
const VIDEO_AVATAR_SELECTOR = '.bili-avatar img';
const SPACE_ROOT_SELECTOR = '.upinfo';
const SPACE_ACTION_SELECTOR = '.interactions';
const SPACE_NAME_SELECTOR = '.nickname';
const SPACE_AVATAR_SELECTOR = '.avatar img';
const VIDEO_AUTHOR_HOVER_CARD_ROOT_SELECTOR = '.usercard-wrap';
const VIDEO_AUTHOR_HOVER_CARD_ACTION_SELECTOR = '.btn-box';
const VIDEO_AUTHOR_HOVER_CARD_NAME_LINK_SELECTOR = 'a.name';
const VIDEO_AUTHOR_HOVER_CARD_AVATAR_SELECTOR = '.bili-avatar img';
const COMMENT_HOVER_CARD_HOST_SELECTOR = 'bili-user-profile';
const COMMENT_HOVER_CARD_ACTION_SELECTOR = '#action';
const COMMENT_HOVER_CARD_NAME_LINK_SELECTOR = 'a#name';
const COMMENT_HOVER_CARD_PROFILE_LINK_SELECTOR = '#avatar';
const COMMENT_HOVER_CARD_AVATAR_SELECTOR = '#avatar img';

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
  folderSnapshot: undefined,
  availableFolders: [],
  createPanelVisible: false,
  selectedFolderId: '',
  createFolderFormVisible: false,
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

function getImageUrl(root: QueryRoot, selector: string): string | undefined {
  const img = root.querySelector(selector);
  if (!(img instanceof HTMLImageElement)) {
    return undefined;
  }
  const src = img.currentSrc || img.src || '';
  return src || undefined;
}

function getTextContent(root: QueryRoot, selector: string): string | undefined {
  const element = root.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    return undefined;
  }
  return normalizeText(element.textContent) || undefined;
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

async function fetchDialogData(mid: number, refreshFolders = false): Promise<DialogData> {
  const resp = await sendMessage({
    type: 'GET_AUTHOR_GROUP_DIALOG_DATA',
    payload: {
      mid,
      refreshFolders: refreshFolders === true
    }
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
  dialogState.folderSnapshot = data.folderSnapshot;
  dialogState.availableFolders = data.availableFolders;
}

function syncCreatePanelInteractiveState(): void {
  if (!dialogBackdrop) {
    return;
  }

  const createExistingButton = dialogBackdrop.querySelector<HTMLButtonElement>('[data-bbe-author-group-create-existing="1"]');
  if (createExistingButton) {
    createExistingButton.disabled = !dialogState.selectedFolderId || dialogState.creatingFolder;
  }

  const createFolderSubmit = dialogBackdrop.querySelector<HTMLButtonElement>('.bbe-author-group-create-form .bbe-author-group-create-submit');
  if (createFolderSubmit) {
    createFolderSubmit.disabled = dialogState.creatingFolder || dialogState.newFolderTitle.trim().length === 0;
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
        <div class="bbe-author-group-dialog-actions">
          <button type="button" class="bbe-author-group-add" data-bbe-author-group-toggle-create="1">+ 添加分组</button>
          <button type="button" class="bbe-author-group-close" aria-label="关闭">×</button>
        </div>
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

    if (target.closest('[data-bbe-author-group-toggle-create="1"]')) {
      dialogState.createPanelVisible = !dialogState.createPanelVisible;
      if (!dialogState.createPanelVisible) {
        dialogState.createFolderFormVisible = false;
        dialogState.newFolderTitle = '';
      }
      renderDialog();
      return;
    }

    if (target.closest('[data-bbe-author-group-toggle-new-folder="1"]')) {
      dialogState.createFolderFormVisible = !dialogState.createFolderFormVisible;
      if (!dialogState.createFolderFormVisible) {
        dialogState.newFolderTitle = '';
      }
      renderDialog();
      return;
    }

    if (target.closest('[data-bbe-author-group-create-existing="1"]')) {
      void onCreateSelectedFolderGroup(root);
      return;
    }

    if (target.closest('[data-bbe-author-group-refresh-folders="1"]')) {
      void refreshDialogFolders();
      return;
    }

    const groupButton = target.closest<HTMLButtonElement>('[data-bbe-author-group-id]');
    if (groupButton) {
      void onGroupItemClick(root, groupButton.dataset.bbeAuthorGroupId || '');
      return;
    }
  });

  dialogBackdrop.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.dataset.bbeAuthorGroupCreateInput !== '1') {
      return;
    }
    dialogState.newFolderTitle = target.value;
    syncCreatePanelInteractiveState();
  });

  dialogBackdrop.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || target.dataset.bbeAuthorGroupFolderSelect !== '1') {
      return;
    }
    dialogState.selectedFolderId = target.value;
    syncCreatePanelInteractiveState();
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
  const folderSnapshotText = dialogState.folderSnapshot
    ? `${formatRelativeMinutes(dialogState.folderSnapshot.fetchedAt)}`
    : '当前还没有收藏夹列表缓存，请先手动刷新';
  const addButton = dialogBackdrop.querySelector('.bbe-author-group-add');
  if (addButton instanceof HTMLButtonElement) {
    addButton.classList.toggle('active', dialogState.createPanelVisible);
  }

  bodyEl.innerHTML = `
    ${dialogState.createPanelVisible ? `
      <div class="bbe-author-group-create-panel">
        <div class="bbe-author-group-create-row">
          <select
            class="bbe-author-group-create-select"
            data-bbe-author-group-folder-select="1"
            ${!hasAvailableFolders || dialogState.creatingFolder ? 'disabled' : ''}
          >
            <option value="">请选择收藏夹</option>
            ${availableFolders.map((folder) => `
              <option value="${folder.id}" ${String(folder.id) === dialogState.selectedFolderId ? 'selected' : ''}>
                ${escapeHtml(folder.title)}（${folder.mediaCount}）
              </option>
            `).join('')}
          </select>
          <button
            type="button"
            class="bbe-author-group-create-submit"
            data-bbe-author-group-create-existing="1"
            ${!dialogState.selectedFolderId || !hasAvailableFolders || dialogState.creatingFolder ? 'disabled' : ''}
          >
            创建分组
          </button>
        </div>
        <div class="bbe-author-group-create-meta">${escapeHtml(folderSnapshotText)}</div>
        <div class="bbe-author-group-create-actions">
          <button
            type="button"
            class="bbe-author-group-link-btn"
            data-bbe-author-group-refresh-folders="1"
            ${dialogState.loading || dialogState.creatingFolder ? 'disabled' : ''}
          >
            刷新收藏夹列表
          </button>
          <button type="button" class="bbe-author-group-link-btn" data-bbe-author-group-toggle-new-folder="1">
            ${dialogState.createFolderFormVisible ? '收起新建收藏夹' : '+ 新建收藏夹'}
          </button>
          ${hasAvailableFolders ? '' : `<span class="bbe-author-group-create-empty">${
            dialogState.folderSnapshot ? '没有可用的未绑定收藏夹' : '尚未加载收藏夹列表'
          }</span>`}
        </div>
        ${dialogState.createFolderFormVisible ? `
          <form class="bbe-author-group-create-form">
            <input
              type="text"
              class="bbe-author-group-create-input"
              data-bbe-author-group-create-input="1"
              maxlength="80"
              placeholder="输入新收藏夹标题"
              value="${escapeHtml(dialogState.newFolderTitle)}"
              ${dialogState.creatingFolder ? 'disabled' : ''}
            />
            <button
              type="submit"
              class="bbe-author-group-create-submit${dialogState.creatingFolder ? ' pending' : ''}"
              ${dialogState.creatingFolder || !hasNewFolderTitle ? 'disabled' : ''}
            >
              ${dialogState.creatingFolder ? '创建中...' : '新建并创建分组'}
            </button>
          </form>
        ` : ''}
      </div>
    ` : ''}
    ${hasGroups ? `
      <div class="bbe-author-group-list">
        ${membership!.groups.map((group) => {
          const pending = dialogState.pendingGroupIds.has(group.groupId);
          const indicatorClass = pending
            ? ' pending'
            : group.checked
              ? ' checked'
              : '';
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
              <span class="bbe-author-group-item-indicator${indicatorClass}" aria-hidden="true">
                <span class="bbe-author-group-item-check">✓</span>
              </span>
            </button>
          `;
        }).join('')}
      </div>
    ` : '<div class="bbe-author-group-state">还没有插件分组，点击右上角“添加分组”开始创建。</div>'}
  `;
}

function closeDialog(): void {
  dialogState.visible = false;
  dialogState.loading = false;
  dialogState.error = '';
  dialogState.pendingGroupIds.clear();
  dialogState.pendingFolderIds.clear();
  dialogState.createPanelVisible = false;
  dialogState.selectedFolderId = '';
  dialogState.createFolderFormVisible = false;
  dialogState.creatingFolder = false;
  dialogState.newFolderTitle = '';
  dialogState.context = null;
  dialogState.membership = null;
  dialogState.folderSnapshot = undefined;
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
  dialogState.createPanelVisible = false;
  dialogState.selectedFolderId = '';
  dialogState.createFolderFormVisible = false;
  dialogState.creatingFolder = false;
  dialogState.newFolderTitle = '';
  dialogState.membership = membershipCache.get(context.mid) ?? null;
  dialogState.folderSnapshot = undefined;
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

async function refreshDialogFolders(): Promise<void> {
  const context = dialogState.context;
  if (!context || dialogState.loading) {
    return;
  }

  dialogState.loading = true;
  dialogState.error = '';
  renderDialog();

  const requestId = ++dialogRequestSeq;
  try {
    const dialogData = await fetchDialogData(context.mid, true);
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
    dialogState.error = error instanceof Error ? error.message : '刷新收藏夹列表失败';
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
    dialogState.selectedFolderId = '';
    dialogState.createPanelVisible = false;
    dialogState.createFolderFormVisible = false;
    dialogState.newFolderTitle = '';
    pushToast(root, resp.data.message);
  } catch (error) {
    pushToast(root, error instanceof Error ? error.message : '创建分组失败');
  } finally {
    dialogState.pendingFolderIds.delete(mediaId);
    renderDialog();
  }
}

async function onCreateSelectedFolderGroup(root: HTMLElement): Promise<void> {
  const mediaId = Math.max(1, Number(dialogState.selectedFolderId) || 0);
  if (!mediaId) {
    pushToast(root, '请先选择收藏夹');
    return;
  }

  await onCreateGroupFromFolderClick(root, mediaId);
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
    dialogState.selectedFolderId = '';
    dialogState.createPanelVisible = false;
    dialogState.createFolderFormVisible = false;
    dialogState.newFolderTitle = '';
    pushToast(root, resp.data.message);
  } catch (error) {
    pushToast(root, error instanceof Error ? error.message : '创建收藏夹失败');
  } finally {
    dialogState.creatingFolder = false;
    renderDialog();
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

function buildVideoPageContext(actionRoot: HTMLElement): AuthorEntryContext | null {
  const root = actionRoot.closest(VIDEO_ROOT_SELECTOR);
  if (!(root instanceof HTMLElement)) {
    return null;
  }

  const nameLink = root.querySelector(VIDEO_NAME_SELECTOR);
  const mid = extractMidFromAnchor(nameLink);
  const bvid = parseVideoBvidFromLocation();
  if (!mid || !bvid) {
    return null;
  }

  return {
    mid,
    source: 'video-page',
    name: normalizeText(nameLink?.textContent) || undefined,
    face: getImageUrl(root, VIDEO_AVATAR_SELECTOR),
    video: {
      bvid
    }
  };
}

function buildSpacePageContext(actionRoot: HTMLElement): AuthorEntryContext | null {
  const root = actionRoot.closest(SPACE_ROOT_SELECTOR);
  if (!(root instanceof HTMLElement)) {
    return null;
  }

  const mid = parseSpaceMidFromLocation();
  if (!mid) {
    return null;
  }

  return {
    mid,
    source: 'space-page',
    name: getTextContent(root, SPACE_NAME_SELECTOR),
    face: getImageUrl(root, SPACE_AVATAR_SELECTOR)
  };
}

function buildVideoAuthorHoverCardContext(cardRoot: HTMLElement): AuthorEntryContext | null {
  const nameLink = cardRoot.querySelector(VIDEO_AUTHOR_HOVER_CARD_NAME_LINK_SELECTOR);
  const mid = extractMidFromAnchor(nameLink);
  if (!mid) {
    return null;
  }

  return {
    mid,
    source: 'video-author-hover-card',
    name: normalizeText(nameLink?.textContent) || undefined,
    face: getImageUrl(cardRoot, VIDEO_AUTHOR_HOVER_CARD_AVATAR_SELECTOR)
  };
}

function buildCommentHoverCardContext(shadowRoot: ShadowRoot): AuthorEntryContext | null {
  const avatarLink = shadowRoot.querySelector(COMMENT_HOVER_CARD_PROFILE_LINK_SELECTOR);
  const mid = extractMidFromAnchor(avatarLink);
  if (!mid) {
    return null;
  }

  return {
    mid,
    source: 'comment-hover-card',
    name: getTextContent(shadowRoot, COMMENT_HOVER_CARD_NAME_LINK_SELECTOR),
    face: getImageUrl(shadowRoot, COMMENT_HOVER_CARD_AVATAR_SELECTOR)
  };
}

function scanVideoPage(root: HTMLElement): void {
  if (!/\/video\//.test(window.location.pathname)) {
    return;
  }
  const videoRoot = document.querySelector(VIDEO_ROOT_SELECTOR);
  if (!(videoRoot instanceof HTMLElement) || !isElementVisible(videoRoot)) {
    return;
  }
  const actionRoot = videoRoot.querySelector(VIDEO_ACTION_SELECTOR);
  if (!(actionRoot instanceof HTMLElement)) {
    return;
  }
  const context = buildVideoPageContext(actionRoot);
  if (!context) {
    return;
  }
  upsertButton(root, document, actionRoot, context);
}

function scanSpacePage(root: HTMLElement): void {
  if (window.location.host !== 'space.bilibili.com') {
    return;
  }
  const spaceRoot = document.querySelector(SPACE_ROOT_SELECTOR);
  if (!(spaceRoot instanceof HTMLElement) || !isElementVisible(spaceRoot)) {
    return;
  }
  const actionRoot = spaceRoot.querySelector(SPACE_ACTION_SELECTOR);
  if (!(actionRoot instanceof HTMLElement)) {
    return;
  }
  const context = buildSpacePageContext(actionRoot);
  if (!context) {
    return;
  }
  upsertButton(root, document, actionRoot, context);
}

function scanVideoAuthorHoverCardTargets(root: HTMLElement): void {
  const hoverCardRoots = document.querySelectorAll(VIDEO_AUTHOR_HOVER_CARD_ROOT_SELECTOR);
  for (const hoverCardRoot of hoverCardRoots) {
    if (!(hoverCardRoot instanceof HTMLElement) || !isElementVisible(hoverCardRoot)) {
      continue;
    }

    const actionRoot = hoverCardRoot.querySelector(VIDEO_AUTHOR_HOVER_CARD_ACTION_SELECTOR);
    if (!(actionRoot instanceof HTMLElement)) {
      continue;
    }

    const context = buildVideoAuthorHoverCardContext(hoverCardRoot);
    if (!context) {
      continue;
    }

    upsertButton(root, hoverCardRoot, actionRoot, context);
  }
}

function scanCommentHoverCardTargets(root: HTMLElement): void {
  const hoverCardHosts = document.querySelectorAll(COMMENT_HOVER_CARD_HOST_SELECTOR);
  for (const hoverCardHost of hoverCardHosts) {
    if (!(hoverCardHost instanceof HTMLElement) || !hoverCardHost.shadowRoot) {
      continue;
    }

    const shadowRoot = hoverCardHost.shadowRoot;
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

    const actionRoot = shadowRoot.querySelector(COMMENT_HOVER_CARD_ACTION_SELECTOR);
    if (!(actionRoot instanceof HTMLElement) || !isElementVisible(actionRoot)) {
      continue;
    }

    const context = buildCommentHoverCardContext(shadowRoot);
    if (!context) {
      continue;
    }

    upsertButton(root, shadowRoot, actionRoot, context);
  }
}

function runScan(root: HTMLElement): void {
  scanVideoPage(root);
  scanSpacePage(root);
  scanVideoAuthorHoverCardTargets(root);
  scanCommentHoverCardTargets(root);
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
