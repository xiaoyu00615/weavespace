/**
 * protocol 模块唯一公开入口（UX-02C-02-R1.3）。
 * 职责：Host 与 Shell 共用的**协议边界常量**与纯切分规则。
 * 不负责任何 IO、状态机或授权判定。
 */
export { MAX_RECLAIM_PATHS, chunkReclaimPaths } from './reclaim.ts';
