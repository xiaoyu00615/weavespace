/**
 * 重载前的草稿备份门禁（S9B-F03）。
 *
 * 规则：
 * - 至少一条备份通路成功（本标签页 sessionStorage / 剪贴板）才允许执行重载；
 * - 两条都失败时必须**不调用重载**，由 UI 提示用户手动复制；
 * - 备份动作本身的异常按「失败」处理，不得中断流程或抛出。
 *
 * 抽成纯函数是为了能在 Node 里直接覆盖三条分支（不依赖浏览器环境）。
 */

export interface DraftBackupPorts {
  /** 写入本标签页（sessionStorage）。返回是否成功，允许抛错。 */
  saveLocal(content: string): boolean;
  /** 复制到剪贴板。返回是否成功，允许拒绝。 */
  copy(content: string): Promise<boolean>;
  /** 真正执行重载（丢弃草稿）。只有当至少一条备份成功时才会被调用。 */
  reload(): Promise<boolean>;
}

export interface DraftBackupResult {
  /** 是否满足「可以继续重载」的前提（至少一条备份成功）。 */
  ok: boolean;
  local: boolean;
  clipboard: boolean;
  /** 是否真的执行过重载。 */
  reloaded: boolean;
}

export async function backupDraftBeforeReload(
  draft: string,
  ports: DraftBackupPorts,
): Promise<DraftBackupResult> {
  let local = false;
  try {
    local = ports.saveLocal(draft) === true;
  } catch {
    local = false;
  }

  let clipboard = false;
  try {
    clipboard = (await ports.copy(draft)) === true;
  } catch {
    clipboard = false;
  }

  if (!local && !clipboard) {
    return { ok: false, local, clipboard, reloaded: false };
  }

  const reloaded = await ports.reload();
  return { ok: true, local, clipboard, reloaded };
}
