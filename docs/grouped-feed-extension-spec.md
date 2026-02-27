# 分组动态扩展 Spec（Chrome/Edge + Bilibili）

## 1. 背景与目标

### 1.1 背景
Bilibili 现有关注/动态入口信息密集，无法按用户自定义主题分组查看投稿更新。

### 1.2 目标
实现一个 Chrome/Edge 扩展，在用户登录态下请求 Bilibili 接口，允许用户将“自己的收藏夹”定义为分组，并在站点 Header 注入“分组动态”入口，按分组展示收藏夹内作者的投稿视频更新。

### 1.3 非目标
- 不实现桌面通知。
- 不实现跨设备强一致同步（仅依赖浏览器 `storage.sync` 能力，受配额限制）。
- 不支持手动输入收藏夹 ID（首版必须从“我的收藏夹列表”选择）。

## 2. 术语
- 分组：由一个“我的收藏夹”映射而来（1:1）。
- 混合模式：分组内所有作者投稿混排，按发布时间倒序。
- 作者模式：按作者分段展示，每位作者展示限定数量投稿。
- 已阅时间点：用户在分组内选择的“已阅时间点”（可为具体时间、默认已阅天数或“全部”）。

## 3. 用户故事
1. 作为登录用户，我可以从“我的收藏夹列表”里选择若干收藏夹，创建分组并设置分组别名。
2. 作为用户，我在 `www.bilibili.com` 与 `space.bilibili.com` 顶部 Header 都能看到“分组动态”入口。
3. 作为用户，我点击入口后看到右侧抽屉面板，并能在左侧分组栏切换不同分组。
4. 作为用户，我可以切换“混合模式/作者模式”查看投稿。
5. 作为用户，我可以手动刷新；若距离上次刷新超过阈值（默认 10 分钟），系统自动刷新。
6. 作为用户，我在未查看某分组且出现新投稿时，该入口与对应分组显示红点；红点始终基于已阅时间点计算，不因打开分组自动清除。
7. 作为用户，我在“按作者”模式可勾选“按更新时间倒序”，并记住该分组上次选择状态。

## 4. 功能需求

### 4.1 分组管理
- 数据来源：仅“我创建的收藏夹”。
- 创建分组：从收藏夹下拉/列表选择一个收藏夹后创建。
- 约束：一个收藏夹最多绑定一个分组（1:1）。
- 分组字段：
  - `groupId`（扩展内部 ID）
  - `mediaId`（收藏夹 ID）
  - `mediaTitle`（收藏夹原名）
  - `alias`（可选别名）
  - `enabled`（启用状态）
  - `createdAt` / `updatedAt`
- 支持编辑：别名、启用状态。
- 支持删除分组。

### 4.2 入口注入与面板
- 注入页面：
  - `https://www.bilibili.com/*`
  - `https://space.bilibili.com/*`
- 注入位置：站点顶部 Header 区域，新增“分组动态”入口（视觉风格贴近站点现有导航）。
- 点击行为：打开右侧抽屉面板（内容脚本挂载 Vue 应用）。
- 面板结构：
  - 左侧：分组列表（支持红点）
  - 右侧：当前分组内容区 + 视图模式切换 + 刷新按钮 + 刷新状态（上次刷新时间 / 正在更新中）

#### 4.2.1 Header 入口红点/数字展示

- Header 入口支持两种状态：
  - 红点状态：`unreadCount > 0` 时显示。
  - 数字状态：显示全局 `unreadCount`，`>99` 时显示 `99+`。
- 红点/数字元素复用站点样式类 `red-num--message`，避免自定义视觉与站点风格偏差。
- `unreadCount = 0` 时数字文本为空（隐藏数字），不通过 `display` 切换元素显隐。
- 红点/数字挂载的父节点必须显式设置 `position: relative`，保证绝对定位稳定，不受站点布局变更影响。

#### 4.2.2 抽屉导航状态模型

抽屉侧栏统一使用“导航条目 ID（`activeEntryId`）”驱动，不再使用独立的 `showSettings` / `showDebug` 布尔开关。

- 真实分组条目：使用分组自身 `groupId`。
- 虚拟条目（仅用于页面切换）：
  - 设置页：`__bbe_settings__`
  - 调试页：`__bbe_debug__`

交互规则：
- 点击“设置”后，`activeEntryId = __bbe_settings__`，显示设置页。
- 点击“调试”后，`activeEntryId = __bbe_debug__`，显示调试页。
- 再次点击“设置”或“调试”时，不自动切回分组页（无 toggle 返回行为）。
- 点击任一真实分组后，`activeEntryId = groupId`，显示对应分组内容。

实现约束：
- 仅当 `activeEntryId` 为真实分组 ID 时，才允许触发分组相关请求（如 `GET_GROUP_FEED`、`MARK_GROUP_READ`、手动刷新）。
- 虚拟条目不参与分组缓存、未读统计与分组持久化字段（如 `lastGroupId`）。

### 4.3 投稿聚合规则
- 输入：分组绑定收藏夹中的视频集合。
- 作者提取：从收藏夹视频中提取作者 `mid` 去重。
- 投稿拉取：按作者获取投稿视频列表（仅用于视频列表数据）。
- 作者信息拉取：统一使用 `x/web-interface/card` 获取作者信息（`name`、`face`、`follower`、`following`）。
- 去重：按视频 `bvid` 去重。
- 排序：按投稿发布时间（`pubdate`）倒序。

#### 4.3.1 作者信息来源约束
- 作者名称、头像、粉丝数、关注状态的展示与业务判断，均以 Card API 返回结果为准。
- 仅在“该作者没有任何已缓存 Card 信息”且本轮 Card 请求失败时，允许临时回退使用投稿接口中的作者名兜底展示。
- 一旦该作者已存在 Card 缓存，后续即使 Card 请求失败也必须继续使用缓存，不回退到投稿接口作者信息。

### 4.4 展示模式

#### 4.4.1 混合模式
- 默认初始目标数量：`50`（可配置项）。
- 滚动增量目标数量：每次触底追加 `20`（固定值，首版不暴露配置）。
- “加载更多”按钮与触底自动加载并存：
  - 列表底部常驻显示“加载更多”按钮（无论是否还有更多都显示）。
  - 保留触底自动加载行为，两者复用同一 loadMore 链路与同一节流状态。
- 重要规则：
  - 为构造目标数量，可对作者列表执行多轮拉取。
  - 若某轮请求后数量超过目标值，**不裁剪**，全部展示。
  - 仅在“当前可用数据小于目标值”时继续拉取下一轮。

#### 4.4.1.1 时间流按天分段与左侧时间轴
- 时间流列表按“有投稿的自然日”分段，不显示分段标题文案，仅在分段之间保留视觉留白。
- 左侧时间轴与内容滚动联动，按“有投稿日期”渲染节点。
- 时间文案规则：
  - 当天显示 `今天`。
  - 昨天显示 `昨天`。
  - 距离今天 2–7 天（含）显示 `N 天前`（如 `3 天前`）。
  - 其余日期显示 `MM-DD`（不使用“近一周/一周前”等压缩文案）。
- 节点样式状态：
  - 日期分段在可视区域内：显示空心圆节点。
  - 日期分段不在可视区域内：退化为小黑点节点。
- 时间轴压缩窗口规则：
  - 可视区域内的“有投稿日期”节点全部保留，不做压缩。
  - 在可视区域之外，仅额外保留上方 2 个与下方 2 个“有投稿日期”节点。
  - 离屏节点固定停靠在时间轴顶部/底部区域，不贴靠可视节点，避免滚动到临界位置时跳变。
  - 无投稿的日期不占位、不参与前后计数。
  - 不允许无限累积离屏日期节点。

#### 4.4.2 作者模式
- 每作者展示数量默认 `10`（可配置项）。
- 总量不设上限（由作者数量决定）。
- 每位作者内部按发布时间倒序。
- 每位作者标题右侧展示关注按钮：
  - 未关注：`+ 关注 X万`
  - 已关注：`已关注 X万`
  - `X万` 基于 Card API 的 `follower` 字段格式化。
- 点击按钮可直接关注/取消关注（`x/relation/modify`）：
  - 前端先做乐观更新；
  - 后台操作成功后回写最新 Card 信息；
  - 失败时回滚并展示错误信息。
- 工具栏新增勾选项：`按更新时间倒序`（仅在“按作者”模式展示）。
- 勾选项默认值：`true`（默认勾选）。
- 勾选为 `true` 时：
  - 按“该作者在当前筛选条件下可见视频的最新 `pubdate`”倒序排列作者列表。
  - 若某作者在当前筛选条件下无可见视频，则排在列表末尾。
  - 若最新 `pubdate` 相同，按收藏夹作者原始顺序（`authorMids` 顺序）稳定排序。
- 勾选为 `false` 时：作者列表按收藏夹作者原始顺序（`authorMids` 顺序）展示。
- 勾选状态按分组维度持久化记忆，切换分组后恢复各自上次选择。

#### 4.4.2.1 按作者模式子侧栏导航
- 仅在“按作者”模式显示子侧栏，位置在内容区左侧。
- 子侧栏为竖向列表，不使用时间线样式，不增加额外分段间距。
- 列表项展示：作者头像 + 作者名字（不显示 mid 数字）。
- 点击列表项后，内容区平滑滚动到对应作者分组顶部。
- 子侧栏需要独立滚动；当作者数量较多时，不影响右侧内容区滚动。
- 滚动联动高亮：内容区滚动时，子侧栏自动高亮当前可视区域内的作者。

### 4.5 缓存与刷新机制

#### 4.5.1 作者级视频缓存（AuthorVideoCache）

将视频缓存粒度从"按分组"改为"按作者（mid）"，跨分组共享。

全局数据结构 `AuthorVideoCache`，按 `mid` 索引：

```ts
interface AuthorVideoCache {
  mid: number;
  // 作者基础信息统一来自 Card API
  name: string;
  face?: string;
  follower?: number;
  following?: boolean;
  videos: VideoItem[];        // 已拉取的视频，按 pubdate 倒序
  // 该作者当前已缓存的最大页码（至少为 1）
  maxCachedPn: number;
  // 下一次补页请求要拉取的页码（通常为 maxCachedPn + 1）
  nextPn: number;
  hasMore: boolean;           // 是否还有更多页
  // 首页（pn=1）最后一次刷新时间，用于过期判定基线
  firstPageFetchedAt: number;
  // 第二页（pn=2）最后一次预取/刷新时间（可选）
  secondPageFetchedAt?: number;
  lastFetchedAt: number;      // 最后一次从 API 拉取的时间戳（ms）
}
```

存储位置：`chrome.storage.local`（key: `bbe:author-video-cache`）。

缓存过期判定：`Date.now() - lastFetchedAt > refreshIntervalMinutes * 60 * 1000`。

刷新行为：
- 默认刷新首页（`pn=1`）：
  - 过期时优先刷新首页，更新 `firstPageFetchedAt`，并与已有数据合并去重。
  - 首页未过期时，不重复拉首页。
- 第二页预取策略：
  - 常规调度会为“所有已有缓存作者”做低优先级第二页预取。
  - 仅当该作者首页未过期时，才执行第二页（`pn=2`）预取/刷新。
  - 若首页过期，本轮允许暂时保留历史第二页，不立即清空；待后续首页恢复新鲜后，再在常规调度中刷新第二页。
- 动态补页策略（`pn>=3`）：
  - 由时间流构造器按需触发，单次每作者最多补 1 页；
  - 若补完仍不足，再进入下一轮“命中边界 -> 补 1 页”。
- 每次刷新投稿列表时必须同步请求一次 Card API，更新 `name/face/follower/following`（与投稿刷新同频，不单独设 Card 刷新周期）。
- 若本轮 Card 请求失败：
  - 有已有 Card 缓存：保留并继续使用已有缓存；
  - 无 Card 缓存：允许临时使用投稿接口作者名兜底，直到后续 Card 刷新成功。
- 未过期时，直接使用缓存数据。
- 手动刷新（`forceRefresh`）时无视过期判定，强制重新拉取。

#### 4.5.2 分组与作者的关系

分组不再直接持有视频数据，改为持有作者 mid 列表的引用：

```ts
interface GroupFeedCache {
  groupId: string;
  authorMids: number[];       // 该分组包含的作者 mid 列表
  updatedAt: number;          // 作者列表最后更新时间（从收藏夹重建的时间）
}
```

分组刷新流程：
1. 调用 `getAllFavVideos(mediaId)` 获取收藏夹内容，提取作者列表 → 更新 `GroupFeedCache.authorMids`。
2. 对列表中每个 `mid`，检查 `AuthorVideoCache[mid]` 是否过期，过期则刷新。
3. 组装分组视图时，从全局 `AuthorVideoCache` 中按 `authorMids` 聚合数据。

跨分组共享效果：分组 A 刷新了 UP 主 X，分组 B 也包含 UP 主 X 时直接命中缓存。

#### 4.5.3 收藏夹列表缓存

`getAllFavVideos(mediaId)` 的结果也纳入缓存，按 `mediaId` 索引，过期时间同样遵守 `refreshIntervalMinutes`。避免同一分组短时间内重复拉取收藏夹全量数据。

#### 4.5.4 其他请求缓存

| 请求 | 缓存粒度 | 缓存位置 | 过期时间 |
|------|----------|----------|----------|
| `getMyCreatedFolders` | 全局单例 | 内存 | `refreshIntervalMinutes` |
| `getCurrentUser` | 全局单例 | 内存 | `refreshIntervalMinutes` |
| `getWbiKeys` | 全局单例 | 内存 | 2 分钟（固定），遇 412 自动清除重试 |

#### 4.5.5 前台刷新（用户触发）

- 手动刷新（抽屉按钮 / 设置页分组行“立即刷新”）：
  1. 立即向调度器优先入列该分组的收藏夹刷新任务（`group-fav`）。
  2. 收藏夹刷新成功后，基于最新作者列表按缓存状态衔接作者任务：无缓存入 Burst；有缓存且过期入 `author-video` 常规优先；未过期不入队。
  3. 前台通过轮询 `GET_GROUP_FEED` 获取最新缓存，不等待刷新链路同步完成。
- 新增分组（`UPSERT_GROUP` 新建）：
  1. 保存成功后立即向调度器优先入列该分组的 `group-fav` 刷新任务。
  2. 编辑已有分组不自动触发该刷新（避免重复请求）。
- 自动刷新（打开面板或切换分组）：
  1. 若分组无 `GroupFeedCache`：提交 `group-fav` 优先任务，返回 `cacheStatus: 'generating'`。
  2. 若分组已有 `GroupFeedCache`：不自动触发 `group-fav`（收藏夹缓存仅由定时调度和手动刷新驱动）。
  3. 若分组作者缓存仅部分命中：提交缺失作者的 `author-video` 优先任务，返回 `cacheStatus: 'generating'`，并携带当前可展示的缓存结果（不清空已有内容）。
  4. 仅当“本轮需要补齐的作者都完成至少一轮缓存（存在 `AuthorVideoCache[mid].lastFetchedAt`）”后，才返回 `cacheStatus: 'ready'`。
  5. 若当前完全没有可展示内容，则显示“正在生成缓存”；若已有部分内容，则保持内容可见并显示“正在更新中”状态。

#### 4.5.6 刷新状态展示

- 工具栏右侧状态位规则：
  - `ready`：显示相对时间（如“刚刚刷新 / X 分钟前”）。
  - `generating` 且无可展示内容：显示“正在生成缓存，请稍候...”。
  - `generating` 且已有可展示内容：显示转圈动画 + 文本“正在更新中”，不显示“上次刷新时间”。

#### 4.5.7 后台定时刷新

通过通用调度器 + `chrome.alarms` 实现，Service Worker 休眠后仍可被唤醒。调度细节见 `docs/scheduler-spec.md`。

后台刷新拆分为两条独立通道（互不共享 ratelimit）：
1. `author-video`：刷新作者视频缓存，周期由 `backgroundRefreshIntervalMinutes` 控制。
2. `group-fav`：刷新收藏夹缓存（标题 + 作者列表），周期由 `groupFavRefreshIntervalMinutes` 控制。

批次执行规则保持不变：每个通道都按 `schedulerBatchSize` 分批、批内串行 + 固定间隔、批间按周期均匀分散，并保留失败任务重试机制；详见 `docs/scheduler-spec.md` 3.5 节。
当存在“作者无缓存”目标时触发 Burst 模式：Burst 优先于常规调度，常规任务会在 Burst 清空后恢复；详见 `docs/scheduler-spec.md` 3.6 节。

#### 4.5.8 时间流分页构造与补页

时间流在构造目标片段（如 `1-50`、`51-70`、`71-90`）时遵循以下规则：

1. 先尝试用当前缓存（默认至少包含首页 + 预取第二页）直接构造并返回。
2. 构造过程中若“触及某作者当前缓存最旧一条视频”，且该作者 `hasMore=true`，视为命中分页边界。
3. 命中边界时，向 Burst 队列**队首**插入该作者“下一页补页任务”，并等待该任务执行完成后重构结果。
4. 单轮补页粒度为“每命中作者补 1 页”；若重构后仍不足，再进入下一轮边界判定。
5. 若 Burst 补页失败：
  - 前台展示错误提示；
  - 不中止本次构造，改为基于现有缓存尽可能返回结果（best-effort）。

#### 4.5.9 设置项汇总

| 设置项 | UI 标签 | 含义 | 默认值 | 范围 |
|--------|---------|------|--------|------|
| `refreshIntervalMinutes` | 请求缓存时长（分钟） | API 请求结果的缓存有效期 | 30 | 1–120 |
| `backgroundRefreshIntervalMinutes` | 作者缓存刷新间隔（分钟） | `author-video` 通道 alarm 周期 | 10 | 5–120 |
| `groupFavRefreshIntervalMinutes` | 收藏夹缓存刷新间隔（分钟） | `group-fav` 通道 alarm 周期 | 10 | 5–120 |
| `schedulerBatchSize` | 每批任务数 | 调度器每个通道每批最多执行任务数（全通道共享） | 10 | 1–50 |

### 4.6 红点（未读）规则
- 分组红点与“该分组当前已阅时间点”绑定，不使用“打开分组即已读”的模型。
- 分组级未读计算：
  - 若 `savedReadMarkTs === 0`（全部），该分组未读数固定为 `0`。
  - 否则按分组 `savedReadMarkTs` 计算作者级基线；若作者无可用基线则回退到“默认已阅天数（`defaultReadMarkDays`）”时间点。
  - 分组未读数 = 分组内去重后视频中同时满足：
    - `pubdate > authorBaselineTs`
    - 且未命中“已查看（点击记录命中或 playback_position >= 10）”
- 切换已阅时间点会立即重算分组未读数与 Header 状态。
- Header 全局 unread count 采用“按作者聚合”规则：
  - 同一作者出现在多个分组时，取其在所有“非全部分组”中的最大已阅基线作为全局基线。
  - 若作者只出现在“全部分组”中，则该作者全局未读数为 `0`。
  - 全局 unread count 不等于分组未读数简单求和，且“全部分组”不影响其他分组/作者的基线计算。
  - 全局 unread count 同样扣除“已查看（点击记录命中或 playback_position >= 10）”的视频。

### 4.7 设置项
- `refreshIntervalMinutes`：请求缓存时长（默认 30）。
- `backgroundRefreshIntervalMinutes`：作者缓存刷新间隔（默认 10）。
- `groupFavRefreshIntervalMinutes`：收藏夹缓存刷新间隔（默认 10）。
- `schedulerBatchSize`：调度器每批任务数（默认 10，全通道共享）。
- `timelineMixedMaxCount`：时间流模式目标基数（默认 50）。
- `extraOlderVideoCount`：按作者模式下已阅前额外展示数量（默认 1）。
- `defaultReadMarkDays`：无已阅记录时的默认已阅天数（默认 7）。
- `useStorageSync`：是否启用 `chrome.storage.sync`（默认开；超限时回退 local 并提示）。

## 5. 技术方案

### 5.1 技术栈
- Manifest V3
- Vue 3 + TypeScript
- Vite 构建
- 状态管理：Pinia（或等价轻量方案）

### 5.2 扩展模块划分
- `background`（Service Worker）
  - 统一请求代理（带登录态）
  - 缓存与刷新调度
  - 未读状态计算
- `content`（内容脚本）
  - Header 注入
  - 挂载“分组动态”抽屉 UI
- `options`（设置页）
  - 分组管理
  - 设置项配置
- `shared`（共享层）
  - 类型定义
  - 存储与消息协议
  - API Client

### 5.3 登录态请求策略
- 首选策略：通过扩展发起 `fetch(..., { credentials: 'include' })` 请求 Bilibili 域名接口，使用用户当前登录态 Cookie。
- 权限：声明 `host_permissions` 覆盖 `*.bilibili.com` 必需域名。
- 不主动导出/展示用户 Cookie 原文。

### 5.4 Bilibili API（首版拟定）
- 登录与用户信息：用于确认登录态、拿到当前用户 `mid`。
- 我的收藏夹列表：拉取当前用户“创建的收藏夹”。
- 收藏夹资源列表：拉取收藏夹内视频与作者信息。
- 作者投稿列表：按 `mid` 拉取投稿视频（视频数据源）。
- 作者卡片信息：`x/web-interface/card`（作者名称、头像、粉丝数、是否已关注的数据源）。

说明：不同接口在 Web 端可能存在签名、分页、风控策略差异；实现阶段将封装可替换 API 适配层，保证后续可替换具体端点而不影响 UI 和核心逻辑。

## 6. 数据结构（TypeScript）

```ts
interface GroupConfig {
  groupId: string;
  mediaId: number;
  mediaTitle: string;
  alias?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface ExtensionSettings {
  refreshIntervalMinutes: number; // default 30
  backgroundRefreshIntervalMinutes: number; // default 10
  groupFavRefreshIntervalMinutes: number; // default 10
  schedulerBatchSize: number; // default 10
  timelineMixedMaxCount: number; // default 50
  extraOlderVideoCount: number; // default 1
  useStorageSync: boolean;
}

interface GroupRuntimeState {
  groupId: string;
  lastRefreshAt?: number;
  lastReadAt?: number;
  unreadCount: number;
  mixedTargetCount: number;
  savedMode?: ViewMode;
  savedReadMarkTs?: number;
  savedByAuthorSortByLatest?: boolean; // default true
}

// 按作者缓存视频数据，跨分组共享
interface AuthorVideoCache {
  mid: number;
  name: string; // 来自 Card API
  face?: string; // 来自 Card API
  follower?: number; // 来自 Card API
  following?: boolean; // 来自 Card API
  videos: VideoItem[];
  maxCachedPn: number;
  nextPn: number;
  hasMore: boolean;
  firstPageFetchedAt: number;
  secondPageFetchedAt?: number;
  lastFetchedAt: number;
}

// 分组仅持有作者引用，不直接持有视频数据
interface GroupFeedCache {
  groupId: string;
  authorMids: number[];
  updatedAt: number;
}

interface VideoItem {
  bvid: string;
  aid: number;
  title: string;
  cover: string;
  pubdate: number;
  authorMid: number;
  authorName: string;
}
```

## 7. 交互流程

### 7.1 首次使用
1. 用户安装扩展。
2. 打开设置页，加载“我的收藏夹列表”。
3. 选择收藏夹创建分组，设置别名（可选）。
4. 回到 B 站页面，Header 出现“分组动态”入口。

### 7.2 查看分组动态
1. 点击“分组动态”打开抽屉。
2. 默认选中上次查看分组（或第一个启用分组）。
3. 先读取缓存：
   - 分组无缓存：提交收藏夹优先刷新任务并显示“生成中”状态。
   - 分组有缓存但作者缓存不完整：提交缺失作者优先刷新任务，保留已命中的展示内容并显示“正在更新中”。
4. 展示内容并按当前分组已阅时间点计算红点；不因打开分组自动更新“已读时间”。

### 7.3 混合模式加载更多
1. 初次目标 `timelineMixedMaxCount`。
2. 支持“触底自动加载 + 手动点击加载更多”双触发；按钮常驻显示。
3. 每次触发后目标 += 20。
4. 构造器先尝试使用当前缓存；若命中作者缓存边界则触发 Burst 队首补页并等待。
5. 若补页失败，提示错误并以现有缓存 best-effort 返回。
6. 若单轮拉取超过目标，不裁剪。

## 8. 错误与降级
- 未登录：面板显示“请先登录 Bilibili”。
- 接口失败：显示重试按钮与错误摘要。
- 部分作者拉取失败：记录错误并继续展示已成功部分。
- 若收藏夹刷新结果为空数组（如收藏夹被删除或不可访问）：保持原分组标题与作者列表缓存不变，等待用户在设置页手动删除该分组。
- `storage.sync` 配额超限：自动回退 `storage.local`，提示“已切换本地存储”。

## 9. 权限清单（MV3）
- `storage`
- `alarms`（可选，用于周期性检查）
- `host_permissions`：`https://*.bilibili.com/*`
- `scripting`（如需动态注入）

## 10. 验收标准（首版）
1. 用户可从"我的收藏夹列表"创建/编辑/删除分组。
2. `www` 与 `space` 页面 Header 均出现"分组动态"入口。
3. 面板支持分组切换、混合/作者模式切换、手动刷新。
4. 请求缓存时长可配置，默认 30 分钟。
5. 作者缓存与收藏夹缓存均支持独立后台定时刷新，两个默认间隔均为 10 分钟。
6. 作者级视频缓存跨分组共享，避免重复请求同一 UP 主。
7. 混合模式初始目标默认 50，支持“触底 + 按钮”双触发追加 20，超出目标不裁剪。
8. 作者模式默认每作者 10 条，数量可配置。
9. 红点按“已阅时间点驱动”生效：分组切到“全部”时红点为 0；Header 全局 unread count 按作者聚合且不简单求和。
10. 设置页“分组列表”每行提供“立即刷新”按钮，行为与抽屉手动刷新一致。
11. 设置页支持配置 `schedulerBatchSize`，并对所有调度通道同时生效。
12. 调试页支持“立刻发起调度”；触发后下一次自动调度时间从当前时刻重新起算（`now + interval`）。
13. 调试页支持 Burst 模式监控：可查看 Burst 队列、当前任务（分组名 + 作者名；缺失作者名时回退 MID）、下一次可执行时间，以及是否处于“错误冷却（60s）”。
14. “按作者”模式支持“按更新时间倒序”勾选项，默认勾选，且按分组记忆勾选状态。
15. 分组已有缓存但作者缓存部分缺失时，前台不清空已展示内容，状态显示“正在更新中”，并自动补齐缺失作者缓存。
16. 手动刷新会刷新“分组信息（标题、作者列表）+ 作者投稿缓存”；若收藏夹返回空数组则不覆盖现有分组缓存。
17. 时间流“加载更多”按钮始终可见；命中作者缓存边界时可触发 Burst 队首补页并等待，失败时给出错误提示并 best-effort 返回。

## 11. 里程碑拆分
- M1：扩展骨架 + Header 注入 + 基础抽屉 UI
- M2：登录态 API + 收藏夹分组管理 + 设置页
- M3：投稿聚合（混合/作者）+ 刷新策略 + 红点
- M4：稳定性与错误处理 + 打包说明与 README
