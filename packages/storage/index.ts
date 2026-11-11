/**
 * storage 模块唯一公开入口。
 * 职责：本地文件内容读写原语 + 路径边界校验 + 内容版本 token。
 * 不负责编辑会话、冲突呈现、权限判定。
 */
export {
  createLocalProvider,
  contentVersionOf,
  type LocalProviderOptions,
  type ReadResult,
  type FileStat,
  type StorageFaultHooks,
  type StorageProvider,
} from './local-provider.ts';
export { resolveInsideRoot, fileExists, type PathCheck } from './path-safety.ts';
