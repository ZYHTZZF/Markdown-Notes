import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const output = resolve('dist');
if (dirname(output) !== process.cwd() || !output.endsWith('dist'))
  throw new Error('构建输出目录不安全');
await rm(output, { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await viteBuild();
await build({
  entryPoints: {
    main: 'src/main.ts',
    preload: 'src/preload.ts',
    'print-preload': 'src/print-preload.ts',
    backend: 'src/backend/worker.ts',
    indexer: 'src/backend/indexer.ts',
  },
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  bundle: true,
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
});
