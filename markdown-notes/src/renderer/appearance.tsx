import React, { useEffect, useState } from 'react';
import { ImagePlus, RotateCcw } from 'lucide-react';
import { appearanceColors, backgroundStyle, type AppearanceView } from '../shared/appearance';
import './appearance.css';

export function applyAppearance(a: AppearanceView) {
  const colors = appearanceColors(a.accent),
    style = document.documentElement.style;
  for (const [name, value] of Object.entries({
    '--accent': colors.text,
    '--accent-fill': colors.fill,
    '--accent-dark': colors.hover,
    '--on-accent': colors.on,
    '--on-accent-hover': colors.onHover,
    '--selection': colors.selection,
    ...backgroundStyle(a),
  }))
    style.setProperty(name, value);
  document.documentElement.dataset.background = a.background;
}
export function AppearanceSettings({
  value,
  onChange,
  notify,
}: {
  value: AppearanceView;
  onChange(value: AppearanceView): void;
  notify(text: string, error?: boolean): void;
}) {
  const [draft, setDraft] = useState(value),
    [busy, setBusy] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const run = async (method: string, payload = {}) => {
    setBusy(true);
    try {
      let result = await window.notesApi.call(method, payload);
      onChange(result);
      if (method === 'appearance.chooseImage') {
        const { image_data, warning, ...settings } = draft;
        result = await window.notesApi.call('appearance.set', { ...settings, background: 'image' });
        onChange(result);
      }
      notify('外观已保存');
    } catch (e: any) {
      if (!e.message.includes('已取消')) notify(e.message, true);
    } finally {
      setBusy(false);
    }
  };
  const colors = appearanceColors(draft.accent);
  return (
    <div className="settings-content appearance-settings">
      {value.warning && <p className="muted">{value.warning}</p>}
      <div className="setting-section">
        <h3>主色调</h3>
        <p className="muted">按钮、选中状态和链接使用你的主色；浅色会自动配上清晰的文字。</p>
        <div className="appearance-colors">
          {['#0066cc', '#7352c7', '#b64278', '#a94821', '#34735a', '#424245'].map((color) => (
            <button
              key={color}
              className="color-swatch"
              style={{ background: color }}
              aria-label={'选择主色' + color}
              aria-pressed={draft.accent === color}
              onClick={() => setDraft({ ...draft, accent: color })}
            />
          ))}
          <label className="color-control">
            自定义主色
            <input
              type="color"
              aria-label="自定义主色"
              value={draft.accent}
              onChange={(e) => setDraft({ ...draft, accent: e.target.value })}
            />
          </label>
          <span className="muted">{draft.accent.toUpperCase()}</span>
        </div>
      </div>
      <div className="setting-section">
        <h3>工作区背景</h3>
        <div className="font-options">
          {(
            [
              ['default', '默认'],
              ['solid', '纯色'],
              ['image', '图片'],
            ] as const
          ).map(([kind, label]) => (
            <button
              key={kind}
              className={'button ' + (draft.background === kind ? 'chosen' : '')}
              disabled={kind === 'image' && !value.image_data}
              onClick={() => setDraft({ ...draft, background: kind })}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="appearance-controls">
          <label className="color-control">
            背景颜色
            <input
              type="color"
              aria-label="背景颜色"
              value={draft.background_color}
              onChange={(e) =>
                setDraft({ ...draft, background_color: e.target.value, background: 'solid' })
              }
            />
          </label>
          <button
            className="button"
            disabled={busy}
            onClick={() => void run('appearance.chooseImage')}
          >
            <ImagePlus size={15} />
            选择本地背景图片
          </button>
        </div>
        <label className="background-strength">
          背景强度{' '}
          <input
            type="range"
            aria-label="背景强度"
            min="0"
            max="100"
            value={draft.strength}
            onChange={(e) => setDraft({ ...draft, strength: Number(e.target.value) })}
          />
          <span>{draft.strength}%</span>
        </label>
        <p className="muted mini">
          PNG或JPEG，最大8 MiB；选择图片后立即保存本机副本。正文保留浅色底层，背景不会盖住文字。
        </p>
      </div>
      <div
        className="appearance-preview"
        style={
          {
            ...backgroundStyle(draft),
            '--preview-accent': colors.fill,
            '--preview-on': colors.on,
          } as React.CSSProperties
        }
      >
        <div>
          <strong>让知识拥有自己的颜色</strong>
          <p>预览 · 中文与公式保持清晰</p>
          <span>新建笔记</span>
        </div>
      </div>
      <div className="modal-actions">
        <button className="button" disabled={busy} onClick={() => void run('appearance.reset')}>
          <RotateCcw size={14} />
          恢复默认外观
        </button>
        <button
          className="new-button"
          disabled={busy}
          onClick={() => {
            const { image_data, warning, ...settings } = draft;
            void run('appearance.set', settings);
          }}
        >
          应用外观
        </button>
      </div>
      <p className="muted mini">
        外观与图片仅保存在本机，不包含在完整资料备份中。PDF导出时可单独选择带背景或纯白背景。
      </p>
    </div>
  );
}
