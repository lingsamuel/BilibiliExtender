import type { CurrentUser, FavoriteFolder, VideoItem, WatchedVideo } from '@/shared/types';
import { extractWbiKey, signWbiParams } from '@/shared/utils/wbi';

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
    throw new Error(`请求失败: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as ApiResponse<T>;

  if (payload.code !== 0) {
    throw new Error(`接口错误: ${payload.code} ${payload.message}`);
  }

  return payload;
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
    expiredAt: Date.now() + 10 * 60 * 1000
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
 * 按作者分页拉取投稿视频（WBI 签名接口）。
 */
export async function getUploaderVideos(
  mid: number,
  pn: number,
  ps: number
): Promise<{ videos: VideoItem[]; hasMore: boolean }> {
  const { imgKey, subKey } = await getWbiKeys();
  const signedParams = signWbiParams(
    {
      mid,
      pn,
      ps,
      order: 'pubdate'
    },
    imgKey,
    subKey
  );

  const payload = await fetchApi<ArcSearchData>('/x/space/wbi/arc/search', signedParams);
  const videos = (payload.data.list?.vlist ?? []).map((item) => ({
    bvid: item.bvid,
    aid: item.aid,
    title: item.title,
    cover: item.pic.startsWith('http') ? item.pic : `https:${item.pic}`,
    pubdate: item.created,
    authorMid: item.mid || mid,
    authorName: item.author
  }));

  const page = payload.data.page;
  const hasMore = page.pn * page.ps < page.count;

  return { videos, hasMore };
}

export type { FavMediaItem };

interface HistoryCursorData {
  cursor: {
    max: number;
    view_at: number;
    business: string;
    ps: number;
  };
  list: Array<{
    title: string;
    history: {
      bvid: string;
      business: string;
    };
    progress: number;
    duration: number;
    view_at: number;
  }>;
}

/**
 * 批量拉取 Bilibili 观看历史（游标分页），返回最近 7 天内最多 maxItems 条记录。
 * 仅在 background service worker 中调用（需要登录态 Cookie）。
 */
export async function getWatchHistory(maxItems = 500): Promise<WatchedVideo[]> {
  const result: WatchedVideo[] = [];
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  let viewAt = 0;
  let maxId = 0;

  while (result.length < maxItems) {
    const params: Record<string, string | number> = {
      ps: 20,
      type: 'archive',
      view_at: viewAt,
      max: maxId
    };

    const payload = await fetchApi<HistoryCursorData>('/x/web-interface/history/cursor', params);

    if (!payload.data.list || payload.data.list.length === 0) {
      break;
    }

    for (const item of payload.data.list) {
      if (item.view_at < sevenDaysAgo) {
        return result;
      }

      if (item.history.business === 'archive' && item.history.bvid) {
        result.push({
          bvid: item.history.bvid,
          progress: item.progress,
          duration: item.duration
        });
      }
    }

    viewAt = payload.data.cursor.view_at;
    maxId = payload.data.cursor.max;

    if (payload.data.list.length < 20) {
      break;
    }
  }

  return result;
}
