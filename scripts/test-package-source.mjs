import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 副本不含 Git、依赖与已有构建，确保打包没有偷偷依赖开发环境。
async function withProject(run) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'bbe-source-test-'));
  const fixture = join(temporaryRoot, 'project');
  try {
    await cp(projectRoot, fixture, {
      recursive: true,
      filter: (source) => {
        const entry = relative(projectRoot, source);
        return !['.git', 'node_modules', 'dist', '.claude', '.codex', '.tmp', 'ref'].includes(entry.split('/')[0])
          && !entry.startsWith('docs/bilibili-API-collect')
          && !entry.endsWith('.zip');
      }
    });
    await run(fixture, temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function runScript(fixture, cwd, env = process.env) {
  return spawnSync(process.execPath, [join(fixture, 'scripts/package-source.mjs')], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

async function assertNoStaging(fixture) {
  const entries = await readdir(join(fixture, 'dist'));
  assert.ok(!entries.some((name) => name.startsWith('.source-')), entries.join(', '));
}

test('独立命令生成完整源码包，排除本地文件且重复打包不保留旧条目', async () => {
  await withProject(async (fixture, temporaryRoot) => {
    await mkdir(join(fixture, 'dist'), { recursive: true });
    await mkdir(join(fixture, 'node_modules'), { recursive: true });
    await writeFile(join(fixture, 'dist/old-build.txt'), '旧构建');
    await writeFile(join(fixture, 'node_modules/local.txt'), '本地依赖');
    await writeFile(join(fixture, '.env'), 'LOCAL_ONLY=1');
    await writeFile(join(fixture, 'local.zip'), '本地归档');
    const packaged = spawnSync('npm', ['--prefix', fixture, 'run', 'package:source'], {
      cwd: temporaryRoot,
      encoding: 'utf8'
    });
    assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout);
    const { version } = JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8'));
    const archive = join(fixture, 'dist', `bilibili-extender-source-v${version}.zip`);
    const listed = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    const entries = listed.stdout.trim().split('\n');
    for (const required of ['package-lock.json', 'public/manifest.json', 'vite.config.ts', 'tsconfig.json', 'options.html', 'src/content/main.ts', 'src/background/index.ts', 'scripts/write-manifest.mjs', 'docs/source_build.md', 'README_BUILD.md']) {
      assert.ok(entries.includes(required), `源码包缺少 ${required}`);
    }
    assert.ok(!entries.some((entry) => /(^|\/)(node_modules|dist|\.git|\.env|local\.zip|bilibili-API-collect)(\/|$)/.test(entry)));
    const readme = spawnSync('unzip', ['-p', archive, 'README_BUILD.md'], { encoding: 'utf8' });
    assert.equal(readme.stdout, await readFile(join(fixture, 'docs/source_build.md'), 'utf8'));
    await writeFile(join(fixture, 'obsolete.txt'), '旧归档残留');
    const contaminated = spawnSync('zip', ['-q', archive, 'obsolete.txt'], { cwd: fixture, encoding: 'utf8' });
    assert.equal(contaminated.status, 0, contaminated.stderr);
    const repeated = runScript(fixture, temporaryRoot);
    assert.equal(repeated.status, 0, repeated.stderr);
    const relisted = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8' });
    assert.ok(!relisted.stdout.includes('obsolete.txt'));
    await assertNoStaging(fixture);
  });
});

test('必要文件缺失时打包失败并清理暂存目录', async () => {
  await withProject(async (fixture, temporaryRoot) => {
    await rm(join(fixture, 'options.html'));
    const result = runScript(fixture, temporaryRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /options\.html/);
    await assertNoStaging(fixture);
  });
});

test('zip 失败时保留失败状态并清理暂存目录', async () => {
  await withProject(async (fixture, temporaryRoot) => {
    const bin = join(temporaryRoot, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'zip'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });
    const result = runScript(fixture, temporaryRoot, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /zip.*42/);
    await assertNoStaging(fixture);
  });
});
