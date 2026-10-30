#!/usr/bin/env python3
# Usage: python3 -I tools/make-thumbs.py [--check] [--max-bytes=N] [shots_dir]
"""
Makes the gallery thumbnails assets/shots/<demo>-640.jpg from the full desktop shots assets/shots/<demo>.jpg (the
files tools/shoot.cjs writes; the -m phone shots are left alone).

Each thumbnail is 640px wide with the shot's own aspect (640x1200; a 1280x2340 shot gives 640x1170), resized with
Lanczos and saved as an optimised progressive JPEG. Quality starts at 82 and steps down by 4 (to 62 at the lowest)
until the file is at most --max-bytes, by default 90 KiB (92,160 bytes): the cap the committed thumbnails were made
with. Run it after re-shooting, so index.html's srcset never offers a stale picture (tools/check-index.cjs compares
each thumbnail with its full shot and fails on a mismatch).

A file whose bytes would not change is not rewritten. --check writes nothing: it reports, per thumbnail, whether the
committed file is byte-identical to what this script makes (or, if not, the mean pixel difference) and exits 1 when
any is missing, over the cap, a different size, or differs by more than 1 (0-255).

Needs Pillow. shots_dir defaults to assets/shots next to this tools/ folder.
"""
import glob
import io
import os
import sys

from PIL import Image, ImageChops, ImageStat

WIDTH = 640
QUALITIES = range(82, 59, -4)  # 82, 78, 74, 70, 66, 62
DEFAULT_MAX = 90 * 1024
CHECK_TOLERANCE = 1.0  # mean absolute pixel difference (0-255) still counted as the same picture


def make(full_path, max_bytes):
    """Returns (jpeg bytes, size, quality) for the thumbnail of one full shot."""
    with Image.open(full_path) as im:
        im = im.convert('RGB')
        w, h = im.size
        small = im.resize((WIDTH, round(h * WIDTH / w)), Image.LANCZOS)
    data = b''
    for q in QUALITIES:
        buf = io.BytesIO()
        small.save(buf, 'JPEG', quality=q, optimize=True, progressive=True)
        data = buf.getvalue()
        if len(data) <= max_bytes:
            break
    return data, small.size, q


def mean_diff(a_bytes, b_path):
    with Image.open(io.BytesIO(a_bytes)) as a, Image.open(b_path) as b:
        if a.size != b.size:
            return None
        stat = ImageStat.Stat(ImageChops.difference(a.convert('RGB'), b.convert('RGB')))
        return sum(stat.mean) / 3


def main(argv):
    check = '--check' in argv
    max_bytes = DEFAULT_MAX
    rest = []
    for arg in argv:
        if arg.startswith('--max-bytes='):
            max_bytes = int(arg.split('=', 1)[1])
        elif arg != '--check':
            rest.append(arg)
    if any(a.startswith('--') for a in rest) or len(rest) > 1:
        print('usage: python3 -I tools/make-thumbs.py [--check] [--max-bytes=N] [shots_dir]', file=sys.stderr)
        return 2
    shots = rest[0] if rest else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'shots')
    fulls = sorted(p for p in glob.glob(os.path.join(shots, '[0-9][0-9]-*.jpg'))
                   if not p.endswith('-m.jpg') and not p.endswith('-640.jpg'))
    if not fulls:
        print(f'make-thumbs: no full shots (NN-*.jpg) in {shots}', file=sys.stderr)
        return 2
    bad = 0
    for full in fulls:
        out = full[:-4] + '-640.jpg'
        name = os.path.basename(out)
        data, (w, h), q = make(full, max_bytes)
        over = len(data) > max_bytes
        if check:
            if not os.path.exists(out):
                status, failed = 'MISSING', True
            else:
                with open(out, 'rb') as f:
                    committed = f.read()
                if committed == data:
                    status, failed = 'byte-identical', False
                else:
                    d = mean_diff(data, out)
                    failed = d is None or d > CHECK_TOLERANCE
                    status = 'different size' if d is None else f'differs, mean pixel diff {d:.2f}'
                if len(committed) > max_bytes:
                    status, failed = status + f', committed file is {len(committed)} bytes', True
            failed = failed or over
        else:
            same = os.path.exists(out) and open(out, 'rb').read() == data
            if not same:
                tmp = out + '.tmp'
                with open(tmp, 'wb') as f:
                    f.write(data)
                os.replace(tmp, out)
            status, failed = ('unchanged' if same else 'written'), over
        bad += failed
        print(f'{name:44} {w}x{h} q{q} {len(data):6d} bytes  {status}{"  OVER " + str(max_bytes) if over else ""}{"  FAIL" if failed else ""}')
    print(f'{len(fulls)} thumbnail(s), {bad} problem(s)')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
