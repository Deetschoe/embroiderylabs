#!/usr/bin/env node
/*
 * ATTACK 2: geometry truth.
 *
 * Each shape is rasterised at 0.1 mm by lib/geom.js (own scanline / analytic code, nothing from the engine) and
 * the thread the engine lays down (every needle-to-needle segment of every run, travel included) is measured
 * against it:
 *   - no thread on open fabric: nothing further outside the shape than the pull compensation
 *   - the interior is covered: no bare patch
 *   - stitch lengths: nothing over 12.1 mm, fills not over 7 mm, hardly anything under 0.4 mm
 *   - 'both': the outline follows the boundary, all the way round, every ring
 *   - satin columns have the width that was asked for
 *
 *   ADV_GEOM_ALL=1   every shape with every fill setting (27 x 11) instead of the default selection
 */
'use strict';
const C = require('./lib/common.js');
const K = require('./lib/corpus.js');
const G = require('./lib/geom.js');
const { Engine, check } = C;

const t = C.suite('attack 2: geometry truth (0.1 mm raster of every shape)');
const SNAP = 0.1;        // the IR grid is 0.1 mm and my raster is 0.1 mm: 0.07 + 0.07 of honest slack, rounded up
const BOX = { minX: -6, minY: -6, maxX: 106, maxY: 106 };

// thread on the fabric: one [x1, y1, x2, y2] per needle-to-needle segment, in design millimetres
function segments(ir, runs) {
  const out = [];
  for (const r of runs) for (let i = 2; i < r.length; i += 2) { const a = C.irMm(ir, r[i - 2], r[i - 1]), b = C.irMm(ir, r[i], r[i + 1]); out.push(a[0], a[1], b[0], b[1]); }
  return Float64Array.from(out);
}
function lengths(segs) {
  const L = { n: segs.length / 4, under04: 0, under025: 0, over7: 0, over121: 0, longest: 0, total: 0 };
  for (let i = 0; i < segs.length; i += 4) { const l = Math.hypot(segs[i + 2] - segs[i], segs[i + 3] - segs[i + 1]); L.total += l; if (l < 0.4 - 1e-9) L.under04++; if (l < 0.25) L.under025++; if (l > 7 + 1e-9) L.over7++; if (l > 12.1 + 1e-9) L.over121++; if (l > L.longest) L.longest = l; }
  return L;
}

// Exact distance from a point to a polygon shape (0 when inside by the shape's fill rule). The raster loses
// whatever is thinner than a cell (the tip of a star, a sliver), so samples the raster calls "outside" are
// measured again against the real edges. null for ellipses (analytic shapes: the raster is used, with more slack).
function exactOutside(obj) {
  const geo = G.ringsOf(obj); if (!geo || !geo.rings.length) return null;
  const E = [], evenodd = geo.rule === 'evenodd';
  for (const r of geo.rings) for (let k = 0; k < r.length; k++) { const p = r[k], q = r[(k + 1) % r.length]; E.push(p.x, p.y, q.x, q.y); }
  return (x, y) => {
    let wind = 0, cnt = 0, best = Infinity;
    for (let e = 0; e < E.length; e += 4) {
      const ax = E[e], ay = E[e + 1], bx = E[e + 2], by = E[e + 3];
      if ((ay <= y) !== (by <= y) && ax + (y - ay) / (by - ay) * (bx - ax) > x) { cnt++; wind += by > ay ? 1 : -1; }
      const l2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay), u = l2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l2)) : 0;
      const d = Math.hypot(x - ax - u * (bx - ax), y - ay - u * (by - ay)); if (d < best) best = d;
    }
    return (evenodd ? (cnt & 1) : wind !== 0) ? 0 : best;
  };
}
// furthest any thread lies outside the shape, and how much thread lies further out than tol
function outside(g, m, ex, segs, tol) {
  const o = { max: 0, at: null, beyond: 0 };
  for (let s = 0; s < segs.length; s += 4) {
    const x1 = segs[s], y1 = segs[s + 1], x2 = segs[s + 2], y2 = segs[s + 3], len = Math.hypot(x2 - x1, y2 - y1), n = Math.max(1, Math.ceil(len / 0.05));
    for (let k = 0; k <= n; k++) {
      const x = x1 + (x2 - x1) * k / n, y = y1 + (y2 - y1) * k / n;
      let d = g.at(m.toShape, x, y, 99);
      if (d > 0.05 && ex) d = ex(x, y);
      if (d > tol) o.beyond += len / n;
      if (d > o.max) { o.max = d; o.at = [+x.toFixed(2), +y.toFixed(2)]; }
    }
  }
  return o;
}

/* ---------- fills ---------- */
const pairs = [];
if (process.env.ADV_GEOM_ALL) { for (const s of Object.keys(K.shapes)) for (const f of Object.keys(K.fills)) pairs.push([s, f]); }
else {
  for (const s of Object.keys(K.shapes)) pairs.push([s, 'default']);
  for (const f of Object.keys(K.fills)) if (f !== 'default') for (const s of ['U', 'donut', 'star5', 'blob', 'comb', 'spiral', 'twoHoles']) pairs.push([s, f]);
  for (const [s, f] of [['star9thin', 'a17'], ['E', 'a90'], ['C', 'a45'], ['nested', 'aNeg'], ['pentagramEO', 'a45'], ['bowtie', 'a90'], ['ellipseRot', 'aNeg'], ['rectRot', 'a17'], ['frame', 'a45'], ['islands', 'a90'], ['sliver', 'a90'], ['rectThin', 'a90']]) pairs.push([s, f]);
}
const stats = { cases: 0, worstOut: 0, worstOutAt: '', worstGap: 0, worstGapAt: '', worstBare: 0, worstBareAt: '', trims: 0, short: 0, tiny: 0, stitches: 0 };
const grids = {};
for (const [s, f] of pairs) {
  const key = s + ' / ' + f, design = K.fillDesign(s, f), obj = design.objects[0];
  const fill = Object.assign({ spacing: 0.4, stitchLength: 3, pullComp: 0.2 }, K.fills[f]);
  const r = Engine.generate(design);
  if (!r.canExport) { t.test(key + ': generates', () => check(false, 'not exportable: ' + JSON.stringify(r.warnings.map(w => w.code)))); continue; }
  const g = grids[s] || (grids[s] = G.rasterise(obj, BOX));
  const runs = [].concat(...C.irRuns(r.ir).blocks), segs = segments(r.ir, runs), m = G.measure(g, segs), L = lengths(segs);
  stats.cases++; stats.trims += runs.length - 1; stats.short += L.under04; stats.tiny += L.under025; stats.stitches += L.n;

  t.test(key + ': no thread on open fabric', () => {
    // a row end may reach pullComp past the edge (plus the 0.1 mm grid); anything further is thread across a
    // gap, a hole or outside. Polygons are measured exactly, ellipses on the raster (0.15 mm more slack).
    const ex = exactOutside(obj), tol = fill.pullComp + SNAP + (ex ? 0 : 0.15), o = outside(g, m, ex, segs, tol);
    const over = o.max - fill.pullComp;
    if (over > stats.worstOut) { stats.worstOut = over; stats.worstOutAt = key + ' at (' + o.at + ')'; }
    // The stitch from the end of one row to the start of the next cuts the corner where the outline is concave
    // (the inner corner of a star): by geometry up to about 0.4 x the row spacing. So: a hard limit that includes
    // that, and hardly any thread at all (0.5%) beyond the plain pull compensation.
    const hard = tol + 0.4 * fill.spacing;
    check(o.max <= hard, () => 'thread ' + o.max.toFixed(2) + ' mm outside the shape at (' + o.at + '); allowed ' + hard.toFixed(2) + ' mm; ' + o.beyond.toFixed(1) + ' mm of thread is more than ' + tol.toFixed(2) + ' mm out');
    check(o.beyond <= 0.005 * L.total, () => o.beyond.toFixed(1) + ' mm of ' + L.total.toFixed(0) + ' mm thread lies more than ' + tol.toFixed(2) + ' mm outside the shape, worst ' + o.max.toFixed(2) + ' mm at (' + o.at + ')');
  });
  t.test(key + ': the interior is covered', () => {
    // rows are `spacing` apart, so every point is within spacing/2 of thread; a bare patch is one whose
    // centre is further than one whole row away. Only cells deeper than 1 mm count (edges are the next test).
    const reach = fill.spacing + SNAP, u = m.uncovered(1.0, reach);
    if (u.worstGapMm > stats.worstGap) { stats.worstGap = u.worstGapMm; stats.worstGapAt = key; }
    if (u.fraction > stats.worstBare) { stats.worstBare = u.fraction; stats.worstBareAt = key; }
    check(u.interiorCells === 0 || u.worstGapMm <= 2 * fill.spacing + SNAP, () => 'a bare patch: (' + u.at.x + ', ' + u.at.y + ') is ' + u.worstGapMm.toFixed(2) + ' mm from the nearest thread (rows are ' + fill.spacing + ' mm apart)');
    check(u.fraction <= 0.005, () => (100 * u.fraction).toFixed(2) + '% of the interior (' + u.areaMm2.toFixed(1) + ' mm2) has no thread within ' + reach.toFixed(2) + ' mm');
  });
  t.test(key + ': the fill reaches the edge', () => {
    // everything deeper than 0.5 mm inside must have thread within 0.5 + one row
    const u = m.uncovered(0.5, 0.5 + fill.spacing);
    check(u.fraction <= 0.01, () => (100 * u.fraction).toFixed(2) + '% of the area 0.5 mm inside the edge is further than ' + (0.5 + fill.spacing).toFixed(1) + ' mm from thread, worst at (' + (u.at && u.at.x) + ', ' + (u.at && u.at.y) + ') ' + u.worstGapMm.toFixed(2) + ' mm');
  });
  t.test(key + ': stitch lengths', () => {
    check(L.over121 === 0, L.over121 + ' stitches over 12.1 mm (longest ' + L.longest.toFixed(2) + ')');
    const cap = Math.max(7, fill.stitchLength) + 0.15;
    check(L.longest <= cap, 'a fill stitch of ' + L.longest.toFixed(2) + ' mm (' + L.over7 + ' over 7 mm)');
    // The stitch from one row to the next is as long as the rows are apart (0.4 mm by default, 0.36 after the
    // 0.1 mm grid on a slanted fill), so "under 0.4 mm" is counted and reported, not failed. Stitches a needle
    // can hardly make (under 0.25 mm; the engine drops what is under 0.3 mm before the grid) must be rare.
    check(L.under025 <= Math.max(2, 0.005 * L.n), L.under025 + ' of ' + L.n + ' stitches are shorter than 0.25 mm');
    if (fill.spacing >= 0.4) check(L.under04 <= 0.15 * L.n, L.under04 + ' of ' + L.n + ' stitches are shorter than 0.4 mm');
    check(r.totals.longestStitchMm <= cap, 'totals.longestStitchMm ' + r.totals.longestStitchMm);
  });
  t.test(key + ': thread used is what the area needs', () => {
    // top rows alone: area / spacing of thread. With underlay and travel it must stay under 2.2 x that (3.5 x
    // where the underlay or a 1 mm pull compensation weighs more: loose rows, thin shapes), and cannot be
    // under 0.85 x (rows missing)
    const need = g.area() / fill.spacing, ratio = L.total / need;
    if (g.area() > 30) check(ratio >= 0.85 && ratio <= (fill.spacing >= 1 || fill.pullComp >= 0.5 ? 3.5 : 2.2), 'thread length is ' + ratio.toFixed(2) + ' x area / spacing (' + L.total.toFixed(0) + ' mm for ' + g.area().toFixed(0) + ' mm2)');
  });
}
t.note(stats.cases + ' fills measured, ' + stats.stitches + ' stitches; furthest outside beyond the pull compensation ' + stats.worstOut.toFixed(2) + ' mm (' + stats.worstOutAt + '); largest bare gap ' + stats.worstGap.toFixed(2) + ' mm (' + stats.worstGapAt + '); most bare ' + (100 * stats.worstBare).toFixed(2) + '% (' + stats.worstBareAt + '); ' + stats.trims + ' trims inside single shapes; ' + stats.short + ' stitches under 0.4 mm (row-turn stitches), ' + stats.tiny + ' under 0.25 mm');

/* ---------- outlines of 'both' ---------- */
const boundaryCells = g => { const b = new Uint8Array(g.w * g.h); for (let j = 1; j < g.h - 1; j++) for (let i = 1; i < g.w - 1; i++) { const k = j * g.w + i; if (g.inside[k] && !(g.inside[k - 1] && g.inside[k + 1] && g.inside[k - g.w] && g.inside[k + g.w])) b[k] = 1; } return b; };
for (const [s, type, width] of [['U', 'satin', 2.4], ['donut', 'running', 0], ['star5', 'bean', 0], ['blob', 'satin', 2.4], ['twoHoles', 'satin', 3], ['frame', 'running', 0], ['islands', 'bean', 0], ['circle', 'satin', 4], ['rectRot', 'satin', 2], ['E', 'running', 0], ['triangle', 'satin', 3]]) {
  const key = 'both ' + s + ' / ' + type;
  const design = { name: key, hoop: { width: 100, height: 100 }, objects: [Object.assign({ color: '#1d4ed8', paint: 'both', line: { type, width: width || 3, color: '#e11d48' } }, JSON.parse(JSON.stringify(K.shapes[s])))] };
  const r = Engine.generate(design), ir = C.irRuns(r.ir);
  t.test(key + ': fill first, then the outline in its own colour', () => {
    check(r.canExport, 'not exportable: ' + JSON.stringify(r.warnings.map(w => w.code)));
    check(r.threads.length === 2 && r.threads[0].color === '#1d4ed8' && r.threads[1].color === '#e11d48', 'threads ' + JSON.stringify(r.threads.map(x => x.color)));
  });
  if (!r.canExport || ir.blocks.length !== 2) continue;
  const g = grids[s] || (grids[s] = G.rasterise(design.objects[0], BOX)), edge = boundaryCells(g), toEdge = G.distanceTo(edge, g.w, g.h);
  const segs = segments(r.ir, ir.blocks[1]), half = type === 'satin' ? width / 2 : 0;
  t.test(key + ': the outline stays on the boundary', () => {
    // a satin needle lands half a column (plus its pull compensation) either side of the edge; corners fan out to
    // half * sqrt(2) at a right angle and further at a sharp tip, so allow the mitre of a 36 degree tip, capped
    let worst = 0, at = null, off = 0, n = 0;
    for (let i = 0; i < segs.length; i += 4) for (const [x, y] of [[segs[i], segs[i + 1]], [segs[i + 2], segs[i + 3]]]) { const d = g.at(toEdge, x, y, 99); n++; if (d > half + 0.2 + 0.45) off++; if (d > worst) { worst = d; at = [x, y]; } }
    const cap = type === 'satin' ? Math.min((half + 0.2) * 3.3, half + 0.2 + 3.5) + SNAP : 0.3 + SNAP;
    check(worst <= cap, () => 'an outline stitch lands ' + worst.toFixed(2) + ' mm from the boundary at (' + at[0] + ', ' + at[1] + '), allowed ' + cap.toFixed(2));
    check(off <= 0.12 * n, off + ' of ' + n + ' outline needle points are more than ' + (half + 0.65).toFixed(2) + ' mm from the boundary');
  });
  t.test(key + ': the outline goes all the way round every ring', () => {
    // every boundary cell must have outline thread near it
    const thread = new Uint8Array(g.w * g.h);
    for (let i = 0; i < segs.length; i += 4) { const len = Math.hypot(segs[i + 2] - segs[i], segs[i + 3] - segs[i + 1]), n = Math.max(1, Math.ceil(len / 0.05)); for (let k = 0; k <= n; k++) { const x = segs[i] + (segs[i + 2] - segs[i]) * k / n, y = segs[i + 1] + (segs[i + 3] - segs[i + 1]) * k / n, a = g.ix(x), b = g.iy(y); if (a >= 0 && b >= 0 && a < g.w && b < g.h) thread[b * g.w + a] = 1; } }
    const toThread = G.distanceTo(thread, g.w, g.h), reach = type === 'satin' ? 0.9 : 0.45;
    let miss = 0, total = 0, worst = 0, at = null;
    for (let k = 0; k < edge.length; k++) if (edge[k]) { total++; if (toThread[k] > reach) { miss++; if (toThread[k] > worst) { worst = toThread[k]; at = [(g.x0 + (k % g.w + 0.5) * 0.1).toFixed(1), (g.y0 + (Math.floor(k / g.w) + 0.5) * 0.1).toFixed(1)]; } } }
    check(miss <= 0.01 * total, () => (100 * miss / total).toFixed(1) + '% of the boundary has no outline within ' + reach + ' mm; worst at (' + at + '), ' + worst.toFixed(2) + ' mm away');
  });
  t.test(key + ': outline stitch lengths', () => {
    const L = lengths(segs);
    check(L.over121 === 0, L.over121 + ' stitches over 12.1 mm');
    check(L.longest <= 7.15, 'longest outline stitch ' + L.longest.toFixed(2) + ' mm');
    check(L.under04 <= Math.max(4, 0.03 * L.n), L.under04 + ' of ' + L.n + ' stitches under 0.4 mm');
  });
}

/* ---------- satin width ---------- */
// a straight horizontal column: the needle must swing width/2 either side of the centre line
const widths = [];
for (const w of [1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12]) {
  for (const [name, x1, y1, x2, y2] of [['horizontal', 15, 50, 85, 50], ['diagonal', 20, 20, 80, 70]]) {
    const design = { name: 'satin', hoop: { width: 100, height: 100 }, objects: [{ type: 'line', x1, y1, x2, y2, color: '#000000', line: { type: 'satin', width: w } }] };
    const r = Engine.generate(design);
    t.test('satin ' + w + ' mm ' + name + ': sewn width', () => {
      check(r.canExport, 'not exportable: ' + JSON.stringify(r.warnings.map(x => x.code)));
      const runs = [].concat(...C.irRuns(r.ir).blocks), len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      // signed distance of every needle point from the centre line, for the middle 80% of the column
      const side = [];
      for (const run of runs) for (let i = 0; i < run.length; i += 2) { const p = C.irMm(r.ir, run[i], run[i + 1]), a = (p[0] - x1) * ux + (p[1] - y1) * uy, d = -(p[0] - x1) * uy + (p[1] - y1) * ux; if (a > 0.1 * len && a < 0.9 * len) side.push(d); }
      const hi = Math.max(...side), lo = Math.min(...side), sewn = hi - lo;
      // top layer = the outermost needle points; their median says where the column edge really is
      const edgeHi = side.filter(d => d > hi - 0.3).length, edgeLo = side.filter(d => d < lo + 0.3).length;
      widths.push(w + (name === 'diagonal' ? 'd' : '') + ' -> ' + sewn.toFixed(2));
      check(Math.abs(hi + lo) <= 0.25, 'the column is off centre: ' + lo.toFixed(2) + ' .. ' + hi.toFixed(2));
      // asked width, plus up to 0.2 mm of pull compensation per side, minus nothing
      check(sewn >= w - 0.15 && sewn <= w + 0.4 + 0.15, 'asked for ' + w + ' mm, the needle swings ' + sewn.toFixed(2) + ' mm');
      check(edgeHi >= 0.3 * len / 0.4 * 0.8 && edgeLo >= 0.3 * len / 0.4 * 0.8, 'too few needle points on the column edges (' + edgeLo + ' / ' + edgeHi + ' over ' + (0.8 * len).toFixed(0) + ' mm at 0.4 mm spacing)');
      const L = lengths(segments(r.ir, runs));
      check(L.over121 === 0 && L.longest <= 7.15, 'longest satin stitch ' + L.longest.toFixed(2) + ' mm for a ' + w + ' mm column');
    });
  }
}
t.note('satin: asked -> needle swing (mm): ' + widths.join(', '));

/* ---------- lines ---------- */
for (const [type, sl] of [['running', 2.5], ['bean', 2.5], ['running', 1], ['running', 7], ['bean', 4]]) {
  // a gentle wave: tightest radius 16.9 mm (amplitude 10 mm, 1 / 13 per step of 1 mm)
  const pts = Array.from({ length: 81 }, (_, i) => [10 + i, 50 + 10 * Math.sin(i / 13)]);
  const r = Engine.generate({ hoop: { width: 100, height: 100 }, objects: [{ type: 'polyline', points: pts, color: '#000000', line: { type, stitchLength: sl } }] });
  t.test(type + ' line, stitch length ' + sl + ': follows the path', () => {
    const runs = [].concat(...C.irRuns(r.ir).blocks), segs = segments(r.ir, runs);
    const dist = (x, y) => { let best = Infinity; for (let i = 1; i < pts.length; i++) { const ax = pts[i - 1][0], ay = pts[i - 1][1], bx = pts[i][0], by = pts[i][1], l2 = (bx - ax) ** 2 + (by - ay) ** 2, u = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l2)); best = Math.min(best, Math.hypot(x - ax - u * (bx - ax), y - ay - u * (by - ay))); } return best; };
    let worst = 0;
    for (let i = 0; i < segs.length; i += 4) for (let k = 0; k <= 10; k++) worst = Math.max(worst, dist(segs[i] + (segs[i + 2] - segs[i]) * k / 10, segs[i + 1] + (segs[i + 3] - segs[i + 1]) * k / 10));
    // a chord of length sl across the tightest bend sags by the sagitta; plus the grid
    const R = 16.9, sag = R - Math.sqrt(R * R - sl * sl / 4);
    check(worst <= sag + 0.15, 'thread strays ' + worst.toFixed(2) + ' mm from the drawn line (a ' + sl + ' mm chord may sag ' + sag.toFixed(2) + ')');
    const L = lengths(segs), core = [];
    for (let i = 0; i < segs.length; i += 4) core.push(Math.hypot(segs[i + 2] - segs[i], segs[i + 3] - segs[i + 1]));
    core.sort((a, b) => a - b);
    const median = core[core.length >> 1];
    check(Math.abs(median - sl) <= 0.35 * sl, 'median stitch ' + median.toFixed(2) + ' mm, asked ' + sl);
    check(L.longest <= sl + 0.6, 'longest ' + L.longest.toFixed(2));
    // both ends reached
    const ends = [pts[0], pts[pts.length - 1]].map(p => Math.min(...Array.from({ length: segs.length / 4 }, (_, i) => Math.min(Math.hypot(segs[4 * i] - p[0], segs[4 * i + 1] - p[1]), Math.hypot(segs[4 * i + 2] - p[0], segs[4 * i + 3] - p[1])))));
    check(ends[0] <= 0.15 && ends[1] <= 0.15, 'the line ends are missed by ' + ends.map(e => e.toFixed(2)).join(' / ') + ' mm');
    // thread laid down: once along the path for a running stitch, three times for a bean stitch (plus tie-offs)
    let path = 0; for (let i = 1; i < pts.length; i++) path += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const passes = L.total / path, want = type === 'bean' ? 3 : 1;
    check(passes >= want * 0.97 && passes <= want * 1.06 + 4 / path, 'thread is ' + passes.toFixed(2) + ' x the path length, expected ' + want);
  });
}
module.exports = t.done();
