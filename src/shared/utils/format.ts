import type { GroupSyncStatus } from '@/shared/types';

interface FormatPubdateOptions {
  hideCurrentYear?: boolean;
}

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

/**
 * 按本地时区格式化投稿时间。
 * 可选地在“当前年份”场景下省略年份，用于卡片上的紧凑展示。
 */
export function formatPubdate(seconds: number, options: FormatPubdateOptions = {}): string {
  const date = new Date(seconds * 1000);
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  const hh = `${date.getHours()}`.padStart(2, '0');
  const mm = `${date.getMinutes()}`.padStart(2, '0');
  if (options.hideCurrentYear && y === new Date().getFullYear()) {
    return `${m}-${d} ${hh}:${mm}`;
  }
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

/**
 * B 站投稿接口的时长常以 `分钟:秒` 返回。
 * 当分钟数超过 60 时，将其转成更易读的 `小时:分钟:秒`。
 * 非预期格式保持原样返回，避免误伤其他展示来源。
 */
export function formatVideoDuration(durationText?: string): string | undefined {
  if (!durationText) {
    return undefined;
  }

  const normalized = durationText.trim();
  const parts = normalized.split(':');
  if (parts.length !== 2) {
    return normalized;
  }

  const [minutesPart, secondsPart] = parts;
  if (!/^\d+$/.test(minutesPart) || !/^\d+$/.test(secondsPart)) {
    return normalized;
  }

  const totalMinutes = Number(minutesPart);
  const seconds = Number(secondsPart);
  if (!Number.isInteger(totalMinutes) || !Number.isInteger(seconds) || seconds < 0 || seconds >= 60) {
    return normalized;
  }

  if (totalMinutes < 60) {
    return normalized;
  }

  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  return `${hours}:${String(remainingMinutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
