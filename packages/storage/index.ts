/**
 * storage 模块唯一公开入口。
 * 职责：本地文件内容读写原语 + 路径边界校验 + 根目录连续性 + 内容版本 token。
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
  type CreateEntryKind,
  type CreateEntryResult,
  type MoveEntryResult,
  type LstatImpl,
  type LstatResultLike,
} from './local-provider.ts';
export {
  resolveInsideRoot,
  fileExists,
  type PathCheck,
  // 根目录连续性（S11-A1-G0）：身份令牌、连续性断言与分阶段检查点类型
  assertRootContinuity,
  assertRootStillAbsent,
  buildRootToken,
  claimRootDirectory,
  rootTokenOf,
  rootChangedError,
  isPathInsideRoot,
  mapStorageError,
  type RootBoundary,
  type RootCheckpoint,
  type RootStatLike,
} from './path-safety.ts';
export {
  validateEntryName,
  validateParentDir,
  entryRelativePath,
  parentDirOfEntry,
  entryNameOf,
  sameEntryPath,
  isEntryUnder,
  MAX_ENTRY_NAME_LENGTH,
  MAX_PARENT_DIR_LENGTH,
  type EntryNameCheck,
} from './entry-name.ts';
