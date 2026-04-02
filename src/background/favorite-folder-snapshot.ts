import {
  getCreatedFoldersByMid,
  getCurrentUser,
  type ApiRequestTracker
} from '@/shared/api/bilibili';
import {
  loadFavoriteFolderSnapshot,
  saveCurrentUserSnapshot,
  saveFavoriteFolderSnapshot
} from '@/shared/storage/repository';
import type {
  CurrentUserSnapshot,
  FavoriteFolder,
  FavoriteFolderSnapshot
} from '@/shared/types';

let currentUserRefreshPromise: Promise<CurrentUserSnapshot> | null = null;
let favoriteFolderRefreshPromise: Promise<FavoriteFolderSnapshot> | null = null;

async function refreshCurrentUserSnapshot(requestTracker?: ApiRequestTracker): Promise<CurrentUserSnapshot> {
  if (currentUserRefreshPromise) {
    return currentUserRefreshPromise;
  }

  const task = (async () => {
    const user = await getCurrentUser(requestTracker);
    const snapshot: CurrentUserSnapshot = {
      ...user,
      fetchedAt: Date.now()
    };
    await saveCurrentUserSnapshot(snapshot);
    return snapshot;
  })();

  currentUserRefreshPromise = task;
  try {
    return await task;
  } finally {
    if (currentUserRefreshPromise === task) {
      currentUserRefreshPromise = null;
    }
  }
}

export async function readFavoriteFolderSnapshot(): Promise<FavoriteFolderSnapshot | null> {
  return loadFavoriteFolderSnapshot();
}

export async function forceRefreshFavoriteFolderSnapshot(
  requestTracker?: ApiRequestTracker
): Promise<FavoriteFolderSnapshot> {
  if (favoriteFolderRefreshPromise) {
    return favoriteFolderRefreshPromise;
  }

  const task = (async () => {
    const user = await refreshCurrentUserSnapshot(requestTracker);
    const folders = await getCreatedFoldersByMid(user.mid, requestTracker);
    const snapshot: FavoriteFolderSnapshot = {
      ownerMid: user.mid,
      ownerName: user.uname,
      folders,
      fetchedAt: Date.now()
    };
    await saveFavoriteFolderSnapshot(snapshot);
    return snapshot;
  })();

  favoriteFolderRefreshPromise = task;
  try {
    return await task;
  } finally {
    if (favoriteFolderRefreshPromise === task) {
      favoriteFolderRefreshPromise = null;
    }
  }
}

/**
 * 新建收藏夹成功后直接回写本地快照，避免立刻再打一轮列表请求。
 * `fetchedAt` 保持最近一次真实同步时间，避免把本地补写误当成远端刷新。
 */
export async function mergeCreatedFavoriteFolderIntoSnapshot(
  folder: FavoriteFolder
): Promise<FavoriteFolderSnapshot | null> {
  const snapshot = await loadFavoriteFolderSnapshot();
  if (!snapshot) {
    return null;
  }

  const next: FavoriteFolderSnapshot = {
    ...snapshot,
    folders: [
      folder,
      ...snapshot.folders.filter((item) => item.id !== folder.id)
    ]
  };
  await saveFavoriteFolderSnapshot(next);
  return next;
}
