import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { fork } from 'node:child_process';
import { ZipFile } from 'yazl';
import { Store } from '../src/backend/store';
import { Backend } from '../src/backend/service';
import { readBackup, writeBackup } from '../src/backend/archive';
import { matchRange } from '../src/shared/rules';
import type { Snapshot } from '../src/shared/types';
const tmp = () => mkdtempSync(join(tmpdir(), 'zhiye-safe-'));
const worker = resolve('dist/indexer.cjs');
const call = (b: Backend, method: string, payload: any = {}) =>
  b.call({ api_version: 1, request_id: randomUUID(), epoch: b.epoch, method, payload });
async function ready(b: Backend) {
  for (let i = 0; i < 1000; i++) {
    if (b.index.state === 'ready' && b.index.indexed_version === b.store!.version) return;
    if (b.index.state === 'failed') throw Error(b.index.phase);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('timeout');
}
function sample() {
  const root = tmp(),
    s = new Store(join(root, 'source.sqlite'), true),
    n = s.mutate('note.create', { title: 'A' }, randomUUID()).note;
  s.mutate(
    'note.save',
    {
      note_id: n.note_id,
      expected_revision: 0,
      content: '不可泄漏的正文',
      tag_ids: [],
      edit_sequence: 1,
    },
    randomUUID(),
  );
  const data = s.snapshot();
  s.close();
  return data;
}
async function crafted(
  data: Buffer | string,
  options: {
    extra?: boolean;
    duplicateManifest?: boolean;
    badHash?: boolean;
    format?: number;
    symlink?: boolean;
  } = {},
) {
  const dir = tmp(),
    file = join(dir, 'backup.zip'),
    buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let manifest = JSON.stringify({
    format_version: options.format ?? 1,
    backup_id: randomUUID(),
    snapshot_at: new Date().toISOString(),
    note_count: 1,
    data_size_bytes: buffer.length,
    checksum_algorithm: 'SHA-256',
    data_sha256: options.badHash
      ? '0'.repeat(64)
      : createHash('sha256').update(buffer).digest('hex'),
  });
  if (options.duplicateManifest)
    manifest = manifest.replace('"format_version":1', '"format_version":1,"format_version":1');
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(manifest),
    'manifest.json',
    options.symlink ? { mode: 0o120777 } : undefined,
  );
  zip.addBuffer(buffer, 'data.json');
  if (options.extra) zip.addBuffer(Buffer.from('bad'), 'extra.txt');
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(file));
  return file;
}

test('备份拒绝重复字段、额外条目、符号链接与未知格式', async () => {
  const raw = JSON.stringify(sample());
  for (const option of [
    { extra: true },
    { duplicateManifest: true },
    { format: 99 },
    { symlink: true },
  ])
    await assert.rejects(readBackup(await crafted(raw, option)));
  const duplicate = raw.replace('"schema_version":1', '"schema_version":1,"schema_version":1');
  await assert.rejects(readBackup(await crafted(duplicate)));
});
test('备份拒绝错误顶层类型、无效外键、伪造摘要、非法UTF-8', async () => {
  const source = sample();
  const wrong = { ...source, notes: {} };
  await assert.rejects(readBackup(await crafted(JSON.stringify(wrong))));
  const fk = {
    ...source,
    note_tags: [
      {
        note_id: source.notes[0].note_id,
        tag_id: randomUUID(),
        created_at: new Date().toISOString(),
      },
    ],
  };
  await assert.rejects(readBackup(await crafted(JSON.stringify(fk))));
  await assert.rejects(readBackup(await crafted(JSON.stringify(source), { badHash: true })));
  await assert.rejects(
    readBackup(
      await crafted(Buffer.concat([Buffer.from(JSON.stringify(source)), Buffer.from([255])])),
    ),
  );
});
test('正文容量在流式解析时拒绝超限', async () => {
  const s = sample();
  s.notes[0].content = 'x'.repeat(1048577);
  await assert.rejects(readBackup(await crafted(JSON.stringify(s))), /1 MiB|容量/);
});
test('组合字符和emoji高亮映回完整原字符区间', () => {
  assert.deepEqual(matchRange('xCafe\u0301😀尾', 'café'), [1, 6]);
  assert.deepEqual(matchRange('x😀尾', '😀'), [1, 3]);
  assert.equal(matchRange('Ａ', 'a'), null);
});
test('同名新建重新绑定，恢复改名不猜测历史自引用', async (t) => {
  const b = new Backend(tmp(), worker);
  t.after(() => b.close());
  await ready(b);
  let target = (await call(b, 'note.create', { title: 'B' })).note;
  const a = (await call(b, 'note.create', { title: 'A' })).note;
  await call(b, 'note.save', {
    note_id: a.note_id,
    expected_revision: 0,
    content: '[[B]]',
    tag_ids: [],
    edit_sequence: 1,
  });
  target = (
    await call(b, 'note.save', {
      note_id: target.note_id,
      expected_revision: 0,
      content: '[[B]]',
      tag_ids: [],
      edit_sequence: 1,
    })
  ).note;
  target = (
    await call(b, 'trash.move', { note_id: target.note_id, expected_revision: target.revision })
  ).note;
  const newer = (await call(b, 'note.create', { title: 'B' })).note;
  await ready(b);
  assert.equal(
    (await call(b, 'links', { note_id: a.note_id })).outgoing[0].target_id,
    newer.note_id,
  );
  await call(b, 'trash.restore', {
    note_id: target.note_id,
    expected_revision: target.revision,
    title: 'C',
  });
  await ready(b);
  assert.equal((await call(b, 'note.get', { note_id: target.note_id })).content, '[[B]]');
  assert.equal(
    (await call(b, 'links', { note_id: target.note_id })).outgoing[0].target_id,
    newer.note_id,
  );
});
test('120条结果翻页50/50/20且无重复', async (t) => {
  const b = new Backend(tmp(), worker);
  t.after(() => b.close());
  await ready(b);
  for (let i = 0; i < 120; i++) await call(b, 'note.create', { title: '分页笔记' + i });
  await ready(b);
  const first = await call(b, 'search.query', { keyword: '分页', scope: 'title' }),
    second = await call(b, 'search.query', { query_token: first.query_token, page: 2 }),
    third = await call(b, 'search.query', { query_token: first.query_token, page: 3 });
  assert.deepEqual([first.items.length, second.items.length, third.items.length], [50, 50, 20]);
  assert.equal(
    new Set([...first.items, ...second.items, ...third.items].map((n) => n.note_id)).size,
    120,
  );
});
test('正常恢复保护备份失败／切换前失败保持旧库完整', async () => {
  const root = tmp();
  let b = new Backend(root, worker);
  await ready(b);
  const n = (await call(b, 'note.create', { title: '原库' })).note;
  const backup = await call(b, 'backup.create', { directory: join(root, 'backups') });
  const oldEpoch = b.epoch;
  const notDir = join(root, 'not-directory');
  writeFileSync(notDir, 'do not touch');
  const p = await call(b, 'restore.inspect', { path: backup.file_path });
  await assert.rejects(
    call(b, 'restore.execute', { inspect_token: p.inspect_token, backup_directory: notDir }),
  );
  assert.equal(b.epoch, oldEpoch);
  assert.equal((await call(b, 'note.get', { note_id: n.note_id })).title, '原库');
  await b.close();
  b = new Backend(root, worker, 'beforeSwitch');
  await ready(b);
  const check = await call(b, 'restore.inspect', { path: backup.file_path });
  await assert.rejects(
    call(b, 'restore.execute', {
      inspect_token: check.inspect_token,
      backup_directory: join(root, 'backups'),
    }),
  );
  assert.equal(b.epoch, oldEpoch);
  assert.equal((await call(b, 'note.get', { note_id: n.note_id })).title, '原库');
  await b.close();
});
test('控制库损坏恢复保留原控制材料及原业务文件', async () => {
  const root = tmp();
  let b = new Backend(root, worker);
  await ready(b);
  const n = (await call(b, 'note.create', { title: '控制故障测试' })).note;
  const backup = await call(b, 'backup.create', { directory: join(root, 'backups') }),
    originalData = b.activePath;
  await b.close();
  const pointer = JSON.parse(readFileSync(join(root, 'control-location.json'), 'utf8')),
    controlPath = join(root, pointer.file);
  writeFileSync(controlPath, 'broken control');
  const bytes = readFileSync(controlPath),
    data = readFileSync(originalData);
  b = new Backend(root, worker);
  assert(b.fault);
  const inspect = await call(b, 'restore.inspect', { path: backup.file_path });
  await call(b, 'restore.execute', { inspect_token: inspect.inspect_token });
  await ready(b);
  assert.deepEqual(readFileSync(controlPath), bytes);
  assert.deepEqual(readFileSync(originalData), data);
  assert.equal((await call(b, 'note.get', { note_id: n.note_id })).title, '控制故障测试');
  await b.close();
});
test('禁止导出覆盖内部数据库，未知IPC字段被拒绝', async (t) => {
  const b = new Backend(tmp(), worker);
  t.after(() => b.close());
  await ready(b);
  const n = (await call(b, 'note.create', { title: 'A' })).note;
  await assert.rejects(
    call(b, 'export', { path: b.activePath, note_id: n.note_id, overwrite: true }),
    /内部/,
  );
  await assert.rejects(call(b, 'note.create', { title: 'B', unexpected: true }));
  assert.equal((await call(b, 'note.get', { note_id: n.note_id })).title, 'A');
});
test('已提交正文在强制结束真实进程后仍可读取（不是断电验证）', async () => {
  const root = tmp();
  const child = fork(resolve('tests/fixtures/crash-child.ts'), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, ZHIYE_CRASH_ROOT: root },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const saved = await new Promise<any>((res, rej) => {
    const timer = setTimeout(() => rej(Error('child timeout')), 15000);
    child.once('message', (m) => {
      clearTimeout(timer);
      res(m);
    });
    child.once('error', rej);
  });
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await exited;
  const b = new Backend(root, worker);
  try {
    await ready(b);
    const n = await call(b, 'note.get', { note_id: saved.note_id });
    assert.equal(n.content, '真实进程提交后的正文');
    assert.equal(n.revision, 1);
  } finally {
    await b.close();
  }
});

test('旧格式1可读取，格式1不得混入新版元数据', async () => {
  const s = sample();
  assert.equal((await readBackup(await crafted(JSON.stringify(s)))).manifest.format_version, 1);
  s.profile.preferences.favorites = [s.notes[0].note_id];
  await assert.rejects(readBackup(await crafted(JSON.stringify(s))));
  assert.equal(
    (
      (await readBackup(await crafted(JSON.stringify(s), { format: 2 }))).snapshot.profile
        .preferences.favorites as string[]
    )[0],
    s.notes[0].note_id,
  );
});
