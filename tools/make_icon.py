# Renders the AlCal app icons: embossed seal-red wordmark on black pebbled leather.
# Needs logo900.ttf (the 'AlCal Logo' font from index.html, instanced at wght 900 / wdth 87.5) beside it.
# Run: python3 make_icon.py  -> icon-512/192/180.png
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as nd
import sys

S = 2048                       # supersampled canvas
INK = np.array([125, 50, 43]) / 255.0   # seal ink
BG = np.array([16, 14, 14]) / 255.0
rng = np.random.default_rng(7)

# ---------- wordmark mask ----------
font = ImageFont.truetype('logo900.ttf', 620)
text = 'AlCal'
track = -0.045 * 620
widths = [font.getlength(c) for c in text]
total = sum(widths) + track * (len(text) - 1)
m = Image.new('L', (S, int(S / 1.08)), 0)
d = ImageDraw.Draw(m)
asc, desc = font.getmetrics()
x = (S - total) / 2
ybase = m.height / 2 + 0.36 * 620          # visually centre cap height
for c, w in zip(text, widths):
    d.text((x, ybase), c, font=font, fill=255, anchor='ls')
    x += w + track
m = m.resize((S, S), Image.LANCZOS)           # scaleY 1.08
mask = np.asarray(m, dtype=np.float32) / 255.0
# match old icon: wordmark spans ~75% width
ys, xs = np.where(mask > .5)
w0 = xs.max() - xs.min()
k = 0.75 * S / w0
cx, cy = (xs.max() + xs.min()) / 2, (ys.max() + ys.min()) / 2
mask = nd.affine_transform(mask, [1 / k, 1 / k], offset=[cy - S / 2 / k, cx - S / 2 / k], order=1)

# ---------- leather grain height ----------
def pebbles(n, r):
    pts = np.zeros((S, S), bool)
    pts[rng.integers(0, S, n), rng.integers(0, S, n)] = True
    dist, idx = nd.distance_transform_edt(~pts, return_indices=True)
    # second-nearest approximation via cell boundaries: creases where label changes
    lab = idx[0] * S + idx[1]
    edge = (np.diff(lab, axis=0, prepend=lab[:1]) != 0) | (np.diff(lab, axis=1, prepend=lab[:, :1]) != 0)
    de = nd.distance_transform_edt(~edge)
    h = 1 - np.exp(-de / r)                   # domed pebble, deep crease at border
    return h

def noise(sigma, amp):
    return nd.gaussian_filter(rng.standard_normal((S, S)), sigma) * amp

grain = pebbles(26000, 3.2) * 1.0 + pebbles(5000, 9) * 0.6
grain = (grain - grain.mean()) / grain.std()
grain += noise(1.2, 0.9) / noise(1.2, 1).std() * 0.35
wrinkles = noise(40, 1)
wrinkles = wrinkles / wrinkles.std()
grain += 0.25 * wrinkles

# ---------- emboss height ----------
soft = nd.gaussian_filter(mask, 7)
bevel = np.clip(nd.gaussian_filter(mask, 14) * 1.6 - 0.3, 0, 1) * mask
H = 34 * (0.55 * soft + 0.45 * bevel) + grain * (0.9 - 0.55 * mask)

def shade(H):
    gy, gx = np.gradient(H)
    n = np.stack([-gx, -gy, np.ones_like(H)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    L = np.array([-0.55, -0.62, 0.56]); L /= np.linalg.norm(L)
    diff = np.clip((n * L).sum(-1), 0, 1)
    Hv = L + np.array([0, 0, 1.0]); Hv /= np.linalg.norm(Hv)
    spec = np.clip((n * Hv).sum(-1), 0, 1) ** 38
    return diff, spec

diff, spec = shade(H)
flat = shade(np.zeros((4, 4)))[0][0, 0]
lum = diff / flat

# cast shadow of raised letters
sh = nd.shift(nd.gaussian_filter(mask, 10), (14, 11), order=1)
shadow = 1 - 0.55 * np.clip(sh - mask, 0, 1)

# colour: leather + ink with slight mottling (ink worked into the grain)
mott = 1 + 0.06 * (noise(18, 1) / noise(18, 1).std())
base = BG[None, None] * (1 - mask[..., None]) + (INK * 1.0)[None, None] * mask[..., None] * mott[..., None]
# crease darkening in letters (ink pools less in creases)
shadeL = (0.35 + 0.65 * lum)
inside = mask > .9
shadeL = np.where(mask > .5, shadeL / np.median(shadeL[inside]), shadeL)  # keep letter mean = seal ink
img = base * shadeL[..., None] * shadow[..., None]
img += spec[..., None] * (0.08 + 0.16 * mask[..., None]) * np.array([1, .93, .9])
# vignette for depth
yy, xx = np.mgrid[0:S, 0:S] / S - 0.5
img *= (1 - 0.35 * (xx ** 2 + yy ** 2))[..., None]
img = np.clip(img, 0, 1)

out = Image.fromarray((img * 255).astype(np.uint8))
out.save('icon-master.png')
for s in (512, 192, 180):
    out.resize((s, s), Image.LANCZOS).save(f'icon-{s}.png', optimize=True)
print('done')
