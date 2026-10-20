import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mathAt, MAX_MATH_LENGTH } from '../src/shared/math';
import { markdown, refs, renameRefs } from '../src/shared/rules';
import { mathMarkup } from '../src/renderer/math-render';
import { Store } from '../src/backend/store';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

test('四种公式定界符，转义、金额和未完成输入', () => {
  for (const [raw, display] of [
    [String.raw`$x^2$`, false],
    [String.raw`\(x^2\)`, false],
    ['$$\nx^2\n$$', true],
    [String.raw`\[x^2\]`, true],
  ] as const) {
    const span = mathAt(raw, 0)!;
    assert.equal(span.end, raw.length);
    assert.equal(span.tex.trim(), 'x^2');
    assert.equal(span.display, display);
  }
  for (const raw of [
    '$ hello$',
    '$x $',
    '$x\ny$',
    '$x',
    '$5 and $10',
    '$' + 'x'.repeat(MAX_MATH_LENGTH + 1) + '$',
  ])
    assert.equal(mathAt(raw, 0), null);
  assert.equal(mathAt(String.raw`\$x$`, 1), null);
  assert.equal(mathAt(String.raw`$x+\$y$`, 0)?.tex, String.raw`x+\$y`);
});

test('公式、代码和转义不产生引用，重命名只改真实引用', () => {
  const raw =
    String.raw`[[A]] $[[A]]$ \([[A]]\) $$[[A]]$$ \[[[A]]\] ` + '`$[[A]]$`\n```tex\n$[[A]]$\n```';
  assert.equal(refs(raw).length, 1);
  assert.equal(renameRefs(raw, 'a', 'B'), raw.replace('[[A]]', '[[B]]'));
  assert.equal((markdown(raw, mathMarkup).match(/data-note=/g) ?? []).length, 1);
});

test('分式、积分、矩阵、对齐和中文公式；代码与多行块保持结构', () => {
  const raw =
    String.raw`行内 $E=mc^2$ 与 \(a_1\)。

$$
\begin{aligned}
\int_0^1 x^2\,dx &= \frac{1}{3} \\
A &= \begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}
\end{aligned}
$$

\[\sqrt{x}+\text{中文说明}\]

` + '`$x$`\n\n```tex\n$$x$$\n```';
  const html = markdown(raw, mathMarkup);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 4);
  assert.match(html, /中文说明/);
  assert.match(html, /<svg/); // radicals must retain their vector strokes after sanitization too
  assert.match(html, /<code>\$x\$<\/code>/);
  assert.match(html, /<pre><code class="language-tex">\$\$x\$\$/);
  assert.doesNotMatch(html, /math-error/);
});

test('错误公式安全回退，限制宏展开与不可信HTML命令', () => {
  for (const tex of [
    String.raw`\frac{`,
    String.raw`\notARealCommand{中文}`,
    String.raw`\def\x{\x}\x`,
    '<script>',
  ]) {
    const html = mathMarkup(tex, false);
    assert.doesNotMatch(html, /<script>|<iframe/);
  }
  assert.match(mathMarkup(String.raw`\frac{`, false), /math-error/);
  assert.doesNotMatch(
    mathMarkup(
      String.raw`\href{javascript:alert(1)}{x}\includegraphics{https://example.com/a.png}\htmlStyle{background:red}{x}`,
      false,
    ),
    /<a |<img |style="[^"]*background:red/,
  );
  mathMarkup(String.raw`\gdef\secret{1}\secret`, false);
  assert.match(mathMarkup(String.raw`\secret`, false), /math-error/);
});

test('旧版派生引用目录原子刷新，记录全部笔记供索引追赶，正文与修订号不变', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'zhiye-ref-upgrade-')), 'notes.sqlite');
  let store = new Store(path, true);
  const n = store.mutate('note.create', { title: 'A' }, randomUUID()).note;
  const saved = store.mutate(
    'note.save',
    {
      note_id: n.note_id,
      expected_revision: n.revision,
      content: '$[[A]]$',
      tag_ids: [],
      edit_sequence: 1,
    },
    randomUUID(),
  ).note;
  store.db.prepare('INSERT INTO note_refs VALUES(?,?,?,?)').run(n.note_id, 'a', 'A', 1);
  store.db.exec('PRAGMA user_version=0');
  const oldVersion = store.version;
  store.close();
  store = new Store(path, true);
  assert.equal((store.db.prepare('SELECT COUNT(*) n FROM note_refs').get() as any).n, 0);
  assert.equal(store.version, oldVersion + 1);
  const change = store.db
    .prepare('SELECT payload FROM changes WHERE version=?')
    .get(store.version) as any;
  assert.deepEqual(JSON.parse(change.payload).notes, [n.note_id]);
  assert.equal(store.note(n.note_id).content, saved.content);
  assert.equal(store.note(n.note_id).revision, saved.revision);
  store.close();
  store = new Store(path, true);
  assert.equal(store.version, oldVersion + 1); // migration is idempotent
  store.close();
});
