# 通用调度器 Spec

## 1. 背景与目标

### 1.1 问题

当前实现覆盖作者视频缓存刷新与收藏夹缓存刷新，但点赞交互仍未完全并入同等级别的受控调度：
- 作者“一键点赞”仍是独立串行队列；
- 单个 VideoCard 的点赞/取消点赞还未统一接入通道化调度与限流。

### 1.2 目标

将后台调度器抽象为通用组件，支持多任务通道并行存在、独立限流与独立 alarm：
- 通道 A：作者视频缓存刷新（`author-video`）
- 通道 B：收藏夹缓存刷新（`group-fav`）
- 通道 C：交互点赞任务（`like-action`）

前台行为统一为“读缓存 + 提交任务”，不直接发起重型 API 刷新请求。
- 前台只允许提交“刷新意图”（如手动刷新、分组创建触发刷新），不得携带调度细节（如 `mid`、`pn`、队列位置、是否等待完成）。
- 调度器必须异步执行刷新任务；`GET_GROUP_FEED` 必须保持纯缓存读取，不得在请求路径中同步等待补页任务完成。

### 1.3 非目标

- 不改变 UI 的核心展示结构（混合模式/作者模式）。
- 不改变红点判定规则。
- 不引入跨设备强一致调度状态同步。

## 2. 术语

- **通道（Channel）**：一类任务的独立队列与执行参数集合。
- **任务（Task）**：一次最小刷新单元。
- **优先任务（Priority Task）**：由用户操作触发，立即入列到队首。
- **常规任务（Routine Task）**：由定时 alarm 触发。
- **Burst 任务（Burst Task）**：作者级高优先任务，包含“无缓存作者首刷”与“时间流命中边界补页”两类任务，使用专用队列。

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
  key: `author:${number}:pn:${number}:ps:${number}`;
  mid: number;
  name: string;
  // 作者投稿请求必须显式携带 pageSize；1=首页刷新，>=2=连续窗口维护、时间流补块或精确分页请求
  pn: number;
  ps: number;
  reason: 'first-page-refresh' | 'extend-continuous-window' | 'load-more-boundary' | 'request-author-page';
}
```

来源：
- 定时（两阶段）：
  1. 收集所有启用分组中的作者 `mid`，筛选“首页过期”任务（`pn=1`）；
  2. 对“所有已有缓存作者”执行低优先级“连续窗口维护”扫描：
     - 第二页仍是默认优先的防御性目标；
     - 若当前连续缓存长度不足以覆盖 `2 + authorContinuousExtraPageCount` 页窗口，则继续入列后续补块任务；
     - 该判断不再依赖旧的 `usedInMixed/pageState` 回报，而是统一基于作者投稿列表服务的连续缓存长度与块池状态。
- 优先：手动刷新、首次访问分组、新建分组初始化后触发。
- Burst：
  - 任意入口发现“作者缓存不存在”时，进入 Burst 队列并优先拉取 `pn=1`；
  - 时间流构造器命中作者连续缓存边界时，进入 Burst 队列并按需拉取 `pn>=2`；
  - 作者分页请求 `REQUEST_AUTHOR_PAGE(groupId, mid, pn, ps)` 也走 Burst，但其结果语义是“精确页块”，不是旧的页级共享缓存命中。

执行：
1. 任意 `pn/ps` 请求成功后，都必须先落成一个作者投稿块（记录 `pageNum/pageSize/startIndex/endExclusive/version/videos`）。
2. 刷新首页（`pn=1`）时必须同步提取版本摘要（`page.count + tlist.Count`），并立即尝试重建主连续缓存。
3. 无论是否同版本，块拼接都优先尝试“相同 `bvid`”，其次尝试“时间戳接续/交叉”；仅当两者都不满足时，同版本块才允许退回到“绝对序号区间无缝衔接/重叠”的弱证据拼接。跨版本块仍必须依赖前两类证据，不能只靠区间拼接。
4. 调度器维护目标不再是“把 `maxCachedPn` 推进到更深页”，而是“尽量把主连续缓存维持到目标窗口长度”。
5. 旧版本块不立即丢弃，允许留在块池中直到超出非连续缓存容量后再淘汰。

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
5. 将该分组最新作者列表转换为 `AuthorVideoTask` 后按缓存状态分流：
   - 若 `AuthorVideoCache[mid]` 不存在：入列 Burst 队列；
   - 若缓存存在但已过期：入列 `author-video` 常规优先队列；
   - 若缓存存在且未过期：本轮跳过，不入作者队列。

说明：该通道与 `author-video` 通道独立限流，不共享 ratelimit。

#### 3.2.3 点赞动作通道（`like-action`）

任务结构：

```ts
interface LikeActionTask extends SchedulerTaskBase {
  key: `like:${string}`; // like:{bvid}
  bvid: string;
  aid: number;
  authorMid: number;
  action: 'like' | 'unlike';
  source: 'single-card-toggle' | 'author-batch-like';
  trigger: 'manual-click';
  pageContext: {
    tabId: number;
    pageOrigin: string;
    pageReferer: string;
  };
}
```

来源：
- 优先：
  - 前台点击某个 VideoCard 拇指按钮后，将该卡片转为点赞/取消点赞任务并入列；
  - 前台点击作者“一键点赞”后，将该作者当前可见视频列表转为点赞任务并入列。

执行：
1. 串行执行视频点赞 API（`archive/like`）：
   - `action='like'` => `like=1`
   - `action='unlike'` => `like=2`
2. 每个任务在真正发起请求前，都必须基于 `pageContext` 安装仅命中当前 `tabId` 的 DNR session rule，修正 `Origin`、`Referer`、`Sec-Fetch-Site`。
3. 单任务失败不中断后续任务；失败明细写入批次结果。
4. 队列去重键为 `bvid`，避免重复操作同一视频。
5. 任务间固定间隔（默认 `1000ms`）。
6. 单卡点击任务允许前台同步等待结果；作者批量点赞在批次结束后向前台返回成功/失败汇总，用于 toast 展示。

### 3.3 Alarm 与间隔设置

新增/调整设置项：
- `backgroundRefreshIntervalMinutes`：作者视频通道定时周期，默认 `10`，范围 `5–120`。
- `groupFavRefreshIntervalMinutes`：收藏夹缓存通道定时周期，默认 `10`，范围 `5–120`。
- `schedulerBatchSize`：调度器每批任务数，默认 `10`，范围 `1–50`，两个通道共享同一设置值。

每个通道独立注册 alarm：
- `bbe:refresh:author-video`
- `bbe:refresh:group-fav`

说明：`like-action` 为纯交互通道，不注册周期 alarm，仅响应前台显式入列。

### 3.4 前台交互

#### 3.4.1 GET_GROUP_FEED

- 该接口严格为“纯缓存读取 + 可选入列意图”，不得在请求路径中同步执行或等待任何刷新任务完成。
- 分组无缓存时：返回 `cacheStatus: 'generating'`，并优先入列 `group-fav` 任务。
- 分组有缓存但作者缓存不完整时：
  1. 识别缺失作者并分流：
     - 若 `AuthorVideoCache[mid]` 不存在：入列 Burst 队列；
     - 若缓存存在但已过期：入列 `author-video` 常规优先队列。
  2. 去重后入列，避免重复堆积。
  3. 返回 `cacheStatus: 'generating'`，但同时返回当前可用的聚合结果（允许部分内容先展示）。
  4. 仅当本轮缺失作者都完成至少一轮缓存后，返回 `cacheStatus: 'ready'`。
- 分组有缓存且作者缓存完整时：返回 `cacheStatus: 'ready'`。
- 时间流目标片段构造（`1-50`、`51-70`、`71-90`...）时：
  1. 先尝试使用现有可用连续缓存构造。
  2. 若构造触及某作者“当前连续缓存末尾”且判定仍有潜在可见增量，可提交“边界补块意图”给调度器。
     - 潜在可见增量判定同时满足：
       - 未跨过当前时间流可见下界（跨过后继续翻页不会产出当前筛选可见数据）；
       - 且作者连续缓存长度仍未覆盖已知总量，或块池/最新版本信息表明仍可能存在后续数据。
  3. 本次请求直接返回当前缓存结果，不等待补块任务完成；前台通过后续轮询或下一次读取拿到更新后结果。
  4. 若任务失败，不影响当前读取返回；错误记录在调度历史中并通过可观测性通道暴露。
  5. 补块成功后，必须先写块再重建连续缓存；时间流始终只消费重建后的连续数组。
  6. `hasMoreForMixed` 的判定必须与第 2 条保持同口径，避免出现“按钮可点但无增量”或“仍有增量却提前显示无更多”。

#### 3.4.1.1 REQUEST_AUTHOR_PAGE

`REQUEST_AUTHOR_PAGE(groupId, mid, pn, ps)` 的行为统一为“提交作者分页意图 + 建立一次前台等待会话”：
1. 若 `(mid, pn, ps)` 的精确页块已缓存且仍可直接复用：立即返回 `{ accepted: true, status: 'cached' }`，不建立等待会话，也不发送后续通知。
2. 若已确认作者不存在更多页：立即返回 `{ accepted: false, status: 'no-more' }`，不建立等待会话，也不发送后续通知。
3. 若目标页未缓存且仍可能存在：立即返回 `{ accepted: true, status: 'queued' }`，并向 Burst 队列提交该页任务。
4. 对 `status: 'queued'` 的分页请求：
   - 调度器必须记录“发起页面 + groupId + mid + pn + ps”的等待会话，仅用于该次作者分页反馈；
   - 当目标页任务成功写入块缓存并完成一次连续缓存重建后，向对应内容页发送“页已就绪”通知；
   - 当目标页任务首次执行失败时，即按该次前台等待会话的终态失败处理：向对应内容页发送“页失败”通知，并结束该次等待会话。
5. 上述通知能力仅用于 `REQUEST_AUTHOR_PAGE`，不得扩展到 `MANUAL_REFRESH`、时间流边界补页或收藏夹刷新链路。
6. 前台收到“页已就绪”通知后，应立即补发一次分页数据读取；收到“页失败”通知后，应立即停止本次作者分页等待中的兜底轮询。
7. 等待会话一旦因 `failed` 结束，调度器不得再向该会话补发后续 `ready`；若后续因其他入口再次入队并成功，只能作为新的读取结果被动可见。

作者分页前台等待策略：
1. `status: 'queued'` 后立即启动兜底轮询，但轮询只用于作者分页当前等待会话。
2. 轮询节奏固定为：前三次 `500ms`，后续每次 `1000ms`。
3. 满足以下任一条件即停止轮询：
   - 收到匹配当前 pending 目标的“页已就绪”通知，并完成一次成功的 `GET_GROUP_FEED`；
   - 收到匹配当前 pending 目标的“页失败”通知；
   - 当前 pending 目标失效（分组切换、模式切换、筛选切换、用户取消等待等）。

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

#### 3.4.5 前台调度边界（新增）

1. 前台业务路径不得调用“同步补页并等待结果”的接口（如 `ENSURE_AUTHOR_PAGE` 类能力）。
2. 前台可提交 `MANUAL_REFRESH` / `REQUEST_AUTHOR_PAGE` 等“刷新意图”，但不得通过参数控制调度器内部策略（如强制 `failFast`、队首插入、通道选择、重试策略）。
3. 刷新意图仅表达“需要什么数据”，是否立即执行、先执行哪条任务、何时完成由调度器自行决定。
4. 调试接口（如 `RUN_SCHEDULER_NOW`）仅用于调试面板，不得进入生产用户交互主路径。

#### 3.4.6 新增分组自动刷新

1. `UPSERT_GROUP` 在“新增分组”场景下，保存成功后立即触发一次该分组刷新（等价入列一条 `group-fav` 优先任务）。
2. “编辑已有分组”不自动触发此刷新，避免重复请求；仍由手动刷新或调度器驱动更新。

### 3.5 常规模式批次与限速规则（关键约束）

以下规则在“非 Burst 执行窗口”内生效，`author-video`、`group-fav`、`like-action` 三个通道都适用，且互相独立执行：

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
8. 全局冷却门：每次从任一通道真正发起请求前，都必须先检查 `now >= globalNextAllowedAt`；若未到时刻则统一等待剩余时间后再执行请求。

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

### 3.6 全局 WBI 风控冷却（新增）

该机制独立于通道批次节奏，作用范围覆盖全部请求入口（`author-video`、`group-fav`、`burst`）：

1. 触发条件（唯一）：
   - 作者投稿 WBI 接口出现 `WBI 签名过期`；
   - 且该请求已经执行过“清除 WBI key 后重试一次”仍失败（即 `getUploaderVideos` 抛出 `WbiExpiredError`）。
2. 一旦触发，调度器判定为 `Ratelimit` 超限，设置 `globalNextAllowedAt = now + 60s`。
3. 在 `globalNextAllowedAt` 到达前，任意通道都不得发起下一次请求（包括 `group-fav` 通道）。
4. 若冷却结束后再次触发同类错误，重复设置 `globalNextAllowedAt = now + 60s`；按固定 1 分钟阶梯持续退避，直到恢复。
5. 除上述 `WbiExpiredError` 外，其他错误保持现有处理，不触发全局冷却。
6. 对 Burst `failFast` 任务：允许立即返回失败状态给调用方，但同时必须写入全局冷却，防止下一次请求立即发出。
7. 全局冷却不重置 alarm 周期；仅延后实际请求执行时机。

### 3.7 Burst 模式（作者优先补页）

#### 3.7.1 触发条件

1. 任意作者 `mid` 在 `AuthorVideoCache` 中不存在时，触发 Burst 入列（优先 `pn=1`）。
2. 时间流构造命中分页边界时，触发 Burst 入列（由作者投稿列表服务计算下一块的 `pn + ps`）。
3. Burst 去重键使用 `(mid, pn, ps)`；同一作者同一请求窗口避免重复堆积。

#### 3.7.2 优先级与阻塞规则

1. Burst 优先级高于常规任务。
2. Burst 队列非空时，不执行任意通道的常规 alarm 调度（`author-video` / `group-fav` 都暂停常规执行）。
3. Burst 期间，用户触发任务仍可入常规队列，但执行时机延后到 Burst 队列清空之后。
4. 若 Burst 激活时已有非 Burst 任务正在执行，允许该任务完成当前项后再切换到 Burst 循环。
5. Burst 队列清空后，恢复常规调度；仅当 Burst 期间实际拦截过某通道 alarm 时，才补偿触发对应通道的一次常规任务收集（不重置 alarm）。
6. “加载更多命中边界”触发的 Burst 任务必须插入队首（head），优先于已有 Burst 队列任务（包括补第二页）。

#### 3.7.3 执行语义

1. Burst 仍然串行执行（一次一个作者）。
2. 成功路径仍使用 `INTRA_DELAY_MS`（与常规任务一致），且为“无条件冷却”：每次任务成功后都要记录下一次可执行时间（`nextAllowedAt = now + INTRA_DELAY_MS`），即使此刻队列为空也不例外。
3. Burst 不使用批次间延迟，不受 `batchDelay`/`intervalMinutes` 约束。
4. 只要遇到任意错误，立即进入冷却：等待 `60s` 后再继续执行，并记录冷却原因为 `error`（供调试面板展示）。
5. Burst 每次取任务前都必须先检查 `now >= nextAllowedAt`，不满足则等待剩余时间，避免“上一条刚完成、下一条立刻入队”导致的无间隔请求。
6. 失败任务留在队首，冷却结束后优先重试；直到 Burst 队列为空才退出 Burst 模式。
7. 对 Burst `failFast` 请求：若任务失败，需回传失败状态；读取链路继续以缓存结果 best-effort 返回。
8. Burst 发起请求前同样受“全局冷却门”约束：需同时满足 `now >= nextAllowedAt` 与 `now >= globalNextAllowedAt`。

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

### 3.8 调试页可观测性（新增）

调试页 `GET_SCHEDULER_STATUS` 需新增“全局冷却”状态块，用于定位 WBI 风控退避：

```ts
globalCooldown: {
  active: boolean;
  nextAllowedAt: number; // 0 表示无冷却
  reason: 'wbi-ratelimit' | null;
  lastTriggeredAt?: number;
}
```

展示要求：
1. 显示当前是否处于全局冷却中。
2. 显示下一次允许请求时间与剩余秒数。
3. 显示最近一次触发时间与触发原因（固定为 `wbi-ratelimit`）。

## 4. 消息协议

沿用现有消息，`MANUAL_REFRESH` 请求/响应不变：

```ts
| { type: 'MANUAL_REFRESH'; payload: { groupId: string } }

interface ManualRefreshResponse {
  accepted: boolean;
}
```

新增作者分页意图消息（前台表达“想看第 N 页”，不等待执行完成）：

```ts
| { type: 'REQUEST_AUTHOR_PAGE'; payload: { groupId: string; mid: number; pn: number; ps: number } }

interface RequestAuthorPageResponse {
  accepted: boolean;
  status: 'queued' | 'cached' | 'no-more';
  maxPage?: number;
}
```

新增作者分页结果通知消息（后台主动发送到内容页，仅服务于 `REQUEST_AUTHOR_PAGE`）：

```ts
| { type: 'AUTHOR_PAGE_STATUS'; payload: {
    groupId: string;
    mid: number;
    pn: number;
    status: 'ready' | 'failed';
    error?: string;
  } }
```

约束：
1. `status: 'ready'` 表示目标页已成功写入缓存，前台应立即拉一次 `GET_GROUP_FEED`。
2. `status: 'failed'` 表示该次作者分页等待会话已终态失败，前台必须停止该次兜底轮询、清除 pending 状态，并提示错误。
3. 该通知仅发给触发本次 `REQUEST_AUTHOR_PAGE` 的内容页；若页面上下文已失效，可直接丢弃，不要求补发。
4. 该通知不承载分页数据本体，不替代 `GET_GROUP_FEED`。

新增调试触发消息：

```ts
| { type: 'RUN_SCHEDULER_NOW' }

interface RunSchedulerNowResponse {
  accepted: true;
  triggeredAt: number;
  channels: Array<{
    name: 'author-video' | 'group-fav' | 'like-action';
    queued: number;
    nextAlarmAt?: number;
  }>;
}
```

新增页级使用回报消息（由构造器调用）：

```ts
| { type: 'REPORT_AUTHOR_PAGE_USAGE'; payload: {
    groupId: string;
    // 仅回报“实际参与本次目标页组构造”的最大页码，不包含仅命中边界但未取用的数据页
    usedPages: Array<{ mid: number; usedMaxPn: number }>;
  } }

interface ReportAuthorPageUsageResponse {
  accepted: true;
}
```

`GET_SCHEDULER_STATUS` 扩展为按通道返回状态（调试用）：

```ts
interface SchedulerStatusResponse {
  schedulerBatchSize: number;
  channels: Array<{
    name: 'author-video' | 'group-fav' | 'like-action';
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

Burst 监控字段（调试页必须展示）：

```ts
interface SchedulerStatusResponse {
  // 兼容现有 author 顶层状态，补充 burst 明细
  burst: {
    running: boolean;
    queueLength: number;
    currentTask: {
      // 可选：若任务来源可提供作者名则展示
      name?: string;
      mid: number;
      pn: number;
      reason: 'first-page-refresh' | 'prefetch-next-page' | 'load-more-boundary';
      // 显示口径以分组名为主；作者名缺失时允许回退 MID。
      groupNames: string[];
    } | null;
    // 下一次允许执行的时间戳（用于观测无条件冷却）
    nextAllowedAt: number;
    // 冷却原因：正常节流或错误退避
    cooldownReason: 'intra-delay' | 'error' | null;
    lastRunAt?: number;
    queue: Array<{
      name?: string;
      mid: number;
      pn: number;
      reason: 'first-page-refresh' | 'prefetch-next-page' | 'load-more-boundary';
      groupNames: string[];
    }>;
  };
  history: Array<{
    // 通道标识：作者通道或收藏夹通道
    channel: 'author-video' | 'group-fav' | 'like-action';
    // 作者任务为 mid，收藏夹任务为 groupId，点赞任务为 bvid/aid
    mid?: number;
    groupId?: string;
    bvid?: string;
    aid?: number;
    pn?: number;
    name: string;
    success: boolean;
    timestamp: number;
    error?: string;
    // 新增：区分常规与 Burst 执行来源
    mode: 'regular' | 'burst';
    // 任务语义（执行的是什么任务）
    taskReason:
      | 'first-page-refresh'
      | 'prefetch-next-page'
      | 'load-more-boundary'
      | 'group-fav-refresh'
      | 'single-card-like'
      | 'single-card-unlike'
      | 'author-batch-like';
    // 触发来源（是谁触发了这次任务）
    trigger:
      | 'alarm-routine'
      | 'debug-run-now'
      | 'manual-refresh'
      | 'manual-click'
      | 'request-author-page'
      | 'group-created-auto-refresh'
      | 'get-group-feed-missing-fav-cache'
      | 'get-group-feed-missing-author-cache'
      | 'get-group-feed-boundary'
      | 'group-fav-chain';
  }>;
}
```

调试页显示要求：
1. 顶层作者面板标题改为“常规更新队列”，仅展示常规作者队列，不混入 Burst 队列。
2. 新增“Burst 状态”面板，显示 `running`、`currentTask(groupNames + name?)`、`queueLength`、`lastRunAt`、`nextAllowedAt`。
3. Burst 队列详情按执行顺序展示“分组名 + 作者名”；仅当作者名缺失时回退显示 `MID`。
4. 当 `cooldownReason === 'error'` 且 `nextAllowedAt > now` 时，展示“错误冷却中（剩余 X 秒）”。
5. 调度历史增加 `mode` 列，显示 `regular` / `burst`。
6. 调度历史增加 `Reason` 列，显示 `trigger`（触发来源）并附带关键参数（如 `mid` / `pn` / `groupId`）；必要时可附带 `taskReason` 作为补充说明。
7. “常规更新队列 / Burst 状态 / 收藏夹通道状态 / 点赞通道状态”统一使用弹性布局容器：
   - 容器采用 `display: flex; flex-wrap: wrap;`
   - 子面板采用弹性宽度并自动换行，尽量填满一行剩余空间；
   - 在窄宽度下自动折到下一行，避免每个面板固定独占一整行。
8. 调度历史需持久化到本地存储，避免 Service Worker 被回收或切换面板后历史记录丢失。

## 5. 文件变更清单

### 5.1 新增

- `src/background/scheduler/core.ts`：通用调度器内核。
- `src/background/scheduler/channels/author-video.ts`：作者视频通道。
- `src/background/scheduler/channels/group-fav.ts`：收藏夹缓存通道。
- `src/background/scheduler/channels/like-action.ts`：点赞动作通道。

### 5.2 修改

- `src/background/scheduler.ts`：改为通道装配与对外门面。
- `src/background/index.ts`：
  - `MANUAL_REFRESH` 改为触发“收藏夹刷新 → 作者视频刷新”链路。
  - `GET_GROUP_FEED` 无缓存时触发 `group-fav` 优先任务。
- `src/background/index.ts`：
  - 新增 `RUN_SCHEDULER_NOW` 消息路由。
  - 点赞消息路由改为提交 `like-action` 通道，并在单次写请求执行前使用 `pageOrigin + pageReferer` 临时安装 DNR session rule；请求结束后立即清理。
- `src/background/feed-service.ts`：补充分组收藏夹刷新原子函数（仅供调度器调用）。
- `src/shared/types.ts`：`ExtensionSettings` 新增 `groupFavRefreshIntervalMinutes`、`schedulerBatchSize`。
- `src/shared/constants.ts`：两个后台刷新间隔默认值均调整为 `10`。
- `src/shared/components/SettingsPanel.vue`：
  - 新增 `groupFavRefreshIntervalMinutes` 设置项。
  - 新增 `schedulerBatchSize` 设置项（全调度器共享）。
  - 分组行新增“立即刷新”按钮。
- `src/shared/messages.ts`：
  - 新增 `RUN_SCHEDULER_NOW` 消息类型与响应，调试状态返回 `schedulerBatchSize`。
  - `LIKE_VIDEO`、`BATCH_LIKE_VIDEOS` 消息新增 `pageOrigin`、`pageReferer`，用于点赞请求的 DNR 规则安装。
- `src/content/components/DebugPanel.vue`：新增“立刻发起调度”按钮并展示重置后的下次触发时间。
- `src/content/components/DrawerApp.vue`：作者标题新增“一键点赞”入口，并为所有 VideoCard 注入可点击的点赞/取消点赞交互与本地 pending 状态。
- `src/content/components/VideoCard.vue`：新增始终显示的拇指按钮、loading/disabled 态与点赞切换事件。

## 6. 与主 Spec 的关系

`grouped-feed-extension-spec.md` 仅保留刷新行为的产品级描述；具体调度执行模型以本文档为准。
