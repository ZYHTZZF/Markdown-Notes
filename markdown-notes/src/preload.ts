import { contextBridge, ipcRenderer } from 'electron';
let epoch: string | null = null;
contextBridge.exposeInMainWorld('notesApi', {
  async call(method: string, payload: Record<string, unknown> = {}) {
    const request_id = crypto.randomUUID();
    const result = await ipcRenderer.invoke('notes:call', {
      api_version: 1,
      request_id,
      epoch,
      method,
      payload,
    });
    if (!result.ok)
      throw Object.assign(new Error(result.message), { code: result.code, request_id });
    if (method === 'system.status' || result.data?.epoch) epoch = result.data.epoch;
    if (
      result.data?.business_version &&
      [
        'note.create',
        'note.save',
        'note.setTags',
        'note.rename',
        'trash.move',
        'trash.restore',
        'trash.purge',
        'tag.create',
        'tag.rename',
        'tag.delete',
        'preferences',
      ].includes(method)
    )
      void ipcRenderer
        .invoke('notes:call', {
          api_version: 1,
          request_id: crypto.randomUUID(),
          epoch,
          method: 'request.ack',
          payload: { request_id },
        })
        .catch(() => {
          // Shutdown can dispose the bridge before this optional receipt acknowledgement.
          // The unacknowledged business receipt remains available in the data service.
        });
    return result.data;
  },
  onChange(fn: (value: any) => void) {
    const listener = (_event: any, value: any) => {
      if (value.epoch) epoch = value.epoch;
      fn(value);
    };
    ipcRenderer.on('notes:change', listener);
    return () => ipcRenderer.removeListener('notes:change', listener);
  },
  onClose(fn: () => Promise<boolean>) {
    const listener = async () => {
      let ok = false;
      try {
        ok = await fn();
      } catch {}
      ipcRenderer.send('notes:close-result', ok);
    };
    ipcRenderer.on('notes:closing', listener);
    return () => ipcRenderer.removeListener('notes:closing', listener);
  },
});
