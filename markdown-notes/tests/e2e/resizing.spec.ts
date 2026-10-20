import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function drag(page: Page, divider: Locator, delta: number) {
  const box = (await divider.boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + Math.min(100, box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  // One native move still exercises pointer capture and the final drag position. Avoid eight
  // protocol round trips that allow the physical desktop pointer to interrupt a hidden window.
  await page.mouse.move(Math.max(1, x + delta), y);
  await page.mouse.up();
  await expect(page.locator('.app-shell')).not.toHaveClass(/resizing/);
}
const value = async (divider: Locator) => Number(await divider.getAttribute('aria-valuenow'));
async function assertUsable(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const doc = document.querySelector('.document')!.getBoundingClientRect();
        const toolbar = document.querySelector('.editor-toolbar')!;
        return {
          editor: doc.width >= 559,
          page: document.documentElement.scrollWidth <= innerWidth,
          toolbar: toolbar.scrollWidth <= toolbar.clientWidth + 2,
        };
      }),
    )
    .toEqual({ editor: true, page: true, toolbar: true });
}
for (const width of [1480, 1080]) {
  test(`${width}宽窗口：三栏拖动、收起展开、边界、取消、键盘及记忆`, async () => {
    test.setTimeout(90_000);
    const root = mkdtempSync(join(tmpdir(), 'zhiye-resize-ui-'));
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ZHIYE_DATA_DIR: root,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const launch = () =>
      electron.launch({
        args: ['.', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
        cwd: process.cwd(),
        env,
      });
    let app = await launch();
    try {
      let page = await app.firstWindow();
      const resize = async (w: number) => {
        await app.evaluate(({ BrowserWindow }, w) => {
          const window = BrowserWindow.getAllWindows()[0];
          window.setSize(w, 800);
          window.webContents.setBackgroundThrottling(false);
          window.hide();
        }, w);
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(w);
        // Hidden native windows can defer resize notifications until they are shown.
        // Dispatch the notification using the actual native content dimensions.
        await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      };
      await resize(width);
      await page.getByRole('button', { name: '新建笔记', exact: true }).click();
      await page.getByRole('button', { name: '创建空白笔记', exact: true }).click();
      const text = '# 自由调整工作区\n\n拖动或收起侧栏时，保留正在输入的内容。\n\n[[双向引用]]';
      await page.getByRole('textbox', { name: 'Markdown编辑器' }).fill(text);
      let sidebar = page.getByRole('separator', { name: '调整导航栏宽度' });
      let list = page.getByRole('separator', { name: '调整笔记列表宽度' });
      const initial = { sidebar: width <= 1250 ? 176 : 200, list: width <= 1250 ? 232 : 260 };
      await expect(sidebar).toHaveAttribute('aria-valuenow', String(initial.sidebar));
      await expect(list).toHaveAttribute('aria-valuenow', String(initial.list));
      const before = (await page.locator('.document').boundingBox())!.width;
      await drag(page, sidebar, 40);
      await expect(sidebar).toHaveAttribute('aria-valuenow', String(initial.sidebar + 40));
      await drag(page, list, 36);
      await expect(list).toHaveAttribute('aria-valuenow', String(initial.list + 36));
      expect((await page.locator('.document').boundingBox())!.width).toBeCloseTo(before - 76, 0);
      await expect(page.getByRole('textbox', { name: 'Markdown编辑器' })).toHaveValue(text);
      await assertUsable(page);
      await page.getByRole('button', { name: '隐藏笔记列表', exact: true }).click();
      await page.getByRole('textbox', { name: '搜索笔记' }).fill('自由调整');
      await expect(page.locator('.note-list')).toBeVisible();
      await expect(page.locator('.note-card')).toHaveCount(1);
      await page.getByRole('button', { name: '清空搜索' }).click();
      await app.close();
      app = await launch();
      page = await app.firstWindow();
      await resize(width);
      await page.locator('.note-card').first().click();
      sidebar = page.getByRole('separator', { name: '调整导航栏宽度' });
      list = page.getByRole('separator', { name: '调整笔记列表宽度' });
      await expect(sidebar).toHaveAttribute('aria-valuenow', String(initial.sidebar + 40));
      await expect(list).toHaveAttribute('aria-valuenow', String(initial.list + 36));
      await resize(1080);
      await assertUsable(page);
      await resize(width);
      await expect(sidebar).toHaveAttribute('aria-valuenow', String(initial.sidebar + 40));
      await expect(list).toHaveAttribute('aria-valuenow', String(initial.list + 36));
      await drag(page, list, width / 2);
      const rememberedList = await value(list);
      expect(rememberedList).toBe(Number(await list.getAttribute('aria-valuemax')));
      await assertUsable(page);
      await drag(page, list, -width);
      await expect(list).toHaveCount(0);
      await expect(page.locator('.note-list')).toHaveCount(0);
      await page.getByRole('button', { name: '展开笔记列表', exact: true }).click();
      await expect(list).toHaveAttribute('aria-valuenow', String(rememberedList));
      await list.focus();
      await page.keyboard.press('Home');
      await expect(list).toHaveAttribute('aria-valuenow', '220');
      await drag(page, sidebar, width / 2);
      const rememberedSidebar = await value(sidebar);
      expect(rememberedSidebar).toBe(Number(await sidebar.getAttribute('aria-valuemax')));
      await assertUsable(page);
      await drag(page, sidebar, -width);
      await expect(sidebar).toHaveCount(0);
      await expect(page.locator('.sidebar')).toHaveCount(0);
      await page.getByRole('button', { name: '展开导航栏', exact: true }).click();
      await expect(sidebar).toHaveAttribute('aria-valuenow', String(rememberedSidebar));
      await sidebar.focus();
      await page.keyboard.press('Home');
      await expect(sidebar).toHaveAttribute('aria-valuenow', '176');
      await page.keyboard.press('ArrowRight');
      await expect(sidebar).toHaveAttribute('aria-valuenow', '186');
      await page.keyboard.press('Shift+ArrowRight');
      await expect(sidebar).toHaveAttribute('aria-valuenow', '236');
      await page.keyboard.press('Enter');
      await expect(sidebar).toHaveAttribute('aria-valuenow', String(initial.sidebar));
      const box = (await list.boundingBox())!;
      await page.mouse.move(box.x + 3, box.y + 80);
      await page.mouse.down();
      await page.mouse.move(box.x - 80, box.y + 80, { steps: 4 });
      await expect(list).toHaveAttribute('data-collapse-pending', 'true');
      await list.dispatchEvent('pointercancel', { pointerId: 1 });
      await page.mouse.up();
      await expect(list).toHaveCount(1);
      await expect(page.locator('.app-shell')).not.toHaveClass(/resizing/);
      await list.dblclick();
      await expect(list).toHaveAttribute('aria-valuenow', String(initial.list));
      await assertUsable(page);
      await page.getByRole('button', { name: '隐藏导航栏', exact: true }).click();
      await page.getByRole('button', { name: '隐藏笔记列表', exact: true }).click();
      await expect(page.getByRole('separator')).toHaveCount(0);
      await assertUsable(page);
      await expect(page.getByRole('textbox', { name: 'Markdown编辑器' })).toHaveValue(text);
      await app.close();
      app = await launch();
      page = await app.firstWindow();
      await resize(width);
      await expect(page.getByRole('button', { name: '展开导航栏', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '展开笔记列表', exact: true })).toBeVisible();
      await expect(page.getByRole('separator')).toHaveCount(0);
      await page.getByRole('button', { name: '展开笔记列表', exact: true }).click();
      await page.locator('.note-card').first().click();
      await page.getByRole('button', { name: '展开导航栏', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Markdown编辑器' })).toHaveValue(text);
      await assertUsable(page);
      // Capture after all pointer work, so the human's real desktop mouse cannot interrupt a captured test drag.
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
      await page.screenshot({ animations: 'disabled', path: `test-results/三栏拖动-${width}.png` });
      await page.getByRole('button', { name: '隐藏导航栏', exact: true }).click();
      await page.getByRole('button', { name: '隐藏笔记列表', exact: true }).click();
      await page.screenshot({ animations: 'disabled', path: `test-results/三栏收起-${width}.png` });
      await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText('知识库设置');
    } finally {
      await app.close();
    }
  });
}
