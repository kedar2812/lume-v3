"""Render a recorded product-tour scene (apps/web/e2e/site/recorder.ts) into a video.

The recording holds the page's own frames and a log of the cursor, clicks, camera and cuts. This draws what
headless Chrome can't: a cursor that glides between targets, a ripple on every click, a camera that eases in on
each moment and back out, and the waits cut out. 60 fps, H.264.

    python scripts/tour/render.py <scene-dir> <out.mp4> [--width 1920] [--captions captions.json --font Inter.ttf]

With captions, the scene opens on its first frame while the problem is read, then the caption turns into LUME's
answer as the cursor starts to move.
"""

import argparse
import bisect
import json
import math
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FPS = 60
ACCENT = (42, 91, 255)  # LUME's one accent, #2A5BFF
CAMERA_SECONDS = 0.95
MAX_ZOOM = 2.1
PAD = 0.14  # breathing room around a zoomed box, as a share of the box


def ease_in_out(x):
    x = min(max(x, 0.0), 1.0)
    return 4 * x * x * x if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def cursor_sprite(height_px):
    """The arrow, drawn large and scaled down so its edges stay smooth; a soft shadow under it."""
    s = 8
    pts = [(0, 0), (0, 17.2), (4.1, 13.4), (7.0, 20.0), (9.9, 18.8), (7.1, 12.4), (12.6, 12.4)]
    k = height_px / 21.0 * s
    pad = int(6 * k / s * s)
    w = int(14 * k) + pad * 2
    h = int(22 * k) + pad * 2
    poly = [(pad + x * k, pad + y * k) for x, y in pts]
    shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon([(x + 1.2 * k, y + 2.0 * k) for x, y in poly], fill=(0, 0, 0, 90))
    shadow = shadow.filter(ImageFilter.GaussianBlur(2.2 * k))
    art = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(art)
    d.polygon(poly, fill=(255, 255, 255, 255))
    # The black body inset by the white rim.
    cx = sum(x for x, _ in poly) / len(poly)
    cy = sum(y for _, y in poly) / len(poly)
    inset = 1.55 * k
    inner = []
    for x, y in poly:
        dx, dy = x - cx, y - cy
        n = math.hypot(dx, dy) or 1
        inner.append((x - dx / n * inset, y - dy / n * inset))
    d.polygon(inner, fill=(17, 18, 22, 255))
    out = Image.alpha_composite(shadow, art)
    out = out.resize((w // s, h // s), Image.LANCZOS)
    return out, (pad // s, pad // s)  # the tip's offset in the sprite


class Caption:
    """A glass pill at the top: the problem (an eyebrow in warm red), then LUME's answer (an eyebrow in blue)."""

    def __init__(self, font_path, width, problem, lume):
        self.k = width / 1920
        self.problem, self.lume = problem, lume
        self.font_path = font_path
        self.layers = {}
        for key, eyebrow, colour, text in (
            ("problem", "THE PROBLEM", (255, 122, 99), problem),
            ("lume", "WITH LUME", (110, 176, 255), lume),
        ):
            if text:
                self.layers[key] = self._layer(eyebrow, colour, text)

    def _font(self, size, weight):
        f = ImageFont.truetype(self.font_path, round(size * self.k))
        try:
            f.set_variation_by_axes([min(32, max(14, size)), weight])
        except Exception:
            pass
        return f

    def _layer(self, eyebrow, colour, text):
        k = self.k
        small, big = self._font(15, 650), self._font(29, 560)
        eb_w = small.getlength(eyebrow) + 22 * k
        tx_w = big.getlength(text)
        w = int(30 * k + eb_w + 16 * k + tx_w + 34 * k)
        h = int(68 * k)
        im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        # The eyebrow: a quiet chip.
        x = 30 * k
        d.rounded_rectangle((x, h / 2 - 15 * k, x + eb_w, h / 2 + 15 * k), radius=15 * k, fill=colour + (46,))
        d.text((x + 11 * k, h / 2), eyebrow, font=small, fill=colour + (255,), anchor="lm")
        d.text((x + eb_w + 16 * k, h / 2 + 1 * k), text, font=big, fill=(255, 255, 255, 255), anchor="lm")
        return im

    def draw(self, view, t, lead, total):
        """t: output seconds. The pill rises in and holds the problem through the lead-in; then the problem slides
        up and out, the pill eases to its new width, and LUME's answer rises in. Frosted: what's under it blurs."""
        k = self.k
        a_in = min(max((t - 0.12) / 0.4, 0), 1)
        if a_in <= 0:
            return
        rise = 1 - (1 - a_in) ** 3
        a = self.layers.get("problem")
        b = self.layers["lume"]
        m = ease_in_out((t - lead) / 0.6) if a is not None else 1.0
        w = a.width * (1 - m) + b.width * m if a is not None else b.width
        h = b.height
        x0 = int((view.width - w) / 2)
        y0 = int(30 * k + (1 - rise) * 14 * k)
        box = (x0, y0, int(x0 + w), y0 + h)
        # Everything happens in a region around the pill (blurring the whole frame each time is slow).
        g = int(48 * k)
        rx0, ry0 = max(0, box[0] - g), max(0, box[1] - g)
        rx1, ry1 = min(view.width, box[2] + g), min(view.height, box[3] + g)
        region = view.crop((rx0, ry0, rx1, ry1))
        lb = (box[0] - rx0, box[1] - ry0, box[2] - rx0, box[3] - ry0)
        mask = Image.new("L", region.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle(lb, radius=h / 2, fill=int(255 * a_in))
        sh = Image.new("RGBA", region.size, (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle((lb[0], lb[1] + 8 * k, lb[2], lb[3] + 8 * k), radius=h / 2, fill=(8, 10, 14, int(64 * a_in)))
        region.alpha_composite(sh.filter(ImageFilter.GaussianBlur(14 * k)))
        region.paste(region.filter(ImageFilter.GaussianBlur(16 * k)), (0, 0), mask)
        tint = Image.new("RGBA", region.size, (17, 18, 22, 0))
        tint.putalpha(mask.point(lambda v: int(v * 0.86)))
        region.alpha_composite(tint)
        # The words, clipped to the pill.
        words = Image.new("RGBA", region.size, (0, 0, 0, 0))
        for layer, phase in ((a, "out"), (b, "in")):
            if layer is None:
                continue
            if phase == "out":
                p = min(max(m / 0.45, 0), 1)
                alpha, dy = 1 - p, -10 * k * p
            else:
                p = min(max((m - 0.4) / 0.6, 0), 1) if a is not None else 1.0
                alpha, dy = p, 10 * k * (1 - p)
            if alpha <= 0.01:
                continue
            l2 = layer.copy()
            l2.putalpha(l2.getchannel("A").point(lambda v, al=alpha: int(v * al)))
            words.alpha_composite(l2, (int((view.width - layer.width) / 2) - rx0, int(y0 + dy) - ry0))
        words.putalpha(Image.composite(words.getchannel("A"), Image.new("L", region.size, 0), mask.point(lambda v: 255 if v else 0)))
        if a_in < 1:
            words.putalpha(words.getchannel("A").point(lambda v: int(v * a_in)))
        region.alpha_composite(words)
        view.paste(region, (rx0, ry0))


class Scene:
    def __init__(self, folder: Path):
        self.folder = folder
        data = json.loads((folder / "tour.json").read_text(encoding="utf-8"))
        self.vw = data["viewport"]["width"]
        self.vh = data["viewport"]["height"]
        self.frames = sorted(data["frames"], key=lambda f: f["t"])
        if not self.frames:
            raise SystemExit(f"{folder}: no frames")
        self.times = [f["t"] for f in self.frames]
        ev = data["events"]
        self.moves = sorted([e for e in ev if e["k"] == "move"], key=lambda e: e["t0"])
        self.clicks = sorted([e for e in ev if e["k"] == "click"], key=lambda e: e["t"])
        self.zooms = sorted([e for e in ev if e["k"] == "zoom"], key=lambda e: e["t"])
        self.cuts = sorted([(e["t0"], e["t1"]) for e in ev if e["k"] == "cut"])
        self.t0 = self.times[0]
        last_event = max([self.times[-1]] + [e.get("t1", e.get("t", 0)) for e in ev])
        self.t1 = last_event + 0.35
        self.cuts = self._merge(self.cuts + self._idle(ev))
        self._cache = (None, None)

    IDLE_KEEP = 0.75  # the longest a still moment lasts: enough to take it in, not to wait

    def _idle(self, ev):
        """Stretches where nothing moves (no cursor, no click settling, no camera), squeezed to IDLE_KEEP."""
        busy = []
        for e in ev:
            if e["k"] == "move":
                busy.append((e["t0"] - 0.05, e["t1"] + 0.05))
            elif e["k"] == "click":
                busy.append((e["t"] - 0.1, e["t"] + 0.6))
            elif e["k"] == "zoom":
                busy.append((e["t"], e["t"] + CAMERA_SECONDS))
        busy.append((self.t0, self.t0 + 0.5))
        busy.append((self.t1 - 0.6, self.t1))
        busy = self._merge(busy)
        out = []
        for (a0, a1), (b0, _) in zip(busy, busy[1:]):
            gap = b0 - a1
            if gap > self.IDLE_KEEP:
                out.append((a1 + self.IDLE_KEEP / 2, b0 - self.IDLE_KEEP / 2))
        return out

    @staticmethod
    def _merge(spans):
        out = []
        for a, b in sorted(spans):
            if out and a <= out[-1][1]:
                out[-1] = (out[-1][0], max(out[-1][1], b))
            else:
                out.append((a, b))
        return out

    # Time: the output skips the cuts.
    MOVE_MAX = 0.7  # a glide never looks slower than this, however long the real one took

    def _speed(self, t):
        for m in self.moves:
            if m["t0"] <= t <= m["t1"]:
                return max(1.0, (m["t1"] - m["t0"]) / self.MOVE_MAX)
        return 1.0

    def source_times(self, lead=0.0):
        for _ in range(round(lead * FPS)):
            yield self.t0
        t, dt = self.t0, 1.0 / FPS
        cuts = list(self.cuts)
        while t <= self.t1:
            while cuts and t >= cuts[0][0]:
                a, b = cuts.pop(0)
                if t < b:
                    t = b
            yield t
            t += dt * self._speed(t)

    def frame_at(self, t):
        i = max(0, bisect.bisect_right(self.times, t) - 1)
        if self._cache[0] != i:
            img = Image.open(self.folder / self.frames[i]["file"]).convert("RGB")
            self._cache = (i, img)
        return self._cache[1]

    def cursor_at(self, t):
        pos = None
        for m in self.moves:
            if t < m["t0"]:
                break
            if t <= m["t1"]:
                e = ease_in_out((t - m["t0"]) / max(m["t1"] - m["t0"], 1e-6))
                return (m["from"][0] + (m["to"][0] - m["from"][0]) * e, m["from"][1] + (m["to"][1] - m["from"][1]) * e)
            pos = tuple(m["to"])
        if pos is None:
            pos = tuple(self.moves[0]["from"]) if self.moves else (self.vw * 0.62, self.vh * 0.72)
        return pos

    def rect_for(self, box):
        """The camera's view (x, y, w, h in CSS px) that frames a box, or the whole screen."""
        if not box:
            return (0.0, 0.0, float(self.vw), float(self.vh))
        bw = box["w"] * (1 + 2 * PAD) + 40
        bh = box["h"] * (1 + 2 * PAD) + 40
        z = min(self.vw / bw, self.vh / bh, MAX_ZOOM)
        z = max(z, 1.0)
        w, h = self.vw / z, self.vh / z
        cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
        x = min(max(cx - w / 2, 0), self.vw - w)
        y = min(max(cy - h / 2, 0), self.vh - h)
        return (x, y, w, h)

    def camera_at(self, t):
        cur = self.rect_for(None)
        for z in self.zooms:
            if t < z["t"]:
                break
            target = self.rect_for(z["box"])
            p = (t - z["t"]) / CAMERA_SECONDS
            if p >= 1:
                cur = target
            else:
                e = 1 - (1 - p) ** 4 if p > 0 else 0  # ease-out quart: quick to move, slow to settle
                e = ease_in_out(p) * 0.35 + e * 0.65
                cur = tuple(a + (b - a) * e for a, b in zip(cur, target))
        return cur


def render(folder: Path, out: Path, width: int, caption=None, lead=0.0):
    sc = Scene(folder)
    height = round(width * sc.vh / sc.vw / 2) * 2
    sprite_base, tip = cursor_sprite(24)
    ff = subprocess.Popen(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}", "-r", str(FPS), "-i", "-",
            "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", str(out),
        ],
        stdin=subprocess.PIPE,
    )
    n = 0
    for t in sc.source_times(lead):
        frame = sc.frame_at(t)
        k = frame.width / sc.vw  # frame pixels per CSS px
        cx, cy, cw, ch = sc.camera_at(t)
        view = frame.crop((round(cx * k), round(cy * k), round((cx + cw) * k), round((cy + ch) * k)))
        view = view.resize((width, height), Image.LANCZOS if cw < sc.vw * 0.98 else Image.BICUBIC).convert("RGBA")
        scale = width / cw  # output px per CSS px
        px, py = sc.cursor_at(t)
        ox, oy = (px - cx) * scale, (py - cy) * scale
        # Click: a ripple in the accent, and the cursor dips.
        press = 1.0
        overlay = Image.new("RGBA", view.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(overlay)
        for c in sc.clicks:
            dt = t - c["t"]
            if -0.02 <= dt <= 0.55:
                p = max(dt, 0) / 0.55
                r = (8 + 30 * (1 - (1 - p) ** 3)) * scale / 1.6
                a = int(150 * (1 - p) ** 1.5)
                cxp, cyp = (c["at"][0] - cx) * scale, (c["at"][1] - cy) * scale
                d.ellipse((cxp - r, cyp - r, cxp + r, cyp + r), fill=ACCENT + (int(a * 0.35),), outline=ACCENT + (a,), width=max(2, int(2.5 * scale / 1.6)))
            if 0 <= dt <= 0.16:
                press = 1 - 0.14 * math.sin(math.pi * dt / 0.16)
        view = Image.alpha_composite(view, overlay)
        # The cursor grows a little with the camera, as if it were on the screen, but not all the way.
        cur_scale = (1 + (scale / (width / sc.vw) - 1) * 0.45) * press
        size = (max(1, round(sprite_base.width * cur_scale * width / 1920)), max(1, round(sprite_base.height * cur_scale * width / 1920)))
        sprite = sprite_base.resize(size, Image.LANCZOS)
        tx, ty = tip[0] * size[0] / sprite_base.width, tip[1] * size[1] / sprite_base.height
        view.paste(sprite, (int(round(ox - tx)), int(round(oy - ty))), sprite)
        if caption:
            caption.draw(view, n / FPS, lead, None)
        ff.stdin.write(view.convert("RGB").tobytes())
        n += 1
    ff.stdin.close()
    ff.wait()
    print(f"{out}: {n} frames, {n / FPS:.1f}s")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("scene", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--captions", type=Path)
    ap.add_argument("--font", type=Path)
    ap.add_argument("--key", help="the captions' key (default: the scene folder's name)")
    ap.add_argument("--lead", type=float, default=2.4, help="seconds on the first frame while the problem is read")
    a = ap.parse_args()
    cap, lead = None, 0.0
    if a.captions:
        c = json.loads(a.captions.read_text(encoding="utf-8")).get(a.key or a.scene.name)
        if c:
            cap = Caption(str(a.font), a.width, c.get("problem"), c["lume"])
            lead = a.lead if c.get("problem") else 0.0
    render(a.scene, a.out, a.width, cap, lead)
