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

export function formatPubdate(seconds: number): string {
  const date = new Date(seconds * 1000);
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  const hh = `${date.getHours()}`.padStart(2, '0');
  const mm = `${date.getMinutes()}`.padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}
