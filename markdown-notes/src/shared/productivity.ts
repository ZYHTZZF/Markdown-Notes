import { z } from 'zod';
import MarkdownIt from 'markdown-it';
import { body, bytes, fail, name, refs } from './rules';
import { mathPlugin } from './math';

export const templateSchema = z
  .object({
    template_id: z.string().uuid(),
    title: z.string(),
    content: z.string(),
  })
  .strict();
export type NoteTemplate = z.infer<typeof templateSchema>;
export const productivitySchema = z.object({
  favorites: z.array(z.string().uuid()).max(10000).optional(),
  pinned: z.array(z.string().uuid()).max(10000).optional(),
  templates: z.array(templateSchema).max(50).optional(),
});
export function validateProductivity(preferences: Record<string, unknown>, noteIds?: Set<string>) {
  const p = productivitySchema.parse(preferences);
  for (const field of ['favorites', 'pinned'] as const) {
    const ids = p[field] ?? [];
    if (new Set(ids).size !== ids.length || (noteIds && ids.some((id) => !noteIds.has(id))))
      fail('E_PACKAGE', '收藏或置顶包含重复、无效笔记');
  }
  const ids = new Set<string>();
  let size = 0;
  for (const t of p.templates ?? []) {
    if (ids.has(t.template_id) || name(t.title) !== t.title) fail('E_INPUT', '模板名称或标识无效');
    ids.add(t.template_id);
    body(t.content);
    if (bytes(t.content) > 65536) fail('E_CAPACITY', '单个模板最多64 KiB');
    size += bytes(t.content);
  }
  if (size > 262144) fail('E_CAPACITY', '自定义模板正文合计最多256 KiB');
  return p;
}
export const BUILTIN_TEMPLATES = [
  {
    template_id: 'course',
    title: '课程笔记',
    content:
      '# 课程笔记\n\n## 学习目标\n\n- \n\n## 核心概念\n\n## 例题与推导\n\n## 疑问与复习\n\n- [ ] 复习本节内容\n',
  },
  {
    template_id: 'meeting',
    title: '会议记录',
    content:
      '# 会议记录\n\n## 会议主题\n\n## 讨论要点\n\n- \n\n## 决定\n\n## 待办事项\n\n- [ ] 事项 / 负责人 / 截止日期\n',
  },
  {
    template_id: 'reading',
    title: '阅读摘记',
    content:
      '# 阅读摘记\n\n## 资料来源\n\n## 主要观点\n\n## 我的理解\n\n## 相关知识\n\n## 后续行动\n\n- [ ] \n',
  },
];
const parser = new MarkdownIt({ html: false });
mathPlugin(parser);
export function outline(content: string) {
  const starts = [0];
  for (let i = content.indexOf('\n'); i >= 0; i = content.indexOf('\n', i + 1)) starts.push(i + 1);
  const tokens = parser.parse(content, {});
  return tokens.flatMap((t, i) =>
    t.type === 'heading_open' && t.map
      ? [
          {
            level: Number(t.tag.slice(1)),
            text:
              tokens[i + 1]?.children
                ?.map((c) =>
                  c.type === 'image'
                    ? c.content
                    : c.type.endsWith('_open') || c.type.endsWith('_close')
                      ? ''
                      : c.content,
                )
                .join('') ||
              tokens[i + 1]?.content ||
              '无标题',
            offset: starts[t.map[0]] ?? 0,
          },
        ]
      : [],
  );
}
/** Validate a prospective complete reference using the same parser as persisted references. */
export function completionContext(text: string, caret: number) {
  const start = text.lastIndexOf('[[', caret - 1);
  if (start < 0 || caret < start + 2 || /[\[\]\r\n]/.test(text.slice(start + 2, caret)))
    return null;
  const end = text.slice(caret, caret + 2) === ']]' ? caret + 2 : caret;
  const candidate = text.slice(0, start) + '[[候选笔记]]' + text.slice(end);
  if (!refs(candidate).some((r) => r.start === start)) return null;
  return { start, end, query: text.slice(start + 2, caret) };
}
