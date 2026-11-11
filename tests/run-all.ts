/**
 * P0 测试总入口（单进程、按文件名顺序装载）。
 *
 * 为什么不用 `node --test <dir>`：本机沙箱不允许子进程管道（spawn EPERM），
 * 测试运行器会为每个测试文件启动子进程而失败。改为在**同一进程**内依次 import 套件；
 * node:test 会在当前进程注册并执行，失败时进程退出码为 1。
 */
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suitesDir = join(here, 'suites');

const files = (await readdir(suitesDir))
  .filter((name) => name.endsWith('.test.ts'))
  .sort();

process.stdout.write(`[p0] runId=${process.pid} suites=${files.length}\n`);
for (const file of files) {
  process.stdout.write(`[p0] loading ${file}\n`);
  await import(pathToFileURL(join(suitesDir, file)).href);
}
