import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  name,
  key,
  body,
  counts,
  bytes,
  LIMITS,
  fail,
  renameRefs,
  validateSnapshot,
} from '../shared/rules';
import type { Note, NoteView, Profile, Snapshot, Tag } from '../shared/types';

export class Store {
  db: DatabaseSync;
  constructor(
    public path: string,
    create = false,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    const existed = existsSync(path);
    if (create && existed) {
      const check = new DatabaseSync(path, { readOnly: true });
      try {
        const row = check.prepare('PRAGMA quick_check').get() as any;
        if (!row || Object.values(row)[0] !== 'ok') fail('E_STORAGE', '主资料库完整性检查失败');
        const m = check.prepare('SELECT * FROM meta WHERE id=1').get() as any;
        if (!m || m.schema_version !== 1) fail('E_VERSION', '不支持的资料库格式');
      } finally {
        check.close();
      }
    }
    this.db = new DatabaseSync(path, { readOnly: !create });
    if (create) {
      this.db.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;',
      );
      if (!existed) this.schema();
      this.db.exec('CREATE INDEX IF NOT EXISTS notes_capacity ON notes(content_bytes,deleted_at)');
    }
    const ok = this.db.prepare('PRAGMA quick_check').get() as any;
    if (!ok || Object.values(ok)[0] !== 'ok') fail('E_STORAGE', '主资料库完整性检查失败');
    const meta = this.db.prepare('SELECT * FROM meta WHERE id=1').get() as any;
    if (!meta || meta.schema_version !== 1) fail('E_VERSION', '不支持的资料库版本');
  }
  schema() {
    this.db.exec(`
    CREATE TABLE IF NOT EXISTS profile(user_id TEXT PRIMARY KEY,display_name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,preferences TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,business_version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS notes(note_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES profile(user_id),title TEXT NOT NULL,title_key TEXT NOT NULL,content TEXT NOT NULL,content_bytes INTEGER NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS active_titles ON notes(title_key) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS note_order ON notes(deleted_at,updated_at DESC,note_id);
    CREATE TABLE IF NOT EXISTS tags(tag_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES profile(user_id),name TEXT NOT NULL,name_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS note_tags(note_id TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,tag_id TEXT NOT NULL REFERENCES tags(tag_id) ON DELETE CASCADE,created_at TEXT NOT NULL,PRIMARY KEY(note_id,tag_id));
    CREATE INDEX IF NOT EXISTS tag_notes ON note_tags(tag_id,note_id);
    CREATE TABLE IF NOT EXISTS note_refs(source_id TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,target_key TEXT NOT NULL,name TEXT NOT NULL,occurrences INTEGER NOT NULL,PRIMARY KEY(source_id,target_key));
    CREATE INDEX IF NOT EXISTS ref_keys ON note_refs(target_key,source_id);
    CREATE TABLE IF NOT EXISTS changes(version INTEGER PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS receipts(request_id TEXT PRIMARY KEY,hash TEXT NOT NULL,result TEXT NOT NULL);
  `);
    if (!this.db.prepare('SELECT id FROM meta').get()) {
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO meta VALUES(1,1,0)').run();
      this.db
        .prepare('INSERT INTO profile VALUES(?,?,?,?,?)')
        .run(randomUUID(), '本地用户', now, now, JSON.stringify({ font_size: 16, mode: 'split' }));
    }
  }
  get version() {
    return Number(
      (this.db.prepare('SELECT business_version FROM meta WHERE id=1').get() as any)
        .business_version,
    );
  }
  profile(): Profile {
    const p = this.db.prepare('SELECT * FROM profile').get() as any;
    return { ...p, preferences: JSON.parse(p.preferences) };
  }
  tags(): Tag[] {
    return this.db
      .prepare('SELECT tag_id,user_id,name,created_at,updated_at FROM tags ORDER BY name')
      .all() as unknown as Tag[];
  }
  note(id: string, trash = false): NoteView {
    const n = this.db
      .prepare(
        'SELECT note_id,user_id,title,content,revision,created_at,updated_at,deleted_at FROM notes WHERE note_id=?',
      )
      .get(id) as unknown as Note;
    if (!n || Boolean(n.deleted_at) !== trash) fail('E_NOT_FOUND', '笔记不存在或已进入回收站');
    const tags = this.db
      .prepare(
        'SELECT t.tag_id,t.user_id,t.name,t.created_at,t.updated_at FROM tags t JOIN note_tags a ON a.tag_id=t.tag_id WHERE a.note_id=? ORDER BY t.name',
      )
      .all(id) as unknown as Tag[];
    return { ...n, tags };
  }
  list(trash = false, tagIds: string[] = [], page = 1) {
    const filters = tagIds
      .map(() => 'EXISTS(SELECT 1 FROM note_tags a WHERE a.note_id=n.note_id AND a.tag_id=?)')
      .join(' AND ');
    const where = `n.deleted_at IS ${trash ? 'NOT ' : ''}NULL${filters ? ' AND ' + filters : ''}`;
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) n FROM notes n WHERE ${where}`).get(...tagIds) as any).n,
    );
    const items = this.db
      .prepare(
        `SELECT note_id,title,substr(content,1,160) snippet,revision,created_at,updated_at,deleted_at FROM notes n WHERE ${where} ORDER BY updated_at DESC,note_id LIMIT 50 OFFSET ?`,
      )
      .all(...tagIds, (page - 1) * 50)
      .map((n: any) => ({
        ...n,
        tags: this.db
          .prepare(
            'SELECT t.tag_id,t.name FROM tags t JOIN note_tags a ON a.tag_id=t.tag_id WHERE a.note_id=? ORDER BY t.name',
          )
          .all(n.note_id),
      }));
    return { items, total, page, business_version: this.version };
  }
  stats() {
    return {
      ...this.db
        .prepare(
          'SELECT COUNT(*) notes,COALESCE(SUM(content_bytes),0) bytes,SUM(deleted_at IS NULL) active,SUM(deleted_at IS NOT NULL) trash FROM notes',
        )
        .get(),
      tags: this.tags().length,
      links: this.linkCount(),
      business_version: this.version,
    };
  }
  linkCount() {
    return Number(
      (
        this.db
          .prepare(
            'SELECT COUNT(*) n FROM note_refs r JOIN notes t ON t.title_key=r.target_key AND t.deleted_at IS NULL',
          )
          .get() as any
      ).n,
    );
  }
  updateRefs(id: string, content: string, active: boolean) {
    this.db.prepare('DELETE FROM note_refs WHERE source_id=?').run(id);
    if (active) {
      const insert = this.db.prepare('INSERT INTO note_refs VALUES(?,?,?,?)');
      for (const [k, r] of counts(content)) insert.run(id, k, r.name, r.count);
    }
  }
  capacity() {
    const s = this.stats() as any;
    if (
      s.notes > LIMITS.notes ||
      s.bytes > LIMITS.total ||
      s.tags > LIMITS.tags ||
      s.links > LIMITS.links
    )
      fail('E_CAPACITY', '本次联动会超出资料库容量，整次操作未提交');
    if (this.db.prepare('SELECT note_id FROM note_tags GROUP BY note_id HAVING COUNT(*)>20').get())
      fail('E_CAPACITY', '每篇最多20个标签');
  }
  checked(id: string, revision: number, trash = false) {
    const n = this.note(id, trash);
    if (n.revision !== revision)
      fail('E_STALE_REVISION', '笔记已有更新，请重新读取后重试；当前输入仍保留');
    return n;
  }
  mutate(method: string, p: any, requestId: string, inject?: string) {
    const hash = createHash('sha256').update(JSON.stringify({ method, p })).digest('hex');
    const old = this.db
      .prepare('SELECT hash,result FROM receipts WHERE request_id=?')
      .get(requestId) as any;
    if (old) {
      if (old.hash !== hash) fail('E_INPUT', '同一请求标识不能用于不同内容');
      return JSON.parse(old.result);
    }
    const before = this.stats() as any,
      over = (s: any) =>
        s.notes > LIMITS.notes ||
        s.bytes > LIMITS.total ||
        s.tags > LIMITS.tags ||
        s.links > LIMITS.links;
    if (over(before) && !['trash.move', 'trash.purge', 'tag.delete'].includes(method))
      fail('E_CAPACITY', '现有资料已超限，目前仅允许查看、导出和不增加超限指标的删除清理');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = new Date().toISOString(),
        changed = new Set<string>(),
        keys = new Set<string>();
      let result: any = {};
      const touch = (id: string) => {
        this.db
          .prepare('UPDATE notes SET revision=revision+1,updated_at=? WHERE note_id=?')
          .run(now, id);
        changed.add(id);
      };
      if (method === 'note.create') {
        let title = p.title ? name(p.title) : '未命名笔记',
          i = 1;
        while (
          this.db
            .prepare('SELECT 1 FROM notes WHERE title_key=? AND deleted_at IS NULL')
            .get(key(title))
        ) {
          if (p.title) fail('E_NAME_CONFLICT', '已有同名笔记');
          title = `未命名笔记 ${i++}`;
        }
        const id = randomUUID();
        this.db
          .prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,NULL)')
          .run(id, this.profile().user_id, title, key(title), '', 0, 0, now, now);
        keys.add(key(title));
        changed.add(id);
        result = { note_id: id };
      } else if (method === 'note.save' || method === 'note.setTags') {
        const n = this.checked(p.note_id, p.expected_revision),
          content = method === 'note.save' ? body(p.content) : n.content;
        const tags = [...new Set<string>(p.tag_ids)];
        if (tags.length > 20) fail('E_CAPACITY', '每篇最多20个标签');
        for (const id of tags)
          if (!this.db.prepare('SELECT 1 FROM tags WHERE tag_id=?').get(id))
            fail('E_TAG_GONE', '标签已删除，请重新选择');
        this.db
          .prepare('UPDATE notes SET content=?,content_bytes=? WHERE note_id=?')
          .run(content, bytes(content), n.note_id);
        this.updateRefs(n.note_id, content, true);
        this.db.prepare('DELETE FROM note_tags WHERE note_id=?').run(n.note_id);
        for (const id of tags)
          this.db.prepare('INSERT INTO note_tags VALUES(?,?,?)').run(n.note_id, id, now);
        touch(n.note_id);
        result = { note_id: n.note_id, edit_sequence: p.edit_sequence };
      } else if (method === 'note.rename') {
        const n = this.checked(p.note_id, p.expected_revision),
          title = name(p.title),
          oldKey = key(n.title),
          newKey = key(title);
        if (
          this.db
            .prepare('SELECT 1 FROM notes WHERE title_key=? AND deleted_at IS NULL AND note_id<>?')
            .get(newKey, n.note_id)
        )
          fail('E_NAME_CONFLICT', '已有同名有效笔记');
        const sources = this.db
          .prepare(
            'SELECT n.note_id,n.content FROM notes n JOIN note_refs r ON r.source_id=n.note_id WHERE r.target_key=?',
          )
          .all(oldKey) as any[];
        this.db
          .prepare('UPDATE notes SET title=?,title_key=? WHERE note_id=?')
          .run(title, newKey, n.note_id);
        for (const s of sources) {
          const text = renameRefs(s.content, oldKey, title);
          body(text);
          this.db
            .prepare('UPDATE notes SET content=?,content_bytes=? WHERE note_id=?')
            .run(text, bytes(text), s.note_id);
          this.updateRefs(s.note_id, text, true);
          changed.add(s.note_id);
        }
        changed.add(n.note_id);
        for (const id of changed) touch(id);
        keys.add(oldKey);
        keys.add(newKey);
        result = { note_id: n.note_id, affected: changed.size };
      } else if (
        method === 'trash.move' ||
        method === 'trash.restore' ||
        method === 'trash.purge'
      ) {
        const n = this.checked(p.note_id, p.expected_revision, method !== 'trash.move');
        keys.add(key(n.title));
        if (method === 'trash.purge') {
          this.db.prepare('DELETE FROM notes WHERE note_id=?').run(n.note_id);
          changed.add(n.note_id);
        } else if (method === 'trash.move') {
          this.db.prepare('UPDATE notes SET deleted_at=? WHERE note_id=?').run(now, n.note_id);
          this.updateRefs(n.note_id, n.content, false);
          touch(n.note_id);
        } else {
          const title = p.title ? name(p.title) : n.title;
          if (
            this.db
              .prepare('SELECT 1 FROM notes WHERE title_key=? AND deleted_at IS NULL')
              .get(key(title))
          )
            fail('E_NAME_CONFLICT', '恢复标题与现有笔记冲突，请使用其他标题');
          this.db
            .prepare('UPDATE notes SET title=?,title_key=?,deleted_at=NULL WHERE note_id=?')
            .run(title, key(title), n.note_id);
          this.updateRefs(n.note_id, n.content, true);
          keys.add(key(title));
          touch(n.note_id);
        }
        result = { note_id: n.note_id };
      } else if (method === 'tag.create') {
        const value = name(p.name, 'tag');
        if (this.db.prepare('SELECT 1 FROM tags WHERE name_key=?').get(key(value)))
          fail('E_NAME_CONFLICT', '已有同名标签');
        const id = randomUUID();
        this.db
          .prepare('INSERT INTO tags VALUES(?,?,?,?,?,?)')
          .run(id, this.profile().user_id, value, key(value), now, now);
        result = { tag_id: id };
      } else if (method === 'tag.rename' || method === 'tag.delete') {
        if (!this.db.prepare('SELECT 1 FROM tags WHERE tag_id=?').get(p.tag_id))
          fail('E_NOT_FOUND', '标签不存在');
        const ids = this.db
          .prepare('SELECT note_id FROM note_tags WHERE tag_id=?')
          .all(p.tag_id) as any[];
        if (method === 'tag.delete') {
          this.db.prepare('DELETE FROM tags WHERE tag_id=?').run(p.tag_id);
          for (const { note_id } of ids) touch(note_id);
        } else {
          const value = name(p.name, 'tag');
          if (
            this.db
              .prepare('SELECT 1 FROM tags WHERE name_key=? AND tag_id<>?')
              .get(key(value), p.tag_id)
          )
            fail('E_NAME_CONFLICT', '已有同名标签');
          this.db
            .prepare('UPDATE tags SET name=?,name_key=?,updated_at=? WHERE tag_id=?')
            .run(value, key(value), now, p.tag_id);
          for (const { note_id } of ids) changed.add(note_id);
        }
        result = { affected: ids.length };
      } else if (method === 'preferences') {
        const pref = { ...this.profile().preferences, ...p.preferences };
        this.db
          .prepare('UPDATE profile SET preferences=?,updated_at=?')
          .run(JSON.stringify(pref), now);
      } else fail('E_NOT_SUPPORTED', '不支持的操作');
      if (inject === 'beforeCommit') fail('E_TEST_FAILURE', '测试：提交前注入失败');
      if (over(before)) {
        const after = this.stats() as any;
        for (const metric of ['notes', 'bytes', 'tags', 'links'])
          if (after[metric] > before[metric]) fail('E_CAPACITY', '清理操作不能增加容量指标');
      } else this.capacity();
      const version = this.version + 1;
      this.db.prepare('UPDATE meta SET business_version=? WHERE id=1').run(version);
      this.db
        .prepare('INSERT INTO changes VALUES(?,?)')
        .run(version, JSON.stringify({ notes: [...changed], keys: [...keys] }));
      if (result.note_id && method !== 'trash.purge')
        result.note = this.note(result.note_id, method === 'trash.move');
      result.business_version = version;
      this.db
        .prepare('INSERT INTO receipts VALUES(?,?,?)')
        .run(requestId, hash, JSON.stringify(result));
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  snapshot(): Snapshot {
    this.db.exec('BEGIN');
    try {
      const s = {
        schema_version: 1 as const,
        business_version: this.version,
        profile: this.profile(),
        notes: this.db
          .prepare(
            'SELECT note_id,user_id,title,content,revision,created_at,updated_at,deleted_at FROM notes ORDER BY note_id',
          )
          .all() as unknown as Note[],
        tags: this.tags(),
        note_tags: this.db
          .prepare('SELECT * FROM note_tags ORDER BY note_id,tag_id')
          .all() as any[],
      };
      this.db.exec('COMMIT');
      return s;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  import(s: Snapshot) {
    validateSnapshot(s);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(
        'DELETE FROM note_refs;DELETE FROM note_tags;DELETE FROM notes;DELETE FROM tags;DELETE FROM profile;DELETE FROM changes;DELETE FROM receipts;',
      );
      const p = s.profile;
      this.db
        .prepare('INSERT INTO profile VALUES(?,?,?,?,?)')
        .run(p.user_id, p.display_name, p.created_at, p.updated_at, JSON.stringify(p.preferences));
      for (const n of s.notes) {
        this.db
          .prepare('INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(
            n.note_id,
            n.user_id,
            n.title,
            key(name(n.title)),
            n.content,
            bytes(n.content),
            n.revision,
            n.created_at,
            n.updated_at,
            n.deleted_at,
          );
        this.updateRefs(n.note_id, n.content, !n.deleted_at);
      }
      for (const t of s.tags)
        this.db
          .prepare('INSERT INTO tags VALUES(?,?,?,?,?,?)')
          .run(t.tag_id, t.user_id, t.name, key(name(t.name, 'tag')), t.created_at, t.updated_at);
      for (const a of s.note_tags)
        this.db
          .prepare('INSERT INTO note_tags VALUES(?,?,?)')
          .run(a.note_id, a.tag_id, a.created_at);
      this.db.prepare('UPDATE meta SET business_version=? WHERE id=1').run(s.business_version);
      this.capacity();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
