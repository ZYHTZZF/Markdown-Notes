import { BUILTIN_TEMPLATES } from '../shared/productivity';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  renameSync,
  readFileSync,
  statSync,
  openSync,
  closeSync,
  fsyncSync,
  realpathSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { Store } from './store';
import { readBackup, writeBackup, exportNotes, digest, inside } from './archive';
import { buildStandalone } from './indexer';
import { fail, AppError, key, name, counts, trim } from '../shared/rules';
import type { IndexStatus, Rpc } from '../shared/types';

const id = z.string().uuid(),
  revision = z.number().int().nonnegative(),
  ids = z.array(id).max(20),
  empty = z.object({}).strict();
const schemas: Record<string, z.ZodType<any>> = {
  'note.create': z
    .object({ title: z.string().optional(), template_id: z.string().max(100).optional() })
    .strict(),
  'note.flag': z
    .object({
      note_id: id,
      expected_revision: revision,
      flag: z.enum(['favorites', 'pinned']),
      value: z.boolean(),
    })
    .strict(),
  'template.list': empty,
  'template.save': z
    .object({ template_id: id.optional(), title: z.string(), content: z.string() })
    .strict(),
  'template.delete': z.object({ template_id: id }).strict(),
  'note.suggest': z.object({ keyword: z.string().max(200) }).strict(),
  'note.save': z
    .object({
      note_id: id,
      expected_revision: revision,
      content: z.string(),
      tag_ids: ids,
      edit_sequence: revision,
    })
    .strict(),
  'note.setTags': z.object({ note_id: id, expected_revision: revision, tag_ids: ids }).strict(),
  'note.rename.prepare': z
    .object({ note_id: id, expected_revision: revision, title: z.string() })
    .strict(),
  'note.rename': z.object({ plan_token: id }).strict(),
  'trash.move': z.object({ note_id: id, expected_revision: revision }).strict(),
  'trash.restore': z
    .object({ note_id: id, expected_revision: revision, title: z.string().optional() })
    .strict(),
  'trash.purge': z.object({ note_id: id, expected_revision: revision }).strict(),
  'tag.create': z.object({ name: z.string() }).strict(),
  'tag.rename': z.object({ tag_id: id, name: z.string() }).strict(),
  'tag.delete': z.object({ tag_id: id }).strict(),
  'note.get': z.object({ note_id: id, trash: z.boolean().optional() }).strict(),
  'note.list': z
    .object({
      favorites_only: z.boolean().optional(),
      trash: z.boolean().optional(),
      tag_ids: ids.optional(),
      page: z.number().int().min(1).optional(),
    })
    .strict(),
  'search.query': z
    .object({
      favorites_only: z.boolean().optional(),
      keyword: z.string().optional(),
      scope: z.enum(['all', 'title', 'content', 'tag']).optional(),
      tag_ids: ids.optional(),
      page: z.number().int().min(1).optional(),
      query_token: id.optional(),
    })
    .strict(),
  links: z.object({ note_id: id }).strict(),
  'link.open': z.object({ target_key: z.string() }).strict(),
  preferences: z
    .object({
      preferences: z
        .object({
          font_size: z.number().int().min(12).max(24).optional(),
          mode: z.enum(['edit', 'split', 'read']).optional(),
        })
        .strict(),
    })
    .strict(),
  'system.status': empty,
  'index.status': empty,
  'index.rebuild': empty,
  'backup.list': empty,
  'tag.list': empty,
  stats: empty,
  'backup.create': z.object({ directory: z.string() }).strict(),
  export: z
    .object({ path: z.string(), note_id: id.optional(), overwrite: z.boolean().optional() })
    .strict(),
  'restore.inspect': z.object({ path: z.string() }).strict(),
  'restore.execute': z
    .object({ inspect_token: id, backup_directory: z.string().optional() })
    .strict(),
  'operation.status': z.object({ request_id: id }).strict(),
  'request.ack': z.object({ request_id: id }).strict(),
  'extension.describe': empty,
};

export class Backend extends EventEmitter {
  private lease: DatabaseSync;
  control: DatabaseSync | null = null;
  store: Store | null = null;
  epoch: string | null = null;
  fault: string | null = null;
  activePath = '';
  worker: Worker | null = null;
  pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }
  >();
  index: IndexStatus = {
    state: 'updating',
    indexed_version: -1,
    business_version: 0,
    epoch: '',
    phase: '准备索引',
    unavailable_ms: 0,
    unavailable_total_ms: 0,
    lag_commits: 0,
    closure_notes: 0,
    closure_bytes: 0,
    barrier_attempts: 0,
    barrier_ms: 0,
    barrier_total_ms: 0,
    wal_bytes: 0,
    wal_peak_bytes: 0,
    wal_growth_bytes: 0,
    checkpoint_status: 'idle',
    budget_code: null,
  };
  exclusive = false;
  barrier = false;
  private barrierTimer?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private outageStart: number | null = null;
  private outageTotal = 0;
  private outageWall: number | null = null;
  private autoStopped = false;
  private pressure = false;
  private outageId: string | null = null;
  private statsCache: any = null;
  private inspected = new Map<string, any>();
  private plans = new Map<string, any>();
  private walStart = 0;
  private reclaimStart = 0;
  private pressureSince = 0;
  constructor(
    public root: string,
    private workerFile: string,
    private inject?: string,
  ) {
    super();
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
    this.lease = new DatabaseSync(join(this.root, '.writer-lock.sqlite'));
    try {
      this.lease.exec('CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY);BEGIN IMMEDIATE');
    } catch {
      this.lease.close();
      fail('E_LOCKED', '该资料库已被其他实例占用，不能并发写入');
    }
    this.boot();
    this.timer = setInterval(() => this.monitor(), 1000);
    this.timer.unref();
  }
  private boot() {
    try {
      const pointer = join(this.root, 'control-location.json'),
        defaultFile = join(this.root, 'control.sqlite');
      let controlPath = defaultFile;
      if (existsSync(pointer)) {
        const value = JSON.parse(readFileSync(pointer, 'utf8'));
        if (typeof value.file !== 'string' || basename(value.file) !== value.file)
          fail('E_STORAGE', '控制位置记录无效');
        controlPath = join(this.root, value.file);
        if (!existsSync(controlPath)) fail('E_STORAGE', '控制文件缺失');
      }
      const fresh = !existsSync(controlPath) && !existsSync(join(this.root, 'generations'));
      if (!fresh && !existsSync(controlPath))
        fail('E_STORAGE', '原资料存在但控制文件缺失，请从备份恢复');
      if (!fresh) {
        const c = new DatabaseSync(controlPath, { readOnly: true });
        try {
          if (Object.values(c.prepare('PRAGMA quick_check').get()!)[0] !== 'ok')
            fail('E_STORAGE', '本机控制文件损坏');
          c.prepare('SELECT value FROM kv LIMIT 1').get();
        } finally {
          c.close();
        }
      }
      this.control = new DatabaseSync(controlPath);
      this.control.exec(
        'PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE IF NOT EXISTS backups(id TEXT PRIMARY KEY,value TEXT);CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,value TEXT);',
      );
      if (fresh) {
        this.epoch = randomUUID();
        this.activePath = join(this.root, 'generations', this.epoch, 'business.sqlite');
        this.store = new Store(this.activePath, true);
        this.set('active', { epoch: this.epoch, path: this.activePath, index: null });
        this.writePointer(basename(controlPath));
      } else {
        const active = this.get('active');
        if (!active || !existsSync(active.path)) fail('E_STORAGE', '活动资料库缺失，请从备份恢复');
        this.epoch = active.epoch;
        this.activePath = active.path;
        const probe = new Store(this.activePath);
        probe.close();
        this.store = new Store(this.activePath, true);
      }
      const old = this.get('runtime');
      if (old) {
        this.outageTotal = old.total ?? 0;
        if (old.outageWall) {
          this.outageWall = old.outageWall;
          this.outageId = old.outage_id ?? randomUUID();
          this.outageStart = performance.now() - Math.max(0, Date.now() - old.outageWall);
        }
      }
      this.startIndexer();
    } catch (e: any) {
      this.fault =
        e.code === 'E_VERSION'
          ? '资料格式版本不支持，请使用兼容版本。'
          : '主数据或控制信息异常，已停止写入；请选择完整备份进行故障恢复。';
      this.index.state = 'failed';
      this.index.phase = this.fault;
      try {
        this.store?.close();
      } catch {}
      this.store = null;
    }
  }
  get(k: string) {
    const row = this.control?.prepare('SELECT value FROM kv WHERE key=?').get(k) as any;
    return row ? JSON.parse(row.value) : null;
  }
  set(k: string, v: any) {
    this.control!.prepare('INSERT OR REPLACE INTO kv VALUES(?,?)').run(k, JSON.stringify(v));
  }
  private writePointer(file: string) {
    const target = join(this.root, 'control-location.json'),
      temp = target + '.new';
    writeFileSync(temp, JSON.stringify({ file }));
    const fd = openSync(temp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  }
  status() {
    if (this.store) {
      this.index.business_version = this.store.version;
      if (!this.statsCache) this.statsCache = this.store.stats();
    }
    this.index.epoch = this.epoch ?? '';
    this.index.outage_id = this.outageId;
    this.index.unavailable_ms =
      this.outageStart === null ? 0 : performance.now() - this.outageStart;
    this.index.unavailable_total_ms = this.outageTotal + this.index.unavailable_ms;
    return {
      epoch: this.epoch,
      fault: this.fault,
      root: this.root,
      active_path: this.activePath,
      index: { ...this.index },
      profile: this.store?.profile() ?? null,
      stats: this.store ? this.statsCache : null,
      exclusive: this.exclusive,
    };
  }
  private emitChange(kind = 'state') {
    this.emit('change', { kind, ...this.status() });
  }
  private unavailable() {
    if (this.outageStart === null) {
      this.outageStart = performance.now();
      this.outageWall = Date.now();
      this.outageId = randomUUID();
      try {
        this.set('runtime', {
          outageWall: this.outageWall,
          outage_id: this.outageId,
          total: this.outageTotal,
        });
      } catch {}
    }
  }
  private available() {
    if (this.outageStart !== null) {
      this.outageTotal += performance.now() - this.outageStart;
      this.outageStart = null;
      this.outageWall = null;
      this.outageId = null;
      this.autoStopped = false;
      this.index.budget_code = null;
      try {
        this.set('runtime', { outageWall: null, outage_id: null, total: this.outageTotal });
      } catch {}
    }
  }
  private startIndexer() {
    if (!this.store || !this.epoch) return;
    this.unavailable();
    this.index.state = 'updating';
    const existing = this.get('active')?.index;
    this.worker = new Worker(this.workerFile, {
      workerData: {
        kind: 'index',
        source: this.activePath,
        directory: dirname(this.activePath),
        epoch: this.epoch,
        existing,
      },
    });
    this.worker.on('message', (msg) => {
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        msg.ok ? p.resolve(msg.data) : p.reject(new AppError(msg.code, msg.message));
        return;
      }
      if (msg.event === 'barrier') {
        if (this.exclusive) {
          this.worker?.postMessage({ kind: 'barrierAck', id: msg.id, denied: true });
          return;
        }
        this.barrier = true;
        clearTimeout(this.barrierTimer);
        this.barrierTimer = setTimeout(() => {
          this.barrier = false;
          this.index.budget_code = 'E_REBUILD_BUDGET';
        }, 4900);
        this.worker?.postMessage({ kind: 'barrierAck', id: msg.id, version: this.store?.version });
        return;
      }
      if (msg.event === 'release') {
        this.barrier = false;
        clearTimeout(this.barrierTimer);
        return;
      }
      if (msg.event === 'published') {
        const active = this.get('active');
        if (active?.epoch === this.epoch) this.set('active', { ...active, index: msg.file });
        return;
      }
      if (msg.event === 'index') {
        const { event, ...fields } = msg;
        Object.assign(this.index, fields);
        if (
          this.store &&
          this.index.state === 'ready' &&
          this.index.indexed_version === this.store.version
        )
          this.available();
        else this.unavailable();
        this.emitChange();
      }
    });
    this.worker.on('error', () => {
      this.index.state = 'failed';
      this.index.phase = '索引进程异常，请重新构建';
      this.barrier = false;
      this.unavailable();
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new AppError('E_INDEX_UNAVAILABLE', '索引不可用'));
      }
      this.pending.clear();
      this.emitChange();
    });
  }
  private async indexCall(kind: string, payload: any) {
    if (
      !this.worker ||
      this.index.state !== 'ready' ||
      this.index.indexed_version !== this.store!.version
    )
      fail('E_INDEX_UNAVAILABLE', '搜索和引用索引正在更新，请稍候');
    const v = this.store!.version;
    const data = await new Promise<any>((resolve, reject) => {
      const id = randomUUID(),
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AppError('E_INDEX_UNAVAILABLE', '索引查询超时'));
        }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ kind, id, payload });
    });
    if (this.store!.version !== v) fail('E_QUERY_STALE', '资料已变更，请刷新');
    return data;
  }
  private monitor() {
    try {
      if (!this.store) return;
      if (this.outageStart !== null) {
        const age = performance.now() - this.outageStart;
        if (age >= 60_000) this.index.budget_code = 'INDEX_UNAVAILABLE_60S';
        if (age >= 120_000 && !this.autoStopped) {
          this.autoStopped = true;
          if (this.index.state === 'rebuilding') {
            void this.stopIndexer();
            this.index.state = 'failed';
            this.index.phase = '索引不可用已超过120秒，请处理原因后重新构建';
          }
        }
      }
      const wal = this.activePath + '-wal',
        size = existsSync(wal) ? statSync(wal).size : 0;
      this.index.wal_bytes = size;
      this.index.wal_peak_bytes = Math.max(size, this.index.wal_peak_bytes);
      this.index.wal_growth_bytes = Math.max(0, this.index.wal_peak_bytes - this.walStart);
      if (size >= 64 * 1048576) {
        const cp = this.store.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as any;
        this.index.checkpoint_status = cp.busy ? 'busy' : 'passive';
      }
      if (size >= 256 * 1048576 && !this.pressureSince) {
        this.pressureSince = Date.now();
        this.index.budget_code = 'WAL_PRESSURE';
        if (this.index.state === 'rebuilding') {
          void this.stopIndexer();
          this.index.state = 'failed';
          this.index.phase = '日志空间压力，重建已停止，正文已保留';
        }
      }
      if (size > 0 && this.index.state !== 'rebuilding' && !this.exclusive && !this.barrier) {
        const cp = this.store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as any;
        this.index.checkpoint_status = cp.busy ? 'busy' : 'truncated';
        if (!cp.busy) {
          this.pressure = false;
          this.pressureSince = 0;
          this.reclaimStart = 0;
        } else if (this.pressureSince && Date.now() - this.pressureSince > 10_000)
          this.pressure = true;
      }
      if (this.pressure) {
        this.index.budget_code = 'E_STORAGE_PRESSURE';
        this.index.phase = '日志回收受阻，请释放磁盘空间或关闭占用程序';
      }
      if (this.outageStart !== null || this.pressure) this.emitChange('runtime');
    } catch {
      this.index.checkpoint_status = 'error';
      if (this.pressureSince && Date.now() - this.pressureSince > 10_000) this.pressure = true;
    }
  }
  private async stopIndexer() {
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
    this.barrier = false;
    clearTimeout(this.barrierTimer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AppError('E_INDEX_UNAVAILABLE', '索引任务已停止'));
    }
    this.pending.clear();
  }
  private async writable() {
    if (!this.store || this.fault) fail('E_STORAGE', '资料库不可写，请先恢复');
    if (this.exclusive) fail('E_BUSY', '恢复正在执行，请稍候');
    if (this.pressure) fail('E_STORAGE_PRESSURE', '磁盘日志回收受阻，当前输入已保留');
    const t = performance.now();
    while (this.barrier) {
      if (performance.now() - t > 5100) fail('E_BUSY', '索引切换尚未完成，请重试');
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async call(request: Rpc) {
    const method = request.method;
    let p: any;
    try {
      p = (schemas[method] ?? fail('E_NOT_SUPPORTED', '不支持的接口')).parse(request.payload);
    } catch (e) {
      if (e instanceof AppError) throw e;
      fail('E_INPUT', '输入字段或格式不正确');
    }
    if (
      !['system.status', 'restore.inspect', 'restore.execute', 'operation.status'].includes(
        method,
      ) &&
      request.epoch !== this.epoch
    )
      fail('E_EPOCH', '资料库已切换，请重新加载');
    if (method === 'system.status' || method === 'index.status') return this.status();
    if (method === 'extension.describe')
      return { enabled: false, api_version: 1, message: '插件与主题扩展属于P2，基础版未启用' };
    if (method === 'operation.status') {
      const row = this.control
        ?.prepare('SELECT value FROM jobs WHERE id=?')
        .get(p.request_id) as any;
      if (row) return JSON.parse(row.value);
      const receipt = this.store?.db
        .prepare('SELECT result FROM receipts WHERE request_id=?')
        .get(p.request_id) as any;
      return receipt
        ? { state: 'committed', result: JSON.parse(receipt.result) }
        : { state: 'unknown' };
    }
    if (method === 'request.ack') {
      this.store?.db.prepare('DELETE FROM receipts WHERE request_id=?').run(p.request_id);
      return { acknowledged: true };
    }
    if (method === 'restore.inspect') {
      if (this.exclusive) fail('E_BUSY', '已有恢复任务');
      const parsed = await readBackup(p.path);
      const token = randomUUID();
      this.inspected.clear();
      this.inspected.set(token, {
        manifest: parsed.manifest,
        packageHash: parsed.packageHash,
        path: realpathSync(p.path),
        epoch: this.epoch,
        version: this.store?.version ?? null,
      });
      return {
        inspect_token: token,
        manifest: parsed.manifest,
        mode: this.fault ? 'fault' : 'normal',
        original_path: this.activePath || this.root,
        message: this.fault
          ? '原始材料将保留在原位置，恢复会新建独立资料库'
          : '恢复将整体替换当前资料，执行前会创建保护备份',
      };
    }
    if (method === 'restore.execute') return this.restore(p, request.request_id);
    if (!this.store || this.fault) fail('E_STORAGE', '主数据不可用，请执行故障恢复');
    if (method === 'note.get') return this.store.note(p.note_id, p.trash);
    if (method === 'note.list')
      return this.store.list(p.trash, p.tag_ids, p.page, p.favorites_only);
    if (method === 'template.list')
      return [
        ...BUILTIN_TEMPLATES.map((t) => ({ ...t, builtin: true })),
        ...((this.store.profile().preferences.templates as any[]) ?? []),
      ];
    if (method === 'note.suggest') {
      const q = key(trim(p.keyword));
      return (
        this.store.db
          .prepare(
            'SELECT note_id,title FROM notes WHERE deleted_at IS NULL ORDER BY title_key,note_id',
          )
          .all() as any[]
      )
        .filter((n) => key(n.title).includes(q))
        .sort((a, b) => Number(!key(a.title).startsWith(q)) - Number(!key(b.title).startsWith(q)))
        .slice(0, 20);
    }
    if (method === 'tag.list') return this.store.tags();
    if (method === 'stats') return this.store.stats();
    if (method === 'search.query') {
      const pref = this.store.profile().preferences;
      const result = await this.indexCall('query', {
        ...p,
        ...(p.favorites_only ? { favorite_ids: pref.favorites ?? [] } : {}),
      });
      const favorite = new Set((pref.favorites as string[]) ?? []),
        pinned = new Set((pref.pinned as string[]) ?? []);
      return {
        ...result,
        items: result.items.map((n: any) => ({
          ...n,
          favorite: favorite.has(n.note_id),
          pinned: pinned.has(n.note_id),
        })),
      };
    }
    if (method === 'links') return this.indexCall('links', p);
    if (method === 'link.open') {
      if (this.index.state !== 'ready' || this.index.indexed_version !== this.store.version)
        fail('E_INDEX_UNAVAILABLE', '引用索引尚未就绪');
      const n = this.store.db
        .prepare('SELECT note_id FROM notes WHERE title_key=? AND deleted_at IS NULL')
        .get(p.target_key) as any;
      if (!n) fail('E_LINK_UNRESOLVED', '目标笔记不存在，不会自动创建');
      return this.store.note(n.note_id);
    }
    if (method === 'index.rebuild') {
      if (this.exclusive) fail('E_BUSY', '恢复期间不可重建');
      if (this.pressureSince || this.pressure)
        fail('E_STORAGE_PRESSURE', '请先解除日志空间压力后再重建');
      if (this.index.state === 'rebuilding') fail('E_BUSY', '索引正在重建');
      this.autoStopped = true;
      if (!this.worker) this.startIndexer();
      else this.worker.postMessage({ kind: 'rebuild' });
      this.index.state = 'rebuilding';
      this.unavailable();
      this.walStart = existsSync(this.activePath + '-wal')
        ? statSync(this.activePath + '-wal').size
        : 0;
      this.index.wal_peak_bytes = this.walStart;
      this.index.wal_growth_bytes = 0;
      this.emitChange();
      return { accepted: true };
    }
    if (method === 'backup.list')
      return this.control!.prepare('SELECT value FROM backups ORDER BY rowid DESC LIMIT 100')
        .all()
        .map((r: any) => {
          const b = JSON.parse(r.value);
          return { ...b, exists: existsSync(b.file_path) };
        });
    if (method === 'backup.create') {
      if (this.exclusive) fail('E_BUSY', '恢复期间不可手动备份');
      return this.backup(p.directory, 'manual');
    }
    if (method === 'export') {
      if (this.exclusive) fail('E_BUSY', '恢复期间不可导出');
      mkdirSync(dirname(p.path), { recursive: true });
      const actual = join(realpathSync(dirname(p.path)), basename(p.path));
      if (inside(this.root, actual))
        fail('E_PATH', '不能用导出覆盖内部资料或保护材料，请选择资料库之外的位置');
      return exportNotes(this.store.snapshot(), p.path, p.note_id, p.overwrite);
    }
    if (method === 'note.rename.prepare') {
      const n = this.store.checked(p.note_id, p.expected_revision),
        title = name(p.title),
        sources = this.store.db
          .prepare('SELECT source_id FROM note_refs WHERE target_key=?')
          .all(key(n.title));
      const token = randomUUID();
      this.plans.set(token, { ...p, title, version: this.store.version });
      if (this.plans.size > 20) this.plans.delete(this.plans.keys().next().value!);
      return {
        plan_token: token,
        affected: sources.length,
        self: sources.some((r: any) => r.source_id === n.note_id),
        message: '将同步修改有效笔记中的引用（含自引用），回收站正文保持原文',
      };
    }
    await this.writable();
    if (method === 'note.rename') {
      const plan = this.plans.get(p.plan_token);
      if (!plan || plan.version !== this.store.version)
        fail('E_PLAN_STALE', '内容已变化，请重新预览改名影响');
      p = { note_id: plan.note_id, expected_revision: plan.expected_revision, title: plan.title };
    }
    const result = this.store.mutate(method, p, request.request_id, this.inject);
    this.statsCache = null;
    this.index.business_version = this.store.version;
    this.index.state = this.index.state === 'rebuilding' ? 'rebuilding' : 'updating';
    this.unavailable();
    this.worker?.postMessage({ kind: 'sync' });
    this.monitor();
    this.emitChange('commit');
    return result;
  }
  private async backup(directory: string, type: string) {
    if (inside(join(this.root, 'generations'), directory))
      fail('E_PATH', '备份须保存在业务资料和原始保全材料之外');
    mkdirSync(directory, { recursive: true });
    if (inside(realpathSync(join(this.root, 'generations')), realpathSync(directory)))
      fail('E_PATH', '备份目录不能指向业务资料或原始保全材料');
    const s = this.store!.snapshot(),
      record = await writeBackup(s, directory);
    const full = {
      ...record,
      user_id: s.profile.user_id,
      backup_type: type,
      status: 'success',
      completed_at: new Date().toISOString(),
      error_summary: null,
    };
    try {
      this.control!.prepare('INSERT INTO backups VALUES(?,?)').run(
        record.backup_id,
        JSON.stringify(full),
      );
      this.set('backup_directory', directory);
    } catch {
      return { ...full, registration_warning: true };
    }
    return full;
  }
  private async restore(p: any, requestId: string) {
    const requestHash = createHash('sha256').update(JSON.stringify(p)).digest('hex');
    const oldJob = this.control?.prepare('SELECT value FROM jobs WHERE id=?').get(requestId) as any;
    if (oldJob) {
      const previous = JSON.parse(oldJob.value);
      if (previous.request_hash !== requestHash)
        fail('E_INPUT', '同一恢复请求标识不能用于不同参数');
      return previous;
    }
    if (this.exclusive) fail('E_BUSY', '恢复正在执行');
    const inspected = this.inspected.get(p.inspect_token);
    if (!inspected) fail('E_PACKAGE', '请先选择并检查备份');
    if (inspected.epoch !== this.epoch || inspected.version !== (this.store?.version ?? null))
      fail('E_PLAN_STALE', '检查后资料已变化，请重新检查备份');
    this.exclusive = true;
    this.emitChange();
    const previous = { epoch: this.epoch, path: this.activePath },
      candidateEpoch = randomUUID(),
      candidatePath = join(this.root, 'generations', candidateEpoch, 'business.sqlite');
    let candidate: Store | null = null,
      switched = false;
    try {
      const verified = await readBackup(inspected.path);
      if (verified.packageHash !== inspected.packageHash)
        fail('E_PACKAGE_CHANGED', '检查后的备份已改变');
      let protective: any = null;
      if (this.store && !this.fault) {
        const directory = p.backup_directory || this.get('backup_directory');
        if (!directory) fail('E_PATH', '请选择恢复前保护备份目录');
        protective = await this.backup(directory, 'before_restore');
      }
      await this.stopIndexer();
      candidate = new Store(candidatePath, true);
      candidate.import(verified.snapshot);
      if (this.inject === 'restoreBuild') fail('E_TEST_FAILURE', '测试：恢复暂存失败');
      const indexPath = join(dirname(candidatePath), 'index-restored.sqlite');
      buildStandalone(candidatePath, indexPath, candidateEpoch);
      candidate.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      candidate.close();
      candidate = null;
      const probe = new Store(candidatePath);
      validateProbe(probe, verified.snapshot);
      const derived = new DatabaseSync(indexPath, { readOnly: true });
      try {
        const m = derived.prepare('SELECT * FROM meta').get() as any;
        const docs = Number((derived.prepare('SELECT COUNT(*) n FROM docs').get() as any).n),
          links = Number(
            (
              derived
                .prepare('SELECT COUNT(*) n FROM links WHERE target_id IS NOT NULL')
                .get() as any
            ).n,
          );
        if (
          m.epoch !== candidateEpoch ||
          m.version !== probe.version ||
          docs !== verified.snapshot.notes.filter((n) => !n.deleted_at).length ||
          links !== probe.linkCount()
        )
          fail('E_PACKAGE', '恢复索引与业务数据不一致');
      } finally {
        derived.close();
      }
      probe.close();
      if (!this.control || (this.fault && this.getSafeActive() === null)) {
        try {
          this.control?.close();
        } catch {}
        const file = `control-${randomUUID()}.sqlite`;
        this.control = new DatabaseSync(join(this.root, file));
        this.control.exec(
          'PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE backups(id TEXT PRIMARY KEY,value TEXT);CREATE TABLE jobs(id TEXT PRIMARY KEY,value TEXT)',
        );
        this.writePointer(file);
      }
      const result = {
        request_hash: requestHash,
        state: 'completed',
        epoch: candidateEpoch,
        active_path: candidatePath,
        original_path: previous.path || this.root,
        source_path: inspected.path,
        protective_backup: protective?.file_path ?? null,
        mode: this.fault ? 'fault' : 'normal',
      };
      if (this.inject === 'beforeSwitch') fail('E_TEST_FAILURE', '测试：切换前失败');
      this.control!.exec('BEGIN IMMEDIATE');
      try {
        this.set('active', { epoch: candidateEpoch, path: candidatePath, index: indexPath });
        this.control!.prepare('INSERT OR REPLACE INTO jobs VALUES(?,?)').run(
          requestId,
          JSON.stringify(result),
        );
        this.control!.exec('COMMIT');
        switched = true;
      } catch (e) {
        this.control!.exec('ROLLBACK');
        throw e;
      }
      try {
        this.store?.close();
      } catch {}
      this.epoch = candidateEpoch;
      this.activePath = candidatePath;
      this.store = new Store(candidatePath, true);
      this.statsCache = null;
      this.fault = null;
      this.index = { ...this.index, state: 'updating', indexed_version: -1, epoch: candidateEpoch };
      this.startIndexer();
      this.inspected.clear();
      this.emitChange('restore');
      return result;
    } catch (e) {
      try {
        candidate?.close();
      } catch {}
      if (switched) {
        this.fault = '恢复切换已提交，请重新启动以核实最终状态';
        this.store = null;
      } else if (this.store && !this.worker) this.startIndexer();
      throw e;
    } finally {
      this.exclusive = false;
      this.emitChange();
    }
  }
  private getSafeActive() {
    try {
      return this.get('active');
    } catch {
      return null;
    }
  }
  async close() {
    clearInterval(this.timer);
    clearTimeout(this.barrierTimer);
    await this.stopIndexer();
    try {
      this.store?.close();
    } catch {}
    try {
      this.control?.close();
    } catch {}
    try {
      this.lease.exec('ROLLBACK');
      this.lease.close();
    } catch {}
  }
}
function validateProbe(probe: Store, s: any) {
  const canonical = (value: any): string =>
    value && typeof value === 'object'
      ? Array.isArray(value)
        ? '[' + value.map(canonical).join(',') + ']'
        : '{' +
          Object.keys(value)
            .sort()
            .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
            .join(',') +
          '}'
      : JSON.stringify(value);
  if (probe.version !== s.business_version || canonical(probe.profile()) !== canonical(s.profile))
    fail('E_PACKAGE', '恢复档案或版本核对失败');
  const check = (table: string, fields: string[], values: any[], getId: (row: any) => string) => {
    const expected = new Map(values.map((row) => [getId(row), row]));
    let count = 0;
    for (const row of probe.db
      .prepare(`SELECT ${fields.join(',')} FROM ${table}`)
      .iterate() as any) {
      const original = expected.get(getId(row));
      if (!original || fields.some((k) => row[k] !== original[k]))
        fail('E_PACKAGE', '恢复字段核对失败');
      count++;
    }
    if (count !== values.length) fail('E_PACKAGE', '恢复数据数量核对失败');
  };
  check(
    'notes',
    [
      'note_id',
      'user_id',
      'title',
      'content',
      'revision',
      'created_at',
      'updated_at',
      'deleted_at',
    ],
    s.notes,
    (n) => n.note_id,
  );
  check('tags', ['tag_id', 'user_id', 'name', 'created_at', 'updated_at'], s.tags, (t) => t.tag_id);
  check(
    'note_tags',
    ['note_id', 'tag_id', 'created_at'],
    s.note_tags,
    (a) => a.note_id + ':' + a.tag_id,
  );
}
