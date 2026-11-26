/**
 * 浏览器验证脚本的成败判定（R2-04）。
 *
 * 抽成独立模块只为一件事：让"失败必须非零退出"这条规则能被自动化测试直接驱动，
 * 而不是靠人眼看脚本最后一行写的是什么。
 */
export function summarize(checks) {
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  const total = Object.keys(checks).length;
  return { total, passed: total - failed.length, failed };
}

/** 全部通过 → 0；任一失败 → 1。 */
export function exitCodeFor(failed) {
  return failed.length > 0 ? 1 : 0;
}
