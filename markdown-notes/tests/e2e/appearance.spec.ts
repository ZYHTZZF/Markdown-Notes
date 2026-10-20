import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('自定义颜色与图片背景：本机记忆、独立副本、带背景／无背景PDF、恢复默认', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zhiye-appearance-'));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ZHIYE_DATA_DIR: root,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Markdown编辑器' })
      .fill(
        '# 自定义外观验证\n\n中文笔记与公式。\n\n$$\\frac{1}{2}+\\text{中文说明}$$\n\n[阅读链接](https://example.com)' +
          Array.from(
            { length: 18 },
            (_, i) =>
              `\n\n## 第${i + 1}段：背景分页\n\n跨页保持背景和中文清晰，数学公式 $x^2$ 正常显示。`,
          ).join(''),
      );
    const image = join(root, 'source.png');
    await app.evaluate(({ nativeImage }, path) => {
      const pixels = Buffer.alloc(128 * 128 * 4);
      for (let y = 0; y < 128; y++)
        for (let x = 0; x < 128; x++) {
          const at = (y * 128 + x) * 4;
          pixels[at] = x < 64 ? 190 : 70;
          pixels[at + 1] = y < 64 ? 70 : 170;
          pixels[at + 2] = 210;
          pixels[at + 3] = 255;
        }
      process
        .getBuiltinModule('node:fs')
        .writeFileSync(
          path,
          nativeImage.createFromBitmap(pixels, { width: 128, height: 128 }).toPNG(),
        );
    }, image);
    await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
    await page.getByRole('button', { name: '外观', exact: true }).click();
    await page.getByRole('button', { name: '选择主色#7352c7', exact: true }).click();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, image);
    await page.getByRole('button', { name: '选择本地背景图片', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('外观已保存');
    await page.getByRole('slider', { name: '背景强度' }).fill('100');
    await page.getByRole('button', { name: '应用外观', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => window.notesApi.call('appearance.get').then((x) => x.strength)),
      )
      .toBe(100);
    const saved = await page.evaluate(() => window.notesApi.call('appearance.get'));
    expect(saved.accent).toBe('#7352c7');
    expect(saved.image_data).toMatch(/^data:image\/png;base64,/);
    unlinkSync(image);
    await page.screenshot({ path: 'test-results/知页-外观设置.png' });
    await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await page.screenshot({ path: 'test-results/知页-自定义背景.png' });
    await app.close();
    app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
    page = await app.firstWindow();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.background))
      .toBe('image');
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--accent-fill').trim(),
      ),
    ).toBe('#7352c7');
    await page.locator('.note-card').first().click();
    mkdirSync('reports', { recursive: true });
    for (const withBackground of [true, false]) {
      const path = resolve(`reports/外观导出-${withBackground ? '带背景' : '无背景'}.pdf`);
      await app.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
      }, path);
      await page.getByRole('button', { name: '导出PDF', exact: true }).click();
      const checkbox = page.getByRole('checkbox', { name: '带背景导出', exact: true });
      await expect(checkbox).not.toBeChecked();
      if (withBackground) await checkbox.check();
      await page.getByRole('button', { name: '导出PDF文件', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('PDF已导出');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(readFileSync(path).subarray(0, 5).toString()).toBe('%PDF-');
    }
    await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
    await page.getByRole('button', { name: '外观', exact: true }).click();
    await page.getByLabel('自定义主色', { exact: true }).fill('#fff099');
    await page.getByLabel('背景颜色', { exact: true }).fill('#000000');
    await page.getByRole('button', { name: '应用外观', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.background))
      .toBe('solid');
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--on-accent').trim(),
        ),
      )
      .toBe('#000000');
    await page.getByRole('button', { name: '恢复默认外观', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.background))
      .toBe('default');
    expect(
      (await page.evaluate(() => window.notesApi.call('appearance.get'))).image_data,
    ).toBeNull();
  } finally {
    await app.close();
  }
});

test('无效图片、伪造路径与损坏设置：拒绝非法输入，保留原设置并回退默认', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zhiye-appearance-invalid-'));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ZHIYE_DATA_DIR: root,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: '新建笔记', exact: true }).waitFor();
    const original = await page.evaluate(() => window.notesApi.call('appearance.get'));
    const invalid = join(root, 'invalid.png');
    writeFileSync(invalid, '<svg onload="alert(1)"></svg>');
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, invalid);
    const result = await page.evaluate(async () => {
      try {
        await window.notesApi.call('appearance.chooseImage');
        return '';
      } catch (e: any) {
        return e.message;
      }
    });
    expect(result).toContain('PNG或JPEG');
    expect(await page.evaluate(() => window.notesApi.call('appearance.get'))).toEqual(original);
    const bad = await page.evaluate(async (original) => {
      const { image_data, ...settings } = original;
      try {
        await window.notesApi.call('appearance.set', { ...settings, path: 'C:/private.txt' });
        return '';
      } catch (e: any) {
        return e.message;
      }
    }, original);
    expect(bad).toContain('格式无效');
    const settingsFile = await app.evaluate(({ app }) =>
      process
        .getBuiltinModule('node:path')
        .join(app.getPath('userData'), 'appearance', 'appearance.json'),
    );
    await app.close();
    writeFileSync(settingsFile, '{broken');
    app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
    page = await app.firstWindow();
    await page.getByRole('button', { name: '新建笔记', exact: true }).waitFor();
    await expect
      .poll(() =>
        page.evaluate(() => window.notesApi.call('appearance.get').then((x) => x.warning)),
      )
      .toContain('损坏');
    expect(readFileSync(settingsFile, 'utf8')).toBe('{broken');
    expect((await page.evaluate(() => window.notesApi.call('appearance.get'))).background).toBe(
      'default',
    );
  } finally {
    await app.close();
  }
});
