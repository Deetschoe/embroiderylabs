#!/usr/bin/env python
"""Helper for the trace tests (needs pyembroidery; Pillow for pictures).

    python -B render.py decode  <image> <out.rgba>
        any picture Pillow reads -> raw RGBA bytes; prints {"width", "height"}

    python -B render.py readback <file.pes|.dst> [<job.json>]
        reads the machine file back with pyembroidery and prints what is in it:
        {"stitches", "jumps", "trims", "colorChanges", "threads": ["#rrggbb"...], "bounds": [x0,y0,x1,y1] mm,
         "longest": mm, "blocks": [{"color", "stitches"}]}
        with job.json = {"out": "x.png", "source": {"rgba": path, "width", "height"}?, "size": {"width","height"} mm,
                         "origin": {"x","y"} mm, "objects": [...traced objects...]?, "title": str?, "ppmm": 8}
        it also draws the stitches (thread width 0.4 mm on cloth) next to the source picture, and reports
        "coverage": share of the traced fill area that has thread on it, and "spill": share of thread outside it.
"""
import json
import sys

import pyembroidery

STITCH, JUMP, TRIM, STOP, END, COLOR_CHANGE = 0, 1, 2, 3, 4, 5


def decode(src, dst):
    from PIL import Image
    im = Image.open(src).convert("RGBA")
    with open(dst, "wb") as f:
        f.write(im.tobytes())
    print(json.dumps({"width": im.width, "height": im.height}))


def read_blocks(path):
    p = pyembroidery.read(path)
    threads = ["#%06x" % (t.color & 0xFFFFFF) for t in p.threadlist]
    blocks, cur, ci = [], [], 0
    segs = [cur]
    counts = {"stitches": 0, "jumps": 0, "trims": 0, "colorChanges": 0}
    longest = 0.0
    last = None
    for x, y, cmd in p.stitches:
        cmd &= 0xFF
        if cmd == STITCH:
            counts["stitches"] += 1
            if last is not None and cur:
                d = ((x - last[0]) ** 2 + (y - last[1]) ** 2) ** 0.5 / 10.0
                longest = max(longest, d)
            cur.append((x / 10.0, y / 10.0))
            last = (x, y)
        elif cmd in (JUMP, TRIM):
            counts["jumps" if cmd == JUMP else "trims"] += 1
            if cur:
                cur = []
                segs.append(cur)
            last = None
        elif cmd in (COLOR_CHANGE, STOP):
            counts["colorChanges"] += 1
            blocks.append((ci, [s for s in segs if len(s) > 0]))
            ci += 1
            cur = []
            segs = [cur]
            last = None
        elif cmd == END:
            break
    blocks.append((ci, [s for s in segs if len(s) > 0]))
    blocks = [b for b in blocks if b[1]]
    return p, threads, blocks, counts, longest


def readback(path, job_path=None):
    p, threads, blocks, counts, longest = read_blocks(path)
    xs = [x for _, segs in blocks for s in segs for x, _ in s]
    ys = [y for _, segs in blocks for s in segs for _, y in s]
    out = dict(counts)
    out["threads"] = threads
    out["longest"] = round(longest, 2)
    out["bounds"] = [min(xs), min(ys), max(xs), max(ys)] if xs else None
    out["blocks"] = [{"color": threads[ci % len(threads)] if threads else "#000000", "stitches": sum(len(s) for s in segs)} for ci, segs in blocks]
    if job_path:
        with open(job_path) as f:
            job = json.load(f)
        out.update(draw(job, threads, blocks, out["bounds"]))
    print(json.dumps(out))


def draw(job, threads, blocks, bounds):
    from PIL import Image, ImageDraw
    ppmm = float(job.get("ppmm", 8))
    wmm, hmm = job["size"]["width"], job["size"]["height"]
    ox, oy = job.get("origin", {}).get("x", 0), job.get("origin", {}).get("y", 0)
    # machine files are centred on their own bounds; the design's own frame is recovered from the traced objects
    objs = job.get("objects") or []
    pts = []
    for o in objs:
        if o.get("type") == "path":
            for r in o["rings"]:
                pts.extend(r)
        elif o.get("points"):
            pts.extend(o["points"])
    dx = dy = 0.0
    if bounds and pts:
        bx0 = min(q[0] for q in pts); bx1 = max(q[0] for q in pts)
        by0 = min(q[1] for q in pts); by1 = max(q[1] for q in pts)
        dx = (bx0 + bx1) / 2 - (bounds[0] + bounds[2]) / 2
        dy = (by0 + by1) / 2 - (bounds[1] + bounds[3]) / 2
    elif bounds:
        dx = ox + wmm / 2 - (bounds[0] + bounds[2]) / 2
        dy = oy + hmm / 2 - (bounds[1] + bounds[3]) / 2
    W, H = max(8, int(round(wmm * ppmm))), max(8, int(round(hmm * ppmm)))
    cloth = tuple(job.get("cloth", [236, 233, 226]))
    sew = Image.new("RGB", (W, H), cloth)
    d = ImageDraw.Draw(sew)
    mask = Image.new("L", (W, H), 0)
    dm = ImageDraw.Draw(mask)
    lw = max(1, int(round(0.4 * ppmm)))
    # the design's own colours when given (a PES v1 file can only name the nearest thread of a 64-colour chart)
    if job.get("threads") and len(job["threads"]) >= len(blocks):
        threads = job["threads"]
    for ci, segs in blocks:
        col = threads[ci % len(threads)] if threads else "#000000"
        for s in segs:
            q = [((x + dx - ox) * ppmm, (y + dy - oy) * ppmm) for x, y in s]
            if len(q) > 1:
                d.line(q, fill=col, width=lw)
                dm.line(q, fill=255, width=lw)
    res = {}
    if objs:
        want = Image.new("L", (W, H), 0)
        for o in objs:
            if o.get("type") != "path":
                continue
            one = Image.new("L", (W, H), 0)
            d1 = ImageDraw.Draw(one)
            for i, r in enumerate(o["rings"]):
                d1.polygon([((x - ox) * ppmm, (y - oy) * ppmm) for x, y in r], fill=255 if i == 0 else 0)
            want.paste(255, (0, 0), one)
        import numpy as np
        a = np.asarray(want) > 0
        b = np.asarray(mask) > 0
        na, nb = int(a.sum()), int(b.sum())
        res["coverage"] = round(float((a & b).sum()) / na, 4) if na else None
        res["spill"] = round(float((b & ~a).sum()) / nb, 4) if nb else None
        res["fillPx"] = na
    panels = []
    src = job.get("source")
    if src:
        with open(src["rgba"], "rb") as f:
            raw = f.read()
        im = Image.frombytes("RGBA", (src["width"], src["height"]), raw)
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        # checker under transparent parts so they can be told from white
        if im.getextrema()[3][0] < 255:
            dc = ImageDraw.Draw(bg)
            step = max(4, im.width // 40)
            for yy in range(0, im.height, step):
                for xx in range(0, im.width, step):
                    if ((xx // step) + (yy // step)) % 2:
                        dc.rectangle([xx, yy, xx + step - 1, yy + step - 1], fill=(225, 225, 225, 255))
        bg.alpha_composite(im)
        panels.append(bg.convert("RGB").resize((W, H), Image.LANCZOS if im.width > W else Image.NEAREST))
    panels.append(sew)
    gap = 12
    sheet = Image.new("RGB", (sum(p.width for p in panels) + gap * (len(panels) + 1), H + gap * 2 + 14), (255, 255, 255))
    x = gap
    for pnl in panels:
        sheet.paste(pnl, (x, gap))
        x += pnl.width + gap
    if job.get("title"):
        ImageDraw.Draw(sheet).text((gap, H + gap + 2), job["title"], fill=(60, 60, 60))
    sheet.save(job["out"])
    res["png"] = job["out"]
    return res


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "decode":
        decode(sys.argv[2], sys.argv[3])
    elif len(sys.argv) >= 3 and sys.argv[1] == "readback":
        readback(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    else:
        sys.stderr.write(__doc__)
        sys.exit(2)
