import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { counts, key, keyword, fail, matchRange } from '../shared/rules';

export function indexSchema(db: DatabaseSync) {
  db.exec(`
  PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-65536; PRAGMA mmap_size=536870912;
  CREATE TABLE meta(id INTEGER PRIMARY KEY,version INTEGER NOT NULL,epoch TEXT NOT NULL);
  PRAGMA user_version=3;
  CREATE TABLE docs(note_id TEXT PRIMARY KEY,title TEXT,title_key TEXT,content TEXT,normalized TEXT,updated_at TEXT,tags TEXT,tag_ids TEXT);
  CREATE VIRTUAL TABLE body_fts USING fts5(note_id UNINDEXED,body,tokenize='trigram case_sensitive 1',detail=full);
  CREATE TABLE links(source_id TEXT,target_id TEXT,target_key TEXT,name TEXT,occurrences INTEGER,PRIMARY KEY(source_id,target_key));
  CREATE INDEX targets ON links(target_id,source_id);
  CREATE TABLE tag_catalog(tag_id TEXT PRIMARY KEY,name TEXT,search_key TEXT);
  CREATE TABLE doc_tags(note_id TEXT,tag_id TEXT,PRIMARY KEY(note_id,tag_id));
  CREATE INDEX indexed_tag_notes ON doc_tags(tag_id,note_id);
`);
}
function project(
  source: DatabaseSync,
  index: DatabaseSync,
  id: string,
  titles: Map<string, string>,
) {
  const old = index.prepare('SELECT rowid,content FROM docs WHERE note_id=?').get(id) as any;
  const n = source
    .prepare('SELECT * FROM notes WHERE note_id=? AND deleted_at IS NULL')
    .get(id) as any;
  index.prepare('DELETE FROM doc_tags WHERE note_id=?').run(id);
  index.prepare('DELETE FROM links WHERE source_id=?').run(id);
  if (!n) {
    if (old) {
      index.prepare('DELETE FROM body_fts WHERE rowid=?').run(old.rowid);
      index.prepare('DELETE FROM docs WHERE note_id=?').run(id);
    }
    return;
  }
  const tags = (
    source
      .prepare(
        'SELECT t.tag_id,t.name FROM tags t JOIN note_tags a ON a.tag_id=t.tag_id WHERE a.note_id=? ORDER BY t.name',
      )
      .all(id) as any[]
  ).map((t) => ({ ...t, search_key: key(t.name) }));
  const catalog = index.prepare(
      'INSERT INTO tag_catalog VALUES(?,?,?) ON CONFLICT(tag_id) DO UPDATE SET name=excluded.name,search_key=excluded.search_key WHERE tag_catalog.name<>excluded.name OR tag_catalog.search_key<>excluded.search_key',
    ),
    associate = index.prepare('INSERT INTO doc_tags VALUES(?,?)');
  for (const t of tags) {
    catalog.run(t.tag_id, t.name, t.search_key);
    associate.run(id, t.tag_id);
  }
  if (old && old.content === n.content)
    index
      .prepare('UPDATE docs SET title=?,title_key=?,updated_at=?,tags=?,tag_ids=? WHERE note_id=?')
      .run(
        n.title,
        n.title_key,
        n.updated_at,
        JSON.stringify(tags),
        JSON.stringify(tags.map((t) => t.tag_id)),
        id,
      );
  else {
    if (old) {
      index.prepare('DELETE FROM body_fts WHERE rowid=?').run(old.rowid);
      index.prepare('DELETE FROM docs WHERE note_id=?').run(id);
    }
    const inserted = index
      .prepare('INSERT INTO docs VALUES(?,?,?,?,?,?,?,?)')
      .run(
        id,
        n.title,
        n.title_key,
        n.content,
        key(n.content),
        n.updated_at,
        JSON.stringify(tags),
        JSON.stringify(tags.map((t) => t.tag_id)),
      );
    index
      .prepare('INSERT INTO body_fts(rowid,note_id,body) VALUES(?,?,?)')
      .run(inserted.lastInsertRowid, id, key(n.content));
  }
  for (const [k, r] of counts(n.content))
    index
      .prepare('INSERT INTO links VALUES(?,?,?,?,?)')
      .run(id, titles.get(k) ?? null, k, r.name, r.count);
}
const getTitles = (db: DatabaseSync) =>
  new Map(
    (db.prepare('SELECT note_id,title_key FROM notes WHERE deleted_at IS NULL').all() as any[]).map(
      (n) => [n.title_key, n.note_id],
    ),
  );
const version = (db: DatabaseSync) =>
  Number(
    (db.prepare('SELECT business_version FROM meta WHERE id=1').get() as any).business_version,
  );
export function buildStandalone(sourcePath: string, indexPath: string, epoch: string) {
  const source = new DatabaseSync(sourcePath, { readOnly: true }),
    index = new DatabaseSync(indexPath);
  try {
    indexSchema(index);
    source.exec('BEGIN');
    const v = version(source),
      titles = getTitles(source);
    index.exec('BEGIN');
    for (const n of source
      .prepare('SELECT note_id FROM notes WHERE deleted_at IS NULL')
      .all() as any[])
      project(source, index, n.note_id, titles);
    index.prepare('INSERT INTO meta VALUES(1,?,?)').run(v, epoch);
    index.exec('COMMIT');
    source.exec('COMMIT');
    index.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    source.close();
    index.close();
  }
}

if (parentPort && workerData?.kind === 'index') {
  const port = parentPort,
    source = new DatabaseSync(workerData.source, { readOnly: true });
  let index: DatabaseSync | null = null,
    indexPath = '',
    running = false,
    dirty = false,
    force = false,
    closing = false;
  let indexed = -1,
    state = 'updating',
    phase = '准备索引',
    barrierId = '';
  const queries = new Map<string, any>(),
    barriers = new Map<string, (value: any) => void>();
  const pageCache = new Map<string, any>();
  const emit = (extra: any = {}) =>
    port.postMessage({ event: 'index', state, phase, indexed_version: indexed, ...extra });
  const status = (s: string, p: string, extra: any = {}) => {
    state = s;
    phase = p;
    emit(extra);
  };
  const yieldTurn = () => new Promise<void>((r) => setImmediate(r));
  const requestBarrier = () =>
    new Promise<any>((res, rej) => {
      barrierId = randomUUID();
      const id = barrierId;
      const timer = setTimeout(() => {
        barriers.delete(id);
        rej(new Error('发布屏障等待超时'));
      }, 950);
      barriers.set(id, (value) => {
        clearTimeout(timer);
        if (value.denied) rej(new Error('恢复期间禁止发布'));
        else res(value);
      });
      port.postMessage({ event: 'barrier', id });
    });
  const release = () => {
    if (barrierId) {
      port.postMessage({ event: 'release', id: barrierId });
      barrierId = '';
    }
  };
  function delta(from: number) {
    const v = version(source),
      events = source
        .prepare('SELECT payload FROM changes WHERE version>? AND version<=? ORDER BY version')
        .all(from, v) as any[];
    const ids = new Set<string>(),
      keys = new Set<string>();
    for (const e of events) {
      const c = JSON.parse(e.payload);
      for (const id of c.notes) ids.add(id);
      for (const k of c.keys) keys.add(k);
    }
    for (const k of keys)
      for (const r of source
        .prepare('SELECT source_id FROM note_refs WHERE target_key=?')
        .all(k) as any[])
        ids.add(r.source_id);
    let total = 0;
    for (const id of ids)
      total += Number(
        (source.prepare('SELECT content_bytes FROM notes WHERE note_id=?').get(id) as any)
          ?.content_bytes ?? 0,
      );
    return { v, ids, commits: v - from, bytes: total };
  }
  function apply(db: DatabaseSync, from: number) {
    source.exec('BEGIN');
    try {
      const d = delta(from),
        titles = getTitles(source);
      db.exec('BEGIN');
      try {
        for (const id of d.ids) project(source, db, id, titles);
        db.prepare('INSERT OR REPLACE INTO meta VALUES(1,?,?)').run(d.v, workerData.epoch);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      source.exec('COMMIT');
      return d;
    } catch (e) {
      source.exec('ROLLBACK');
      throw e;
    }
  }
  async function rebuild() {
    status('rebuilding', '读取一致快照');
    const started = performance.now(),
      file = join(workerData.directory, `index-${randomUUID()}.sqlite`),
      candidate = new DatabaseSync(file);
    let published = false,
      readOpen = false;
    try {
      indexSchema(candidate);
      source.exec('BEGIN');
      readOpen = true;
      let v = version(source);
      const titles = getTitles(source),
        ids = source.prepare('SELECT note_id FROM notes WHERE deleted_at IS NULL').all() as any[];
      candidate.exec('BEGIN');
      for (let i = 0; i < ids.length; i++) {
        project(source, candidate, ids[i].note_id, titles);
        if (i % 40 === 0) {
          emit({ progress: Math.round((i / Math.max(ids.length, 1)) * 75) });
          await yieldTurn();
          if (closing) throw new Error('重建已取消');
          if (performance.now() - started > 60_000) throw new Error('静态重建超过60秒');
        }
      }
      candidate.prepare('INSERT INTO meta VALUES(1,?,?)').run(v, workerData.epoch);
      candidate.exec('COMMIT');
      source.exec('COMMIT');
      readOpen = false;
      let attempts = 0,
        totalBarrier = 0;
      while (true) {
        phase = '追平已提交修改';
        const changed = apply(candidate, v);
        v = changed.v;
        await yieldTurn();
        if (closing) throw new Error('重建已取消');
        if (performance.now() - started > 120_000) throw new Error('动态重建超过120秒');
        const d = delta(v);
        emit({ lag_commits: d.commits, closure_notes: d.ids.size, closure_bytes: d.bytes });
        if (d.commits > 10 || d.ids.size > 100 || d.bytes > 2 * 1048576) continue;
        if (attempts >= 2 || totalBarrier >= 10_000) throw new Error('重建发布屏障预算耗尽');
        const barrierStart = performance.now();
        attempts++;
        await requestBarrier();
        try {
          const final = delta(v);
          if (final.commits > 10 || final.ids.size > 100 || final.bytes > 2 * 1048576) continue;
          const applyStart = performance.now();
          const done = apply(candidate, v);
          v = done.v;
          if (performance.now() - applyStart > 3000 || performance.now() - barrierStart > 4500)
            throw new Error('最终追平超过发布屏障预算');
          const previous = index,
            previousPath = indexPath;
          index = candidate;
          indexPath = file;
          indexed = v;
          queries.clear();
          pageCache.clear();
          published = true;
          previous?.close();
          port.postMessage({ event: 'published', file, version: v });
          status('ready', '索引可用', {
            barrier_attempts: attempts,
            barrier_ms: performance.now() - barrierStart,
            barrier_total_ms: totalBarrier + performance.now() - barrierStart,
          });
          if (previousPath && previousPath !== file)
            for (const suffix of ['', '-wal', '-shm'])
              try {
                unlinkSync(previousPath + suffix);
              } catch {}
          break;
        } finally {
          totalBarrier += performance.now() - barrierStart;
          release();
        }
      }
    } finally {
      release();
      if (readOpen) {
        try {
          source.exec('ROLLBACK');
        } catch {}
      }
      if (!published) {
        try {
          candidate.close();
        } catch {}
        if (existsSync(file))
          try {
            unlinkSync(file);
          } catch {}
      }
    }
  }
  async function sync() {
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    try {
      do {
        dirty = false;
        const current = version(source),
          available = Number(
            (
              source
                .prepare('SELECT COUNT(*) n FROM changes WHERE version>? AND version<=?')
                .get(indexed, current) as any
            ).n,
          );
        if (!index || force || indexed > current || available !== current - indexed) {
          force = false;
          await rebuild();
        } else {
          status('updating', '更新索引');
          const d = apply(index, indexed);
          indexed = d.v;
          pageCache.clear();
          status('ready', '索引可用');
        }
      } while (dirty && !closing);
    } catch (e: any) {
      const timeout = /超过|超时|预算/.test(e.message ?? '');
      status('failed', timeout ? '索引重建超出时间预算，请重新构建' : '索引构建失败，请重新构建', {
        budget_code: timeout ? 'E_REBUILD_BUDGET' : 'E_INDEX_UNAVAILABLE',
      });
    } finally {
      running = false;
    }
  }
  function query(p: any) {
    const v = version(source);
    if (state !== 'ready' || !index || v !== indexed)
      fail('E_INDEX_UNAVAILABLE', '索引更新中，请稍候');
    let options: any,
      token = p.query_token;
    if (token) {
      options = queries.get(token);
      if (!options || options.version !== v) fail('E_QUERY_STALE', '资料已变更，请从第一页刷新');
    } else {
      options = {
        keyword: keyword(p.keyword ?? ''),
        scope: p.scope ?? 'all',
        favorite_ids: p.favorite_ids,
        tag_ids: p.tag_ids ?? [],
        version: v,
      };
      token = randomUUID();
      queries.set(token, options);
      if (queries.size > 20) queries.delete(queries.keys().next().value!);
    }
    const q = options.keyword as string,
      scope = options.scope,
      tagIds = options.tag_ids as string[];
    const page = Math.max(1, Number(p.page) || 1),
      cacheKey = JSON.stringify({ v, q, scope, tagIds, page, favorites: options.favorite_ids });
    const cached = pageCache.get(cacheKey);
    if (cached) return { ...cached, query_token: token };
    const params: Record<string, any> = {},
      where: string[] = [];
    if (options.favorite_ids) {
      params.$favorites = JSON.stringify(options.favorite_ids);
      where.push('d.note_id IN(SELECT value FROM json_each($favorites))');
    }
    const title = 'instr(d.title_key,$q)>0',
      tag =
        'd.note_id IN(SELECT dt.note_id FROM doc_tags dt WHERE dt.tag_id IN(SELECT tag_id FROM tag_catalog WHERE instr(search_key,$q)>0))';
    let body = 'instr(d.normalized,$q)>0';
    if (q && [...q].length >= 3 && !/[\p{Cc}]/u.test(q) && ['all', 'content'].includes(scope)) {
      // A single trigram avoids costly repeated-position phrase merges. Exact verification retains literal semantics.
      const gram = [...q].slice(0, 3).join('');
      params.$ft = '"' + gram.replace(/"/g, '""') + '"';
      body = `(d.note_id IN(SELECT note_id FROM body_fts WHERE body_fts MATCH $ft) AND ${body})`;
    }
    if (q) {
      params.$q = q;
      where.push(
        scope === 'all'
          ? `(${title} OR ${body} OR ${tag})`
          : scope === 'title'
            ? title
            : scope === 'content'
              ? body
              : tag,
      );
    }
    tagIds.forEach((id, i) => {
      params['$t' + i] = id;
      where.push(
        `EXISTS(SELECT 1 FROM doc_tags ti WHERE ti.note_id=d.note_id AND ti.tag_id=$t${i})`,
      );
    });
    const condition = where.length ? where.join(' AND ') : '1';
    const total = Number(
      (index!.prepare(`SELECT COUNT(*) n FROM docs d WHERE ${condition}`).get(params) as any).n,
    );
    const rank = q
      ? `CASE WHEN ${title} THEN 0 WHEN instr(d.normalized,$q)>0 THEN 1 ELSE 2 END`
      : '0';
    const rows = index!
      .prepare(
        `SELECT note_id,title,content,tags,updated_at,${rank} rank FROM docs d WHERE ${condition} ORDER BY rank,updated_at DESC,note_id LIMIT 50 OFFSET ${(page - 1) * 50}`,
      )
      .all(params) as any[];
    const items = rows.map(({ content, rank, ...n }) => {
      const tags = JSON.parse(n.tags).map(({ search_key, ...t }: any) => t),
        fields: string[] = [];
      if (q) {
        if (key(n.title).includes(q)) fields.push('title');
        if (key(content).includes(q)) fields.push('content');
        if (tags.some((t: any) => key(t.name).includes(q))) fields.push('tag');
      }
      const match = q ? matchRange(content, q) : null;
      let start = match ? Math.max(0, match[0] - 30) : 0;
      if (start > 0 && /[\uDC00-\uDFFF]/.test(content[start])) start--;
      const snippet = [...content.slice(start)].slice(0, 120).join('');
      return {
        ...n,
        tags,
        snippet,
        matched_fields: fields,
        highlight_ranges: { title: matchRange(n.title, q), snippet: matchRange(snippet, q) },
      };
    });
    const result = { items, total, page, business_version: v };
    pageCache.set(cacheKey, result);
    if (pageCache.size > 8) pageCache.delete(pageCache.keys().next().value!);
    return { ...result, query_token: token };
  }
  port.on('message', async (msg) => {
    if (msg.kind === 'barrierAck') {
      barriers.get(msg.id)?.(msg);
      barriers.delete(msg.id);
      return;
    }
    if (msg.kind === 'sync') {
      dirty = true;
      void sync();
      return;
    }
    if (msg.kind === 'rebuild') {
      force = true;
      void sync();
      return;
    }
    if (msg.kind === 'query' || msg.kind === 'links') {
      try {
        let data;
        if (msg.kind === 'query') data = query(msg.payload);
        else {
          if (state !== 'ready' || !index || version(source) !== indexed)
            fail('E_INDEX_UNAVAILABLE', '引用索引更新中');
          const id = msg.payload.note_id;
          data = {
            outgoing: index
              .prepare(
                'SELECT l.*,s.title source_title FROM links l JOIN docs s ON s.note_id=l.source_id WHERE l.source_id=?',
              )
              .all(id),
            incoming: index
              .prepare(
                'SELECT l.*,s.title source_title FROM links l JOIN docs s ON s.note_id=l.source_id WHERE l.target_id=?',
              )
              .all(id),
          };
        }
        port.postMessage({ id: msg.id, ok: true, data });
      } catch (e: any) {
        port.postMessage({
          id: msg.id,
          ok: false,
          code: e.code ?? 'E_INDEX_UNAVAILABLE',
          message: e.message,
        });
      }
      return;
    }
  });
  mkdirSync(workerData.directory, { recursive: true });
  try {
    if (workerData.existing && existsSync(workerData.existing)) {
      const existing = new DatabaseSync(workerData.existing);
      existing.exec('PRAGMA cache_size=-65536;PRAGMA mmap_size=536870912');
      const m = existing.prepare('SELECT * FROM meta').get() as any;
      const format = (existing.prepare('PRAGMA user_version').get() as any).user_version;
      if (m.epoch === workerData.epoch && format === 3) {
        index = existing;
        indexPath = workerData.existing;
        indexed = m.version;
      } else existing.close();
    }
  } catch {}
  void sync();
}
