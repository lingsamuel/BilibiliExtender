# 编码指南

## 构建架构

本项目使用 Vite 多配置构建，导出配置数组以满足不同入口的模块格式需求。

### 为什么需要多配置

Chrome 扩展的不同入口对 JS 模块格式有不同要求：

- **Background Service Worker**：Manifest V3 中可声明 `"type": "module"`，支持 ES Module 格式。
- **Content Script**：由浏览器以普通 `<script>` 方式注入页面，**不支持 ES Module**。如果产物中包含 `import` 语句，会报 `Cannot use import statement outside a module`。
- **Options Page**：作为独立 HTML 页面，通过 `<script type="module">` 加载，支持 ES Module。

因此 Vite 配置导出为数组，每个配置项对应一组入口，分别指定输出格式：

| 入口 | 输出格式 | 原因 |
|------|---------|------|
| background + options | `es` (默认) | 运行环境支持 ESM |
| content script | `iife` | 注入环境不支持 ESM，需自执行函数并内联所有依赖 |

### Content Script 构建要点

- `output.format` 设为 `iife`，确保产物为自执行函数。
- `output.inlineDynamicImports` 设为 `true`，将所有依赖内联到单文件，不产生外部 chunk。
- CSS 通过 `cssCodeSplit: false` 内联处理。

## 构建验证

每次代码变更完成后，必须执行 `npm run build` 确认构建无报错。
