/**
 * CT-11 + ENG-001/002：新增插件不需要修改既有实现；依赖方向可静态检查。
 * 说明：这是"近似架构测试"，不是完整 CI 门禁（未引入 eslint/dependency-cruiser）。
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createHarness } from '../helpers.ts';
import type { PluginManifest } from '../../packages/contracts/types.ts';

const ROOT = process.cwd();

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string) {
    const entries = await readdir(join(ROOT, rel), { withFileTypes: true });
    for (const e of entries) {
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        await walk(childRel);
      } else if (e.name.endsWith('.ts')) {
        out.push(childRel);
      }
    }
  }
  await walk(dir);
  return out;
}

test('CT-11 新增只读查看器插件：仅靠 manifest + module 即可工作，无需改 Core', async () => {
  const h = await createHarness();
  try {
    const viewer = JSON.parse(
      await readFile(resolve(ROOT, 'plugins/image-viewer/manifest.json'), 'utf8'),
    ) as PluginManifest;
    const { createImageViewerPlugin } = await import('../../plugins/image-viewer/index.ts');

    const reg = h.plugins.register(viewer, createImageViewerPlugin());
    assert.equal(reg.ok, true);
    await h.plugins.activate(viewer.id);

    const candidates = h.plugins.candidatesForExtension('.png');
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].provides, ['file.viewer'], '查看器不得声明写能力');
    assert.ok(!candidates[0].requestedPermissions.includes('workspace.write'));
  } finally {
    await h.cleanup();
  }
});

test('CT-11b 同一扩展名可有多个处理器（扩展名不是独占）', async () => {
  const h = await createHarness();
  try {
    const markdown = JSON.parse(
      await readFile(resolve(ROOT, 'plugins/markdown/manifest.json'), 'utf8'),
    ) as PluginManifest;
    const fakeAnalyzer: PluginManifest = {
      ...markdown,
      id: 'probe.analyzer',
      provides: ['file.viewer'],
      requestedPermissions: ['workspace.read'],
    };
    assert.equal(h.plugins.register(markdown, {}).ok, true);
    assert.equal(h.plugins.register(fakeAnalyzer, {}).ok, true);
    await h.plugins.activate(markdown.id);
    await h.plugins.activate(fakeAnalyzer.id);

    const candidates = h.plugins.candidatesForExtension('.md');
    assert.equal(candidates.length, 2, '.md 应同时由多个插件处理');
    const ids = candidates.map((c) => c.pluginId).sort();
    assert.deepEqual(ids, ['probe.analyzer', 'weavespace.markdown']);
  } finally {
    await h.cleanup();
  }
});

test('CT-11c 静态检查：packages 不 import plugins，插件之间不互相 import', async () => {
  const pkgFiles = await listTsFiles('packages');
  assert.ok(pkgFiles.length >= 8, `应扫描到模块文件，实际 ${pkgFiles.length}`);

  for (const rel of pkgFiles) {
    const src = await readFile(resolve(ROOT, rel), 'utf8');
    assert.equal(/from\s+['"][^'"]*\/plugins\//.test(src), false, `${rel} 不得依赖 plugins/`);
    assert.equal(/from\s+['"][^'"]*[\\/]apps[\\/]/.test(src), false, `${rel} 不得依赖 apps/`);
  }

  const pluginFiles = await listTsFiles('plugins');
  for (const rel of pluginFiles) {
    const src = await readFile(resolve(ROOT, rel), 'utf8');
    // 插件不得 import 其他插件的实现目录
    assert.equal(
      /from\s+['"][^'"]*..\/[a-z-]+\/(?!\.\.)/.test(src),
      false,
      `${rel} 不得跨插件 import 实现`,
    );
  }

  const contractsFiles = await listTsFiles('packages/contracts');
  for (const rel of contractsFiles) {
    const src = await readFile(resolve(ROOT, rel), 'utf8');
    assert.equal(
      /from\s+['"]\.\.\/(?!contracts)/.test(src),
      false,
      `contracts/${rel} 不得反向依赖具体实现（ENG-002）`,
    );
  }
});

test('CT-11d 每个模块具备单一公开入口 index.ts 与最小 README（ENG-001/ENG-005）', async () => {
  const modules = (await readdir(resolve(ROOT, 'packages'), { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.ok(modules.length >= 6, `模块数量异常: ${modules.join(',')}`);
  for (const mod of modules) {
    const files = await readdir(resolve(ROOT, 'packages', mod));
    assert.ok(files.includes('index.ts'), `${mod} 缺少唯一公开入口 index.ts`);
  }
  // README 逐步补齐：contracts 的 README 在下一小步补；先断言已有模块
  for (const mod of ['storage', 'document', 'permission', 'command', 'plugin-runtime']) {
    const files = await readdir(resolve(ROOT, 'packages', mod));
    assert.ok(files.includes('README.md'), `${mod} 缺少最小 README`);
  }
});

test('CT-11e 插件源码不直接访问 fs / 网络（能力边界）', async () => {
  const pluginFiles = await listTsFiles('plugins');
  for (const rel of pluginFiles) {
    const src = await readFile(resolve(ROOT, rel), 'utf8');
    assert.equal(/from\s+['"](node:)?fs/.test(src), false, `${rel} 不得直接读文件系统`);
    assert.equal(/from\s+['"](node:)?(http|https|net|dgram)/.test(src), false, `${rel} 不得开网络`);
  }
});
