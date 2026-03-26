import type { GroupSyncStatus } from '@/shared/types';

export function formatRelativeMinutes(timestampMs?: number): string {
  if (!timestampMs) {
    return '从未刷新';
  }

  const diffMs = Date.now() - timestampMs;
  if (diffMs < 60 * 1000) {
    return '刚刚刷新';
  }

  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 60) {
    return `${minutes} 分钟前刷新`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前刷新`;
  }

  const days = Math.floor(hours / 24);
  return `${days} 天前刷新`;
}

export function formatGroupSyncStatus(status?: GroupSyncStatus): string {
  if (!status || status.totalAuthors <= 0) {
    return '暂无作者';
  }

  if (status.staleAuthors > 0) {
    return `待刷新：${status.staleAuthors}/${status.totalAuthors}`;
  }

  if (!status.oldestFreshFetchedAt) {
    return `待刷新：${status.totalAuthors}/${status.totalAuthors}`;
  }

  const diffMinutes = Math.max(0, Math.floor((Date.now() - status.oldestFreshFetchedAt) / (60 * 1000)));
  if (diffMinutes <= 0) {
    return '上次同步：刚刚';
  }
  return `上次同步：${diffMinutes}分钟前`;
}

export function formatPubdate(seconds: number): string {
  const date = new Date(seconds * 1000);
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  const hh = `${date.getHours()}`.padStart(2, '0');
  const mm = `${date.getMinutes()}`.padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

/**
 * 将 Unix 秒级时间戳格式化为可读的日期时间字符串，用于已阅时间点下拉菜单。
 */
export function formatReadMarkTs(seconds: number): string {
  return formatPubdate(seconds);
}

/**
 * B 站封面播放量在超过 1 万后转为 “N万” 形式，且固定保留 1 位小数。
 */
export function formatVideoPlayCount(playCount?: number): string | undefined {
  if (!Number.isFinite(playCount) || playCount === undefined || playCount < 0) {
    return undefined;
  }

  if (playCount > 10000) {
    return `${(playCount / 10000).toFixed(1)}万`;
  }

  return String(Math.floor(playCount));
}
