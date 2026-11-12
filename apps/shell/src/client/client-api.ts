/**
 * Client API 边界（S9-A）。
 *
 * 浏览器**不得**直接访问文件系统或 SQLite。Shell 只依赖下面这组接口；
 * S9-A 提供 demo 实现（内存数据、绝不写盘），未来替换为访问 Core 的 HTTP/WS 客户端，
 * 契约不变。真正的读写权限仍由 Core 的 CommandBus + PermissionService 判定。
 */

export interface ResourceNode {
  id: string;
  name: string;
  kind: 'folder' | 'markdown' | 'text';
  children?: ResourceNode[];
}

export interface DocumentSnapshot {
  resourceId: string;
  path: string;
  content: string;
  contentVersion: string | null;
}

export interface SaveOutcome {
  status: 'COMMITTED' | 'CONFLICT' | 'FAILED' | 'UNKNOWN';
  contentVersion?: string;
}

export interface WeaveSpaceClient {
  readonly mode: 'demo';
  listResources(): Promise<ResourceNode[]>;
  readDocument(resourceId: string): Promise<DocumentSnapshot>;
  /** 演示实现只更新内存并返回 COMMITTED（标注 demo），绝不落盘。 */
  saveDocument(resourceId: string, content: string): Promise<SaveOutcome>;
}
