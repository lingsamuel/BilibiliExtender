# 统一调度器 Spec

## 1. 背景与目标

### 1.1 问题

当前实现中，前台操作（打开抽屉、切换分组、手动刷新）会直接触发 API 请求。当分组包含大量作者时，会在短时间内发出大量请求，触发 Bilibili 限流（HTTP 412）。限流后整个分组不可用。

### 1.2 目标

将所有 Bilibili API 请求收归到后台统一调度器管理。前台操作不再直接发起 API 请求，而是：
- 始终优先读取缓存
- 缓存为空时显示"正在生成缓存"提示
- 需要刷新时，向调度器提交优先任务

### 1.3 非目标

- 不改变现有的缓存数据结构（`AuthorVideoCache`、`GroupFeedCache`）。
- 不改变视图组装逻辑（`toFeedResult`）。

## 2. 术语

- **任务（Task）**：刷新单个作者视频缓存的工作单元，包含 `mid` 和 `name`。
- **批次（Batch）**：一组串行执行的任务，最多 `BATCH_SIZE`（10）个。
- **优先任务**：由用户操作（手动刷新、新建分组）触发的任务，插入队列最前。
- **常规任务**：由 alarm 定时触发的过期作者刷新任务。

## 3. 调度器设计

### 3.1 核心数据结构

```ts
interface SchedulerTask {
  mid: number;
  name: string;
  // 关联的分组 ID，用于通知前台刷新完成
  groupId?: string;
}

interface SchedulerState {
  // 待执行任务队列（FIFO，优先任务插入队首）
  queue: SchedulerTask[];
  // 当前正在执行的任务（null 表示空闲）
  currentTask: SchedulerTask | null;
  // 当前批次已完成的任务数
  batchCompleted: number;
  // 当前批次失败的任务（放入下一批次重试）
  batchFailed: SchedulerTask[];
  // 调度器是否正在运行
  running: boolean;
  // 上次调度循环开始时间
  lastRunAt?: number;
}
```

### 3.2 调度流程

#### 3.2.1 Alarm 触发

1. `chrome.alarms` 按 `backgroundRefreshIntervalMinutes` 周期触发。
2. 触发时检查调度器状态：
   - **有正在执行的任务**：不生成新批次，等待当前批次完成后自然继续。
   - **空闲**：收集所有启用分组的过期作者，按 `lastFetchedAt` 升序排列，生成任务队列，开始执行。

#### 3.2.2 优先任务插入

当用户触发手动刷新或新建分组时：

1. 收集需要刷新的作者列表。
2. 去重：跳过队列中已存在的 `mid`。
3. 插入到队列最前面（在 `currentTask` 之后）。
4. 检查当前批次剩余任务数（`batchCompleted` + 队列中属于当前批次的任务）：
   - 如果插入后当前批次总任务数超过 `BATCH_SIZE`，将超出部分移到下一批次位置。
5. 如果调度器空闲，立即启动执行循环。

#### 3.2.3 执行循环

```
while (queue 非空) {
  取出队首任务 → currentTask
  执行 refreshAuthorCache(mid, name, authorCacheMap)
  if (成功) {
    batchCompleted++
  } else {
    将任务加入 batchFailed
  }
  currentTask = null

  if (batchCompleted >= BATCH_SIZE) {
    // 当前批次结束
    将 batchFailed 追加到队列末尾
    batchFailed = []
    batchCompleted = 0
    持久化缓存
    等待批次间延迟
  } else if (queue 非空) {
    等待 INTRA_DELAY（1秒）
  }
}

// 队列清空，处理最后一批的失败任务
将 batchFailed 追加到队列末尾（留给下次 alarm）
持久化缓存
running = false
```

#### 3.2.4 批次间延迟计算

与现有逻辑一致：

```
batchCount = ceil(总任务数 / BATCH_SIZE)
batchDelay = max(MIN_BATCH_DELAY, backgroundRefreshIntervalMinutes * 60 * 1000 / batchCount)
```

### 3.3 前台交互变更

#### 3.3.1 打开抽屉 / 切换分组

1. 前台发送 `GET_GROUP_FEED` 消息。
2. 后台检查 `feedCacheMap` 和 `authorCacheMap`：
   - **有缓存**：直接用 `toFeedResult` 组装返回。不触发任何 API 请求。
   - **无缓存（首次）**：返回特殊响应 `{ cacheStatus: 'generating' }`，同时向调度器提交该分组的作者列表为优先任务。
3. 前台收到 `generating` 状态后显示"正在生成缓存，请稍候..."提示。
4. 前台启动轮询（间隔 3 秒，最多轮询 10 次），每次发送 `GET_GROUP_FEED` 检查缓存是否就绪。

#### 3.3.2 手动刷新

1. 前台发送 `MANUAL_REFRESH` 消息（新消息类型），携带 `groupId`。
2. 后台收集该分组所有作者，作为优先任务插入调度器队列。
3. 立即返回 `{ accepted: true }`，不等待刷新完成。
4. 前台启动轮询（间隔 3 秒，最多轮询 20 次），每次发送 `GET_GROUP_FEED` 获取最新缓存。
5. 轮询期间 UI 显示"正在刷新..."状态。

#### 3.3.3 新建分组

1. 分组创建后，后台需要先拉取收藏夹内容获取作者列表（`getAllFavVideos`）。
2. 这个收藏夹拉取请求也通过调度器执行：提交一个特殊的"分组初始化"任务。
3. 初始化完成后，将作者列表作为优先任务插入队列。

### 3.4 消息协议变更

新增消息类型：

```ts
// 手动刷新请求
| { type: 'MANUAL_REFRESH'; payload: { groupId: string } }

// 获取调度器状态（调试用）
| { type: 'GET_SCHEDULER_STATUS' }
```

`GET_GROUP_FEED` 响应变更：

```ts
interface GroupFeedResponse {
  // 现有字段...
  // 新增：缓存状态
  cacheStatus: 'ready' | 'generating';
}
```

`MANUAL_REFRESH` 响应：

```ts
interface ManualRefreshResponse {
  accepted: boolean;
}
```

`GET_SCHEDULER_STATUS` 响应：

```ts
interface SchedulerStatusResponse {
  running: boolean;
  queueLength: number;
  currentTask: { mid: number; name: string } | null;
  batchCompleted: number;
  batchFailed: number;
  lastRunAt?: number;
  // 队列详情（调试用）
  queue: Array<{ mid: number; name: string; groupId?: string }>;
}
```

## 4. 调试模式

### 4.1 设置项

`ExtensionSettings` 新增：

```ts
debugMode: boolean; // 默认 false
```

### 4.2 调试页面

- 入口：抽屉侧边栏，"设置"按钮下方显示"调试"按钮（仅 `debugMode` 开启时可见）。
- 内容：
  - 调度器状态：运行中/空闲
  - 当前任务：mid + name
  - 队列长度 + 队列详情列表
  - 当前批次进度：已完成 / BATCH_SIZE
  - 失败任务数
  - 上次调度时间
- 自动刷新：每 2 秒轮询 `GET_SCHEDULER_STATUS`。

## 5. 文件变更清单

### 5.1 删除

- `src/background/scheduler.ts`：现有调度器实现，将被新实现替代。

### 5.2 新增

- `src/background/scheduler.ts`：统一调度器（重写）。
- `src/content/components/DebugPanel.vue`：调试面板组件。

### 5.3 修改

- `src/shared/types.ts`：`ExtensionSettings` 新增 `debugMode`。
- `src/shared/constants.ts`：`DEFAULT_SETTINGS` 新增 `debugMode: false`；移除 `API_REQUEST_DELAY_MS`。
- `src/shared/messages.ts`：新增 `MANUAL_REFRESH`、`GET_SCHEDULER_STATUS` 消息类型。
- `src/background/index.ts`：`handleGetGroupFeed` 不再调用 `ensureGroupCache`/`loadMoreForMixed` 等触发 API 的函数，改为纯缓存读取 + 提交调度任务。新增 `handleManualRefresh`、`handleGetSchedulerStatus`。
- `src/background/feed-service.ts`：移除 `ensureAuthorCache`、`ensureGroupCache` 中的 API 调用逻辑和 `sleep`/`API_REQUEST_DELAY_MS`。`refreshAuthorCache` 保留为调度器调用的原子操作。
- `src/content/components/DrawerApp.vue`：手动刷新改为发送 `MANUAL_REFRESH` + 轮询；处理 `cacheStatus: 'generating'`。
- `src/content/components/DrawerApp.vue`：侧边栏新增调试入口。
- `src/shared/components/SettingsPanel.vue`：新增调试模式开关。
- `src/styles/content.css`：调试面板样式。

## 6. 从主 Spec 中移除的内容

原 `grouped-feed-extension-spec.md` 的 4.5.5（前台刷新）和 4.5.6（后台定时刷新）两节将被本文档替代。主 Spec 中这两节改为引用本文档。
