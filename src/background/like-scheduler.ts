import { likeVideo } from '@/shared/api/bilibili';

const LIKE_TASK_INTERVAL_MS = 1000;

interface LikeTask {
  aid: number;
  bvid: string;
  csrf: string;
  batchId: string;
}

interface BatchState {
  authorMid: number;
  total: number;
  remaining: number;
  successCount: number;
  failedBvids: string[];
  resolve: (value: LikeBatchResult) => void;
}

export interface LikeBatchResult {
  authorMid: number;
  total: number;
  successCount: number;
  failedCount: number;
  failedBvids: string[];
}

const queue: LikeTask[] = [];
const batchStates = new Map<string, BatchState>();
let running = false;
let batchSeq = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 将原始视频列表归一化为“可执行点赞”的任务输入：
 * - 仅保留 aid/bvid 有效的视频；
 * - 按 bvid 去重，避免同批次重复点赞。
 */
function normalizeVideos(videos: Array<{ aid: number; bvid: string }>): Array<{ aid: number; bvid: string }> {
  const dedup = new Map<string, { aid: number; bvid: string }>();
  for (const video of videos) {
    const aid = Math.max(0, Math.floor(Number(video.aid) || 0));
    const bvid = video.bvid?.trim();
    if (!aid || !bvid) {
      continue;
    }
    if (!dedup.has(bvid)) {
      dedup.set(bvid, { aid, bvid });
    }
  }
  return Array.from(dedup.values());
}

function startWorkerIfIdle(): void {
  if (running || queue.length === 0) {
    return;
  }
  void runWorker();
}

async function runWorker(): Promise<void> {
  if (running) {
    return;
  }
  running = true;

  while (queue.length > 0) {
    const task = queue.shift()!;
    const state = batchStates.get(task.batchId);
    if (!state) {
      continue;
    }

    try {
      await likeVideo({ aid: task.aid, bvid: task.bvid }, true, task.csrf);
      state.successCount += 1;
    } catch {
      state.failedBvids.push(task.bvid);
    } finally {
      state.remaining -= 1;
      if (state.remaining <= 0) {
        batchStates.delete(task.batchId);
        state.resolve({
          authorMid: state.authorMid,
          total: state.total,
          successCount: state.successCount,
          failedCount: state.failedBvids.length,
          failedBvids: [...state.failedBvids]
        });
      }
    }

    if (queue.length > 0) {
      await sleep(LIKE_TASK_INTERVAL_MS);
    }
  }

  running = false;
}

/**
 * 提交作者级批量点赞任务并等待批次完成。
 * 批次内部串行执行，失败不阻断后续任务。
 */
export async function enqueueLikeBatchAndWait(
  authorMid: number,
  videos: Array<{ aid: number; bvid: string }>,
  csrf: string
): Promise<LikeBatchResult> {
  const normalized = normalizeVideos(videos);
  if (normalized.length === 0) {
    return {
      authorMid,
      total: 0,
      successCount: 0,
      failedCount: 0,
      failedBvids: []
    };
  }

  const batchId = `${Date.now()}-${++batchSeq}`;
  const resultPromise = new Promise<LikeBatchResult>((resolve) => {
    batchStates.set(batchId, {
      authorMid,
      total: normalized.length,
      remaining: normalized.length,
      successCount: 0,
      failedBvids: [],
      resolve
    });

    for (const video of normalized) {
      queue.push({
        aid: video.aid,
        bvid: video.bvid,
        csrf,
        batchId
      });
    }
  });

  startWorkerIfIdle();
  return resultPromise;
}
