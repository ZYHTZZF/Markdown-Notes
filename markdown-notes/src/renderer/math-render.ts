import katex from 'katex';

export function mathMarkup(tex: string, display: boolean) {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      output: 'htmlAndMathml',
      throwOnError: true,
      trust: false,
      strict: 'ignore',
      maxExpand: 1000,
      maxSize: 20,
      macros: {},
    });
  } catch {
    const raw = tex.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
    return `<code class="math-error" title="公式语法有误或命令不受支持，请检查LaTeX源码">${raw}</code>`;
  }
}
