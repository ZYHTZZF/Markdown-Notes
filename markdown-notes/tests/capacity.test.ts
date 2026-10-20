import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/backend/store';
import type { Snapshot, Note } from '../src/shared/types';

test('100,000条引用边界：新建、恢复和重命名激活超限均整笔拒绝', (t) => {
  const store = new Store(
    join(mkdtempSync(join(tmpdir(), 'zhiye-capacity-')), 'business.sqlite'),
    true,
  );
  t.after(() => store.close());
  const profile = store.profile(),
    now = new Date().toISOString();
  const make = (title: string, content = '', deleted_at: string | null = null): Note => ({
    note_id: randomUUID(),
    user_id: profile.user_id,
    title,
    content,
    revision: 0,
    created_at: now,
    updated_at: now,
    deleted_at,
  });
  const targets = Array.from({ length: 100 }, (_, i) => make('T' + i)),
    content = targets.map((n) => '[[' + n.title + ']]').join(' ') + ' [[X]]';
  const sources = Array.from({ length: 1000 }, (_, i) => make('S' + i, content)),
    unresolved = make('尚无绑定', '[[X]]'),
    trash = make('X', '', now);
  const snapshot: Snapshot = {
    schema_version: 1,
    business_version: 1,
    profile,
    notes: [...targets, ...sources, unresolved, trash],
    tags: [],
    note_tags: [],
  };
  store.import(snapshot);
  assert.equal(store.linkCount(), 100000);
  for (const [method, payload] of [
    ['note.create', { title: 'X' }],
    ['trash.restore', { note_id: trash.note_id, expected_revision: 0 }],
    ['note.rename', { note_id: targets[0].note_id, expected_revision: 0, title: 'X' }],
  ] as const) {
    const version = store.version;
    assert.throws(() => store.mutate(method, payload, randomUUID()), /容量/);
    assert.equal(store.version, version);
    assert.equal(store.linkCount(), 100000);
    assert.equal(store.note(targets[0].note_id).title, 'T0');
    assert.equal(store.note(trash.note_id, true).title, 'X');
    assert.equal(store.note(sources[0].note_id).content, content);
  }
});
