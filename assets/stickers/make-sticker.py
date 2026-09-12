"""Generate the round Beehive Bin Co. bin sticker.

Emits two files from one set of geometry:
  bin-sticker-round.svg          -- RGB vector, fine for screens and most web printers
  bin-sticker-round-pdfx1a.pdf   -- PDF/X-1a:2001, CMYK, trim + bleed boxes, SWOP intent

Text is emitted as outlined glyph paths (Archivo Black, the site display face)
so nothing depends on fonts at the print shop. Re-run after any copy change:

    python3 assets/stickers/make-sticker.py
"""
import datetime, hashlib, math, os, re, urllib.request, zlib
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, "ArchivoBlack.ttf")          # OFL, fetched on demand
FONT_URL = "https://fonts.gstatic.com/s/archivoblack/v23/HTxqL289NzCGg4MzN6KJ7eW6OYs.ttf"
OUT_SVG = os.path.join(HERE, "bin-sticker-round.svg")
OUT_PDF = os.path.join(HERE, "bin-sticker-round-pdfx1a.pdf")
ICC = os.path.join(HERE, "default_cmyk.icc")   # Artifex SWOP-style CMYK, AGPL

if not os.path.exists(FONT):
    urllib.request.urlretrieve(FONT_URL, FONT)

# Brand colours: hex for screen, process CMYK for print
YELLOW = ("#FFC400", (0.00, 0.23, 1.00, 0.00))
INK    = ("#15130F", (0.60, 0.40, 0.40, 1.00))   # rich black
WHITE  = ("#FFFFFF", (0.00, 0.00, 0.00, 0.00))

CX = CY = 600.0
# Canvas is 1200 px = 4.0945 in (4 in sticker + bleed). Printer cuts at 4 in,
# safety line sits near r=525 -- keep every glyph inside r=500.
CANVAS_IN = 4.0945
TRIM_IN = 4.0
PX_PER_IN = 1200 / CANVAS_IN
R_OUTER = 600.0                         # yellow: bleed + visible rim after the cut
R_CUT   = TRIM_IN / 2 * PX_PER_IN       # ~586: where the printer cuts
R_INK   = R_CUT - 0.10 * PX_PER_IN      # ~557: 0.1 in yellow border stays visible
CAP = 0.73                              # cap-height as fraction of em (Archivo Black)

# Wordmark arc over the icon (caps grow outward from the baseline)
NAME = "BEEHIVE BIN CO."
NAME_SIZE = 98.0
NAME_R = 498.0 - CAP * NAME_SIZE        # outermost glyph edge lands at r=498

# Fine print along the bottom (caps grow inward from the baseline)
FINE = "PROPERTY OF BEEHIVE BIN CO.  •  IF FOUND PLEASE CONTACT SUPPORT@BEEHIVEBIN.CO"
FINE_SIZE = 23.0
FINE_R = 498.0

# Icon: hex is 26 wide x 29 tall in a 32-unit box
ICON_SCALE = 21.0
ICON_CY = CY + 34.0
# Same geometry as assets/logo/beehive-icon.svg, one even-odd path so the bin
# shows the ink field through it. Absolute coordinates only.
ICON_D = ("M16 1.5 L29 9 L29 23 L16 30.5 L3 23 L3 9 Z "
          "M9 10.6 L23 10.6 L23 13.2 L21.47 13.2 L20.3 21.5 L11.7 21.5 L10.53 13.2 L9 13.2 Z")

font = TTFont(FONT)
upem = font["head"].unitsPerEm
gset = font.getGlyphSet()
cmap = font.getBestCmap()
hmtx = font["hmtx"]

def glyphs(text):
    out = []
    for ch in text:
        gn = cmap.get(ord(ch))
        if gn is None:
            raise SystemExit(f"missing glyph for {ch!r}")
        out.append((gn, hmtx[gn][0] / upem))   # advance in em
    return out

def path_for(gname):
    pen = SVGPathPen(gset)
    gset[gname].draw(pen)
    return pen.getCommands()

# A drawing is a list of shapes. Each shape is either
#   ("circle", colour, r)                                   centred on the canvas
#   ("path", colour, [(a,b,c,d,e,f) matrices...], d, evenodd) transforms outer->inner
def arc_text(text, center_deg, baseline_r, direction, size, track_em, colour):
    """Lay `text` along a circular arc as outlined glyph paths.
    direction=+1 -> angle increases with reading order (top arc, glyphs face outward)
    direction=-1 -> angle decreases with reading order (bottom arc, glyphs face inward)
    Returns (shapes, span_deg)."""
    gl = glyphs(text)
    em_width = sum(a for _, a in gl) + track_em * (len(gl) - 1)
    k = size / upem
    track = track_em * size

    shapes = []
    s = -(em_width * size) / 2.0          # arc-length offset from centre of the string
    for gname, adv_em in gl:
        adv = adv_em * size
        mid = s + adv / 2.0
        a = math.radians(center_deg) + direction * (mid / baseline_r)
        px = CX + baseline_r * math.cos(a)
        py = CY + baseline_r * math.sin(a)
        rot = math.degrees(a) + (90.0 if direction > 0 else -90.0)
        d = path_for(gname)
        if d.strip():
            shapes.append(("path", colour,
                           [("translate", px, py), ("rotate", rot),
                            ("translate", -adv / 2, 0), ("scale", k, -k)],
                           d, False))
        s += adv + track
    span = math.degrees(em_width * size / baseline_r)
    return shapes, span

name_shapes, name_span = arc_text(NAME, -90, NAME_R, +1, NAME_SIZE, 0.03, YELLOW)
fine_shapes, fine_span = arc_text(FINE, 90, FINE_R, -1, FINE_SIZE, 0.06, WHITE)

shapes = [
    ("circle", YELLOW, R_OUTER),
    ("circle", INK, R_INK),
    ("path", YELLOW,
     [("translate", CX - 16 * ICON_SCALE, ICON_CY - 16 * ICON_SCALE), ("scale", ICON_SCALE, ICON_SCALE)],
     ICON_D, True),
    *name_shapes,
    *fine_shapes,
]

hex_top = ICON_CY - 14.5 * ICON_SCALE
hex_bot = ICON_CY + 14.5 * ICON_SCALE
print(f"name arc {name_span:.0f}deg, baseline r={NAME_R:.0f}, caps to r=498")
print(f"fine arc {fine_span:.0f}deg, caps in to r={FINE_R - CAP*FINE_SIZE:.0f}")
print(f"hex {26*ICON_SCALE:.0f}w x {29*ICON_SCALE:.0f}h, top y={hex_top:.0f} "
      f"(name baseline y={CY - NAME_R:.0f}), bottom r={hex_bot - CY:.0f}")

# ---- SVG --------------------------------------------------------------------
def svg_transform(ops):
    out = []
    for op in ops:
        if op[0] == "translate": out.append(f"translate({op[1]:.3f},{op[2]:.3f})")
        elif op[0] == "rotate":  out.append(f"rotate({op[1]:.4f})")
        elif op[0] == "scale":   out.append(f"scale({op[1]:.6f},{op[2]:.6f})")
    return " ".join(out)

body = []
for sh in shapes:
    if sh[0] == "circle":
        body.append(f'<circle cx="600" cy="600" r="{sh[2]:.2f}" fill="{sh[1][0]}"/>')
    else:
        _, colour, ops, d, evenodd = sh
        fr = ' fill-rule="evenodd"' if evenodd else ""
        body.append(f'<path transform="{svg_transform(ops)}" d="{d}" fill="{colour[0]}"{fr}/>')

svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200" width="1200" height="1200" role="img" aria-label="Beehive Bin Co. Property of Beehive Bin Co. If found please contact support@beehivebin.co">
<title>Beehive Bin Co. bin sticker</title>
<desc>Round die-cut sticker. Canvas 4.0945 in incl. bleed, cut at 4 in, 0.1 in yellow border. Text is outlined (no fonts required).</desc>
{chr(10).join(body)}
</svg>
"""
open(OUT_SVG, "w").write(svg)
print("wrote", OUT_SVG, len(svg), "bytes")

# ---- PDF/X-1a:2001 -----------------------------------------------------------
# Written by hand: the artwork is only CMYK fills and Bezier paths, so a
# PDF 1.3 file with DeviceCMYK, no transparency, an embedded output-intent
# profile and Trim/Bleed boxes is all the standard asks for.
_tok = re.compile(r"[MLHVCQZ]|-?\d*\.?\d+(?:e-?\d+)?")

def svg_path_to_pdf(d):
    """Absolute M/L/H/V/C/Q/Z (what SVGPathPen and ICON_D emit) -> PDF operators.
    Quadratics are lifted to cubics."""
    toks = _tok.findall(d)
    i, cmd, out = 0, None, []
    x = y = sx = sy = 0.0
    def num():
        nonlocal i
        v = float(toks[i]); i += 1; return v
    while i < len(toks):
        if toks[i].isalpha():
            cmd = toks[i]; i += 1
            if cmd == "Z":
                out.append("h"); x, y = sx, sy; continue
        if cmd == "M":
            x, y = num(), num(); sx, sy = x, y; out.append(f"{x:.3f} {y:.3f} m"); cmd = "L"
        elif cmd == "L":
            x, y = num(), num(); out.append(f"{x:.3f} {y:.3f} l")
        elif cmd == "H":
            x = num(); out.append(f"{x:.3f} {y:.3f} l")
        elif cmd == "V":
            y = num(); out.append(f"{x:.3f} {y:.3f} l")
        elif cmd == "C":
            x1, y1, x2, y2, x, y = (num() for _ in range(6))
            out.append(f"{x1:.3f} {y1:.3f} {x2:.3f} {y2:.3f} {x:.3f} {y:.3f} c")
        elif cmd == "Q":
            qx, qy, nx, ny = num(), num(), num(), num()
            x1, y1 = x + 2/3 * (qx - x), y + 2/3 * (qy - y)
            x2, y2 = nx + 2/3 * (qx - nx), ny + 2/3 * (qy - ny)
            out.append(f"{x1:.3f} {y1:.3f} {x2:.3f} {y2:.3f} {nx:.3f} {ny:.3f} c")
            x, y = nx, ny
        else:
            raise SystemExit(f"unhandled path command {cmd!r}")
    return "\n".join(out)

def circle_pdf(cx, cy, r):
    k = 0.5522847498 * r
    return "\n".join([
        f"{cx+r:.3f} {cy:.3f} m",
        f"{cx+r:.3f} {cy+k:.3f} {cx+k:.3f} {cy+r:.3f} {cx:.3f} {cy+r:.3f} c",
        f"{cx-k:.3f} {cy+r:.3f} {cx-r:.3f} {cy+k:.3f} {cx-r:.3f} {cy:.3f} c",
        f"{cx-r:.3f} {cy-k:.3f} {cx-k:.3f} {cy-r:.3f} {cx:.3f} {cy-r:.3f} c",
        f"{cx+k:.3f} {cy-r:.3f} {cx+r:.3f} {cy-k:.3f} {cx+r:.3f} {cy:.3f} c",
        "h"])

PT = 72.0
page_pt = CANVAS_IN * PT
trim_off = (CANVAS_IN - TRIM_IN) / 2 * PT
px_to_pt = page_pt / 1200.0

content = [f"{px_to_pt:.6f} 0 0 {-px_to_pt:.6f} 0 {page_pt:.3f} cm"]   # draw in SVG px, y-down
for sh in shapes:
    c = sh[1][1]
    content.append(f"{c[0]} {c[1]} {c[2]} {c[3]} k")
    if sh[0] == "circle":
        content.append(circle_pdf(CX, CY, sh[2])); content.append("f")
    else:
        _, _, ops, d, evenodd = sh
        content.append("q")
        for op in ops:
            if op[0] == "translate":
                content.append(f"1 0 0 1 {op[1]:.4f} {op[2]:.4f} cm")
            elif op[0] == "rotate":
                a = math.radians(op[1]); ca, sa = math.cos(a), math.sin(a)
                content.append(f"{ca:.6f} {sa:.6f} {-sa:.6f} {ca:.6f} 0 0 cm")
            elif op[0] == "scale":
                content.append(f"{op[1]:.6f} 0 0 {op[2]:.6f} 0 0 cm")
        content.append(svg_path_to_pdf(d))
        content.append("f*" if evenodd else "f")
        content.append("Q")
stream = zlib.compress("\n".join(content).encode("ascii"), 9)
icc_bytes = open(ICC, "rb").read()

now = datetime.datetime.now().astimezone()
pdf_date = now.strftime("D:%Y%m%d%H%M%S") + now.strftime("%z")[:3] + "'" + now.strftime("%z")[3:] + "'"
objs = [
    b"<< /Type /Catalog /Pages 2 0 R /OutputIntents [6 0 R] >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    (f"<< /Type /Page /Parent 2 0 R"
     f" /MediaBox [0 0 {page_pt:.3f} {page_pt:.3f}]"
     f" /BleedBox [0 0 {page_pt:.3f} {page_pt:.3f}]"
     f" /TrimBox [{trim_off:.3f} {trim_off:.3f} {page_pt-trim_off:.3f} {page_pt-trim_off:.3f}]"
     f" /Resources << /ProcSet [/PDF] >> /Contents 4 0 R >>").encode(),
    b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(stream) + stream + b"\nendstream",
    (f"<< /Title (Beehive Bin Co. bin sticker) /Creator (assets/stickers/make-sticker.py)"
     f" /Producer (make-sticker.py) /CreationDate ({pdf_date}) /ModDate ({pdf_date})"
     f" /Trapped /False /GTS_PDFXVersion (PDF/X-1a:2001) >>").encode(),
    (b"<< /Type /OutputIntent /S /GTS_PDFX"
     b" /OutputCondition (SWOP \\(Publication\\) printing)"
     b" /OutputConditionIdentifier (CGATS TR 001) /RegistryName (http://www.color.org)"
     b" /Info (Artifex CMYK SWOP profile) /DestOutputProfile 7 0 R >>"),
    b"<< /N 4 /Length %d >>\nstream\n" % len(icc_bytes) + icc_bytes + b"\nendstream",
]
out = bytearray(b"%PDF-1.3\n%\xe2\xe3\xcf\xd3\n")
offsets = []
for n, body in enumerate(objs, 1):
    offsets.append(len(out))
    out += b"%d 0 obj\n" % n + body + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
for o in offsets:
    out += b"%010d 00000 n \n" % o
fid = hashlib.md5(bytes(out)).hexdigest().encode()
out += (b"trailer\n<< /Size %d /Root 1 0 R /Info 5 0 R /ID [<%s> <%s>] >>\n"
        b"startxref\n%d\n%%%%EOF\n" % (len(objs) + 1, fid, fid, xref))
open(OUT_PDF, "wb").write(out)
print("wrote", OUT_PDF, len(out), "bytes")
