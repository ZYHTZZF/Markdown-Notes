import { parentPort, workerData } from 'node:worker_threads';
import { Backend } from './service';
import { AppError } from '../shared/rules';
const backend = new Backend(workerData.root, workerData.indexWorker);
backend.on('change', (event) => parentPort!.postMessage({ event }));
parentPort!.on('message', async (message) => {
  if (message.close) {
    await backend.close();
    parentPort!.postMessage({ id: message.id, ok: true });
    return;
  }
  try {
    const data = await backend.call(message.request);
    parentPort!.postMessage({ id: message.id, ok: true, data });
  } catch (e: any) {
    const known = e instanceof AppError;
    parentPort!.postMessage({
      id: message.id,
      ok: false,
      code: known ? e.code : 'E_STORAGE',
      message: known ? e.message : '操作失败，原始数据已保留；请检查文件权限、磁盘空间或备份格式',
    });
  }
});
parentPort!.postMessage({ event: { kind: 'state', ...backend.status() } });
