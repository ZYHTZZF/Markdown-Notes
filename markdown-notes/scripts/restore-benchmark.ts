import { Backend } from '../src/backend/service';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
async function main() {
  const report = JSON.parse(readFileSync('reports/benchmark.json', 'utf8'));
  const root = report.test_root,
    b = new Backend(root, resolve('dist/indexer.cjs'));
  const call = (method: string, payload: any = {}) =>
    b.call({ api_version: 1, request_id: randomUUID(), epoch: b.epoch, method, payload });
  try {
    while (b.index.state !== 'ready') await new Promise((r) => setTimeout(r, 20));
    const backups = await call('backup.list'),
      chosen = backups.find((x: any) => x.backup_type === 'manual' && x.exists);
    if (!chosen) throw Error('Missing full-scale backup');
    const inspected = await call('restore.inspect', { path: chosen.file_path });
    const t = performance.now();
    const result = await call('restore.execute', {
      inspect_token: inspected.inspect_token,
      backup_directory: join(root, 'backups'),
    });
    while (b.index.state !== 'ready') await new Promise((r) => setTimeout(r, 20));
    const ms = performance.now() - t;
    report.measurements.full_restore_after_memory_optimization = {
      ms,
      target_ms: 180000,
      pass: ms <= 180000,
    };
    report.final_restored_stats = b.store!.stats();
    report.restore_retest_date = new Date().toISOString();
    writeFileSync('reports/benchmark.json', JSON.stringify(report, null, 2));
    console.log('满容量恢复复测', Math.round(ms) + 'ms', result.state);
  } finally {
    await b.close();
  }
}
void main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
