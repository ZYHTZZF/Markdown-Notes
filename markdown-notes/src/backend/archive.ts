import { productivitySchema, validateProductivity } from '../shared/productivity';
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  renameSync,
  unlinkSync,
  existsSync,
  openSync,
  fsyncSync,
  closeSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import * as yauzl from 'yauzl';
import { ZipFile } from 'yazl';
import { Tokenizer, TokenParser, TokenType } from '@streamparser/json';
import { z } from 'zod';
import { validateSnapshot, fail, LIMITS, bytes, name } from '../shared/rules';
import type { Snapshot } from '../shared/types';

export const digest = async (file: string) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
export function inside(parent: string, child: string) {
  const p = resolve(parent).toLowerCase(),
    c = resolve(child).toLowerCase();
  return c === p || c.startsWith(p + sep);
}
function publish(temp: string, target: string, overwrite = false) {
  if (existsSync(target) && !overwrite) fail('E_PATH', '目标文件已存在，请重新选择');
  const fd = openSync(temp, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
}
const id = z.string().uuid(),
  time = z.string().datetime(),
  version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pref = z
  .object({
    ...productivitySchema.shape,
    font_size: z.number().int().min(12).max(24).optional(),
    mode: z.enum(['edit', 'split', 'read']).optional(),
  })
  .strict();
const profile = z
  .object({
    user_id: id,
    display_name: z
      .string()
      .refine((s) => s.isWellFormed() && [...s].length >= 1 && [...s].length <= 50),
    created_at: time,
    updated_at: time,
    preferences: pref,
  })
  .strict();
const note = z
  .object({
    note_id: id,
    user_id: id,
    title: z.string(),
    content: z.string(),
    revision: version,
    created_at: time,
    updated_at: time,
    deleted_at: time.nullable(),
  })
  .strict();
const tag = z
  .object({ tag_id: id, user_id: id, name: z.string(), created_at: time, updated_at: time })
  .strict();
const association = z.object({ note_id: id, tag_id: id, created_at: time }).strict();
const manifestSchema = z
  .object({
    format_version: z.union([z.literal(1), z.literal(2)]),
    backup_id: id,
    snapshot_at: time,
    note_count: version,
    data_size_bytes: version,
    checksum_algorithm: z.literal('SHA-256'),
    data_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Streaming token parsing with duplicate-key checks, bounded per-entity assembly. */
async function parseData(stream: NodeJS.ReadableStream, collect: boolean) {
  const tokenizer = new Tokenizer({ stringBufferSize: 65536, emitPartialTokens: true }),
    parser = new TokenParser({
      paths: [
        '$.schema_version',
        '$.business_version',
        '$.profile',
        '$.notes.*',
        '$.tags.*',
        '$.note_tags.*',
      ],
      keepStack: false,
    });
  const result: any = { notes: [], tags: [], note_tags: [] },
    top = new Set<string>();
  let totalBytes = 0,
    noteCount = 0,
    tagCount = 0,
    assocCount = 0;
  const stack: { object: boolean; expectKey: boolean; keys: Set<string> }[] = [];
  let rootKey: string | null = null,
    rootValue = false;
  tokenizer.onToken = (t: any) => {
    if (typeof t.value === 'string' && bytes(t.value) > LIMITS.body)
      fail('E_CAPACITY', '备份单个文本字段超过1 MiB');
    if (t.partial) return;
    const current = stack.at(-1);
    if (!stack.length && t.token !== TokenType.LEFT_BRACE)
      fail('E_PACKAGE', '备份根节点必须为对象');
    if (stack.length === 1 && rootValue) {
      const expected = ['notes', 'tags', 'note_tags'].includes(rootKey!)
        ? TokenType.LEFT_BRACKET
        : rootKey === 'profile'
          ? TokenType.LEFT_BRACE
          : TokenType.NUMBER;
      if (t.token !== expected) fail('E_PACKAGE', '备份顶层字段类型错误');
      rootValue = false;
      rootKey = null;
    }
    if (t.token === TokenType.STRING && current?.object && current.expectKey) {
      if (current.keys.has(t.value)) fail('E_PACKAGE', 'JSON含有重复字段');
      current.keys.add(t.value);
      if (stack.length === 1) {
        top.add(t.value);
        rootKey = t.value;
      }
      current.expectKey = false;
    }
    if (t.token === TokenType.COLON && stack.length === 1) rootValue = true;
    if (t.token === TokenType.LEFT_BRACE)
      stack.push({ object: true, expectKey: true, keys: new Set() });
    else if (t.token === TokenType.LEFT_BRACKET)
      stack.push({ object: false, expectKey: false, keys: new Set() });
    else if (t.token === TokenType.RIGHT_BRACE || t.token === TokenType.RIGHT_BRACKET) stack.pop();
    else if (t.token === TokenType.COMMA && current?.object) current.expectKey = true;
    if (stack.length > 24) fail('E_PACKAGE', '备份结构嵌套异常');
    parser.write(t);
  };
  parser.onValue = ({ value, key, stack }: any) => {
    if (stack.length === 1) {
      if (key === 'profile') result.profile = profile.parse(value);
      else result[key] = value;
      return;
    }
    const parent = stack[1]?.key;
    if (parent === 'notes') {
      const n = note.parse(value);
      name(n.title);
      totalBytes += bytes(n.content);
      if (++noteCount > LIMITS.notes || bytes(n.content) > LIMITS.body || totalBytes > LIMITS.total)
        fail('E_CAPACITY', '备份正文或笔记数量超过容量');
      if (collect) result.notes.push(n);
    } else if (parent === 'tags') {
      const t = tag.parse(value);
      name(t.name, 'tag');
      if (++tagCount > LIMITS.tags) fail('E_CAPACITY', '备份标签超过容量');
      if (collect) result.tags.push(t);
    } else if (parent === 'note_tags') {
      const a = association.parse(value);
      if (++assocCount > LIMITS.notes * 20) fail('E_CAPACITY', '标签关联超过容量');
      if (collect) result.note_tags.push(a);
    }
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const hash = createHash('sha256');
  let length = 0,
    crc = 0;
  for await (const chunk of stream as any) {
    const b = Buffer.from(chunk);
    length += b.length;
    crc = crc32(b, crc);
    hash.update(b);
    decoder.decode(b, { stream: true });
    tokenizer.write(b);
  }
  decoder.decode();
  if (!tokenizer.isEnded) tokenizer.end();
  if (!parser.isEnded) parser.end();
  const allowed = ['schema_version', 'business_version', 'profile', 'notes', 'tags', 'note_tags'];
  if (
    top.size !== 6 ||
    allowed.some((k) => !top.has(k)) ||
    result.schema_version !== 1 ||
    !version.safeParse(result.business_version).success ||
    !result.profile
  )
    fail('E_PACKAGE', '备份顶层格式不完整或版本不兼容');
  return { snapshot: result as Snapshot, hash: hash.digest('hex'), length, noteCount, crc };
}

export async function readBackup(file: string) {
  const zip = await new Promise<yauzl.ZipFile>((res, rej) =>
    yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (e, z) =>
      e ? rej(e) : res(z!),
    ),
  );
  const entries: Record<string, yauzl.Entry> = {};
  try {
    await new Promise<void>((res, rej) => {
      zip.on('entry', (entry) => {
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (
          !['manifest.json', 'data.json'].includes(entry.fileName) ||
          entries[entry.fileName] ||
          (mode !== 0 && mode !== 0x8000) ||
          entry.generalPurposeBitFlag & 1
        )
          return rej(new Error('备份含额外、重复或不安全条目'));
        entries[entry.fileName] = entry;
        zip.readEntry();
      });
      zip.once('end', res);
      zip.once('error', rej);
      zip.readEntry();
    });
    if (Object.keys(entries).length !== 2)
      fail('E_PACKAGE', '完整备份必须且仅包含manifest.json和data.json');
    const open = (entry: yauzl.Entry) =>
      new Promise<NodeJS.ReadableStream>((res, rej) =>
        zip.openReadStream(entry, (e, s) => (e ? rej(e) : res(s!))),
      );
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const part of (await open(entries['manifest.json'])) as any) {
      size += part.length;
      if (size > 65536) fail('E_PACKAGE', '清单过大');
      chunks.push(part);
    }
    // Also detect duplicates in the small manifest before normal parsing.
    const manifestBytes = Buffer.concat(chunks);
    if (crc32(manifestBytes) !== entries['manifest.json'].crc32)
      fail('E_PACKAGE', '清单CRC校验失败');
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes);
    const seen = new Set();
    const tok = new Tokenizer();
    let depth = 0,
      wantKey = false;
    tok.onToken = (t: any) => {
      if (t.token === 0) {
        depth++;
        wantKey = true;
      } else if (t.token === 1) depth--;
      else if (t.token === 5 && depth === 1) wantKey = true;
      else if (t.token === 9 && depth === 1 && wantKey) {
        if (seen.has(t.value)) fail('E_PACKAGE', '清单字段重复');
        seen.add(t.value);
        wantKey = false;
      }
    };
    tok.write(raw);
    if (!tok.isEnded) tok.end();
    const manifest = manifestSchema.parse(JSON.parse(raw));
    const parsed = await parseData(await open(entries['data.json']), true);
    if (
      parsed.crc !== entries['data.json'].crc32 ||
      parsed.length !== manifest.data_size_bytes ||
      parsed.hash !== manifest.data_sha256 ||
      parsed.noteCount !== manifest.note_count
    )
      fail('E_PACKAGE', '备份摘要、CRC、长度或数量不一致');
    if (
      manifest.format_version === 1 &&
      ['favorites', 'pinned', 'templates'].some((k) => k in parsed.snapshot.profile.preferences)
    )
      fail('E_VERSION', '旧备份格式不能声明新版元数据');
    validateSnapshot(parsed.snapshot);
    validateProductivity(
      parsed.snapshot.profile.preferences,
      new Set(parsed.snapshot.notes.map((n) => n.note_id)),
    );
    return { snapshot: parsed.snapshot, manifest, packageHash: await digest(file) };
  } finally {
    zip.close();
  }
}

async function* snapshotChunks(s: Snapshot) {
  yield Buffer.from(
    `{"schema_version":1,"business_version":${s.business_version},"profile":${JSON.stringify(s.profile)},`,
  );
  for (const field of ['notes', 'tags', 'note_tags'] as const) {
    yield Buffer.from(`"${field}":[`);
    let first = true;
    for (const item of s[field]) {
      yield Buffer.from((first ? '' : ',') + JSON.stringify(item));
      first = false;
    }
    yield Buffer.from(field === 'note_tags' ? ']}' : '],');
  }
}

export async function writeBackup(s: Snapshot, directory: string) {
  validateSnapshot(s);
  validateProductivity(s.profile.preferences, new Set(s.notes.map((n) => n.note_id)));
  mkdirSync(directory, { recursive: true });
  const backup_id = randomUUID(),
    snapshot_at = new Date().toISOString(),
    target = join(
      directory,
      `知页备份-${snapshot_at.replace(/[:.]/g, '-')}-${backup_id.slice(0, 8)}.zip`,
    ),
    temp = target + '.partial';
  const hash = createHash('sha256');
  let data_size_bytes = 0;
  for await (const b of snapshotChunks(s)) {
    hash.update(b);
    data_size_bytes += b.length;
  }
  const manifest = {
    format_version: 2,
    backup_id,
    snapshot_at,
    note_count: s.notes.length,
    data_size_bytes,
    checksum_algorithm: 'SHA-256',
    data_sha256: hash.digest('hex'),
  };
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json');
  zip.addReadStream(Readable.from(snapshotChunks(s)), 'data.json');
  zip.end();
  try {
    await pipeline(zip.outputStream, createWriteStream(temp, { flags: 'wx' }));
    await readBackup(temp);
    publish(temp, target);
    return {
      ...manifest,
      file_path: target,
      file_size: statSync(target).size,
      checksum: await digest(target),
    };
  } catch (e) {
    if (existsSync(temp)) unlinkSync(temp);
    throw e;
  }
}
export async function exportNotes(s: Snapshot, target: string, noteId?: string, overwrite = false) {
  const temp = target + '.' + randomUUID() + '.partial';
  mkdirSync(dirname(target), { recursive: true });
  try {
    if (noteId) {
      const n = s.notes.find((n) => n.note_id === noteId && !n.deleted_at);
      if (!n) fail('E_NOT_FOUND', '笔记不存在');
      await pipeline(
        Readable.from([Buffer.from(n.content, 'utf8')]),
        createWriteStream(temp, { flags: 'wx' }),
      );
    } else {
      const notes = s.notes.filter((n) => !n.deleted_at),
        zip = new ZipFile();
      for (const n of notes) zip.addBuffer(Buffer.from(n.content), `notes/${n.note_id}.md`);
      const metadata = {
        export_format_version: 1,
        snapshot_at: new Date().toISOString(),
        notes: notes.map((n) => ({
          note_id: n.note_id,
          title: n.title,
          favorite: ((s.profile.preferences.favorites as string[]) ?? []).includes(n.note_id),
          pinned: ((s.profile.preferences.pinned as string[]) ?? []).includes(n.note_id),
          tag_names: s.note_tags
            .filter((a) => a.note_id === n.note_id)
            .map((a) => s.tags.find((t) => t.tag_id === a.tag_id)!.name),
          created_at: n.created_at,
          updated_at: n.updated_at,
          file_name: `notes/${n.note_id}.md`,
        })),
      };
      zip.addBuffer(Buffer.from(JSON.stringify(metadata, null, 2)), 'metadata.json');
      zip.end();
      await pipeline(zip.outputStream, createWriteStream(temp, { flags: 'wx' }));
    }
    publish(temp, target, overwrite);
    return { file_path: target, file_size: statSync(target).size };
  } catch (e) {
    if (existsSync(temp)) unlinkSync(temp);
    throw e;
  }
}
