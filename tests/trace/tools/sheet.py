#!/usr/bin/env python
"""Contact sheet for looking at traced pictures: source | traced shapes | stitch-out, one row per run.

    python -B sheet.py <job.json>

job = {"out": "sheet.png", "panel": 480, "rows": [
         {"source": {"rgba": path, "width": w, "height": h}, "size": {"width": mm, "height": mm}, "origin": {"x","y"}, "crop": [x0, y0, x1, y1] fractions (optional),
          "objects": [...traced objects...], "pes": path or null, "threads": ["#rrggbb"...], "caption": "..."}]}
Prints {"rows": [{"stitches", "jumps", "trims", "colorChanges", "short": n under 0.5 mm, "long": n over 7 mm,
                  "longest": mm, "coverage", "bounds": [x0, y0, x1, y1] mm relative to the picture}]}.
The stitch-out is read back from the PES file with pyembroidery, so it shows what a machine would be told.
"""
import json
import sys

import pyembroidery
from PIL import Image, ImageDraw

STITCH, JUMP, TRIM, STOP, END, COLOR_CHANGE = 0, 1, 2, 3, 4, 5
CLOTH = (206, 201, 191)


def read(path):
    p = pyembroidery.read(path)
    blocks, cur, segs, ci = [], [], [], 0
    c = {"stitches": 0, "jumps": 0, "trims": 0, "colorChanges": 0, "short": 0, "long": 0}
    longest, last = 0.0, None
    segs.append(cur)
    for x, y, cmd in p.stitches:
        cmd &= 0xFF
        if cmd == STITCH:
            c["stitches"] += 1
            if last is not None and cur:
                d = ((x - last[0]) ** 2 + (y - last[1]) ** 2) ** 0.5 / 10.0
                longest = max(longest, d)
                if d < 0.5:
                    c["short"] += 1
                if d > 7.0:
                    c["long"] += 1
            cur.append((x / 10.0, y / 10.0))
            last = (x, y)
        elif cmd in (JUMP, TRIM):
            c["jumps" if cmd == JUMP else "trims"] += 1
            if cur:
                cur = []
                segs.append(cur)
            last = None
        elif cmd in (COLOR_CHANGE, STOP):
            c["colorChanges"] += 1
            blocks.append((ci, [s for s in segs if s]))
            ci += 1
            cur = []
            segs = [cur]
            last = None
        elif cmd == END:
            break
    blocks.append((ci, [s for s in segs if s]))
    c["longest"] = round(longest, 2)
    return [b for b in blocks if b[1]], c


def obj_points(objs):
    pts = []
    for o in objs:
        if o.get("type") == "path":
            for r in o["rings"]:
                pts.extend(r)
        elif o.get("points"):
            pts.extend(o["points"])
    return pts


def darker(hexc, k=0.55):
    v = int(hexc.lstrip("#"), 16)
    return (int(((v >> 16) & 255) * k), int(((v >> 8) & 255) * k), int((v & 255) * k))


def row_panels(row, panel):
    wmm, hmm = row["size"]["width"], row["size"]["height"]
    ox, oy = row.get("origin", {}).get("x", 0), row.get("origin", {}).get("y", 0)
    crop = row.get("crop") or [0, 0, 1, 1]          # fractions of the picture: x0, y0, x1, y1 (to look closely)
    ppmm = panel / max(wmm * (crop[2] - crop[0]), hmm * (crop[3] - crop[1]))
    SS = max(2, int(-(-24 // ppmm)))                # thread is drawn at 24 px/mm or finer, whatever the panel size
    W, H = max(8, int(round(wmm * ppmm))), max(8, int(round(hmm * ppmm)))
    k = ppmm * SS
    out = []
    # source
    src = row["source"]
    with open(src["rgba"], "rb") as f:
        im = Image.frombytes("RGBA", (src["width"], src["height"]), f.read())
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    if im.getextrema()[3][0] < 255:
        dc = ImageDraw.Draw(bg)
        step = max(4, im.width // 40)
        for yy in range(0, im.height, step):
            for xx in range(0, im.width, step):
                if ((xx // step) + (yy // step)) % 2:
                    dc.rectangle([xx, yy, xx + step - 1, yy + step - 1], fill=(222, 222, 222, 255))
    bg.alpha_composite(im)
    out.append(bg.convert("RGB").resize((W, H), Image.LANCZOS if im.width > W else Image.BICUBIC))
    # traced shapes, in sewing order (so what is drawn last is what is sewn last)
    objs = row.get("objects") or []
    sh = Image.new("RGB", (W * SS, H * SS), CLOTH)
    d = ImageDraw.Draw(sh)
    for o in objs:
        col = o.get("color", "#000000")
        if o.get("type") == "path":
            one = Image.new("L", sh.size, 0)
            d1 = ImageDraw.Draw(one)
            for i, r in enumerate(o["rings"]):
                d1.polygon([((x - ox) * k, (y - oy) * k) for x, y in r], fill=255 if i == 0 else 0)
            sh.paste(col, (0, 0), one)
            for r in o["rings"]:
                q = [((x - ox) * k, (y - oy) * k) for x, y in r]
                d.line(q + [q[0]], fill=darker(col), width=1)
        elif o.get("points"):
            q = [((x - ox) * k, (y - oy) * k) for x, y in o["points"]]
            if o.get("closed"):
                q = q + [q[0]]
            ln = o.get("line", {})
            wmm_ = ln.get("width", 0.4) if ln.get("type") == "satin" else (0.5 if ln.get("type") == "bean" else 0.3)
            d.line(q, fill=col, width=max(1, int(round(wmm_ * k))), joint="curve")
    out.append(sh.resize((W, H), Image.LANCZOS))
    res = {}
    # stitch-out
    st = Image.new("RGB", (W * SS, H * SS), CLOTH)
    if row.get("pes"):
        blocks, counts = read(row["pes"])
        res.update(counts)
        xs = [x for _, segs in blocks for s in segs for x, _ in s]
        ys = [y for _, segs in blocks for s in segs for _, y in s]
        pts = obj_points(objs)
        dx = dy = 0.0
        if xs and pts:
            # the file is centred on the stitches' own bounds; the engine reports where those are in the hoop
            b = row.get("bounds")
            if b:
                dx = (b["minX"] + b["maxX"]) / 2 - (min(xs) + max(xs)) / 2
                dy = (b["minY"] + b["maxY"]) / 2 - (min(ys) + max(ys)) / 2
            else:
                dx = (min(q[0] for q in pts) + max(q[0] for q in pts)) / 2 - (min(xs) + max(xs)) / 2
                dy = (min(q[1] for q in pts) + max(q[1] for q in pts)) / 2 - (min(ys) + max(ys)) / 2
            res["bounds"] = [round(min(xs) + dx - ox, 2), round(min(ys) + dy - oy, 2), round(max(xs) + dx - ox, 2), round(max(ys) + dy - oy, 2)]
        d = ImageDraw.Draw(st)
        mask = Image.new("L", st.size, 0)
        dm = ImageDraw.Draw(mask)
        threads = row.get("threads") or ["#000000"]
        lw = max(1, int(round(0.38 * k)))
        for ci, segs in blocks:
            col = threads[ci % len(threads)]
            for s in segs:
                q = [((x + dx - ox) * k, (y + dy - oy) * k) for x, y in s]
                if len(q) > 1:
                    d.line(q, fill=col, width=lw)
                    dm.line(q, fill=255, width=lw)
        # coverage of the traced fills by thread
        want = Image.new("L", st.size, 0)
        for o in objs:
            if o.get("type") != "path":
                continue
            one = Image.new("L", st.size, 0)
            d1 = ImageDraw.Draw(one)
            for i, r in enumerate(o["rings"]):
                d1.polygon([((x - ox) * k, (y - oy) * k) for x, y in r], fill=255 if i == 0 else 0)
            want.paste(255, (0, 0), one)
        import numpy as np
        a = np.asarray(want) > 0
        b2 = np.asarray(mask) > 0
        na = int(a.sum())
        res["coverage"] = round(float((a & b2).sum()) / na, 4) if na else None
    out.append(st.resize((W, H), Image.LANCZOS))
    if crop != [0, 0, 1, 1]:
        box = (int(crop[0] * W), int(crop[1] * H), int(crop[2] * W), int(crop[3] * H))
        out = [im_.crop(box) for im_ in out]
    return out, res


def main(job_path):
    with open(job_path) as f:
        job = json.load(f)
    panel = int(job.get("panel", 480))
    gap, cap = 10, 30
    rows, results = [], []
    for row in job["rows"]:
        p, res = row_panels(row, panel)
        rows.append((p, row.get("caption", "")))
        results.append(res)
    Wt = max(sum(x.width for x in p) + gap * (len(p) + 1) for p, _ in rows)
    Ht = sum(p[0].height + cap + gap for p, _ in rows) + gap
    sheet = Image.new("RGB", (Wt, Ht), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    y = gap
    for p, caption in rows:
        x = gap
        for pnl in p:
            sheet.paste(pnl, (x, y))
            x += pnl.width + gap
        lines = caption.split("\n")
        for i, ln in enumerate(lines[:2]):
            d.text((gap, y + p[0].height + 2 + 12 * i), ln, fill=(40, 40, 40))
        y += p[0].height + cap + gap
    sheet.save(job["out"])
    print(json.dumps({"rows": results}))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.stderr.write(__doc__)
        sys.exit(2)
    main(sys.argv[1])
