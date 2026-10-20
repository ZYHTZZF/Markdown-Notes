import { safeMarkdown } from './markdown';
import './print.css';
import { appearanceColors, backgroundStyle, type AppearanceView } from '../shared/appearance';

declare global {
  interface Window {
    pdfDocument: {
      source(): Promise<{ title: string; content: string; appearance?: AppearanceView }>;
      ready(ok: boolean): Promise<void>;
    };
  }
}
async function prepare() {
  try {
    const source = await window.pdfDocument.source();
    if (source.appearance) {
      const a = source.appearance;
      for (const [name, value] of Object.entries(backgroundStyle(a)))
        document.documentElement.style.setProperty(name, value);
      document.documentElement.style.setProperty('--print-accent', appearanceColors(a.accent).text);
      document.documentElement.dataset.background = a.background;
      if (a.background === 'image' && a.image_data) {
        const image = new Image();
        image.src = a.image_data;
        await image.decode();
      }
    }
    document.title = source.title;
    document.getElementById('title')!.textContent = source.title;
    document.getElementById('content')!.innerHTML = safeMarkdown(source.content);
    void document.body.offsetHeight;
    await document.fonts.ready;
    if ([...document.fonts].some((font) => font.status === 'error'))
      throw new Error('字体加载失败');
    // A4 content width is fixed before printing. Shrink oversize formulae rather than clipping them.
    for (const outer of document.querySelectorAll<HTMLElement>('.katex-display')) {
      const inner = outer.querySelector<HTMLElement>('.katex');
      if (inner && inner.scrollWidth > outer.clientWidth) {
        inner.style.fontSize = `${Math.min(1, outer.clientWidth / inner.scrollWidth) * 1.21}em`;
      }
    }
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await window.pdfDocument.ready(true);
  } catch {
    await window.pdfDocument.ready(false);
  }
}
void prepare();
