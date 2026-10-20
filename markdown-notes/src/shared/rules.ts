import MarkdownIt from 'markdown-it';
import type { RefSpan, Snapshot } from './types';

export const LIMITS = {
  notes: 10_000,
  body: 1_048_576,
  total: 300 * 1_048_576,
  tags: 2_000,
  noteTags: 20,
  links: 100_000,
};
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
export function fail(code: string, message: string): never {
  throw new AppError(code, message);
}
export const key = (text: string) =>
  text.normalize('NFC').replace(/[A-Z]/g, (c) => c.toLowerCase());
export const trim = (text: string) => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
export const codepoints = (s: string) => [...s].length;
export const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
export function name(text: unknown, kind: 'title' | 'tag' = 'title') {
  if (typeof text !== 'string' || !text.isWellFormed()) fail('E_INPUT', '请输入有效的文字');
  const value = trim(text as string).normalize('NFC'),
    n = codepoints(value);
  if (
    n < 1 ||
    n > (kind === 'title' ? 100 : 30) ||
    /[\p{Cc}\u2028\u2029]/u.test(value) ||
    (kind === 'title' && /[\[\]]/.test(value))
  )
    fail(
      'E_INPUT',
      kind === 'title'
        ? '标题须为1—100个字符，不能含控制字符或方括号'
        : '标签须为1—30个字符，不能含控制字符',
    );
  return value;
}
export function body(text: unknown) {
  if (typeof text !== 'string' || !text.isWellFormed()) fail('E_INPUT', '正文不是有效文字');
  if (bytes(text as string) > LIMITS.body) fail('E_CAPACITY', '单篇正文不能超过1 MiB');
  return text as string;
}
export function keyword(text: unknown) {
  if (typeof text !== 'string' || !text.isWellFormed()) fail('E_INPUT', '搜索词无效');
  const q = key(trim(text as string));
  if (codepoints(q) > 100) fail('E_INPUT', '搜索词最多100个字符');
  return q;
}
export function matchRange(text: string, q: string): [number, number] | null {
  if (!q) return null;
  const at = key(text).indexOf(q);
  if (at < 0) return null;
  let normalized = 0,
    start = -1,
    end = -1;
  for (const s of new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)) {
    const next = normalized + key(s.segment).length;
    if (start < 0 && next > at) start = s.index;
    if (next >= at + q.length) {
      end = s.index + s.segment.length;
      break;
    }
    normalized = next;
  }
  return start >= 0 && end >= start ? [start, end] : null;
}
export const md = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
});

/** All positions refer to the original UTF-16 source. Never normalize the body. */
export function refs(content: string): RefSpan[] {
  if (!content.includes('[[')) return [];
  const excluded = new Uint8Array(content.length),
    starts = [0];
  if (
    content.includes('`') ||
    content.includes('~') ||
    /^(?:[ \t>]|(?:[-+*]|\d+[.)])\s)/m.test(content)
  ) {
    for (let i = content.indexOf('\n'); i >= 0; i = content.indexOf('\n', i + 1))
      starts.push(i + 1);
    for (const token of md.parse(content, {}))
      if ((token.type === 'fence' || token.type === 'code_block') && token.map) {
        const a = starts[token.map[0]] ?? content.length,
          b = starts[token.map[1]] ?? content.length;
        excluded.fill(1, a, b);
      }
  }
  for (let i = content.indexOf('`'); i >= 0; i = content.indexOf('`', i + 1)) {
    if (excluded[i] || content[i] !== '`') continue;
    let slashes = 0;
    for (let p = i - 1; p >= 0 && content[p] === '\\'; p--) slashes++;
    if (slashes % 2) continue;
    let j = i;
    while (content[j] === '`') j++;
    const run = j - i;
    let end = -1;
    for (let p = j; p < content.length; p++) {
      if (excluded[p]) break;
      if (content[p] !== '`') continue;
      let q = p;
      while (content[q] === '`') q++;
      if (q - p === run) {
        end = q;
        break;
      }
      p = q - 1;
    }
    if (end >= 0) {
      excluded.fill(1, i, end);
      i = end - 1;
    } else i = j - 1;
  }
  const out: RefSpan[] = [];
  for (let i = content.indexOf('[['); i >= 0; i = content.indexOf('[[', i + 1)) {
    if (excluded[i] || content.slice(i, i + 2) !== '[[') continue;
    let s = 0;
    for (let p = i - 1; p >= 0 && content[p] === '\\'; p--) s++;
    if (s % 2) {
      i++;
      continue;
    }
    let end = content.indexOf(']]', i + 2),
      line = content.indexOf('\n', i + 2);
    if (end < 0 || (line >= 0 && end > line)) {
      i = line < 0 ? content.length : line;
      continue;
    }
    const raw = content.slice(i + 2, end);
    let invalid = false;
    for (let p = i; p < end + 2; p++) if (excluded[p]) invalid = true;
    if (!invalid && !/[\[\]]/.test(raw)) {
      try {
        const n = name(raw);
        out.push({ start: i, end: end + 2, name: raw, key: key(n) });
      } catch {}
    }
    i = end + 1;
  }
  return out;
}
export function counts(text: string) {
  const map = new Map<string, { name: string; count: number }>();
  for (const r of refs(text)) {
    const old = map.get(r.key);
    if (old) old.count++;
    else map.set(r.key, { name: r.name, count: 1 });
  }
  return map;
}
export function renameRefs(content: string, oldKey: string, newTitle: string) {
  let result = content;
  for (const r of refs(content)
    .filter((r) => r.key === oldKey)
    .reverse())
    result = result.slice(0, r.start) + `[[${newTitle}]]` + result.slice(r.end);
  return result;
}
export function validateSnapshot(s: Snapshot) {
  if (s.schema_version !== 1) fail('E_VERSION', '不支持的资料库格式版本');
  if (s.notes.length > LIMITS.notes || s.tags.length > LIMITS.tags)
    fail('E_CAPACITY', '笔记或标签总数超过上限');
  const ids = new Set<string>(),
    titles = new Set<string>(),
    tags = new Set<string>(),
    tagNames = new Set<string>();
  let total = 0;
  for (const n of s.notes) {
    if (ids.has(n.note_id)) fail('E_PACKAGE', '笔记ID重复');
    ids.add(n.note_id);
    if (name(n.title) !== n.title) fail('E_PACKAGE', '备份标题须为规范化显示标题');
    body(n.content);
    total += bytes(n.content);
    if (n.user_id !== s.profile.user_id) fail('E_PACKAGE', '笔记所属档案无效');
    if (!n.deleted_at) {
      const k = key(name(n.title));
      if (titles.has(k)) fail('E_NAME_CONFLICT', '存在重复的有效标题');
      titles.add(k);
    }
  }
  if (total > LIMITS.total) fail('E_CAPACITY', '全部正文不能超过300 MiB');
  for (const t of s.tags) {
    name(t.name, 'tag');
    const k = key(name(t.name, 'tag'));
    if (tags.has(t.tag_id) || tagNames.has(k) || t.user_id !== s.profile.user_id)
      fail('E_PACKAGE', '标签ID、名称或所属档案无效');
    tags.add(t.tag_id);
    tagNames.add(k);
  }
  const pairs = new Set<string>(),
    perNote = new Map<string, number>();
  for (const a of s.note_tags) {
    const pair = a.note_id + ':' + a.tag_id;
    if (!ids.has(a.note_id) || !tags.has(a.tag_id) || pairs.has(pair))
      fail('E_PACKAGE', '标签关联重复或存在无效外键');
    pairs.add(pair);
    const n = (perNote.get(a.note_id) ?? 0) + 1;
    if (n > 20) fail('E_CAPACITY', '每篇最多20个标签');
    perNote.set(a.note_id, n);
  }
  let links = 0;
  for (const n of s.notes)
    if (!n.deleted_at) for (const k of counts(n.content).keys()) if (titles.has(k)) links++;
  if (links > LIMITS.links) fail('E_CAPACITY', '有效引用关系不能超过100,000条');
  return { notes: s.notes.length, tags: s.tags.length, bytes: total, links };
}

export function markdown(content: string) {
  let source = content;
  for (const r of refs(content).reverse()) {
    const label = r.name.replace(/[\\`*_[\]<>|]/g, '\\$&');
    source =
      source.slice(0, r.start) +
      `[${label}](note:${encodeURIComponent(r.key)})` +
      source.slice(r.end);
  }
  const parser = new MarkdownIt({ html: false, linkify: false });
  parser.renderer.rules.image = () =>
    '<span class="image-placeholder">[图片：基础版不加载图片]</span>';
  const link =
    parser.renderer.rules.link_open ?? ((t, i, o, _e, self) => self.renderToken(t, i, o));
  parser.renderer.rules.link_open = (tokens, i, options, env, self) => {
    const href = String(tokens[i].attrGet('href') ?? '');
    if (href.startsWith('note:')) {
      tokens[i].attrSet('data-note', href.slice(5));
      tokens[i].attrSet('href', '#');
    } else if (!/^https?:\/\//i.test(href)) {
      tokens[i].attrSet('href', '#');
      tokens[i].attrSet('aria-disabled', 'true');
    }
    return link(tokens, i, options, env, self);
  };
  return parser
    .render(source)
    .replace(
      /(<li>)(\s*)\[([ xX])\] /g,
      (_m, a, b, c) => `${a}${b}<input type="checkbox" disabled ${c !== ' ' ? 'checked' : ''}> `,
    );
}
