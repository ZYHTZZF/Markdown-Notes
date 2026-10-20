import React, { useEffect, useRef, useState } from 'react';
import { completionContext } from '../shared/productivity';
import { safeMarkdown } from './markdown';
import './productivity.css';
const api = window.notesApi;

export function ReferenceSuggest({
  cursor,
  onPick,
  disabled,
}: {
  cursor: { text: string; caret: number } | null;
  onPick(start: number, end: number, title: string): void;
  disabled: boolean;
}) {
  const context = cursor && !disabled ? completionContext(cursor.text, cursor.caret) : null;
  const signature = context ? JSON.stringify([cursor!.text, cursor!.caret]) : '';
  const [items, setItems] = useState<{ note_id: string; title: string }[]>([]);
  const [active, setActive] = useState(0),
    [dismissed, setDismissed] = useState('');
  const composing = useRef(false);
  const open = !!context && signature !== dismissed && items.length > 0;
  useEffect(() => {
    setItems([]);
    setActive(0);
    setDismissed('');
    if (!context) return;
    let alive = true;
    const timer = setTimeout(() => {
      api
        .call('note.suggest', { keyword: context.query })
        .then((result) => {
          if (alive) setItems(result);
        })
        .catch(() => {});
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [signature]);
  const pick = (i: number) => {
    if (!context || !items[i]) return;
    onPick(context.start, context.end, items[i].title);
    setDismissed(signature);
    setItems([]);
  };
  useEffect(() => {
    const start = () => {
        composing.current = true;
      },
      end = () => {
        composing.current = false;
      };
    const key = (e: KeyboardEvent) => {
      if (!open || e.isComposing || composing.current || e.keyCode === 229) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopImmediatePropagation();
        pick(active);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setDismissed(signature);
      }
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('compositionstart', start, true);
    window.addEventListener('compositionend', end, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('compositionstart', start, true);
      window.removeEventListener('compositionend', end, true);
    };
  }, [open, active, signature, items]);
  if (!open) return null;
  return (
    <div className="reference-suggest" role="listbox" aria-label="引用自动补全">
      <div className="suggest-hint">选择已有笔记 · ↑↓ 选择 · Enter 插入 · Esc 关闭</div>
      {items.map((item, i) => (
        <button
          key={item.note_id}
          role="option"
          aria-selected={active === i}
          className={active === i ? 'selected' : ''}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(i)}
        >
          {item.title}
        </button>
      ))}
    </div>
  );
}

export function TemplateManager({
  onCreate,
  onError,
}: {
  onCreate(id: string): Promise<void>;
  onError(message: string): void;
}) {
  const [items, setItems] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(null);
  const [title, setTitle] = useState(''),
    [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => setItems(await api.call('template.list'));
  useEffect(() => {
    void load().catch((e) => onError(e.message));
  }, []);
  const choose = (t: any) => {
    setSelected(t);
    setTitle(t.title);
    setContent(t.content);
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="template-manager">
      <p className="muted">
        从课程、会议、阅读模板开始，也可以保存自己的模板。新笔记与模板独立编辑。
      </p>
      <div className="template-grid">
        <div className="template-list">
          {items.map((t) => (
            <button
              key={t.template_id}
              className={'button ' + (selected?.template_id === t.template_id ? 'selected' : '')}
              onClick={() => choose(t)}
            >
              {t.title}
              <small>{t.builtin ? '内置' : '自定义'}</small>
            </button>
          ))}
          <button
            className="button"
            onClick={() => {
              setSelected({});
              setTitle('');
              setContent('');
            }}
          >
            ＋ 新建自定义模板
          </button>
        </div>
        <div className="template-detail">
          {selected ? (
            <>
              <label>
                模板名称
                <input
                  aria-label="模板名称"
                  value={title}
                  disabled={selected.builtin || busy}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              {selected.builtin ? (
                <article
                  className="markdown template-preview"
                  dangerouslySetInnerHTML={{ __html: safeMarkdown(content) }}
                />
              ) : (
                <label>
                  Markdown 正文
                  <textarea
                    aria-label="模板正文"
                    value={content}
                    disabled={busy}
                    onChange={(e) => setContent(e.target.value)}
                  />
                </label>
              )}
              <div className="template-buttons">
                {selected.template_id && (
                  <button
                    className="new-button"
                    disabled={busy || title !== selected.title || content !== selected.content}
                    title={
                      title !== selected.title || content !== selected.content
                        ? '请先保存模板修改'
                        : '复制已保存的模板创建独立笔记'
                    }
                    onClick={() => void run(() => onCreate(selected.template_id))}
                  >
                    用此模板新建
                  </button>
                )}
                {!selected.builtin && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await api.call('template.save', {
                          ...(selected.template_id ? { template_id: selected.template_id } : {}),
                          title,
                          content,
                        });
                        await load();
                        choose({ template_id: result.template_id, title, content });
                      })
                    }
                  >
                    保存模板
                  </button>
                )}
                {!selected.builtin && selected.template_id && (
                  <button
                    className="button danger"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api.call('template.delete', { template_id: selected.template_id });
                        await load();
                        setSelected(null);
                      })
                    }
                  >
                    删除模板
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="muted">选择一个模板查看内容。</p>
          )}
        </div>
      </div>
    </div>
  );
}
