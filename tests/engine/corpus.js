/*
 * Shape corpus and measuring tools shared by the engine suites. Everything here is independent of the
 * engine's own geometry code on purpose: the tests must not grade the engine with its own ruler.
 * Units: millimetres, hoop top-left origin, y down. Points are [x, y].
 */
'use strict';

const OP = { STITCH: 0, JUMP: 1, TRIM: 2, COLOR_CHANGE: 3, END: 4 };

// ---- deterministic random numbers (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- shapes
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const ellipse = (cx, cy, rx, ry, n = 72) => Array.from({ length: n }, (_, i) => [cx + rx * Math.cos(2 * Math.PI * i / n), cy + ry * Math.sin(2 * Math.PI * i / n)]);
const star = (cx, cy, R1, r, n = 5) => Array.from({ length: n * 2 }, (_, i) => { const a = -Math.PI / 2 + Math.PI * i / n, rr = i % 2 ? r : R1; return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)]; });
const pentagram = (cx, cy, r) => [0, 2, 4, 1, 3].map(i => [cx + r * Math.cos(-Math.PI / 2 + 2 * Math.PI * i / 5), cy + r * Math.sin(-Math.PI / 2 + 2 * Math.PI * i / 5)]);

// Closed shapes for fills: name -> { rings, rule }. All fit a 100 x 100 mm hoop with a margin.
const FILL_SHAPES = {
  rect5: { rings: [rect(20, 20, 5, 5)] },
  rect10: { rings: [rect(20, 20, 10, 10)] },
  rect80: { rings: [rect(10, 10, 80, 80)] },
  ellipse40x25: { rings: [ellipse(50, 50, 20, 12.5)] },
  triangle: { rings: [[[50, 12], [88, 85], [12, 85]]] },
  L60: { rings: [[[20, 20], [40, 20], [40, 60], [80, 60], [80, 80], [20, 80]]] },
  U60: { rings: [[[20, 20], [35, 20], [35, 65], [65, 65], [65, 20], [80, 20], [80, 80], [20, 80]]] },
  comb: { rings: [[[20, 20], [30, 20], [30, 65], [45, 65], [45, 20], [55, 20], [55, 65], [70, 65], [70, 20], [80, 20], [80, 80], [20, 80]]] },
  combDown: { rings: [[[20, 20], [80, 20], [80, 80], [70, 80], [70, 35], [55, 35], [55, 80], [45, 80], [45, 35], [30, 35], [30, 80], [20, 80]]] },
  star: { rings: [star(50, 50, 30, 12)] },
  pentagram: { rings: [pentagram(50, 50, 30)] },
  pentagramEvenOdd: { rings: [pentagram(50, 50, 30)], rule: 'evenodd' },
  bowtie: { rings: [[[20, 20], [80, 80], [80, 20], [20, 80]]] },
  donut: { rings: [ellipse(50, 50, 30, 30), ellipse(50, 50, 12, 12).reverse()] },
  donutEvenOdd: { rings: [ellipse(50, 50, 30, 30), ellipse(50, 50, 12, 12)], rule: 'evenodd' },
  frame: { rings: [rect(15, 15, 70, 70), rect(25, 25, 50, 50).reverse()] },
  twoIslands: { rings: [rect(12, 30, 30, 30), ellipse(72, 45, 14, 14)] },
  eight: { rings: [ellipse(50, 50, 22, 32), ellipse(50, 36, 8, 8).reverse(), ellipse(50, 64, 8, 8).reverse()] },
  sliverH: { rings: [rect(10, 40, 80, 1.2)] },
  sliverV: { rings: [rect(40, 10, 1.2, 80)] },
  sliverTri: { rings: [[[10, 50], [90, 51.5], [10, 53]]] },
  zigzag: { rings: [[[10, 20], [25, 60], [40, 20], [55, 60], [70, 20], [85, 60], [85, 80], [10, 80]]] },
};
const HUGE_RECT = { rings: [rect(0.5, 0.5, 99, 99)] };

// Open paths for lines.
const LINE_PATHS = {
  straight: [[10, 10], [90, 60]],
  short: [[10, 10], [11.5, 10]],
  elbow: [[10, 80], [10, 20], [70, 20]],
  hairpin: [[10, 50], [80, 48], [12, 46]],
  wave: Array.from({ length: 81 }, (_, i) => [10 + i, 50 + 15 * Math.sin(i / 6)]),
  spiral: Array.from({ length: 200 }, (_, i) => { const a = i / 8, r = 3 + i * 0.18; return [50 + r * Math.cos(a), 50 + r * Math.sin(a)]; }),
  scribble: (() => { const r = rng(7), p = []; let x = 20, y = 50; for (let i = 0; i < 300; i++) { x = Math.min(90, Math.max(10, x + (r() - 0.45) * 2)); y = Math.min(90, Math.max(10, y + (r() - 0.5) * 2)); p.push([x, y]); } return p; })(),
};

// seeded random polygons: star-shaped (simple) and unconstrained (self-crossing)
function randomPolygon(seed) {
  const r = rng(seed), n = 3 + Math.floor(r() * 14), pts = [];
  if (seed % 3 === 0) { for (let i = 0; i < n; i++) pts.push([12 + r() * 76, 12 + r() * 76]); } // any order: usually self-crossing
  else { const cx = 40 + r() * 20, cy = 40 + r() * 20; for (let i = 0; i < n; i++) { const a = 2 * Math.PI * (i + r() * 0.8) / n, rad = 4 + r() * 30; pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]); } }
  return pts;
}

// ---- geometry (independent implementations)
function inside(p, rings, rule) {
  let w = 0, c = 0;
  for (const r of rings) for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    if ((a[1] <= p[1]) !== (b[1] <= p[1])) { const x = a[0] + (p[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0]); if (x > p[0]) { c++; w += b[1] > a[1] ? 1 : -1; } }
  }
  return rule === 'evenodd' ? (c & 1) === 1 : w !== 0;
}
function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function distToRings(p, rings) {
  let d = Infinity;
  for (const r of rings) for (let i = 0; i < r.length; i++) d = Math.min(d, distToSeg(p, r[i], r[(i + 1) % r.length]));
  return d;
}
function distToPath(p, path, closed) {
  let d = Infinity;
  for (let i = 0; i + 1 < path.length; i++) d = Math.min(d, distToSeg(p, path[i], path[i + 1]));
  if (closed) d = Math.min(d, distToSeg(p, path[path.length - 1], path[0]));
  return d;
}
const rotate = (p, deg) => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]; };

// ---- IR readers
function counts(ir) { const n = [0, 0, 0, 0, 0]; for (let i = 0; i < ir.commands.length; i += 3) n[ir.commands[i]]++; return { STITCH: n[0], JUMP: n[1], TRIM: n[2], COLOR_CHANGE: n[3], END: n[4] }; }
// thread runs: [{ thread, pts: [[x, y] mm, ...] }], one per JUMP..TRIM
function runs(ir) {
  const c = ir.commands, ox = ir.hoop.w / 20, oy = ir.hoop.h / 20, out = [];
  let cur = null, thread = 0;
  for (let i = 0; i < c.length; i += 3) {
    if (c[i] === OP.STITCH) { if (!cur) { cur = { thread, pts: [], units: [] }; out.push(cur); } cur.pts.push([c[i + 1] / 10 + ox, c[i + 2] / 10 + oy]); cur.units.push([c[i + 1], c[i + 2]]); }
    else { cur = null; if (c[i] === OP.COLOR_CHANGE) thread++; }
  }
  return out;
}
// sewn segments in mm: [{ a, b, len }]
function segments(ir) {
  const segs = [];
  for (const r of runs(ir)) for (let i = 1; i < r.pts.length; i++) segs.push({ a: r.pts[i - 1], b: r.pts[i], len: Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]) });
  return segs;
}
// stitches that leave the filled region: a stitch counts when at least 1.0 mm of it lies more than tol outside
function outside(segs, rings, rule, tol = 0.6) {
  let n = 0, worst = 0;
  for (const s of segs) {
    if (!s.len) continue;
    const k = Math.max(1, Math.ceil(s.len / 0.25)); let out = 0;
    for (let i = 0; i < k; i++) { const t = (i + 0.5) / k, p = [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t]; if (!inside(p, rings, rule) && distToRings(p, rings) > tol) out++; }
    const o = out / k * s.len; if (o >= 1.0) { n++; worst = Math.max(worst, o); }
  }
  return { count: n, worstMm: +worst.toFixed(2) };
}
function lengths(segs) {
  let max = 0, min = Infinity, zero = 0, sum = 0;
  for (const s of segs) { if (s.len > max) max = s.len; if (s.len < min) min = s.len; if (s.len === 0) zero++; sum += s.len; }
  return { n: segs.length, max, min: segs.length ? min : 0, zero, sumMm: sum };
}
// Row coverage: share of interior sample points (at least `edge` mm from the outline) that have a sewn row of
// the fill direction within spacing * 0.75. Works on the IR: segments are rotated by -angle so rows are horizontal.
function coverage(segs, rings, rule, spacing, angleDeg, edge = 0.5) {
  const rows = new Map();
  for (const s of segs) {
    const a = rotate(s.a, -angleDeg), b = rotate(s.b, -angleDeg);
    if (Math.abs(a[1] - b[1]) > 0.08 || Math.abs(a[0] - b[0]) < 0.3) continue;   // only stitches lying along the rows
    const k = Math.round((a[1] + b[1]) / 2 * 20);                                   // 0.05 mm bins
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k).push([Math.min(a[0], b[0]), Math.max(a[0], b[0])]);
  }
  const keys = [...rows.keys()].sort((p, q) => p - q);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of rings) for (const p of r) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  let tot = 0, hit = 0; const st = 0.5, reach = spacing * 0.75;
  for (let y = minY + st / 2; y < maxY; y += st) for (let x = minX + st / 2; x < maxX; x += st) {
    const p = [x, y]; if (!inside(p, rings, rule) || distToRings(p, rings) < edge) continue; tot++;
    const q = rotate(p, -angleDeg);
    let lo = 0, hi = keys.length; const want = (q[1] - reach) * 20;
    while (lo < hi) { const m = (lo + hi) >> 1; if (keys[m] < want) lo = m + 1; else hi = m; }
    let ok = false;
    for (let i = lo; i < keys.length && keys[i] / 20 <= q[1] + reach + 0.05; i++) { if (rows.get(keys[i]).some(sp => q[0] >= sp[0] - 0.1 && q[0] <= sp[1] + 0.1)) { ok = true; break; } }
    if (ok) hit++;
  }
  return { samples: tot, pct: tot ? hit / tot * 100 : 100 };
}
// Lock stitches: every run must start and end with the same tiny back-and-forth (p, a, p, a, p), |a - p| <= maxLen.
function lockProblems(ir, maxLenMm = 0.75) {
  const bad = [];
  runs(ir).forEach((r, idx) => {
    const u = r.units, n = u.length;
    const tie = (i0, step) => {
      const p = u[i0], a = u[i0 + step];
      if (n < 5) return 'run of ' + n + ' stitches is too short to hold a lock';
      for (let k = 0; k < 5; k++) { const q = u[i0 + k * step], w = k % 2 ? a : p; if (q[0] !== w[0] || q[1] !== w[1]) return 'no back-and-forth'; }
      const d = Math.hypot(a[0] - p[0], a[1] - p[1]) / 10;
      return d > 0 && d <= maxLenMm ? null : 'lock stitch length ' + d;
    };
    const s = tie(0, 1), e = tie(n - 1, -1);
    if (s) bad.push('run ' + idx + ' start: ' + s);
    if (e) bad.push('run ' + idx + ' end: ' + e);
  });
  return bad;
}

// design builders
const HOOP = { width: 100, height: 100 };
const fillDesign = (shape, fill, extra) => ({ hoop: HOOP, objects: [Object.assign({ type: 'path', rings: shape.rings, fillRule: shape.rule || 'nonzero', color: '#cc3344', paint: 'fill', fill: fill || {} }, extra || {})] });
const lineDesign = (points, line, extra) => ({ hoop: HOOP, objects: [Object.assign({ type: 'polyline', points, color: '#224488', paint: 'line', line: line || {} }, extra || {})] });

module.exports = {
  OP, rng, rect, ellipse, star, pentagram, FILL_SHAPES, HUGE_RECT, LINE_PATHS, randomPolygon,
  inside, distToSeg, distToRings, distToPath, rotate, counts, runs, segments, outside, lengths, coverage, lockProblems,
  HOOP, fillDesign, lineDesign,
};
