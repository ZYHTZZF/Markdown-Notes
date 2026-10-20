import { Backend } from '../../src/backend/service';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
async function main() {
  const b = new Backend(process.env.ZHIYE_CRASH_ROOT!, resolve('dist/indexer.cjs'));
  const call = (method: string, payload: any = {}) =>
    b.call({ api_version: 1, request_id: randomUUID(), epoch: b.epoch, method, payload });
  const n = (await call('note.create', { title: '真实进程中断' })).note;
  const saved = (
    await call('note.save', {
      note_id: n.note_id,
      expected_revision: 0,
      content: '真实进程提交后的正文',
      tag_ids: [],
      edit_sequence: 1,
    })
  ).note;
  process.send?.({ note_id: saved.note_id });
  setInterval(() => {}, 1000);
}
void main();
