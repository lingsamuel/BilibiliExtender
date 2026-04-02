# Firefox 支持与 AMO 提交 Spec

## 1. 背景与目标

### 1.1 背景

当前项目已经支持 Firefox 本地调试，但原始目标只覆盖“可临时加载”，没有覆盖 AMO 提交所需的 Firefox manifest 元数据。  
在准备提交 Firefox 官方商店时，需要在 Firefox 构建产物中补齐扩展 ID、数据收集声明与最低版本约束。

### 1.2 目标

在不改变核心业务功能（分组、缓存、调度、UI 交互）的前提下，实现：

1. 可在 Firefox `about:debugging` 中加载构建产物进行本地调试。
2. Firefox 构建产物具备 AMO 提交所需的基础 manifest 字段。
3. 保持 Chrome/Edge 现有行为不回退。

### 1.3 非目标

1. 不包含 AMO 发布后台中的截图、分类、详情页文案、多语言运营资料填写。
2. 不包含扩展签名流程本身。
3. 不额外新增浏览器特化功能。

## 2. 需求范围

### 2.1 功能范围

1. Manifest 分流：Chromium 与 Firefox 生成各自可加载 manifest。
2. Firefox manifest 补充 AMO 提交所需字段。
3. 构建命令继续支持一键生成两套产物。

### 2.2 兼容口径

1. Chromium 产物维持现有 MV3 行为。
2. Firefox 产物继续支持本地调试加载。
3. 以“可提交 AMO 基础审核”为目标，但不覆盖商店后台所有运营资料填写。

## 3. 设计方案

### 3.1 Manifest 与构建分流

构建阶段继续生成两套产物：

1. `dist/chromium/manifest.json`
2. `dist/firefox/manifest.json`

其中：

1. Chromium 清单维持现有 MV3 行为与字段。
2. Firefox 清单保留兼容后台字段（`background.scripts`），满足 Firefox 本地调试加载。
3. Firefox 清单补充 `browser_specific_settings.gecko.id`，满足 MV3 扩展在 AMO 签名时必须提供扩展 ID 的要求。
4. Firefox 清单补充 `browser_specific_settings.gecko.data_collection_permissions`，声明扩展运行所需的站点内容与站点交互数据传输。
5. 由于当前仓库未实现旧版 Firefox 的自定义数据收集同意流程，`strict_min_version` 提升到支持内建同意提示的版本。

> 说明：AMO 相关字段仅写入 Firefox 产物，不污染 Chromium 清单。

### 3.2 字段口径

1. `gecko.id` 使用固定值，保证后续升级与 `storage.sync` 能力识别稳定。
2. `data_collection_permissions.required` 按当前实现声明：
   - `websiteContent`：扩展会读取并传递站点内容上下文与请求上下文，用于 Bilibili 接口调用。
   - `websiteActivity`：扩展会代表用户执行关注、收藏夹、点赞、投币等站点交互请求。
3. `strict_min_version` 设为 `140.0`，避免在未提供内建数据同意提示的旧版 Firefox 中安装后行为不符合商店要求。

## 4. 风险与缓解

1. 风险：Firefox AMO 的数据收集分类与扩展真实行为不一致，可能导致审核打回。  
   缓解：按当前实现声明必需的 `websiteContent` 与 `websiteActivity`，后续若数据范围变化需同步复核。
2. 风险：`storage.sync` 在未配置固定 ID 时能力受限。  
   缓解：补充固定 `gecko.id`，并继续保留 local 回退策略。
3. 风险：Firefox 背景脚本加载机制与 Chromium 不一致。  
   缓解：继续沿用 Firefox 专用清单分流，构建后执行完整构建验证。

## 5. 验收标准

1. `npm run build` 可成功完成 Chromium + Firefox 两套构建。
2. Chromium 产物可正常加载并维持当前功能。
3. Firefox 产物可在 `about:debugging` 本地加载。
4. Firefox 产物包含可用于 AMO 提交的 `gecko.id`、`data_collection_permissions` 与 `strict_min_version`。

## 6. 实施步骤

1. 调整 Firefox manifest 生成脚本，补充 AMO 所需字段。
2. 同步更新 README 与 Firefox 说明文档。
3. bump patch 版本号。
4. 执行 `npm run build` 验证。

## 7. 参考资料

1. MDN `background`：https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background
2. MDN `browser_specific_settings`：https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings
3. Extension Workshop `Extensions and the Add-on ID`：https://extensionworkshop.com/documentation/develop/extensions-and-the-add-on-id/
4. Extension Workshop `Firefox built-in consent for data collection and transmission`：https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
