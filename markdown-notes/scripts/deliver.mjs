import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, readFile, writeFile, stat, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';

const project = process.cwd();
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const workspace = resolve(project, '..');
const slash = (value) => value.split(sep).join('/');
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`不打包符号链接：${path}`);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function zip(output, entries) {
  const archive = new yazl.ZipFile();
  const writing = pipeline(archive.outputStream, createWriteStream(output));
  for (const entry of entries) archive.addFile(entry.file, entry.name, { compress: true });
  archive.end();
  await writing;
  return {
    file: output,
    entries: entries.length,
    bytes: (await stat(output)).size,
    sha256: await digest(output),
  };
}

const packaged = resolve('release/知页-win-x64');
const compiled = await files(resolve('dist'));
const integrity = [];
for (const file of compiled) {
  const copy = join(packaged, 'resources/app/dist', relative(resolve('dist'), file));
  const hash = await digest(file);
  if (hash !== (await digest(copy))) throw new Error(`成品与最新构建不一致：${file}`);
  integrity.push({ path: slash(relative(project, file)), sha256: hash });
}
await mkdir('reports/screenshots', { recursive: true });
await copyFile('test-results/知页-编辑与预览.png', 'reports/screenshots/知页-编辑与预览.png');
const baselinePaths = ['需求分析文档/01-需求分析文档.md', '软件设计文档/01-软件设计文档.md'];
const baselines = [];
for (const path of baselinePaths)
  baselines.push({ path, sha256: await digest(join(workspace, path)) });
const manifest = {
  date: new Date().toISOString(),
  version,
  baseline: baselines,
  compiled_files: integrity,
  packaged: JSON.parse(await readFile('reports/packaged-test.json', 'utf8')),
};
await writeFile('reports/delivery-manifest.json', JSON.stringify(manifest, null, 2));

const binaryEntries = (await files(packaged)).map((file) => ({
  file,
  name: `知页-win-x64/${slash(relative(packaged, file))}`,
}));
const sourceNames = [
  'README.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.mts',
  'playwright.config.ts',
  'index.html',
  'print.html',
  '.prettierrc.json',
  '.gitignore',
  'THIRD-PARTY-NOTICES.txt',
  '启动知页.cmd',
];
let sourceFiles = sourceNames.map((file) => resolve(file));
for (const folder of ['src', 'tests', 'scripts', 'docs', 'reports'])
  sourceFiles.push(...(await files(resolve(folder))));
const sourceEntries = sourceFiles.map((file) => ({
  file,
  name: `markdown-notes/${slash(relative(project, file))}`,
}));
for (const folder of ['需求分析文档', '软件设计文档']) {
  for (const file of await files(join(workspace, folder))) {
    if (!file.toLowerCase().endsWith('.zip'))
      sourceEntries.push({ file, name: slash(relative(workspace, file)) });
  }
}
sourceEntries.push({ file: join(workspace, '开发交付说明.md'), name: '开发交付说明.md' });
const results = [];
results.push(await zip(join(workspace, '知页-Windows成品.zip'), binaryEntries));
results.push(await zip(join(workspace, '知页-源码与测试记录.zip'), sourceEntries));
await writeFile(
  join(workspace, '交付校验SHA256.txt'),
  results.map((item) => `${item.sha256}  ${relative(workspace, item.file)}`).join('\r\n') + '\r\n',
);
console.log(JSON.stringify(results, null, 2));
