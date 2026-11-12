/**
 * 能力标识与版本兼容（S10-A）。
 *
 * 标识形如 `file.viewer`，可选后缀 `@<major>`；缺省视为宿主主版本。
 * 只校验**主版本**：能力契约允许同一主版本内向后兼容地增量演进，
 * 次版本差异不阻止加载（docs/05「API 兼容检查」的最小形态）。
 *
 * 本文件刻意不 import 任何 Node 内建模块：能力注册既要在 Core 侧（Node）
 * 校验，也要在 Shell 侧（浏览器）解析查看器，两侧必须共用同一实现。
 */

/** 宿主当前支持的能力契约主版本。 */
export const CAPABILITY_API_MAJOR = 1;

export interface CapabilityRef {
  /** 不含版本后缀的能力名，例如 `file.viewer`。 */
  name: string;
  /** 主版本号；缺省后缀时为 `CAPABILITY_API_MAJOR`。 */
  major: number;
  /** 原始声明串，便于诊断输出。 */
  raw: string;
}

const NAME_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

export function parseCapabilityRef(raw: string): CapabilityRef | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const at = trimmed.lastIndexOf('@');
  const name = at === -1 ? trimmed : trimmed.slice(0, at);
  const versionPart = at === -1 ? '' : trimmed.slice(at + 1);

  if (!NAME_RE.test(name)) return null;
  if (versionPart === '') return { name, major: CAPABILITY_API_MAJOR, raw: trimmed };
  if (!/^[0-9]+$/.test(versionPart)) return null;
  return { name, major: Number(versionPart), raw: trimmed };
}

/** 主版本一致即可用；更高主版本视为不兼容（不做静默降级）。 */
export function isCapabilityCompatible(ref: CapabilityRef): boolean {
  return ref.major === CAPABILITY_API_MAJOR;
}

/** 去掉版本后缀，得到稳定的能力名（用于 `provides` 查找）。 */
export function capabilityName(raw: string): string {
  return parseCapabilityRef(raw)?.name ?? raw;
}
