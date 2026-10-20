import { z } from 'zod';

export const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((s) => s.toLowerCase());
export const appearanceSchema = z
  .object({
    accent: colorSchema,
    background: z.enum(['default', 'solid', 'image']),
    background_color: colorSchema,
    strength: z.number().int().min(0).max(100),
  })
  .strict();
export type Appearance = z.infer<typeof appearanceSchema>;
export type AppearanceView = Appearance & { image_data: string | null; warning?: string };
export const DEFAULT_APPEARANCE: Appearance = {
  accent: '#0066cc',
  background: 'default',
  background_color: '#e7edf5',
  strength: 35,
};
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (v: number[]) =>
  '#' + v.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
export function luminance(color: string) {
  return rgb(color)
    .map((x) => {
      const n = x / 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
export function appearanceColors(value: string) {
  const raw = colorSchema.parse(value);
  const on = (c: string) => (luminance(c) > 0.179 ? '#000000' : '#ffffff');
  let text = rgb(raw);
  // Colored text remains readable on the white content surfaces, including pale custom colors.
  while (1.05 / (luminance(hex(text)) + 0.05) < 6) text = text.map((x) => Math.floor(x * 0.9));
  const hover = hex(rgb(raw).map((x) => x * 0.88));
  return {
    fill: raw,
    text: hex(text),
    hover,
    on: on(raw),
    onHover: on(hover),
    selection: hex(rgb(raw).map((x) => 255 * 0.9 + x * 0.1)),
  };
}
export function backgroundStyle(a: AppearanceView): Record<string, string> {
  return {
    '--background-color': a.background === 'solid' ? a.background_color : '#f5f5f7',
    '--background-image':
      a.background === 'image' && a.image_data ? `url("${a.image_data}")` : 'none',
    '--background-strength': a.background === 'default' ? '0' : String(a.strength / 100),
  };
}
