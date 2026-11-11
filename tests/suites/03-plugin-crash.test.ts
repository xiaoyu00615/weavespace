/**
 * CT-08：插件故障不得拖垮 Core，且未保存内容必须受保护。
 * 注意：此处只证明「单插件激活失败被隔离 + Core 继续服务」，
 * **不证明**任何沙箱/强隔离能力（同进程，docs/02、RSK-13）。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { createHarness, ISO_UTC_RE } from '../helpers.ts';
import type { PluginManifest } from '../../packages/contracts/types.ts';

test('CT-08 插件激活抛错 → QUARANTINED，其他插件与 Core 不受影响', async () => {
  let dirty = false;
  const h = await createHarness({ hasDirtyState: () => dirty });
  try {
    const markdown = JSON.parse(
      await readFile(resolve(process.cwd(), 'plugins/markdown/manifest.json'), 'utf8'),
    ) as PluginManifest;
    const viewer = JSON.parse(
      await readFile(resolve(process.cwd(), 'plugins/image-viewer/manifest.json'), 'utf8'),
    ) as PluginManifest;

    assert.equal(h.plugins.register(markdown, {}).ok, true);
    assert.equal(
      h.plugins.register(viewer, {
        activate() {
          throw new Error('模拟插件激活阶段崩溃');
        },
      }).ok,
      true,
    );

    await h.plugins.activate(markdown.id);
    const crashed = await h.plugins.activate(viewer.id);

    assert.equal(crashed?.status, 'QUARANTINED');
    assert.equal(crashed?.lastErrorCode, 'ERR_PLUGIN_CRASHED');
    assert.match(String(crashed?.lastErrorAt), ISO_UTC_RE);
    assert.match(String(crashed?.lastErrorMessage), /模拟插件激活阶段崩溃/);
    assert.equal(h.plugins.status(markdown.id)?.status, 'ACTIVE', '健康插件不应受影响');

    // Core 仍可服务命令
    h.permission.grant({ actorId: 'user-a', action: 'read', scope: '' });
    const opened = await h.bus.dispatch(
      {
        commandId: 'cmd-open-1',
        type: 'document.open',
        payload: { resourceId: 'res-1', path: 'a.md', providerId: 'local' },
      },
      { actorId: 'user-a' },
    );
    assert.equal(opened.status, 'APPLIED');
  } finally {
    await h.cleanup();
  }
});

test('CT-08b 存在未保存内容时停用插件被拒绝，插件保持 ACTIVE', async () => {
  let dirty = false;
  const h = await createHarness({ hasDirtyState: () => dirty });
  try {
    const markdown = JSON.parse(
      await readFile(resolve(process.cwd(), 'plugins/markdown/manifest.json'), 'utf8'),
    ) as PluginManifest;
    h.plugins.register(markdown, {});
    await h.plugins.activate(markdown.id);

    h.permission.grant({ actorId: 'user-a', action: 'read', scope: '' });
    h.permission.grant({ actorId: 'user-a', action: 'write', scope: '' });
    const opened = await h.bus.dispatch(
      {
        commandId: 'cmd-open-2',
        type: 'document.open',
        payload: { resourceId: 'res-2', path: 'b.md', providerId: 'local' },
      },
      { actorId: 'user-a' },
    );
    const handle = opened.result as { sessionId: string };

    dirty = true; // 模拟该插件名下存在未保存会话
    const blocked = await h.plugins.deactivate(markdown.id);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.errorCode, 'ERR_PLUGIN_DEACTIVATE_BLOCKED');
    assert.equal(h.plugins.status(markdown.id)?.status, 'ACTIVE');
    assert.equal(h.document.getSession(handle.sessionId)?.dirty, false, '会话本身未被修改');

    dirty = false;
    const ok = await h.plugins.deactivate(markdown.id);
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 'INACTIVE');
  } finally {
    await h.cleanup();
  }
});
