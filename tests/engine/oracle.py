#!/usr/bin/env python
"""Reference oracle for the JS embroidery writers (used by oracle.test.js and by run.js --update-golden).

    python -B oracle.py cases.json workdir

cases.json : {"cases": [{"id", "name"?, "threads": [0xRRGGBB, ...], "stitches": [[x, y, cmd], ...],
                          "formats": ["pes", "pes6", "pec", "dst"]}]}
             cmd: 0 STITCH, 1 JUMP, 2 TRIM, 3 STOP, 4 END, 5 COLOR_CHANGE. Absolute coordinates, 1/10 mm, y down.

For every case and format this
  1. writes what pyembroidery produces to   workdir/py/<id>.<format>          (byte comparison), and
  2. if workdir/js/<id>.<format> exists (written by the JS writer), reads THAT file back with pyembroidery
     and records what it finds: needle points, command counts, threads, bounds  (round trip).
Everything is reported in workdir/report.json. Nothing is compared here: the assertions live in the JS suite.

pyembroidery's build_unique_palette walks set(threadlist), i.e. CPython hash order, which depends on the
colour values. The JS port walks the distinct colours in first-occurrence order, so the same rule is
patched in here. Both orders give valid files; they differ only in which of two equally near palette
threads a colour gets when two design colours compete for it.
"""
import io
import json
import os
import sys

import pyembroidery
import pyembroidery.PecWriter as PecWriter
from pyembroidery import EmbPattern, EmbThread

STITCH = 0


def build_unique_palette_ordered(thread_palette, threadlist):
    chart = [None] * len(thread_palette)
    seen = set()
    for thread in threadlist:
        if thread.color & 0xFFFFFF in seen:
            continue
        seen.add(thread.color & 0xFFFFFF)
        index = thread.find_nearest_color_index(thread_palette)
        if index is None:
            break
        thread_palette[index] = None
        chart[index] = thread
    return [thread.find_nearest_color_index(chart) for thread in threadlist]


def build_pattern(case):
    p = EmbPattern()
    if case.get("name") is not None:
        p.metadata("name", case["name"])
    for color in case["threads"]:
        t = EmbThread()
        t.color = int(color) & 0xFFFFFF
        p.add_thread(t)
    for x, y, cmd in case["stitches"]:
        p.add_stitch_absolute(int(cmd), x, y)
    return p


WRITERS = {
    "pes": lambda p, f: pyembroidery.write_pes(p, f),
    "pes6": lambda p, f: pyembroidery.write_pes(p, f, {"pes version": 6}),
    "pec": lambda p, f: pyembroidery.write_pec(p, f),
    "dst": lambda p, f: pyembroidery.write_dst(p, f),
}
READERS = {
    "pes": pyembroidery.read_pes,
    "pes6": pyembroidery.read_pes,
    "pec": pyembroidery.read_pec,
    "dst": pyembroidery.read_dst,
}


def read_back(fmt, data):
    """What pyembroidery finds in a file: the facts the round-trip test compares with the design."""
    p = READERS[fmt](io.BytesIO(data))
    counts = {}
    points = []
    for s in p.stitches:
        c = s[2] & 0xFF
        counts[str(c)] = counts.get(str(c), 0) + 1
        if c == STITCH:
            pt = [int(round(s[0])), int(round(s[1]))]
            if not points or points[-1] != pt:
                points.append(pt)
    xs = [q[0] for q in points] or [0]
    ys = [q[1] for q in points] or [0]
    return {
        "bytes": len(data),
        "threads": [t.color & 0xFFFFFF for t in p.threadlist],
        "counts": counts,
        "points": [v for q in points for v in q],
        "bounds": [min(xs), min(ys), max(xs), max(ys)],
        "name": p.get_metadata("name"),
    }


def pyembroidery_version():
    try:
        from importlib.metadata import version
        return version("pyembroidery")
    except Exception:
        return getattr(pyembroidery, "__version__", None) or "unknown"


def main():
    cases_path, workdir = sys.argv[1], sys.argv[2]
    PecWriter.build_unique_palette = build_unique_palette_ordered
    py_dir, js_dir = os.path.join(workdir, "py"), os.path.join(workdir, "js")
    os.makedirs(py_dir, exist_ok=True)
    with open(cases_path) as f:
        cases = json.load(f)["cases"]
    report = {"pyembroidery": pyembroidery_version(), "python": sys.version.split()[0], "files": {}}
    for case in cases:
        for fmt in case.get("formats", ["pes"]):
            key = "%s.%s" % (case["id"], fmt)
            entry = {}
            try:
                buf = io.BytesIO()
                WRITERS[fmt](build_pattern(case), buf)
                with open(os.path.join(py_dir, key), "wb") as out:
                    out.write(buf.getvalue())
                entry["written"] = len(buf.getvalue())
            except Exception as e:  # recorded, never hidden
                entry["writeError"] = "%s: %s" % (type(e).__name__, e)
            js_path = os.path.join(js_dir, key)
            if os.path.exists(js_path):
                try:
                    with open(js_path, "rb") as f:
                        entry["read"] = read_back(fmt, f.read())
                except Exception as e:
                    entry["readError"] = "%s: %s" % (type(e).__name__, e)
            report["files"][key] = entry
    with open(os.path.join(workdir, "report.json"), "w") as f:
        json.dump(report, f)
    print("oracle: %d files for %d cases" % (len(report["files"]), len(cases)))


if __name__ == "__main__":
    main()
