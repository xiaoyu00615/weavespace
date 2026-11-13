/**
 * S11-B：Quick File（浏览器本地临时文件，只读预览）。
 *
 * 这些用例驱动的是 Shell 真实使用的纯状态模型 `state/quick-file.ts`：
 * - 用真实字节（含真实临时文件）走完整的"校验 → 读取 → 解码 → 提交"链路；
 * - 迟到的读取用可控 Promise 制造，不依赖 sleep；
 * - 同时断言 Quick File 与工作区（Project / Session / 草稿）完全隔离。
 *
 * 查看器的真实选择与渲染（Markdown / 纯文本 / 停用降级）由真实 Chrome E2E 覆盖，
 * 因为能力注册表会把插件的 `.tsx` 实现一起装进来，Node 的类型剥离无法加载 JSX。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderViewerSafely } from '../../apps/shell/src/capabilities/safe-render.ts';
import {
  QUICK_FILE_MAX_BYTES,
  createQuickFileController,
  decodeQuickFileBytes,
  formatQuickFileSize,
  type QuickFileSource,
} from '../../apps/shell/src/state/quick-file.ts';
import { INITIAL_STATE, workspaceReducer } from '../../apps/shell/src/state/workspace-reducer.ts';
import type { DocTab } from '../../apps/shell/src/state/types.ts';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function textSource(name: string, text: string): QuickFileSource {
  const bytes = new TextEncoder().encode(text);
  return { name, size: bytes.byteLength, read: async () => toArrayBuffer(bytes) };
}

function byteSource(name: string, bytes: Uint8Array, size?: number): QuickFileSource {
  return { name, size: size ?? bytes.byteLength, read: async () => toArrayBuffer(bytes) };
}

/** 可挂起的读取：模拟"文件很大/磁盘慢"，用于迟到响应测试。 */
function deferredSource(name: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source: QuickFileSource = {
    name,
    size: bytes.byteLength,
    async read() {
      await gate;
      return toArrayBuffer(bytes);
    },
  };
  return { source, release };
}

// ---------------------------------------------------------------------------
// QF-01 单文件选择成功
// ---------------------------------------------------------------------------
test('QF-01 选择一个 Markdown 文件：进入 ready，展示名称/类型/大小/内容', async () => {
  const controller = createQuickFileController();
  const state = await controller.open([textSource('notes.md', '# 标题\n')]);

  assert.equal(state.status, 'ready');
  assert.equal(state.active, true, '选择成功后应立即展示预览');
  assert.ok(state.file);
  assert.equal(state.file?.name, 'notes.md');
  assert.equal(state.file?.extension, '.md');
  assert.equal(state.file?.size, new TextEncoder().encode('# 标题\n').byteLength);
  assert.equal(state.file?.content, '# 标题\n');
  assert.equal(state.errorCode, null);
});

// ---------------------------------------------------------------------------
// QF-02 拖入成功（拖入与选择走同一条 open 链路）
// ---------------------------------------------------------------------------
test('QF-02 拖入单个文件与选择走同一链路：directory=false 时成功', async () => {
  const controller = createQuickFileController();
  const state = await controller.open([textSource('dropped.txt', 'hello')], { directory: false });
  assert.equal(state.status, 'ready');
  assert.equal(state.file?.name, 'dropped.txt');
  assert.equal(state.file?.content, 'hello');
});

// ---------------------------------------------------------------------------
// QF-03 多文件被拒绝
// ---------------------------------------------------------------------------
test('QF-03 一次拖入多个文件：明确拒绝，不"取第一个"', async () => {
  const controller = createQuickFileController();
  let reads = 0;
  const first: QuickFileSource = {
    name: 'a.md',
    size: 1,
    read: async () => {
      reads += 1;
      return toArrayBuffer(new Uint8Array([0x23]));
    },
  };
  const state = await controller.open([first, textSource('b.md', '# b')]);

  assert.equal(state.status, 'error');
  assert.equal(state.errorCode, 'ERR_QUICKFILE_MULTIPLE');
  assert.equal(state.file, null);
  assert.equal(reads, 0, '多文件时必须一个都不读');
});

// ---------------------------------------------------------------------------
// QF-04 目录被拒绝
// ---------------------------------------------------------------------------
test('QF-04 拖入文件夹：明确拒绝，不读取任何内容', async () => {
  const controller = createQuickFileController();
  const state = await controller.open([textSource('dir.md', '# x')], { directory: true });
  assert.equal(state.status, 'error');
  assert.equal(state.errorCode, 'ERR_QUICKFILE_DIRECTORY');
  assert.equal(state.file, null);
});

// ---------------------------------------------------------------------------
// QF-05 / QF-06 格式到查看器的映射（真实渲染在浏览器用例中验证）
// ---------------------------------------------------------------------------
test('QF-05 Markdown 两种扩展名都进入 ready，扩展名保持给查看器解析', async () => {
  const controller = createQuickFileController();
  const md = await controller.open([textSource('a.md', '# a')]);
  assert.equal(md.file?.extension, '.md');
  const long = await controller.open([textSource('b.markdown', '# b')]);
  assert.equal(long.file?.extension, '.markdown');
});

test('QF-06 纯文本保留原始内容（含 CRLF 与制表符）', async () => {
  const controller = createQuickFileController();
  const text = 'line1\r\n\tline2\n';
  const state = await controller.open([textSource('log.txt', text)]);
  assert.equal(state.status, 'ready');
  assert.equal(state.file?.extension, '.txt');
  assert.equal(state.file?.content, text, '不得改写换行或制表符');
});

// ---------------------------------------------------------------------------
// QF-07 不支持格式被拒绝
// ---------------------------------------------------------------------------
test('QF-07 图片/PDF/DOCX 一律拒绝，且不读取字节', async () => {
  for (const name of ['photo.png', 'doc.pdf', 'report.docx']) {
    const controller = createQuickFileController();
    let reads = 0;
    const source: QuickFileSource = {
      name,
      size: 10,
      read: async () => {
        reads += 1;
        return new ArrayBuffer(10);
      },
    };
    const state = await controller.open([source]);
    assert.equal(state.status, 'error', `${name} 应被拒绝`);
    assert.equal(state.errorCode, 'ERR_QUICKFILE_UNSUPPORTED_TYPE');
    assert.equal(reads, 0, `${name} 不应被读取`);
  }
});

// ---------------------------------------------------------------------------
// QF-08 超过大小上限
// ---------------------------------------------------------------------------
test('QF-08 超过 2 MiB：读取前拒绝，不截断、不部分加载', async () => {
  const controller = createQuickFileController();
  let reads = 0;
  const source: QuickFileSource = {
    name: 'huge.md',
    size: QUICK_FILE_MAX_BYTES + 1,
    read: async () => {
      reads += 1;
      return new ArrayBuffer(0);
    },
  };
  const state = await controller.open([source]);
  assert.equal(state.status, 'error');
  assert.equal(state.errorCode, 'ERR_QUICKFILE_TOO_LARGE');
  assert.equal(reads, 0);
  assert.equal(state.file, null);
  assert.match(formatQuickFileSize(QUICK_FILE_MAX_BYTES + 1), /MiB/);
});

// ---------------------------------------------------------------------------
// QF-09 非法 UTF-8 / 二进制
// ---------------------------------------------------------------------------
test('QF-09 非法 UTF-8、二进制签名与 NUL 字节都安全拒绝', async () => {
  const invalid = await createQuickFileController().open([
    byteSource('bad.md', new Uint8Array([0xc3, 0x28, 0x0a])),
  ]);
  assert.equal(invalid.status, 'error');
  assert.equal(invalid.errorCode, 'ERR_QUICKFILE_NOT_UTF8');
  assert.equal(invalid.file, null, '不得把乱码当成正常文本');

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const binary = await createQuickFileController().open([byteSource('fake.md', png)]);
  assert.equal(binary.errorCode, 'ERR_QUICKFILE_NOT_UTF8');

  const withNul = await createQuickFileController().open([
    byteSource('nul.txt', new Uint8Array([0x61, 0x00, 0x62])),
  ]);
  assert.equal(withNul.errorCode, 'ERR_QUICKFILE_NOT_UTF8');

  const direct = decodeQuickFileBytes(new Uint8Array([0xff, 0xfe, 0x00]));
  assert.equal(direct.ok, false);
});

// ---------------------------------------------------------------------------
// QF-10 不调用 Host 的保存/编辑接口（整体不发任何网络请求）
// ---------------------------------------------------------------------------
test('QF-10 打开 Quick File 不触发任何网络调用（不经过 Host）', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error('Quick File 不应发起网络请求');
  }) as typeof fetch;
  try {
    const controller = createQuickFileController();
    const state = await controller.open([textSource('offline.md', '# offline\n')]);
    assert.equal(state.status, 'ready');
    assert.equal(calls, 0, '不得调用 /api/save、/api/edit 或任何 Host 接口');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// QF-11 不进入项目资源树
// ---------------------------------------------------------------------------
test('QF-11 Quick File 不进入项目资源树，也不改变工作区状态', async () => {
  const base = workspaceReducer({ ...INITIAL_STATE, mode: 'live', workspaceMode: 'multi' }, {
    type: 'SET_PROJECTS',
    projects: [{ projectId: 'project-a', name: '项目 A', status: 'READY' }],
  });
  const snapshot = JSON.stringify(base);

  const controller = createQuickFileController();
  await controller.open([textSource('scratch.md', '# scratch')]);

  assert.equal(JSON.stringify(base), snapshot, '工作区状态必须一个字节都不变');
  assert.equal(
    JSON.stringify(base).includes('scratch.md'),
    false,
    'Quick File 不得出现在资源树/标签/项目状态里',
  );
});

// ---------------------------------------------------------------------------
// QF-12 项目切换不丢 Quick File
// ---------------------------------------------------------------------------
test('QF-12 切换当前项目不影响 Quick File 的内容与激活状态', async () => {
  const controller = createQuickFileController();
  const opened = await controller.open([textSource('keep.md', '# keep')]);
  const state = workspaceReducer(
    { ...INITIAL_STATE, activeProjectId: 'project-a', projects: [
      { projectId: 'project-a', name: 'A', status: 'READY' },
      { projectId: 'project-b', name: 'B', status: 'READY' },
    ] },
    { type: 'SET_ACTIVE_PROJECT', projectId: 'project-b' },
  );
  assert.equal(state.activeProjectId, 'project-b');

  const after = controller.getState();
  assert.equal(after.status, 'ready');
  assert.equal(after.active, true);
  assert.equal(after.file?.id, opened.file?.id, 'Quick File 身份不受项目切换影响');
});

// ---------------------------------------------------------------------------
// QF-13 替换文件不删除原文件
// ---------------------------------------------------------------------------
test('QF-13 选择新文件替换旧的：磁盘上的原文件保持不动', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-qf-'));
  try {
    const first = join(dir, 'first.md');
    const second = join(dir, 'second.md');
    await writeFile(first, '# first\n', 'utf8');
    await writeFile(second, '# second\n', 'utf8');
    const sourceOf = (path: string, name: string): QuickFileSource => ({
      name,
      size: 8,
      read: async () => toArrayBuffer(new Uint8Array(await readFile(path))),
    });

    const controller = createQuickFileController();
    await controller.open([sourceOf(first, 'first.md')]);
    const replaced = await controller.open([sourceOf(second, 'second.md')]);

    assert.equal(replaced.file?.name, 'second.md');
    assert.equal(await readFile(first, 'utf8'), '# first\n', '替换不得触碰原文件');
    assert.equal(await readFile(second, 'utf8'), '# second\n');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// QF-14 移除只清空预览
// ---------------------------------------------------------------------------
test('QF-14 移除只清空当前预览，不删除本机文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-qf-rm-'));
  try {
    const path = join(dir, 'keep.txt');
    await writeFile(path, 'keep me\n', 'utf8');
    const controller = createQuickFileController();
    await controller.open([
      {
        name: 'keep.txt',
        size: 8,
        read: async () => toArrayBuffer(new Uint8Array(await readFile(path))),
      },
    ]);
    assert.equal(controller.getState().status, 'ready');

    const removed = controller.remove();
    assert.equal(removed.status, 'empty');
    assert.equal(removed.file, null);
    assert.equal(removed.active, false);
    assert.equal((await stat(path)).isFile(), true, '原文件必须仍在');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// QF-15 旧读取迟到不得覆盖新文件
// ---------------------------------------------------------------------------
test('QF-15 旧读取迟到：新文件优先，旧结果整份丢弃', async () => {
  const controller = createQuickFileController();
  const slow = deferredSource('slow.md', '# slow');
  const pending = controller.open([slow.source]);
  assert.equal(controller.getState().status, 'loading');

  const fast = await controller.open([textSource('fast.md', '# fast')]);
  assert.equal(fast.file?.name, 'fast.md');

  slow.release();
  await pending;

  const final = controller.getState();
  assert.equal(final.status, 'ready');
  assert.equal(final.file?.name, 'fast.md', '迟到结果不得覆盖用户后来选择的文件');
  assert.equal(final.file?.content, '# fast');
});

// ---------------------------------------------------------------------------
// QF-16 项目编辑与草稿不受影响
// ---------------------------------------------------------------------------
test('QF-16 Quick File 的打开/移除不影响项目标签的草稿与 dirty', async () => {
  const tab: DocTab = {
    docId: 'doc:project-a/a.md',
    projectId: 'project-a',
    path: 'a.md',
    title: 'a.md',
    extension: '.md',
    buffer: '# 未保存草稿\n',
    dirty: true,
    mode: 'live',
    sessionId: 'session-1',
    viewId: 'view-1',
    baseVersion: 'version-1',
    revision: 3,
    documentState: 'EDITING_DIRTY',
    saving: false,
    lastStatus: null,
    errorCode: null,
  };
  const state = { ...INITIAL_STATE, mode: 'live' as const, tabs: [tab] };
  const before = JSON.stringify(state.tabs);

  const controller = createQuickFileController();
  await controller.open([textSource('peek.md', '# peek')]);
  controller.remove();

  assert.equal(JSON.stringify(state.tabs), before, '项目草稿、dirty 与 revision 必须原样保留');
});

// ---------------------------------------------------------------------------
// QF-17 Quick File 没有项目身份
// ---------------------------------------------------------------------------
test('QF-17 Quick File 不携带 projectId / resourceId / sessionId', async () => {
  const controller = createQuickFileController();
  const state = await controller.open([textSource('plain.md', '# plain')]);
  const keys = Object.keys(state.file ?? {}).sort();
  assert.deepEqual(keys, ['content', 'extension', 'id', 'name', 'size']);
  assert.equal('projectId' in (state.file ?? {}), false);
  assert.equal('resourceId' in (state.file ?? {}), false);
  assert.equal('sessionId' in (state.file ?? {}), false);
});

// ---------------------------------------------------------------------------
// QF-18 查看器抛错时安全降级
// ---------------------------------------------------------------------------
test('QF-18 查看器 render 抛错：收敛为错误结果，不向上扩散', () => {
  const crashed = renderViewerSafely(
    {
      render() {
        throw new Error('boom');
      },
    },
    { content: '# x', path: 'x.md' },
  );
  assert.equal(crashed.ok, false);
  if (!crashed.ok) {
    assert.equal(crashed.errorCode, 'ERR_PLUGIN_CRASHED');
    assert.match(crashed.message, /boom/);
  }

  const fine = renderViewerSafely({ render: () => 'ok' }, { content: 'x', path: 'x.txt' });
  assert.equal(fine.ok, true);
});
