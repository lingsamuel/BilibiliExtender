# 审核源码包构建说明

本源码包包含“惊蛰：哔哩哔哩关注功能扩展”的可读源代码、资源、锁文件和构建脚本。
扩展使用 Vite 将 TypeScript 与 Vue 单文件组件编译、打包及压缩；审核时可按本文独立重建。
Mozilla 的源码提交要求见：https://extensionworkshop.com/documentation/publish/source-code-submission/ 。

## 环境与依赖

- 在 Linux 的 POSIX shell 中执行；项目现有 GitHub Actions 使用 Ubuntu 与 Node.js 22。
- 本次本地验证环境为 Linux x86_64、Node.js 26.7.0、npm 11.19.0。
- Node.js 与 npm 可从 https://nodejs.org/ 获取；依赖安装需要访问公开 npm registry。
- `npm ci` 使用随包提供的 `package-lock.json`，无需全局安装 Vite、Vue 或 TypeScript。
- 重建单个浏览器扩展不需要 Git、参考 API 文档子模块、zip 或 B 站账号。
- 只有生成 zip 压缩包的命令需要系统 `zip` 工具；Ubuntu 可使用 `sudo apt-get install zip` 安装。

## 重建 Firefox 扩展

在解压后的源码包根目录执行：

```bash
npm ci
npm run build:firefox
```

生成目录为 `dist/firefox/`，其中包含 `manifest.json`、`background.js`、`content.js`、
`options.html`、`assets/`、`icons/` 等扩展文件，可与同版本 Firefox 安装包中的文件逐一对比。
源码映射文件也由构建自动生成。

Firefox 清单由 `scripts/write-manifest.mjs` 从 `public/manifest.json` 派生：将后台入口改为
`background.scripts`，补充 `browser_specific_settings.gecko` 的扩展 ID、最低版本及数据声明。

可选重建 Chromium：

```bash
npm run build:chromium
```

生成目录为 `dist/chromium/`。如需重建两套目录、安装压缩包与审核源码包，安装系统 zip 后执行 `npm run build`。

## 源码与产物对应关系

| 源文件 | 生成内容 |
| --- | --- |
| `src/background/index.ts` 及其依赖 | `background.js`（ES Module） |
| `src/content/main.ts` 及其依赖、Vue 组件与样式 | `content.js`（IIFE）及 `assets/style.css` |
| `options.html`、`src/options/` 及共享模块 | `options.html` 与 `assets/` 中的设置页脚本及样式 |
| `src/assets/` | `assets/` 中的字体等资源 |
| `public/` | 基础清单与复制到扩展目录的图标 |
| `scripts/`、`vite.config.ts` | 构建、清单派生及归档流程 |

包内没有预编译扩展、`node_modules/`、Git 元数据或本地临时文件。
`docs/bilibili-API-collect` 只供开发时查阅接口文档，不参与构建，因此不包含在源码包中。

## 第三方代码

运行时依赖为 Vue 3 与 Pinia，构建依赖包括 Vite、Vue 插件、TypeScript 和 vue-tsc；
完整版本与传递依赖以 `package-lock.json` 为准，均由 `npm ci` 从公开 registry 安装。
本项目不要求审核员从私有仓库下载额外框架或预编译依赖。

## 生成与提交源码包

```bash
npm run package:source
```

生成 `dist/bilibili-extender-source-v<version>.zip`。该命令可单独执行，无需预先构建。
统一的 `npm run build` 也会在安装包生成后调用此命令，一次生成两套安装包及审核源码包。
包根层的 `README_BUILD.md` 由本文件复制生成；上传到对应扩展版本的 AMO “Source code” 栏。
