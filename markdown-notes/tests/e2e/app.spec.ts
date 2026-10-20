import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('桌面端：离线编辑、自动保存、标签、引用、导出与完整恢复', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zhiye-ui-')),
    backupDir = join(root, 'backups');
  mkdirSync(backupDir);
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
    await expect(page.getByText('给想法一个安静的地方')).toBeVisible();
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await page.getByRole('button', { name: '创建空白笔记', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Markdown编辑器' });
    await expect(editor).toBeVisible();
    await editor.fill(
      '# 软件工程学习笔记\n\n把学习整理成自己的知识。\n\n## 今天的收获\n\n- 需求与设计保持一致\n- [x] 完成第一篇笔记\n\n[[知识管理]]\n\n> 记录的价值，在于下一次找到它。',
    );
    await expect(page.locator('.save-status')).toContainText('已保存', { timeout: 10000 });
    await expect(page.locator('.markdown h1')).toHaveText('软件工程学习笔记');
    await page.getByRole('button', { name: '重命名笔记', exact: true }).click();
    await page.locator('.modal input.field').fill('软件工程 · 需求与设计');
    await page.getByRole('button', { name: '检查影响', exact: true }).click();
    await page.getByRole('button', { name: '确认重命名', exact: true }).click();
    await expect(page.locator('.document-heading h1')).toHaveText('软件工程 · 需求与设计');
    await page.getByRole('button', { name: '添加标签', exact: true }).click();
    await page.getByRole('button', { name: '新建标签', exact: true }).click();
    await page.locator('.modal input.field').fill('课程笔记');
    await page.getByRole('button', { name: '保存标签', exact: true }).click();
    await expect(page.locator('.document-tags')).toContainText('课程笔记');
    await expect(page.locator('.save-status')).toContainText('已保存');
    await page.evaluate(async () => {
      await window.notesApi.call('note.create', { title: '知识管理' });
    });
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.notesApi.call('system.status')).index.state),
      )
      .toBe('ready');
    await page.getByRole('button', { name: '查看引用关系', exact: true }).click();
    await expect(page.locator('.reference-content')).toContainText('知识管理');
    await page.getByRole('button', { name: '关闭引用面板', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索笔记' }).fill('需求与设计');
    await expect(page.locator('.notes-scroll .note-card')).toHaveCount(1);
    await page.getByRole('textbox', { name: '搜索笔记' }).fill('');
    await app.evaluate(
      async ({ dialog }, options) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [options.backupDir] });
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: options.single });
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      },
      { backupDir, single: join(tmpdir(), '知页-UI导出-' + Date.now() + '.md') },
    );
    await page.getByRole('button', { name: '导出当前笔记', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已导出');
    await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
    await page.getByRole('button', { name: '创建完整备份', exact: true }).click();
    await expect(page.locator('.backup-history')).toContainText('手动完整备份');
    const backups = await page.evaluate(() => window.notesApi.call('backup.list'));
    expect(backups.length).toBe(1);
    await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await editor.fill('备份之后修改的内容');
    await expect(page.locator('.save-status')).toContainText('已保存');
    await app.evaluate(
      async ({ dialog }, options) => {
        (dialog as any).showOpenDialog = async (_win: any, choice: any) => ({
          canceled: false,
          filePaths: [choice.properties.includes('openFile') ? options.file : options.directory],
        });
      },
      { file: backups[0].file_path, directory: backupDir },
    );
    await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
    await page.getByRole('button', { name: '从备份恢复', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('备份检查完成');
    await page.getByRole('button', { name: '执行整体恢复', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已恢复', { timeout: 20000 });
    await page.locator('.note-card').filter({ hasText: '软件工程 · 需求与设计' }).click();
    await expect(editor).toHaveValue(/软件工程学习笔记/);
    await page.screenshot({
      animations: 'disabled',
      path: 'test-results/知页-编辑与预览.png',
      fullPage: true,
    });
    expect(errors).toEqual([]);
    await expect(
      page.evaluate(() => ({
        require: typeof (window as any).require,
        process: typeof (window as any).process,
      })),
    ).resolves.toEqual({ require: 'undefined', process: 'undefined' });
  } finally {
    await app.close();
  }
});

test('关闭重启后正文保留，恶意HTML和远程图片不执行', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zhiye-persist-ui-'));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ZHIYE_DATA_DIR: root,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
  let page = await app.firstWindow();
  try {
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await page.getByRole('button', { name: '创建空白笔记', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Markdown编辑器' })
      .fill(
        '# 持久化测试\n\n<script>window.hacked=true</script>\n\n![](https://example.com/private.png)',
      );
    await expect(page.locator('.save-status')).toContainText('已保存');
    expect(await page.evaluate(() => (window as any).hacked)).toBeUndefined();
    expect(await page.locator('.markdown img').count()).toBe(0);
    await app.close();
    app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
    page = await app.firstWindow();
    await page.locator('.note-card').first().click();
    await expect(page.getByRole('textbox', { name: 'Markdown编辑器' })).toHaveValue(/持久化测试/);
  } finally {
    await app.close();
  }
});

test('持续输入定期持久化，并对规范等价的原文高亮', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zhiye-continuous-ui-'));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ZHIYE_DATA_DIR: root,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await page.getByRole('button', { name: '创建空白笔记', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Markdown编辑器' });
    for (let i = 0; i < 22; i++) {
      await editor.fill('持续记录 Cafe\u0301 · ' + i);
      await page.waitForTimeout(600);
    }
    const list = await page.evaluate(() => window.notesApi.call('note.list'));
    const saved = await page.evaluate(
      (id) => window.notesApi.call('note.get', { note_id: id }),
      list.items[0].note_id,
    );
    expect(saved.revision).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.save-status')).toContainText('已保存');
    await page.getByRole('textbox', { name: '搜索笔记' }).fill('café');
    await expect(page.locator('.note-card mark')).toHaveText('Cafe\u0301');
  } finally {
    await app.close();
  }
});
