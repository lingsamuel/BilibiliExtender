import type { AuthorVideoVersionFingerprint, CurrentUser, FavoriteFolder, VideoItem } from '@/shared/types';
import { extractWbiKey, signWbiParams, WbiExpiredError } from '@/shared/utils/wbi';

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

interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

export interface ApiRequestTracker {
  beforeRequest?(): void | Promise<void>;
  recordRequest(): void;
}

export class BilibiliApiError extends Error {
  readonly code: number;
  readonly apiMessage: string;

  constructor(code: number, message: string) {
    super(`接口错误: ${code} ${message}`);
    this.name = 'BilibiliApiError';
    this.code = code;
    this.apiMessage = message;
  }
}

interface NavData {
  isLogin: boolean;
  mid: number;
  uname: string;
  wbi_img?: {
    img_url: string;
    sub_url: string;
  };
}

interface FolderItem {
  id: number;
  title: string;
  media_count: number;
}

interface FolderCreatedListData {
  list: FolderItem[];
}

interface CreatedFolderData {
  id: number;
  title: string;
  media_count: number;
}

interface FavMediaItem {
  bvid: string;
  id: number;
  title: string;
  cover: string;
  pubtime: number;
  upper?: {
    mid: number;
    name: string;
  };
}

interface FavResourceListData {
  medias?: FavMediaItem[];
  has_more: boolean;
}

interface ArcSearchItem {
  bvid: string;
  aid: number;
  title: string;
  pic: string;
  created: number;
  author: string;
  mid: number;
  play?: number;
  video_review?: number;
  length?: string;
  playback_position?: number;
}

interface ArcSearchData {
  list: {
    vlist: ArcSearchItem[];
    tlist?: Record<string, { tid?: number; count?: number }>;
  };
  page: {
    count: number;
    pn: number;
    ps: number;
  };
}

interface WebCardData {
  card?: {
    name?: string;
    face?: string;
  };
  follower?: number;
  following?: boolean;
}

interface VideoViewData {
  aid: number;
  bvid: string;
}

export interface VideoActionTarget {
  aid?: number;
  bvid?: string;
}

async function fetchApi<T>(
  path: string,
  params?: Record<string, string | number>,
  requestTracker?: ApiRequestTracker
): Promise<ApiResponse<T>> {
  const url = new URL(path, API_BASE);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });
  }

  await requestTracker?.beforeRequest?.();
  requestTracker?.recordRequest();
  const response = await fetch(url.toString(), {
    credentials: 'include'
  });

  if (!response.ok) {
    if (response.status === 412) {
      throw new WbiExpiredError();
    }
    throw new Error(`请求失败: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as ApiResponse<T>;

  if (payload.code !== 0) {
    throw new BilibiliApiError(payload.code, payload.message);
  }

  return payload;
}

async function postApi<T>(
  path: string,
  body: Record<string, string | number>,
  query?: Record<string, string | number>,
  requestTracker?: ApiRequestTracker
): Promise<ApiResponse<T>> {
  const url = new URL(path, API_BASE);
  const form = new URLSearchParams();

  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });
  }

  Object.entries(body).forEach(([key, value]) => {
    form.set(key, String(value));
  });

  await requestTracker?.beforeRequest?.();
  requestTracker?.recordRequest();
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

  const payload = (await response.json()) as ApiResponse<T>;
  if (payload.code !== 0) {
    throw new BilibiliApiError(payload.code, payload.message);
  }
  return payload;
}

function normalizeBiliUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  return url.startsWith('http') ? url : `https:${url}`;
}

let cachedWbiKey: { imgKey: string; subKey: string; expiredAt: number } | null = null;

/**
 * 获取当前登录用户；当未登录时会抛错给上层统一处理。
 */
export async function getCurrentUser(requestTracker?: ApiRequestTracker): Promise<CurrentUser> {
  const payload = await fetchApi<NavData>('/x/web-interface/nav', undefined, requestTracker);

  if (!payload.data.isLogin) {
    throw new Error('当前未登录 Bilibili');
  }

  return {
    mid: payload.data.mid,
    uname: payload.data.uname
  };
}

async function getWbiKeys(requestTracker?: ApiRequestTracker): Promise<{ imgKey: string; subKey: string }> {
  if (cachedWbiKey && cachedWbiKey.expiredAt > Date.now()) {
    return {
      imgKey: cachedWbiKey.imgKey,
      subKey: cachedWbiKey.subKey
    };
  }

  const navPayload = await fetchApi<NavData>('/x/web-interface/nav', undefined, requestTracker);
  const imgUrl = navPayload.data.wbi_img?.img_url;
  const subUrl = navPayload.data.wbi_img?.sub_url;

  if (!imgUrl || !subUrl) {
    throw new Error('获取 WBI 密钥失败');
  }

  const imgKey = extractWbiKey(imgUrl);
  const subKey = extractWbiKey(subUrl);

  cachedWbiKey = {
    imgKey,
    subKey,
    expiredAt: Date.now() + 2 * 60 * 1000
  };

  return { imgKey, subKey };
}

/**
 * 获取当前用户创建的收藏夹列表，用于分组配置。
 */
export async function getCreatedFoldersByMid(
  mid: number,
  requestTracker?: ApiRequestTracker
): Promise<FavoriteFolder[]> {
  const payload = await fetchApi<FolderCreatedListData>('/x/v3/fav/folder/created/list-all', {
    up_mid: mid
  }, requestTracker);

  return (payload.data.list ?? []).map((item) => ({
    id: item.id,
    title: item.title,
    mediaCount: item.media_count
  }));
}

/**
 * 获取当前用户创建的收藏夹列表，用于分组配置。
 */
export async function getMyCreatedFolders(requestTracker?: ApiRequestTracker): Promise<FavoriteFolder[]> {
  const user = await getCurrentUser(requestTracker);
  return getCreatedFoldersByMid(user.mid, requestTracker);
}

/**
 * 新建收藏夹；当前作者分组弹框内创建分组时固定创建为私密收藏夹。
 */
export async function createFavoriteFolder(
  title: string,
  csrf: string
): Promise<FavoriteFolder> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    throw new Error('收藏夹标题不能为空');
  }

  const payload = await postApi<CreatedFolderData>('/x/v3/fav/folder/add', {
    title: trimmedTitle,
    privacy: 1,
    csrf
  });

  return {
    id: Math.max(0, Math.floor(Number(payload.data.id) || 0)),
    title: payload.data.title?.trim() || trimmedTitle,
    mediaCount: Math.max(0, Math.floor(Number(payload.data.media_count) || 0))
  };
}

/**
 * 拉取收藏夹内全部视频条目，仅用于提取作者与构建初始上下文。
 */
export async function getAllFavVideos(mediaId: number): Promise<FavMediaItem[]> {
  let pn = 1;
  const ps = 20;
  const allVideos: FavMediaItem[] = [];

  while (true) {
    const payload = await fetchApi<FavResourceListData>('/x/v3/fav/resource/list', {
      media_id: mediaId,
      pn,
      ps,
      platform: 'web'
    });

    const pageVideos = payload.data.medias ?? [];
    allVideos.push(...pageVideos);

    if (!payload.data.has_more || pageVideos.length === 0) {
      break;
    }

    pn += 1;

    if (pn > 200) {
      // 防止异常分页导致无限循环。
      break;
    }
  }

  return allVideos;
}

/**
 * 清除 WBI 密钥缓存，强制下次调用重新获取。
 */
function invalidateWbiKeys(): void {
  cachedWbiKey = null;
}

/**
 * 按作者分页拉取投稿视频（WBI 签名接口）。
 * 遇到 412 时自动清除 WBI key 缓存并重试一次。
 */
export async function getUploaderVideos(
  mid: number,
  pn: number,
  ps: number,
  options?: { requestTracker?: ApiRequestTracker }
): Promise<{
  videos: VideoItem[];
  hasMore: boolean;
  totalCount: number;
  pageSize: number;
  version: AuthorVideoVersionFingerprint;
}> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { imgKey, subKey } = await getWbiKeys(options?.requestTracker);
      const signedParams = signWbiParams(
        { mid, pn, ps, order: 'pubdate' },
        imgKey,
        subKey
      );

      const payload = await fetchApi<ArcSearchData>('/x/space/wbi/arc/search', signedParams, options?.requestTracker);
      const videos: VideoItem[] = (payload.data.list?.vlist ?? []).map((item) => ({
        bvid: item.bvid,
        aid: item.aid,
        title: item.title,
        cover: normalizeBiliUrl(item.pic) ?? '',
        pubdate: item.created,
        authorMid: item.mid || mid,
        authorName: item.author,
        playCount: Number.isFinite(item.play) ? item.play : undefined,
        danmakuCount: Number.isFinite(item.video_review) ? item.video_review : undefined,
        durationText: item.length?.trim() || undefined,
        playbackPosiiton: item.playback_position
      }));

      const page = payload.data.page;
      const hasMore = page.pn * page.ps < page.count;
      const totalCount = Math.max(0, Number(page.count) || 0);
      const tagCounts = Object.values(payload.data.list?.tlist ?? {})
        .map((item) => ({
          tid: Math.max(0, Number(item?.tid) || 0),
          count: Math.max(0, Number(item?.count) || 0)
        }))
        .sort((a, b) => a.tid - b.tid);

      return {
        videos,
        hasMore,
        totalCount,
        pageSize: Math.max(1, Number(page.ps) || ps),
        version: {
          totalCount,
          tagCounts
        }
      };
    } catch (error) {
      if (error instanceof WbiExpiredError && attempt === 0) {
        invalidateWbiKeys();
        continue;
      }
      throw error;
    }
  }

  throw new Error('WBI 签名重试失败');
}

export type { FavMediaItem };

export interface UserCardProfile {
  mid: number;
  name?: string;
  face?: string;
  follower?: number;
  following?: boolean;
}

/**
 * 获取作者卡片信息（头像、名称、粉丝数、关注状态）。
 */
export async function getUserCard(mid: number, requestTracker?: ApiRequestTracker): Promise<UserCardProfile> {
  const payload = await fetchApi<WebCardData>('/x/web-interface/card', { mid }, requestTracker);
  return {
    mid,
    name: payload.data.card?.name?.trim() || undefined,
    face: normalizeBiliUrl(payload.data.card?.face),
    follower: payload.data.follower,
    following: payload.data.following
  };
}

/**
 * 关注/取消关注指定用户。
 * act: 1=关注, 2=取关
 */
export async function modifyUserRelation(
  fid: number,
  follow: boolean,
  csrf: string
): Promise<void> {
  const act = follow ? 1 : 2;
  // 关注接口除了业务参数外，还需要尽量补齐 Web 前端同形态的上下文字段，
  // 否则部分账号会因为客户端判定或风控校验失败。
  const extendContent = JSON.stringify({
    entity: 'user',
    entity_id: fid
  });
  await postApi<Record<string, never>>('/x/relation/modify', {
    fid,
    act,
    re_src: 11,
    gaia_source: 'web_main',
    spmid: RELATION_SPMID,
    extend_content: extendContent,
    is_from_frontend_component: 'true',
    csrf
  }, {
    statistics: RELATION_STATISTICS,
    'x-bili-device-req-json': RELATION_DEVICE_REQ
  });
}

function buildVideoActionParams(target: VideoActionTarget): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  const aid = Number(target.aid);
  const bvid = target.bvid?.trim();

  if (aid > 0) {
    params.aid = Math.floor(aid);
  } else if (bvid) {
    params.bvid = bvid;
  } else {
    throw new Error('视频参数不完整');
  }

  return params;
}

/**
 * 点赞/取消点赞视频。
 * like=true => 点赞（1），like=false => 取消点赞（2）。
 */
export async function likeVideo(
  target: VideoActionTarget,
  like: boolean,
  csrf: string
): Promise<void> {
  const params = buildVideoActionParams(target);
  await postApi<Record<string, never>>('/x/web-interface/archive/like', {
    ...params,
    like: like ? 1 : 2,
    csrf
  });
}

/**
 * 解析视频目标，确保获得收藏夹写接口需要的 aid / bvid。
 */
export async function getVideoIdentity(target: VideoActionTarget): Promise<Required<VideoActionTarget>> {
  const aid = Math.max(0, Math.floor(Number(target.aid) || 0));
  const bvid = target.bvid?.trim() || '';

  if (aid > 0 && bvid) {
    return { aid, bvid };
  }

  const payload = await fetchApi<VideoViewData>('/x/web-interface/view', aid > 0 ? { aid } : { bvid });
  const resolvedAid = Math.max(0, Math.floor(Number(payload.data?.aid) || 0));
  const resolvedBvid = payload.data?.bvid?.trim() || '';
  if (!resolvedAid || !resolvedBvid) {
    throw new Error('获取视频信息失败');
  }

  return {
    aid: resolvedAid,
    bvid: resolvedBvid
  };
}

/**
 * 将单个视频加入指定收藏夹。
 */
export async function addVideoToFavorites(
  target: VideoActionTarget,
  mediaId: number,
  csrf: string
): Promise<void> {
  const identity = await getVideoIdentity(target);
  await postApi<Record<string, never>>('/x/v3/fav/resource/deal', {
    rid: identity.aid,
    type: 2,
    add_media_ids: mediaId,
    del_media_ids: '',
    platform: 'web',
    csrf
  });
}

/**
 * 批量移除收藏夹中的视频资源。
 */
export async function batchDeleteFavoriteResources(
  mediaId: number,
  resources: Array<{ id: number; type?: number }>,
  csrf: string
): Promise<void> {
  const formatted = resources
    .map((item) => {
      const id = Math.max(0, Math.floor(Number(item.id) || 0));
      const type = Math.max(1, Math.floor(Number(item.type) || 2));
      return id > 0 ? `${id}:${type}` : '';
    })
    .filter(Boolean)
    .join(',');

  if (!formatted) {
    return;
  }

  await postApi<Record<string, never>>('/x/v3/fav/resource/batch-del', {
    resources: formatted,
    media_id: mediaId,
    platform: 'web',
    csrf
  });
}

interface CoinVideoResponse {
  like?: boolean;
}

/**
 * 给视频投币。
 * multiply 仅允许 1 或 2；selectLike=true 时附加点赞。
 */
export async function coinVideo(
  target: VideoActionTarget,
  multiply: number,
  selectLike: boolean,
  csrf: string
): Promise<{ like?: boolean }> {
  const params = buildVideoActionParams(target);
  const safeMultiply = multiply >= 2 ? 2 : 1;
  const payload = await postApi<CoinVideoResponse>('/x/web-interface/coin/add', {
    ...params,
    multiply: safeMultiply,
    select_like: selectLike ? 1 : 0,
    csrf
  });
  return { like: payload.data?.like };
}

interface AccInfoData {
  face: string;
}

/**
 * 获取用户头像 URL（WBI 签名接口）。
 * 遇到 412 时自动清除 WBI key 缓存并重试一次。
 */
export async function getUserFace(mid: number): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { imgKey, subKey } = await getWbiKeys();
      const signedParams = signWbiParams({ mid }, imgKey, subKey);
      const payload = await fetchApi<AccInfoData>('/x/space/wbi/acc/info', signedParams);
      const face = payload.data.face;
      return face.startsWith('http') ? face : `https:${face}`;
    } catch (error) {
      if (error instanceof WbiExpiredError && attempt === 0) {
        invalidateWbiKeys();
        continue;
      }
      throw error;
    }
  }
  throw new Error('获取用户头像失败');
}
