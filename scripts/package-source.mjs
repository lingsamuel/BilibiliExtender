import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runZip } from './archive-utils.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 沿用 Nesoi 的显式清单，避免把本地文件、已构建代码或庞大的 API 文档子模块交给审核员。
const SOURCE_FILES = [
  'README.md',
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'tsconfig.json',
  'index.html',
  'options.html',
  'docs/source_build.md'
];
const SOURCE_DIRS = ['src', 'public', 'scripts'];
const BUILD_README_SOURCE = 'docs/source_build.md';
const BUILD_README_NAME = 'README_BUILD.md';

/**
 * 独立生成审核源码包，不依赖已有构建或 Git；可从任意工作目录调用。
 * 构建说明保留 docs 下的正文，并复制到包根层，保证解压后也能再次执行本命令。
 */
async function main() {
  const packageJson = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
  const version = packageJson.version;
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('package.json 缺少合法 version，无法生成源码包');
  }

  const distDir = resolve(projectRoot, 'dist');
  const archivePath = resolve(distDir, `bilibili-extender-source-v${version}.zip`);
  await mkdir(distDir, { recursive: true });
  // 唯一暂存目录避免同时打包时互相删除中间文件；失败路径也由 finally 清理。
  const stagingDir = await mkdtemp(resolve(distDir, '.source-'));
  try {
    for (const file of SOURCE_FILES) {
      const target = resolve(stagingDir, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(resolve(projectRoot, file), target);
    }
    for (const dir of SOURCE_DIRS) {
      await cp(resolve(projectRoot, dir), resolve(stagingDir, dir), { recursive: true });
    }
    await cp(resolve(stagingDir, BUILD_README_SOURCE), resolve(stagingDir, BUILD_README_NAME));

    // zip 会更新已有归档，先删除才能保证本次不残留已从源码移除的旧条目。
    await rm(archivePath, { force: true });
    await runZip(['-qr', archivePath, '.'], stagingDir);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
  console.log(`源码包已生成：${archivePath}`);
  console.log('上传方式：对应 AMO 版本页面的「Source code」栏。');
}

await main();
