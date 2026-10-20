import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, totalmem, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/backend/store';
import { Backend } from '../src/backend/service';
import type { Snapshot } from '../src/shared/types';
import { bytes } from '../src/shared/rules';

async function main() {
  const report: any = {
    date: new Date().toISOString(),
    environment: {
      os: platform() + ' ' + release(),
      cpu: cpus()[0].model,
      logical_cpus: cpus().length,
      memory_gib: Math.round(totalmem() / 1073741824),
      node: process.version,
    },
    scale: { notes: 10000, body_bytes: 300 * 1048576, tags: 2000, links: 100000 },
    measurements: {},
    limitations: [
      '仅代表当前设备与本合成数据集；不能替代规定基准设备测量、真实用户测试或突然断电测试。',
    ],
  };
  const out = resolve('reports/benchmark.json');
  mkdirSync(resolve('reports'), { recursive: true });
  const persist = () => writeFileSync(out, JSON.stringify(report, null, 2));
  const root = process.env.ZHIYE_BENCH_ROOT || mkdtempSync(join(tmpdir(), 'zhiye-bench-'));
  report.test_root = root;
  persist();
  if (process.env.ZHIYE_BENCH_ROOT) {
    const { DatabaseSync } = await import('node:sqlite');
    const { readFileSync } = await import('node:fs');
    const location = JSON.parse(readFileSync(join(root, 'control-location.json'), 'utf8'));
    const c = new DatabaseSync(join(root, location.file));
    c.prepare('INSERT OR REPLACE INTO kv VALUES(?,?)').run(
      'runtime',
      JSON.stringify({ outageWall: null, total: 0 }),
    );
    c.close();
    report.fixture_reused = true;
    report.observation_reset = '仅重置合成测试库的本轮观测窗口，历史失败报告另存';
    persist();
  }
  let b = new Backend(root, resolve('dist/indexer.cjs'));
  const call = (method: string, payload: any = {}) =>
    b.call({ api_version: 1, request_id: randomUUID(), epoch: b.epoch, method, payload });
  async function ready(limit = 180000) {
    const start = performance.now();
    while (performance.now() - start < limit) {
      if (b.index.state === 'ready' && b.index.indexed_version === b.store!.version) return;
      if (b.index.state === 'failed') throw new Error(b.index.phase);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('索引超时');
  }
  const summary = (samples: number[], limit: number) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      samples_ms: samples,
      p95_ms: sorted[Math.ceil(samples.length * 0.95) - 1],
      max_ms: sorted.at(-1),
      target_ms: limit,
      pass: sorted[Math.ceil(samples.length * 0.95) - 1] <= limit,
    };
  };
  try {
    if (!process.env.ZHIYE_BENCH_ROOT) {
      await ready();
      await b.close();
      const active = JSON.parse(
        (await import('node:fs')).readFileSync(join(root, 'control-location.json'), 'utf8'),
      );
      const { DatabaseSync } = await import('node:sqlite');
      const control = new DatabaseSync(join(root, active.file));
      const entry = JSON.parse(
        (control.prepare("SELECT value FROM kv WHERE key='active'").get() as any).value,
      );
      control.close();
      const store = new Store(entry.path, true),
        p = store.profile(),
        now = new Date().toISOString(),
        ids = Array.from({ length: 10000 }, () => randomUUID()),
        tagIds = Array.from({ length: 2000 }, () => randomUUID());
      const refs = Array.from(
        { length: 10 },
        (_, i) => `[[目标${String(i).padStart(2, '0')}]]`,
      ).join(' ');
      let snapshot: Snapshot | null = {
        schema_version: 1,
        business_version: 1,
        profile: p,
        notes: [],
        tags: tagIds.map((tag_id, i) => ({
          tag_id,
          user_id: p.user_id,
          name: '标签 ' + String(i).padStart(4, '0'),
          created_at: now,
          updated_at: now,
        })),
        note_tags: [],
      };
      for (let i = 0; i < 10000; i++) {
        const target = 31457 + (i < 2800 ? 1 : 0),
          prefix = `# 笔记 ${i}\n\n${refs}\n\n`;
        snapshot.notes.push({
          note_id: ids[i],
          user_id: p.user_id,
          title:
            i < 10 ? '目标' + String(i).padStart(2, '0') : '笔记 ' + String(i).padStart(5, '0'),
          content: prefix + 'personal knowledge '.repeat(2000).slice(0, target - bytes(prefix)),
          revision: 0,
          created_at: now,
          updated_at: now,
          deleted_at: null,
        });
        for (let j = 0; j < 20; j++)
          snapshot.note_tags.push({
            note_id: ids[i],
            tag_id: tagIds[(i * 20 + j) % 2000],
            created_at: now,
          });
      }
      console.log('准备10,000篇／300 MiB／100,000引用的测试库');
      const importStart = performance.now();
      store.import(snapshot);
      report.measurements.fixture_import_ms = performance.now() - importStart;
      report.scale_actual = store.stats();
      store.close();
      snapshot = null;
      persist();
    } else {
      report.scale_actual = b.store!.stats();
      await b.close();
    }
    const cold = performance.now();
    b = new Backend(root, resolve('dist/indexer.cjs'));
    await ready();
    report.measurements.initial_index_ms = performance.now() - cold;
    console.log('首次索引完成', report.measurements.initial_index_ms.toFixed(0) + 'ms');
    persist();
    const ids = (
        b.store!.db.prepare('SELECT note_id FROM notes ORDER BY title_key').all() as any[]
      ).map((n) => n.note_id),
      tagIds = b.store!.tags().map((t) => t.tag_id);
    for (const [scope, queries, target] of [
      ['title', ['目标', '笔记 002', '不存在的标题'], 1000],
      ['tag', ['标签 0000', '标签 1999', '不存在的标签'], 1000],
      ['content', ['personal', '知', '目标00', '不存在的正文'], 2000],
      ['all', ['笔记', 'personal knowledge', '标签 0000', '不存在'], 2000],
    ] as const) {
      const samples: number[] = [];
      for (let i = 0; i < 100; i++) {
        const t = performance.now();
        await call('search.query', { keyword: queries[i % queries.length], scope });
        samples.push(performance.now() - t);
      }
      report.measurements['search_' + scope] = summary(samples, target);
      console.log(scope, 'P95', report.measurements['search_' + scope].p95_ms.toFixed(1));
      persist();
    }
    const saves: number[] = [],
      indexes: number[] = [];
    for (let i = 0; i < 100; i++) {
      const n = await call('note.get', { note_id: ids[30] }),
        t = performance.now();
      await call('note.save', {
        note_id: n.note_id,
        expected_revision: n.revision,
        content: n.content.replace(/^[#@]/, i % 2 ? '#' : '@'),
        tag_ids: tagIds.slice(0, 20),
        edit_sequence: i,
      });
      const committed = performance.now();
      saves.push(committed - t);
      await ready();
      indexes.push(performance.now() - committed);
    }
    report.measurements.save = { ...summary(saves, 2000), pass: Math.max(...saves) <= 2000 };
    report.measurements.incremental_index = {
      ...summary(indexes, 2000),
      pass: Math.max(...indexes) <= 2000,
    };
    persist();
    const staticBuilds: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      await call('index.rebuild');
      await ready();
      staticBuilds.push(performance.now() - t);
      console.log('静态重建', i + 1, staticBuilds.at(-1)?.toFixed(0));
    }
    report.measurements.static_rebuild = {
      ...summary(staticBuilds, 60000),
      pass: Math.max(...staticBuilds) <= 60000,
    };
    persist();
    const backupT = performance.now(),
      backup = await call('backup.create', { directory: join(root, 'backups') });
    report.measurements.full_backup_ms = performance.now() - backupT;
    report.backup_bytes = backup.file_size;
    persist();
    const inspect = await call('restore.inspect', { path: backup.file_path }),
      restoreT = performance.now();
    await call('restore.execute', {
      inspect_token: inspect.inspect_token,
      backup_directory: join(root, 'backups'),
    });
    await ready();
    report.measurements.full_restore = {
      ms: performance.now() - restoreT,
      target_ms: 180000,
      pass: performance.now() - restoreT <= 180000,
    };
    persist();
    report.completed = true;
    console.log('基准完成：', out);
  } catch (e: any) {
    report.error = e.message;
    console.log('基准失败：', e.message);
    process.exitCode = 1;
  } finally {
    persist();
    await b.close();
  }
}
void main();
