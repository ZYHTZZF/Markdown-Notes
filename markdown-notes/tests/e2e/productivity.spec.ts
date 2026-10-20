import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
async function launch(root = mkdtempSync(join(tmpdir(), 'zhiye-workflow-'))) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ZHIYE_DATA_DIR: root,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: '新建笔记', exact: true }).waitFor();
  await expect(page.getByRole('button', { name: '新建笔记', exact: true })).toBeEnabled();
  return { app, page, root };
}

test('新建入口直接选模板：取消不创建、Ctrl+N、内置与自定义、草稿保护及空白新建', async () => {
  const { app, page } = await launch();
  try {
    const count = () => page.evaluate(async () => (await window.notesApi.call('note.list')).total);
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '新建笔记', exact: true });
    await expect(picker.getByRole('button', { name: '创建空白笔记' })).toBeVisible();
    await expect(
      picker.getByRole('button', { name: '使用模板：课程笔记', exact: true }),
    ).toBeVisible();
    expect(await count()).toBe(0);
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    expect(await count()).toBe(0);
    await page.keyboard.press('Control+n');
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: '使用模板：课程笔记', exact: true }).click();
    await expect(picker).toHaveCount(0);
    const editor = page.getByRole('textbox', { name: 'Markdown编辑器' });
    await expect(editor).toHaveValue(/## 核心概念/);
    await expect(editor).toBeFocused();
    const oldId = await page.evaluate(
      async () => (await window.notesApi.call('note.list')).items[0].note_id,
    );
    await editor.fill('尚未等自动保存的课程草稿');
    await page.keyboard.press('Control+n');
    await picker.getByRole('button', { name: '使用模板：会议记录', exact: true }).click();
    await expect(editor).toHaveValue(/## 讨论要点/);
    expect(
      await page.evaluate(
        async (id) => (await window.notesApi.call('note.get', { note_id: id })).content,
        oldId,
      ),
    ).toBe('尚未等自动保存的课程草稿');
    await page.evaluate(async () => {
      await window.notesApi.call('template.save', {
        title: '每周复盘',
        content: '# 每周复盘\n\n## 下周计划',
      });
    });
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await expect(
      picker.getByRole('button', { name: '使用模板：每周复盘', exact: true }),
    ).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 700));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1080);
    expect(await picker.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    await page.screenshot({
      animations: 'disabled',
      path: 'test-results/知页-新建笔记选择模板.png',
    });
    await picker.getByRole('button', { name: '使用模板：每周复盘', exact: true }).click();
    await expect(editor).toHaveValue('# 每周复盘\n\n## 下周计划');
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await picker.getByRole('button', { name: '创建空白笔记' }).click();
    await expect(editor).toHaveValue('');
    expect(await count()).toBe(4);
  } finally {
    await app.close();
  }
});
test('大纲：源码/阅读/即时跳转，重复标题与小窗口布局', async () => {
  const { app, page } = await launch();
  try {
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await page.getByRole('button', { name: '创建空白笔记', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Markdown编辑器' });
    const text =
      '# 第一章\n\n' +
      '正文\n\n'.repeat(90) +
      '## 重复标题\n\n正文\n\n## 重复标题\n\n```md\n# 不入大纲\n```\n';
    await editor.fill(text);
    await page.getByRole('button', { name: '查看目录大纲' }).click();
    const drawer = page.getByRole('complementary', { name: '目录大纲' });
    await expect(drawer.locator('.outline-list button')).toHaveCount(3);
    await drawer.locator('.outline-list button').nth(2).click();
    expect(await editor.evaluate((t: HTMLTextAreaElement) => t.selectionStart)).toBe(
      text.lastIndexOf('## 重复标题'),
    );
    await page.getByRole('button', { name: '阅读', exact: true }).click();
    await drawer.locator('.outline-list button').nth(2).click();
    await expect(page.locator('.markdown h2').last()).toBeInViewport();
    await page.getByRole('button', { name: '即时', exact: true }).click();
    await page.getByRole('textbox', { name: '即时编辑器' }).waitFor();
    await drawer.locator('.outline-list button').nth(2).click();
    await expect(page.locator('.live-h2').last()).toBeInViewport();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1080, 700);
    });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1080);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'test-results/知页-目录大纲-1080.png' });
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole('button', { name: '查看目录大纲' })).toBeFocused();
  } finally {
    await app.close();
  }
});
test('引用补全：源码与即时输入、特殊字符、Esc、键盘选择、中文组合输入', async () => {
  const { app, page } = await launch();
  try {
    await page.evaluate(async () => {
      await window.notesApi.call('note.create', { title: '代数|#\\公式😀' });
      await window.notesApi.call('note.create', { title: '代数基础' });
    });
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await page.getByRole('button', { name: '创建空白笔记', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Markdown编辑器' });
    await editor.fill('前文 [[');
    const list = page.getByRole('listbox', { name: '引用自动补全' });
    await expect(list).toBeVisible();
    await page.getByRole('option', { name: '代数|#\\公式😀', exact: true }).click();
    await expect(editor).toHaveValue('前文 [[代数|#\\公式😀]]');
    await editor.fill('[[代');
    await expect(list).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await editor.fill('[[代数基');
    await expect(list.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(editor).toHaveValue('[[代数基础]]');
    await editor.fill('`[[代数]]`');
    await editor.evaluate((t: HTMLTextAreaElement) => {
      t.setSelectionRange(6, 6);
      t.dispatchEvent(new Event('select', { bubbles: true }));
    });
    await expect(list).toHaveCount(0);
    await editor.fill('');
    await page.getByRole('button', { name: '即时', exact: true }).click();
    const live = page.getByRole('textbox', { name: '即时编辑器' });
    await live.click();
    await page.keyboard.type('[[');
    await page.keyboard.insertText('代数基');
    await expect(list.getByRole('option')).toHaveCount(1);
    await live.dispatchEvent('compositionstart', { data: '' });
    await live.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      isComposing: true,
      bubbles: true,
    });
    await expect(list).toBeVisible();
    await live.dispatchEvent('compositionend', { data: '基' });
    await page.keyboard.press('Enter');
    await expect(list).toHaveCount(0);
    await page.getByRole('button', { name: '分屏', exact: true }).click();
    await expect(editor).toHaveValue('[[代数基础]]');
    await page.screenshot({ path: 'test-results/知页-引用自动补全.png' });
  } finally {
    await app.close();
  }
});
test('模板、收藏、置顶：自定义复用、收藏搜索、回收恢复与重启持久化', async () => {
  let { app, page, root } = await launch();
  try {
    await page.getByRole('button', { name: '笔记模板', exact: true }).click();
    await page.getByRole('button', { name: /课程笔记.*内置/ }).click();
    await page.getByRole('button', { name: '用此模板新建' }).click();
    const editor = page.getByRole('textbox', { name: 'Markdown编辑器' });
    await expect(editor).toHaveValue(/核心概念/);
    await editor.fill('# 我的学习模板\n\n## 今日目标\n\n- [ ] 完成练习');
    await page.getByRole('button', { name: '保存为模板', exact: true }).click();
    await page.getByRole('textbox', { name: '模板名称' }).fill('我的学习模板');
    await page.getByRole('button', { name: '保存模板', exact: true }).click();
    await page.getByRole('button', { name: '收藏笔记', exact: true }).last().click();
    await page.getByRole('button', { name: '置顶笔记', exact: true }).click();
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await page.getByRole('button', { name: '创建空白笔记', exact: true }).click();
    await expect(page.locator('.note-card').first()).toContainText('课程笔记');
    await page.getByRole('button', { name: '收藏笔记', exact: true }).first().click();
    await expect(page.locator('.note-card')).toHaveCount(1);
    await page.locator('.note-card').click();
    await page.getByRole('button', { name: '删除当前笔记' }).click();
    await expect(page.locator('.note-card')).toHaveCount(0);
    await page.getByRole('button', { name: /^回收站/ }).click();
    await page.locator('.note-card').click();
    await page.getByRole('button', { name: '恢复笔记', exact: true }).click();
    await page
      .getByRole('dialog', { name: '恢复笔记', exact: true })
      .getByRole('button', { name: '恢复笔记', exact: true })
      .click();
    await expect(page.getByRole('button', { name: '取消收藏' })).toBeVisible();
    await expect(page.getByRole('button', { name: '取消置顶' })).toBeVisible();
    await page.getByRole('button', { name: '笔记模板', exact: true }).click();
    await page.getByRole('button', { name: /我的学习模板.*自定义/ }).click();
    const templateBody = page.getByRole('textbox', { name: '模板正文' });
    const savedTemplateBody = await templateBody.inputValue();
    await templateBody.fill('尚未保存的模板修改');
    await expect(page.getByRole('button', { name: '用此模板新建' })).toBeDisabled();
    await templateBody.fill(savedTemplateBody);
    await expect(page.getByRole('button', { name: '用此模板新建' })).toBeEnabled();
    await page.screenshot({ path: 'test-results/知页-笔记模板.png' });
    await page.getByRole('button', { name: '用此模板新建' }).click();
    await expect(editor).toHaveValue('# 我的学习模板\n\n## 今日目标\n\n- [ ] 完成练习');
    await app.close();
    ({ app, page } = await launch(root));
    await page.getByRole('button', { name: '收藏笔记', exact: true }).first().click();
    await expect(page.locator('.note-card')).toHaveCount(1);
    await page.locator('.note-card').click();
    await expect(page.getByRole('button', { name: '取消置顶' })).toBeVisible();
    await page.screenshot({ path: 'test-results/知页-收藏与置顶.png' });
  } finally {
    await app.close();
  }
});
