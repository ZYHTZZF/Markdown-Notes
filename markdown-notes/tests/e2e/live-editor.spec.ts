import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function launch(root = mkdtempSync(join(tmpdir(), 'zhiye-live-'))) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ZHIYE_DATA_DIR: root,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: '新建笔记', exact: true }).waitFor();
  return { app, page, root };
}
test('即时编辑：##空格生成二级标题、列表、粗体、撤销与源码往返', async () => {
  const { app, page } = await launch();
  try {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await page.getByRole('button', { name: '即时', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '即时编辑器', exact: true });
    await expect(editor).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Markdown编辑器' })).toHaveCount(0);
    await editor.click();
    await page.keyboard.type('##');
    await page.keyboard.press('Space');
    await expect(page.locator('.live-h2')).toHaveCount(1);
    await page.keyboard.insertText('我的二级标题');
    await expect(page.getByRole('heading', { name: '我的二级标题', level: 2 })).toBeVisible();
    await expect(editor).not.toContainText('##');
    expect(
      await page.locator('.live-h2').evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
    ).toBeGreaterThan(20);
    await page.keyboard.press('Enter');
    await page.keyboard.type('- ');
    await page.keyboard.insertText('第一条');
    await expect(page.locator('.live-marker')).toContainText('•');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('第二条');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('**bold**');
    await expect(page.locator('.live-bold')).toContainText('bold');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: '插入粗体', exact: true }).click();
    await page.keyboard.insertText('工具条');
    await page.keyboard.press('Control+s');
    await expect(page.locator('.save-status')).toContainText('已保存');
    await page.getByRole('button', { name: '分屏', exact: true }).click();
    const value = await page.getByRole('textbox', { name: 'Markdown编辑器' }).inputValue();
    expect(value).toContain('## 我的二级标题');
    expect(value).toContain('- 第一条');
    expect(value).toContain('**bold**');
    expect(value).toContain('**工具条**');
    await page.getByRole('button', { name: '即时', exact: true }).click();
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('撤销演示');
    await page.keyboard.press('Control+z');
    await expect(editor).not.toContainText('撤销演示');
    await page.keyboard.press('Control+y');
    await expect(editor).toContainText('撤销演示');
    await page.screenshot({ path: 'test-results/知页-即时编辑.png' });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('原文保留、公式表格、中文组合输入、模式记忆与关闭前保存', async () => {
  const first = await launch();
  let app = first.app,
    page = first.page;
  try {
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    const original =
      '# 原有笔记\r\n\r\n**中文粗体** 与 [[知识库]]\r\n\r\n$E=mc^2$\r\n\r\n$$\r\n\\frac{1}{2}+\\text{中文说明}\r\n$$\r\n\r\n| A | B |\r\n|---|---|\r\n| 1 | 2 |\r\n\r\n```tex\r\n$保持原样$\r\n```';
    const note = await page.evaluate(async (text) => {
      const list = await window.notesApi.call('note.list');
      const n = await window.notesApi.call('note.get', { note_id: list.items[0].note_id });
      return (
        await window.notesApi.call('note.save', {
          note_id: n.note_id,
          expected_revision: n.revision,
          content: text,
          tag_ids: [],
          edit_sequence: 1,
        })
      ).note;
    }, original);
    await page.getByRole('button', { name: '阅读', exact: true }).click();
    await page.locator('.note-card').first().click();
    await page.getByRole('button', { name: '即时', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '即时编辑器', exact: true });
    await expect(editor).toBeVisible();
    await expect(page.locator('.live-rendered-block .katex')).toHaveCount(2);
    await expect(page.locator('.live-rendered-block table')).toHaveCount(1);
    await page.getByRole('button', { name: '编辑表格', exact: true }).click();
    await expect(page.locator('.live-rendered-block table')).toHaveCount(0);
    await page.keyboard.press('Control+Home');
    await expect(page.locator('.live-rendered-block table')).toHaveCount(1);
    const current = await page.evaluate(
      (id) => window.notesApi.call('note.get', { note_id: id }),
      note.note_id,
    );
    expect(current.content).toBe(original);
    expect(current.revision).toBe(note.revision);
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await editor.dispatchEvent('compositionstart', { data: '' });
    await page.keyboard.insertText('中文输入');
    await editor.dispatchEvent('compositionend', { data: '中文输入' });
    await page.keyboard.insertText('关闭前保留');
    await app.close();
    ({ app, page } = await launch(first.root));
    await page.locator('.note-card').first().click();
    await expect(page.getByRole('textbox', { name: '即时编辑器', exact: true })).toBeVisible();
    const saved = await page.evaluate(
      (id) => window.notesApi.call('note.get', { note_id: id }),
      note.note_id,
    );
    expect(saved.content).toContain('中文输入关闭前保留');
    expect(saved.content).toContain('[[知识库]]');
    expect(saved.content).toContain('\\frac{1}{2}');
    expect(saved.content).toContain('\r\n');
    await page.getByRole('button', { name: '分屏', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Markdown编辑器' })).toHaveValue(
      /中文输入关闭前保留/,
    );
  } finally {
    await app.close();
  }
});

test('即时模式小窗口、原文粘贴、安全显示与回收站只读', async () => {
  const { app, page } = await launch();
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 700));
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await page.getByRole('button', { name: '即时', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '即时编辑器', exact: true });
    await editor.click();
    await page.keyboard.insertText(
      '# 粘贴标题\n\n<script>window.hacked=1</script>\n\n![远程](https://example.com/no.png)\n\n[[不存在的笔记]]\n\n$$\\sqrt{x}$$',
    );
    await page.keyboard.press('Control+Home');
    expect(await page.evaluate(() => (window as any).hacked)).toBeUndefined();
    expect(await page.locator('.live-editor img[src]').count()).toBe(0);
    await expect(page.locator('.live-rendered-block .katex')).toHaveCount(1);
    const layout = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth <= innerWidth,
      toolbar:
        document.querySelector('.editor-toolbar')!.scrollWidth <=
        document.querySelector('.editor-toolbar')!.clientWidth + 2,
    }));
    expect(layout).toEqual({ page: true, toolbar: true });
    await page.keyboard.press('Control+s');
    await expect(page.locator('.save-status')).toContainText('已保存');
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await page.getByRole('button', { name: '删除当前笔记', exact: true }).click();
    await page
      .getByRole('button', { name: /回收站/ })
      .first()
      .click();
    await page.locator('.note-card').first().click();
    await expect(page.getByRole('textbox', { name: '即时编辑器', exact: true })).toHaveAttribute(
      'contenteditable',
      'false',
    );
    await expect(page.getByRole('button', { name: '插入粗体' })).toBeDisabled();
  } finally {
    await app.close();
  }
});
