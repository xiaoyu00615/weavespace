/**
 * Quick File 面板（S11-B）：左列项目树**下方**的独立区域。
 *
 * 边界：
 * - 只能由用户显式操作触发（点击"选择文件"或拖入），不扫描目录、不自动加载；
 * - 只接受单个文件，格式与大小门禁在 `state/quick-file.ts` 里完成；
 * - 内容只进内存预览，不发 HTTP、不写盘、不进入任何项目。
 */
import { useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useQuickFile } from '../state/QuickFileContext';
import {
  QUICK_FILE_EXTENSIONS,
  QUICK_FILE_MAX_BYTES,
  formatQuickFileSize,
} from '../state/quick-file';

/** DataTransferItem 的目录探测（非标准但各浏览器均实现；缺失时按非目录处理）。 */
function entryOf(item: DataTransferItem): { isDirectory?: boolean } | null {
  const getter = (item as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory?: boolean } | null })
    .webkitGetAsEntry;
  if (typeof getter !== 'function') return null;
  try {
    return getter.call(item) ?? null;
  } catch {
    return null;
  }
}

export function QuickFilePanel() {
  const quick = useQuickFile();
  // 折叠状态属于本区域自己：与项目树、与其他项目分区互不影响
  const [expanded, setExpanded] = useState(true);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const file = quick.state.file;
  const visible = quick.state.status === 'ready' && quick.state.active;

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const items = Array.from(event.dataTransfer.items ?? []);
    const directory = items.some((item) => entryOf(item)?.isDirectory === true);
    const files = Array.from(event.dataTransfer.files ?? []);
    void quick.selectFiles(files, { directory });
  };

  return (
    <section className="quick" aria-label="Quick File（本机临时文件）">
      <header className="quick__header">
        <button
          type="button"
          className="quick__caret"
          aria-expanded={expanded}
          aria-label={expanded ? '折叠 Quick File' : '展开 Quick File'}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span className="quick__title">Quick File</span>
        <span className="quick__badge" title="只读预览：不写盘、不进项目、不上传">
          只读
        </span>
      </header>

      {expanded && (
        <div className="quick__body">
          <div
            className={dragging ? 'quick__drop quick__drop--active' : 'quick__drop'}
            role="button"
            tabIndex={0}
            aria-label="拖入一个文件，或按回车选择文件"
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                inputRef.current?.click();
              }
            }}
            onClick={() => inputRef.current?.click()}
          >
            <span>拖入单个文件</span>
            <span className="quick__drop-hint">或点击选择</span>
          </div>

          <div className="quick__actions">
            <button type="button" className="chip" onClick={() => inputRef.current?.click()}>
              选择文件
            </button>
            {file && (
              <>
                <button
                  type="button"
                  className="chip"
                  onClick={() => (visible ? quick.deactivate() : quick.activate())}
                >
                  {visible ? '收起预览' : '查看'}
                </button>
                <button type="button" className="chip" onClick={() => quick.remove()}>
                  移除
                </button>
              </>
            )}
          </div>

          <input
            ref={inputRef}
            type="file"
            className="quick__input"
            accept={QUICK_FILE_EXTENSIONS.join(',')}
            aria-label="选择 Quick File"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              // 允许再次选择同一个文件：清空 value，否则 change 不再触发
              event.target.value = '';
              void quick.selectFiles(files);
            }}
          />

          {quick.state.status === 'loading' && (
            <p className="quick__meta" role="status">
              正在读取 {quick.state.pendingName} …
            </p>
          )}

          {quick.state.status === 'error' && (
            <div className="quick__error" role="alert">
              <strong>无法预览</strong>
              <div>{quick.state.errorMessage}</div>
              <div className="quick__error-code">{quick.state.errorCode}</div>
            </div>
          )}

          {quick.state.status === 'ready' && file && (
            <div className="quick__file">
              <div className="quick__file-name" title={file.name}>
                {file.name}
              </div>
              <div className="quick__meta">
                {file.extension} · {formatQuickFileSize(file.size)}
                {visible ? ' · 正在预览' : ''}
              </div>
            </div>
          )}

          <p className="quick__hint">
            仅支持 {QUICK_FILE_EXTENSIONS.join(' / ')}，单文件 ≤{' '}
            {formatQuickFileSize(QUICK_FILE_MAX_BYTES)}。内容只在本页预览，不上传、不写盘、不加入任何项目。
          </p>
        </div>
      )}
    </section>
  );
}
