# Firefox 本地调试支持 Spec

## 1. 背景与目标

### 1.1 背景

当前项目明确面向 Chrome/Edge，代码中直接调用 `chrome.*`，并且仅提供单一 `manifest.json`。  
要在 Firefox 本地调试中可用，需要补齐浏览器 API 兼容层与构建产物分流。

### 1.2 目标

在不改变核心业务功能（分组、缓存、调度、UI 交互）的前提下，实现：

1. 可在 Firefox `about:debugging` 中加载构建产物进行本地调试。
2. 代码层提供统一浏览器 API 入口，避免业务模块直接依赖 `chrome.*`。
3. 保持 Chrome/Edge 现有行为不回退。

### 1.3 非目标

1. 不包含 AMO 发布流程。
2. 不包含扩展签名流程。
3. 本轮不强制配置 `browser_specific_settings.gecko.id`。
4. 不额外新增浏览器特化功能。

## 2. 需求范围

### 2.1 功能范围

1. API 适配层：统一封装运行时、存储与调度相关 API。
2. Manifest 分流：Chromium 与 Firefox 生成各自可加载 manifest。
3. 构建命令：支持一键构建两套产物，便于本地调试。

### 2.2 兼容口径

1. 以“本地调试可用”为验收标准。
2. `storage.sync` 在 Firefox 本地调试场景采用“可用则用，不可用自动回退 local”策略。
3. 不要求本轮保证 AMO 审核规则全量满足。

## 3. 设计方案

## 3.1 API 适配层

新增平台模块（暂定 `src/shared/platform/webext.ts`）：

1. 暴露统一 `ext` 对象，作为业务模块调用入口。
2. 运行时自动选择可用命名空间（`browser` 或 `chrome`）。
3. 仅在该模块内处理浏览器差异，业务代码不直接访问全局 `chrome`。

业务代码改造规则：

1. `src/shared/messages.ts`、`src/shared/storage/repository.ts`、`src/background/*` 等涉及扩展 API 的模块统一改用 `ext`。
2. 关键行为（消息收发、`alarms`、`storage`）保留原有语义与错误处理。
3. 对复杂差异点保留中文注释，说明兼容原因与降级策略。

## 3.2 Manifest 与构建分流

构建阶段生成两套产物：

1. `dist/chromium/manifest.json`
2. `dist/firefox/manifest.json`

其中：

1. Chromium 清单维持现有 MV3 行为与字段。
2. Firefox 清单增加兼容后台字段（`background.scripts`）以满足 Firefox 本地调试加载。
3. 本轮不写入 `browser_specific_settings.gecko.id`（因仅本地调试）。

> 说明：Firefox 对 MV3 `background.service_worker` 支持与 Chromium 存在差异，需通过 manifest 字段兼容处理。

## 3.3 构建与脚本

新增（或调整）脚本：

1. `npm run build:chromium`：生成 Chromium 可加载产物。
2. `npm run build:firefox`：生成 Firefox 可加载产物。
3. `npm run build`：顺序执行上述两套构建。

额外约束：

1. 保持 content script 的 IIFE 构建策略不变。
2. 保持版本号在 `package.json` 与 manifest 中一致（按仓库规范 bump patch）。

## 4. 影响分析

## 4.1 对现有功能影响

1. 业务逻辑不变，仅替换底层 API 调用入口。
2. 后台调度与缓存策略不变。
3. UI 与交互不变。

## 4.2 风险与缓解

1. 风险：Firefox 背景脚本加载机制与 Chromium 不一致。  
   缓解：采用清单分流，并在本地调试执行完整联调。
2. 风险：`storage.sync` 在未配置固定 ID 时能力受限。  
   缓解：沿用现有 local 回退策略，确保主流程可用。
3. 风险：API 入口替换可能引入回归。  
   缓解：构建后执行关键路径手测（分组读取、刷新、调度、已阅标记）。

## 5. 验收标准

1. `npm run build` 可成功完成 Chromium + Firefox 两套构建。
2. Chromium 产物可正常加载并维持当前功能。
3. Firefox 产物可在 `about:debugging` 本地加载。
4. 在 Firefox 中可完成最小闭环：
   - 打开抽屉
   - 读取分组
   - 手动刷新
   - 展示时间流/按作者
5. 代码中不再出现业务模块直接调用全局 `chrome.*`（允许适配层内部使用）。

## 6. 实施步骤

1. 新增平台 API 适配层并接入存储/消息/调度模块。
2. 增加 manifest 模板或构建后清单生成脚本，输出 Chromium/Firefox 两套 manifest。
3. 调整 `package.json` 构建脚本，支持双目标构建。
4. 更新 `README.md` 的加载说明（补充 Firefox 本地调试步骤）。
5. 执行 `npm run build` 验证。

## 7. 参考资料

1. MDN `background`：https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background
2. MDN `browser_specific_settings`：https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings
3. MDN `storage.sync`：https://developer.mozilla.org/en-US/Add-ons/WebExtensions/API/storage/sync
