"""
Generate the two seed packet images used as MindAR image targets.

MindAR tracks the natural features of an image: corners, edges and texture patches it can
recognise again from a new angle. Plain colours, simple shapes and repeating patterns give it
nothing to lock onto, and detail repeated across an image is as bad as no detail, because the
tracker cannot tell which copy it is looking at.

Generating the cards makes feature density a design decision rather than luck. Every choice below
exists for tracking reasons:

  asymmetric layout        a symmetric card can lock in two orientations
  seeded irregular scatter detail that never repeats, unlike a grid or halftone
  mixed type sizes         features survive at several viewing distances
  dense fine print         small high-contrast glyph edges, cheap and very effective
  no large flat areas      flat regions contribute nothing
  two different palettes   the two cards do not resemble each other

It also removes any licence question, since the result is original work.

Requires Pillow. Run from the app folder:  python tools/make_markers.py

Then compile the PNG into targets/targets.mind with the MindAR compiler:
https://hiukim.github.io/mind-ar-js-doc/tools/compile
"""

import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1000, 1400
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "targets")

FONT_CANDIDATES = [
    "C:/Windows/Fonts/georgiab.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/segoeuib.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
FONT_CANDIDATES_REG = [
    "C:/Windows/Fonts/georgia.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def load_font(size, bold=True):
    for path in (FONT_CANDIDATES if bold else FONT_CANDIDATES_REG):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


# One card. A paddy card was generated and printed too, and was dropped on 6 September 2026: the
# paddy model read badly standing on a card, and paddy is already the crop the markerless field is
# made of, so each mode now shows a different crop. Adding a card back means adding an entry here,
# recompiling targets.mind, and listing its crop id in CARD_CROP_IDS in marker.html, in the same
# order the images went into the compiler.
CARDS = [
    {
        "file": "marker-b.png",
        "name": "PINEAPPLE",
        "latin": "Ananas comosus",
        "spacing": "45 cm",
        "seed": 7734,
        "bg": (238, 228, 199),
        "ink": (36, 38, 22),
        "accent": (196, 92, 30),
        "leaf": (46, 96, 74),
        "leaf2": (96, 143, 84),
        "blades": 15,
        "blade_kind": "broad",
        "notes": [
            "Plant suckers or crowns, not seed.",
            "Row spacing 60 cm. Plant to plant 45 cm.",
            "Set crowns 8 cm deep in free draining soil.",
            "First fruit 16 to 22 months after planting.",
            "Avoid waterlogging. Full sun preferred.",
            "Lot 2026-04-B. Packed for the 2026 Maha season.",
        ],
    },
]


def rough_polygon(draw, cx, cy, radius, points, rng, fill, jitter=0.34):
    """An irregular blob. Irregular matters: a circle gives the tracker one repeated curve."""
    pts = []
    for i in range(points):
        angle = (i / points) * math.tau + rng.uniform(-0.12, 0.12)
        r = radius * (1.0 + rng.uniform(-jitter, jitter))
        pts.append((cx + math.cos(angle) * r, cy + math.sin(angle) * r))
    draw.polygon(pts, fill=fill)


def draw_plant(draw, card, rng):
    """A stylised plant built from irregular tapered blades radiating from a base."""
    cx, cy = 470, 800
    broad = card["blade_kind"] == "broad"

    for i in range(card["blades"]):
        # Spread across the upper half, deliberately not evenly spaced.
        t = i / max(1, card["blades"] - 1)
        angle = math.radians(-172 + t * 164) + rng.uniform(-0.09, 0.09)

        length = rng.uniform(150, 330) * (1.15 if broad else 1.0)
        width = rng.uniform(26, 52) if broad else rng.uniform(9, 20)

        tip_x = cx + math.cos(angle) * length
        tip_y = cy + math.sin(angle) * length

        # Bend the blade so no two are the same curve.
        bend = rng.uniform(-0.5, 0.5)
        mid_x = cx + math.cos(angle + bend * 0.4) * length * 0.55
        mid_y = cy + math.sin(angle + bend * 0.4) * length * 0.55

        perp = angle + math.pi / 2
        ox, oy = math.cos(perp) * width, math.sin(perp) * width

        colour = card["leaf"] if i % 2 else card["leaf2"]
        draw.polygon(
            [
                (cx - ox * 0.4, cy - oy * 0.4),
                (mid_x - ox, mid_y - oy),
                (tip_x, tip_y),
                (mid_x + ox, mid_y + oy),
                (cx + ox * 0.4, cy + oy * 0.4),
            ],
            fill=colour,
        )

    rough_polygon(draw, cx, cy + 18, 62, 9, rng, card["leaf"])


def scatter_seeds(draw, card, rng, keep_out):
    """
    Irregular seed shapes at varied sizes, spread over the whole card.

    Two rules that matter for tracking. Never a grid, because repeated identical detail leaves
    the tracker unable to tell which copy it is looking at. And cover the flat regions, because
    a large empty area means tracking drops the moment the camera frames only that part of the
    card.
    """
    def blocked(x, y, pad=14):
        for (x0, y0, x1, y1) in keep_out:
            if x0 - pad < x < x1 + pad and y0 - pad < y < y1 + pad:
                return True
        return False

    placed = 0
    attempts = 0
    while placed < 260 and attempts < 6000:
        attempts += 1
        x = rng.uniform(30, W - 30)
        y = rng.uniform(170, H - 26)
        if blocked(x, y):
            continue
        r = rng.uniform(3, 12)
        shade = rng.choice([card["accent"], card["leaf"], card["leaf2"], card["ink"]])
        rough_polygon(draw, x, y, r, rng.randint(5, 8), rng, shade, jitter=0.45)
        placed += 1


def side_strip(img, draw, card, rng, f_small):
    """A printed spine down the left edge. Strong continuous contrast on an otherwise bare side."""
    draw.rectangle([0, 150, 56, H], fill=card["ink"])

    for i in range(46):
        y = 180 + i * 26 + rng.randint(-4, 4)
        w = rng.choice([14, 22, 30, 38])
        draw.line([8, y, 8 + w, y], fill=card["accent"] if i % 3 else card["bg"], width=2)

    strip = Image.new("RGB", (520, 40), card["ink"])
    ImageDraw.Draw(strip).text(
        (6, 8), "GOVIYA SEED CO.  " + card["latin"].upper(), font=f_small, fill=card["bg"])
    img.paste(strip.rotate(90, expand=True), (8, 760))


def inset_panel(draw, card, rng, f_small):
    """A seed detail box, which fills the dead area left of the spacing badge."""
    x0, y0, x1, y1 = 96, 408, 596, 596
    draw.rectangle([x0, y0, x1, y1], outline=card["ink"], width=4)
    draw.rectangle([x0, y0, x1, y0 + 40], fill=card["ink"])
    draw.text((x0 + 14, y0 + 8), "SEED DETAIL, ACTUAL SIZE", font=f_small, fill=card["bg"])

    for i in range(16):
        cx = x0 + 34 + (i % 8) * 58 + rng.randint(-7, 7)
        cy = y0 + 80 + (i // 8) * 52 + rng.randint(-7, 7)
        rough_polygon(draw, cx, cy, rng.uniform(9, 17), rng.randint(6, 9), rng,
                      card["accent"] if i % 3 else card["leaf"], jitter=0.5)

    draw.text((x0 + 14, y1 - 34), "Purity 98.4 percent   Germination 92 percent",
              font=f_small, fill=card["ink"])


def corner_stamp(draw, card, rng, f_small):
    """An overprinted batch stamp. Deliberately rotated and off the grid."""
    cx, cy = 838, 812
    for r, w in ((92, 6), (78, 3)):
        pts = []
        for i in range(28):
            a = (i / 28) * math.tau
            rr = r * (1.0 + rng.uniform(-0.035, 0.035))
            pts.append((cx + math.cos(a) * rr, cy + math.sin(a) * rr))
        draw.line(pts + [pts[0]], fill=card["accent"], width=w)

    draw.text((cx - 62, cy - 30), "PASSED", font=f_small, fill=card["accent"])
    draw.text((cx - 52, cy - 4), "QC 041", font=f_small, fill=card["accent"])
    draw.text((cx - 66, cy + 22), "2026 MAHA", font=f_small, fill=card["accent"])


def build(card):
    rng = random.Random(card["seed"])
    img = Image.new("RGB", (W, H), card["bg"])
    draw = ImageDraw.Draw(img)

    # Background tone variation. Flat areas are dead weight for a tracker.
    noise = Image.new("L", (W // 4, H // 4))
    noise.putdata([rng.randint(108, 148) for _ in range(noise.width * noise.height)])
    noise = noise.resize((W, H), Image.BICUBIC).filter(ImageFilter.GaussianBlur(2))
    img = Image.blend(img, Image.merge("RGB", (noise, noise, noise)), 0.06)
    draw = ImageDraw.Draw(img)

    f_brand = load_font(34)
    f_title = load_font(96)
    f_latin = load_font(40, bold=False)
    f_badge = load_font(62)
    f_badge_s = load_font(26, bold=False)
    f_note = load_font(25, bold=False)
    f_small = load_font(20, bold=False)

    # Header. Offset from centre on purpose, so the card is not symmetric.
    draw.rectangle([0, 0, W, 150], fill=card["ink"])
    draw.text((84, 40), "GOVIYA SEED CO.", font=f_brand, fill=card["bg"])
    draw.text((84, 92), "CERTIFIED PLANTING STOCK", font=f_small, fill=card["accent"])
    rough_polygon(draw, 872, 75, 46, 11, rng, card["accent"])

    side_strip(img, draw, card, rng, f_small)

    draw.text((84, 196), card["name"], font=f_title, fill=card["ink"])
    draw.text((90, 306), card["latin"], font=f_latin, fill=card["accent"])
    draw.line([84, 372, 946, 372], fill=card["ink"], width=5)

    # Artwork first, then the printed panels over the top of it. Overlap is deliberate: a leaf
    # running behind a label is how real packaging is laid out, and the resulting edges are
    # extra features rather than a problem.
    draw_plant(draw, card, rng)

    inset_panel(draw, card, rng, f_small)

    # Spacing badge, hard against the right edge to break symmetry further.
    bx, by = 654, 408
    draw.rectangle([bx, by, bx + 292, by + 172], fill=card["ink"])
    draw.text((bx + 26, by + 20), "SPACE", font=f_badge_s, fill=card["accent"])
    draw.text((bx + 24, by + 54), card["spacing"], font=f_badge, fill=card["bg"])
    draw.text((bx + 26, by + 130), "PLANT TO PLANT", font=f_small, fill=card["bg"])

    corner_stamp(draw, card, rng, f_small)

    # A ruler strip. Ticks are uneven in height, which keeps them from reading as a pattern.
    ry = 968
    draw.line([84, ry, 946, ry], fill=card["ink"], width=4)
    for i in range(29):
        x = 84 + i * 30.8
        h = 26 if i % 5 == 0 else rng.randint(9, 15)
        draw.line([x, ry, x, ry - h], fill=card["ink"], width=3 if i % 5 == 0 else 2)
        if i % 5 == 0:
            draw.text((x - 6, ry + 8), str(i), font=f_small, fill=card["ink"])

    # Fine print. The densest source of trackable features on the whole card.
    y = 1082
    for line in card["notes"]:
        draw.text((96, y), line, font=f_note, fill=card["ink"])
        y += 38

    draw.text((96, H - 62), "Keep dry. Store below 25 C.", font=f_small, fill=card["accent"])
    draw.text((640, H - 62), "INTE 42312 demo card", font=f_small, fill=card["accent"])

    # Scatter last, so it fills whatever is still bare without covering any text.
    keep_out = [
        (0, 0, W, 152),            # header
        (0, 150, 60, H),           # spine
        (80, 180, 700, 380),       # title block
        (92, 404, 600, 600),       # inset panel
        (650, 404, 950, 584),      # badge
        (250, 560, 800, 900),      # plant
        (740, 714, 936, 910),      # stamp
        (80, 930, 950, 1010),      # ruler
        (88, 1070, 950, 1330),     # fine print
        (88, H - 74, 950, H - 30),  # footer
    ]
    scatter_seeds(draw, card, rng, keep_out)

    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    for card in CARDS:
        img = build(card)
        path = os.path.join(OUT_DIR, card["file"])
        img.save(path, "PNG", optimize=True)
        print("wrote {}  {}x{}  ({:,} bytes)".format(path, img.width, img.height,
                                                     os.path.getsize(path)))

    print("\nNext: compile the image at the MindAR compiler.")
    print("https://hiukim.github.io/mind-ar-js-doc/tools/compile")
    print("Save the result as targets/targets.mind")


if __name__ == "__main__":
    main()
