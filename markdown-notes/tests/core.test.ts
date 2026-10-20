import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/backend/store';
import { Backend } from '../src/backend/service';
import { readBackup, writeBackup, exportNotes, digest } from '../src/backend/archive';
import { name, key, keyword, refs, renameRefs, markdown, LIMITS } from '../src/shared/rules';
import type { Snapshot, Rpc } from '../src/shared/types';

const temp = () => mkdtempSync(join(tmpdir(), 'zhiye-test-'));
const create = (s: Store, title: string) => s.mutate('note.create', { title }, randomUUID()).note;
const save = (s: Store, n: any, content: string, tags: string[] = []) =>
  s.mutate(
    'note.save',
    { note_id: n.note_id, expected_revision: n.revision, content, tag_ids: tags, edit_sequence: 1 },
    randomUUID(),
  ).note;
const worker = resolve('dist/indexer.cjs');
function service(root = temp(), inject?: string) {
  return new Backend(root, worker, inject);
}
async function rpc(b: Backend, method: string, payload: any = {}, request_id = randomUUID()) {
  return b.call({ api_version: 1, request_id, epoch: b.epoch, method, payload });
}
async function ready(b: Backend) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const s = b.status();
    if (s.index.state === 'ready' && s.index.indexed_version === s.index.business_version) return;
    if (s.index.state === 'failed') throw new Error('index failed: ' + s.index.phase);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('index timeout');
}

test('名称：NFC、ASCII大小写、码点长度、控制字符与全角区别', () => {
  assert.equal(name(' \tCafe\u0301\u00a0'), 'Café');
  assert.equal(key('AbCÉ'), 'abcÉ');
  assert.notEqual(key('Ａ'), key('A'));
  assert.equal(name('😀'.repeat(100)).length, 200);
  assert.throws(() => name('😀'.repeat(101)));
  assert.throws(() => name('a\nB'));
  assert.throws(() => name('[[A]]'));
  assert.equal(name('A|B#C\\D:/E'), 'A|B#C\\D:/E');
  assert.equal(keyword(' [[ '), '[[');
});
test('解析：排除三类代码、奇偶转义、嵌套、相邻与字面特殊字符', () => {
  const text =
    '[[B]][[A#B]][[A|B]]\n`[[code]]`\n```md\n[[fence]]\n```\n\n    [[indent]]\n\n\\[[escaped]] \\\\[[even]] [[outer [[inner]]]] [[bad\nname]] [[ ]]';
  assert.deepEqual(
    refs(text).map((x) => x.key),
    ['b', 'a#b', 'a|b', 'even'],
  );
  assert.equal(renameRefs('[[B]] `[[B]]` \\[[B]]', 'b', 'C'), '[[C]] `[[B]]` \\[[B]]');
});
test('渲染：HTML不执行、远程图片不加载，双向引用与任务列表可用', () => {
  const html = markdown(
    '<script>bad()</script>\n\n![](https://evil.example/a.png)\n\n[[A|B]]\n\n- [x] 完成',
  );
  assert(!html.includes('<script>'));
  assert(!html.includes('<img'));
  assert(html.includes('data-note="a%7Cb"'));
  assert(html.includes('type="checkbox"'));
});
test('持久化、默认标题、重复标题、revision与请求幂等', (t) => {
  const dir = temp(),
    s = new Store(join(dir, 'business.sqlite'), true);
  t.after(() => s.close());
  const id = randomUUID(),
    first = s.mutate('note.create', {}, id);
  assert.equal(s.mutate('note.create', {}, id).note_id, first.note_id);
  assert.throws(() => s.mutate('note.create', { title: 'different' }, id));
  const n = s.mutate('note.create', {}, randomUUID()).note;
  assert.equal(n.title, '未命名笔记 1');
  assert.throws(() => create(s, '未命名笔记'));
  const saved = save(s, n, '中文\n**正文**');
  assert.equal(s.note(n.note_id).content, '中文\n**正文**');
  assert.throws(() => save(s, n, 'stale'), /已有更新/);
  assert.equal(saved.revision, n.revision + 1);
  const ro = new Store(s.path);
  assert.equal(ro.note(n.note_id).content, saved.content);
  ro.close();
});
test('原子重命名包含自引用，回收站、代码和转义原文不变', (t) => {
  const s = new Store(join(temp(), 'business.sqlite'), true);
  t.after(() => s.close());
  let b = create(s, 'B'),
    a = create(s, 'A'),
    trash = create(s, 'Trash');
  b = save(s, b, '[[B]]');
  a = save(s, a, '[[B]] [[B]] `[[B]]` \\[[B]]');
  trash = save(s, trash, '[[B]]');
  s.mutate(
    'trash.move',
    { note_id: trash.note_id, expected_revision: trash.revision },
    randomUUID(),
  );
  s.mutate(
    'note.rename',
    { note_id: b.note_id, expected_revision: b.revision, title: 'C' },
    randomUUID(),
  );
  assert.equal(s.note(b.note_id).content, '[[C]]');
  assert.equal(s.note(a.note_id).content, '[[C]] [[C]] `[[B]]` \\[[B]]');
  assert.equal(s.note(trash.note_id, true).content, '[[B]]');
});
test('重命名执行中失败与联动超限均整体回滚', (t) => {
  const s = new Store(join(temp(), 'business.sqlite'), true);
  t.after(() => s.close());
  let b = create(s, 'B'),
    a = create(s, 'A');
  a = save(s, a, 'x'.repeat(LIMITS.body - 5) + '[[B]]');
  const before = s.snapshot();
  assert.throws(
    () =>
      s.mutate(
        'note.rename',
        { note_id: b.note_id, expected_revision: b.revision, title: '非常长的新标题' },
        randomUUID(),
      ),
    /1 MiB/,
  );
  assert.deepEqual(s.snapshot(), before);
  assert.throws(() =>
    s.mutate(
      'note.rename',
      { note_id: b.note_id, expected_revision: b.revision, title: 'C' },
      randomUUID(),
      'beforeCommit',
    ),
  );
  assert.deepEqual(s.snapshot(), before);
});
test('全局删除标签包括回收站关联，同名新标签不重新关联', (t) => {
  const s = new Store(join(temp(), 'business.sqlite'), true);
  t.after(() => s.close());
  const tag = s.mutate('tag.create', { name: '课程' }, randomUUID()).tag_id;
  let n = save(s, create(s, 'A'), 'text', [tag]);
  n = s.mutate(
    'trash.move',
    { note_id: n.note_id, expected_revision: n.revision },
    randomUUID(),
  ).note;
  s.mutate('tag.delete', { tag_id: tag }, randomUUID());
  const newer = s.mutate('tag.create', { name: '课程' }, randomUUID()).tag_id;
  assert.notEqual(tag, newer);
  n = s.note(n.note_id, true);
  const restored = s.mutate(
    'trash.restore',
    { note_id: n.note_id, expected_revision: n.revision },
    randomUUID(),
  ).note;
  assert.deepEqual(restored.tags, []);
  assert.equal(restored.content, 'text');
});
test('21个标签拒绝，不会提交部分关联', (t) => {
  const s = new Store(join(temp(), 'business.sqlite'), true);
  t.after(() => s.close());
  const tags = Array.from(
      { length: 21 },
      (_, i) => s.mutate('tag.create', { name: 'T' + i }, randomUUID()).tag_id,
    ),
    n = create(s, 'A'),
    before = s.snapshot();
  assert.throws(() => save(s, n, 'text', tags));
  assert.deepEqual(s.snapshot(), before);
});
test('备份流式格式：原字节摘要、业务字段与导出元数据差异', async (t) => {
  const dir = temp(),
    s = new Store(join(dir, 'business.sqlite'), true);
  t.after(() => s.close());
  let n = save(s, create(s, '中文 / 标题'), '# 中文\n\n[[中文 / 标题]]\n\n```js\nconst a=1;\n```');
  const trashed = create(s, '回收站');
  s.mutate(
    'trash.move',
    { note_id: trashed.note_id, expected_revision: trashed.revision },
    randomUUID(),
  );
  const snapshot = s.snapshot(),
    record = await writeBackup(snapshot, join(dir, 'backups'));
  const read = await readBackup(record.file_path);
  assert.deepEqual(read.snapshot, JSON.parse(JSON.stringify(snapshot)));
  assert.equal(record.checksum, await digest(record.file_path));
  const single = join(dir, 'single.md');
  await exportNotes(snapshot, single, n.note_id);
  assert.equal(readFileSync(single, 'utf8'), n.content);
  const all = join(dir, 'all.zip');
  await exportNotes(snapshot, all);
  await assert.rejects(readBackup(all));
});
test('损坏ZIP、摘要不一致、额外条目均拒绝且不改变原库', async (t) => {
  const dir = temp(),
    s = new Store(join(dir, 'business.sqlite'), true);
  t.after(() => s.close());
  create(s, '保护原文');
  const before = await digest(s.path);
  const bad = join(dir, 'bad.zip');
  writeFileSync(bad, 'not zip');
  await assert.rejects(readBackup(bad));
  assert.equal(before, await digest(s.path));
});
test('单资料库排他锁与未知格式保护', async () => {
  const root = temp(),
    b = service(root);
  await ready(b);
  assert.throws(() => service(root), /其他实例/);
  await b.close();
  const next = service(root);
  await ready(next);
  await next.close();
});
test('搜索、字面匹配、标签交集、分页作废与双向引用', async (t) => {
  const b = service();
  t.after(() => b.close());
  await ready(b);
  const target = (await rpc(b, 'note.create', { title: '概念#A|B' })).note;
  let a = (await rpc(b, 'note.create', { title: '学习 Café' })).note;
  await rpc(b, 'note.save', {
    note_id: a.note_id,
    expected_revision: a.revision,
    content: '中文离散数学 % [[概念#A|B]] [[概念#A|B]] `[[ignore]]`',
    tag_ids: [],
    edit_sequence: 1,
  });
  await ready(b);
  assert.equal((await rpc(b, 'search.query', { keyword: '离散', scope: 'content' })).total, 1);
  assert.equal((await rpc(b, 'search.query', { keyword: 'Cafe\u0301', scope: 'title' })).total, 1);
  assert.equal((await rpc(b, 'search.query', { keyword: '%' })).total, 1);
  const links = await rpc(b, 'links', { note_id: target.note_id });
  assert.equal(links.incoming[0].occurrences, 2);
  const q = await rpc(b, 'search.query', { keyword: '学习' });
  await rpc(b, 'note.create', { title: '学习2' });
  await ready(b);
  await assert.rejects(rpc(b, 'search.query', { query_token: q.query_token, page: 2 }), /变更/);
});
test('重建期间编辑、删除、标签变更和同名激活均进入新版本', async (t) => {
  const b = service();
  t.after(() => b.close());
  await ready(b);
  const notes: any[] = [];
  for (let i = 0; i < 80; i++)
    notes.push((await rpc(b, 'note.create', { title: '笔记' + i })).note);
  const tag = (await rpc(b, 'tag.create', { name: '旧标签' })).tag_id;
  await ready(b);
  await rpc(b, 'index.rebuild');
  await rpc(b, 'note.save', {
    note_id: notes[0].note_id,
    expected_revision: 0,
    content: '重建期间独有词 [[未来目标]]',
    tag_ids: [tag],
    edit_sequence: 1,
  });
  await rpc(b, 'trash.move', { note_id: notes[1].note_id, expected_revision: 0 });
  await rpc(b, 'tag.rename', { tag_id: tag, name: '新标签' });
  const target = (await rpc(b, 'note.create', { title: '未来目标' })).note;
  await ready(b);
  assert.equal((await rpc(b, 'search.query', { keyword: '重建期间独有词' })).total, 1);
  assert.equal((await rpc(b, 'search.query', { keyword: '新标签', scope: 'tag' })).total, 1);
  assert.equal((await rpc(b, 'links', { note_id: target.note_id })).incoming.length, 1);
  await assert.rejects(rpc(b, 'note.get', { note_id: notes[1].note_id }));
});
test('正常恢复有保护备份，新epoch拒绝旧保存，保留本机历史', async (t) => {
  const root = temp(),
    b = service(root);
  t.after(() => b.close());
  await ready(b);
  let n = (await rpc(b, 'note.create', { title: 'A' })).note;
  n = (
    await rpc(b, 'note.save', {
      note_id: n.note_id,
      expected_revision: n.revision,
      content: '备份时的正文',
      tag_ids: [],
      edit_sequence: 1,
    })
  ).note;
  const backup = await rpc(b, 'backup.create', { directory: join(root, 'backups') });
  await rpc(b, 'note.save', {
    note_id: n.note_id,
    expected_revision: n.revision,
    content: '后续更改',
    tag_ids: [],
    edit_sequence: 2,
  });
  const oldEpoch = b.epoch,
    inspect = await rpc(b, 'restore.inspect', { path: backup.file_path });
  const restoreId = randomUUID();
  const restorePayload = {
    inspect_token: inspect.inspect_token,
    backup_directory: join(root, 'backups'),
  };
  const restoreResult = await rpc(b, 'restore.execute', restorePayload, restoreId);
  await ready(b);
  assert.deepEqual(await rpc(b, 'restore.execute', restorePayload, restoreId), restoreResult);
  await assert.rejects(
    rpc(
      b,
      'restore.execute',
      { ...restorePayload, backup_directory: join(root, 'different') },
      restoreId,
    ),
    /不同参数/,
  );
  assert.notEqual(b.epoch, oldEpoch);
  assert.equal((await rpc(b, 'note.get', { note_id: n.note_id })).content, '备份时的正文');
  assert.equal((await rpc(b, 'backup.list')).length, 2);
  await assert.rejects(
    b.call({
      api_version: 1,
      request_id: randomUUID(),
      epoch: oldEpoch,
      method: 'note.save',
      payload: {
        note_id: n.note_id,
        expected_revision: n.revision,
        content: '旧请求',
        tag_ids: [],
        edit_sequence: 3,
      },
    }),
    /切换/,
  );
});
test('主库损坏时故障恢复不依赖旧库有效备份，原文件逐字节保留', async () => {
  const root = temp();
  let b = service(root);
  await ready(b);
  const n = (await rpc(b, 'note.create', { title: '重要笔记' })).note;
  const backup = await rpc(b, 'backup.create', { directory: join(root, 'backups') });
  const oldPath = b.activePath;
  await b.close();
  writeFileSync(oldPath, 'damaged database');
  const original = readFileSync(oldPath);
  b = service(root);
  assert(b.status().fault);
  const inspect = await rpc(b, 'restore.inspect', { path: backup.file_path });
  assert.equal(inspect.mode, 'fault');
  await rpc(b, 'restore.execute', { inspect_token: inspect.inspect_token });
  await ready(b);
  assert.deepEqual(readFileSync(oldPath), original);
  assert.equal((await rpc(b, 'note.get', { note_id: n.note_id })).title, '重要笔记');
  assert(existsSync(backup.file_path));
  await b.close();
});
test('恢复暂存失败不会切换活动库或改变原始正文', async () => {
  const root = temp();
  let b = service(root);
  await ready(b);
  const n = (await rpc(b, 'note.create', { title: 'A' })).note;
  const backup = await rpc(b, 'backup.create', { directory: join(root, 'backups') });
  await b.close();
  b = service(root, 'restoreBuild');
  await ready(b);
  const epoch = b.epoch,
    path = b.activePath,
    inspect = await rpc(b, 'restore.inspect', { path: backup.file_path });
  await assert.rejects(
    rpc(b, 'restore.execute', {
      inspect_token: inspect.inspect_token,
      backup_directory: join(root, 'backups'),
    }),
  );
  assert.equal(b.epoch, epoch);
  assert.equal(b.activePath, path);
  assert.equal((await rpc(b, 'note.get', { note_id: n.note_id })).title, 'A');
  await b.close();
});
