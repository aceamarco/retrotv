#!/usr/bin/env python3
"""Turn generated TV images (solid green background, solid magenta screen) into
frame PNGs with a transparent screen, and write frames.json.

Put images in frames/src/ named <id>.png|jpg|jpeg (e.g. 1950s.jpeg), then
run:  python3 frames/build_frames.py
"""
import glob, json, os, re
from collections import deque
from PIL import Image, ImageFilter, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
NAMES = {"1950s": "1950s console", "1960s": "1960s wood console", "1970s": "1970s space-age portable",
         "1980s": "1980s tabletop", "1990s": "1990s CRT", "2000s": "2000s flat CRT"}
MAX_W = 1400
# Minimum saturation for spill suppression. Low by default so faint green casts on
# grey/cream/silver cabinets get neutralised; higher where the set really is green.
SPILL_SAT = {"1950s": 0.24}   # sage Predicta housing

def hsv(R, G, B):
    mx = max(R, G, B); mn = min(R, G, B); c = mx - mn
    if c == 0: return 0.0, 0.0
    if mx == G: hue = 60 * ((B - R) / c) + 120
    elif mx == R: hue = (60 * ((G - B) / c)) % 360
    else: hue = 60 * ((R - G) / c) + 240
    return hue, c / mx

def backdrop_hue(im):
    """Median hue of the saturated pixels in a ring just inside the border.
    Gemini's green renders anywhere from hue 120 to 132 depending on the image."""
    im = im.convert("RGB"); W, H = im.size; px = im.load(); hues = []
    ring = [(x, y) for x in range(4, W - 4, 3) for y in (4, H - 5)] + [(x, y) for y in range(4, H - 4, 3) for x in (4, W - 5)]
    for x, y in ring:
        h, sat = hsv(*px[x, y])
        if sat > 0.4 and 90 <= h <= 160: hues.append(h)
    hues.sort()
    return hues[len(hues) // 2] if hues else 125.0

def classify(im):
    """Return (green_mask, magenta_mask) as 'L' images from HSV-ish rules that
    survive JPEG artifacts."""
    im = im.convert("RGB")
    r, g, b = [ch.point(lambda v: v) for ch in im.split()]
    px = im.load(); W, H = im.size
    green = Image.new("L", im.size, 0); mag = Image.new("L", im.size, 0)
    gp, mp = green.load(), mag.load()
    bg = backdrop_hue(im); lo, hi = bg - 8, bg + 8
    for y in range(H):
        for x in range(W):
            R, G, B = px[x, y]
            hue, sat = hsv(R, G, B)
            # Backdrop: within 8 degrees of the measured border hue at any brightness
            # (vignetted corners, shadow pockets). Green reflections on the set drift
            # toward yellow-green, so they survive and get spill-suppressed instead.
            if lo <= hue <= hi and sat > 0.45 and G > 60:
                gp[x, y] = 255
            elif 285 <= hue <= 315 and sat > 0.6 and R > 120 and B > 120:
                mp[x, y] = 255
    return green, mag

def flood_from_border(mask):
    """Keep only the mask pixels connected to the image border."""
    W, H = mask.size; m = mask.load()
    out = Image.new("L", mask.size, 0); o = out.load()
    seen = bytearray(W * H); q = deque()
    for x in range(W):
        for y in (0, H - 1):
            if m[x, y] and not seen[y * W + x]: seen[y * W + x] = 1; q.append((x, y))
    for y in range(H):
        for x in (0, W - 1):
            if m[x, y] and not seen[y * W + x]: seen[y * W + x] = 1; q.append((x, y))
    while q:
        x, y = q.popleft(); o[x, y] = 255
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < W and 0 <= ny < H and m[nx, ny] and not seen[ny * W + nx]:
                seen[ny * W + nx] = 1; q.append((nx, ny))
    return out

def largest_component_bbox(mask):
    W, H = mask.size; m = mask.load(); seen = bytearray(W * H); best = None
    for sy in range(0, H, 4):
        for sx in range(0, W, 4):
            if m[sx, sy] and not seen[sy * W + sx]:
                q = deque([(sx, sy)]); seen[sy * W + sx] = 1; n = 0
                x0 = x1 = sx; y0 = y1 = sy
                while q:
                    x, y = q.popleft(); n += 1
                    x0, x1, y0, y1 = min(x0, x), max(x1, x), min(y0, y), max(y1, y)
                    for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                        if 0 <= nx < W and 0 <= ny < H and m[nx, ny] and not seen[ny * W + nx]:
                            seen[ny * W + nx] = 1; q.append((nx, ny))
                if best is None or n > best[0]: best = (n, x0, y0, x1, y1)
    return best[1:] if best else None

def build(path):
    fid = re.sub(r"\.(png|jpe?g)$", "", os.path.basename(path), flags=re.I)
    im = Image.open(path).convert("RGBA")
    if im.width > 2400: im = im.resize((2400, int(im.height * 2400 / im.width)), Image.LANCZOS)
    green, mag = classify(im)
    print(f"{os.path.basename(path)}: backdrop hue {backdrop_hue(im):.0f}")
    # No border flood-fill: pockets of background enclosed by the set (under a
    # swivel tube, between legs) must go too. The prompt forbids green paint on the set.
    # clean up JPEG fringe: small close/open, then feather
    green = green.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    mag = mag.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(5))   # grow 1px into the bezel so no magenta halo
    bbox = largest_component_bbox(mag)
    if not bbox: raise SystemExit(f"{path}: no magenta screen found")
    alpha = ImageChops.subtract(Image.new("L", im.size, 255), ImageChops.lighter(green, mag))
    # close thin keyed gaps (a glossy stem top reflecting pure backdrop green)
    alpha = alpha.filter(ImageFilter.MaxFilter(11)).filter(ImageFilter.MinFilter(11))
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.8))
    # spill suppression: any opaque pixel tinted toward the backdrop hue (glossy
    # stems, cabinet tops reflecting the green) gets its green clamped. The sets
    # themselves carry no green within 20 degrees of the backdrop hue.
    bg = backdrop_hue(im); px = im.load(); ap = alpha.load()
    W, H = im.size
    sat_gate = SPILL_SAT.get(fid, 0.08)
    for y in range(H):
        for x in range(W):
            if not ap[x, y]: continue
            R, G, B, A = px[x, y]
            m = max(R, B)
            if G > m:
                hue, sat = hsv(R, G, B)
                # reflections drift toward yellow-green as they mix with cream/tan
                # surfaces, so the window is wider on that side; the saturation gate
                # keeps a set's own muted green paint (sage, olive) untouched.
                if bg - 38 <= hue <= bg + 22 and sat > sat_gate:
                    px[x, y] = (R, m, B, A)
    im.putalpha(alpha)
    # trim transparent margins (but keep the bottom edge if the set runs off the image)
    trim = im.getbbox()
    im = im.crop(trim)
    bx0, by0, bx1, by1 = bbox[0] - trim[0], bbox[1] - trim[1], bbox[2] - trim[0], bbox[3] - trim[1]
    W, H = im.size
    if W > MAX_W: im = im.resize((MAX_W, int(H * MAX_W / W)), Image.LANCZOS)
    out = os.path.join(HERE, fid + ".png")
    im.save(out, optimize=True)
    screen = {"left": round(bx0 / W * 100, 2), "top": round(by0 / H * 100, 2),
              "width": round((bx1 - bx0) / W * 100, 2), "height": round((by1 - by0) / H * 100, 2)}
    print(f"{fid}: {im.size} screen {screen} ({(bx1-bx0)/(by1-by0):.2f}:1)")
    return {"id": fid, "name": NAMES.get(fid, fid), "src": f"frames/{fid}.png", "aspect": round(W / H, 4),
            "screen": screen, "credit": "Generated with Gemini"}

generated = {}
for p in sorted(glob.glob(os.path.join(HERE, "src", "*"))):
    if re.search(r"\.(png|jpe?g)$", p, re.I):
        f = build(p); generated[f["id"]] = f
order = ["1950s", "1960s", "1970s", "1980s", "1990s", "2000s"]
ids = order + [i for i in generated if i not in order]
frames = [generated[i] for i in ids if i in generated]
json.dump(frames, open(os.path.join(HERE, "frames.json"), "w"), indent=1)
print("frames.json:", [f["id"] for f in frames])
