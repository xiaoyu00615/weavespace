/**
 * 从 `StorageProvider.list()` 的相对路径列表构造资源树（S9-B）。
 *
 * 只做「路径 → 树」的映射，不做磁盘访问；排序固定为「目录在前、同名按字典序」，
 * 保证同一份磁盘内容每次返回的树结构一致（UI 展开状态才有稳定的 key）。
 */

export interface ResourceNodeDto {
  /** 稳定标识：文件为 `doc:<相对路径>`，目录为 `dir:<相对路径>`。 */
  id: string;
  name: string;
  kind: 'folder' | 'markdown' | 'text';
  /** 文件相对路径（供 open 使用）；目录为 `undefined`。 */
  path?: string;
  children?: ResourceNodeDto[];
}

/** 可被文本接口打开的后缀；其余文件不进树（避免展示必定打不开的二进制）。 */
const TEXT_EXTENSIONS = ['.md', '.markdown', '.txt'];

export function isListableTextFile(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function kindOf(relativePath: string): 'markdown' | 'text' {
  const lower = relativePath.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown') ? 'markdown' : 'text';
}

type Entry =
  | { type: 'folder'; name: string; path: string; children: Map<string, Entry> }
  | { type: 'file'; node: ResourceNodeDto };

function sortNodes(nodes: ResourceNodeDto[]): ResourceNodeDto[] {
  return nodes.sort((a, b) => {
    if (a.kind === 'folder' && b.kind !== 'folder') return -1;
    if (a.kind !== 'folder' && b.kind === 'folder') return 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

export interface BuildResourceTreeOptions {
  /** Multi：节点 id 带上项目命名空间（`doc:<projectId>/<rel>`），避免跨项目撞 id。 */
  projectId?: string;
}

export function buildResourceTree(
  relativePaths: readonly string[],
  options: BuildResourceTreeOptions = {},
): ResourceNodeDto[] {
  const idFor = (kind: 'doc' | 'dir', relativePath: string): string =>
    options.projectId ? `${kind}:${options.projectId}/${relativePath}` : `${kind}:${relativePath}`;
  const rootChildren = new Map<string, Entry>();

  for (const relativePath of relativePaths) {
    if (!isListableTextFile(relativePath)) continue;
    const segments = relativePath.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    let cursor = rootChildren;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i];
      const childPath = segments.slice(0, i + 1).join('/');
      const existing = cursor.get(name);
      if (existing && existing.type === 'folder') {
        cursor = existing.children;
        continue;
      }
      const folder: Entry = { type: 'folder', name, path: childPath, children: new Map() };
      cursor.set(name, folder);
      cursor = folder.children;
    }

    const fileName = segments[segments.length - 1];
    cursor.set(fileName, {
      type: 'file',
      node: {
        id: idFor('doc', relativePath),
        name: fileName,
        kind: kindOf(relativePath),
        path: relativePath,
      },
    });
  }

  const materialize = (children: Map<string, Entry>): ResourceNodeDto[] => {
    const out: ResourceNodeDto[] = [];
    for (const entry of children.values()) {
      if (entry.type === 'folder') {
        out.push({
          id: idFor('dir', entry.path),
          name: entry.name,
          kind: 'folder',
          children: materialize(entry.children),
        });
      } else {
        out.push(entry.node);
      }
    }
    return sortNodes(out);
  };

  return materialize(rootChildren);
}
