/**
 * CT-01：安装 Markdown 插件 — 被发现、校验、激活，并记录耗时与时间。
 * 也覆盖：重复 id、apiVersion 不支持、清单非法（ENG-003 契约测试的最小形态）。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { createHarness, ISO_UTC_RE } from '../helpers.ts';
import type { PluginManifest } from '../../packages/contracts/types.ts';

async function loadManifest(relPath: string): Promise<PluginManifest> {
  const raw = await readFile(resolve(process.cwd(), relPath), 'utf8');
  return JSON.parse(raw) as PluginManifest;
}

test('CT-01 Markdown 插件：校验 → 注册 → 激活，记录 UTC 时间与耗时', async () => {
  const h = await createHarness();
  try {
    const manifest = await loadManifest('plugins/markdown/manifest.json');
    const registered = h.plugins.register(manifest);
    assert.equal(registered.ok, true);
    assert.deepEqual(registered.violations, undefined);
    assert.equal(registered.record?.status, 'REGISTERED');
    assert.match(String(registered.record?.registeredAt), ISO_UTC_RE);

    const activated = await h.plugins.activate(manifest.id);
    assert.equal(activated?.status, 'ACTIVE');
    assert.match(String(activated?.activatedAt), ISO_UTC_RE, 'activatedAt 必须是 UTC ISO 8601');
    assert.equal(typeof activated?.activationDurationMs, 'number');
    assert.ok((activated?.activationDurationMs ?? -1) >= 0);

    const candidates = h.plugins.candidatesForExtension('.md');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].pluginId, 'weavespace.markdown');

    // 激活事件必须进入日志，可按 pluginId 追踪（OBS-002）
    const activationLog = h.memorySink.records.find((r) => r.event === 'PLUGIN_ACTIVATED');
    assert.ok(activationLog, '应有 PLUGIN_ACTIVATED 日志');
    assert.equal(activationLog?.pluginId, 'weavespace.markdown');
    assert.match(String(activationLog?.timestamp), ISO_UTC_RE);
  } finally {
    await h.cleanup();
  }
});

test('CT-01b 重复插件 id 被拒绝，且不覆盖已有记录', async () => {
  const h = await createHarness();
  try {
    const manifest = await loadManifest('plugins/markdown/manifest.json');
    assert.equal(h.plugins.register(manifest).ok, true);
    const dup = h.plugins.register({ ...manifest, version: '9.9.9' });
    assert.equal(dup.ok, false);
    assert.equal(dup.errorCode, 'ERR_PLUGIN_DUPLICATE_ID');
    assert.equal(h.plugins.status(manifest.id)?.version, '0.1.0');
  } finally {
    await h.cleanup();
  }
});

test('CT-01c apiVersion 不支持 → BLOCKED_DEPENDENCY，Core 仍健康', async () => {
  const h = await createHarness();
  try {
    const manifest = await loadManifest('plugins/markdown/manifest.json');
    const result = h.plugins.register({ ...manifest, id: 'probe.future', apiVersion: '99.0' });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'ERR_PLUGIN_INCOMPATIBLE');
    assert.equal(result.record?.status, 'BLOCKED_DEPENDENCY');
    assert.equal(h.plugins.list().length, 1);
  } finally {
    await h.cleanup();
  }
});

test('CT-01d 清单非法 → ERR_PLUGIN_INVALID_MANIFEST 并给出字段级原因', async () => {
  const h = await createHarness();
  try {
    const result = h.plugins.register({
      id: 'Bad_ID',
      version: '1.0',
      apiVersion: '0.1',
      fileExtensions: ['md'],
      provides: [],
      requires: [],
      requestedPermissions: [],
      activationEvents: [],
      entrypoints: {},
    } as unknown as PluginManifest);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'ERR_PLUGIN_INVALID_MANIFEST');
    const fields = (result.violations ?? []).map((v) => v.field);
    assert.ok(fields.includes('id'));
    assert.ok(fields.includes('version'));
    assert.ok(fields.includes('fileExtensions'));
    assert.ok(fields.includes('provides'));
    assert.ok(fields.includes('entrypoints'));
  } finally {
    await h.cleanup();
  }
});
