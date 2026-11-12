/**
 * 演示项目数据（S9-A）。
 *
 * 明确约束：
 * - 这些内容**全部是内置演示数据**，与用户真实文件无关；
 * - 页面里的“保存”只清掉 dirty 标记并给出演示提示，**不会写入磁盘**；
 * - 未来由 Core 的 Client API 提供真实资源树与文档内容（见 ../client/client-api.ts）。
 */
import type { ResourceNodeState } from '../state/types';

export interface DemoNode {
  /** 树内唯一 key，同时作为演示文档 id。 */
  id: string;
  name: string;
  kind: 'folder' | 'file';
  extension?: string;
  children?: DemoNode[];
}

export const DEMO_PROJECT_NAME = '演示项目 · 雨夜';

/** 演示树与 live 资源树共用同一形状，组件无需按模式分叉渲染。 */
export function toResourceNodes(nodes: DemoNode[]): ResourceNodeState[] {
  return nodes.map((node) => ({
    id: node.id,
    name: node.name,
    kind: node.kind,
    extension: node.extension,
    children: node.children ? toResourceNodes(node.children) : undefined,
  }));
}


export const DEMO_TREE: DemoNode[] = [
  {
    id: 'folder-script',
    name: '剧本',
    kind: 'folder',
    children: [
      { id: 'doc-scene-01', name: '第01场_巷口.md', kind: 'file', extension: '.md' },
      { id: 'doc-scene-02', name: '第02场_天台.md', kind: 'file', extension: '.md' },
    ],
  },
  {
    id: 'folder-world',
    name: '设定',
    kind: 'folder',
    children: [
      { id: 'doc-characters', name: '人物小传.md', kind: 'file', extension: '.md' },
      { id: 'doc-locations', name: '场景清单.md', kind: 'file', extension: '.md' },
    ],
  },
  {
    id: 'folder-notes',
    name: '笔记',
    kind: 'folder',
    children: [
      { id: 'doc-todo', name: '待办.md', kind: 'file', extension: '.md' },
      { id: 'doc-raw', name: '素材索引.txt', kind: 'file', extension: '.txt' },
    ],
  },
];

export const DEMO_NODES: ResourceNodeState[] = toResourceNodes(DEMO_TREE);

const CONTENTS: Record<string, string> = {
  'doc-scene-01': `# 第 01 场 · 巷口

**时间**：夜 / 雨
**人物**：林晚、修表匠

> 雨水顺着招牌流下，霓虹把水洼切成碎片。

## 动作

1. 林晚停在巷口，抬头看那块停在 03:17 的挂钟。
2. 修表匠没有抬头，只说了一句："它走得比你以为的准。"

## 对白

林晚：这只表，是我父亲的。
修表匠：*那就更不该修它。*

- 待确认：是否需要闪回
- 待确认：雨声是否延续到下一场

---

参考：[场景清单](设定/场景清单.md) · 下一场：第 02 场_天台
`,
  'doc-scene-02': `# 第 02 场 · 天台

**时间**：夜 / 雨刚停
**人物**：林晚

天台的水箱在滴水。她把手表放在栏杆上，第一次听见秒针走动的声音。

- 关键道具：挂钟、手表
- 情绪曲线：怀疑 → 确认
`,
  'doc-characters': `# 人物小传

## 林晚

- 年龄：29
- 职业：声音编辑
- 动机：确认父亲留下的物件是否还在走动

## 修表匠

- 年龄：不详
- 台词极少，习惯用反问回答
- 知道挂钟为什么停在 03:17
`,
  'doc-locations': `# 场景清单

| 场景 | 时间 | 备注 |
| --- | --- | --- |
| 巷口 | 夜 / 雨 | 挂钟、招牌、水洼 |
| 天台 | 夜 / 雨停 | 水箱、栏杆 |

> 两个场景都要有持续的滴水声。
`,
  'doc-todo': `# 待办

- [ ] 补齐第 03 场大纲
- [x] 确认人物年龄
- [ ] 找雨声素材（**48kHz / 24bit**）
- [ ] 与摄影确认夜景灯位
`,
  'doc-raw': `素材索引（纯文本演示）

001 雨声_巷口_长.wav
002 挂钟_秒针_近.wav
003 天台_水箱_滴水中.wav

说明：以上均为演示占位，未指向真实磁盘文件。
`,
};

export const DEMO_CONTENTS: Readonly<Record<string, string>> = CONTENTS;

export function findNode(nodes: DemoNode[], id: string): DemoNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const hit = findNode(node.children, id);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** 目录 id → 默认展开（首屏只展开剧本与设定，笔记保持收起）。 */
export const DEFAULT_EXPANDED: Record<string, boolean> = {
  'folder-script': true,
  'folder-world': true,
};
