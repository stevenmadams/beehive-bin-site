"""Generate the round "Property of Beehive Bin Co." bin sticker.

Ring text is emitted as outlined glyph paths (Archivo Black, the site display
face) so the SVG needs no fonts installed at the print shop. Re-run after any
copy change:

    python3 assets/stickers/make-sticker.py
    rsvg-convert -w 1200 -h 1200 assets/stickers/bin-sticker-round.svg \
        -o assets/stickers/bin-sticker-round-1200.png
"""
import math, os, re, urllib.request
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
FONT = os.path.join(HERE, "ArchivoBlack.ttf")          # OFL, fetched on demand
FONT_URL = "https://fonts.gstatic.com/s/archivoblack/v23/HTxqL289NzCGg4MzN6KJ7eW6OYs.ttf"
OUT = os.path.join(HERE, "bin-sticker-round.svg")

if not os.path.exists(FONT):
    urllib.request.urlretrieve(FONT_URL, FONT)

INK    = "#15130F"
YELLOW = "#FFC400"
WHITE  = "#FFFFFF"

CX = CY = 600.0
# Canvas is 1200 px = 4.0945 in (4 in sticker + bleed). Printer cuts at 4 in,
# safety line sits near r=525 -- keep every glyph inside r=495.
PX_PER_IN = 1200 / 4.0945
R_OUTER = 600.0                         # yellow: bleed + visible rim after the cut
R_CUT   = 4.0 / 2 * PX_PER_IN           # ~586: where the printer cuts
R_INK   = R_CUT - 0.10 * PX_PER_IN      # ~557: 0.1 in yellow border stays visible
R_WHITE = R_INK - 0.14 * PX_PER_IN      # ~516: ink frame band
FINE_OUTER_R = 492.0  # baseline of the outer fine-print arc (caps grow inward)
FINE_INNER_R = 458.0
FINE_SIZE = 24.0
CAP = 0.73          # cap-height as fraction of em (Archivo Black)

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

def arc_text(text, center_deg, span_deg, baseline_r, direction, track_em=0.06, color=YELLOW, size=None):
    """Lay `text` along a circular arc as outlined glyph paths.
    direction=+1 -> angle increases with reading order (top arc, glyphs face outward)
    direction=-1 -> angle decreases with reading order (bottom arc, glyphs face inward)"""
    gl = glyphs(text)
    em_width = sum(a for _, a in gl) + track_em * (len(gl) - 1)
    if size is None:
        size = math.radians(span_deg) * baseline_r / em_width
    k = size / upem
    track = track_em * size

    parts = []
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
            parts.append(
                f'<g transform="translate({px:.3f},{py:.3f}) rotate({rot:.4f}) '
                f'translate({-adv/2:.3f},0) scale({k:.6f},{-k:.6f})">'
                f'<path d="{d}"/></g>'
            )
        s += adv + track
    return f'<g fill="{color}">' + "".join(parts) + "</g>", size

def hexagon(cx, cy, r, fill):
    pts = []
    for i in range(6):
        ang = math.radians(-90 + i * 60)     # pointy top, matches the brand mark
        pts.append(f"{cx + r*math.cos(ang):.2f},{cy + r*math.sin(ang):.2f}")
    return f'<polygon points="{" ".join(pts)}" fill="{fill}"/>'

# ---- centre logo: reuse the real stacked lockup, scaled up as the focal point
raw = open(os.path.join(REPO, "assets", "logo", "beehive-stacked.svg")).read()
inner = re.sub(r"^.*?<title>.*?</title>", "", raw, flags=re.S).replace("</svg>", "")
LOGO_W, LOGO_H = 514.0, 355.0
target_w = 750.0
sc = target_w / LOGO_W
logo_cy = CY + 6.0    # optically centred above the fine-print footer
logo = (f'<g transform="translate({CX - target_w/2:.2f},{logo_cy - LOGO_H*sc/2:.2f}) '
        f'scale({sc:.6f})">{inner}</g>')

# ---- fine print: two short arcs under the logo, ink on white -----------------
LINE1 = "PROPERTY OF BEEHIVE BIN CO."
LINE2 = "IF FOUND PLEASE CONTACT SUPPORT@BEEHIVEBIN.CO"
# LINE1 sits on the inner (upper) arc, LINE2 on the outer (lower) arc
line1_svg, _ = arc_text(LINE1, 90, 0, FINE_INNER_R, -1, track_em=0.08, color=INK, size=FINE_SIZE)
line2_svg, _ = arc_text(LINE2, 90, 0, FINE_OUTER_R, -1, track_em=0.06, color=INK, size=FINE_SIZE)

def span_deg(text, r, track_em):
    gl = glyphs(text)
    w = (sum(a for _, a in gl) + track_em * (len(gl) - 1)) * FINE_SIZE
    return math.degrees(w / r)
print(f"fine print: line1 {span_deg(LINE1, FINE_INNER_R, 0.08):.0f}deg, "
      f"line2 {span_deg(LINE2, FINE_OUTER_R, 0.06):.0f}deg, "
      f"outermost glyph r={FINE_OUTER_R:.0f}, logo corner r="
      f"{math.hypot(target_w/2, LOGO_H*sc/2 + (logo_cy - CY)):.0f}")

svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200" width="1200" height="1200" role="img" aria-label="Beehive Bin Co. Property of Beehive Bin Co. If found please contact support@beehivebin.co">
<title>Beehive Bin Co. bin sticker</title>
<desc>Round die-cut sticker. Canvas 4.0945 in incl. bleed, cut at 4 in, 0.1 in yellow border. Text is outlined (no fonts required).</desc>
<circle cx="600" cy="600" r="{R_OUTER}" fill="{YELLOW}"/>
<circle cx="600" cy="600" r="{R_INK}" fill="{INK}"/>
<circle cx="600" cy="600" r="{R_WHITE}" fill="{WHITE}"/>
{logo}
{line1_svg}
{line2_svg}
</svg>
"""
open(OUT, "w").write(svg)
print("wrote", OUT, len(svg), "bytes")
