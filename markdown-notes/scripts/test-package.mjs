import { _electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, createReadStream, readFileSync } from 'node:fs';
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
    .fill(
      '# Windows成品验证\n\n中文学习笔记：离线公式与导出。\n\n行内 $E=mc^2$\n\n$$\\frac{1}{2}+\\sqrt{x}+\\text{中文说明}$$',
    );
  await page.waitForFunction(() =>
    document.querySelector('.save-status')?.textContent?.includes('已保存'),
  );
  assert.equal(await page.locator('.markdown h1').textContent(), 'Windows成品验证');
  assert.equal(await page.locator('.markdown .katex').count(), 2);
  await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('button', { name: '选择主色#7352c7', exact: true }).click();
  await page.getByLabel('背景颜色', { exact: true }).fill('#e7e3ef');
  await page.getByRole('button', { name: '应用外观', exact: true }).click();
  await page.waitForFunction(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--accent-fill').trim() ===
      '#7352c7',
  );
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.evaluate(() => document.fonts.ready.then(() => true));
  const pdf = resolve('reports/成品中文与公式验证.pdf');
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, pdf);
  await page.getByRole('button', { name: '导出PDF', exact: true }).click();
  await page.getByRole('checkbox', { name: '带背景导出', exact: true }).check();
  await page.getByRole('button', { name: '导出PDF文件', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('[role="status"]')?.textContent?.includes('PDF已导出'),
  );
  assert.equal(readFileSync(pdf).subarray(0, 5).toString(), '%PDF-');
  const runtime = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
  }));
  assert(runtime.packaged);
  assert.equal(runtime.version, JSON.parse(readFileSync('package.json', 'utf8')).version);
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
      '成品离线数学公式预览与真实PDF导出',
      '成品主色与纯色背景设置、带背景导出选项',
      '实际打包标志与版本',
    ],
  };
  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/packaged-test.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
}
