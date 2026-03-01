type WebExtNamespace = typeof chrome;

/**
 * 统一解析扩展 API 命名空间：
 * - Firefox 优先使用 `browser.*`；
 * - Chromium 回退到 `chrome.*`。
 *
 * 业务层只依赖 `ext`，避免散落的浏览器分支判断。
 */
function resolveWebExtNamespace(): WebExtNamespace {
  const globalScope = globalThis as typeof globalThis & {
    browser?: WebExtNamespace;
    chrome?: WebExtNamespace;
  };

  const api = globalScope.browser ?? globalScope.chrome;
  if (!api) {
    throw new Error('当前环境缺少 WebExtension API 命名空间');
  }

  return api;
}

export const ext = resolveWebExtNamespace();
export type StorageAreaLike = typeof ext.storage.local;
