"""Developer-only PDF evidence check; PyMuPDF/Pillow are not application dependencies."""
import json
from pathlib import Path
from datetime import datetime, timezone
import pymupdf
from PIL import Image, ImageOps, ImageDraw

root = Path(__file__).resolve().parent.parent
source = root / "reports/数学公式与中文导出样例.pdf"
doc = pymupdf.open(source)
text = "\n".join(page.get_text() for page in doc)
checks = {
    "multipage": len(doc) >= 3,
    "chinese_body": "中文学习笔记" in text and "知识整理" in text,
    "chinese_in_formula": "中文说明" in text,
    "last_section": "第42节" in text,
    "code_stays_literal": "$$不渲染代码块$$" in text,
    "math_symbols": "∫" in text and "∑" in text,
    "no_replacement_characters": "\ufffd" not in text,
}
fonts = {}
overflow = []
thumbs = []
for number, page in enumerate(doc, 1):
    for font in page.get_fonts(full=True):
        xref = font[0]
        name, ext, kind, data = doc.extract_font(xref)
        fonts[xref] = {"name": name, "type": kind, "embedded_bytes": len(data)}
    for block in page.get_text("blocks"):
        x0, y0, x1, y1 = block[:4]
        if x0 < -1 or y0 < -1 or x1 > page.rect.width + 1 or y1 > page.rect.height + 1:
            overflow.append({"page": number, "bounds": list(block[:4])})
    pix = page.get_pixmap(matrix=pymupdf.Matrix(1.1, 1.1))
    picture = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
    if number in (1, len(doc)):
        picture.save(root / f"reports/数学公式-PDF{'首页' if number == 1 else '末页'}.png")
    picture.thumbnail((300, 425))
    thumb = Image.new("RGB", (320, 455), "#e5e5ea")
    thumb.paste(picture, ((320 - picture.width) // 2, 10))
    ImageDraw.Draw(thumb).text((12, 435), f"Page {number}", fill="black")
    thumbs.append(thumb)
checks["all_fonts_embedded"] = all(f["embedded_bytes"] > 0 for f in fonts.values())
checks["chinese_font_embedded"] = any("YaHei" in f["name"] for f in fonts.values())
checks["katex_fonts_embedded"] = any("KaTeX" in f["name"] for f in fonts.values())
checks["no_page_overflow"] = not overflow
montage = Image.new("RGB", (320 * 3, 455 * ((len(thumbs) + 2) // 3)), "white")
for i, thumb in enumerate(thumbs):
    montage.paste(thumb, (i % 3 * 320, i // 3 * 455))
montage.save(root / "reports/数学公式-PDF分页总览.png")
report = {"date": datetime.now(timezone.utc).isoformat(), "file": str(source),
          "tool": f"PyMuPDF {pymupdf.VersionBind}", "pages": len(doc), "checks": checks,
          "fonts": list(fonts.values()), "overflow": overflow, "pass": all(checks.values())}
(root / "reports/pdf-validation.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
print(json.dumps({"pages": len(doc), "checks": checks, "pass": report["pass"]}, indent=2))
assert report["pass"], "PDF evidence check failed"
