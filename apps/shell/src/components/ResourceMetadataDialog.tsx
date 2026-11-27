/**
 * 资源标注对话框（UX-02C-04）：标注名 / 标签 / 行颜色。
 *
 * 三个区块各自可清除，也可以一次性全部清除。组件只负责**呈现与本地输入**：
 * 校验规则来自 `resource-metadata.ts`（与 Host 同一份契约），提交与刷新由
 * `MetadataContext` 编排。
 *
 * 明确不做：不显示/不接受真实路径以外的信息，不修改真实文件名，不预览文件内容。
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useResourceMetadata } from '../state/MetadataContext.tsx';
import { COLOR_OPTIONS, colorLabelOf, tagBadges } from '../state/resource-metadata.ts';
import { MAX_ALIAS_LENGTH } from '../../../../packages/contracts/metadata.ts';

export function ResourceMetadataDialog() {
  const { session, close, setAlias, addTag, removeTag, setColor, submit, clearAll } = useResourceMetadata();
  /** 标签输入框的临时内容：回车/点「添加」才进草稿（避免每敲一个字就改记录）。 */
  const [tagDraft, setTagDraft] = useState('');
  if (!session) return null;

  const { draft, target, error, submitting } = session;
  const badges = tagBadges(draft.tags, 99);
  const canClear = draft.alias.trim() !== '' || draft.tags.length > 0 || draft.color !== undefined;

  return createPortal(
    <div className="modal__backdrop" role="presentation" onMouseDown={() => close()}>
      <div
        className="modal meta__dialog"
        role="dialog"
        aria-modal="true"
        aria-label="资源标注"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
          // Ctrl/Cmd + Enter 在任意位置提交：长标签输入时不必去够按钮
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <h2 className="modal__title">资源标注</h2>
        <p className="modal__lead">
          「{target.path === '' ? target.name : target.path}」 · 标注只影响工作台展示：
          真实文件名、文件内容与扩展名都不变。
        </p>

        <section className="meta__section">
          <label className="meta__label" htmlFor="meta-alias">
            标注名
          </label>
          <div className="meta__row">
            <input
              id="meta-alias"
              className={error && draft.alias.trim().length > MAX_ALIAS_LENGTH ? 'meta__input meta__input--invalid' : 'meta__input'}
              value={draft.alias}
              autoFocus={session.focus === 'alias'}
              disabled={submitting}
              maxLength={MAX_ALIAS_LENGTH}
              placeholder="例如：核心架构（留空表示不显示标注名）"
              aria-label="标注名"
              onChange={(event) => setAlias(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            {draft.alias !== '' && (
              <button
                type="button"
                className="button button--ghost meta__clear"
                disabled={submitting}
                onClick={() => setAlias('')}
              >
                清除
              </button>
            )}
          </div>
          <p className="meta__hint">展示为「真实文件名（标注名）」；清除后恢复只显示真实文件名。</p>
        </section>

        <section className="meta__section">
          <span className="meta__label">标签</span>
          <div className="meta__tags" aria-label="已有标签">
            {badges.shown.length === 0 && <span className="meta__hint">还没有标签</span>}
            {badges.shown.map((tag) => (
              <span key={tag} className="meta__tag">
                {tag}
                <button
                  type="button"
                  className="meta__tag-remove"
                  aria-label={`移除标签 ${tag}`}
                  disabled={submitting}
                  onClick={() => removeTag(tag)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="meta__row">
            <input
              className="meta__input"
              value={tagDraft}
              autoFocus={session.focus === 'tags'}
              disabled={submitting}
              placeholder="输入标签后按回车添加"
              aria-label="新增标签"
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                if (tagDraft.trim() === '') return;
                addTag(tagDraft);
                setTagDraft('');
              }}
            />
            <button
              type="button"
              className="button button--ghost meta__clear"
              disabled={submitting || tagDraft.trim() === ''}
              onClick={() => {
                addTag(tagDraft);
                setTagDraft('');
              }}
            >
              添加
            </button>
          </div>
          <p className="meta__hint">大小写不敏感去重（Arch 与 arch 视为同一个），最多 16 个。</p>
        </section>

        <section className="meta__section">
          <span className="meta__label">行颜色</span>
          <div className="meta__swatches" role="group" aria-label="行颜色">
            <button
              type="button"
              className={draft.color === undefined ? 'meta__swatch meta__swatch--default meta__swatch--active' : 'meta__swatch meta__swatch--default'}
              aria-pressed={draft.color === undefined}
              disabled={submitting}
              title="默认（不染色）"
              onClick={() => setColor(undefined)}
            >
              默认
            </button>
            {COLOR_OPTIONS.map((option) => (
              <button
                key={option.token}
                type="button"
                className={
                  draft.color === option.token
                    ? `${option.swatchClass} meta__swatch--active`
                    : option.swatchClass
                }
                aria-pressed={draft.color === option.token}
                disabled={submitting}
                title={colorLabelOf(option.token)}
                onClick={() => setColor(option.token)}
              >
                <span className="meta__sr">{colorLabelOf(option.token)}</span>
              </button>
            ))}
          </div>
          <p className="meta__hint">颜色只作用于这一行的文字，不覆盖选中、焦点与错误等状态。</p>
        </section>

        {error && <p className="meta__error">{error}</p>}

        <div className="modal__actions">
          <button
            type="button"
            className="button button--ghost"
            disabled={submitting || !canClear}
            onClick={() => void clearAll()}
          >
            清除全部标注
          </button>
          <button type="button" className="button button--ghost" disabled={submitting} onClick={close}>
            取消（Esc）
          </button>
          <button type="button" className="button" disabled={submitting} onClick={() => void submit()}>
            {submitting ? '正在保存…' : '保存'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
