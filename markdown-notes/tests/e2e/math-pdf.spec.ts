import { test, expect, _electron as electron } from '@playwright/test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('离线公式预览与真实PDF：中文、四种定界符、矩阵、长文分页、安全隔离和取消', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zhiye-pdf-'));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ZHIYE_DATA_DIR: root,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Markdown编辑器' });
    const content =
      String.raw`# 数学公式与中文离线导出

中文学习笔记：知识整理、备份恢复，标点正常显示。

行内公式 $E=mc^2$，另一种写法 \(a_1+b_2=c^3\)。

$$
\int_0^1 x^2\,dx=\frac{1}{3},\quad \sqrt{x^2+y^2}
$$

\[
\begin{aligned}
A &= \begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix} \\
\text{中文说明} &: \sum_{i=1}^{n}i=\frac{n(n+1)}{2}
\end{aligned}
\]

金额：\$5 和 \$10。` +
      '\n\n`$这里是代码$`\n\n```tex\n$$不渲染代码块$$\n```\n\n' +
      Array.from(
        { length: 42 },
        (_, i) =>
          `## 第${i + 1}节：长期知识记录\n\n这是第${i + 1}段中文内容，用于检查跨页文字、段落、标题与公式之间的关系。行内 $x_{${i + 1}}^2$ 保持清晰。\n`,
      ).join('\n');
    await editor.fill(content);
    await expect(page.locator('.markdown .katex')).toHaveCount(46);
    await expect(page.locator('.markdown .katex-display')).toHaveCount(2);
    await expect(page.locator('.markdown .math-error')).toHaveCount(0);
    await expect(page.locator('.markdown .katex svg')).not.toHaveCount(0);
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family);
    });
    expect(fonts.some((f) => f.includes('KaTeX_Main'))).toBeTruthy();
    const file = resolve('reports/数学公式与中文导出样例.pdf');
    mkdirSync('reports', { recursive: true });
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, file);
    await page.getByRole('button', { name: '导出PDF', exact: true }).click();
    await page.getByRole('button', { name: '导出PDF文件', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('PDF已导出', { timeout: 25000 });
    expect(readFileSync(file).subarray(0, 5).toString()).toBe('%PDF-');
    const list = await page.evaluate(() => window.notesApi.call('note.list'));
    const noteId = list.items[0].note_id;
    const saved = await page.evaluate(
      (id) => window.notesApi.call('note.get', { note_id: id }),
      noteId,
    );
    expect(saved.content).toBe(content); // export flushes the latest edit before snapshotting
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await page.screenshot({ path: 'test-results/知页-数学公式与PDF.png' });
    // Cancel must not overwrite a previous export.
    const previous = readFileSync(file);
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
    });
    await page.getByRole('button', { name: '导出PDF', exact: true }).click();
    await page.getByRole('button', { name: '导出PDF文件', exact: true }).click();
    await expect(page.getByRole('button', { name: '导出PDF', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect(readFileSync(file)).toEqual(previous);
    // Internal-path writes are rejected, even when the native chooser is stubbed by a test.
    const denied = join(root, 'unsafe.pdf');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, denied);
    const rejected = await page.evaluate(async (id) => {
      try {
        await window.notesApi.call('export.pdf', { note_id: id });
        return '';
      } catch (e: any) {
        return e.message;
      }
    }, noteId);
    expect(rejected).toContain('不能用PDF覆盖内部资料');
    expect(existsSync(denied)).toBeFalsy();
    expect(await page.evaluate(() => typeof (window as any).pdfDocument)).toBe('undefined');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('错误公式与恶意命令不执行；打印失败保留旧PDF、清理隐藏窗口并允许重试', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zhiye-pdf-fail-'));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ZHIYE_DATA_DIR: root,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
  const file = join(tmpdir(), 'zhiye-pdf-failure-' + Date.now() + '.pdf');
  writeFileSync(file, 'old file');
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await page.getByRole('textbox', { name: 'Markdown编辑器' }).fill(String.raw`# 错误公式

$\frac{$

$\href{javascript:alert(1)}{x}\includegraphics{https://example.com/a.png}$

<span style="background:red" onclick="window.hacked=1">原始HTML</span>
`);
    await expect(page.locator('.markdown .math-error')).toHaveCount(1);
    await expect(
      page.locator('.markdown img,.markdown script,.markdown a[href^="javascript"]'),
    ).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).hacked)).toBeUndefined();
    await app.evaluate(({ app, dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      app.once('web-contents-created', (_event, web) => {
        web.printToPDF = async () => {
          throw new Error('injected print failure');
        };
      });
    }, file);
    await page.getByRole('button', { name: '导出PDF', exact: true }).click();
    await page.getByRole('button', { name: '导出PDF文件', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('PDF导出失败', { timeout: 25000 });
    expect(readFileSync(file, 'utf8')).toBe('old file');
    expect(
      readdirSync(tmpdir()).some(
        (name) => name.startsWith(file.split(/[\\/]/).pop()! + '.') && name.endsWith('.partial'),
      ),
    ).toBeFalsy();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '导出PDF', exact: true }).click();
    await page.getByRole('button', { name: '导出PDF文件', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('PDF已导出', { timeout: 25000 });
    expect(readFileSync(file).subarray(0, 5).toString()).toBe('%PDF-');
  } finally {
    await app.close();
  }
});
