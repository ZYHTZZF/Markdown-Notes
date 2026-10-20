"""Audit the real PDFs exported by appearance.spec.ts (developer-only dependencies)."""
from pathlib import Path
from datetime import datetime, timezone
import json
import pymupdf
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
results = {}
thumbs = []
for label, filename in [('background', '外观导出-带背景.pdf'), ('plain', '外观导出-无背景.pdf')]:
    doc = pymupdf.open(root / 'reports' / filename)
    pages = []
    for number, page in enumerate(doc, 1):
        pix = page.get_pixmap()
        color = list(pix.pixel(int(page.rect.width / 2), int(page.rect.height - 80)))
        text = page.get_text()
        fonts = [doc.extract_font(font[0]) for font in page.get_fonts()]
        pages.append({'page': number, 'sample_rgb': color, 'text_present': bool(text.strip()),
                      'no_replacement': '\ufffd' not in text,
                      'fonts_embedded': all(len(f[3]) > 0 for f in fonts)})
        image = Image.frombytes('RGB', [pix.width, pix.height], pix.samples)
        if number == 1:
            image.save(root / 'reports' / f'外观导出-{label}.png')
        image.thumbnail((290, 410))
        tile = Image.new('RGB', (310, 440), '#e5e5ea')
        tile.paste(image, ((310-image.width)//2, 5))
        ImageDraw.Draw(tile).text((10, 420), f'{label} - Page {number}', fill='black')
        thumbs.append(tile)
    joined = ''.join(p.get_text() for p in doc)
    results[label] = {'pages': pages, 'page_count': len(doc),
                      'chinese_body': '中文笔记与公式' in joined, 'chinese_formula': '中文说明' in joined,
                      'last_section': '第18段' in joined}

checks = {
    'both_multipage': all(r['page_count'] >= 2 for r in results.values()),
    'matching_page_counts': results['background']['page_count'] == results['plain']['page_count'],
    'background_on_every_page': all(min(p['sample_rgb']) < 252 for p in results['background']['pages']),
    'plain_pages_are_white': all(p['sample_rgb'] == [255,255,255] for p in results['plain']['pages']),
    'chinese_and_last_section': all(r['chinese_body'] and r['chinese_formula'] and r['last_section'] for r in results.values()),
    'all_fonts_and_text': all(p['text_present'] and p['no_replacement'] and p['fonts_embedded'] for r in results.values() for p in r['pages']),
}
canvas = Image.new('RGB', (310*len(thumbs), 440), 'white')
for number, tile in enumerate(thumbs):
    canvas.paste(tile, (number*310, 0))
canvas.save(root / 'reports/外观导出-对比.png')
report = {'date': datetime.now(timezone.utc).isoformat(), 'tool': f'PyMuPDF {pymupdf.VersionBind}',
          'checks': checks, 'documents': results, 'pass': all(checks.values())}
(root / 'reports/appearance-pdf-validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'checks': checks, 'pass': report['pass']}, indent=2))
assert report['pass']
