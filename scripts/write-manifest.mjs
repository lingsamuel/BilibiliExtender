import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGETS = new Set(['chromium', 'firefox']);

function resolveTarget(rawTarget) {
  if (TARGETS.has(rawTarget)) {
    return rawTarget;
  }
  throw new Error(`不支持的构建目标: ${rawTarget ?? '(empty)'}，仅支持 chromium/firefox`);
}

function buildManifest(baseManifest, target) {
  if (target === 'chromium') {
    return baseManifest;
  }

  const backgroundScript = baseManifest.background?.service_worker || 'background.js';

  return {
    ...baseManifest,
    background: {
      scripts: [backgroundScript],
      type: 'module'
    },
    browser_specific_settings: {
      gecko: {
        id: 'bilibili-extender@lingsamuel.com',
        // Firefox 140+ 才提供内建的数据收集同意流程；当前仓库未实现旧版本回退弹窗。
        strict_min_version: '140.0',
        data_collection_permissions: {
          required: ['websiteContent', 'websiteActivity']
        }
      }
    }
  };
}

async function main() {
  const target = resolveTarget(process.argv[2]);
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(currentDir, '..');
  const manifestPath = resolve(projectRoot, 'public', 'manifest.json');
  const distDir = resolve(projectRoot, 'dist', target);
  const distManifestPath = resolve(distDir, 'manifest.json');

  const raw = await readFile(manifestPath, 'utf8');
  const baseManifest = JSON.parse(raw);
  const manifest = buildManifest(baseManifest, target);

  await mkdir(distDir, { recursive: true });
  await writeFile(distManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

await main();
