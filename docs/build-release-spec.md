# 构建打包与 GitHub Release 自动发布 Spec

## 1. 背景与目标

### 1.1 背景

当前仓库的构建流程只会生成两套可直接加载的目录产物：

1. `dist/chromium`
2. `dist/firefox`

这满足本地加载与 AMO 提交前检查的基本需求，但仍缺少两个发布层能力：

1. 构建后直接生成可上传或分发的 zip 包。
2. 在默认分支 push 后，自动基于版本号创建 GitHub Release 并上传 zip 产物。

### 1.2 目标

在不改变扩展业务逻辑的前提下，实现以下能力：

1. `npm run build` 完成后，同时产出 Chromium 与 Firefox 的 zip 包。
2. zip 包解压后直接得到扩展文件本身，不包含额外的顶层目录。
3. GitHub Actions 仅在默认分支 push 时触发自动发布。
4. 每次发布基于当前项目版本号创建新的 GitHub Release，并上传两个浏览器产物 zip。

### 1.3 非目标

1. 不修改扩展运行时功能、权限或浏览器兼容策略。
2. 不接入手动审批、草稿发布、预发布等复杂发布流。
3. 不处理“同一版本号重复 push 仍自动创建新 release”的场景。

## 2. 需求范围

### 2.1 本地构建产物

执行 `npm run build` 后，应至少包含以下产物：

1. `dist/chromium/`：可直接加载的 Chromium 目录产物。
2. `dist/firefox/`：可直接加载的 Firefox 目录产物。
3. `dist/bilibili-extender-chromium-v<version>.zip`
4. `dist/bilibili-extender-firefox-v<version>.zip`

其中 zip 内部文件布局必须满足：

1. 根层直接包含 `manifest.json`、`background.js`、`content.js`、`options.html`、`assets/`、`icons/` 等文件或目录。
2. 不出现 `chromium/`、`firefox/` 作为 zip 内的额外顶层目录。
3. 本地 `dist/` 下的历史 zip 最多保留最近 3 个版本，每个版本按 Chromium + Firefox 一整组保留。

### 2.2 GitHub Release 规则

自动发布工作流需要满足：

1. 仅在默认分支收到 `push` 时触发。
2. 从 `package.json` 的 `version` 字段读取版本号。
3. 使用 `v<version>` 作为 git tag 与 Release 名称的核心标识。
4. Release 附件上传两个 zip：
   - `bilibili-extender-chromium-v<version>.zip`
   - `bilibili-extender-firefox-v<version>.zip`

### 2.3 版本约束

由于 Release 与 tag 由版本号推导，因此：

1. 默认分支上每次希望创建新 Release 时，必须先提交一个新的版本号。
2. 若重复 push 同一版本号，工作流应视为冲突并失败，而不是静默覆盖已有 Release。

## 3. 设计方案

### 3.1 构建与打包流程

保留现有两阶段浏览器构建逻辑：

1. 先生成 Chromium 目录产物并写入 manifest。
2. 再生成 Firefox 目录产物并写入 manifest。

在两套目录产物生成完成后，新增统一打包步骤：

1. 读取当前版本号。
2. 分别进入 `dist/chromium` 与 `dist/firefox` 目录执行 zip 打包。
3. 输出 zip 到 `dist/` 根目录，避免把中间目录再嵌套进压缩包。
4. 按 zip 文件名中的版本号分组，仅保留最近 3 个版本，超出的旧版本整组删除。

### 3.2 自动发布流程

GitHub Actions 工作流执行步骤如下：

1. 检出默认分支最新代码。
2. 安装 Node.js 依赖。
3. 执行 `npm ci`。
4. 执行 `npm run build` 生成目录产物与 zip。
5. 读取 `package.json` 版本号，生成 tag：`v<version>`。
6. 创建对应 GitHub Release。
7. 上传 Chromium 与 Firefox 两个 zip 作为 release assets。

### 3.3 失败策略

为避免发布状态与版本号失真，采用严格失败策略：

1. 如果构建失败，则不创建 Release。
2. 如果 tag 已存在或 Release 已存在，则工作流失败。
3. 如果 zip 缺失，则工作流失败。

## 4. 风险与缓解

1. 风险：默认分支重复 push 同一版本号会导致自动发布失败。  
   缓解：将“每次发布前必须 bump 版本号”明确写入 README 与发布约束。

2. 风险：不同 runner 的压缩命令行为存在差异。  
   缓解：使用 GitHub Ubuntu runner 自带的标准 `zip` 工具，并在脚本中显式从浏览器产物目录内部打包，确保压缩包结构稳定。

3. 风险：发布附件命名不稳定，影响下载与回溯。  
   缓解：统一使用带浏览器目标与版本号的固定命名规则。

## 5. 验收标准

1. 本地执行 `npm run build` 后，`dist/` 下可见两个 zip 文件。
2. 任一 zip 解压后，根层直接包含扩展文件，不包含额外顶层子目录。
3. 本地存在超过 3 个历史版本时，下一次构建会自动删除更早版本的整组 zip。
4. 默认分支 push 时，GitHub Actions 能自动创建 `v<version>` 对应 Release。
5. Release 页面可下载 Chromium 与 Firefox 两个 zip 产物。
6. 若未 bump 版本号导致 tag 已存在，工作流明确失败。

## 6. 实施步骤

1. 新增构建后打包脚本，并串联到现有 `npm run build`。
2. 新增 GitHub Actions 发布工作流。
3. 同步更新 README 的构建与发布说明。
4. bump patch 版本号。
5. 执行 `npm run build` 验证本地产物。
