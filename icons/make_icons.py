"""Generate Model Route Inspector icons (PNG) without external deps.
Design: indigo rounded square, a route line connecting a green node
to a red node with an arrowhead — symbolizing model routing/switch.
Renders at 4x supersampling then downsamples for AA.
"""
import zlib
import struct
import os
import math

OUT_DIR = os.path.dirname(os.path.abspath(__file__))


def png_chunk(chunk_type, data):
    return (struct.pack(">I", len(data)) + chunk_type + data +
            struct.pack(">I", zlib.crc32(chunk_type + data) & 0xFFFFFFFF))


def write_png(path, pixels, w, h):
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter: none
        for x in range(w):
            r, g, b, a = pixels[y * w + x]
            raw += bytes((r, g, b, a))
    compressed = zlib.compress(bytes(raw), 9)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(png_chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)))
        f.write(png_chunk(b"IDAT", compressed))
        f.write(png_chunk(b"IEND", b""))


def new_canvas(size):
    return [(0, 0, 0, 0)] * (size * size)


def blend(dst, src):
    sr, sg, sb, sa = src
    if sa == 0:
        return dst
    dr, dg, db, da = dst
    a = sa / 255.0
    ia = 1.0 - a
    return (
        int(sr * a + dr * ia),
        int(sg * a + dg * ia),
        int(sb * a + db * ia),
        int(sa + da * ia),
    )


def fill_rounded_rect(buf, size, radius, color, pad=0):
    x0, y0 = pad, pad
    x1, y1 = size - pad, size - pad
    for y in range(size):
        for x in range(size):
            if x0 <= x < x1 and y0 <= y < y1:
                # corner check
                cx = cy = None
                if x < x0 + radius and y < y0 + radius:
                    cx, cy = x0 + radius, y0 + radius
                elif x >= x1 - radius and y < y0 + radius:
                    cx, cy = x1 - radius - 1, y0 + radius
                elif x < x0 + radius and y >= y1 - radius:
                    cx, cy = x0 + radius, y1 - radius - 1
                elif x >= x1 - radius and y >= y1 - radius:
                    cx, cy = x1 - radius - 1, y1 - radius - 1
                if cx is not None:
                    if (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2:
                        continue
                buf[y * size + x] = color


def fill_circle(buf, size, cx, cy, r, color):
    r2 = r * r
    for y in range(max(0, int(cy - r - 1)), min(size, int(cy + r + 2))):
        for x in range(max(0, int(cx - r - 1)), min(size, int(cx + r + 2))):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r2:
                buf[y * size + x] = blend(buf[y * size + x], color)


def draw_line(buf, size, x0, y0, x1, y1, width, color):
    # thick line via sampling circles
    steps = int(max(abs(x1 - x0), abs(y1 - y0))) + 1
    for i in range(steps + 1):
        t = i / steps
        x = x0 + (x1 - x0) * t
        y = y0 + (y1 - y0) * t
        fill_circle(buf, size, x, y, width / 2.0, color)


def draw_arrowhead(buf, size, x0, y0, x1, y1, size_px, color):
    angle = math.atan2(y1 - y0, x1 - x0)
    for spread in (math.pi * 0.82, -math.pi * 0.82):
        ex = x1 + size_px * math.cos(angle + spread)
        ey = y1 + size_px * math.sin(angle + spread)
        draw_line(buf, size, x1, y1, ex, ey, size_px * 0.28, color)


def downsample(src, ssize, dsize):
    dst = new_canvas(dsize)
    factor = ssize / dsize
    for dy in range(dsize):
        for dx in range(dsize):
            sx0 = int(dx * factor)
            sy0 = int(dy * factor)
            sx1 = max(sx0 + 1, int((dx + 1) * factor))
            sy1 = max(sy0 + 1, int((dy + 1) * factor))
            tr = tg = tb = ta = 0
            cnt = 0
            for sy in range(sy0, min(ssize, sy1)):
                for sx in range(sx0, min(ssize, sx1)):
                    r, g, b, a = src[sy * ssize + sx]
                    tr += r; tg += g; tb += b; ta += a; cnt += 1
            if cnt:
                dst[dy * dsize + dx] = (tr // cnt, tg // cnt, tb // cnt, ta // cnt)
    return dst


def render(size):
    SS = 4
    S = size * SS
    c = new_canvas(S)
    # indigo background
    fill_rounded_rect(c, S, int(S * 0.22), (79, 70, 229, 255))
    # route
    x0, y0 = int(S * 0.30), int(S * 0.62)
    x1, y1 = int(S * 0.70), int(S * 0.38)
    lw = max(2.0, S * 0.035)
    draw_line(c, S, x0, y0, x1 - S * 0.02, y1 + S * 0.02, lw, (255, 255, 255, 235))
    draw_arrowhead(c, S, x0, y0, x1, y1, S * 0.16, (255, 255, 255, 235))
    # green start node
    fill_circle(c, S, x0, y0, S * 0.10, (34, 197, 94, 255))
    fill_circle(c, S, x0, y0, S * 0.10, (34, 197, 94, 255))
    # red end node
    fill_circle(c, S, x1, y1, S * 0.10, (239, 68, 68, 255))
    return downsample(c, S, size)


for sz in (16, 48, 128):
    p = os.path.join(OUT_DIR, f"icon{sz}.png")
    write_png(p, render(sz), sz, sz)
    print("wrote", p)
