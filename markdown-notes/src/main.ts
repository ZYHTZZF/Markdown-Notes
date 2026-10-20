import { app, BrowserWindow, ipcMain, protocol, dialog, shell, Menu } from 'electron';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep, basename } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Rpc } from './shared/types';
import { exportPdf, registerPdfExport } from './pdf-export';
import { AppearanceStore } from './appearance-store';
import { appearanceSchema } from './shared/appearance';

app.setName('知页');
if (process.env.ZHIYE_DATA_DIR) {
  mkdirSync(process.env.ZHIYE_DATA_DIR, { recursive: true });
  app.setPath('userData', join(process.env.ZHIYE_DATA_DIR, '.host'));
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
protocol.registerSchemesAsPrivileged([
  { scheme: 'zhiyenotes', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
let win: BrowserWindow | null = null,
  backend: Worker | null = null,
  allowClose = false,
  closing = false;
const pending = new Map<
  string,
  { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }
>();
const envelope = z
  .object({
    api_version: z.literal(1),
    request_id: z.string().uuid(),
    epoch: z.string().uuid().nullable(),
    method: z.string().max(50),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
function liveWindow() {
  return win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win : null;
}
function sendToWindow(channel: string, value?: unknown) {
  const target = liveWindow();
  if (!target) return false;
  target.webContents.send(channel, value);
  return true;
}
function call(request: Rpc) {
  return new Promise<any>((resolve, reject) => {
    const id = randomUUID(),
      timer = setTimeout(() => {
        pending.delete(id);
        reject(
          Object.assign(new Error('操作状态暂未确认，请重新检查资料或任务状态'), {
            code: 'E_RESULT_UNKNOWN',
          }),
        );
      }, 210_000);
    pending.set(id, { resolve, reject, timer });
    backend!.postMessage({ id, request });
  });
}
function system(method: string, payload: any = {}, epoch: string | null = null) {
  return call({ api_version: 1, request_id: randomUUID(), epoch, method, payload });
}
function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  const target = liveWindow();
  if (!target || event.sender !== target.webContents) return false;
  // senderFrame can itself throw when its frame was disposed during shutdown.
  try {
    const sender = event.senderFrame;
    return (
      !!sender?.url?.startsWith('zhiyenotes://app/') && sender === target.webContents.mainFrame
    );
  } catch {
    return false;
  }
}
const safeName = (title: string, id: string) => {
  let s = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 100);
  if (!s || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)) s = id;
  return s + '.md';
};

if (gotLock)
  app.whenReady().then(async () => {
    const root = process.env.ZHIYE_DATA_DIR || join(app.getPath('userData'), 'library');
    mkdirSync(root, { recursive: true });
    registerPdfExport();
    const appearance = new AppearanceStore(join(app.getPath('userData'), 'appearance'));
    backend = new Worker(join(__dirname, 'backend.cjs'), {
      workerData: { root, indexWorker: join(__dirname, 'indexer.cjs') },
    });
    backend.on('message', (msg) => {
      if (msg.event) {
        sendToWindow('notes:change', msg.event);
        return;
      }
      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        msg.ok
          ? p.resolve(msg.data)
          : p.reject(Object.assign(new Error(msg.message), { code: msg.code }));
      }
    });
    backend.on('error', () => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(
          Object.assign(new Error('本地数据服务已停止，请重新启动；资料文件已保留'), {
            code: 'E_STORAGE',
          }),
        );
      }
      pending.clear();
      sendToWindow('notes:change', {
        kind: 'fault',
        fault: '本地数据服务已停止，请重新启动',
      });
    });
    protocol.handle('zhiyenotes', (request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'app') return new Response('', { status: 403 });
      const dir = resolve(__dirname, 'renderer'),
        file = resolve(
          dir,
          '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname),
        );
      if (!file.startsWith(dir + sep)) return new Response('', { status: 403 });
      try {
        const type = file.endsWith('.woff2')
          ? 'font/woff2'
          : file.endsWith('.woff')
            ? 'font/woff'
            : file.endsWith('.ttf')
              ? 'font/ttf'
              : file.endsWith('.js')
                ? 'text/javascript'
                : file.endsWith('.css')
                  ? 'text/css'
                  : file.endsWith('.svg')
                    ? 'image/svg+xml'
                    : file.endsWith('.png')
                      ? 'image/png'
                      : 'text/html';
        return new Response(readFileSync(file), {
          headers: {
            'content-type': type,
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'",
          },
        });
      } catch {
        return new Response('资源不存在', { status: 404 });
      }
    });
    ipcMain.handle('notes:call', async (event, input) => {
      try {
        if (!trusted(event)) throw Object.assign(new Error('来源不可用'), { code: 'E_INPUT' });
        const request = envelope.parse(input) as Rpc,
          { method, payload } = request;
        if (method === 'system.openLink') {
          const u = new URL(String(payload.url));
          if (!['http:', 'https:'].includes(u.protocol)) throw new Error('不支持的链接');
          await shell.openExternal(u.href);
          return { ok: true, data: true };
        }
        if (method === 'system.reveal') {
          const status = await system('system.status');
          let path = status.root;
          if (payload.backup_id) {
            const list = await system('backup.list', {}, status.epoch);
            path = list.find((b: any) => b.backup_id === payload.backup_id)?.file_path;
            if (!path) throw new Error('备份记录不存在');
          }
          shell.showItemInFolder(path);
          return { ok: true, data: true };
        }
        if (method.startsWith('appearance.')) {
          try {
            if (method === 'appearance.set')
              return { ok: true, data: appearance.set(appearanceSchema.parse(payload)) };
            z.object({}).strict().parse(payload);
            if (method === 'appearance.get') return { ok: true, data: appearance.get() };
            if (method === 'appearance.reset') return { ok: true, data: appearance.reset() };
            if (method !== 'appearance.chooseImage') throw new Error('不支持的外观操作');
            const chosen = await dialog.showOpenDialog(win!, {
              title: '选择背景图片',
              properties: ['openFile'],
              filters: [{ name: 'PNG / JPEG图片', extensions: ['png', 'jpg', 'jpeg'] }],
            });
            if (chosen.canceled || !chosen.filePaths[0])
              return { ok: false, code: 'E_CANCELLED', message: '已取消选择背景图片' };
            return { ok: true, data: appearance.selectImage(chosen.filePaths[0]) };
          } catch (error: any) {
            throw Object.assign(
              new Error(
                error instanceof z.ZodError ? '外观设置格式无效，请重新选择' : error.message,
              ),
              { code: 'E_APPEARANCE' },
            );
          }
        }
        if (method === 'export.pdf') {
          const { include_background, ...p } = z
            .object({ note_id: z.string().uuid(), include_background: z.boolean().default(false) })
            .strict()
            .parse(payload);
          const status = await system('system.status');
          if (status.fault || status.exclusive || request.epoch !== status.epoch)
            throw Object.assign(new Error('资料库状态已改变或正在恢复，请稍后重试'), {
              code: 'E_BUSY',
            });
          const note = await system('note.get', p, status.epoch);
          const owner = liveWindow();
          if (!owner) throw new Error('窗口已关闭');
          const chosen = await dialog.showSaveDialog(owner, {
            title: '导出当前笔记为PDF',
            defaultPath: join(
              app.getPath('documents'),
              safeName(note.title, note.note_id).replace(/\.md$/, '.pdf'),
            ),
            filters: [{ name: 'PDF文档', extensions: ['pdf'] }],
            properties: ['showOverwriteConfirmation', 'createDirectory'],
          });
          if (chosen.canceled || !chosen.filePath)
            return { ok: false, code: 'E_CANCELLED', message: '已取消导出' };
          const current = await system('system.status');
          if (current.epoch !== status.epoch || current.exclusive || current.fault)
            throw Object.assign(new Error('资料库状态已改变，请重新导出'), { code: 'E_BUSY' });
          return {
            ok: true,
            data: await exportPdf(owner, root, chosen.filePath, {
              title: note.title,
              content: note.content,
              appearance: {
                ...appearance.get(),
                ...(include_background ? {} : { background: 'default', image_data: null }),
              },
            }),
          };
        }
        if (method === 'backup.create') {
          if (Object.keys(payload).length) throw new Error('非法路径参数');
          const chosen = await dialog.showOpenDialog(win!, {
            title: '选择资料库之外的备份文件夹',
            properties: ['openDirectory', 'createDirectory'],
          });
          if (chosen.canceled) return { ok: false, code: 'E_CANCELLED', message: '已取消备份' };
          request.payload = { directory: chosen.filePaths[0] };
        }
        if (method === 'export') {
          const status = await system('system.status');
          const n = payload.note_id
            ? await system('note.get', { note_id: payload.note_id }, status.epoch)
            : null;
          const chosen = await dialog.showSaveDialog(win!, {
            title: n ? '导出Markdown正文' : '导出全部有效笔记',
            defaultPath: join(
              app.getPath('documents'),
              n ? safeName(n.title, n.note_id) : '知页-全部笔记.zip',
            ),
            filters: [{ name: n ? 'Markdown' : 'ZIP归档', extensions: [n ? 'md' : 'zip'] }],
            properties: ['showOverwriteConfirmation', 'createDirectory'],
          });
          if (chosen.canceled || !chosen.filePath)
            return { ok: false, code: 'E_CANCELLED', message: '已取消导出' };
          request.payload = { path: chosen.filePath, note_id: payload.note_id, overwrite: true };
          if (!payload.note_id) delete request.payload.note_id;
        }
        if (method === 'restore.inspect') {
          if (Object.keys(payload).length) throw new Error('非法路径参数');
          const chosen = await dialog.showOpenDialog(win!, {
            title: '选择知页完整备份（不是Markdown导出包）',
            properties: ['openFile'],
            filters: [{ name: '知页完整备份', extensions: ['zip'] }],
          });
          if (chosen.canceled) return { ok: false, code: 'E_CANCELLED', message: '已取消选择' };
          request.payload = { path: chosen.filePaths[0] };
        }
        if (['trash.purge', 'trash.move', 'tag.delete', 'restore.execute'].includes(method)) {
          const texts: Record<string, string> = {
            'trash.purge': '永久删除这篇笔记？此操作不可撤销。',
            'trash.move': '将笔记移入回收站？其他笔记中的引用文字会保留，目标将暂时失效。',
            'tag.delete': '删除这个标签？所有笔记（含回收站）的关联都会移除，笔记正文会保留。',
            'restore.execute': '从完整备份恢复？这会整体替换当前资料库，原始资料和保护副本会保留。',
          };
          const confirm = await dialog.showMessageBox(win!, {
            type: 'warning',
            title: '确认操作',
            message: texts[method],
            buttons: ['取消', method === 'trash.purge' ? '永久删除' : '确认'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          if (confirm.response !== 1)
            return { ok: false, code: 'E_CANCELLED', message: '操作已取消' };
          if (method === 'restore.execute') {
            const status = await system('system.status');
            if (!status.fault) {
              const dir = await dialog.showOpenDialog(win!, {
                title: '选择恢复前保护备份的位置（须位于资料库之外）',
                properties: ['openDirectory', 'createDirectory'],
              });
              if (dir.canceled)
                return { ok: false, code: 'E_CANCELLED', message: '已取消恢复，当前资料未改变' };
              request.payload = {
                inspect_token: payload.inspect_token,
                backup_directory: dir.filePaths[0],
              };
            }
          }
        }
        return { ok: true, data: await call(request), request_id: request.request_id };
      } catch (e: any) {
        return {
          ok: false,
          code: e.code ?? 'E_INPUT',
          message: e.code ? e.message : '操作未完成，请检查输入、文件权限与磁盘空间',
        };
      }
    });
    win = new BrowserWindow({
      width: 1480,
      height: 940,
      minWidth: 1080,
      minHeight: 700,
      backgroundColor: '#F5F5F7',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#F5F5F7', symbolColor: '#1D1D1F', height: 56 },
      title: '知页 · 个人知识库',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    Menu.setApplicationMenu(null);
    win.webContents.session.setPermissionRequestHandler((_web, _permission, cb) => cb(false));
    win.webContents.session.webRequest.onBeforeRequest((details, cb) =>
      cb({
        cancel:
          !details.url.startsWith('zhiyenotes://app/') && !details.url.startsWith('devtools://'),
      }),
    );
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.on('close', (event) => {
      if (allowClose) return;
      event.preventDefault();
      if (!closing) {
        closing = true;
        sendToWindow('notes:closing');
      }
    });
    win.once('closed', () => {
      // Worker messages can already be queued when window-all-closed terminates it.
      win = null;
    });
    ipcMain.on('notes:close-result', async (event, ok) => {
      if (!trusted(event)) return;
      if (!ok) {
        const result = await dialog.showMessageBox(win!, {
          type: 'warning',
          message: '最新修改尚未保存。是否放弃未保存的内容并退出？',
          buttons: ['继续编辑', '放弃并退出'],
          defaultId: 0,
          cancelId: 0,
        });
        if (result.response !== 1) {
          closing = false;
          return;
        }
      }
      allowClose = true;
      liveWindow()?.close();
    });
    win.once('ready-to-show', () => liveWindow()?.show());
    await win.loadURL('zhiyenotes://app/index.html');
  });
app.on('second-instance', () => {
  const target = liveWindow();
  target?.restore();
  target?.show();
  target?.focus();
});
app.on('window-all-closed', () => {
  backend?.terminate();
  app.quit();
});
