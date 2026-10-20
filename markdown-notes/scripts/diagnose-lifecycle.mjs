import { _electron } from '@playwright/test';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated diagnostics: capture native error boxes instead of interrupting the desktop.
const observations = [];
for (const mode of ['close', 'destroy']) {
  for (let run = 0; run < 5; run++) {
    const root = mkdtempSync(join(tmpdir(), 'zhiye-lifecycle-'));
    const errors = join(root, 'errors.json');
    const env = { ...process.env, ZHIYE_DATA_DIR: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({ args: ['.'], cwd: process.cwd(), env });
    const child = app.process();
    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    await app.evaluate(({ dialog }, errorPath) => {
      const fs = process.getBuiltinModule('node:fs');
      const errors = [];
      const record = (kind, error) => {
        errors.push({ kind, error });
        fs.writeFileSync(errorPath, JSON.stringify(errors, null, 2));
      };
      dialog.showErrorBox = (title, content) => record(title, content);
      process.on('uncaughtExceptionMonitor', (error) =>
        record('uncaughtExceptionMonitor', error.stack || String(error)),
      );
    }, errors);
    const page = await app.firstWindow();
    await page.waitForFunction(
      () => !document.querySelector('.topbar .new-button')?.hasAttribute('disabled'),
    );
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Markdown编辑器' })
      .fill('关闭并发诊断，仅使用临时合成资料');
    await page.evaluate(() => {
      for (let i = 0; i < 20; i++)
        void window.notesApi.call('note.create', { title: '并发笔记' + i }).catch(() => {});
    });
    if (mode === 'destroy') {
      await app
        .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].destroy())
        .catch(() => {});
      await new Promise((resolve) =>
        child.exitCode !== null ? resolve() : child.once('exit', resolve),
      );
    } else await app.close();
    observations.push({
      mode,
      run,
      errors: existsSync(errors) ? JSON.parse(readFileSync(errors, 'utf8')) : [],
      stderr,
    });
  }
}
mkdirSync('reports', { recursive: true });
writeFileSync(
  'reports/lifecycle-diagnostic.json',
  JSON.stringify({ date: new Date().toISOString(), observations }, null, 2),
);
console.log(
  JSON.stringify(
    observations.map(({ mode, run, errors }) => ({ mode, run, errors })),
    null,
    2,
  ),
);
if (observations.some((item) => item.errors.length)) process.exitCode = 1;
