/**
 * 把 UX-02C-04-R1 的测试 Workspace 恢复到"干净初始态"。
 *
 * 只碰 `D:/Workspace/projects/weavespace-test/c04r1`（本轮专用测试目录），
 * 不碰用户真实文件，也不碰上一轮 c04 的目录（那轮证据要能独立复读）。
 *
 * 目录会被重建 → inode 变化 → **rootToken 必须重算**，否则 Host 判
 * `ROOT_TOKEN_CHANGED`，整轮验证测的是一个不可用的项目。
 *
 * 配置写成 **v5 + metadata: []**：这一轮不再验证"v4 升 v5"（那是 UX-02C-04 的事），
 * 而是从"已有 v5 结构、零记录"开始，避免把两件事混在一个证据里。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = 'D:/Workspace/projects/weavespace-test/c04r1';
const GOLDEN = join(BASE, 'golden');
const STORE = join(BASE, 'store/workspace.json');
const ROOT = join(BASE, 'projA');

const FILES = {
  'projA/same.md': '# A original\n\n被回收的那一个（原文件 A）\n',
  'projA/keep.md': '# keep\n\n不会被碰的文件\n',
  'projA/dir/nested.md': '# nested\n',
};

mkdirSync(BASE, { recursive: true });
for (const [rel, content] of Object.entries(FILES)) {
  const full = join(GOLDEN, rel);
  mkdirSync(dirname(full), { recursive: true });
  if (!existsSync(full)) writeFileSync(full, content);
}

rmSync(ROOT, { recursive: true, force: true });
cpSync(join(GOLDEN, 'projA'), ROOT, { recursive: true });
// 上一次留下的回收区/回收标记必须清掉，否则"回收区里只有一条"这类断言会带上历史
rmSync(join(ROOT, '.weavespace'), { recursive: true, force: true });
mkdirSync(join(ROOT, '.weavespace'), { recursive: true });
writeFileSync(join(ROOT, '.weavespace/.gitignore'), '*\n');

const { serializeConfig } = await import(
  'file:///D:/Workspace/projects/weavespace/apps/server/src/store/config.ts'
);
const { rootTokenOf } = await import('file:///D:/Workspace/projects/weavespace/packages/storage/path-safety.ts');

mkdirSync(join(BASE, 'store'), { recursive: true });

let prior = null;
if (existsSync(STORE)) {
  try {
    prior = JSON.parse(readFileSync(STORE, 'utf8'));
  } catch {
    prior = null;
  }
}

const config = {
  version: 5,
  // 序号只增不减：日志/证据里出现倒退的 seq 会让人怀疑是不是读错了文件
  commitSeq: prior?.commitSeq ?? 0,
  issuedIds: ['proj-a'],
  revoked: [],
  projects: [
    {
      projectId: 'proj-a',
      name: '项目A',
      rootDir: ROOT,
      canonicalRoot: ROOT,
      rootToken: rootTokenOf(ROOT),
      grantedAt: '2026-11-27T00:00:00.000Z',
      grantSource: 'os-dialog',
    },
  ],
  hidden: [],
  trash: [],
  metadata: [],
};

writeFileSync(STORE, serializeConfig(config));
// 锁文件残留会让 Host 以 `ERR_STORE_LOCKED` 拒绝启动（LOCK_FILE = 'workspace.lock'）
rmSync(join(BASE, 'store/workspace.lock'), { force: true });

console.log(
  JSON.stringify({
    root: ROOT,
    files: readdirSync(ROOT),
    version: config.version,
    metadata: config.metadata.length,
    rootToken: config.projects[0].rootToken,
    seq: config.commitSeq,
  }),
);
