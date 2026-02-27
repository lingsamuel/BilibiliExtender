import type { VideoItem } from '@/shared/types';

export interface MixedDayGroup {
  dayKey: string;
  label: string;
  videos: VideoItem[];
}

function pad2(value: number): string {
  return `${value}`.padStart(2, '0');
}

function toDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return `${year}-${month}-${day}`;
}

function buildDateFromDayKey(dayKey: string): Date | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!matched) {
    return null;
  }
  const [, yearText, monthText, dayText] = matched;
  const year = Number(yearText);
  const month = Number(monthText) - 1;
  const day = Number(dayText);
  return new Date(year, month, day);
}

/**
 * 按用户本地时区把秒级时间戳转换为自然日键（YYYY-MM-DD）。
 * 时间流的按天分段、可视窗口压缩都基于该键，保证同一时区下分组稳定。
 */
export function getDayKeyFromSeconds(seconds: number): string {
  return toDayKey(new Date(seconds * 1000));
}

export function formatTimelineDayLabel(dayKey: string, nowMs = Date.now()): string {
  const now = new Date(nowMs);
  const todayKey = toDayKey(now);
  if (dayKey === todayKey) {
    return '今天';
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey === toDayKey(yesterday)) {
    return '昨天';
  }

  const date = buildDateFromDayKey(dayKey);
  if (!date) {
    return dayKey;
  }

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const targetStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.floor((todayStart - targetStart) / (24 * 60 * 60 * 1000));
  if (diffDays >= 2 && diffDays <= 7) {
    return `${diffDays}天前`;
  }

  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * 把时间流视频列表按“有投稿的日期”分段。
 * 不补齐无投稿日期，返回顺序与视频流顺序一致（通常为发布时间倒序）。
 */
export function buildMixedDayGroups(videos: VideoItem[], nowMs = Date.now()): MixedDayGroup[] {
  const groups: MixedDayGroup[] = [];
  const groupMap = new Map<string, MixedDayGroup>();

  for (const video of videos) {
    const dayKey = getDayKeyFromSeconds(video.pubdate);
    let group = groupMap.get(dayKey);
    if (!group) {
      group = {
        dayKey,
        label: formatTimelineDayLabel(dayKey, nowMs),
        videos: []
      };
      groupMap.set(dayKey, group);
      groups.push(group);
    }
    group.videos.push(video);
  }

  return groups;
}

/**
 * 计算时间轴压缩窗口，只保留焦点日期前后固定数量的“有投稿日期”。
 */
export function buildTimelineWindow(
  total: number,
  focusIndex: number,
  radius: number
): { start: number; end: number } {
  if (total <= 0) {
    return { start: 0, end: -1 };
  }

  const safeFocus = Math.max(0, Math.min(total - 1, focusIndex));
  return {
    start: Math.max(0, safeFocus - radius),
    end: Math.min(total - 1, safeFocus + radius)
  };
}
