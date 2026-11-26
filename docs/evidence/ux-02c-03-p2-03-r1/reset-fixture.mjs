/**
 * 把 P2-03 的测试 Workspace 恢复到"干净初始态"。
 *
 * 为什么需要它：这一轮要反复做"移入 → 恢复 → 重启"的真实磁盘操作，任何一次中断都会
 * 留下 trash 记录。脚本只碰 `weavespace-test/p203`（专用测试目录），不碰用户真实文件。
 *
 * 用法：先停 Host，再 `node reset-fixture.mjs`，然后重新启动 Host。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = 'D:/Workspace/projects/weavespace-test/p203';
const GOLDEN = join(BASE, 'golden');
const STORE = join(BASE, 'store/workspace.json');

/* 1) 重建 golden（只在不存在时创建，避免把被测试改过的内容当成基线） */
function seedGolden() {
  if (existsSync(GOLDEN)) return;
  const files = {
    'projA/note.md': '# hello\n\nmarkdown body\n',
    'projA/plain.txt': 'plain text line\nsecond line\n',
    'projA/中文名.txt': '中文内容与标点：测试。\n',
    'projA/with space.txt': 'space name file\n',
    'projA/notes/deep.md': '# deep\n\nin subdirectory\n',
    'projB/b-only.md': '# b only\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = join(GOLDEN, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  // 二进制：0..255 循环 4 次（含 0x00 / 0xFF，能暴露文本化损坏）
  mkdirSync(join(GOLDEN, 'projA'), { recursive: true });
  writeFileSync(join(GOLDEN, 'projA/blob.bin'), Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256)));
}

mkdirSync(BASE, { recursive: true });
seedGolden();

/* 2) 还原两个项目目录 */
for (const name of ['projA', 'projB']) {
  const target = join(BASE, name);
  rmSync(target, { recursive: true, force: true });
  cpSync(join(GOLDEN, name), target, { recursive: true });
  rmSync(join(target, '.weavespace'), { recursive: true, force: true });
  mkdirSync(join(target, '.weavespace'), { recursive: true });
  writeFileSync(join(target, '.weavespace/.gitignore'), '*\n');
}

/* 3) store：不存在就按"两个真实项目"建一份；存在就把回收记录清空 */
const { serializeConfig } = await import('file:///D:/Workspace/projects/weavespace/apps/server/src/store/config.ts');
const { rootTokenOf } = await import('file:///D:/Workspace/projects/weavespace/packages/storage/path-safety.ts');

mkdirSync(join(BASE, 'store'), { recursive: true });
let raw;
if (existsSync(STORE)) {
  raw = JSON.parse(readFileSync(STORE, 'utf8'));
} else {
  raw = {
    version: 4,
    commitSeq: 0,
    issuedIds: ['proj-a', 'proj-b'],
    revoked: [],
    projects: [
      { projectId: 'proj-a', name: '项目A', rootDir: join(BASE, 'projA') },
      { projectId: 'proj-b', name: '项目B', rootDir: join(BASE, 'projB') },
    ],
    hidden: [],
    trash: [],
  };
}
// 目录被重建过 → inode 变了：rootToken 必须重算，否则 Host 会判 ROOT_TOKEN_CHANGED
for (const project of raw.projects) {
  project.canonicalRoot = project.rootDir;
  project.rootToken = rootTokenOf(project.rootDir);
  project.grantedAt ??= '2026-11-27T00:00:00.000Z';
  project.grantSource ??= 'os-dialog';
}
raw.trash = [];
raw.hidden = [];
writeFileSync(STORE, serializeConfig(raw));

console.log(
  JSON.stringify({
    restored: readdirSync(join(BASE, 'projA')),
    trash: raw.trash.length,
    seq: raw.commitSeq,
  }),
);
