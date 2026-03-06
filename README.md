# Bilibili Extender

一个面向 Chrome/Edge，并支持 Firefox 本地调试的 Bilibili 扩展：
- 用用户当前登录态请求 Bilibili 接口
- 将“我创建的收藏夹”映射为分组
- 在站点 Header 注入“分组动态”入口
- 按分组展示收藏夹内作者的投稿更新

## 当前功能
- 站点注入入口：`www.bilibili.com`、`space.bilibili.com`、`search.bilibili.com`
- 右侧抽屉面板：分组切换、红点、手动刷新
- 双视图：
  - 时间流（混合模式，支持滚动加载更多）
  - 按作者（每作者展示数量可配置）
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
- `dist/firefox`：Firefox（本地调试）

Chrome/Edge 加载步骤：
1. 打开 Chrome/Edge 扩展管理页
2. 开启“开发者模式”
3. 选择“加载已解压的扩展程序”并指向 `dist/chromium`

Firefox 本地调试加载步骤：
1. 打开 `about:debugging#/runtime/this-firefox`
2. 点击“临时载入附加组件”
3. 选择 `dist/firefox/manifest.json`

## 目录结构
```text
src/
  background/   # Service Worker：API 请求代理、缓存、刷新、红点
  content/      # 内容脚本：Header 注入与抽屉 UI
  options/      # 设置页
  shared/       # 类型、消息协议、存储封装、API 与工具函数
docs/
  grouped-feed-extension-spec.md
  firefox-support-spec.md
```

## 权限说明
- `host_permissions: https://*.bilibili.com/*`
  - 用于请求 Bilibili 接口（`credentials: include`）
- `storage`
  - 保存分组、设置、运行时状态
- `alarms`
  - 预留周期调度能力

## 已知风险
- Bilibili API 可能调整字段、风控或签名策略，导致请求失败。
- `storage.sync` 受浏览器配额限制，配置过大时会自动回退本地存储。
