import { readdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const BUILD_TARGETS = ['chromium', 'firefox'];

function runZip(args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('zip', args, {
      cwd,
      stdio: 'inherit'
    });

    child.once('error', rejectPromise);
    child.once('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`zip 执行失败，退出码: ${code ?? '(null)'}`));
    });
  });
}

async function packageTarget(projectRoot, version, target) {
  const targetDir = resolve(projectRoot, 'dist', target);
  const archivePath = resolve(projectRoot, 'dist', `bilibili-extender-${target}-v${version}.zip`);
  const entries = (await readdir(targetDir)).sort();

  if (entries.length === 0) {
    throw new Error(`构建产物目录为空，无法打包: ${targetDir}`);
  }

  // 先删除旧压缩包，避免 zip 在已有文件上追加旧条目。
  await rm(archivePath, { force: true });
  await runZip(['-qr', archivePath, ...entries], targetDir);
}

async function main() {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(currentDir, '..');
  const packageJsonPath = resolve(projectRoot, 'package.json');
  const rawPackageJson = await readFile(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(rawPackageJson);
  const version = packageJson.version;

  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('package.json 缺少合法 version，无法生成发布压缩包');
  }

  for (const target of BUILD_TARGETS) {
    await packageTarget(projectRoot, version, target);
  }
}

await main();
