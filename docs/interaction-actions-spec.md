# 交互动作与错误提示 Spec

## 1. 背景

当前版本已经具备基础的关注与点赞链路，但点赞交互仍存在三个缺口：
- VideoCard 只能在“本地已知点赞成功”时显示角标，未点赞时没有统一入口，且不能直接在卡片上切换点赞/取消点赞。
- 作者“一键点赞”仍使用独立串行队列，尚未并入通道化调度器。
- 点赞请求尚未补齐与关注同级的 DNR 头改写策略，在多标签页场景下也缺少按标签页精确命中的约束。

本 Spec 定义以下能力：
- 错误展示统一为通知弹框（toast），不再用错误文本覆盖主内容区。
- 修复关注 API 请求结构。
- 新增/完善视频点赞、投币 API。
- 在作者区域保留“一键点赞”能力，并将点赞任务并入通道化调度器。
- 在所有 VideoCard 封面左下角展示可点击的点赞拇指按钮，支持点赞/取消点赞。

## 2. 范围与非目标

### 2.1 范围
- Content UI：错误提示、作者区域操作按钮、VideoCard 点赞按钮/角标。
- Background：关注/点赞/投币消息处理、点赞调度执行与点赞写请求 DNR 规则安装。
- Shared API/消息协议：新增/扩展点赞与投币相关接口。

### 2.2 非目标
- 不新增桌面系统通知。
- 不做“一键三连”能力。
- 不做历史全量点赞状态回溯。
- 本轮不改造投币链路的 DNR 接入，仅处理点赞请求。

## 3. 功能需求

### 3.1 错误展示统一为通知弹框

1. 所有前台操作错误（包括加载失败、刷新失败、关注失败、点赞失败、投币失败、已阅相关失败）统一通过 toast 展示。
2. 失败时不允许将主列表区域替换为错误详情文本。
3. 若当前已有可展示缓存内容，报错后继续保留现有内容，仅弹出 toast。
4. 若首次加载且暂无内容，仍使用原有空态/加载态，不显示“整页报错替换态”。
5. toast 支持自动消失，短时间内多条错误按队列展示。

### 3.2 关注 API 修复（`x/relation/modify`）

请求仍使用 `POST /x/relation/modify`，Cookie 登录态鉴权，`application/x-www-form-urlencoded`。

必填参数：
- `fid`
- `act`（1 关注，2 取关）
- `re_src`（保持 11）
- `csrf`
- `extend_content`（本次修复关键）
- `gaia_source=web_main`
- `spmid=333.1387`
- `is_from_frontend_component=true`
- URL Query：`statistics={"appId":100,"platform":5}`
- URL Query：`x-bili-device-req-json={"platform":"web","device":"pc","spmid":"333.1387"}`

`extend_content` 规则：
- JSON 字符串：`{"entity":"user","entity_id":<fid>}`
- 提交时作为 form 字段发送（URL 编码由 `URLSearchParams` 处理）。

说明：
- `extend_content` 仍作为 form 字段提交，继续交给 `URLSearchParams` 做 URL 编码；不要求保留抓包里“冒号未编码”的字面形态。
- 当前阶段暂不使用页面桥接脚本，恢复为 background 发起关注请求。
- 关注请求在发起前，由 DNR session rule 精确改写 `Origin`、`Referer`、`Sec-Fetch-Site`，其中 `Origin` 与 `Referer` 取自用户当前页面，`Sec-Fetch-Site` 固定为 `same-site`。
- 该结论上升为项目约束：对 Bilibili 的 `POST` 写操作，默认应先接入 DNR 头改写；关注接口只是首个验证通过的落地点，不视为特例。

### 3.3 新增视频点赞/投币 API

#### 3.3.1 点赞 API
- 端点：`POST /x/web-interface/archive/like`
- 入参：`aid|bvid`（二选一）、`like`（1 点赞 / 2 取消赞）、`csrf`
- 请求策略：
  - 默认按“POST 写操作”处理，接入与关注同类的 DNR 头改写能力。
  - Content script 发送消息时同时携带当前页面的 `pageOrigin`、`pageReferer`。
  - Background 结合消息 `sender.tab.id` 安装 session-scoped DNR 规则，精确限定 `tabIds + archive/like + POST + xmlhttprequest`。
  - DNR 规则至少改写 `Origin`、`Referer`、`Sec-Fetch-Site`，其中 `Referer` 去掉 hash，`Sec-Fetch-Site` 固定为 `same-site`。
  - 单卡点赞与作者批量点赞共享同一套 DNR 安装逻辑。

#### 3.3.2 投币 API
- 端点：`POST /x/web-interface/coin/add`
- 入参：`aid|bvid`（二选一）、`multiply`（1/2）、`select_like`（0/1）、`csrf`
- 请求策略：保留现状；本轮不扩展投币请求的 DNR 处理。

### 3.4 作者区域“一键点赞”按钮

1. 在“未观看（byAuthor）”作者标题左侧操作组中，紧邻关注按钮新增“一键点赞”按钮。
2. 点击后对该作者“当前界面实际展示出来”的视频逐条点赞：
   - 仅覆盖当前筛选结果与当前分页可见视频；
   - 不隐式拉取未展示页。
3. 执行策略：
   - 任务先入 `like-action` 通道；
   - 调度器按通道串行执行，避免瞬时并发导致风控；
   - 单条失败不中断后续任务；
   - 结束后 toast 汇总成功/失败数量。
4. 运行中按钮显示 loading 并禁用，避免重复触发同一作者批次。

### 3.5 VideoCard 点赞按钮与状态角标

1. 所有 VideoCard 在封面左下角都显示一个可点击的小拇指按钮，时间流与按作者视图统一生效。
2. 未点赞：
   - 显示白色描边、无填充的拇指按钮；
   - hover 时允许轻微高亮，但不改成粉色实心。
3. 已点赞：
   - 显示粉色填充的拇指按钮；
   - 再次点击执行取消点赞。
4. 运行中：
   - 当前卡片按钮进入 loading/disabled 状态；
   - 前台不再接受同一 `bvid` 的重复点击，避免同卡片并发切换状态。
5. 状态来源优先级：
   - 本地最近一次成功写操作回写状态（最高优先，可为 `liked=true/false`）；
   - 默认未点赞。

## 4. 消息协议变更

新增消息类型（命名可按现有风格调整）：
- `LIKE_VIDEO`
- `COIN_VIDEO`
- `ENQUEUE_AUTHOR_VISIBLE_LIKES`
- `GET_LIKE_SCHEDULER_STATUS`（调试可选）

消息负载调整：
- `LIKE_VIDEO`：新增 `pageOrigin`、`pageReferer`，用于安装 tab-scoped DNR 规则。
- `BATCH_LIKE_VIDEOS`：新增 `pageOrigin`、`pageReferer`，用于作者批量点赞安装 tab-scoped DNR 规则。

返回约定：
- 与现有消息一致，统一 `{ ok, data?, error? }`。
- 错误信息需可直接用于 toast 展示。

## 5. 点赞调度器设计

新增 `like-action` 通道（可集成到现有 `scheduler.ts`，不强制拆新文件）：

任务结构示例：

```ts
interface LikeTask {
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

执行约束：
1. 队列去重键：`bvid`。
2. 单卡点赞/取消点赞与作者批量点赞统一走 `like-action` 通道。
3. 串行执行；任务间固定间隔（默认 1000ms）。
4. 单任务执行前需先安装 tab-scoped DNR 规则，再调用点赞 API：
   - `action='like'` => `like=1`
   - `action='unlike'` => `like=2`
5. 单任务失败记录错误并继续下一条。
6. 单卡点击可同步等待该任务完成后回写 UI；作者批量点赞在批次结束后返回汇总（成功数、失败数、失败明细）。
7. 不影响现有 `author-video` / `group-fav` 刷新通道。

## 6. 数据结构建议

```ts
interface VideoInteractionState {
  liked: boolean; // 本地最近一次成功写操作口径
  pending?: boolean;
  likedAt?: number;
}

type VideoInteractionStateMap = Record<string, VideoInteractionState>; // key: bvid
```

说明：
- 该状态用于 UI 呈现与短期交互反馈，不参与 unread 计算。
- 可按需持久化；若不持久化，至少在抽屉会话内保持一致。

## 7. 交互流程

### 7.1 关注操作
1. 用户点击关注/取关。
2. 前端乐观更新按钮状态。
3. 后台请求 `x/relation/modify`（含 `extend_content`）。
4. 成功：按返回与 Card 同步回写。
5. 失败：回滚乐观状态并 toast 报错。

### 7.2 作者一键点赞
1. 用户点击作者“一键点赞”。
2. 收集该作者当前可见视频列表并入队。
3. 调度器通过 `like-action` 通道串行点赞。
4. 每条成功即回写该视频 `liked=true`。
5. 批次结束 toast 汇总结果。

### 7.3 VideoCard 单卡点赞/取消点赞
1. 用户点击某张 VideoCard 左下角拇指按钮。
2. 前端根据当前本地状态决定目标动作：未点赞则提交 `like`，已点赞则提交 `unlike`。
3. 消息携带 `pageOrigin`、`pageReferer`；background 使用 `sender.tab.id` 安装仅命中当前标签页的 DNR session rule。
4. 调度器将该任务作为 `like-action` 优先任务串行执行。
5. 成功后本地回写该视频 `liked=true/false`；失败则保留旧状态并 toast 提示。

## 8. 错误与降级

1. 任何接口失败均使用 toast 提示，不替换主内容区域。
2. 关注失败：回滚按钮状态。
3. 点赞批次部分失败：成功项保留，失败项记录并汇总提示。
4. 点赞态未命中本地状态时：不阻断页面渲染，按钮按“未点赞空心态”展示。
5. 当前浏览器若不支持 `declarativeNetRequest.updateSessionRules`：点赞操作直接报错并 toast，不降级为无 DNR 写请求。

## 9. 验收标准

1. “关注 API 失败”不再导致主视图被错误文本覆盖，而是 toast 提示。
2. 关注/取关请求中包含 `extend_content`，且流程可正常完成。
3. 存在可调用的视频点赞与投币消息/API。
4. 每位作者标题行显示“一键点赞”按钮，点击后可对当前可见视频批量点赞。
5. 一键点赞采用 `like-action` 通道串行调度，不会并发轰炸接口。
6. 所有 VideoCard 封面左下角都显示可点击拇指按钮：未点赞为空心白色描边，已点赞为粉色实心。
7. 单卡点击可执行点赞与取消点赞，成功后即时回写 UI。
8. 点赞请求会安装仅命中当前标签页的 DNR session rule，避免多标签页串用来源头。
