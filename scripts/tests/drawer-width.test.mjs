import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as vue from 'vue';

// 使用项目已有的 TypeScript 编译器加载真实模块，仅替换浏览器 API 与生命周期边界。
function compile(relativePath) {
  return ts.transpileModule(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
}

const constants = {};
vm.runInNewContext(compile('../../src/shared/constants.ts'), { exports: constants });
const widthKey = constants.STORAGE_KEYS.DRAWER_WIDTH;
const widthCode = compile('../../src/content/drawer-width.ts');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createStorage(initialWidth) {
  const values = initialWidth === undefined ? {} : { [widthKey]: initialWidth };
  const listeners = new Set();
  const writes = [];
  return {
    values, listeners, writes,
    emit(width, area = 'local') {
      for (const listener of listeners) listener({ [widthKey]: { newValue: width } }, area);
    },
    async get() { return { ...values }; },
    async set(update) {
      Object.assign(values, update);
      writes.push(update);
      this.emit(update[widthKey]);
    }
  };
}

function mountPage(storage, { legacy = null, blockedLegacy = false, get, set } = {}) {
  const mounted = [];
  const unmounted = [];
  const events = new Map();
  const warnings = [];
  const local = new Map(legacy === null ? [] : [['bbe-drawer-width', legacy]]);
  const ext = {
    storage: {
      local: { get: get ?? storage.get.bind(storage), set: set ?? storage.set.bind(storage) },
      onChanged: {
        addListener: (listener) => storage.listeners.add(listener),
        removeListener: (listener) => storage.listeners.delete(listener)
      }
    }
  };
  const exports = {};
  vm.runInNewContext(widthCode, {
    exports,
    require(name) {
      if (name === 'vue') return { ...vue, onMounted: (cb) => mounted.push(cb), onUnmounted: (cb) => unmounted.push(cb) };
      if (name === '@/shared/constants') return constants;
      if (name === '@/shared/platform/webext') return { ext };
      if (name === '@/shared/utils/debug-console') return { debugWarn: (...args) => warnings.push(args) };
      throw new Error(`未预期的依赖：${name}`);
    },
    window: { innerWidth: 2000 },
    document: {
      addEventListener: (name, cb) => events.set(name, cb),
      removeEventListener: (name, cb) => { if (events.get(name) === cb) events.delete(name); }
    },
    localStorage: {
      getItem(key) {
        if (blockedLegacy) throw new Error('页面存储不可用');
        return local.get(key) ?? null;
      },
      setItem() { assert.fail('新版本不应再写入网页存储'); }
    }
  });
  const state = exports.useDrawerWidth();
  mounted.forEach((cb) => cb());
  return {
    ...state, events, warnings,
    start: () => state.onResizeStart({ clientX: 1000, preventDefault() {} }),
    move: (clientX) => events.get('mousemove')?.({ clientX }),
    end: () => events.get('mouseup')?.(),
    unmount: () => unmounted.forEach((cb) => cb())
  };
}

test('拖拽结束保存共享宽度，新子域名页面继承该宽度', async () => {
  const storage = createStorage();
  const first = mountPage(storage);
  await flush();
  first.start();
  first.move(700);
  assert.equal(storage.writes.length, 0);
  first.end();
  const second = mountPage(storage);
  await flush();
  assert.equal(second.drawerWidth.value, 1200);
  assert.equal(storage.values[widthKey], 1200);
});

test('迁移旧页面设置，并通知已经打开的新页面', async () => {
  const storage = createStorage();
  const fresh = mountPage(storage);
  await flush();
  assert.equal(storage.writes.length, 0, '没有旧值时不能用默认值占用共享存储');
  const legacy = mountPage(storage, { legacy: '1250' });
  await flush();
  assert.equal(legacy.drawerWidth.value, 1250);
  assert.equal(fresh.drawerWidth.value, 1250);
  assert.equal(storage.values[widthKey], 1250);
});

test('已有共享值优先，其他源的旧值不能覆盖它', async () => {
  const storage = createStorage(1300);
  const page = mountPage(storage, { legacy: '1000' });
  await flush();
  assert.equal(page.drawerWidth.value, 1300);
  assert.equal(storage.writes.length, 0);
});

test('拒绝非有限值、非数字共享值和小于最小宽度的值', async () => {
  for (const invalid of [NaN, Infinity, -Infinity, 499, '1200', null, {}, true]) {
    const storage = createStorage(invalid);
    const page = mountPage(storage, { legacy: 'Infinity' });
    await flush();
    assert.equal(page.drawerWidth.value, 900);
    assert.equal(storage.writes.length, 0);
  }
  const storage = createStorage(Infinity);
  const page = mountPage(storage, { legacy: '1100.4' });
  await flush();
  assert.equal(page.drawerWidth.value, 1100);
  assert.equal(storage.values[widthKey], 1100);
});

test('页面存储被禁用时仍能加载共享值或使用默认值', async () => {
  for (const saved of [undefined, 1200]) {
    const page = mountPage(createStorage(saved), { blockedLegacy: true });
    await flush();
    assert.equal(page.drawerWidth.value, saved ?? 900);
  }
});

test('扩展存储读写失败时保留可操作的宽度且处理错误', async () => {
  const storage = createStorage();
  const page = mountPage(storage, {
    get: async () => { throw new Error('读取失败'); },
    set: async () => { throw new Error('保存失败'); }
  });
  await flush();
  assert.equal(page.drawerWidth.value, 900);
  page.start();
  page.move(700);
  page.end();
  await flush();
  assert.equal(page.drawerWidth.value, 1200);
  assert.equal(page.warnings.length, 2);
});

test('迟到的初始化结果不能覆盖拖拽结果，也不能迁移过时旧值', async () => {
  const storage = createStorage();
  const pending = deferred();
  const page = mountPage(storage, { legacy: '1500', get: () => pending.promise });
  page.start();
  page.move(700);
  page.end();
  pending.resolve({});
  await flush();
  assert.equal(page.drawerWidth.value, 1200);
  assert.equal(storage.values[widthKey], 1200);
  assert.equal(storage.writes.length, 1);
});

test('初始化期间收到存储更新后，忽略旧读取快照', async () => {
  const storage = createStorage(1000);
  const pending = deferred();
  const page = mountPage(storage, { get: () => pending.promise });
  await storage.set({ [widthKey]: 1400 });
  pending.resolve({ [widthKey]: 1000 });
  await flush();
  assert.equal(page.drawerWidth.value, 1400);
});

test('拖拽期间忽略其他页面的更新，结束后以当前用户操作为准', async () => {
  const storage = createStorage(1000);
  const page = mountPage(storage);
  const other = mountPage(storage);
  await flush();
  page.start();
  page.move(800);
  await storage.set({ [widthKey]: 1600 });
  assert.equal(page.drawerWidth.value, 1200);
  page.end();
  await flush();
  assert.equal(other.drawerWidth.value, 1200);
  assert.equal(storage.values[widthKey], 1200);
});

test('卸载时清理拖拽和存储监听，并忽略尚未完成的初始化', async () => {
  const storage = createStorage();
  const pending = deferred();
  const page = mountPage(storage, { legacy: '1500', get: () => pending.promise });
  page.start();
  page.move(800);
  page.unmount();
  pending.resolve({});
  await flush();
  assert.equal(page.events.size, 0);
  assert.equal(storage.listeners.size, 0);
  assert.equal(storage.writes.length, 0);
  assert.equal(page.drawerWidth.value, 1100);
});

test('沿用拖拽边界与视口显示规则，仅响应 local 存储变更', async () => {
  const storage = createStorage();
  const page = mountPage(storage);
  await flush();
  storage.emit(1600, 'sync');
  assert.equal(page.drawerWidth.value, 900);
  page.start();
  page.move(2000);
  assert.equal(page.drawerWidth.value, 500);
  page.move(-2000);
  assert.equal(page.drawerWidth.value, 1900);
  assert.equal(page.drawerStyle.value.width, 'min(1900px, 88vw)');
  page.end();
  storage.emit(undefined);
  assert.equal(page.drawerWidth.value, 900);
});
