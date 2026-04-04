# 惊蛰：哔哩哔哩关注功能扩展

一个面向 Chrome/Edge，并支持 Firefox 本地调试与 AMO 提交的 Bilibili 扩展：
- 用用户当前登录态请求 Bilibili 接口
- 将“我创建的收藏夹”映射为分组
- 在站点 Header 注入“分组动态”入口
- 按分组展示收藏夹内作者的投稿更新
- 支持默认分支 push 后自动打包并发布 GitHub Release

## 当前功能
- 站点注入入口：`www.bilibili.com`、`space.bilibili.com`、`search.bilibili.com`
- 作者分组管理注入：
  - 视频投稿页作者区域支持“添加到分组 / 已分组”
  - 用户空间作者区域支持“添加到分组 / 已分组”
  - 用户头像 hover 卡片支持“添加到分组 / 已分组”
- 右侧抽屉面板：分组切换、红点、手动刷新
- 三种投稿视图：
  - 时间流：按时间顺序查看近期投稿，支持滚动加载更多
  - 近期投稿：按作者查看近期投稿
  - 全部投稿：按作者查看全部投稿
- 设置页：
  - 从“我的收藏夹列表”创建分组（1:1）
  - 分组别名 / 启用状态 / 删除
  - 刷新间隔、混合初始数量、作者模式数量
  - `storage.sync` 开关（超限自动回退 local）

## 技术栈
- Manifest V3
- Vue 3 + TypeScript
- Vite

## 本地开发
```bash
npm install
npm run build
```

构建后会输出两套产物：
- `dist/chromium`：Chrome/Edge
- `dist/firefox`：Firefox（本地调试 / AMO 提交）
- `dist/bilibili-extender-chromium-v<version>.zip`：Chromium 发布包
- `dist/bilibili-extender-firefox-v<version>.zip`：Firefox 发布包

zip 包说明：
- 压缩包根层直接包含扩展文件本身。
- 解压后不会出现额外的 `chromium/` 或 `firefox/` 顶层目录。
- 本地 `dist/` 最多只保留最近 3 个版本的 zip，每个版本会同时保留 Chromium 与 Firefox 两个包。

Chrome/Edge 加载步骤：
1. 打开 Chrome/Edge 扩展管理页
2. 开启“开发者模式”
3. 选择“加载已解压的扩展程序”并指向 `dist/chromium`

Firefox 本地调试加载步骤：
1. 打开 `about:debugging#/runtime/this-firefox`
2. 点击“临时载入附加组件”
3. 选择 `dist/firefox/manifest.json`

Firefox 提交说明：
- Firefox 构建产物会自动补充固定 `gecko.id`，用于 MV3 扩展签名与 `storage.sync` 能力识别。
- Firefox 构建产物会自动补充 `data_collection_permissions`，声明扩展运行所需的站点内容与站点交互数据传输。
- 由于当前仓库未实现旧版 Firefox 的自定义数据收集同意流程，Firefox 清单最低版本设为 `140.0`。

## 自动发布

仓库已配置 GitHub Actions 自动发布：
- 仅默认分支 `push` 时触发。
- 工作流会执行 `npm ci` 与 `npm run build`，然后读取 `package.json` 的版本号创建 `v<version>` GitHub Release。
- Release 会上传 Chromium 与 Firefox 两个 zip 产物。

发布约束：
- 每次希望创建新的 Release，必须先 bump 版本号再 push。
- 如果默认分支重复 push 同一个版本号，因 `v<version>` 已存在，工作流会直接失败，不会覆盖已有 Release。

## 目录结构
```text
src/
  background/   # Service Worker：API 请求代理、缓存、刷新、红点
  content/      # 内容脚本：Header 注入与抽屉 UI
  options/      # 设置页
  shared/       # 类型、消息协议、存储封装、API 与工具函数
docs/
  build-release-spec.md
  grouped-feed-extension-spec.md
  firefox-support-spec.md
```

## 权限说明
- `host_permissions: https://*.bilibili.com/*`
  - 用于请求 Bilibili 接口（`credentials: include`）
- `declarativeNetRequest`
  - 用于在 Bilibili `POST` 写操作前改写关键来源头（如 `Origin`、`Referer`、`Sec-Fetch-Site`），降低扩展上下文触发风控的概率
- `storage`
  - 保存分组、设置、运行时状态
- `alarms`
  - 预留周期调度能力

## 已知风险
- Bilibili API 可能调整字段、风控或签名策略，导致请求失败。
- `storage.sync` 受浏览器配额限制，配置过大时会自动回退本地存储。
