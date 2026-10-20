import { nativeImage } from 'electron';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  appearanceSchema,
  DEFAULT_APPEARANCE,
  type Appearance,
  type AppearanceView,
} from './shared/appearance';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
function imageSize(data: Buffer) {
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.toString('ascii', 12, 16) === 'IHDR'
  )
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data[0] === 0xff && data[1] === 0xd8) {
    let pos = 2;
    while (pos + 4 < data.length) {
      if (data[pos++] !== 0xff) break;
      while (data[pos] === 0xff) pos++;
      const marker = data[pos++];
      if (marker === 0xda || marker === 0xd9) break;
      const length = data.readUInt16BE(pos);
      if (length < 2 || pos + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8)
        return { width: data.readUInt16BE(pos + 5), height: data.readUInt16BE(pos + 3) };
      pos += length;
    }
  }
  throw new Error('请选择有效的PNG或JPEG图片');
}
export class AppearanceStore {
  private config: Appearance = { ...DEFAULT_APPEARANCE };
  private imageFile: string | null = null;
  private warning: string | undefined;
  constructor(private directory: string) {
    mkdirSync(directory, { recursive: true });
    const file = join(directory, 'appearance.json');
    if (!existsSync(file)) return;
    try {
      if (statSync(file).size > 4096) throw new Error();
      const { image_file, ...settings } = JSON.parse(readFileSync(file, 'utf8'));
      this.config = appearanceSchema.parse(settings);
      if (image_file != null && !/^background-[0-9a-f-]{36}\.png$/.test(image_file))
        throw new Error();
      this.imageFile = image_file ?? null;
      if (this.config.background === 'image' && !this.imageData()) throw new Error();
    } catch {
      this.config = { ...DEFAULT_APPEARANCE };
      this.imageFile = null;
      this.warning = '本机外观设置或背景图片损坏，已使用默认外观，原文件已保留。';
    }
  }
  private imageData() {
    if (!this.imageFile) return null;
    const path = join(this.directory, this.imageFile);
    if (statSync(path).size > MAX_IMAGE_BYTES * 2) throw new Error('背景文件过大');
    const bytes = readFileSync(path);
    imageSize(bytes);
    return 'data:image/png;base64,' + bytes.toString('base64');
  }
  get(): AppearanceView {
    let data: string | null = null;
    try {
      data = this.imageData();
    } catch {
      this.warning = '本机背景图片不可用，请重新选择图片。';
    }
    return {
      ...this.config,
      background: this.config.background === 'image' && !data ? 'default' : this.config.background,
      image_data: data,
      ...(this.warning ? { warning: this.warning } : {}),
    };
  }
  set(input: unknown) {
    const next = appearanceSchema.parse(input);
    if (next.background === 'image' && !this.imageData()) throw new Error('请先选择背景图片');
    return this.publish(next, this.imageFile);
  }
  private publish(next: Appearance, imageFile: string | null) {
    const file = join(this.directory, 'appearance.json'),
      temp = file + '.' + randomUUID() + '.partial';
    try {
      writeFileSync(temp, JSON.stringify({ ...next, image_file: imageFile }), { flag: 'wx' });
      renameSync(temp, file);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
    this.config = next;
    this.imageFile = imageFile;
    this.warning = undefined;
    return this.get();
  }
  selectImage(path: string) {
    if (statSync(path).size > MAX_IMAGE_BYTES) throw new Error('背景图片不能超过8 MiB');
    const data = readFileSync(path),
      size = imageSize(data);
    if (
      !size.width ||
      !size.height ||
      size.width > 8192 ||
      size.height > 8192 ||
      size.width * size.height > 20_000_000
    )
      throw new Error('图片尺寸须在8192像素以内，且总像素不超过2000万');
    let image = nativeImage.createFromBuffer(data);
    if (image.isEmpty()) throw new Error('图片解码失败，请选择其他PNG或JPEG');
    const scale = Math.min(1, 2560 / size.width, 2560 / size.height);
    if (scale < 1)
      image = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'best',
      });
    const name = 'background-' + randomUUID() + '.png',
      file = join(this.directory, name),
      previous = this.imageFile;
    let normalized = image.toPNG();
    if (normalized.length > MAX_IMAGE_BYTES * 2) {
      image = image.resize({
        width: Math.max(1, Math.round(image.getSize().width / 2)),
        height: Math.max(1, Math.round(image.getSize().height / 2)),
        quality: 'best',
      });
      normalized = image.toPNG();
    }
    if (normalized.length > MAX_IMAGE_BYTES * 2)
      throw new Error('转换后的图片过大，请选择其他图片');
    writeFileSync(file, normalized, { flag: 'wx' });
    try {
      const result = this.publish({ ...this.config, background: 'image' }, name);
      if (previous) {
        try {
          unlinkSync(join(this.directory, previous));
        } catch {}
      }
      return result;
    } catch (error) {
      unlinkSync(file);
      throw error;
    }
  }
  reset() {
    const old = this.imageFile;
    const result = this.publish({ ...DEFAULT_APPEARANCE }, null);
    if (old) {
      try {
        unlinkSync(join(this.directory, old));
      } catch {}
    }
    return result;
  }
}
