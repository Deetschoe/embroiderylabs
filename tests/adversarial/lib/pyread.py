#!/usr/bin/env python
"""Second, independent reader for the adversarial suite: STOCK pyembroidery (no patches).

    python -B pyread.py <folder> <out.json> [--points]

Reads every *.pes / *.pec / *.dst in <folder> and writes what it finds. Nothing is compared here.
Per file: {"error": str} or
  {"cmds": "SSJT..." (one letter per command: S stitch, J jump, T trim, C colour change, P stop, E end, ? other),
   "xy": [x0, y0, x1, y1, ...] absolute, 0.1 mm, y down (only with --points or for files under 40,000 commands),
   "n": command count, "threads": ["#rrggbb", ...], "bounds": [minx, miny, maxx, maxy] of the stitches,
   "nan": bool}
"""
import io
import json
import math
import os
import sys

import pyembroidery

LETTER = {pyembroidery.STITCH: "S", pyembroidery.JUMP: "J", pyembroidery.TRIM: "T",
          pyembroidery.COLOR_CHANGE: "C", pyembroidery.STOP: "P", pyembroidery.END: "E"}
READ = {".pes": pyembroidery.read_pes, ".pec": pyembroidery.read_pec, ".dst": pyembroidery.read_dst}


def read(path, want_points):
    ext = os.path.splitext(path)[1].lower()
    with open(path, "rb") as f:
        data = f.read()
    p = READ[ext](io.BytesIO(data))
    if p is None:
        return {"error": "reader returned None"}
    cmds = []
    xy = []
    nan = False
    minx = miny = float("inf")
    maxx = maxy = float("-inf")
    for s in p.stitches:
        c = s[2] & 0xFF
        cmds.append(LETTER.get(c, "?"))
        x, y = s[0], s[1]
        if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
            nan = True
        if isinstance(y, float) and (math.isnan(y) or math.isinf(y)):
            nan = True
        xy.append(x)
        xy.append(y)
        if c == pyembroidery.STITCH:
            minx = min(minx, x); maxx = max(maxx, x); miny = min(miny, y); maxy = max(maxy, y)
    out = {"cmds": "".join(cmds), "n": len(cmds), "nan": nan,
           "threads": ["#%06x" % (t.color & 0xFFFFFF) for t in p.threadlist],
           "bounds": None if minx == float("inf") else [minx, miny, maxx, maxy],
           "name": p.extras.get("name")}
    if want_points or len(cmds) <= 40000:
        out["xy"] = xy
    return out


def main():
    folder, target = sys.argv[1], sys.argv[2]
    want_points = "--points" in sys.argv[3:]
    report = {"pyembroidery": getattr(pyembroidery, "__version__", "1.5.0?"), "python": sys.version.split()[0], "files": {}}
    for name in sorted(os.listdir(folder)):
        if os.path.splitext(name)[1].lower() not in READ:
            continue
        try:
            report["files"][name] = read(os.path.join(folder, name), want_points)
        except Exception as e:  # a file pyembroidery cannot read is the finding
            report["files"][name] = {"error": "%s: %s" % (type(e).__name__, e)}
    with open(target, "w") as f:
        json.dump(report, f, separators=(",", ":"))


if __name__ == "__main__":
    main()
