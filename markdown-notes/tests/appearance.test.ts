import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appearanceColors,
  appearanceSchema,
  DEFAULT_APPEARANCE,
  backgroundStyle,
  luminance,
} from '../src/shared/appearance';

test('任意主色生成可读的按钮与链接，包括极浅、极深和灰色', () => {
  for (const r of [0, 51, 102, 153, 204, 255])
    for (const g of [0, 85, 170, 255])
      for (const b of [0, 85, 170, 255]) {
        const c = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
        const p = appearanceColors(c);
        const ratio = (a: string, b: string) =>
          (Math.max(luminance(a), luminance(b)) + 0.05) /
          (Math.min(luminance(a), luminance(b)) + 0.05);
        assert(ratio(p.fill, p.on) >= 4.5, c);
        assert(ratio(p.hover, p.onHover) >= 4.5, c + ' hover');
        assert(ratio(p.text, '#ffffff') >= 6, c + ' link');
        assert(ratio(p.text, '#e6e6e6') >= 4.5, c + ' background link');
      }
});

test('外观输入只接受受限颜色、背景类别与强度，不接收任意路径或CSS', () => {
  for (const patch of [
    { accent: 'red' },
    { accent: '#fff' },
    { strength: 101 },
    { strength: -1 },
    { strength: 0.5 },
    { background: 'url(https://example.com)' },
    { path: 'C:/private.txt' },
  ])
    assert.equal(appearanceSchema.safeParse({ ...DEFAULT_APPEARANCE, ...patch }).success, false);
  assert.equal(
    backgroundStyle({ ...DEFAULT_APPEARANCE, image_data: null })['--background-strength'],
    '0',
  );
  assert.equal(
    backgroundStyle({ ...DEFAULT_APPEARANCE, background: 'solid', image_data: null })[
      '--background-image'
    ],
    'none',
  );
});
