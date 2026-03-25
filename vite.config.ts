import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const sharedResolve = {
  alias: {
    '@': resolve(__dirname, 'src')
  }
};

const target = process.env.BUILD_TARGET;
const browserTarget = process.env.BROWSER_TARGET === 'firefox' ? 'firefox' : 'chromium';
const outDir = resolve(__dirname, 'dist', browserTarget);

// Content Script：不支持 ESM，必须构建为 IIFE 并内联所有依赖
const contentConfig = defineConfig({
  plugins: [vue()],
  resolve: sharedResolve,
  build: {
    outDir,
    emptyOutDir: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        content: resolve(__dirname, 'src/content/main.ts')
      },
      output: {
        format: 'iife',
        entryFileNames: 'content.js',
        inlineDynamicImports: true,
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
});

// 页面主世界桥接脚本：使用普通脚本形态注入站点页面，执行需要页面上下文的请求。
const pageBridgeConfig = defineConfig({
  plugins: [vue()],
  resolve: sharedResolve,
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: {
      input: {
        pageBridge: resolve(__dirname, 'src/content/page-bridge.ts')
      },
      output: {
        format: 'iife',
        entryFileNames: 'assets/page-bridge.js',
        inlineDynamicImports: true,
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
});

// Background + Options：支持 ESM 的环境
const mainConfig = defineConfig({
  plugins: [vue()],
  resolve: sharedResolve,
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        options: resolve(__dirname, 'options.html'),
        background: resolve(__dirname, 'src/background/index.ts')
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') {
            return 'background.js';
          }
          return 'assets/[name].js';
        },
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
});

const activeConfig =
  target === 'content'
    ? contentConfig
    : target === 'page-bridge'
      ? pageBridgeConfig
      : mainConfig;

export default activeConfig;
