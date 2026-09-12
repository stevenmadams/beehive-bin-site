"""Generate the round Beehive Bin Co. bin sticker.

Text is emitted as outlined glyph paths (Archivo Black, the site display face)
so the SVG needs no fonts installed at the print shop. Re-run after any copy
change:

    python3 assets/stickers/make-sticker.py
    rsvg-convert -w 1200 -h 1200 assets/stickers/bin-sticker-round.svg \
        -o assets/stickers/bin-sticker-round-1200.png
"""
import math, os, urllib.request
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

HERE = os.path.dirname(os.path.abspath(__file__))
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
# safety line sits near r=525 -- keep every glyph inside r=500.
PX_PER_IN = 1200 / 4.0945
R_OUTER = 600.0                         # yellow: bleed + visible rim after the cut
R_CUT   = 4.0 / 2 * PX_PER_IN           # ~586: where the printer cuts
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

def arc_text(text, center_deg, baseline_r, direction, size, track_em, color):
    """Lay `text` along a circular arc as outlined glyph paths.
    direction=+1 -> angle increases with reading order (top arc, glyphs face outward)
    direction=-1 -> angle decreases with reading order (bottom arc, glyphs face inward)
    Returns (svg, span_deg)."""
    gl = glyphs(text)
    em_width = sum(a for _, a in gl) + track_em * (len(gl) - 1)
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
    span = math.degrees(em_width * size / baseline_r)
    return f'<g fill="{color}">' + "".join(parts) + "</g>", span

# ---- icon: the brand hex, same geometry as assets/logo/beehive-icon.svg -------
# Drawn as one even-odd path so the bin shows the ink field through it.
ICON_D = ("M16 1.5 29 9v14L16 30.5 3 23V9z "
          "M9 10.6H23V13.2H21.47L20.3 21.5H11.7L10.53 13.2H9Z")
icon = (f'<path transform="translate({CX - 16*ICON_SCALE:.2f},{ICON_CY - 16*ICON_SCALE:.2f}) '
        f'scale({ICON_SCALE})" d="{ICON_D}" fill="{YELLOW}" fill-rule="evenodd"/>')

name_svg, name_span = arc_text(NAME, -90, NAME_R, +1, NAME_SIZE, 0.03, YELLOW)
fine_svg, fine_span = arc_text(FINE, 90, FINE_R, -1, FINE_SIZE, 0.06, WHITE)

hex_top = ICON_CY - 14.5 * ICON_SCALE
hex_bot = ICON_CY + 14.5 * ICON_SCALE
print(f"name arc {name_span:.0f}deg, baseline r={NAME_R:.0f}, caps to r=498")
print(f"fine arc {fine_span:.0f}deg, caps in to r={FINE_R - CAP*FINE_SIZE:.0f}")
print(f"hex {26*ICON_SCALE:.0f}w x {29*ICON_SCALE:.0f}h, top y={hex_top:.0f} "
      f"(name baseline y={CY - NAME_R:.0f}), bottom r={hex_bot - CY:.0f}")

svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200" width="1200" height="1200" role="img" aria-label="Beehive Bin Co. Property of Beehive Bin Co. If found please contact support@beehivebin.co">
<title>Beehive Bin Co. bin sticker</title>
<desc>Round die-cut sticker. Canvas 4.0945 in incl. bleed, cut at 4 in, 0.1 in yellow border. Text is outlined (no fonts required).</desc>
<circle cx="600" cy="600" r="{R_OUTER}" fill="{YELLOW}"/>
<circle cx="600" cy="600" r="{R_INK:.2f}" fill="{INK}"/>
{icon}
{name_svg}
{fine_svg}
</svg>
"""
open(OUT, "w").write(svg)
print("wrote", OUT, len(svg), "bytes")
