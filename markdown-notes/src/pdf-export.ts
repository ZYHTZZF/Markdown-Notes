import { BrowserWindow, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { join, dirname, basename, resolve, sep } from 'node:path';
import {
  mkdirSync,
  realpathSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AppearanceView } from './shared/appearance';

type Source = { title: string; content: string; appearance?: AppearanceView };
type Job = { window: BrowserWindow; source: Source; finish: (ok: boolean) => void };
const jobs = new Map<number, Job>();
function jobFor(event: IpcMainInvokeEvent) {
  const job = jobs.get(event.sender.id);
  if (
    !job ||
    job.window.isDestroyed() ||
    event.senderFrame !== event.sender.mainFrame ||
    event.senderFrame?.url !== 'zhiyenotes://app/print.html'
  )
    throw new Error('打印页面来源不可用');
  return job;
}
export function registerPdfExport() {
  ipcMain.handle('pdf:source', (event) => jobFor(event).source);
  ipcMain.handle('pdf:ready', (event, ok) => jobFor(event).finish(ok === true));
}
function checkPath(root: string, target: string) {
  const parent = realpathSync(dirname(target));
  const actual = resolve(join(parent, basename(target))).toLowerCase();
  const internal = realpathSync(root).toLowerCase();
  if (actual === internal || actual.startsWith(internal + sep))
    throw Object.assign(new Error('不能用PDF覆盖内部资料，请选择资料库之外的位置'), {
      code: 'E_PATH',
    });
  if (!target.toLowerCase().endsWith('.pdf'))
    throw Object.assign(new Error('请选择.pdf文件名'), { code: 'E_PATH' });
}
export async function exportPdf(
  owner: BrowserWindow,
  root: string,
  target: string,
  source: Source,
) {
  mkdirSync(dirname(target), { recursive: true });
  checkPath(root, target);
  const window = new BrowserWindow({
    parent: owner,
    show: false,
    width: 900,
    height: 1000,
    backgroundColor: '#FFFFFF',
    webPreferences: {
      preload: join(__dirname, 'print-preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  let timer: NodeJS.Timeout | undefined;
  const ready = new Promise<boolean>((resolve) => {
    jobs.set(window.webContents.id, { window, source, finish: resolve });
    timer = setTimeout(() => resolve(false), 60_000);
    window.once('closed', () => resolve(false));
    window.webContents.once('render-process-gone', () => resolve(false));
  });
  const id = window.webContents.id;
  const temp = target + '.' + randomUUID() + '.partial';
  const abort = () => {
    if (!window.isDestroyed()) window.destroy();
  };
  owner.once('closed', abort);
  try {
    await window.loadURL('zhiyenotes://app/print.html');
    if (!(await ready) || owner.isDestroyed()) throw new Error('PDF排版或字体加载未完成');
    const data = await window.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      generateTaggedPDF: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    if (owner.isDestroyed()) throw new Error('导出已取消');
    checkPath(root, target);
    const fd = openSync(temp, 'wx');
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
    return { file_path: target, file_size: data.length };
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp);
    if ((error as any).code === 'E_PATH') throw error;
    throw Object.assign(
      new Error('PDF导出失败，原有文件已保留；请检查公式、字体、文件占用和磁盘空间后重试'),
      { code: 'E_EXPORT' },
    );
  } finally {
    clearTimeout(timer);
    jobs.delete(id);
    owner.removeListener('closed', abort);
    abort();
  }
}
