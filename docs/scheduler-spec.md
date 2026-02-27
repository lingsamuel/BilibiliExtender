# 通用调度器 Spec

## 1. 背景与目标

### 1.1 问题

当前实现只覆盖作者视频缓存刷新，收藏夹内容（标题、作者列表）缺少同等级别的定时缓存更新。导致分组配置建立后，收藏夹后续变更无法稳定同步到分组缓存。

### 1.2 目标

将后台调度器抽象为通用组件，支持多任务通道并行存在、独立限流与独立 alarm：
- 通道 A：作者视频缓存刷新（`author-video`）
- 通道 B：收藏夹缓存刷新（`group-fav`）

前台行为统一为“读缓存 + 提交任务”，不直接发起重型 API 刷新请求。

### 1.3 非目标

- 不改变 UI 的核心展示结构（混合模式/作者模式）。
- 不改变红点判定规则。
- 不引入跨设备强一致调度状态同步。

## 2. 术语

- **通道（Channel）**：一类任务的独立队列与执行参数集合。
- **任务（Task）**：一次最小刷新单元。
- **优先任务（Priority Task）**：由用户操作触发，立即入列到队首。
- **常规任务（Routine Task）**：由定时 alarm 触发。
- **Burst 任务（Burst Task）**：仅包含“作者缓存不存在（无任何缓存）”的作者任务，使用专用队列。

## 3. 设计方案

### 3.1 通用调度器内核

```ts
interface SchedulerTaskBase {
  key: string; // 任务去重键
  groupId?: string;
}

interface SchedulerChannel<TTask extends SchedulerTaskBase> {
  name: string;
  queue: TTask[];
  currentTask: TTask | null;
  batchCompleted: number;
  batchFailed: TTask[];
  running: boolean;
  lastRunAt?: number;

  batchSize: number;
  intraDelayMs: number;
  minBatchDelayMs: number;

  collectRoutineTasks(): Promise<TTask[]>;
  runTask(task: TTask): Promise<void>;
  onTaskSuccess?(task: TTask): Promise<void>;
}
```

内核职责：
1. 去重入列（`key`）。
2. 串行执行同一通道任务。
3. 批次计数、批次间延迟、失败重排。
4. 状态查询（供调试面板）。
5. 按通道注册 `chrome.alarms`。

### 3.2 任务通道

#### 3.2.1 作者视频通道（`author-video`）

任务结构：

```ts
interface AuthorVideoTask extends SchedulerTaskBase {
  key: `author:${number}`;
  mid: number;
  name: string;
}
```

来源：
- 定时：收集所有启用分组中的作者 `mid`，筛选过期缓存。
- 优先：手动刷新、首次访问分组、新建分组初始化后触发。
- Burst：任意入口发现“作者缓存不存在”时，进入 `author-video` 的 Burst 队列。

执行：调用 `refreshAuthorCache(mid, name, authorCacheMap)`。

#### 3.2.2 收藏夹缓存通道（`group-fav`）

任务结构：

```ts
interface GroupFavTask extends SchedulerTaskBase {
  key: `group:${string}`;
  groupId: string;
}
```

来源：
- 定时：遍历所有启用分组，按 `groupFavRefreshIntervalMinutes` 判断 `GroupFeedCache.updatedAt` 是否过期。
- 优先：`MANUAL_REFRESH`、分组列表“立即刷新”。

执行：
1. 读取分组配置，调用 `getAllFavVideos(mediaId)`。
2. 若请求失败，或请求成功但作者列表为空数组：判定为“无效更新”，保持现有 `GroupFeedCache` 与 `group.mediaTitle` 不变，不覆盖为“空分组”。
3. 仅在作者列表非空时，更新 `GroupFeedCache.authorMids` 与 `updatedAt`。
4. 同步收藏夹标题到 `group.mediaTitle`（`alias` 不变）。
5. 将该分组最新作者列表转换为 `AuthorVideoTask`，立即入列 `author-video` 通道（优先）。

说明：该通道与 `author-video` 通道独立限流，不共享 ratelimit。

### 3.3 Alarm 与间隔设置

新增/调整设置项：
- `backgroundRefreshIntervalMinutes`：作者视频通道定时周期，默认 `10`，范围 `5–120`。
- `groupFavRefreshIntervalMinutes`：收藏夹缓存通道定时周期，默认 `10`，范围 `5–120`。
- `schedulerBatchSize`：调度器每批任务数，默认 `10`，范围 `1–50`，两个通道共享同一设置值。

每个通道独立注册 alarm：
- `bbe:refresh:author-video`
- `bbe:refresh:group-fav`

### 3.4 前台交互

#### 3.4.1 GET_GROUP_FEED

- 仅基于缓存组装返回。
- 分组无缓存时：返回 `cacheStatus: 'generating'`，并优先入列 `group-fav` 任务。
- 分组有缓存但作者缓存不完整时：
  1. 识别缺失作者并分流：
     - 若 `AuthorVideoCache[mid]` 不存在：入列 Burst 队列；
     - 若缓存存在但已过期：入列 `author-video` 常规优先队列。
  2. 去重后入列，避免重复堆积。
  3. 返回 `cacheStatus: 'generating'`，但同时返回当前可用的聚合结果（允许部分内容先展示）。
  4. 仅当本轮缺失作者都完成至少一轮缓存后，返回 `cacheStatus: 'ready'`。
- 分组有缓存且作者缓存完整时：返回 `cacheStatus: 'ready'`。

#### 3.4.2 MANUAL_REFRESH

`MANUAL_REFRESH(groupId)` 的行为统一为“立即入列两段刷新链路”：
1. 优先入列 `group-fav` 任务。
2. `group-fav` 成功后，基于最新作者列表优先入列 `author-video` 任务。
3. 接口立即返回 `{ accepted: true }`，前台轮询 `GET_GROUP_FEED`。

#### 3.4.3 设置页“立即刷新”

分组列表每行新增“立即刷新”按钮，行为与抽屉手动刷新完全一致，调用同一 `MANUAL_REFRESH` 消息。

#### 3.4.4 调试页“立刻发起调度”

1. 调试页新增“立刻发起调度”按钮，触发目标范围为全部通道（`author-video` + `group-fav`）。
2. 每个通道执行“单次补齐调度”：本次触发仅保证该通道队列总量达到 `schedulerBatchSize`，不会把候选任务全量入队。
3. 补齐顺序固定为：
   - 先保留当前队列中的已有任务；
   - 若不足 `schedulerBatchSize`，按“最旧优先”补齐候选任务（不区分是否过期）。
4. “最旧”口径固定为：
   - `author-video`：按 `AuthorVideoCache.lastFetchedAt` 升序（缺失缓存视为 `0`）；
   - `group-fav`：按 `GroupFeedCache.updatedAt` 升序（缺失缓存视为 `0`）。
5. 若通道空闲则立即启动执行循环；若已在运行则只合并任务队列，不创建并行循环。
6. 触发后必须重置该通道 alarm 的下次触发时间：`nextAlarmAt = now + 对应通道 interval`。

### 3.5 常规模式批次与限速规则（关键约束）

以下规则在“非 Burst 执行窗口”内生效，`author-video` 与 `group-fav` 两个通道都适用，且互相独立执行：

1. 任务串行：同一通道内一次只执行一个任务。
2. 批次上限：每批最多 `schedulerBatchSize` 个任务（默认 `10`）。
3. 批内间隔：同批任务之间固定等待 `INTRA_DELAY_MS`（默认 `1000ms`）。
4. 批间延迟：每批完成后按周期均匀分散请求，公式为：

```ts
batchCount = ceil(totalTasks / schedulerBatchSize);
batchDelay = max(MIN_BATCH_DELAY_MS, intervalMinutes * 60 * 1000 / batchCount);
```

其中 `MIN_BATCH_DELAY_MS` 默认 `30000ms`。

5. 失败重试：任务失败后先放入 `batchFailed`，在当前批次结束时追加到队列尾部，进入下一批或下次 alarm 重试。
6. 优先入列：用户触发的优先任务插入队首；去重键冲突时跳过重复任务。
7. 运行中告警：若某通道正在运行，alarm 触发时不重复创建新执行循环，只补充队列。

执行循环约束如下：

```ts
while (queue not empty) {
  task = queue.shift();
  runTask(task);
  if (success) batchCompleted++;
  else batchFailed.push(task);

  if (batchCompleted >= schedulerBatchSize) {
    queue.push(...batchFailed);
    batchFailed = [];
    batchCompleted = 0;
    persist();
    wait(batchDelay);
  } else if (queue not empty) {
    wait(INTRA_DELAY_MS);
  }
}

queue.push(...batchFailed); // 留给下一批或下次 alarm
persist();
```

### 3.6 Burst 模式（作者无缓存快速填充）

#### 3.6.1 触发条件

1. 只要发现任意作者 `mid` 在 `AuthorVideoCache` 中不存在，即触发 Burst 入列（不设数量阈值）。
2. Burst 队列只允许接收“无缓存作者”任务；已存在缓存（无论是否过期）不得进入 Burst 队列。
3. Burst 去重键与作者任务一致（`mid`）。

#### 3.6.2 优先级与阻塞规则

1. Burst 优先级高于常规任务。
2. Burst 队列非空时，不执行任意通道的常规 alarm 调度（`author-video` / `group-fav` 都暂停常规执行）。
3. Burst 期间，用户触发任务仍可入常规队列，但执行时机延后到 Burst 队列清空之后。
4. 若 Burst 激活时已有非 Burst 任务正在执行，允许该任务完成当前项后再切换到 Burst 循环。
5. Burst 队列清空后，恢复常规调度；并立即补偿触发一次常规任务收集（不重置 alarm）。

#### 3.6.3 执行语义

1. Burst 仍然串行执行（一次一个作者）。
2. 成功路径仍使用 `INTRA_DELAY_MS`（与常规任务一致），且为“无条件冷却”：每次任务成功后都要记录下一次可执行时间（`nextAllowedAt = now + INTRA_DELAY_MS`），即使此刻队列为空也不例外。
3. Burst 不使用批次间延迟，不受 `batchDelay`/`intervalMinutes` 约束。
4. 只要遇到任意错误，立即进入冷却：等待 `60s` 后再继续执行。
5. Burst 每次取任务前都必须先检查 `now >= nextAllowedAt`，不满足则等待剩余时间，避免“上一条刚完成、下一条立刻入队”导致的无间隔请求。
6. 失败任务留在队首，冷却结束后优先重试；直到 Burst 队列为空才退出 Burst 模式。

执行循环约束如下：

```ts
while (burstQueue not empty) {
  waitUntil(nextAllowedAt);
  task = burstQueue.peek();
  try {
    runTask(task);
    burstQueue.shift();
    nextAllowedAt = now + INTRA_DELAY_MS;
  } catch (error) {
    wait(60_000);
  }
}
```

## 4. 消息协议

沿用现有消息，`MANUAL_REFRESH` 请求/响应不变：

```ts
| { type: 'MANUAL_REFRESH'; payload: { groupId: string } }

interface ManualRefreshResponse {
  accepted: boolean;
}
```

新增调试触发消息：

```ts
| { type: 'RUN_SCHEDULER_NOW' }

interface RunSchedulerNowResponse {
  accepted: true;
  triggeredAt: number;
  channels: Array<{
    name: 'author-video' | 'group-fav';
    queued: number;
    nextAlarmAt?: number;
  }>;
}
```

`GET_SCHEDULER_STATUS` 扩展为按通道返回状态（调试用）：

```ts
interface SchedulerStatusResponse {
  schedulerBatchSize: number;
  channels: Array<{
    name: 'author-video' | 'group-fav';
    running: boolean;
    queueLength: number;
    currentTask: Record<string, unknown> | null;
    batchCompleted: number;
    batchFailed: number;
    lastRunAt?: number;
    nextAlarmAt?: number;
  }>;
}
```

## 5. 文件变更清单

### 5.1 新增

- `src/background/scheduler/core.ts`：通用调度器内核。
- `src/background/scheduler/channels/author-video.ts`：作者视频通道。
- `src/background/scheduler/channels/group-fav.ts`：收藏夹缓存通道。

### 5.2 修改

- `src/background/scheduler.ts`：改为通道装配与对外门面。
- `src/background/index.ts`：
  - `MANUAL_REFRESH` 改为触发“收藏夹刷新 → 作者视频刷新”链路。
  - `GET_GROUP_FEED` 无缓存时触发 `group-fav` 优先任务。
- `src/background/index.ts`：新增 `RUN_SCHEDULER_NOW` 消息路由。
- `src/background/feed-service.ts`：补充分组收藏夹刷新原子函数（仅供调度器调用）。
- `src/shared/types.ts`：`ExtensionSettings` 新增 `groupFavRefreshIntervalMinutes`、`schedulerBatchSize`。
- `src/shared/constants.ts`：两个后台刷新间隔默认值均调整为 `10`。
- `src/shared/components/SettingsPanel.vue`：
  - 新增 `groupFavRefreshIntervalMinutes` 设置项。
  - 新增 `schedulerBatchSize` 设置项（全调度器共享）。
  - 分组行新增“立即刷新”按钮。
- `src/shared/messages.ts`：新增 `RUN_SCHEDULER_NOW` 消息类型与响应，调试状态返回 `schedulerBatchSize`。
- `src/content/components/DebugPanel.vue`：新增“立刻发起调度”按钮并展示重置后的下次触发时间。

## 6. 与主 Spec 的关系

`grouped-feed-extension-spec.md` 仅保留刷新行为的产品级描述；具体调度执行模型以本文档为准。
