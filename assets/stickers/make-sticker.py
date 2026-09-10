import math, re, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

SCRATCH = "/private/tmp/claude-501/-Users-stevenadams-Development-bin-rental/35474d19-c49c-472b-b0fb-bbb8d29ae203/scratchpad"
REPO = "/Users/stevenadams/Development/bin_rental"

INK    = "#15130F"
YELLOW = "#FFC400"
WHITE  = "#FFFFFF"

CX = CY = 600.0
R_OUTER = 600.0
R_INK   = 582.0     # ink disc inside the yellow rim
R_RING_KEYLINE = 452.0
R_WHITE = 444.0
TEXT_OUTER = 548.0  # outer edge both text arcs align to
CAP = 0.73          # cap-height as fraction of em (Archivo Black)

font = TTFont(f"{SCRATCH}/ArchivoBlack.ttf")
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

def arc_text(text, center_deg, span_deg, baseline_r, direction, track_em=0.06, color=YELLOW):
    """Lay `text` along a circular arc as outlined glyph paths.
    direction=+1 -> angle increases with reading order (top arc, glyphs face outward)
    direction=-1 -> angle decreases with reading order (bottom arc, glyphs face inward)"""
    gl = glyphs(text)
    em_width = sum(a for _, a in gl) + track_em * (len(gl) - 1)
    target_arc = math.radians(span_deg) * baseline_r
    size = target_arc / em_width
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

# ---- centre logo: reuse the real stacked lockup ------------------------------
raw = open(f"{REPO}/assets/logo/beehive-stacked.svg").read()
inner = re.sub(r"^.*?<title>.*?</title>", "", raw, flags=re.S).replace("</svg>", "")
LOGO_W, LOGO_H = 514.0, 355.0
target_w = 640.0
sc = target_w / LOGO_W
logo = (f'<g transform="translate({CX - target_w/2:.2f},{CY - LOGO_H*sc/2:.2f}) '
        f'scale({sc:.6f})">{inner}</g>')

# ---- ring text ---------------------------------------------------------------
TOP = "PROPERTY OF BEEHIVE BIN CO."
BOTTOM = "IF FOUND PLEASE CONTACT SUPPORT@BEEHIVEBIN.CO"

TOP_SPAN, BOT_SPAN = 132.0, 150.0
# solve baseline radius for the top arc (its caps grow outward from the baseline)
size_guess = 64.0
for _ in range(6):
    r_top = TEXT_OUTER - CAP * size_guess
    _, size_guess = arc_text(TOP, -90, TOP_SPAN, r_top, +1)
top_svg, top_size = arc_text(TOP, -90, TOP_SPAN, r_top, +1)
bot_svg, bot_size = arc_text(BOTTOM, 90, BOT_SPAN, TEXT_OUTER, -1, track_em=0.05)

print(f"top size {top_size:.1f}px  baseline r {r_top:.1f}")
print(f"bottom size {bot_size:.1f}px  cap reaches r {TEXT_OUTER - CAP*bot_size:.1f}")

hex_r = 33.0
hex_ring_r = TEXT_OUTER - 0.5 * CAP * max(top_size, bot_size)
seps = (hexagon(CX + hex_ring_r, CY, hex_r, YELLOW)
        + hexagon(CX - hex_ring_r, CY, hex_r, YELLOW))

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200" width="1200" height="1200" role="img" aria-label="Property of Beehive Bin Co. If found please contact support@beehivebin.co">
<title>Beehive Bin Co. — bin asset sticker</title>
<desc>Round 4 in / 102 mm die-cut sticker. Ring text is outlined (no fonts required).</desc>
<circle cx="600" cy="600" r="{R_OUTER}" fill="{YELLOW}"/>
<circle cx="600" cy="600" r="{R_INK}" fill="{INK}"/>
<circle cx="600" cy="600" r="{R_RING_KEYLINE}" fill="{YELLOW}"/>
<circle cx="600" cy="600" r="{R_WHITE}" fill="{WHITE}"/>
{top_svg}
{bot_svg}
{seps}
{logo}
</svg>
'''
open(f"{SCRATCH}/sticker.svg", "w").write(svg)
print("wrote sticker.svg", len(svg), "bytes")
