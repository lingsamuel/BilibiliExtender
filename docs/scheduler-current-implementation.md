# 调度器当前实现总览

> 状态说明：
> 本文描述的是仓库当前代码实际行为，基于 `src/background/scheduler.ts` 与 `src/background/index.ts` 整理。
> 它不是未来目标设计文档，也不试图覆盖 `docs/scheduler-spec.md` 中尚未完全落地的抽象。

## 1. 调度器当前由哪些运行单元组成

当前实现不是一个完全拆分的“通用调度器内核 + 多通道模块”结构，而是集中在单文件中维护 5 个运行状态：

1. `authorState`
   - 作者常规队列。
   - 负责首页刷新、连续窗口预取、部分“缺首页缓存但已有缓存壳”的补齐任务。

2. `groupFavState`
   - 分组收藏夹队列。
   - 负责刷新分组作者列表，并在成功后继续衔接作者任务。

3. `likeActionState`
   - 点赞动作队列。
   - 负责单卡点赞/取消点赞、作者批量点赞。

4. `burstState`
   - 作者 Burst 专用队列。
   - 负责无缓存作者首刷、时间流边界补页、作者分页请求等高优先作者任务。

5. `globalCooldownState`
   - 全局 WBI 冷却门。
   - 仅在作者投稿接口命中 `WbiExpiredError` 后生效，阻塞作者类请求与分组收藏夹刷新请求。

## 2. 当前存在的任务类型

### 2.1 作者任务

作者任务在实现上统一复用同一个结构，常规作者队列与 Burst 队列都使用它：

```ts
interface SchedulerTask {
  mid: number;
  name: string;
  groupId?: string;
  pn?: number;
  ps?: number;
  reason?: SchedulerAuthorTaskReason;
  trigger?: SchedulerTaskTrigger;
  forceRefreshCurrentPage?: boolean;
  ensureContinuousFromHead?: boolean;
  failFast?: boolean;
}
```

当前实际使用到的 `reason`：

- `first-page-refresh`
- `extend-continuous-window`
- `load-more-boundary`
- `request-author-page`
- `refresh-author-current-page`

作者任务去重键：

```ts
key = `${mid}:${pn}:${ps}`
```

含义：

- 同一作者同一页码同一页大小视为同一个调度目标。
- `reason`、`trigger`、`groupId` 不参与去重。

### 2.2 分组收藏夹任务

```ts
interface GroupFavTask {
  groupId: string;
  trigger: SchedulerTaskTrigger;
  authorRefreshMode: 'stale' | 'force' | 'none';
}
```

当前语义：

- `none`
  - 只刷新分组收藏夹缓存，不继续衔接作者刷新。
- `stale`
  - 刷新分组收藏夹缓存后，只把“已有缓存且已过期”的作者送入作者常规队列。
- `force`
  - 刷新分组收藏夹缓存后，把该分组所有“已有缓存”的作者都送入作者常规优先队列；无缓存作者送入 Burst。

分组收藏夹任务去重键：

```ts
key = groupId
```

### 2.3 点赞动作任务

```ts
interface LikeActionTask {
  key: `like:${string}`;
  aid: number;
  bvid: string;
  authorMid: number;
  csrf: string;
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

点赞任务去重键：

```ts
key = `like:${bvid}`
```

含义：

- 同一个 `bvid` 在队列中只保留一个点赞动作。
- 若当前已有同一 `bvid` 的相反动作在执行或排队，会直接报错，不做覆盖。

## 3. 当前可触发调度的入口

下面按“外部入口”和“内部链路入口”拆开列出。

### 3.1 外部入口

| 入口 | 触发位置 | 实际动作 | 结果队列 |
| --- | --- | --- | --- |
| 新增分组 | `UPSERT_GROUP` 新建场景 | `enqueuePriorityGroup([groupId], 'group-created-auto-refresh')` | `group-fav` 优先队列 |
| 首次读取某分组且无收藏夹缓存 | `GET_GROUP_FEED` | `enqueuePriorityGroup([groupId], 'get-group-feed-missing-fav-cache')` | `group-fav` 优先队列 |
| 读取“全部”分组且部分分组无缓存 | `GET_GROUP_FEED` | `enqueuePriorityGroup(missingFavGroupIds, 'get-group-feed-missing-fav-cache')` | `group-fav` 优先队列 |
| 读取分组时发现作者缺首页缓存 | `GET_GROUP_FEED` | 无缓存作者走 `enqueueBurst(...)`；已有缓存壳但缺首页抓取时间的作者走 `enqueuePriority(...)` | `burst` / `author-video` |
| 时间流命中边界补页 | `GET_GROUP_FEED` | `enqueueBurst(...)`，`reason='load-more-boundary'` | `burst` 队列尾部 |
| 手动刷新投稿列表 | `REFRESH_GROUP_POSTS` | `enqueuePriorityGroup(..., 'manual-refresh-posts', 'force')` | `group-fav` 优先队列 |
| 手动刷新收藏夹 | `REFRESH_GROUP_FAV` | `enqueuePriorityGroup(..., 'manual-refresh-fav', 'none')` | `group-fav` 优先队列 |
| 手动请求作者分页 | `REQUEST_AUTHOR_PAGE` | `enqueueBurst(...)`，并注册一次前台等待会话 | `burst` 队列尾部 |
| 单卡点赞/取消点赞 | `LIKE_VIDEO` | `enqueueLikeActionAndWait(...)` | `like-action` 优先队列 |
| 作者批量点赞 | `BATCH_LIKE_VIDEOS` | `enqueueLikeBatch(...)` | `like-action` 优先队列 |
| 调试页“立刻发起调度” | `RUN_SCHEDULER_NOW` | 仅补齐到 batch size，不做全量入队 | `author-video` / `group-fav` |
| Service Worker 安装、设置保存 | `onInstalled` / `SAVE_SETTINGS` | `setupAlarm(...)` | 仅更新 alarm，不直接入队 |

### 3.2 内部链路入口

1. `group-fav` 成功后的二段衔接
   - `runGroupFavTask` 拉取最新收藏夹作者列表后：
   - 无缓存作者进入 `enqueueBurst(...)`
   - 已有缓存作者根据 `authorRefreshMode` 进入 `enqueuePriority(...)`

2. 周期 alarm
   - 作者 alarm 触发 `triggerAuthorRoutine(...)`
   - 分组收藏夹 alarm 触发 `triggerGroupFavRoutine(...)`

3. Burst 期间的 alarm 补偿
   - 若 alarm 触发时 Burst 正在活跃，不立即收集任务；
   - 仅记录 `pendingAuthorRoutineAfterBurst` / `pendingGroupFavRoutineAfterBurst`；
   - 等 Burst 清空后补跑一次常规任务收集。

## 4. 当前所有 trigger 类型

当前代码里实际声明的 `SchedulerTaskTrigger`：

- `alarm-routine`
- `debug-run-now`
- `manual-click`
- `manual-refresh-posts`
- `manual-refresh-fav`
- `group-created-auto-refresh`
- `get-group-feed-missing-fav-cache`
- `get-group-feed-missing-author-cache`
- `get-group-feed-boundary`
- `request-author-page`
- `group-fav-chain`

这些 `trigger` 当前主要用于：

- 调试状态展示
- 历史记录
- 辅助理解任务来源

它们当前不参与去重，也不直接参与队列排序。

## 5. 当前优先级规则

当前优先级由多层规则共同决定，不是单一排序器。

### 5.1 跨队列优先级

#### 5.1.1 Burst 高于作者常规队列和分组收藏夹队列

规则如下：

1. 只要 `burstState.queue.length > 0` 或 `burstState.running === true`，作者常规队列与分组收藏夹队列都不会启动新的执行循环。
2. 若作者常规队列或分组收藏夹队列已经在执行一个任务，Burst 不会强杀当前任务。
3. 当前任务执行完后，常规循环会在下一轮检查时退出，把控制权让给 Burst。

这意味着：

- Burst 会抢占“下一项”执行权；
- 但不会中断“当前项”。

#### 5.1.2 `like-action` 当前独立于 Burst

当前实现里，点赞通道：

- 不受 Burst 阻塞；
- 不读取 `globalCooldownState`；
- 不使用批次延迟；
- 只做串行执行 + 固定 `1000ms` 间隔。

因此，`like-action` 并不属于“被 Burst 暂停的常规通道”。

#### 5.1.3 全局冷却门当前只影响作者类请求与分组收藏夹请求

当前实现中：

- `runAuthorLoop` 在每次真正取任务前调用 `waitForGlobalCooldownIfNeeded()`
- `runGroupFavLoop` 也会调用同一个等待逻辑
- `runBurstLoop` 会同时受 `burstState.nextAllowedAt` 与 `globalCooldownState.nextAllowedAt` 约束
- `runLikeActionLoop` 不读全局冷却

所以全局冷却的当前实际影响范围是：

- `author-video`
- `group-fav`
- `burst`

不包括：

- `like-action`

### 5.2 同一队列内的入队优先级

当前实现没有统一的“排序器”。队列顺序主要由“插到头部还是尾部”决定。

#### 5.2.1 优先入队

以下 API 会把新任务插到队首：

- `enqueuePriority(...)`
- `enqueuePriorityGroup(...)`
- `enqueueLikeActionAndWait(...)`
- `enqueueLikeBatch(...)`
- `enqueueBurstHeadAndWait(...)` 的内部单任务入队

实现方式是：

```ts
state.queue.unshift(...newTasks)
```

性质：

- 同一次调用内，输入数组顺序会被保留；
- 但整批新任务会整体压到旧队列前面。

#### 5.2.2 常规入队

以下路径会把任务插到队尾：

- `enqueueBurst(...)`
- 常规 alarm 收集后的 `dedupeAndEnqueue(..., false)`
- 调试页补齐后的 `fillQueueToBatchSize(...)`

实现方式是：

```ts
state.queue.push(...newTasks)
```

### 5.3 当前去重范围

当前去重只看：

- `currentTask`
- `queue`

不看：

- `batchFailed`

影响：

- 若某个常规任务刚失败、已被移入 `batchFailed`，但还没在批末重新追加回主队列；
- 此时若同 key 任务再次入队，去重不会命中，可能再次进入主队列。

### 5.4 当前各入口的相对优先级

如果只看“谁更容易排到前面”，当前实际大致是下面这个顺序：

1. `enqueueBurstHeadAndWait(...)` 插入的 Burst 队首任务
   - 当前代码存在该能力，但仓库内还没有线上入口真正调用它。

2. Burst 队列中已经存在的任务
   - 包括无缓存首刷、时间流边界补页、`REQUEST_AUTHOR_PAGE`
   - 这些任务都走 `enqueueBurst(...)`，默认追加到 Burst 队尾

3. 作者常规优先任务
   - `enqueuePriority(...)`
   - 例如 `GET_GROUP_FEED` 发现“已有缓存壳但缺首页抓取时间”的作者
   - 例如 `group-fav` 成功后衔接出来的作者刷新任务

4. 分组收藏夹优先任务
   - `enqueuePriorityGroup(...)`
   - 例如手动刷新、缺分组缓存、新增分组自动刷新

5. alarm 常规任务
   - 作者首页过期刷新
   - 连续窗口预取
   - 分组收藏夹过期刷新

6. 调试页补齐任务
   - 仅在现有队列不足 batch size 时补齐
   - 不会挤掉现有排队项

需要注意：

- 第 3 条和第 4 条不共享同一个队列，因此不存在一个全局总序；
- 真正的执行先后仍受“Burst 是否活跃”“哪个通道当前已在运行”“全局冷却是否生效”共同影响。

## 6. 各通道的实际排序与收集规则

### 6.1 作者常规队列

作者常规队列当前没有按“请求时间”或“缓存更新时间”做统一重排。

它的顺序来源分三类：

1. 常规 alarm 收集
   - 无缓存作者：不进常规队列，进 Burst
   - 过期首页任务：按 `lastFirstPageFetchedAt || firstPageFetchedAt || lastFetchedAt` 升序收集
   - 连续窗口预取：按 `mid`、`pn` 升序收集
   - 最终以 `[staleTasks..., prefetchTasks...]` 的顺序整体追加到队尾

2. `GET_GROUP_FEED` 缺首页缓存
   - 仅把“已有缓存壳但缺首页抓取时间”的作者走 `enqueuePriority(...)`
   - 整批压到队首

3. `group-fav` 成功后的二段衔接
   - `authorRefreshMode='force'` 时：
     - 该分组所有已有缓存作者都会以优先任务形式重新压到队首
   - `authorRefreshMode='stale'` 时：
     - 只把已过期作者压到队首

这也是“重复手动全量刷新会把上一轮尾部作者继续往后挤”的根源：

- 队列内没有“旧请求优先”或“更旧作者优先”的统一重排；
- 只有“新来的优先任务整批压队首”。

### 6.2 Burst 队列

Burst 队列当前有两种入队方式：

1. `enqueueBurst(...)`
   - 默认追加到队尾
   - 当前线上入口都走这个路径

2. `enqueueBurstHeadAndWait(...)`
   - 会把任务插到队首
   - 当前仓库内存在实现，但没有被实际业务入口调用

当前线上会进入 Burst 的入口包括：

- 无缓存作者首刷
- 时间流命中边界补页
- `REQUEST_AUTHOR_PAGE`
- `group-fav` 成功后发现的新作者首刷

Burst 当前不会根据 `reason` 再做二次排序。

### 6.3 分组收藏夹队列

分组收藏夹队列顺序来源分三类：

1. 常规 alarm 收集
   - 按 `GroupFeedCache.updatedAt` 升序
   - 追加到队尾

2. 手动/缺缓存/新增分组
   - 统一走 `enqueuePriorityGroup(...)`
   - 整批压到队首

3. 调试页“立刻发起调度”
   - 先保留现有队列
   - 若未满 batch size，再按“最旧分组优先”补到队尾

此外，分组收藏夹队列存在“弱任务升级为强任务”的能力：

- 若同一 `groupId` 已在 `currentTask` 或 `queue` 中；
- 新任务带来更高的 `authorRefreshMode` 优先级；
- 则会直接提升已有任务的 `authorRefreshMode`

当前优先级为：

```txt
force > stale > none
```

### 6.4 点赞队列

点赞队列当前非常简单：

1. 所有入口都走优先入队
2. 只按 `bvid` 去重
3. 不做批次延迟
4. 不做失败重试
5. 每个任务执行后若队列仍非空，只等待固定 `1000ms`

## 7. 批次与失败处理的当前实际行为

### 7.1 作者常规队列与分组收藏夹队列

两者当前共享这一套行为：

1. 同一通道串行执行
2. 成功任务计入 `batchCompleted`
3. 失败任务先进入 `batchFailed`
4. 若 `batchCompleted >= schedulerBatchSize`
   - 把 `batchFailed` 追加回主队列尾部
   - 清空 `batchFailed`
   - 重置 `batchCompleted`
   - 若队列非空，等待 `currentBatchDelay`
5. 若未满 batch 且队列非空
   - 等待固定 `1000ms`
6. 循环结束时
   - 再把剩余 `batchFailed` 统一追加到队尾

### 7.2 Burst 队列

Burst 的失败语义与常规队列不同：

1. 成功
   - 任务从队首移除
   - `nextAllowedAt = now + 1000ms`

2. 失败且 `failFast === false`
   - 任务保留在队首
   - `nextAllowedAt = now + 60s`
   - 冷却后优先重试同一任务

3. 失败且 `failFast === true`
   - 任务从队首移除
   - 以失败终态通知等待方
   - `nextAllowedAt = now + 1000ms`

### 7.3 点赞队列

点赞队列当前失败后不会重试：

1. 失败任务会暂时计入 `batchFailed`
2. 但循环结束后只是清空统计状态
3. 失败任务不会重新回到主队列

## 8. 当前实现与 `docs/scheduler-spec.md` 的关键差异

为了避免后续讨论时把“现状”和“目标设计”混为一谈，这里列出几条最重要的差异。

### 8.1 代码结构仍集中在单文件

当前真实实现仍主要位于：

- `src/background/scheduler.ts`

而不是 `scheduler-spec` 中描述的拆分式目录结构。

### 8.2 `load-more-boundary` 还没有走 Burst 队首插入

`scheduler-spec` 把“加载更多命中边界”定义成必须插入 Burst 队首。

当前实现中：

- `GET_GROUP_FEED` 命中边界后调用的是 `enqueueBurst(...)`
- 这会把任务追加到 Burst 队尾

因此，当前“时间流边界补页”并不具备最高级 Burst 抢占。

### 8.3 `REQUEST_AUTHOR_PAGE` 当前也只是追加到 Burst 队尾

当前实现中：

- `REQUEST_AUTHOR_PAGE` 会建立等待会话
- 但实际入队仍然走 `enqueueBurst(...)`

所以它不会自动插到已有 Burst 任务前面。

### 8.4 `like-action` 当前不受 Burst 阻塞，也不受全局冷却限制

`scheduler-spec` 把多个通道描述成统一调度体系的一部分。

但当前实现里：

- 点赞通道不读取全局冷却
- 点赞通道不因 Burst 活跃而暂停
- 点赞通道也没有批次延迟与失败重试

它更接近“独立串行交互队列”。

### 8.5 旧的 `reportAuthorPageUsage(...)` 已退化为空实现

当前实现中：

- `reportAuthorPageUsage(...)` 仍保留导出
- 但函数体已经为空

连续窗口维护已改为直接基于连续缓存长度判断，而不再依赖页级使用回报。

## 9. 当前已知的优先级风险点

当前实现下，以下风险是结构性存在的：

1. 重复的“手动刷新投稿列表”可能让旧请求尾部作者持续后移
   - 原因是 `group-fav` 成功后会再次把作者优先任务整批 `unshift` 到作者常规队列队首
   - 队列内部没有“请求时间更旧优先”的统一排序

2. Burst 内部当前也没有按请求时间再排序
   - 线上入口都走 Burst 队尾追加
   - 先来的 Burst 会先执行，但不会因为 `reason` 自动提升

3. 常规队列去重不覆盖 `batchFailed`
   - 同 key 失败任务在批次收尾前，理论上可能再次被入队

这些风险并不表示当前实现一定错误，但说明它的优先级主要依赖“头插/尾插”而不是一个稳定的全局排序规则。
