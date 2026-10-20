import { app, BrowserWindow, ipcMain, protocol, dialog, shell, Menu } from 'electron';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep, basename } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Rpc } from './shared/types';

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
const trusted = (sender: any) =>
  sender?.url?.startsWith('zhiyenotes://app/') && sender === win?.webContents.mainFrame;
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
    backend = new Worker(join(__dirname, 'backend.cjs'), {
      workerData: { root, indexWorker: join(__dirname, 'indexer.cjs') },
    });
    backend.on('message', (msg) => {
      if (msg.event) {
        win?.webContents.send('notes:change', msg.event);
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
      win?.webContents.send('notes:change', {
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
        const type = file.endsWith('.js')
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
        if (!trusted(event.senderFrame))
          throw Object.assign(new Error('来源不可用'), { code: 'E_INPUT' });
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
      backgroundColor: '#f6f5f1',
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
        win?.webContents.send('notes:closing');
      }
    });
    ipcMain.on('notes:close-result', async (event, ok) => {
      if (!trusted(event.senderFrame)) return;
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
      win?.close();
    });
    win.once('ready-to-show', () => win?.show());
    await win.loadURL('zhiyenotes://app/index.html');
  });
app.on('second-instance', () => {
  win?.restore();
  win?.show();
  win?.focus();
});
app.on('window-all-closed', () => {
  backend?.terminate();
  app.quit();
});
