/**
 * 把 UX-02C-04 的测试 Workspace 恢复到"干净初始态"。
 *
 * 只碰 `D:/Workspace/projects/weavespace-test/c04`（专用测试目录），不碰用户真实文件。
 * 每次重建目录都会改变 inode，因此 **rootToken 必须重算**，否则 Host 会判
 * `ROOT_TOKEN_CHANGED`，整轮验证都在测一个不可用的项目。
 *
 * 用法：先停 Host，再 `node reset-fixture.mjs`，然后重新启动 Host。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = 'D:/Workspace/projects/weavespace-test/c04';
const GOLDEN = join(BASE, 'golden');
const STORE = join(BASE, 'store/workspace.json');

function seedGolden() {
  if (existsSync(GOLDEN)) return;
  const files = {
    'projA/note.md': '# note\n\nmarkdown body for metadata verification\n',
    'projA/same.md': '# A same\n',
    'projA/docs/guide.md': '# guide\n\nin docs directory\n',
    'projB/same.md': '# B same\n',
    'projB/other.md': '# other\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = join(GOLDEN, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

mkdirSync(BASE, { recursive: true });
seedGolden();

for (const name of ['projA', 'projB']) {
  const target = join(BASE, name);
  rmSync(target, { recursive: true, force: true });
  cpSync(join(GOLDEN, name), target, { recursive: true });
  rmSync(join(target, '.weavespace'), { recursive: true, force: true });
  mkdirSync(join(target, '.weavespace'), { recursive: true });
  writeFileSync(join(target, '.weavespace/.gitignore'), '*\n');
}

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
/*
 * 元数据也清空，并且**固定从 v4 开始**：这一轮要验证"第一次设置时配置升到 v5"，
 * 若上一轮已经写成 v5，这条路径就永远走不到。
 */
raw.metadata = [];
raw.version = 4;

writeFileSync(STORE, serializeConfig(raw));

console.log(
  JSON.stringify({
    restored: readdirSync(join(BASE, 'projA')),
    version: raw.version,
    metadata: raw.metadata.length,
    seq: raw.commitSeq,
  }),
);
