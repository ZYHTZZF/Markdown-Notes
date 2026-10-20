import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const directories = [];
for (const name of await readdir('node_modules')) {
  if (name.startsWith('.')) continue;
  if (name.startsWith('@'))
    for (const child of await readdir(join('node_modules', name)))
      directories.push(join('node_modules', name, child));
  else directories.push(join('node_modules', name));
}
const entries = [];
for (const dir of directories) {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const licenses = [];
    for (const name of await readdir(dir))
      if (/^(licen[cs]e|copying|notice)(\.|$)/i.test(name)) {
        try {
          licenses.push(name + '\n' + (await readFile(join(dir, name), 'utf8')));
        } catch {}
      }
    if (licenses.length)
      entries.push(
        `${pkg.name} ${pkg.version}\nDeclared license: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license)}\n${licenses.join('\n\n')}`,
      );
  } catch {}
}
await writeFile(
  'THIRD-PARTY-NOTICES.txt',
  '知页使用的第三方包许可证与声明（含构建／测试依赖）。\nElectron／Chromium的完整声明另随成品提供。\n\n' +
    entries.sort().join('\n\n' + '='.repeat(78) + '\n\n'),
  'utf8',
);
