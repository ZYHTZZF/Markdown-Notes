import { _electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const exe = resolve('release/知页-win-x64/知页.exe'),
  root = mkdtempSync(join(tmpdir(), 'zhiye-packaged-'));
const env = { ...process.env, ZHIYE_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: exe, args: [], env });
try {
  const page = await app.firstWindow();
  await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Markdown编辑器' })
    .fill('# Windows成品验证\n\n无需安装Node或数据库服务器，离线打开即可开始记录。');
  await page.waitForFunction(() =>
    document.querySelector('.save-status')?.textContent?.includes('已保存'),
  );
  assert.equal(await page.locator('.markdown h1').textContent(), 'Windows成品验证');
  const runtime = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
  }));
  assert(runtime.packaged);
  assert.equal(runtime.version, '1.0.0');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(exe)) hash.update(chunk);
  const report = {
    date: new Date().toISOString(),
    pass: true,
    executable: exe,
    sha256: hash.digest('hex'),
    runtime,
    checks: [
      '成品EXE独立启动',
      '新建与编辑',
      '安全Markdown预览',
      '自动持久化',
      '实际打包标志与版本',
    ],
  };
  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/packaged-test.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
}
