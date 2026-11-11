/**
 * document 模块唯一公开入口。
 * 职责：同一 Resource 的权威编辑会话、dirty 保护、条件保存、冲突/UNKNOWN 处理与 reconcile。
 * 不负责文件编码细节（Serializer/插件）与授权判定（permission）。
 */
export {
  createDocumentService,
  type DocumentEvent,
  type DocumentService,
  type DocumentServiceOptions,
  type OpenSessionInput,
  type ReconcileResult,
  type Serializer,
  type ViewHandle,
  type CloseViewResult,
} from './document-service.ts';
