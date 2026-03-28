# 调度器请求批次与排序修正规格

> 状态说明：
> 本文是基于当前实现整理出的“下一步修正规则”文档。
> 当前实现现状请先参考 `docs/scheduler-current-implementation.md`。

## 1. 背景

当前调度器的优先级主要依赖“头插 / 尾插”：

- 用户触发的优先任务会整批插到队首；
- 常规调度与 Burst 默认追加到队尾；
- 队列内部没有“旧请求优先”或“同一请求内部稳定排序”的统一规则。

这会导致一个明确问题：

1. 某分组有 11 个作者，`schedulerBatchSize = 10`。
2. 第一次“刷新投稿列表”后，前 10 个作者已刷新，只剩最后一个作者 A 还排在作者常规队列中。
3. A 被真正发出前，用户再次触发“刷新投稿列表”。
4. 第二次 `group-fav` 成功后，另外 10 个作者会再次作为优先作者任务插入队首，A 被继续挤到后面。

如果这种时序反复出现，A 甚至可能长期饥饿。

这个问题的本质不是“作者谁更旧”而已，而是：

- 旧请求不应被新请求插队；
- 同一次请求生成的一批任务，应该共享同一个“请求批次”语义；
- 在同一请求批次内部，再根据缓存新旧程度决定先后顺序。

## 2. 目标

本方案的目标是：

1. 保留当前大类优先级语义
   - Burst 仍高于作者常规与分组收藏夹常规执行；
   - 用户手动触发仍高于后台例行刷新；
   - 不把所有通道粗暴合并成一个全局大队列。

2. 引入“逻辑请求批次”概念
   - 同一次用户动作、同一次 `GET_GROUP_FEED` 缺失补齐、同一次 alarm 收集出来的一批作者任务，应共享同一批次元数据。

3. 在同层优先级内保证“旧请求优先”
   - 先来的逻辑请求，不应被后来的同层请求整体插队。

4. 在同一请求批次内部尽量先刷新更旧的数据
   - 同一批次中，缓存更旧的作者应排在前面。

5. 保证顺序稳定
   - 当多个任务在所有业务排序键上都相同时，仍要有确定顺序，避免队列抖动。

## 3. 非目标

本方案当前不是为了解决下面这些问题：

1. 不改 `like-action` 队列
   - 点赞动作仍保持独立串行队列；
   - 不纳入本次请求批次排序方案。

2. 不改现有 API 限速节奏
   - 不修改 `schedulerBatchSize`、`INTRA_DELAY_MS`、`currentBatchDelay`、Burst `60s` 重试冷却等规则。

3. 不改现有作者任务去重键
   - 仍以 `(mid, pn, ps)` 作为同一作者任务的去重目标。

4. 不在本轮方案里把所有通道收敛成统一调度器抽象
   - 当前仍按现有 `author-video`、`group-fav`、`burst` 三套作者相关队列分别落地。

## 4. 适用范围

本方案只覆盖“会影响作者刷新顺序”的任务：

1. `author-video` 常规队列
2. `burst` 队列
3. `group-fav` 队列
   - 不是为了改变分组收藏夹刷新本身的业务语义；
   - 而是为了让它衍生出的作者任务能正确继承请求批次。

不覆盖：

1. `like-action`
2. 历史记录持久化格式
3. 前台消息协议的返回体

## 5. 术语

### 5.1 逻辑请求

指一次明确的“调度意图来源”，例如：

- 用户点击一次“刷新投稿列表”
- 用户点击一次“刷新收藏夹”
- 一次 `GET_GROUP_FEED` 读取发现缺失作者缓存
- 一次 `REQUEST_AUTHOR_PAGE`
- 一次作者 alarm 收集
- 一次分组收藏夹 alarm 收集
- 一次调试页 `RUN_SCHEDULER_NOW`

### 5.2 请求批次

一次逻辑请求可能生成多个任务，这些任务共享一个请求批次：

- 同一个 `requestBatchId`
- 同一个 `requestAt`
- 同一来源 `trigger`

### 5.3 任务优先级层

用于表达“这一类任务应整体排在另一类任务之前”，它高于 `requestAt`。

## 6. 数据模型

### 6.1 新增通用元数据

对作者任务与分组收藏夹任务都补充以下排序元数据：

```ts
interface SchedulerOrderMeta {
  priorityClass: number;
  requestAt: number;
  requestBatchId: string;
  requestSeq: number;
  enqueueSeq: number;
}
```

字段含义：

1. `priorityClass`
   - 业务优先级层。
   - 数值越小，优先级越高。

2. `requestAt`
   - 逻辑请求发生时间。
   - 由“发起意图的那一刻”生成，不是“任务真正塞入队列的时刻”。

3. `requestBatchId`
   - 逻辑请求批次 ID。
   - 用于显式表达“这几条任务属于同一次请求”，避免仅靠毫秒时间戳分组带来的歧义。

4. `requestSeq`
   - 同一个请求批次内部的稳定序号。
   - 用于兜底同批次内完全同分数时的先后关系。

5. `enqueueSeq`
   - 全局单调递增序号。
   - 表示该任务对象真正被调度器接纳的先后顺序，作为最终兜底。

### 6.2 作者任务扩展

作者任务新增：

```ts
interface AuthorTaskOrderMeta extends SchedulerOrderMeta {
  staleAt: number;
}
```

其中：

```ts
staleAt = lastFirstPageFetchedAt || firstPageFetchedAt || lastFetchedAt || 0
```

含义：

- 数值越小，表示首页缓存越旧；
- `0` 表示“没有首页有效抓取时间”，应视为最旧。

说明：

- 对 `pn > 1` 的 Burst 补页任务，如果已有作者缓存，也统一使用该作者首页抓取时间；
- 本轮方案不再单独为“第 N 页块自己的 fetchedAt”设计排序键，先保持作者级口径统一。

### 6.3 分组收藏夹任务扩展

分组收藏夹任务新增：

```ts
interface GroupFavTaskOrderMeta extends SchedulerOrderMeta {
  staleAt: number;
}
```

其中：

```ts
staleAt = GroupFeedCache.updatedAt || 0
```

含义：

- 数值越小，表示该分组收藏夹缓存越旧。

### 6.4 批次上下文对象

为了让二段链路与衍生任务继承同一个请求批次，新增一个只在调度器内部流转的批次上下文：

```ts
interface SchedulerRequestContext {
  requestBatchId: string;
  requestAt: number;
  trigger: SchedulerTaskTrigger;
  priorityClass: number;
}
```

规则：

1. 入口先创建 `SchedulerRequestContext`
2. 同一次入口生成的全部任务共享同一个 `requestBatchId` 与 `requestAt`
3. 二段链路衍生任务必须继承父上下文，而不是重新生成时间

## 7. 优先级层定义

为避免“单纯按时间排序”冲掉现有业务语义，本方案先保留一层显式优先级分类。

建议优先级层如下：

| `priorityClass` | 任务类型 | 说明 |
| --- | --- | --- |
| `0` | Burst 队首交互任务 | 预留给 `enqueueBurstHeadAndWait(...)` 这类必须抢到 Burst 队首的任务 |
| `1` | Burst 交互任务 | 例如 `REQUEST_AUTHOR_PAGE`、作者级局部刷新 |
| `2` | Burst 自动任务 | 例如无缓存作者首刷、时间流边界补页 |
| `3` | 常规用户刷新链路 | 例如 `REFRESH_GROUP_POSTS` 衍生作者任务、`GET_GROUP_FEED` 缺首页缓存补齐 |
| `4` | 常规维护任务 | 例如 alarm 驱动的首页过期刷新、分组收藏夹过期刷新 |
| `5` | 低优先维护任务 | 例如 `extend-continuous-window` 预取、调试页补齐 |

说明：

1. `priorityClass` 只表达大类先后，不替代具体去重与业务开关。
2. `group-fav` 与作者任务不要求共享同一个数值空间来做“全局总序”，但建议按同一套语义定义，方便继承与调试展示。
3. 未来如果确认“时间流边界补页必须高于一般无缓存首刷”，可继续细分 `priorityClass=1/2`，但当前先不扩层。

## 8. 排序规则

### 8.1 基本原则

排序使用复合键，而不是单一时间戳：

```txt
priorityClass
-> requestAt
-> staleAt
-> requestSeq
-> enqueueSeq
```

全部按升序比较。

含义：

1. 先保留大类优先级
2. 同一层里旧请求优先
3. 同一请求里旧缓存优先
4. 同条件下保持稳定

### 8.2 作者常规队列排序

作者常规队列在每次真正“接纳新任务”后，应对 `authorState.queue` 做一次稳定重排。

排序键：

```txt
priorityClass
-> requestAt
-> staleAt
-> requestSeq
-> enqueueSeq
```

预期结果：

1. 第一次手动刷新遗留的作者 A，`requestAt` 更旧，会继续排在第二次手动刷新派生出的 10 个作者前面。
2. 同一次手动刷新里，缓存更旧的作者先刷。
3. alarm 维护任务无法压过用户主动刷新链路。

### 8.3 Burst 队列排序

Burst 队列也使用同一套复合排序，但保留两个额外约束：

1. 当前正在执行的 `currentTask` 不参与重排。
2. 若某入口明确要求“队首插入语义”，仍通过更高 `priorityClass` 或专门的头插入口实现，不用 `requestAt` 去模拟。

这意味着：

- `REQUEST_AUTHOR_PAGE` 等交互型 Burst 可以稳定排在自动 Burst 前面；
- 但不会破坏 Burst 当前“先完成当前项，再切换高优先级下一项”的执行模型。

### 8.4 分组收藏夹队列排序

`group-fav` 队列也应使用同一套排序键：

```txt
priorityClass
-> requestAt
-> staleAt
-> requestSeq
-> enqueueSeq
```

目的不是把它和作者队列强耦合，而是：

1. 用户较早发起的分组刷新，不应被后来相同层级的分组刷新压过去；
2. `group-fav` 成功后派生的作者任务，能继承一套连续的请求批次语义。

## 9. 各入口如何生成请求批次

### 9.1 `REFRESH_GROUP_POSTS`

规则：

1. 在收到前台消息时立即生成一个 `SchedulerRequestContext`
2. `enqueuePriorityGroup(...)` 产生的 `group-fav` 任务携带该上下文
3. `group-fav` 成功后派生出的：
   - 无缓存作者 Burst 任务
   - 已有缓存作者常规优先任务
   都必须继承同一个 `requestBatchId` 与 `requestAt`

这样可保证：

- 第二次手动刷新派生的作者任务，永远不会因为“更晚才生成”而伪装成旧请求。

### 9.2 `REFRESH_GROUP_FAV`

规则：

1. 生成 `SchedulerRequestContext`
2. 仅 `group-fav` 任务携带该上下文
3. 因为 `authorRefreshMode='none'`，不会继续生成作者任务

### 9.3 `GET_GROUP_FEED` 缺失作者补齐

规则：

1. 一次 `GET_GROUP_FEED` 调用内，缺失作者任务共享一个 `SchedulerRequestContext`
2. 无缓存作者进入 Burst 时继承该上下文
3. 已有缓存壳但缺首页时间的作者进入常规队列时也继承该上下文

这样可保证：

- 同一次读取触发的补齐是一批逻辑请求，不会在队列里拆成互不相关的零散任务。

### 9.4 `REQUEST_AUTHOR_PAGE`

规则：

1. 每次前台显式翻页请求都创建一个新的 `SchedulerRequestContext`
2. 若目标页已确认无更多页，则不创建上下文
3. 进入 Burst 的分页任务携带 `priorityClass=1`

说明：

- 即使同一作者连续点两次不同页，也视为两次独立请求批次；
- 不应复用上一次 `requestAt`。

### 9.5 时间流边界补页

规则：

1. 一次 `GET_GROUP_FEED` 构造过程中收集到的全部 `boundaryTasks` 共享一个 `SchedulerRequestContext`
2. 这些任务进入 Burst 时使用自动 Burst 的优先级层

### 9.6 alarm 常规收集

规则：

1. 每次作者 alarm 收集生成一个上下文
2. 这次收集得到的：
   - 首页过期刷新
   - 连续窗口预取
   共享同一 `requestBatchId`
3. 但两类任务仍用不同 `priorityClass`

这意味着：

- 它们属于同一次例行维护；
- 但首页过期刷新仍应先于低优先预取。

### 9.7 `RUN_SCHEDULER_NOW`

规则：

1. 每次调试页点击都生成新的上下文
2. “补齐到 batch size”的任务共享同一批次
3. 优先级应低于真正的用户主动刷新，高于普通预取是否需要提升由实现时再确认

当前建议：

- 先按 `priorityClass=5` 处理，避免调试按钮影响生产用户语义。

## 10. 去重与元数据合并规则

现有去重键 `(mid, pn, ps)` 不变，但元数据合并规则需要更新。

### 10.1 作者任务命中去重时

若新任务命中已有作者任务，应：

1. 继续保留当前“能力升级”逻辑
   - 例如 `forceRefreshCurrentPage`
   - `ensureContinuousFromHead`
   - `failFast`

2. 新增排序元数据升级规则：
   - `priorityClass` 取更高优先级（更小的值）
   - `requestAt` 取更旧的值
   - `requestBatchId` 跟随“最终保留下来的更旧 / 更高优先级语义”
   - `requestSeq` 取更靠前的值

这样可以保证：

- 已存在的任务不会因为去重而丢失“旧请求优先”的语义。

### 10.2 分组收藏夹任务命中去重时

除现有 `authorRefreshMode` 升级规则外，再补充：

1. `priorityClass` 取更高优先级
2. `requestAt` 取更旧值
3. `requestBatchId` / `requestSeq` 跟随被保留的旧请求语义

## 11. 落地建议

### 11.1 第一阶段

先只改：

1. `group-fav` 任务元数据
2. 作者常规任务元数据
3. Burst 任务元数据
4. 三个队列的入队后稳定排序

先不改：

1. `like-action`
2. 调试状态结构
3. 历史记录结构

这样改动面最小，但已经能修掉“手动全量刷新导致尾部作者被挤压”的核心问题。

### 11.2 第二阶段

再视需要补：

1. 调试状态中暴露排序元数据
2. 历史记录中记录 `requestBatchId`
3. 明确 `load-more-boundary` 是否要升级为真正 Burst 队首交互层

## 12. 预期效果

实现本方案后，应满足以下行为：

1. 同一层优先级中，旧请求永远不会被新请求整体插队。
2. 同一请求批次中，缓存更旧的作者优先刷新。
3. 手动刷新仍整体高于后台 alarm 维护。
4. Burst 仍整体高于作者常规与分组收藏夹常规执行。
5. 未来即使队列里积压数百个作者，也能维持“先满足旧请求，再追求更旧数据优先”的顺序。

## 13. 开放问题

以下问题需要在真正实现前再确认：

1. `REQUEST_AUTHOR_PAGE` 是否应继续只是 `priorityClass=1`，还是应该恢复成真正的 Burst 队首插入语义。
2. `load-more-boundary` 是否应高于“无缓存作者首刷”。
3. `RUN_SCHEDULER_NOW` 是否要保持最低维护优先级，还是在调试场景里提升到高于普通 alarm。
4. 调试状态是否需要把 `requestAt / requestBatchId / priorityClass` 直接暴露出来，方便验证顺序。
