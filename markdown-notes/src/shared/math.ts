import type MarkdownIt from 'markdown-it';

export const MAX_MATH_LENGTH = 16_384;
export type MathSpan = { end: number; tex: string; display: boolean };
const escaped = (s: string, at: number) => {
  let count = 0;
  while (at > 0 && s[--at] === '\\') count++;
  return count % 2 !== 0;
};

/** Shared delimiter semantics for rendering and reference extraction. Code is excluded by the caller. */
export function mathAt(s: string, at: number): MathSpan | null {
  if (escaped(s, at)) return null;
  const open = s.startsWith('$$', at)
    ? '$$'
    : s.startsWith('\\[', at)
      ? '\\['
      : s.startsWith('\\(', at)
        ? '\\('
        : s[at] === '$' && s[at - 1] !== '$'
          ? '$'
          : '';
  if (!open) return null;
  const display = open === '$$' || open === '\\[';
  const close = open === '\\[' ? '\\]' : open === '\\(' ? '\\)' : open;
  const start = at + open.length;
  if (open === '$' && (!s[start] || /\s/.test(s[start]))) return null;
  for (let end = start; end < Math.min(s.length, start + MAX_MATH_LENGTH + close.length); end++) {
    if (!display && s[end] === '\n') return null;
    if (!s.startsWith(close, end) || escaped(s, end)) continue;
    if (
      open === '$' &&
      (/\s/.test(s[end - 1]) || /[\d$]/.test(s[end + 1] ?? '') || s[end - 1] === '$')
    )
      continue;
    if (end === start || end - start > MAX_MATH_LENGTH) return null;
    return { end: end + close.length, tex: s.slice(start, end), display };
  }
  return null;
}

export function mathPlugin(
  parser: InstanceType<typeof MarkdownIt>,
  render?: (tex: string, display: boolean) => string,
) {
  parser.inline.ruler.before('escape', 'math_inline', (state, silent) => {
    if (state.src[state.pos] !== '$' && state.src[state.pos] !== '\\') return false;
    const match = mathAt(state.src, state.pos);
    if (!match || match.end > state.posMax) return false;
    if (!silent) {
      const token = state.push('math_inline', '', 0);
      token.content = match.tex;
      token.meta = { display: match.display };
    }
    state.pos = match.end;
    return true;
  });
  parser.block.ruler.before(
    'fence',
    'math_block',
    (state, start, end, silent) => {
      if (state.sCount[start] - state.blkIndent >= 4) return false;
      const first = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
      if (!first.startsWith('$$') && !first.startsWith('\\[')) return false;
      let source = '';
      for (let line = start; line < end; line++) {
        if (line > start && state.sCount[line] < state.blkIndent && !state.isEmpty(line)) break;
        source +=
          (line === start ? '' : '\n') +
          state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
        if (source.length > MAX_MATH_LENGTH + 4) break;
        const match = mathAt(source, 0);
        if (!match) continue;
        if (source.slice(match.end).trim()) return false;
        if (silent) return true;
        const token = state.push('math_block', '', 0);
        token.block = true;
        token.content = match.tex;
        token.map = [start, line + 1];
        token.meta = { display: true };
        state.line = line + 1;
        return true;
      }
      return false;
    },
    { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
  );
  for (const type of ['math_inline', 'math_block'])
    parser.renderer.rules[type] = (tokens, i) =>
      render
        ? render(tokens[i].content, tokens[i].meta?.display === true) +
          (type === 'math_block' ? '\n' : '')
        : parser.utils.escapeHtml(tokens[i].content);
}
