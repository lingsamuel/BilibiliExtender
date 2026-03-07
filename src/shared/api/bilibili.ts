import type { CurrentUser, FavoriteFolder, VideoItem } from '@/shared/types';
import { extractWbiKey, signWbiParams, WbiExpiredError } from '@/shared/utils/wbi';

const API_BASE = 'https://api.bilibili.com';

interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
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
  playback_position?: number;
}

interface ArcSearchData {
  list: {
    vlist: ArcSearchItem[];
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

export interface VideoActionTarget {
  aid?: number;
  bvid?: string;
}

async function fetchApi<T>(
  path: string,
  params?: Record<string, string | number>
): Promise<ApiResponse<T>> {
  const url = new URL(path, API_BASE);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });
  }

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
    throw new Error(`接口错误: ${payload.code} ${payload.message}`);
  }

  return payload;
}

async function postApi<T>(
  path: string,
  body: Record<string, string | number>
): Promise<ApiResponse<T>> {
  const url = new URL(path, API_BASE);
  const form = new URLSearchParams();

  Object.entries(body).forEach(([key, value]) => {
    form.set(key, String(value));
  });

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
    throw new Error(`接口错误: ${payload.code} ${payload.message}`);
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
export async function getCurrentUser(): Promise<CurrentUser> {
  const payload = await fetchApi<NavData>('/x/web-interface/nav');

  if (!payload.data.isLogin) {
    throw new Error('当前未登录 Bilibili');
  }

  return {
    mid: payload.data.mid,
    uname: payload.data.uname
  };
}

async function getWbiKeys(): Promise<{ imgKey: string; subKey: string }> {
  if (cachedWbiKey && cachedWbiKey.expiredAt > Date.now()) {
    return {
      imgKey: cachedWbiKey.imgKey,
      subKey: cachedWbiKey.subKey
    };
  }

  const navPayload = await fetchApi<NavData>('/x/web-interface/nav');
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
export async function getMyCreatedFolders(): Promise<FavoriteFolder[]> {
  const user = await getCurrentUser();
  const payload = await fetchApi<FolderCreatedListData>('/x/v3/fav/folder/created/list-all', {
    up_mid: user.mid
  });

  return (payload.data.list ?? []).map((item) => ({
    id: item.id,
    title: item.title,
    mediaCount: item.media_count
  }));
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
  ps: number
): Promise<{ videos: VideoItem[]; hasMore: boolean; totalCount: number; pageSize: number }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { imgKey, subKey } = await getWbiKeys();
      const signedParams = signWbiParams(
        { mid, pn, ps, order: 'pubdate' },
        imgKey,
        subKey
      );

      const payload = await fetchApi<ArcSearchData>('/x/space/wbi/arc/search', signedParams);
      const videos: VideoItem[] = (payload.data.list?.vlist ?? []).map((item) => ({
        bvid: item.bvid,
        aid: item.aid,
        title: item.title,
        cover: normalizeBiliUrl(item.pic) ?? '',
        pubdate: item.created,
        authorMid: item.mid || mid,
        authorName: item.author,
        playbackPosiiton: item.playback_position
      }));

      const page = payload.data.page;
      const hasMore = page.pn * page.ps < page.count;

      return {
        videos,
        hasMore,
        totalCount: Math.max(0, Number(page.count) || 0),
        pageSize: Math.max(1, Number(page.ps) || ps)
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
export async function getUserCard(mid: number): Promise<UserCardProfile> {
  const payload = await fetchApi<WebCardData>('/x/web-interface/card', { mid });
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
  // 关注接口在 Web 端需要携带 extend_content（实体类型 + 目标 uid），
  // 否则在部分账号/风控场景下可能被拦截。
  const extendContent = JSON.stringify({
    entity: 'user',
    entity_id: fid
  });
  await postApi<Record<string, never>>('/x/relation/modify', {
    fid,
    act,
    re_src: 11,
    extend_content: extendContent,
    csrf
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

/**
 * 查询视频近期点赞状态（仅“近期口径”，不保证覆盖历史点赞）。
 */
export async function getVideoRecentLikeState(target: VideoActionTarget): Promise<boolean> {
  const params = buildVideoActionParams(target);
  const payload = await fetchApi<number>('/x/web-interface/archive/has/like', params);
  return Number(payload.data) === 1;
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
