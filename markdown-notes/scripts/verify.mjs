import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('reports', { recursive: true });
function run(name, args) {
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  writeFileSync(`reports/${name}.log`, (result.stdout ?? '') + '\n' + (result.stderr ?? ''));
  console.log(result.stdout ?? '');
  if (result.status !== 0) {
    console.error(result.stderr ?? '');
    process.exit(result.status ?? 1);
  }
}
run('typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']);
run('unit-tests', [
  'node_modules/tsx/dist/cli.mjs',
  '--test',
  '--test-reporter=tap',
  'tests/*.test.ts',
]);
run('desktop-tests', ['node_modules/@playwright/test/cli.js', 'test']);
copyFileSync('test-results/e2e-results.json', 'reports/desktop-tests.json');
console.log('验证记录已保存至 reports/');
