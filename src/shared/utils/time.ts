import { normalizeDefaultReadMarkDays } from '@/shared/utils/settings';

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;

function getNowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function getElapsedSeconds(seconds: number, nowSeconds: number): number {
  return Math.max(0, nowSeconds - seconds);
}

/**
 * “N天内”统一采用按整天分桶的窗口语义：
 * - 不是严格的 N * 24 小时；
 * - 而是允许落在第 N 个整天桶中的内容继续算作“N天内”。
 *
 * 返回值是一个“排除性边界”：
 * - `pubdate > boundaryTs` 表示命中 N 天窗口；
 * - `pubdate <= boundaryTs` 表示已落到窗口之外。
 */
export function getRecentDaysBoundaryTs(days: number, nowSeconds = getNowSeconds()): number {
  const normalizedDays = normalizeDefaultReadMarkDays(days);
  return nowSeconds - (normalizedDays + 1) * DAY_SECONDS;
}

export function isWithinRecentDays(seconds: number, days: number, nowSeconds = getNowSeconds()): boolean {
  return seconds > getRecentDaysBoundaryTs(days, nowSeconds);
}

/**
 * 投稿时间统一使用“分钟内 / 小时前 / 天前”三段式展示，
 * 避免出现“0天前”这类误导性文案。
 */
export function formatRelativePublishedAt(seconds: number, nowSeconds = getNowSeconds()): string {
  const diffSeconds = getElapsedSeconds(seconds, nowSeconds);
  if (diffSeconds < HOUR_SECONDS) {
    const minutes = Math.max(1, Math.floor(diffSeconds / MINUTE_SECONDS));
    return `${minutes}分钟内`;
  }
  if (diffSeconds < DAY_SECONDS) {
    const hours = Math.floor(diffSeconds / HOUR_SECONDS);
    return `${hours}小时前`;
  }
  const days = Math.floor(diffSeconds / DAY_SECONDS);
  return `${days}天前`;
}
