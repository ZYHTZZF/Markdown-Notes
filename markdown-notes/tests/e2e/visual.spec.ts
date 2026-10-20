import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function launch() {
  const root = mkdtempSync(join(tmpdir(), 'zhiye-glass-ui-'));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ZHIYE_DATA_DIR: root,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
  const page = await app.firstWindow();
  await expect(page.getByRole('button', { name: '新建笔记', exact: true })).toBeEnabled();
  return { app, page, root };
}

async function checkLayout(page: Page) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.modal,.reference-panel')].every(
      (e) => getComputedStyle(e).opacity === '1',
    ),
  );
  const problems = await page.evaluate(() => {
    const errors: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth) errors.push('页面横向溢出');
    for (const selector of ['.topbar', '.editor-toolbar', '.note-list', '.document', '.modal']) {
      const element = document.querySelector<HTMLElement>(selector);
      if (element && element.scrollWidth > element.clientWidth + 2)
        errors.push(selector + '横向溢出');
    }
    for (const selector of ['.source-pane textarea', '.markdown']) {
      const r = document.querySelector(selector)?.getBoundingClientRect();
      if (r && (r.width < 240 || r.height < 140)) errors.push(selector + '正文空间不足');
    }
    const search = document.querySelector('.global-search')!.getBoundingClientRect();
    const button = document.querySelector('.topbar .new-button')!.getBoundingClientRect();
    if (search.right > button.left || button.right > innerWidth - 138)
      errors.push('顶栏与窗口按钮重叠');
    return errors;
  });
  expect(problems).toEqual([]);
}

async function checkContrast(page: Page) {
  return page.evaluate(() => {
    const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
    const over = (fg: number[], bg: number[]) => {
      const a = fg[3] ?? 1;
      return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
    };
    const luminance = (c: number[]) =>
      c
        .map((v) => {
          const x = v / 255;
          return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        })
        .reduce((n, x, i) => n + x * [0.2126, 0.7152, 0.0722][i], 0);
    const failures: { text: string; ratio: number; font: number }[] = [];
    let checked = 0,
      minimum = 100;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode,
        e = node.parentElement!;
      if (!node.textContent?.trim() || e.closest('svg,script,style,button:disabled')) continue;
      if (document.querySelector('.modal') && !e.closest('.modal')) continue;
      const s = getComputedStyle(e),
        r = e.getBoundingClientRect();
      if (
        !r.width ||
        !r.height ||
        r.bottom < 0 ||
        r.top > innerHeight ||
        s.visibility !== 'visible'
      )
        continue;
      let bg = [245, 245, 247];
      const parents: Element[] = [];
      for (let p: Element | null = e; p; p = p.parentElement) parents.unshift(p);
      for (const p of parents) bg = over(rgb(getComputedStyle(p).backgroundColor), bg);
      const fg = over(rgb(s.color), bg),
        l1 = luminance(fg),
        l2 = luminance(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const font = parseFloat(s.fontSize);
      checked++;
      minimum = Math.min(minimum, ratio);
      if (ratio < 4.5 || font < 12)
        failures.push({ text: node.textContent.trim().slice(0, 35), ratio, font });
    }
    return { checked, minimum, failures };
  });
}

for (const [width, height] of [
  [1480, 940],
  [1080, 700],
]) {
  test(`清透界面${width}×${height}：长内容、引用抽屉、搜索、设置与恢复布局`, async () => {
    const { app, page, root } = await launch();
    try {
      await app.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0].setSize(size.width, size.height);
        },
        { width, height },
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      await checkLayout(page);
      await page.screenshot({
        animations: 'disabled',
        path: `test-results/清透-${width}-空状态.png`,
      });
      await page.getByRole('button', { name: '新建笔记', exact: true }).click();
      await page.getByRole('button', { name: '创建空白笔记', exact: true }).click();
      const editor = page.getByRole('textbox', { name: 'Markdown编辑器' });
      const content =
        '# 清晰记录，轻盈连接\n\n白色的纸面，让内容成为主角。\n\n## 今日的思考\n\n- [x] 整理课程笔记\n- 留下值得回顾的想法\n\n[[关联笔记]]\n\n> 少一点干扰，多一点专注。\n\n' +
        '这里是长正文，用于验证滚动与编辑空间。\n\n'.repeat(50);
      await editor.fill(content);
      await expect(page.locator('.save-status')).toContainText('已保存');
      await page.getByRole('button', { name: '重命名笔记', exact: true }).click();
      const title = '课程学习与知识整理 · ' + '长标题展示'.repeat(12);
      await page.locator('.modal input.field').fill(title);
      await page.getByRole('button', { name: '检查影响', exact: true }).click();
      await page.getByRole('button', { name: '确认重命名', exact: true }).click();
      await page.evaluate(async () => {
        await window.notesApi.call('note.create', { title: '关联笔记' });
        for (let i = 0; i < 12; i++)
          await window.notesApi.call('tag.create', { name: '学习主题' + i });
      });
      await page.getByRole('button', { name: '添加标签', exact: true }).click();
      for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.check();
      await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await expect(page.locator('.save-status')).toContainText('已保存');
      await expect(page.locator('.document-tags .chip')).toHaveCount(12);
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.notesApi.call('system.status')).index.state),
        )
        .toBe('ready');
      await checkLayout(page);
      const contrast = await checkContrast(page);
      expect(contrast.failures).toEqual([]);
      const before = await editor.boundingBox();
      const toggle = page.getByRole('button', { name: '查看引用关系', exact: true });
      await expect(page.locator('.reference-panel')).toHaveCount(0);
      await toggle.click();
      await expect(page.locator('.reference-content')).toContainText('关联笔记');
      await expect(page.getByRole('button', { name: '关闭引用面板' })).toBeFocused();
      expect((await editor.boundingBox())!.width).toBe(before!.width);
      expect((await page.locator('.reference-panel').boundingBox())!.width).toBeCloseTo(320, 1);
      await page.keyboard.press('Escape');
      await expect(toggle).toBeFocused();
      await expect(page.locator('.reference-panel')).toHaveCount(0);
      await editor.focus();
      await checkLayout(page);
      await page.screenshot({
        animations: 'disabled',
        path: `test-results/清透-${width}-长内容.png`,
      });
      await toggle.click();
      await expect(page.locator('.reference-content')).toContainText('关联笔记');
      await page.locator('.reference-link').filter({ hasText: '关联笔记' }).click();
      await expect(page.locator('.document-heading h1')).toHaveText('关联笔记');
      await expect(page.locator('.reference-heading p')).toHaveText('关联笔记');
      await page.getByRole('button', { name: /^引用来源/ }).click();
      await expect(page.locator('.reference-content')).toContainText(title);
      await page.locator('.reference-link').click();
      await expect(editor).toHaveValue(content);
      const drawerContrast = await checkContrast(page);
      expect(drawerContrast.failures).toEqual([]);
      await page.screenshot({
        animations: 'disabled',
        path: `test-results/清透-${width}-引用.png`,
      });
      await page.getByRole('button', { name: '关闭引用面板' }).click();
      await page.keyboard.press('Control+k');
      await expect(page.getByRole('textbox', { name: '搜索笔记' })).toBeFocused();
      await page.getByRole('textbox', { name: '搜索笔记' }).fill('长正文');
      await expect(page.locator('.note-card')).toHaveCount(1);
      await checkLayout(page);
      await page.screenshot({
        animations: 'disabled',
        path: `test-results/清透-${width}-搜索.png`,
      });
      await page.getByRole('button', { name: '清空搜索' }).click();
      await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
      await checkLayout(page);
      const modalContrast = await checkContrast(page);
      expect(modalContrast.failures).toEqual([]);
      await page.screenshot({
        animations: 'disabled',
        path: `test-results/清透-${width}-备份.png`,
      });
      const backups = join(root, 'backups');
      mkdirSync(backups);
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, backups);
      await page.getByRole('button', { name: '创建完整备份', exact: true }).click();
      await expect(page.locator('.backup-history')).toContainText('手动完整备份');
      const history = await page.evaluate(() => window.notesApi.call('backup.list'));
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, history[0].file_path);
      await page.getByRole('button', { name: '从备份恢复', exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText('备份检查完成');
      await checkLayout(page);
      const restoreContrast = await checkContrast(page);
      expect(restoreContrast.failures).toEqual([]);
      await page.screenshot({
        animations: 'disabled',
        path: `test-results/清透-${width}-恢复.png`,
      });
      writeFileSync(
        `test-results/visual-${width}.json`,
        JSON.stringify(
          {
            width,
            height,
            contrast,
            drawerContrast,
            modalContrast,
            restoreContrast,
            checks: [
              '布局',
              '抽屉不挤压正文',
              'Escape与焦点返回',
              '双向跳转',
              '搜索输入',
              '长标题与12标签',
              '备份恢复预检',
            ],
          },
          null,
          2,
        ),
      );
    } finally {
      await app.close();
    }
  });
}

test('窗口控制、减少动态效果、模式偏好及关闭前保存兼容', async () => {
  const { app, page, root } = await launch();
  let second: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let firstClosed = false;
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await page.getByRole('button', { name: '创建空白笔记', exact: true }).click();
    await page.getByRole('textbox', { name: 'Markdown编辑器' }).fill('立即关闭前的输入必须保存');
    await page.getByRole('button', { name: '阅读', exact: true }).click();
    await expect(page.locator('.markdown')).toContainText('立即关闭前的输入必须保存');
    await page.getByRole('button', { name: '查看引用关系' }).click();
    expect(
      await page.locator('.reference-panel').evaluate((e) => getComputedStyle(e).animationName),
    ).toBe('none');
    await page.getByRole('button', { name: '关闭引用面板' }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()),
      )
      .toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize());
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()),
      )
      .toBe(false);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
      )
      .toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
      )
      .toBe(false);
    await page.getByRole('button', { name: '写作', exact: true }).click();
    await page.getByRole('textbox', { name: 'Markdown编辑器' }).fill('尚未等待防抖就关闭窗口');
    await app.close();
    firstClosed = true;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ZHIYE_DATA_DIR: root,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    second = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
    const reopened = await second.firstWindow();
    await reopened.locator('.note-card').first().click();
    await expect(reopened.getByRole('textbox', { name: 'Markdown编辑器' })).toHaveValue(
      '尚未等待防抖就关闭窗口',
    );
    await expect(reopened.getByRole('button', { name: '写作', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(reopened.locator('.preview-pane')).toHaveCount(0);
    await expect(reopened.locator('.reference-panel')).toHaveCount(0);
  } finally {
    await second?.close();
    if (!firstClosed) await app.close();
  }
});
