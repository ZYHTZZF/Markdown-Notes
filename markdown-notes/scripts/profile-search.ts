import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.ZHIYE_BENCH_ROOT!;
const pointer = JSON.parse(readFileSync(join(root, 'control-location.json'), 'utf8'));
const control = new DatabaseSync(join(root, pointer.file), { readOnly: true });
const active = JSON.parse(
  (control.prepare("SELECT value FROM kv WHERE key='active'").get() as any).value,
);
control.close();
const db = new DatabaseSync(active.index, { readOnly: true });
db.exec('PRAGMA mmap_size=1073741824;PRAGMA cache_size=-65536');
console.log(active.index);
for (const sql of [
  'SELECT COUNT(*) n FROM docs',
  'SELECT COUNT(*) n FROM body_fts WHERE body_fts MATCH \'"per"\'',
  "SELECT COUNT(*) n FROM docs WHERE instr(normalized,'personal')>0",
  "SELECT COUNT(*) n FROM docs WHERE note_id IN(SELECT note_id FROM body_fts WHERE body_fts MATCH '\"per\"') AND instr(normalized,'personal')>0",
  "SELECT note_id,title,content,tags,updated_at,CASE WHEN instr(title_key,'personal')>0 THEN 0 WHEN instr(normalized,'personal')>0 THEN 1 ELSE 2 END rank FROM docs WHERE note_id IN(SELECT note_id FROM body_fts WHERE body_fts MATCH '\"per\"') AND instr(normalized,'personal')>0 ORDER BY rank,updated_at DESC,note_id LIMIT 50",
]) {
  const t = performance.now();
  const rows = db.prepare(sql).all();
  console.log(
    sql.slice(0, 130),
    Math.round(performance.now() - t) + 'ms',
    rows.length,
    rows.length === 1 ? rows[0] : '',
  );
}
db.close();
void (async () => {
  const { Worker } = await import('node:worker_threads');
  const w = new Worker(join(process.cwd(), 'dist/indexer.cjs'), {
    workerData: {
      kind: 'index',
      source: active.path,
      directory: join(root, 'generations', active.epoch),
      epoch: active.epoch,
      existing: active.index,
    },
  });
  await new Promise<void>((res, rej) => {
    w.on('error', rej);
    w.on('message', (m) => {
      if (m.event === 'index' && m.state === 'ready') res();
    });
  });
  for (const q of ['personal', '知', '目标00', '不存在的正文']) {
    const t = performance.now();
    const data = await new Promise<any>((res, rej) => {
      const on = (m: any) => {
        if (m.id === q) {
          w.off('message', on);
          res(m);
        }
      };
      w.on('message', on);
      w.postMessage({ kind: 'query', id: q, payload: { keyword: q, scope: 'content' } });
    });
    console.log(
      'worker query',
      q,
      Math.round(performance.now() - t) + 'ms',
      data.ok,
      data.data?.total,
      data.message,
    );
  }
  await w.terminate();
})();
