/*
 * digitize.js - the Embroidery Labs digitizer: plain-data shapes (millimetres) -> stitches.
 *
 * Pure functions, no DOM, no dependencies. Loads as a classic <script> (adds Engine.Digitizer),
 * in a Web Worker (importScripts) and in node (require). Public contract: js/engine/API.md.
 *
 * Geometry is in millimetres (floats, hoop top-left origin, y down). The hand-off IR is an
 * Int32Array of (op, x, y) triples in 0.1 mm integer units with the origin at the hoop centre.
 *
 * Status: measured in node and headless Chrome (tests/), compared against pyembroidery through
 * the writer. NOT sewn on a physical machine.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Engine = root.Engine || {}; root.Engine.Digitizer = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OP = { STITCH: 0, JUMP: 1, TRIM: 2, COLOR_CHANGE: 3, END: 4 };
  const OP_NAME = ['STITCH', 'JUMP', 'TRIM', 'COLOR_CHANGE', 'END'];

  // What an object gets when a parameter is missing (public, documented in API.md).
  const DEFAULTS = {
    hoop: { width: 100, height: 100 },
    color: '#000000',
    fill: { spacing: 0.4, stitchLength: 3.0, angle: 0, underlay: true, pullComp: 0.2 },
    line: { type: 'running', width: 3.0, stitchLength: 2.5, spacing: 0.4, underlay: true },
  };
  // Hard limits. Values outside are clamped (PARAM_CLAMPED) or the object is rejected.
  const LIMITS = {
    coord: 2000,                 // |x|, |y| in mm beyond this is treated as bad input
    hoop: [10, 1000],
    fillSpacing: [0.2, 2.0], fillStitchLength: [1.0, 7.0], pullComp: [0, 1.0],
    lineStitchLength: [1.0, 7.0], satinSpacing: [0.2, 2.0], satinWidth: [1.0, 12.0],
    denseBelow: 0.3,             // row / satin spacing below this raises TOO_DENSE
    satinWideAbove: 9.0,         // satin wider than this raises SATIN_TOO_WIDE
    longStitchAbove: 7.0,        // any sewn stitch longer than this raises STITCH_TOO_LONG
    minStitch: 0.3, maxStitch: 12.1,
    maxFillDensity: 8.0,         // mm of fill thread per mm2 over >= 24 mm2 raises TOO_DENSE (about three stacked fills)
    maxDensity: 15.0,            // mm of any thread per mm2 over >= 24 mm2 raises TOO_DENSE
    objectStitches: 400000,      // a single fill estimated above this is rejected (TOO_LARGE)
    maxStitches: 500000,         // a design with more stitches than this is refused (TOO_MANY_STITCHES); source in API.md
    largeDesign: 100000,         // a design with more stitches than this raises LARGE_DESIGN (still exportable)
  };
  // Internal tuning (not part of the public contract).
  const T = {
    fill: { staggers: 4, underlaySpacing: 2.5, underlayLen: 3.5, underlayInset: 0.6, edgeRunLen: 2.5, travelLen: 3.0, minArea: 1.0, minSpan: 0.3, maxOverSewn: 10.0, sewnPenalty: 6 },
    satin: { pullComp: 0.2, maxWidth: 7.0, splitTarget: 5.0, underlayInset: 0.4, underlayRunLen: 2.0, zigzagUnderlayPitch: 2.5 },
    run: { minLen: 0.6, cornerDeg: 30 },
    lock: { len: 0.6, repeats: 2 },
    connectMax: 2.0,
    time: { spm: 600, trimSec: 6, colorChangeSec: 45 },
    thread: { takeUp: 1.1, tailMm: 50 },
  };

  // ------------------------------------------------------------------ geometry
  const BREAK = { break: true };
  const D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const rot = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }; };
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const finite = p => Number.isFinite(p.x) && Number.isFinite(p.y);
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
  function pushAll(dst, src) { for (let i = 0; i < src.length; i++) dst.push(src[i]); return dst; }

  function cleanPolyline(pts, eps) {
    if (eps === undefined) eps = 0.02;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!p || !finite(p)) continue;
      if (!out.length || D(out[out.length - 1], p) > eps) out.push({ x: p.x, y: p.y });
    }
    return out;
  }
  function cleanRing(pts) {
    const r = cleanPolyline(pts);
    while (r.length > 1 && D(r[0], r[r.length - 1]) <= 0.02) r.pop();
    return r.length >= 3 ? r : null;
  }
  function polyLen(p, closed) {
    let l = 0;
    for (let i = 1; i < p.length; i++) l += D(p[i - 1], p[i]);
    if (closed && p.length > 2) l += D(p[p.length - 1], p[0]);
    return l;
  }
  function distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  // Douglas-Peucker without recursion (freehand paths can have thousands of points).
  function simplify(pts, tol) {
    const n = pts.length;
    if (n < 3) return pts.slice();
    const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
    const stack = [0, n - 1];
    while (stack.length) {
      const b = stack.pop(), a = stack.pop();
      // squared distance to the chord a-b, inlined: this loop is the whole cost on long paths
      const ax = pts[a].x, ay = pts[a].y, dx = pts[b].x - ax, dy = pts[b].y - ay, l2 = dx * dx + dy * dy;
      let worst = -1, wd = tol * tol;
      for (let i = a + 1; i < b; i++) {
        const px = pts[i].x - ax, py = pts[i].y - ay;
        let u = l2 ? (px * dx + py * dy) / l2 : 0; u = u < 0 ? 0 : u > 1 ? 1 : u;
        const ex = px - u * dx, ey = py - u * dy, d = ex * ex + ey * ey;
        if (d > wd) { wd = d; worst = i; }
      }
      if (worst > 0) { keep[worst] = 1; stack.push(a, worst, worst, b); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
    return out;
  }
  function simplifyCollinear(pts, eps) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) { if (distToSeg(pts[i], out[out.length - 1], pts[i + 1]) > eps) out.push(pts[i]); }
    out.push(pts[pts.length - 1]);
    return out;
  }

  // All edges of a set of rings, bucketed by y so a scanline only looks at nearby edges.
  class EdgeIndex {
    constructor(rings) {
      let n = 0;
      for (const r of rings) n += r.length;
      const ax = new Float64Array(n), ay = new Float64Array(n), bx = new Float64Array(n), by = new Float64Array(n);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, k = 0, sumH = 0;
      for (const r of rings) for (let i = 0; i < r.length; i++) {
        const p = r[i], q = r[(i + 1) % r.length];
        ax[k] = p.x; ay[k] = p.y; bx[k] = q.x; by[k] = q.y; k++;
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        sumH += Math.abs(q.y - p.y);
      }
      this.n = n; this.ax = ax; this.ay = ay; this.bx = bx; this.by = by;
      this.minX = minX; this.maxX = maxX; this.minY = minY; this.maxY = maxY;
      const H = maxY - minY;
      let B = Math.max(1, Math.min(4096, n >> 2));
      if (H > 0) { const cover = Math.max(1, sumH / H); B = Math.max(1, Math.min(B, Math.floor(4e6 / cover))); } else B = 1;
      this.B = B; this.h = H > 0 ? H / B : 1;
      const start = new Int32Array(B + 1);
      for (let i = 0; i < n; i++) { const b0 = this.bucket(Math.min(ay[i], by[i])), b1 = this.bucket(Math.max(ay[i], by[i])); for (let b = b0; b <= b1; b++) start[b + 1]++; }
      for (let b = 0; b < B; b++) start[b + 1] += start[b];
      const items = new Int32Array(start[B]), fillAt = start.slice(0, B);
      for (let i = 0; i < n; i++) { const b0 = this.bucket(Math.min(ay[i], by[i])), b1 = this.bucket(Math.max(ay[i], by[i])); for (let b = b0; b <= b1; b++) items[fillAt[b]++] = i; }
      this.start = start; this.items = items;
    }
    bucket(y) { const b = Math.floor((y - this.minY) / this.h); return b < 0 ? 0 : b >= this.B ? this.B - 1 : b; }
    // spans [x1, x2] of the horizontal line y that are inside; rule = 'nonzero' (what canvas fill() shows) or 'evenodd'
    spans(y, rule) {
      if (!(y >= this.minY && y <= this.maxY)) return [];
      const xs = [], b = this.bucket(y), ax = this.ax, ay = this.ay, bx = this.bx, by = this.by, items = this.items;
      for (let j = this.start[b], e = this.start[b + 1]; j < e; j++) {
        const i = items[j], py = ay[i], qy = by[i];
        if ((py <= y) !== (qy <= y)) xs.push([ax[i] + (y - py) / (qy - py) * (bx[i] - ax[i]), qy > py ? 1 : -1]);
      }
      xs.sort((p, q) => p[0] - q[0]);
      const spans = [];
      if (rule === 'evenodd') { for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i][0], xs[i + 1][0]]); }
      else { let w = 0, s = 0; for (let i = 0; i < xs.length; i++) { const pw = w; w += xs[i][1]; if (pw === 0 && w !== 0) s = xs[i][0]; else if (pw !== 0 && w === 0) spans.push([s, xs[i][0]]); } }
      return mergeSpans(spans, 1e-9);
    }
    inside(x, y, rule) {
      if (!(y >= this.minY && y <= this.maxY)) return false;
      let w = 0, c = 0;
      const b = this.bucket(y), ax = this.ax, ay = this.ay, bx = this.bx, by = this.by, items = this.items;
      for (let j = this.start[b], e = this.start[b + 1]; j < e; j++) {
        const i = items[j], py = ay[i], qy = by[i];
        if ((py <= y) !== (qy <= y)) { const xx = ax[i] + (y - py) / (qy - py) * (bx[i] - ax[i]); if (xx > x) { c++; w += qy > py ? 1 : -1; } }
      }
      return rule === 'evenodd' ? (c & 1) === 1 : w !== 0;
    }
    // true when some edge is closer than d to (x, y)
    near(x, y, d) {
      const b0 = this.bucket(y - d), b1 = this.bucket(y + d), ax = this.ax, ay = this.ay, bx = this.bx, by = this.by, items = this.items;
      for (let b = b0; b <= b1; b++) for (let j = this.start[b], e = this.start[b + 1]; j < e; j++) {
        const i = items[j];
        const x1 = ax[i], y1 = ay[i], x2 = bx[i], y2 = by[i];
        if ((x1 < x - d && x2 < x - d) || (x1 > x + d && x2 > x + d) || (y1 < y - d && y2 < y - d) || (y1 > y + d && y2 > y + d)) continue;
        const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
        let t = l2 ? ((x - x1) * dx + (y - y1) * dy) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) < d) return true;
      }
      return false;
    }
  }
  function mergeSpans(spans, tol) {
    const out = [];
    for (let i = 0; i < spans.length; i++) { const s = spans[i], l = out[out.length - 1]; if (l && s[0] <= l[1] + tol) { if (s[1] > l[1]) l[1] = s[1]; } else out.push([s[0], s[1]]); }
    return out;
  }
  function intersectSpans(a, b) {
    const out = []; let i = 0, j = 0;
    while (i < a.length && j < b.length) { const lo = Math.max(a[i][0], b[j][0]), hi = Math.min(a[i][1], b[j][1]); if (hi > lo) out.push([lo, hi]); if (a[i][1] < b[j][1]) i++; else j++; }
    return out;
  }

  // ------------------------------------------------------------------ rows -> regions
  // comp > 0 lengthens every row end (pull compensation); inset > 0 erodes the shape (underlay).
  // Returns { rows, covered } where covered is the plain (no comp, no inset) row-covered area in mm2.
  function buildRows(idx, spacing, opt) {
    const comp = opt.comp || 0, inset = opt.inset || 0, rule = opt.rule || 'nonzero', minSpan = opt.minSpan === undefined ? 0.3 : opt.minSpan;
    // Optional count for the total stitch limit: opt.lbLen (the fill's stitch length) asks for `lowerBound`, a number
    // of stitches these rows cannot sew with fewer than; once it passes opt.lbMax the rows are not kept any more
    // (`over`), only measured. Why it is a lower bound: a row holds its two ends plus one point per stitch length in
    // between; assemble() drops a point closer than 0.3 mm to the last one it kept, which can cost a row its first
    // two points and no more (three points of one row lie at least 0.6 mm apart end to end), so a row keeps at least
    // as many points as it has in between. Rows without any are counted at a quarter (a row can vanish, two rows in
    // a row cannot).
    const lbLen = opt.lbLen || 0, lbMax = opt.lbMax === undefined ? Infinity : opt.lbMax;
    const rows = [];
    let covered = 0, hitRows = 0, nSpans = 0, inner = 0, over = false;
    const usable = idx.maxY - idx.minY - 2 * inset;
    if (!(usable > 0)) return { rows, covered, hitRows, lowerBound: 0, over };
    // centre the row lattice in the shape: equal margin (< spacing/2) at both edges, never exactly on a vertex row
    const n = Math.max(1, Math.round(usable / spacing));
    const y0 = idx.minY + inset + (usable - (n - 1) * spacing) / 2;
    for (let k = 0; k < n; k++) {
      const y = y0 + k * spacing + 1e-7;
      let sp = idx.spans(y, rule);
      if (sp.length) { hitRows++; for (let i = 0; i < sp.length; i++) covered += (sp[i][1] - sp[i][0]) * spacing; }
      if (over) continue;
      if (inset > 0) {
        sp = intersectSpans(sp, idx.spans(y - inset, rule));
        sp = intersectSpans(sp, idx.spans(y + inset, rule));
        for (let i = 0; i < sp.length; i++) { sp[i][0] += inset; sp[i][1] -= inset; }
      } else if (comp > 0) {
        for (let i = 0; i < sp.length; i++) { sp[i][0] -= comp; sp[i][1] += comp; }
        sp = mergeSpans(sp, 0.2); // gaps narrower than 0.2 mm after compensation are closed
      }
      const list = [];
      for (let i = 0; i < sp.length; i++) if (sp[i][1] - sp[i][0] >= minSpan) list.push({ x1: sp[i][0], x2: sp[i][1], k, y, up: [], down: [], region: null, sewn: false, id: -1, comp: -1 });
      rows.push({ k, y, spans: list });
      if (lbLen) {
        nSpans += list.length;
        for (let i = 0; i < list.length; i++) { const m = Math.ceil((list[i].x2 - list[i].x1 - 0.6 * lbLen) / lbLen) - 1; if (m > 0) inner += m; }
        if (inner + (nSpans >> 2) > lbMax) { over = true; rows.length = 0; }
      }
    }
    const lowerBound = inner + (nSpans >> 2);
    if (over) return { rows, covered, hitRows, lowerBound, over };
    // links between overlapping spans of neighbouring rows (both lists are sorted by x)
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1].spans, cur = rows[i].spans; let j0 = 0;
      for (const s of cur) {
        while (j0 < prev.length && prev[j0].x2 <= s.x1) j0++;
        for (let j = j0; j < prev.length && prev[j].x1 < s.x2; j++) { const p = prev[j]; if (Math.min(p.x2, s.x2) - Math.max(p.x1, s.x1) > 0) { s.up.push(p); p.down.push(s); } }
      }
    }
    return { rows, covered, hitRows, lowerBound, over };
  }
  // A region = maximal run of rows where each span continues exactly one span above (1:1). Splits, merges
  // and holes start new regions, so a region can always be sewn as one unbroken boustrophedon.
  function buildRegions(rows) {
    const regions = [];
    for (const row of rows) for (const s of row.spans) {
      if (s.up.length === 1 && s.up[0].down.length === 1) s.region = s.up[0].region;
      else { s.region = { id: regions.length, spans: [], sewn: false }; regions.push(s.region); }
      s.region.spans.push(s);
    }
    return regions;
  }

  // ------------------------------------------------------------------ travel inside the shape
  // Graph: node = one row span of the TOP fill, edge = overlap with a span in the next row. Any path through
  // this graph stays inside the shape, so travel never crosses a gap or a hole.
  class Router {
    constructor(rows, spacing) {
      this.rows = rows; this.spacing = spacing; this.all = [];
      for (const r of rows) for (const s of r.spans) { s.id = this.all.length; this.all.push(s); }
      const n = this.all.length;
      this.dist = new Float64Array(n); this.prev = new Int32Array(n); this.seen = new Int32Array(n); this.done = new Int32Array(n); this.epoch = 0;
      // connected components (separate islands need a trim and a jump)
      let nc = 0;
      for (const s0 of this.all) {
        if (s0.comp !== -1) continue;
        const q = [s0]; s0.comp = nc;
        while (q.length) { const s = q.pop(); for (const t of s.up) if (t.comp === -1) { t.comp = nc; q.push(t); } for (const t of s.down) if (t.comp === -1) { t.comp = nc; q.push(t); } }
        nc++;
      }
      this.components = nc;
    }
    locate(p) {
      let best = null, bd = Infinity;
      const rows = this.rows;
      if (!rows.length) return null;
      const k0 = clamp(Math.round((p.y - rows[0].y) / this.spacing), 0, rows.length - 1);
      for (let dk = 0; dk <= rows.length; dk++) {
        for (let side = 0; side < (dk ? 2 : 1); side++) {
          const row = rows[side ? k0 + dk : k0 - dk]; if (!row) continue;
          const dy = Math.abs(row.y - p.y);
          for (const s of row.spans) { const dx = p.x < s.x1 ? s.x1 - p.x : p.x > s.x2 ? p.x - s.x2 : 0; const d = Math.hypot(dx, dy); if (d < bd) { bd = d; best = s; } }
        }
        if (best && (dk * this.spacing > bd || bd === 0)) break;
      }
      return best;
    }
    // Dijkstra from span src; stepping onto an already-sewn span costs sewnPenalty so travel prefers areas
    // that will be covered later. Stops early once targetId is settled.
    dijkstra(src, sewnPenalty, targetId) {
      const ep = ++this.epoch, dist = this.dist, prev = this.prev, seen = this.seen, done = this.done, all = this.all;
      const heap = [];
      const push = (d, id) => { heap.push([d, id]); let i = heap.length - 1; while (i > 0) { const j = (i - 1) >> 1; if (heap[j][0] <= heap[i][0]) break; const t = heap[i]; heap[i] = heap[j]; heap[j] = t; i = j; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { let m = i; const l = 2 * i + 1, r = l + 1; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; const t = heap[i]; heap[i] = heap[m]; heap[m] = t; i = m; } } return top; };
      dist[src.id] = 0; prev[src.id] = -1; seen[src.id] = ep; push(0, src.id);
      const relax = (t, d, from) => { const nd = d + (t.sewn ? sewnPenalty : 1); if (seen[t.id] !== ep || nd < dist[t.id]) { dist[t.id] = nd; prev[t.id] = from; seen[t.id] = ep; push(nd, t.id); } };
      while (heap.length) {
        const top = pop(), d = top[0], id = top[1];
        if (done[id] === ep) continue; done[id] = ep;
        if (id === targetId) break;
        const s = all[id];
        for (let i = 0; i < s.up.length; i++) relax(s.up[i], d, id);
        for (let i = 0; i < s.down.length; i++) relax(s.down[i], d, id);
      }
      return ep;
    }
    // polyline (top frame) from point a (in span sa) to point b (in span sb) after dijkstra(sa, .., sb.id)
    path(a, sa, b, sb, margin) {
      if (margin === undefined) margin = 0.5;
      const ep = this.epoch, prev = this.prev, chain = [];
      if (this.seen[sb.id] !== ep) return null; // disconnected (separate islands): caller must trim + jump
      for (let id = sb.id; id !== -1; id = prev[id]) { chain.push(this.all[id]); if (id === sa.id) break; }
      if (chain[chain.length - 1] !== sa) return null;
      chain.reverse();
      const pts = [{ x: a.x, y: a.y }], n = chain.length - 1;
      let over = 0;
      for (let i = 1; i <= n; i++) {
        const p = chain[i - 1], s = chain[i];
        let lo = Math.max(p.x1, s.x1), hi = Math.min(p.x2, s.x2);
        if (hi - lo > 2 * margin) { lo += margin; hi -= margin; } else lo = hi = (lo + hi) / 2;
        const x = clamp(a.x + (b.x - a.x) * i / n, lo, hi);
        pts.push({ x, y: p.y }, { x, y: s.y });
        if (s.sewn) over += this.spacing; // rows of finished fill crossed at right angles: the visible kind of travel
      }
      pts.push({ x: b.x, y: b.y });
      const out = simplifyCollinear(pts, 0.05);
      out.overSewnMm = over;
      return out;
    }
  }

  // ------------------------------------------------------------------ running stitch
  // Corners (turn > cornerDeg) always get a needle point; between corners points are spread evenly, so no
  // stitch is longer than `len` and none is shorter than ~len/2 unless the corner-to-corner piece itself is.
  function runStitch(poly, len, opt) {
    opt = opt || {};
    const cornerDeg = opt.cornerDeg === undefined ? T.run.cornerDeg : opt.cornerDeg, minLen = opt.minLen === undefined ? T.run.minLen : opt.minLen;
    const p = cleanPolyline(poly);
    if (opt.closed && p.length > 2 && D(p[0], p[p.length - 1]) > 0.02) p.push({ x: p[0].x, y: p[0].y });
    if (p.length < 2) return p;
    // A corner becomes a needle point only when it is at least minLen along the path from the previous one
    // (and from the end): a noisy path then gives stitches that follow it instead of a pile of tiny ones.
    const along = new Float64Array(p.length);
    for (let i = 1; i < p.length; i++) along[i] = along[i - 1] + D(p[i - 1], p[i]);
    const anchors = [0], end = p.length - 1;
    for (let i = 1; i < end; i++) {
      const a1 = Math.atan2(p[i].y - p[i - 1].y, p[i].x - p[i - 1].x), a2 = Math.atan2(p[i + 1].y - p[i].y, p[i + 1].x - p[i].x);
      let t = Math.abs(a2 - a1); if (t > Math.PI) t = 2 * Math.PI - t;
      if (t * 180 / Math.PI > cornerDeg && along[i] - along[anchors[anchors.length - 1]] >= minLen) anchors.push(i);
    }
    while (anchors.length > 1 && along[end] - along[anchors[anchors.length - 1]] < minLen) anchors.pop();
    anchors.push(end);
    const out = [p[0]];
    for (let a = 0; a + 1 < anchors.length; a++) {
      const i0 = anchors[a], i1 = anchors[a + 1], m = i1 - i0 + 1;
      let L = 0; const cum = new Float64Array(m);
      for (let i = 1; i < m; i++) { L += D(p[i0 + i - 1], p[i0 + i]); cum[i] = L; }
      const n = Math.max(1, Math.ceil(L / len - 1e-9)); let j = 1;
      for (let i = 1; i <= n; i++) {
        const t = L * i / n; while (j < m - 1 && cum[j] < t) j++;
        const f = cum[j] === cum[j - 1] ? 0 : (t - cum[j - 1]) / (cum[j] - cum[j - 1]);
        out.push(lerp(p[i0 + j - 1], p[i0 + j], f));
      }
    }
    return cleanPolyline(out, 0.05);
  }
  function bean(pts, repeats) { // repeats = 1 plain, 3 triple (forward, back, forward)
    if (repeats <= 1 || pts.length < 2) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) { for (let r = 0; r < repeats; r++) out.push(r % 2 === 0 ? pts[i] : pts[i - 1]); }
    return out;
  }

  // A number of stitches a line cannot sew with fewer than (for the total stitch limit). Only its long straight
  // pieces are counted: on a straight piece needle points sit `step` or less apart and at least 0.5 mm apart, so
  // assemble() keeps them all but perhaps the first. Short, crumpled pieces count as nothing.
  function lineLowerBound(pts, closed, step, repeats) {
    let n = 0;
    for (let i = 1, e = pts.length + (closed && pts.length > 2 ? 1 : 0); i < e; i++) { const m = Math.floor(D(pts[i - 1], pts[i % pts.length]) / step) - 2; if (m > 0) n += m; }
    return Math.max(0, n * repeats - 8);
  }

  // ------------------------------------------------------------------ fill patterns
  // A pattern is where the needle lands from one row to the next (staggers = how many rows before the needle
  // points line up again), or a second pass across the first (cross). 'smooth' is the default and is exactly the
  // fill the engine has always made.
  const FILL_PATTERNS = {
    smooth:     { label: 'Smooth' },
    brick:      { label: 'Brick', staggers: 2 },
    ribbed:     { label: 'Ribbed', staggers: 1 },
    diagonal:   { label: 'Diagonal', staggers: 8 },
    crosshatch: { label: 'Crosshatch', cross: true },
  };

  // ------------------------------------------------------------------ tatami fill
  function tatamiRow(span, L, staggers, dir, out) {
    const phase = ((span.k % staggers) / staggers) * L, minEnd = L * 0.3, at = out.length;
    out.push({ x: span.x1, y: span.y });
    for (let x = phase + Math.ceil((span.x1 + minEnd - phase) / L) * L; x < span.x2 - minEnd; x += L) out.push({ x, y: span.y });
    out.push({ x: span.x2, y: span.y });
    // The first and last stitch of a row are up to 1.3 L long, and a row that holds a single stitch up to 1.6 L.
    // With a long stitch length (over about 4.3 mm) that is more than the 7 mm a stitch may be, so those are divided.
    const cap = rowCap(L);
    for (let i = out.length - 1; i > at; i--) {
      const x0 = out[i - 1].x, d = out[i].x - x0; if (!(d > cap + 1e-9)) continue;
      const n = Math.ceil(d / cap), add = [];
      for (let k = 1; k < n; k++) add.push({ x: x0 + d * k / n, y: span.y });
      out.splice.apply(out, [i, 0].concat(add));
    }
    if (dir < 0) { for (let i = at, j = out.length - 1; i < j; i++, j--) { const t = out[i]; out[i] = out[j]; out[j] = t; } }
    return at;
  }
  // longest stitch a fill row may hold: the asked stitch length, or just under the long-stitch limit (the margin
  // covers what snapping to the 0.1 mm grid can add)
  function rowCap(L) { return Math.max(L, LIMITS.longStitchAbove - 0.15); }
  // points to insert between the end of one row and the start of the next when the outline steps sideways
  function rowConnector(last, first, prevSpan, span, L, out) {
    const dx = first.x - last.x; if (Math.abs(dx) <= L * 1.2 && Math.hypot(dx, first.y - last.y) <= rowCap(L)) return;
    // The sideways stretch is walked on whichever of the two rows contains it:
    //   next row reaches further      -> drop to the next row first, then walk out to its end
    //   previous row reached further  -> walk back along the previous row, then drop
    const onNext = last.x >= span.x1 - 1e-6 && last.x <= span.x2 + 1e-6;
    const y = onNext ? span.y : prevSpan.y, n = Math.ceil(Math.abs(dx) / L);
    for (let i = onNext ? 0 : 1; i <= (onNext ? n - 1 : n); i++) out.push({ x: last.x + dx * i / n, y });
  }
  function regionCorners(reg) {
    const a = reg.spans[0], b = reg.spans[reg.spans.length - 1], n = reg.spans.length;
    const mk = (span, x, down, dir) => { // exit corner follows from row-count parity
      const lastSpan = down ? b : a, lastDir = (n - 1) % 2 === 0 ? dir : -dir;
      return { span, pt: { x, y: span.y }, down, dir, exit: { x: lastDir > 0 ? lastSpan.x2 : lastSpan.x1, y: lastSpan.y } };
    };
    return [mk(a, a.x1, true, 1), mk(a, a.x2, true, -1), mk(b, b.x1, false, 1), mk(b, b.x2, false, -1)];
  }
  function sewRegion(reg, c, L, staggers, out) {
    const spans = reg.spans, n = spans.length; let dir = c.dir, prev = null;
    for (let i = 0; i < n; i++) {
      const s = c.down ? spans[i] : spans[n - 1 - i];
      const row = []; tatamiRow(s, L, staggers, dir, row);
      if (prev) rowConnector(out[out.length - 1], row[0], prev, s, L, out);
      pushAll(out, row); s.sewn = true; prev = s; dir = -dir;
    }
    reg.sewn = true;
  }
  // inside-the-shape travel from cur to target (both in the top frame). Returns false when the caller must
  // tie off, trim and jump instead (separate island, or the path would cross too much finished fill).
  function travel(router, cur, target, o, stats, out, maxOver) {
    if (D(cur, target) < 0.05) return true;
    const s = router.locate(cur), t = router.locate(target);
    let pl = null;
    if (s && t && s.comp === t.comp) { router.dijkstra(s, o.sewnPenalty, t.id); pl = router.path(cur, s, target, t); }
    if (!pl || pl.overSewnMm > maxOver) { out.push(BREAK); stats.breaks++; return false; }
    const run = runStitch(pl, o.travelLen, { cornerDeg: 20, minLen: 0.3 });
    stats.travelMm += polyLen(pl); stats.travelOverSewnMm += pl.overSewnMm;
    for (let i = 1; i < run.length - 1; i++) out.push(run[i]);
    return true;
  }
  // Sews every region in `regions` (row frame of their own; toTop converts to the router's frame).
  // Order: depth-first over the region graph, sewing a region only after everything hanging off it is done
  // (post-order). Travel to the next region therefore runs through regions that are still unsewn and gets
  // covered later, instead of lying on top of finished fill.
  function sewRegions(regions, L, staggers, router, o, cur, toTop, stats, maxOver) {
    const out = [], regs = [];
    for (const r of regions) if (r.spans.length) regs.push(r);
    for (const reg of regs) {
      reg.visited = false; reg.parent = null; reg.sewn = false;
      reg.corners = regionCorners(reg);
      for (const c of reg.corners) { c.ptTop = toTop(c.pt); c.exTop = toTop(c.exit); }
      const adj = [], a = reg.spans[0], b = reg.spans[reg.spans.length - 1];
      const add = t => { if (t.region && t.region !== reg && adj.indexOf(t.region) < 0) adj.push(t.region); };
      a.up.forEach(add); a.down.forEach(add); b.up.forEach(add); b.down.forEach(add);
      reg.adj = adj;
    }
    const cornerDist = (reg, p) => { let m = Infinity; for (const c of reg.corners) { const d = D(c.ptTop, p); if (d < m) m = d; } return m; };
    const exitCost = (reg, c) => {
      if (!reg.parent) return 0;
      const span = c.down ? reg.spans[reg.spans.length - 1] : reg.spans[0], links = c.down ? span.down : span.up;
      let best = Infinity;
      for (const t of links) if (t.region === reg.parent) { const lo = Math.max(span.x1, t.x1), hi = Math.min(span.x2, t.x2), d = c.exit.x < lo ? lo - c.exit.x : c.exit.x > hi ? c.exit.x - hi : 0; if (d < best) best = d; }
      return best === Infinity ? 0 : best;
    };
    const pickCorner = reg => {
      let cands = reg.corners;
      if (reg.parent && reg.spans.length > 1) {
        const a = reg.spans[0], b = reg.spans[reg.spans.length - 1];
        const top = a.up.some(t => t.region === reg.parent), bot = b.down.some(t => t.region === reg.parent);
        if (top && !bot) cands = [reg.corners[2], reg.corners[3]];      // finish on the row that touches the parent
        else if (bot && !top) cands = [reg.corners[0], reg.corners[1]];
      }
      let best = cands[0], bc = Infinity;
      for (const c of cands) { const cost = (cur ? D(cur, c.ptTop) : 0) + exitCost(reg, c); if (cost < bc - 1e-9) { bc = cost; best = c; } }
      return best;
    };
    let left = regs.length, scan = 0;
    while (left > 0) {
      let rootReg = null;
      if (cur) { let bd = Infinity; for (const reg of regs) if (!reg.visited) { const d = cornerDist(reg, cur); if (d < bd) { bd = d; rootReg = reg; } } }
      else { while (regs[scan].visited) scan++; rootReg = regs[scan]; }
      rootReg.visited = true;
      const stack = [rootReg];
      while (stack.length) {
        const r = stack[stack.length - 1];
        let nb = null, bd = Infinity;
        for (const t of r.adj) if (!t.visited && t.adj) { const d = cur ? cornerDist(t, cur) : 0; if (d < bd) { bd = d; nb = t; } }
        if (nb) { nb.visited = true; nb.parent = r; stack.push(nb); continue; }
        stack.pop();
        const c = pickCorner(r);
        if (cur) travel(router, cur, c.ptTop, o, stats, out, maxOver);
        const seg = []; sewRegion(r, c, L, staggers, seg);
        for (let i = 0; i < seg.length; i++) out.push(toTop(seg[i]));
        cur = out[out.length - 1];
        left--;
      }
    }
    return out;
  }

  // Edge-walk underlay: the outline moved inwards by `inset`. Every edge is sampled (its mitre points and
  // every ~1 mm), each sample is pushed along the edge normal and kept only if it is really inside and far
  // enough from every edge. Short gaps (corners) are bridged; long gaps start a new chain.
  function edgeWalk(rings, idx, inset, rule, runLen) {
    const chains = [], minD = inset * 0.85;
    const offset = (p, tx, ty) => {
      for (let sgn = 1; sgn >= -1; sgn -= 2) {
        const x = p.x - sgn * ty * inset, y = p.y + sgn * tx * inset;
        if (idx.inside(x, y, rule) && !idx.near(x, y, minD)) return { x, y };
      }
      return null;
    };
    for (const r of rings) {
      const n = r.length, cand = [];
      for (let i = 0; i < n; i++) {
        const a = r[i], b = r[(i + 1) % n], z = r[(i - 1 + n) % n], c = r[(i + 2) % n];
        const L = D(a, b); if (!(L > 0)) continue;
        const tx = (b.x - a.x) / L, ty = (b.y - a.y) / L;
        // the vertex itself, pushed along the bisector (gives the rounded join on reflex corners)
        const lz = D(z, a) || 1, bxs = tx + (a.x - z.x) / lz, bys = ty + (a.y - z.y) / lz, bl = Math.hypot(bxs, bys);
        if (bl > 1e-6) { const o0 = offset(a, bxs / bl, bys / bl); if (o0) cand.push(o0); }
        // samples along the edge: mitre point after the start corner, regular steps, mitre point before the end corner
        const ts = [], mitre = (ux, uy, vx, vy) => { // distance along the edge at which the offset line meets the neighbour's
          const dot = clamp(ux * vx + uy * vy, -1, 1), ang = Math.PI - Math.acos(dot); // interior-ish angle between the edges
          const d = inset / Math.tan(ang / 2); return d > 0 && d < L / 2 ? d : -1;
        };
        const d0 = mitre(tx, ty, (a.x - z.x) / lz, (a.y - z.y) / lz), lc = D(b, c) || 1, d1 = mitre(tx, ty, (c.x - b.x) / lc, (c.y - b.y) / lc);
        if (d0 > 0) ts.push(d0);
        const steps = Math.max(1, Math.ceil(L / 1.0));
        for (let j = 1; j < steps; j++) { const t = L * j / steps; if ((d0 < 0 || t > d0 + 0.2) && (d1 < 0 || t < L - d1 - 0.2)) ts.push(t); }
        if (d1 > 0) ts.push(L - d1);
        for (const t of ts) { const o1 = offset({ x: a.x + tx * t, y: a.y + ty * t }, tx, ty); cand.push(o1); }
      }
      // chain the accepted samples; null = rejected sample
      let chain = [];
      const flush = () => { if (chain.length > 2 && polyLen(chain) >= 2.0) chains.push(chain); chain = []; };
      const feed = p => {
        if (!p) return;
        if (chain.length) {
          const q = chain[chain.length - 1], d = D(q, p);
          if (d < 0.05) return;
          if (d > 2.5 || !idx.inside((q.x + p.x) / 2, (q.y + p.y) / 2, rule) || idx.near((q.x + p.x) / 2, (q.y + p.y) / 2, inset * 0.4)) flush();
        }
        chain.push(p);
      };
      let first = null;
      for (const p of cand) { if (p && !first) first = p; feed(p); }
      if (first && chain.length && chain[0] === first) feed({ x: first.x, y: first.y }); // close the loop when it never broke
      else if (first && chains.length && chain.length) { // the loop broke somewhere: join the tail to the head chain if they meet
        feed({ x: first.x, y: first.y });
      }
      flush();
    }
    const out = [];
    for (const c of chains) { const run = runStitch(c, runLen, { cornerDeg: 30 }); if (run.length >= 2) out.push(run); }
    return out;
  }

  // rings: array of closed polylines in mm (outer boundaries and holes, any orientation).
  // Returns { points: [{x,y} | BREAK], stats, skipped? }.
  function fillShape(ringsIn, opt) {
    const o = Object.assign({ spacing: 0.4, stitchLen: 3.0, angleDeg: 0, pullComp: 0.2, rule: 'nonzero', underlay: true, edgeWalk: true }, T.fill, opt || {});
    const stats = { travelMm: 0, travelOverSewnMm: 0, breaks: 0, regions: 0, components: 0, underlayPts: 0, rows: 0, coveredMm2: 0, thin: false };
    // Stitch points are snapped to the 0.1 mm grid afterwards, which can lengthen a stitch by up to 0.14 mm. A stitch
    // length at the long-stitch limit is therefore sewn slightly shorter, so that no fill stitch ends up over the limit
    // (and a legal setting does not raise STITCH_TOO_LONG).
    o.stitchLen = Math.min(o.stitchLen, LIMITS.longStitchAbove - 0.15);
    const a = o.angleDeg * Math.PI / 180, rings = [];
    for (const r of ringsIn) { const c = cleanRing(r); if (c) { for (let i = 0; i < c.length; i++) c[i] = rot(c[i], -a); rings.push(c); } } // top frame: rows horizontal
    if (!rings.length) return { points: [], stats, skipped: 'NO_VALID_RING' };
    const idx = new EdgeIndex(rings);
    // area is measured from the rows themselves (a self-crossing ring such as a bow-tie has signed area 0 but is fillable)
    // o.maxStitches (optional): what is left of the design's stitch limit. A fill that cannot fit is not built.
    const built = buildRows(idx, o.spacing, { comp: o.pullComp, rule: o.rule, minSpan: o.minSpan, lbLen: o.stitchLen, lbMax: o.maxStitches });
    stats.coveredMm2 = built.covered; stats.rows = built.hitRows;
    if (built.covered < o.minArea) return { points: [], stats, skipped: 'TOO_SMALL' };
    if (built.covered / (o.spacing * o.stitchLen) > LIMITS.objectStitches) return { points: [], stats, skipped: 'TOO_LARGE' };
    if (built.over) return { points: [], stats, skipped: 'OVER_LIMIT', lowerBound: built.lowerBound };
    stats.thin = built.hitRows > 0 && built.covered / (built.hitRows * o.spacing) < 1.0;
    const topRows = built.rows, topRegions = buildRegions(topRows); stats.regions = topRegions.length;
    if (!topRegions.length) return { points: [], stats, skipped: 'TOO_SMALL' };
    const router = new Router(topRows, o.spacing), nc = router.components; stats.components = nc;
    const ident = p => p;

    // split everything by island so each island is finished (underlay + top) before the thread is cut
    const comps = [];
    for (let i = 0; i < nc; i++) comps.push({ id: i, regions: [], chains: [], uRegions: [], minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, entry: null, done: false });
    for (const reg of topRegions) {
      const c = comps[reg.spans[0].comp]; c.regions.push(reg);
      for (const s of reg.spans) { if (s.x1 < c.minX) c.minX = s.x1; if (s.x2 > c.maxX) c.maxX = s.x2; if (s.y < c.minY) c.minY = s.y; if (s.y > c.maxY) c.maxY = s.y; }
      if (!c.entry) c.entry = { x: reg.spans[0].x1, y: reg.spans[0].y };
    }
    const q = Math.PI / 2, toTopU = p => rot(p, q);
    if (o.underlay) {
      const minDim = 2 * o.underlayInset + 1.5;
      for (const c of comps) c.big = Math.max(c.maxX - c.minX, c.maxY - c.minY) >= minDim;
      if (comps.some(c => c.big)) {
        if (o.edgeWalk) for (const chain of edgeWalk(rings, idx, o.underlayInset, o.rule, o.edgeRunLen)) { const s = router.locate(chain[0]); if (s && comps[s.comp].big) comps[s.comp].chains.push(chain); }
        // tatami underlay at 90 degrees to the top fill, eroded by the inset, no pull compensation
        const uRings = rings.map(r => r.map(p => rot(p, -q))), uIdx = new EdgeIndex(uRings);
        const uRegs = buildRegions(buildRows(uIdx, o.underlaySpacing, { inset: o.underlayInset, rule: o.rule, minSpan: 1.0 }).rows);
        for (const reg of uRegs) { const s0 = reg.spans[0], s = router.locate(toTopU({ x: (s0.x1 + s0.x2) / 2, y: s0.y })); if (s && comps[s.comp].big) comps[s.comp].uRegions.push(reg); else reg.adj = null; }
      }
    }

    const pts = [];
    let cur = null, end = null;
    for (let done = 0; done < nc; done++) {
      // next island: the first one, then always the nearest to where the needle is
      let comp = null;
      if (!end) comp = comps[0];
      else { let bd = Infinity; for (const c of comps) if (!c.done) { const d = D(c.entry, end); if (d < bd) { bd = d; comp = c; } } }
      comp.done = true;
      if (pts.length) pts.push(BREAK);
      cur = null;
      const at = pts.length;
      // 1. edge-walk underlay
      const chains = comp.chains.slice();
      while (chains.length) {
        let bi = 0;
        if (cur) { let bd = Infinity; for (let i = 0; i < chains.length; i++) { const d = D(chains[i][0], cur); if (d < bd) { bd = d; bi = i; } } }
        const chain = chains.splice(bi, 1)[0];
        if (cur) travel(router, cur, chain[0], o, stats, pts, Infinity);
        pushAll(pts, chain); cur = pts[pts.length - 1];
      }
      // 2. tatami underlay
      if (comp.uRegions.length) {
        const u = sewRegions(comp.uRegions, o.underlayLen, 2, router, o, cur, toTopU, stats, Infinity);
        pushAll(pts, u); if (u.length) cur = pts[pts.length - 1];
      }
      stats.underlayPts += pts.length - at;
      // 3. top fill
      const top = sewRegions(comp.regions, o.stitchLen, o.staggers, router, o, cur, ident, stats, o.maxOverSewn);
      pushAll(pts, top);
      for (let i = pts.length - 1; i >= 0; i--) if (!pts[i].break) { end = pts[i]; break; }
    }
    for (let i = 0; i < pts.length; i++) if (!pts[i].break) pts[i] = rot(pts[i], a);
    return { points: pts, stats, lowerBound: built.lowerBound };
  }

  // ------------------------------------------------------------------ satin column
  // centre: polyline in mm. Rungs pivot around each corner vertex (round outer join); the inner ends of the
  // pivot rungs are shortened alternately so needle points do not pile up. Over-wide rungs are split.
  function satinLine(centreIn, width, opt) {
    const o = Object.assign({ spacing: 0.4, closed: false, underlay: true, stitchLen: 2.5 }, T.satin, opt || {});
    const closed = !!o.closed;
    let c = cleanPolyline(centreIn);
    if (closed) while (c.length > 2 && D(c[0], c[c.length - 1]) <= 0.02) c.pop();
    if (c.length < 2) return { points: [], kind: 'empty' };
    if (width < LIMITS.satinWidth[0]) return { points: bean(runStitch(c, o.stitchLen, { closed }), 3), kind: 'bean' };
    const w = width + 2 * o.pullComp;
    if (closed) { // start in the middle of the longest edge so the seam is not on a corner
      let bi = 0, bl = -1;
      for (let i = 0; i < c.length; i++) { const l = D(c[i], c[(i + 1) % c.length]); if (l > bl) { bl = l; bi = i; } }
      const mid = lerp(c[bi], c[(bi + 1) % c.length], 0.5), re = [mid];
      for (let i = bi + 1; i < c.length; i++) re.push(c[i]);
      for (let i = 0; i <= bi; i++) re.push(c[i]);
      re.push({ x: mid.x, y: mid.y });
      c = cleanPolyline(re);
      if (c.length < 2) return { points: [], kind: 'empty' };
    }
    const h = w / 2, half = o.spacing / 2, rungs = []; // one rung per needle point: centre c, unit normal n, side alternates
    const segN = i => { const dx = c[i + 1].x - c[i].x, dy = c[i + 1].y - c[i].y, l = Math.hypot(dx, dy) || 1; return { x: -dy / l, y: dx / l }; };
    const nSeg = c.length - 1; let carry = 0;
    const fan = (v, n0, n1) => {
      const th = Math.atan2(n0.x * n1.y - n0.y * n1.x, n0.x * n1.x + n0.y * n1.y), steps = Math.ceil(Math.abs(th) * h / half);
      for (let s = 1; s < steps; s++) rungs.push({ c: v, n: rot(n0, th * s / steps), fan: true, inner: th > 0 ? -1 : 1 });
    };
    for (let i = 0; i < nSeg; i++) {
      const n = segN(i), L = D(c[i], c[i + 1]);
      if (i > 0) fan(c[i], segN(i - 1), n);
      let t = carry; for (; t <= L + 1e-9; t += half) rungs.push({ c: lerp(c[i], c[i + 1], t / L), n });
      carry = t - L;
    }
    if (closed) { // overlap the seam by four rungs
      fan(c[0], segN(nSeg - 1), segN(0));
      const l0 = D(c[0], c[1]);
      for (let k = 0; k < 4; k++) rungs.push({ c: lerp(c[0], c[1], Math.min(1, (k + 1) * half / l0)), n: segN(0) });
    }
    if (rungs.length < 2) return { points: bean(runStitch(c, o.stitchLen, { closed }), 3), kind: 'bean' };
    const side = (r, s, k) => ({ x: r.c.x + r.n.x * h * s * k, y: r.c.y + r.n.y * h * s * k });
    const top = []; let short = 0;
    for (let j = 0; j < rungs.length; j++) { const r = rungs[j], s = j % 2 ? -1 : 1; let k = 1; if (r.fan && r.inner === s) k = (short++ % 2) ? 0.75 : 0.5; top.push(side(r, s, k)); }
    // split over-wide stitches, staggering the split points so they do not form a groove
    const stag = [0, 0.33, -0.33];
    const splitLong = list => {
      const res = [];
      for (let j = 0; j < list.length; j++) {
        const p = list[j];
        if (j) { const p0 = list[j - 1], len = D(p0, p); if (len > o.maxWidth) { const n = Math.ceil(len / o.splitTarget); for (let m = 1; m < n; m++) res.push(lerp(p0, p, (m + stag[j % 3] * 0.5) / n)); } }
        res.push(p);
      }
      return res;
    };
    const split = splitLong(top);
    let under = [], body = split;
    if (o.underlay) { // underlay by width class
      const plain = rungs.filter(r => !r.fan);
      const rail = (s, inset) => plain.map(r => side(r, s, Math.max(0, (h - inset - o.pullComp)) / h));
      if (w < 2.5) { const cr = runStitch(plain.map(r => r.c), o.underlayRunLen); under = cr.slice(); for (let i = cr.length - 2; i >= 0; i--) under.push(cr[i]); }
      else {
        const Lr = runStitch(rail(1, o.underlayInset), o.underlayRunLen), Rr = runStitch(rail(-1, o.underlayInset), o.underlayRunLen).reverse();
        under = Lr.concat(Rr);
        if (w >= 5) {
          const step = Math.max(2, Math.round(o.zigzagUnderlayPitch / o.spacing)), zz = [];
          for (let j = 0; j < rungs.length; j++) { const r = rungs[j]; if (!r.fan && j % step === 0) zz.push(side(r, (j / step) % 2 ? -1 : 1, Math.max(0, h - o.underlayInset - o.pullComp - 0.2) / h)); }
          pushAll(under, splitLong(zz)); body = split.slice().reverse();
        }
      }
      under = splitLong(cleanPolyline(under, 0.02)); // also splits the rail-to-rail crossing at the far end
    }
    let pts = under.slice();
    if (under.length) { const link = splitLong([under[under.length - 1], body[0]]); for (let i = 1; i < link.length - 1; i++) pts.push(link[i]); }
    pushAll(pts, body);
    pts = cleanPolyline(pts, 0.02);
    return { points: pts, kind: 'satin', rungs: rungs.length, underlayPts: under.length, width: w };
  }

  // ------------------------------------------------------------------ assembly into the IR
  // parts: [{ color:'#rrggbb', points:[{x,y}|BREAK] (mm, hoop top-left origin), objectIndex }] in sewing order
  function assemble(parts, opt) {
    opt = opt || {};
    const hoopW = opt.hoopW === undefined ? 100 : opt.hoopW, hoopH = opt.hoopH === undefined ? 100 : opt.hoopH;
    const lock = opt.lock || T.lock, minStitch = opt.minStitch === undefined ? LIMITS.minStitch : opt.minStitch;
    const maxStitch = opt.maxStitch === undefined ? LIMITS.maxStitch : opt.maxStitch, connectMax = opt.connectMax === undefined ? T.connectMax : opt.connectMax;
    const cmds = [], threads = [], perObject = [], perThread = [], kinds = [];
    // 0.1 mm ints, origin = hoop centre. A point is snapped to the grid BEFORE the centre is subtracted, so the
    // same shapes give the same stitches (and the same file) whatever the hoop size.
    const ox = Math.round(Math.round(hoopW * 10) / 2), oy = Math.round(Math.round(hoopH * 10) / 2);
    const qx = v => Math.round(v * 10) - ox, qy = v => Math.round(v * 10) - oy;
    let cx = 0, cy = 0, have = false, color = null, open = false, lastP = null, lastPrev = null, owner = -1, splits = 0, kind = 0;
    const stat = () => { if (owner < 0) return null; let s = perObject[owner]; if (!s) s = perObject[owner] = { stitches: 0, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }; return s; };
    let made = 0; // STITCH commands so far (what the total stitch limit counts)
    const emitStitch = (x, y) => {
      cmds.push(OP.STITCH, x, y); kinds.push(kind); made++;
      const s = stat(); if (s) { s.stitches++; if (x < s.minX) s.minX = x; if (x > s.maxX) s.maxX = x; if (y < s.minY) s.minY = y; if (y > s.maxY) s.maxY = y; }
      const t = perThread[perThread.length - 1]; t.stitches++; if (open) t.lengthMm += Math.hypot(x - cx, y - cy) / 10;
      cx = x; cy = y; have = true; open = true;
    };
    const stitchTo = p => {
      const ux = qx(p.x), uy = qy(p.y);
      if (open && ux === cx && uy === cy) return;
      if (open) {
        const d = Math.hypot(ux - cx, uy - cy) / 10;
        if (d > maxStitch) { // safety net: no writer ever sees a stitch above the 12.1 mm DST limit
          const n = Math.ceil(d / (maxStitch - 0.1)), sx = cx, sy = cy; splits++;
          for (let i = 1; i < n; i++) emitStitch(Math.round(sx + (ux - sx) * i / n), Math.round(sy + (uy - sy) * i / n));
        }
      }
      emitStitch(ux, uy);
    };
    const lockAt = (p, toward) => {
      const d = D(p, toward); if (!(d > 1e-6)) return;
      const l = Math.max(0.4, Math.min(lock.len, d)), a = { x: p.x + (toward.x - p.x) * l / d, y: p.y + (toward.y - p.y) * l / d };
      for (let i = 0; i < lock.repeats; i++) { stitchTo(a); stitchTo(p); }
    };
    const tieOffAndTrim = () => { if (!open) return; if (lastP) lockAt(lastP, lastPrev); cmds.push(OP.TRIM, cx, cy); open = false; };
    const add = part => {
      // split on BREAK (unreachable islands) into runs; drop too-short stitches inside each run
      const runs = [[]];
      for (const p of part.points) { if (p.break) runs.push([]); else if (finite(p)) runs[runs.length - 1].push(p); }
      for (const raw of runs) {
        const run = [];
        for (let i = 0; i < raw.length; i++) { const p = raw[i]; if (!run.length || i === raw.length - 1 || D(run[run.length - 1], p) >= minStitch) run.push(p); }
        while (run.length > 2 && D(run[run.length - 1], run[run.length - 2]) < minStitch) run.splice(run.length - 2, 1);
        if (run.length < 2 || (run.length === 2 && D(run[0], run[1]) < minStitch)) continue;
        const c = normColor(part.color);
        if (color === null) { threads.push({ color: c }); perThread.push({ color: c, stitches: 0, lengthMm: 0 }); color = c; }
        else if (c !== color) { tieOffAndTrim(); cmds.push(OP.COLOR_CHANGE, cx, cy); threads.push({ color: c }); perThread.push({ color: c, stitches: 0, lengthMm: 0 }); color = c; }
        else if (open && Math.hypot(qx(run[0].x) - cx, qy(run[0].y) - cy) / 10 > connectMax) tieOffAndTrim();
        owner = part.objectIndex === undefined ? -1 : part.objectIndex; kind = part.kind === 'line' ? 1 : 0;
        if (!open) { const ux = qx(run[0].x), uy = qy(run[0].y); cmds.push(OP.JUMP, ux, uy); cx = ux; cy = uy; stitchTo(run[0]); lockAt(run[0], run[1]); }
        for (let i = 0; i < run.length; i++) stitchTo(run[i]);
        lastP = run[run.length - 1]; lastPrev = run[run.length - 2];
      }
    };
    const finish = () => {
      tieOffAndTrim();
      cmds.push(OP.END, have ? cx : 0, have ? cy : 0);
      const ir = { units: '0.1mm', origin: 'hoop-centre', hoop: { w: Math.round(hoopW * 10), h: Math.round(hoopH * 10) }, threads, commands: Int32Array.from(cmds), bounds: null };
      ir.bounds = boundsOf(ir);
      return { ir, perObject, perThread, splits, kinds: Uint8Array.from(kinds) };
    };
    // assemble(parts): the whole list at once. assemble(null): an assembler that takes parts one at a time, so the
    // stitch count is known while a design is still being generated (see the total stitch limit in digitize()).
    if (parts) { for (const part of parts) add(part); return finish(); }
    return { add, finish, count: () => made };
  }
  function normColor(c) { // canonical '#rrggbb'. Named and rgb() colours must be resolved by the caller.
    let s = String(c === undefined || c === null ? '' : c).trim().toLowerCase();
    if (/^[0-9a-f]{3}$|^[0-9a-f]{6}$/.test(s)) s = '#' + s;
    if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return /^#[0-9a-f]{6}$/.test(s) ? s : null;
  }
  function boundsOf(ir) {
    let b = null; const c = ir.commands;
    for (let i = 0; i < c.length; i += 3) if (c[i] === OP.STITCH) {
      if (!b) b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      if (c[i + 1] < b.minX) b.minX = c[i + 1]; if (c[i + 1] > b.maxX) b.maxX = c[i + 1];
      if (c[i + 2] < b.minY) b.minY = c[i + 2]; if (c[i + 2] > b.maxY) b.maxY = c[i + 2];
    }
    return b;
  }

  // Invariants every file writer may rely on. Returns a list of violations (empty = valid).
  function validateIR(ir, opt) {
    const maxStitch = opt && opt.maxStitch !== undefined ? opt.maxStitch : 121;
    const errs = [], add = m => { if (errs.length < 50) errs.push(m); };
    if (!ir || !ir.commands || !Array.isArray(ir.threads)) return ['not an IR object'];
    const c = ir.commands;
    let x = 0, y = 0, afterTrim = true, jumped = false, jx = 0, jy = 0, colors = 0, ended = false, any = false;
    for (let i = 0; i < c.length; i += 3) if (c[i] === OP.STITCH) { any = true; break; }
    colors = any ? 1 : 0; // an empty design has no colour block
    if (c.length % 3) add('length not a multiple of 3');
    for (let i = 0; i + 2 < c.length; i += 3) {
      const op = c[i], nx = c[i + 1], ny = c[i + 2], at = i / 3;
      if (ended) add('command after END at ' + at);
      if (!Number.isInteger(nx) || !Number.isInteger(ny)) add('non-integer coordinate at ' + at);
      if (op === OP.STITCH) {
        if (afterTrim && !jumped) add('STITCH after TRIM/start without JUMP at ' + at);
        if (afterTrim && jumped && (nx !== jx || ny !== jy)) add('first STITCH not at the JUMP target at ' + at);
        if (!afterTrim) { const d = Math.hypot(nx - x, ny - y); if (d > maxStitch) add('stitch ' + d / 10 + 'mm at ' + at); if (d === 0) add('zero-length stitch at ' + at); }
        afterTrim = false; jumped = false;
      } else if (op === OP.JUMP) { if (!afterTrim) add('JUMP without TRIM at ' + at); if (jumped) add('double JUMP at ' + at); jumped = true; jx = nx; jy = ny; }
      else if (op === OP.TRIM) { if (afterTrim) add('TRIM without stitches at ' + at); if (nx !== x || ny !== y) add('TRIM moves at ' + at); afterTrim = true; jumped = false; }
      else if (op === OP.COLOR_CHANGE) { if (!afterTrim || jumped) add('COLOR_CHANGE without TRIM at ' + at); colors++; }
      else if (op === OP.END) { if (!afterTrim || jumped) add('END without TRIM'); ended = true; }
      else add('unknown op ' + op + ' at ' + at);
      x = nx; y = ny;
    }
    if (!ended) add('missing END');
    if (colors !== ir.threads.length) add('threads ' + ir.threads.length + ' != colour blocks ' + colors);
    for (const t of ir.threads) if (!t || !/^#[0-9a-f]{6}$/.test(t.color)) add('thread colour not canonical: ' + (t && t.color));
    return errs;
  }

  // ------------------------------------------------------------------ design objects -> geometry
  // Reads a point list ([[x, y], ...] or [{x, y}, ...]); bad points are dropped and counted.
  function readPoints(list, issue) {
    const out = [];
    if (!list || typeof list.length !== 'number') { issue.bad++; return out; }
    for (let i = 0; i < list.length; i++) {
      const p = list[i]; let x, y;
      if (p && typeof p === 'object') { if (typeof p.length === 'number') { x = p[0]; y = p[1]; } else { x = p.x; y = p.y; } }
      if (!isNum(x) || !isNum(y)) { issue.bad++; continue; }
      if (Math.abs(x) > LIMITS.coord || Math.abs(y) > LIMITS.coord) { issue.range++; continue; }
      out.push({ x, y });
    }
    return out;
  }
  const okCoord = (issue, ...v) => { for (const n of v) { if (!isNum(n)) { issue.bad++; return false; } if (Math.abs(n) > LIMITS.coord) { issue.range++; return false; } } return true; };
  function rotateAbout(pts, deg, cx, cy) {
    if (!isNum(deg) || deg % 360 === 0) return pts;
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return pts.map(p => ({ x: cx + (p.x - cx) * c - (p.y - cy) * s, y: cy + (p.x - cx) * s + (p.y - cy) * c }));
  }
  // -> { subs: [{ pts, closed }], rule } or null (issue.bad / issue.range / issue.type say why)
  function geometryOf(obj, issue) {
    const type = String(obj.type || '').toLowerCase();
    if (type === 'rect') {
      if (!okCoord(issue, obj.x, obj.y, obj.width, obj.height)) return null;
      const x = Math.min(obj.x, obj.x + obj.width), y = Math.min(obj.y, obj.y + obj.height), w = Math.abs(obj.width), h = Math.abs(obj.height);
      const pts = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
      return { subs: [{ pts: rotateAbout(pts, obj.rotation, x + w / 2, y + h / 2), closed: true }], rule: 'nonzero' };
    }
    if (type === 'ellipse' || type === 'circle') {
      const rx = obj.rx !== undefined ? obj.rx : obj.r, ry = obj.ry !== undefined ? obj.ry : obj.r;
      if (!okCoord(issue, obj.cx, obj.cy, rx, ry)) return null;
      const ax = Math.abs(rx), ay = Math.abs(ry), n = clamp(Math.round(2 * Math.PI * Math.max(ax, ay) / 1.0), 24, 256), pts = [];
      for (let i = 0; i < n; i++) { const t = 2 * Math.PI * i / n; pts.push({ x: obj.cx + ax * Math.cos(t), y: obj.cy + ay * Math.sin(t) }); }
      return { subs: [{ pts: rotateAbout(pts, obj.rotation, obj.cx, obj.cy), closed: true }], rule: 'nonzero' };
    }
    if (type === 'line') {
      if (!okCoord(issue, obj.x1, obj.y1, obj.x2, obj.y2)) return null;
      return { subs: [{ pts: [{ x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 }], closed: false }], rule: 'nonzero' };
    }
    if (type === 'polygon') return { subs: [{ pts: readPoints(obj.points, issue), closed: true }], rule: obj.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' };
    if (type === 'polyline') return { subs: [{ pts: readPoints(obj.points, issue), closed: obj.closed === true }], rule: obj.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' };
    if (type === 'path') {
      const subs = [], list = obj.rings;
      if (!list || typeof list.length !== 'number') { issue.bad++; return null; }
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (r && typeof r === 'object' && typeof r.length !== 'number') subs.push({ pts: readPoints(r.points, issue), closed: r.closed !== false });
        else subs.push({ pts: readPoints(r, issue), closed: true });
      }
      return { subs, rule: obj.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' };
    }
    issue.type = true;
    return null;
  }

  const MESSAGES = {
    EMPTY_DESIGN: 'There is nothing to stitch yet.',
    OUTSIDE_HOOP: 'Part of the design is outside the hoop.',
    EXCEEDS_HOOP: 'The design is bigger than the hoop.',
    NON_FINITE_INPUT: 'A shape had invalid coordinates and was skipped or repaired.',
    INVALID_OBJECT: 'A shape could not be read and was skipped.',
    INVALID_HOOP: 'The hoop size was invalid; 100 x 100 mm was used.',
    INVALID_COLOR: 'A colour could not be read; black was used.',
    TINY_OBJECT: 'A shape is too small to stitch and was skipped.',
    THIN_FILL: 'A filled shape is under 1 mm wide; a line stitch may sew better.',
    OPEN_PATH_NOT_FILLED: 'An open path cannot be filled; it was stitched as a line.',
    SATIN_TOO_WIDE: 'A satin line is very wide; long stitches were split so they do not snag.',
    SATIN_TOO_NARROW: 'A satin line under 1 mm wide was stitched as a triple run instead.',
    STITCH_TOO_LONG: 'Some stitches are long and may snag.',
    TOO_DENSE: 'Stitches are packed very tightly here; the fabric may pucker or the thread may break.',
    TOO_LARGE: 'A shape would need too many stitches and was skipped.',
    PARAM_CLAMPED: 'A stitch setting was outside its range and was adjusted.',
    INTERNAL_ERROR: 'A shape could not be stitched and was skipped.',
    TOO_MANY_STITCHES: 'The design has too many stitches for an embroidery machine. Make it smaller or less dense.',
    LARGE_DESIGN: 'This is a large design: it takes a long time to sew, and small home machines may not load it.',
  };
  const SEVERITY = { EMPTY_DESIGN: 'error', OUTSIDE_HOOP: 'error', EXCEEDS_HOOP: 'error', TOO_MANY_STITCHES: 'error', SATIN_TOO_NARROW: 'info', PARAM_CLAMPED: 'info', THIN_FILL: 'info', INVALID_COLOR: 'info' };

  // one object -> stitch parts. warn(code, extra) records a warning for this object.
  // budget (optional) = { left, need }: left is how many stitches the design may still take. A piece whose lower
  // bound is above that is not built: budget.need is set to the bound and the parts made so far are returned.
  function digitizeObject(obj, index, warn, budget) {
    const parts = [];
    const issue = { bad: 0, range: 0, type: false };
    const geo = geometryOf(obj, issue);
    if (!geo) { warn(issue.type ? 'INVALID_OBJECT' : 'NON_FINITE_INPUT', issue.type ? { message: 'Unknown shape type "' + String(obj.type).slice(0, 20) + '"; the shape was skipped.' } : { message: 'A shape had missing or invalid coordinates and was skipped.' }); return parts; }
    if (issue.bad || issue.range) warn('NON_FINITE_INPUT', { message: (issue.bad + issue.range) + ' invalid point' + (issue.bad + issue.range === 1 ? ' was' : 's were') + ' removed from a shape.', dropped: issue.bad + issue.range });

    let color = normColor(obj.color === undefined ? DEFAULTS.color : obj.color);
    if (!color) { color = DEFAULTS.color; warn('INVALID_COLOR'); }

    const param = (src, key, def, range, name) => {
      const v = src ? src[key] : undefined;
      if (v === undefined || v === null) return def;
      if (!isNum(v)) { warn('PARAM_CLAMPED', { param: name, value: def, message: name + ' was not a number; ' + def + ' was used.' }); return def; }
      if (range && (v < range[0] || v > range[1])) { const c = clamp(v, range[0], range[1]); warn('PARAM_CLAMPED', { param: name, value: c, message: name + ' must be between ' + range[0] + ' and ' + range[1] + '; ' + c + ' was used.' }); return c; }
      return v;
    };

    // sort the sub-paths into fillable rings and lines
    const closedSubs = [], allSubs = [];
    for (const s of geo.subs) {
      const pts = cleanPolyline(s.pts);
      if (s.closed) { const ring = cleanRing(pts); if (ring) { closedSubs.push(ring); allSubs.push({ pts: ring, closed: true }); continue; } }
      if (pts.length >= 2) allSubs.push({ pts, closed: false });
    }
    if (!allSubs.length) { warn('TINY_OBJECT'); return parts; }
    let paint = String(obj.paint || '').toLowerCase();
    if (paint !== 'fill' && paint !== 'line' && paint !== 'both') paint = closedSubs.length ? 'fill' : 'line';
    const openSubs = allSubs.filter(s => !s.closed);
    let wantFill = paint !== 'line', lineSubs = paint === 'fill' ? [] : allSubs;
    if (wantFill && openSubs.length) { if (paint === 'fill') lineSubs = openSubs; warn('OPEN_PATH_NOT_FILLED'); }
    if (wantFill && !closedSubs.length) wantFill = false;

    if (wantFill) {
      const f = obj.fill || {};
      const spacing = param(f, 'spacing', DEFAULTS.fill.spacing, LIMITS.fillSpacing, 'Fill row spacing');
      let slIn = f.stitchLength, stitchLen;
      if (isNum(slIn) && slIn > LIMITS.fillStitchLength[1]) { stitchLen = LIMITS.fillStitchLength[1]; warn('STITCH_TOO_LONG', { message: 'Fill stitches longer than ' + stitchLen + ' mm snag; ' + stitchLen + ' mm was used.' }); }
      else stitchLen = param(f, 'stitchLength', DEFAULTS.fill.stitchLength, LIMITS.fillStitchLength, 'Fill stitch length');
      const angle = param(f, 'angle', DEFAULTS.fill.angle, null, 'Fill angle');
      const pullComp = param(f, 'pullComp', DEFAULTS.fill.pullComp, LIMITS.pullComp, 'Pull compensation');
      const underlay = f.underlay === undefined ? DEFAULTS.fill.underlay : !!f.underlay;
      if (spacing < LIMITS.denseBelow) warn('TOO_DENSE', { message: 'Fill rows closer than ' + LIMITS.denseBelow + ' mm are very dense; the fabric may pucker.' });
      let patKey = f.pattern === undefined || f.pattern === null ? 'smooth' : String(f.pattern).toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(FILL_PATTERNS, patKey)) { warn('PARAM_CLAMPED', { param: 'Fill pattern', value: 'smooth', message: 'Unknown fill pattern; the smooth fill was used.' }); patKey = 'smooth'; }
      const pat = FILL_PATTERNS[patKey];
      const fopt = { spacing, stitchLen, angleDeg: ((angle % 180) + 180) % 180, pullComp, underlay, rule: geo.rule, maxStitches: budget ? budget.left : undefined };
      if (pat.staggers) fopt.staggers = pat.staggers;
      // crosshatch: an open lattice, two passes at right angles with the rows well apart and nothing underneath
      if (pat.cross) { fopt.spacing = Math.min(LIMITS.fillSpacing[1], Math.max(1.2, spacing * 3)); fopt.underlay = false; }
      const res = fillShape(closedSubs, fopt);
      if (res.skipped === 'OVER_LIMIT') { budget.need = res.lowerBound; return parts; }
      if (budget && !res.skipped) budget.left -= res.lowerBound;
      if (res.skipped === 'TOO_LARGE') warn('TOO_LARGE');
      else if (res.skipped) { if (!lineSubs.length) warn('TINY_OBJECT'); }
      else {
        parts.push({ color, points: res.points, objectIndex: index, kind: 'fill', stats: res.stats }); if (res.stats.thin) warn('THIN_FILL');
        if (pat.cross) {
          const res2 = fillShape(closedSubs, Object.assign({}, fopt, { angleDeg: (fopt.angleDeg + 90) % 180, maxStitches: budget ? budget.left : undefined }));
          if (res2.skipped === 'OVER_LIMIT') { budget.need = res2.lowerBound; return parts; }
          if (budget && !res2.skipped) budget.left -= res2.lowerBound;
          if (!res2.skipped) parts.push({ color, points: res2.points, objectIndex: index, kind: 'fill', stats: res2.stats });
        }
      }
    }

    if (lineSubs.length) {
      const l = obj.line || {};
      let type = String(l.type === undefined ? DEFAULTS.line.type : l.type).toLowerCase();
      if (type === 'run') type = 'running';
      if (type !== 'running' && type !== 'bean' && type !== 'satin' && type !== 'raw') { warn('PARAM_CLAMPED', { param: 'Line type', value: 'running', message: 'Unknown line type; a running stitch was used.' }); type = 'running'; }
      let slIn = l.stitchLength, stitchLen;
      if (isNum(slIn) && slIn > LIMITS.lineStitchLength[1]) { stitchLen = LIMITS.lineStitchLength[1]; warn('STITCH_TOO_LONG', { message: 'Line stitches longer than ' + stitchLen + ' mm snag; ' + stitchLen + ' mm was used.' }); }
      else stitchLen = param(l, 'stitchLength', DEFAULTS.line.stitchLength, LIMITS.lineStitchLength, 'Line stitch length');
      let lineColor = color;
      if (l.color !== undefined && l.color !== null) { lineColor = normColor(l.color); if (!lineColor) { lineColor = color; warn('INVALID_COLOR'); } }
      let width = DEFAULTS.line.width, spacing = DEFAULTS.line.spacing;
      const underlay = l.underlay === undefined ? DEFAULTS.line.underlay : !!l.underlay;
      if (type === 'satin') {
        width = param(l, 'width', DEFAULTS.line.width, [0, 1e9], 'Satin width');
        spacing = param(l, 'spacing', DEFAULTS.line.spacing, LIMITS.satinSpacing, 'Satin spacing');
        if (width > LIMITS.satinWidth[1]) { warn('SATIN_TOO_WIDE', { message: 'Satin wider than ' + LIMITS.satinWidth[1] + ' mm is not possible; ' + LIMITS.satinWidth[1] + ' mm was used. Use a fill for wide shapes.' }); width = LIMITS.satinWidth[1]; }
        else if (width > LIMITS.satinWideAbove) warn('SATIN_TOO_WIDE');
        else if (width < LIMITS.satinWidth[0]) warn('SATIN_TOO_NARROW');
        if (spacing < LIMITS.denseBelow) warn('TOO_DENSE', { message: 'Satin stitches closer than ' + LIMITS.denseBelow + ' mm are very dense; the thread may break.' });
      }
      let made = 0;
      for (const s of lineSubs) {
        if (polyLen(s.pts, s.closed) < T.run.minLen) continue;
        let pts;
        const src = type === 'satin' ? simplify(s.pts, 0.08) : s.pts;
        if (budget) {
          const satin = type === 'satin' && width >= LIMITS.satinWidth[0]; // a narrower satin is sewn as a triple run
          // 'raw' sews the given points as they are: one stitch per point
          const lb = type === 'raw' ? Math.max(0, s.pts.length - 1) : lineLowerBound(src, s.closed, satin ? spacing / 2 : stitchLen, satin || type === 'running' ? 1 : 3);
          if (lb > budget.left) { budget.need = lb; return parts; }
          budget.left -= lb;
        }
        if (type === 'satin') pts = satinLine(src, width, { spacing, closed: s.closed, underlay, stitchLen }).points;
        else if (type === 'raw') pts = cleanPolyline(s.pts);   // stitches read from a machine file: the needle lands on every point, nothing is re-spaced
        else { pts = runStitch(s.pts, stitchLen, { closed: s.closed }); if (type === 'bean') pts = bean(pts, 3); }
        if (pts.length >= 2) { parts.push({ color: lineColor, points: pts, objectIndex: index, kind: 'line' }); made++; }
      }
      if (!made && !parts.length) warn('TINY_OBJECT');
    } else if (!parts.length && !wantFill && paint !== 'line') warn('TINY_OBJECT');
    return parts;
  }

  // Thread laid down per mm2 on a grid of 2 mm cells. kinds (one entry per STITCH: 0 fill, 1 line) is optional.
  // A single cell is noisy (corners, locks), so the figure reported is the 6th densest cell: at least 24 mm2
  // are that dense. Returns { fill, total } each { value, peak, x, y } in mm of thread per mm2 / IR units.
  function densityStats(ir, kinds) {
    const b = ir.bounds; if (!b) return null;
    const cell = 20, gw = Math.floor((b.maxX - b.minX) / cell) + 1, gh = Math.floor((b.maxY - b.minY) / cell) + 1;
    if (gw * gh > 4e6) return null;
    const all = new Float32Array(gw * gh), fill = new Float32Array(gw * gh), c = ir.commands;
    let px = 0, py = 0, sewing = false, si = 0;
    for (let i = 0; i < c.length; i += 3) {
      const op = c[i], x = c[i + 1], y = c[i + 2];
      if (op === OP.STITCH) {
        if (sewing) {
          const len = Math.hypot(x - px, y - py), n = Math.max(1, Math.ceil(len / 5)), part = len / n / 10, isFill = !kinds || kinds[si] === 0;
          for (let k = 0; k < n; k++) {
            const t = (k + 0.5) / n, g = Math.floor((py + (y - py) * t - b.minY) / cell) * gw + Math.floor((px + (x - px) * t - b.minX) / cell);
            all[g] += part; if (isFill) fill[g] += part;
          }
        }
        sewing = true; si++;
      } else sewing = false;
      px = x; py = y;
    }
    const area = (cell / 10) * (cell / 10), RANK = 6;
    const summarise = grid => {
      const top = []; let max = 0, at = 0; // keep the RANK largest cells
      for (let i = 0; i < grid.length; i++) {
        const v = grid[i]; if (v > max) { max = v; at = i; }
        if (top.length < RANK) { top.push(v); top.sort((p, q) => p - q); } else if (v > top[0]) { top[0] = v; top.sort((p, q) => p - q); }
      }
      return { value: (top.length === RANK ? top[0] : 0) / area, peak: max / area, x: b.minX + (at % gw + 0.5) * cell, y: b.minY + (Math.floor(at / gw) + 0.5) * cell };
    };
    return { fill: summarise(fill), total: summarise(all) };
  }

  // ------------------------------------------------------------------ public entry point
  // design -> result (see API.md). Never throws for bad design data; problems become warnings.
  function digitize(design, opt) {
    opt = opt || {};
    const warnings = [];
    const pushWarn = (code, extra, objectIndex, objectId) => {
      const w = { code, severity: SEVERITY[code] || 'warning', message: MESSAGES[code] || code };
      if (objectIndex !== undefined && objectIndex !== null) { w.objectIndex = objectIndex; if (objectId !== undefined) w.objectId = objectId; }
      if (extra) for (const k in extra) w[k] = extra[k];
      warnings.push(w);
    };
    const d = design && typeof design === 'object' ? design : {};
    let hoopW = DEFAULTS.hoop.width, hoopH = DEFAULTS.hoop.height;
    if (d.hoop !== undefined && d.hoop !== null) {
      const w = d.hoop.width, h = d.hoop.height;
      if (isNum(w) && isNum(h) && w >= LIMITS.hoop[0] && h >= LIMITS.hoop[0] && w <= LIMITS.hoop[1] && h <= LIMITS.hoop[1]) { hoopW = w; hoopH = h; }
      else pushWarn('INVALID_HOOP');
    }
    const list = Array.isArray(d.objects) ? d.objects : [];
    const objects = [];
    // Total stitch limit. Each object is assembled as soon as it is digitized, so the exact count is known all the
    // way; an object that cannot fit in what is left (by its lower bound) is not built at all. Either way the
    // generation stops there and the design is refused: `over` = the count reached, a lower bound of the real one.
    const limit = isNum(opt.maxStitches) && opt.maxStitches >= 1 && opt.maxStitches < LIMITS.maxStitches ? Math.floor(opt.maxStitches) : LIMITS.maxStitches;
    const building = assemble(null, { hoopW, hoopH }), budget = { left: limit, need: 0 };
    let over = null;
    for (let i = 0; i < list.length; i++) {
      const obj = list[i], id = obj && obj.id !== undefined ? obj.id : undefined;
      const entry = { index: i, stitches: 0, skipped: false }; if (id !== undefined) entry.id = id;
      objects.push(entry);
      if (!obj || typeof obj !== 'object') { pushWarn('INVALID_OBJECT', null, i, id); entry.skipped = true; continue; }
      if (obj.visible === false) { entry.skipped = true; continue; }
      const warn = (code, extra) => pushWarn(code, extra, i, id);
      let made;
      budget.left = limit - building.count(); budget.need = 0;
      try { made = digitizeObject(obj, i, warn, budget); }
      catch (e) { made = []; budget.need = 0; pushWarn('INTERNAL_ERROR', { detail: String(e && e.message || e).slice(0, 200) }, i, id); }
      if (budget.need) { over = limit - budget.left + budget.need; break; }
      if (!made.length) entry.skipped = true;
      for (let k = 0; k < made.length; k++) building.add(made[k]);
      if (building.count() > limit) { over = building.count(); break; }
      if (typeof opt.onProgress === 'function') { try { opt.onProgress(i + 1, list.length); } catch (e) { /* a broken progress callback must not break generation */ } }
    }
    let asm = over === null ? building.finish() : null;
    if (asm && building.count() > limit) { over = building.count(); asm = null; } // the closing lock stitches went over
    if (!asm) {                                                                    // refused: an empty, valid IR
      asm = assemble([], { hoopW, hoopH });
      // every object of the design is still listed, also those after the one that went over
      for (let i = objects.length; i < list.length; i++) { const o = list[i], e = { index: i, stitches: 0, skipped: true }; if (o && o.id !== undefined) e.id = o.id; objects.push(e); }
      if (list.length && typeof opt.onProgress === 'function') { try { opt.onProgress(list.length, list.length); } catch (e) { /* as above */ } }
    }
    const ir = asm.ir;
    for (const o of objects) { const s = asm.perObject[o.index]; if (s) o.stitches = s.stitches; else o.skipped = true; }

    // totals
    const c = ir.commands; let stitches = 0, jumps = 0, trims = 0, changes = 0, longCount = 0, longest = 0, px = 0, py = 0, sewing = false;
    for (let i = 0; i < c.length; i += 3) {
      const op = c[i];
      if (op === OP.STITCH) { stitches++; if (sewing) { const len = Math.hypot(c[i + 1] - px, c[i + 2] - py) / 10; if (len > longest) longest = len; if (len > LIMITS.longStitchAbove + 0.05) longCount++; } sewing = true; }
      else { sewing = false; if (op === OP.JUMP) jumps++; else if (op === OP.TRIM) trims++; else if (op === OP.COLOR_CHANGE) changes++; }
      px = c[i + 1]; py = c[i + 2];
    }
    let sewnMm = 0;
    const threads = asm.perThread.map(t => { sewnMm += t.lengthMm; return { color: t.color, stitches: t.stitches, lengthM: +((t.lengthMm * T.thread.takeUp) / 1000).toFixed(3) }; });
    const threadLengthM = +((sewnMm * T.thread.takeUp + trims * T.thread.tailMm) / 1000).toFixed(2);
    const timeMin = +((stitches / T.time.spm) + (trims * T.time.trimSec + changes * T.time.colorChangeSec) / 60).toFixed(1);
    const totals = { stitches, jumps, trims, colorChanges: changes, colors: threads.length, threadLengthM, timeMin, longestStitchMm: +longest.toFixed(2) };

    // design-level warnings
    let bounds = null;
    if (over !== null) pushWarn('TOO_MANY_STITCHES', { message: 'The design needs more than ' + limit + ' stitches, which is more than an embroidery machine takes. Make it smaller or less dense.', stitches: over, limit });
    else if (!stitches) pushWarn('EMPTY_DESIGN');
    else {
      const b = ir.bounds;
      const cx = Math.round(ir.hoop.w / 2), cy = Math.round(ir.hoop.h / 2); // the IR origin, exactly as assemble() placed it
      bounds = { minX: (b.minX + cx) / 10, minY: (b.minY + cy) / 10, maxX: (b.maxX + cx) / 10, maxY: (b.maxY + cy) / 10, width: (b.maxX - b.minX) / 10, height: (b.maxY - b.minY) / 10 };
      const outside = [];
      for (const o of objects) { const s = asm.perObject[o.index]; if (s && (s.minX < -cx || s.maxX > ir.hoop.w - cx || s.minY < -cy || s.maxY > ir.hoop.h - cy)) outside.push(o.index); }
      if (b.maxX - b.minX > ir.hoop.w || b.maxY - b.minY > ir.hoop.h) pushWarn('EXCEEDS_HOOP', { message: 'The design is ' + bounds.width.toFixed(1) + ' x ' + bounds.height.toFixed(1) + ' mm, bigger than the ' + hoopW + ' x ' + hoopH + ' mm hoop.', objectIndexes: outside });
      else if (outside.length) pushWarn('OUTSIDE_HOOP', { objectIndexes: outside });
      if (longCount || asm.splits) pushWarn('STITCH_TOO_LONG', { count: longCount + asm.splits, longestMm: +longest.toFixed(2) });
      const dens = densityStats(ir, asm.kinds);
      if (dens) {
        const hit = dens.fill.value > LIMITS.maxFillDensity ? dens.fill : dens.total.value > LIMITS.maxDensity ? dens.total : null;
        if (hit) pushWarn('TOO_DENSE', { message: 'Stitches are stacked very thickly in one place (overlapping shapes?); the fabric may pucker or the needle may break.', densityMmPerMm2: +hit.value.toFixed(1), at: { x: (hit.x + cx) / 10, y: (hit.y + cy) / 10 } });
      }
      if (stitches > LIMITS.largeDesign) pushWarn('LARGE_DESIGN', { stitches, threshold: LIMITS.largeDesign, timeMin });
    }
    const canExport = !warnings.some(w => w.severity === 'error');
    return {
      ok: canExport, canExport,
      name: typeof d.name === 'string' ? d.name : '',
      hoop: { width: hoopW, height: hoopH },
      ir, threads, objects, totals, bounds, warnings,
    };
  }

  return {
    OP, OP_NAME, DEFAULTS, LIMITS, FILL_PATTERNS,
    digitize, validateIR, normColor,
    // lower-level pieces, exported for tests and tools (not part of the stable API)
    fillShape, satinLine, runStitch, bean, assemble, EdgeIndex, buildRows, buildRegions, densityStats, simplify, _tuning: T,
  };
});
