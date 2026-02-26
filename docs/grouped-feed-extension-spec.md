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
- 已读时间戳：用户最近一次打开该分组动态面板的时间戳。

## 3. 用户故事
1. 作为登录用户，我可以从“我的收藏夹列表”里选择若干收藏夹，创建分组并设置分组别名。
2. 作为用户，我在 `www.bilibili.com` 与 `space.bilibili.com` 顶部 Header 都能看到“分组动态”入口。
3. 作为用户，我点击入口后看到右侧抽屉面板，并能在左侧分组栏切换不同分组。
4. 作为用户，我可以切换“混合模式/作者模式”查看投稿。
5. 作为用户，我可以手动刷新；若距离上次刷新超过阈值（默认 10 分钟），系统自动刷新。
6. 作为用户，我在未查看某分组且出现新投稿时，该入口与对应分组显示红点；进入该分组后该分组红点清除。

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
  - 右侧：当前分组内容区 + 视图模式切换 + 刷新按钮 + 上次刷新时间

### 4.3 投稿聚合规则
- 输入：分组绑定收藏夹中的视频集合。
- 作者提取：从收藏夹视频中提取作者 `mid` 去重。
- 投稿拉取：按作者获取投稿视频列表。
- 去重：按视频 `bvid` 去重。
- 排序：按投稿发布时间（`pubdate`）倒序。

### 4.4 展示模式

#### 4.4.1 混合模式
- 默认初始目标数量：`50`（可配置项）。
- 滚动增量目标数量：每次触底追加 `20`（固定值，首版不暴露配置）。
- 重要规则：
  - 为构造目标数量，可对作者列表执行多轮拉取。
  - 若某轮请求后数量超过目标值，**不裁剪**，全部展示。
  - 仅在“当前可用数据小于目标值”时继续拉取下一轮。

#### 4.4.2 作者模式
- 每作者展示数量默认 `10`（可配置项）。
- 总量不设上限（由作者数量决定）。
- 每位作者内部按发布时间倒序。

### 4.5 刷新机制
- 手动刷新：点击刷新按钮立即更新当前分组。
- 自动刷新：
  - 每个分组记录 `lastRefreshAt`。
  - 打开面板或切换分组时，若 `now - lastRefreshAt > refreshInterval`，自动刷新。
- 刷新间隔 `refreshInterval` 为设置项，默认 `10` 分钟。

### 4.6 红点（未读）规则
- 分组级未读判定：存在 `pubdate > lastReadAt(groupId)` 的视频即为未读。
- 清除时机：用户打开并激活某分组时，仅清除该分组未读状态（更新 `lastReadAt`）。
- Header 入口红点：任一启用分组存在未读即显示。

### 4.7 设置项
- `refreshIntervalMinutes`：自动刷新阈值（默认 10）。
- `mixedInitialTargetCount`：混合模式初始目标量（默认 50）。
- `authorPerCreatorCount`：作者模式每作者展示量（默认 10）。
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
- 作者投稿列表：按 `mid` 拉取投稿视频。

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
  refreshIntervalMinutes: number; // default 10
  mixedInitialTargetCount: number; // default 50
  authorPerCreatorCount: number; // default 10
  useStorageSync: boolean;
}

interface GroupRuntimeState {
  groupId: string;
  lastRefreshAt?: number;
  lastReadAt?: number;
  unreadCount: number;
  mixedCursor?: {
    targetCount: number;
    round: number;
  };
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
3. 判断是否超过刷新间隔，必要时自动刷新。
4. 展示内容并更新分组已读时间。

### 7.3 混合模式加载更多
1. 初次目标 `mixedInitialTargetCount`。
2. 触底后目标 += 20。
3. 若当前缓存不足新目标，执行追加拉取。
4. 若单轮拉取超过目标，不裁剪。

## 8. 错误与降级
- 未登录：面板显示“请先登录 Bilibili”。
- 接口失败：显示重试按钮与错误摘要。
- 部分作者拉取失败：记录错误并继续展示已成功部分。
- `storage.sync` 配额超限：自动回退 `storage.local`，提示“已切换本地存储”。

## 9. 权限清单（MV3）
- `storage`
- `alarms`（可选，用于周期性检查）
- `host_permissions`：`https://*.bilibili.com/*`
- `scripting`（如需动态注入）

## 10. 验收标准（首版）
1. 用户可从“我的收藏夹列表”创建/编辑/删除分组。
2. `www` 与 `space` 页面 Header 均出现“分组动态”入口。
3. 面板支持分组切换、混合/作者模式切换、手动刷新。
4. 自动刷新阈值可配置，默认 10 分钟。
5. 混合模式初始目标默认 50，触底追加 20，超出目标不裁剪。
6. 作者模式默认每作者 10 条，数量可配置。
7. 红点按“仅当前分组已读清除”生效，Header 红点聚合正确。

## 11. 里程碑拆分
- M1：扩展骨架 + Header 注入 + 基础抽屉 UI
- M2：登录态 API + 收藏夹分组管理 + 设置页
- M3：投稿聚合（混合/作者）+ 刷新策略 + 红点
- M4：稳定性与错误处理 + 打包说明与 README

