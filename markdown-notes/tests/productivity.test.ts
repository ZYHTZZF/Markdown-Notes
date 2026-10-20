import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/backend/store';
import { Backend } from '../src/backend/service';
import { writeBackup, readBackup } from '../src/backend/archive';
import { outline, completionContext, validateProductivity } from '../src/shared/productivity';
const temp = () => mkdtempSync(join(tmpdir(), 'zhiye-productivity-'));
const mutation = (s: Store, m: string, p: any) => s.mutate(m, p, randomUUID());

test('跨页置顶先排序再分页，收藏筛选与标签筛选取交集', () => {
  const s = new Store(join(temp(), 'data.sqlite'), true);
  try {
    const ids: string[] = [];
    for (let i = 0; i < 55; i++)
      ids.push(mutation(s, 'note.create', { title: '分页' + i }).note_id);
    const old = s.note(ids[0]);
    mutation(s, 'note.flag', {
      note_id: old.note_id,
      expected_revision: old.revision,
      flag: 'pinned',
      value: true,
    });
    assert.equal(s.list().items[0].note_id, old.note_id);
    assert.equal(s.list(false, [], 2).items.length, 5);
    assert.equal(
      new Set([...s.list().items, ...s.list(false, [], 2).items].map((n) => n.note_id)).size,
      55,
    );
    const tag = mutation(s, 'tag.create', { name: '课程' });
    let n = s.note(ids[1]);
    n = mutation(s, 'note.flag', {
      note_id: n.note_id,
      expected_revision: n.revision,
      flag: 'favorites',
      value: true,
    }).note;
    assert.equal(s.list(false, [tag.tag_id], 1, true).total, 0);
    mutation(s, 'note.setTags', {
      note_id: n.note_id,
      expected_revision: n.revision,
      tag_ids: [tag.tag_id],
    });
    assert.equal(s.list(false, [tag.tag_id], 1, true).items[0].note_id, n.note_id);
  } finally {
    s.close();
  }
});

test('大纲按源文位置处理ATX/Setext、重复标题、CRLF，排除代码与公式', () => {
  const text =
    '# 一级\r\n\r\n## **重复**\r\n\r\n重复\r\n---\r\n\r\n```md\r\n# 假标题\r\n```\r\n\r\n$$\r\n# 非标题\r\n$$\r\n';
  const headings = outline(text);
  assert.deepEqual(
    headings.map((h) => [h.level, h.text]),
    [
      [1, '一级'],
      [2, '重复'],
      [2, '重复'],
    ],
  );
  assert.equal(headings[2].offset, text.indexOf('重复\r\n---'));
});
test('补全复用引用语义：特殊字符、转义、代码、公式与已有闭括号', () => {
  const text = '前文 [[A|B#C\\D]] 后文';
  assert.deepEqual(completionContext(text, text.indexOf(']]')), {
    start: 3,
    end: text.indexOf(']]') + 2,
    query: 'A|B#C\\D',
  });
  for (const text of ['\\[[A', '`[[A]]`', '```md\n[[A\n```', '$$\n[[A\n$$', '[[x [[A']) {
    const caret = text.indexOf('A') + 1;
    assert.equal(completionContext(text, caret), null, text);
  }
  assert.equal(completionContext('[[', 2)?.query, '');
  assert.equal(completionContext('[[跨\n行', 6), null);
});
test('收藏置顶排序、幂等、回收恢复保留、永久删除清理及失败回滚', () => {
  const s = new Store(join(temp(), 'data.sqlite'), true);
  try {
    let a = mutation(s, 'note.create', { title: 'A' }).note;
    mutation(s, 'note.create', { title: 'B' });
    const payload = {
        note_id: a.note_id,
        expected_revision: a.revision,
        flag: 'pinned',
        value: true,
      },
      id = randomUUID();
    a = s.mutate('note.flag', payload, id).note;
    assert.equal(s.mutate('note.flag', payload, id).note.revision, a.revision);
    a = mutation(s, 'note.flag', {
      note_id: a.note_id,
      expected_revision: a.revision,
      flag: 'favorites',
      value: true,
    }).note;
    assert.equal(s.list().items[0].note_id, a.note_id);
    assert.equal(s.list(false, [], 1, true).total, 1);
    assert.throws(() =>
      s.mutate(
        'note.flag',
        { note_id: a.note_id, expected_revision: a.revision, flag: 'favorites', value: false },
        randomUUID(),
        'beforeCommit',
      ),
    );
    assert.equal(s.note(a.note_id).favorite, true);
    a = mutation(s, 'trash.move', { note_id: a.note_id, expected_revision: a.revision }).note;
    assert.equal(s.list(false, [], 1, true).total, 0);
    a = mutation(s, 'trash.restore', { note_id: a.note_id, expected_revision: a.revision }).note;
    assert.equal(a.pinned, true);
    assert.equal(a.favorite, true);
    a = mutation(s, 'trash.move', { note_id: a.note_id, expected_revision: a.revision }).note;
    mutation(s, 'trash.purge', { note_id: a.note_id, expected_revision: a.revision });
    assert.deepEqual(s.profile().preferences.favorites, []);
    assert.deepEqual(s.profile().preferences.pinned, []);
  } finally {
    s.close();
  }
});
test('模板新建为原子操作、同名自动编号、独立副本、限制与回滚', () => {
  const s = new Store(join(temp(), 'data.sqlite'), true);
  try {
    const t = mutation(s, 'template.save', { title: '课程模板', content: '# 内容\n[[目标]]' });
    const a = mutation(s, 'note.create', { template_id: t.template_id }).note;
    const b = mutation(s, 'note.create', { template_id: t.template_id }).note;
    assert.equal(a.content, '# 内容\n[[目标]]');
    assert.equal(b.title, '课程模板 1');
    mutation(s, 'template.save', {
      template_id: t.template_id,
      title: '课程模板',
      content: '已改模板',
    });
    assert.equal(s.note(a.note_id).content, a.content);
    const count = (s.stats() as any).notes;
    assert.throws(() =>
      s.mutate('note.create', { template_id: 'course' }, randomUUID(), 'beforeCommit'),
    );
    assert.equal((s.stats() as any).notes, count);
    assert.throws(() =>
      mutation(s, 'template.save', { title: '过大', content: 'x'.repeat(65537) }),
    );
    assert.throws(() =>
      validateProductivity({
        templates: Array.from({ length: 51 }, () => ({
          template_id: randomUUID(),
          title: '模板',
          content: '',
        })),
      }),
    );
    assert.throws(() => mutation(s, 'note.create', { template_id: 'gone' }));
    mutation(s, 'template.delete', { template_id: t.template_id });
    assert.throws(() =>
      mutation(s, 'template.save', {
        template_id: t.template_id,
        title: '已删除模板',
        content: '不应复活',
      }),
    );
    assert.equal(s.note(b.note_id).content, b.content);
  } finally {
    s.close();
  }
});
test('格式2完整备份保留收藏、置顶、自定义模板，新库导入后可继续使用', async () => {
  const root = temp(),
    s = new Store(join(root, 'data.sqlite'), true),
    dest = new Store(join(root, 'dest.sqlite'), true);
  try {
    let n = mutation(s, 'note.create', { title: '重要笔记' }).note;
    for (const flag of ['favorites', 'pinned'])
      n = mutation(s, 'note.flag', {
        note_id: n.note_id,
        expected_revision: n.revision,
        flag,
        value: true,
      }).note;
    const t = mutation(s, 'template.save', { title: '我的模板', content: '## 中文 $E=mc^2$' });
    const b = await writeBackup(s.snapshot(), join(root, 'backup'));
    const parsed = await readBackup(b.file_path);
    assert.equal(parsed.manifest.format_version, 2);
    dest.import(parsed.snapshot);
    assert.equal(dest.note(n.note_id).favorite, true);
    assert.equal(dest.note(n.note_id).pinned, true);
    assert.equal(
      mutation(dest, 'note.create', { template_id: t.template_id }).note.content,
      '## 中文 $E=mc^2$',
    );
    const bad = structuredClone(parsed.snapshot);
    bad.profile.preferences.favorites = [randomUUID()];
    assert.throws(() => dest.import(bad));
    assert.equal(dest.note(n.note_id).favorite, true);
  } finally {
    s.close();
    dest.close();
  }
});
test('服务补全排除回收站、规范化字面查询；收藏搜索分页与恢复一致', async () => {
  const b = new Backend(temp(), resolve('dist/indexer.cjs'));
  const call = (method: string, payload: any = {}) =>
    b.call({ api_version: 1, request_id: randomUUID(), epoch: b.epoch, method, payload });
  try {
    let n = (await call('note.create', { title: 'Café|#\\😀' })).note;
    await call('note.create', { title: 'Other' });
    assert.equal((await call('note.suggest', { keyword: 'CAFe\u0301|#\\' }))[0].note_id, n.note_id);
    n = (
      await call('note.flag', {
        note_id: n.note_id,
        expected_revision: n.revision,
        flag: 'favorites',
        value: true,
      })
    ).note;
    for (
      let i = 0;
      i < 500 && (b.index.state !== 'ready' || b.index.indexed_version !== b.store!.version);
      i++
    )
      await new Promise((r) => setTimeout(r, 20));
    const result = await call('search.query', { keyword: '', favorites_only: true });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].note_id, n.note_id);
    n = (await call('trash.move', { note_id: n.note_id, expected_revision: n.revision })).note;
    assert.deepEqual(await call('note.suggest', { keyword: 'Café' }), []);
    await assert.rejects(
      call('note.flag', {
        note_id: n.note_id,
        expected_revision: n.revision,
        flag: 'favorites',
        value: false,
      }),
    );
  } finally {
    await b.close();
  }
});
