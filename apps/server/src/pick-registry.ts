/**
 * 目录选择请求登记表（UX-02B-03）。
 *
 * 为什么要一个 requestId 而不是让 `POST /api/projects/pick` 同步阻塞到用户点完：
 * 系统对话框可能开很久（上限 120s），同步等待会让 HTTP 连接与页面状态一起挂住；
 * 更关键的是——**请求必须能在客户端断开后继续被查询**。ADR-021 因此专门定义了
 * `GET /api/projects/pick?requestId=`。
 *
 * 生命周期：`begin()` 建一条 PENDING 记录（同时把选择器置为"忙"），
 * 选择任务结束时 `settle()` 写入终态并解除忙标记。终态记录保留一段时间供轮询，
 * 过期后按"不存在"处理（410 `ERR_PICK_REQUEST_GONE`）。
 *
 * 记录**只在内存里**：Host 重启后一定查不到（ADR-021 §6 / S-13）。这是刻意的——
 * 把 pending 请求持久化，等于让"某个过去的网页请求"在重启后仍能触发授权，
 * 那会越过 T2 的新鲜度约束。重启后客户端拿 410 重试即可，磁盘上不会留下半成品。
 */
import { randomUUID } from 'node:crypto';
import type { ProjectSummary } from '../../../packages/project-registry/index.ts';

export type PickStatus = 'PENDING' | 'APPLIED' | 'CANCELLED' | 'REJECTED';

export interface PickRecord {
  readonly requestId: string;
  readonly status: PickStatus;
  /** 客户端轮询时应当使用的 HTTP 状态（与终态语义一致）。 */
  readonly httpStatus: number;
  /** 仅 `APPLIED`：不含任何路径/令牌（与 `/api/projects` 的摘要完全一致）。 */
  readonly project?: ProjectSummary;
  readonly errorCode?: string;
  readonly reason?: string;
}

export interface PickRegistry {
  /** 建立一条 PENDING 记录；调用方负责在任务结束时 `settle`。 */
  begin(): string;
  /** 是否有一次选择正在进行（选择器单飞，ADR-021 §3.4）。 */
  isBusy(): boolean;
  /** 写入终态并解除忙标记；对不存在的 requestId 是空操作。 */
  settle(requestId: string, result: Omit<PickRecord, 'requestId'>): void;
  /** 任意状态（含 PENDING）；过期记录返回 undefined。 */
  get(requestId: string): PickRecord | undefined;
  /** 仅诊断/测试。 */
  size(): number;
}

export interface PickRegistryOptions {
  readonly now?: () => number;
  /** 终态记录保留时长；默认 5 分钟（足够页面轮询，也不会无限增长）。 */
  readonly retentionMs?: number;
}

const DEFAULT_RETENTION_MS = 5 * 60_000;

interface Entry {
  readonly requestId: string;
  readonly createdAt: number;
  record: PickRecord;
}

export function createPickRegistry(options: PickRegistryOptions = {}): PickRegistry {
  const now = options.now ?? (() => Date.now());
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const entries = new Map<string, Entry>();
  let busy = false;

  function prune(at: number): void {
    for (const [id, entry] of entries) {
      const settled = entry.record.status !== 'PENDING';
      if (settled && at - entry.createdAt > retentionMs) entries.delete(id);
    }
  }

  return {
    begin() {
      const at = now();
      prune(at);
      const requestId = `pick-${randomUUID()}`;
      entries.set(requestId, {
        requestId,
        createdAt: at,
        record: { requestId, status: 'PENDING', httpStatus: 202 },
      });
      busy = true;
      return requestId;
    },

    isBusy() {
      return busy;
    },

    settle(requestId, result) {
      const entry = entries.get(requestId);
      // 忙标记与"有没有 pending 记录"解耦：即便记录被清理，也必须解除忙
      busy = false;
      if (!entry) return;
      entry.record = { requestId, ...result };
    },

    get(requestId) {
      const at = now();
      prune(at);
      return entries.get(requestId)?.record;
    },

    size() {
      prune(now());
      return entries.size;
    },
  };
}
