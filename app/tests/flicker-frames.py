#!/usr/bin/env python3
"""Find flicker in a sequence of screen captures.

Usage:
    python3 tests/flicker-frames.py <folder> [--crop x,y,w,h] [--bg R,G,B]
                                            [--tol N] [--drop F]

Reads every *.ppm file in <folder> (sorted by name). Each frame's crop
rectangle (default: whole image) is scored by the fraction of pixels within
--tol (default 12, per channel) of --bg (default 20,20,20) and by mean
brightness. A frame is flagged FLICKER when its background fraction is more
than --drop (default 0.25) above BOTH neighbours. Input is binary P6 PPM
with maxval 255 (header comments allowed). One line per frame is printed
(index, filename, background fraction, mean brightness), then a summary
(frames, flicker count, flicker frame indices). Exit code is always 0.
"""
import argparse
import glob
import os
import sys


def read_ppm(path):
    """Read a binary P6 PPM and return (width, height, pixel bytes)."""
    data = open(path, "rb").read()
    pos, tokens = 0, []
    while len(tokens) < 4 and pos < len(data):   # header tokens, # comments
        while pos < len(data) and data[pos] in b" \t\r\n":
            pos += 1
        if pos < len(data) and data[pos:pos + 1] == b"#":
            while pos < len(data) and data[pos] not in b"\r\n":
                pos += 1
            continue
        start = pos
        while pos < len(data) and data[pos] not in b" \t\r\n":
            pos += 1
        tokens.append(data[start:pos])
    if len(tokens) != 4 or tokens[0] != b"P6" or int(tokens[3]) != 255:
        raise ValueError("not a binary P6 PPM with maxval 255")
    width, height = int(tokens[1]), int(tokens[2])
    pos += 2 if data[pos:pos + 2] == b"\r\n" else 1   # separator after maxval
    pixels = data[pos:pos + width * height * 3]
    if len(pixels) != width * height * 3:
        raise ValueError("truncated pixel data")
    return width, height, pixels


def analyse(pixels, width, height, crop, bg, tol):
    """Return (background fraction, mean brightness) inside the crop."""
    x, y, w, h = crop
    x, y = max(0, min(x, width)), max(0, min(y, height))
    w, h = max(0, min(w, width - x)), max(0, min(h, height - y))
    bg_count, total, brightness = 0, w * h, 0.0
    for row in range(y, y + h):
        base = (row * width + x) * 3
        for col in range(base, base + w * 3, 3):
            if all(abs(pixels[col + i] - bg[i]) <= tol for i in range(3)):
                bg_count += 1
            brightness += sum(pixels[col:col + 3]) / 3.0
    return (bg_count / total, brightness / total) if total else (0.0, 0.0)


def parse_ints(text, count, label):
    try:
        parts = [int(v) for v in text.split(",")]
    except ValueError:
        raise argparse.ArgumentTypeError("%s must be integers" % label)
    if len(parts) != count:
        raise argparse.ArgumentTypeError("%s needs %d values" % (label, count))
    return tuple(parts)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Find flicker in PPM screen captures.")
    ap.add_argument("folder")
    ap.add_argument("--crop", type=lambda t: parse_ints(t, 4, "crop"), default=None)
    ap.add_argument("--bg", type=lambda t: parse_ints(t, 3, "bg"), default=(20, 20, 20))
    ap.add_argument("--tol", type=int, default=12)
    ap.add_argument("--drop", type=float, default=0.25)
    args = ap.parse_args(argv)

    paths = sorted(glob.glob(os.path.join(args.folder, "*.ppm")))
    if not paths:
        print("no .ppm files found in %s" % args.folder)
        return 0

    fracs = []
    for i, path in enumerate(paths):
        width, height, pixels = read_ppm(path)
        crop = args.crop or (0, 0, width, height)
        frac, mean = analyse(pixels, width, height, crop, args.bg, args.tol)
        fracs.append(frac)
        print("%4d  %-28s  bg=%.4f  mean=%7.2f"
              % (i, os.path.basename(path), frac, mean))

    flicker = [i for i in range(1, len(fracs) - 1)
               if fracs[i] > fracs[i - 1] + args.drop
               and fracs[i] > fracs[i + 1] + args.drop]
    print("-" * 60)
    print("frames: %d" % len(paths))
    print("flicker count: %d" % len(flicker))
    print("flicker frame indices: %s" % flicker)
    return 0


if __name__ == "__main__":
    sys.exit(main())
