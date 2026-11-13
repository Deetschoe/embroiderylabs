#!/usr/bin/env node
/*
 * Tests for the picture tracer (js/trace). Plain node, no packages to install.
 *
 *   node tests/trace/run.js              everything node alone can check, then the machine-file read-back if
 *                                        venv/bin/python has pyembroidery + Pillow (skipped with a message if not)
 *   --no-python          never start python
 *   --only=word          only tests whose name contains the word
 *   --keep=<dir>         keep the machine files and the pictures of the stitches in <dir>
 *   --verbose            list every test
 *
 * The pictures are painted here, so the truth is known exactly: where each colour is, how large, with which holes.
 * Every result is also checked with code that does not come from trace.js (ring validity, coverage raster) and
 * pushed through the real engine. Exit code 0 when nothing failed. Skips are listed, never counted as passes.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const Trace = require(path.join(ROOT, 'js', 'trace', 'client.js'));     // trace.js + createClient
const Engine = require(path.join(ROOT, 'js', 'engine', 'engine.js'));
const e2e = require('./e2e.js');

const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const val = n => { const a = args.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : null; };
const ONLY = val('only'), VERBOSE = flag('verbose'), KEEP = val('keep');

// ------------------------------------------------------------------ tiny harness
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
class Skip extends Error {}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'expected equal') + ': got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b)); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error((msg || 'value') + ': got ' + (Math.round(a * 1000) / 1000) + ', wanted ' + b + ' +/- ' + tol); }
function within(a, lo, hi, msg) { if (!(a >= lo && a <= hi)) throw new Error((msg || 'value') + ': got ' + (Math.round(a * 1000) / 1000) + ', wanted ' + lo + '..' + hi); }

// ------------------------------------------------------------------ painting pictures with known truth
const WHITE = [255, 255, 255, 255], CLEAR = [0, 0, 0, 0];
const RED = [214, 40, 40, 255], BLUE = [29, 58, 110, 255], YELLOW = [240, 190, 30, 255], GREEN = [40, 140, 70, 255], BLACK = [20, 20, 20, 255];
/* shapes: [{ in(x, y) -> bool, color }] painted in order over bg; ss x ss samples per pixel give soft edges */
function paint(w, h, bg, shapes, ss) {
  ss = ss || 4;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const px = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss;
      let c = bg;
      for (let i = shapes.length - 1; i >= 0; i--) if (shapes[i].in(px, py)) { c = shapes[i].color; break; }
      const al = c[3] / 255; r += c[0] * al; g += c[1] * al; b += c[2] * al; a += al;
    }
    const o = (y * w + x) * 4, n = ss * ss;
    if (a > 0) { data[o] = r / a; data[o + 1] = g / a; data[o + 2] = b / a; }
    data[o + 3] = a / n * 255;
  }
  return { width: w, height: h, data };
}
const disc = (cx, cy, r, color) => ({ color, in: (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r });
const ring = (cx, cy, r1, r0, color) => ({ color, in: (x, y) => { const d = (x - cx) * (x - cx) + (y - cy) * (y - cy); return d <= r1 * r1 && d >= r0 * r0; } });
const rect = (x0, y0, x1, y1, color) => ({ color, in: (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1 });
const band = (ax, ay, bx, by, wd, color) => ({ color, in: (x, y) => {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy) <= wd / 2; } });
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// ------------------------------------------------------------------ independent geometry checks
function signedArea(r) { let a = 0; for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
function pathArea(o) { return o.rings.reduce((s, r, i) => s + (i === 0 ? 1 : -1) * Math.abs(signedArea(r)), 0); }
function inRing(p, r) { let c = false; for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) { const a = r[i], b = r[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
function orient(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
function segsCross(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}
/* number of proper crossings between non-neighbouring edges of one ring, or between two rings */
function crossings(r1, r2) {
  let n = 0;
  const same = !r2; r2 = r2 || r1;
  for (let i = 0; i < r1.length; i++) {
    const a = r1[i], b = r1[(i + 1) % r1.length];
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    for (let j = same ? i + 2 : 0; j < r2.length; j++) {
      if (same && i === 0 && j === r1.length - 1) continue;
      const c = r2[j], d = r2[(j + 1) % r2.length];
      if (Math.max(c[0], d[0]) < x0 || Math.min(c[0], d[0]) > x1 || Math.max(c[1], d[1]) < y0 || Math.min(c[1], d[1]) > y1) continue;
      if (segsCross(a, b, c, d)) n++;
    }
  }
  return n;
}
/* Everything the engine and a sewing machine need from the shapes; throws with the first thing wrong. */
function checkShapes(res, label) {
  const W = res.size.width, H = res.size.height, ox = res.origin.x, oy = res.origin.y, slack = 1.0;
  const ids = new Set();
  res.objects.forEach((o, k) => {
    const at = label + ' object ' + k + ' (' + o.name + ')';
    ok(/^[\w-]{1,40}$/.test(o.id) && !ids.has(o.id), at + ': bad or repeated id'); ids.add(o.id);
    ok(/^#[0-9a-f]{6}$/.test(o.color), at + ': colour ' + o.color);
    ok(res.colors[o.trace.color] && res.colors[o.trace.color].hex === o.color, at + ': colour index does not match');
    const lists = o.type === 'path' ? o.rings : [o.points];
    ok(o.type === 'path' || o.type === 'polyline', at + ': type ' + o.type);
    for (const r of lists) {
      ok(Array.isArray(r) && r.length >= (o.type === 'path' ? 3 : 2), at + ': too few points');
      for (let i = 0; i < r.length; i++) {
        const p = r[i];
        ok(Number.isFinite(p[0]) && Number.isFinite(p[1]), at + ': point is not a number');
        ok(p[0] >= ox - slack && p[0] <= ox + W + slack && p[1] >= oy - slack && p[1] <= oy + H + slack, at + ': point outside the picture ' + p);
        const q = r[(i + 1) % r.length];
        if (o.type === 'path' || i + 1 < r.length) ok(Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6, at + ': repeated point');
      }
    }
    if (o.type === 'path') {
      eq(o.paint, 'fill', at + ' paint');
      ok(o.fill && o.fill.angle >= 0 && o.fill.angle < 180 && o.fill.spacing >= 0.2, at + ': fill settings');
      const outer = o.rings[0];
      ok(Math.abs(signedArea(outer)) > 0.3, at + ': outline with no area');
      o.rings.forEach((r, i) => eq(crossings(r), 0, at + ': ring ' + i + ' crosses itself'));
      for (let i = 1; i < o.rings.length; i++) {
        ok(Math.abs(signedArea(o.rings[i])) < Math.abs(signedArea(outer)), at + ': hole larger than its outline');
        ok(signedArea(o.rings[i]) * signedArea(outer) < 0, at + ': hole ' + i + ' is wound the same way as its outline');
        ok(o.rings[i].every(p => inRing(p, outer)), at + ': hole ' + i + ' is not inside its outline');
        eq(crossings(o.rings[i], outer), 0, at + ': hole ' + i + ' crosses its outline');
        for (let j = i + 1; j < o.rings.length; j++) {
          eq(crossings(o.rings[i], o.rings[j]), 0, at + ': holes cross');
          ok(!inRing(o.rings[j][0], o.rings[i]) && !inRing(o.rings[i][0], o.rings[j]), at + ': hole inside a hole');
        }
      }
      near(pathArea(o), o.trace.areaMm2, Math.max(0.5, o.trace.areaMm2 * 0.02), at + ': reported area');
    } else {
      eq(o.paint, 'line', at + ' paint');
      ok(['running', 'bean', 'satin'].includes(o.line.type), at + ': line type');
      if (o.line.type === 'satin') within(o.line.width, 1, 12, at + ': satin width');
    }
  });
  eq(res.stats.objects, res.objects.length, label + ' stats.objects');
  eq(res.stats.colors, res.colors.length, label + ' stats.colors');
}
/* The shapes as the engine would see them, moved into the middle of a hoop. */
function inHoop(res, pad) {
  pad = pad === undefined ? 10 : pad;
  const hoop = { width: Math.max(20, Math.ceil(res.size.width + 2 * pad)), height: Math.max(20, Math.ceil(res.size.height + 2 * pad)) };
  const dx = (hoop.width - res.size.width) / 2 - res.origin.x, dy = (hoop.height - res.size.height) / 2 - res.origin.y;
  const mv = p => [p[0] + dx, p[1] + dy];
  const objects = res.objects.map(o => o.type === 'path' ? Object.assign({}, o, { rings: o.rings.map(r => r.map(mv)) }) : Object.assign({}, o, { points: o.points.map(mv) }));
  return { hoop, objects };
}
/* The real engine must take every object and make stitches for it. Returns the generate() result. */
function checkEngine(res, label, allow) {
  const d = inHoop(res);
  const gen = Engine.generate({ name: 'test', hoop: d.hoop, objects: d.objects });
  ok(gen.ok && gen.canExport, label + ': the engine refused the design: ' + JSON.stringify(gen.warnings.slice(0, 3)));
  eq(gen.objects.length, res.objects.length, label + ': engine object count');
  gen.objects.forEach((g, i) => ok(!g.skipped && g.stitches > 0, label + ': the engine made no stitches for object ' + i + ' (' + res.objects[i].name + ')'));
  // COLORS_MERGED (engine, added 2026-11-12 while these tests were being extended): two design colours share one of
  // the 64 Brother chart entries a PES file can name. A fact about the file format, not a fault of the traced shapes.
  const bad = gen.warnings.filter(w => w.severity === 'error' || (w.severity === 'warning' && w.code !== 'COLORS_MERGED' && !(allow || []).includes(w.code)));
  ok(!bad.length, label + ': engine warnings ' + JSON.stringify(bad.map(w => w.code + ' ' + w.message).slice(0, 4)));
  ok(gen.totals.longestStitchMm <= 12.2, label + ': longest stitch ' + gen.totals.longestStitchMm);
  return gen;
}
/* Paint the result at `g` mm per cell: owner[i] = index of the LAST object covering the cell (what shows), -1 = bare cloth;
   layers[i] = how many fills cover it. Scanline even-odd over outline + holes; lines as thick strokes. */
function raster(res, g) {
  g = g || 0.1;
  const W = Math.ceil(res.size.width / g), H = Math.ceil(res.size.height / g), ox = res.origin.x, oy = res.origin.y;
  const owner = new Int16Array(W * H).fill(-1), layers = new Uint8Array(W * H);
  res.objects.forEach((o, k) => {
    if (o.type === 'path') {
      const edges = [];
      for (const r of o.rings) for (let i = 0; i < r.length; i++) edges.push([r[i], r[(i + 1) % r.length]]);
      for (let y = 0; y < H; y++) {
        const py = oy + (y + 0.5) * g, xs = [];
        for (const [a, b] of edges) if ((a[1] > py) !== (b[1] > py)) xs.push(a[0] + (py - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
        xs.sort((p, q) => p - q);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const x0 = Math.max(0, Math.ceil((xs[i] - ox) / g - 0.5)), x1 = Math.min(W - 1, Math.floor((xs[i + 1] - ox) / g - 0.5));
          for (let x = x0; x <= x1; x++) { owner[y * W + x] = k; layers[y * W + x]++; }
        }
      }
    } else {
      const hw = Math.max(0.2, (o.line.type === 'satin' ? o.line.width : 0.4) / 2), n = o.points.length;
      for (let i = 0; i < (o.closed ? n : n - 1); i++) {
        const a = o.points[i], b = o.points[(i + 1) % n];
        const x0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - hw - ox) / g)), x1 = Math.min(W - 1, Math.ceil((Math.max(a[0], b[0]) + hw - ox) / g));
        const y0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - hw - oy) / g)), y1 = Math.min(H - 1, Math.ceil((Math.max(a[1], b[1]) + hw - oy) / g));
        const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const px = ox + (x + 0.5) * g, py = oy + (y + 0.5) * g, t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L2));
          if (Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy) <= hw) owner[y * W + x] = k;
        }
      }
    }
  });
  return { owner, layers, W, H, g };
}
/* Compare the raster with the truth. truth(xmm, ymm) -> a key (anything) for "thread belongs here", or null for cloth.
   A cell only counts when the truth is the same `margin` mm around it, so the exact position of an edge is not judged.
   Returns { bare: mm2 that should have thread but has none, spill: mm2 with thread where cloth should show,
             want: mm2 that should have thread, wrong(colorOf): mm2 showing the wrong colour } */
function compare(res, truth, margin, colorOf) {
  const R = raster(res), g = R.g, cell = g * g, m = margin === undefined ? 0.45 : margin;
  const dirs = [[0, 0], [m, 0], [-m, 0], [0, m], [0, -m], [m * 0.7, m * 0.7], [-m * 0.7, m * 0.7], [m * 0.7, -m * 0.7], [-m * 0.7, -m * 0.7]];
  let bare = 0, spill = 0, want = 0, wrong = 0, double = 0, triple = 0;
  for (let y = 0; y < R.H; y++) for (let x = 0; x < R.W; x++) {
    const px = (x + 0.5) * g, py = (y + 0.5) * g, i = y * R.W + x;
    if (R.layers[i] === 2) double += cell; else if (R.layers[i] > 2) triple += cell;
    const t0 = truth(px, py);
    let same = true;
    for (let d = 1; d < dirs.length && same; d++) if (truth(px + dirs[d][0], py + dirs[d][1]) !== t0) same = false;
    if (!same) continue;
    if (t0 === null) { if (R.owner[i] >= 0) spill += cell; continue; }
    want += cell;
    if (R.owner[i] < 0) bare += cell;
    else if (colorOf && colorOf(res.objects[R.owner[i]]) !== t0) wrong += cell;
  }
  return { bare, spill, want, wrong, double, triple };
}
const hexRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const colorDist = (hex, c) => { const a = hexRgb(hex); return Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]); };
/* which of the named colours an object is sewn in */
const nameOf = named => o => { let best = null, bd = 1e9; for (const k in named) { const d = colorDist(o.color, named[k]); if (d < bd) { bd = d; best = k; } } return best; };
const fills = res => res.objects.filter(o => o.type === 'path');
const lines = res => res.objects.filter(o => o.type === 'polyline');
function full(res, label, allow) { ok(res.ok, label + ': not ok: ' + JSON.stringify(res.warnings)); checkShapes(res, label); return checkEngine(res, label, allow); }

// ================================================================== the tests
// All pictures: 240 px for 60 mm unless said otherwise, so 4 px = 1 mm.
const MM = 4, opts60 = { width: 60 };

test('rectangle on a white page: one shape, right size, right place, page left out', () => {
  const img = paint(240, 240, WHITE, [rect(60, 80, 180, 160, RED)]);
  const res = Trace.trace(img, opts60);
  full(res, 'rect');
  eq(res.objects.length, 1, 'objects'); eq(res.colors.length, 1, 'colours');
  eq(res.background.removed, true); eq(res.background.reason, 'border');
  ok(res.warnings.some(w => w.code === 'BACKGROUND_REMOVED'), 'says the page was left out');
  const o = res.objects[0];
  eq(o.rings.length, 1, 'no holes');
  near(pathArea(o), 30 * 20, 600 * 0.03, 'area mm2');
  ok(colorDist(o.color, RED) < 12, 'colour ' + o.color);
  eq(res.colors[0].name, 'Red'); ok(res.colors[0].thread && /^#[0-9a-f]{6}$/.test(res.colors[0].thread.hex), 'thread suggestion');
  const xs = o.rings[0].map(p => p[0]), ys = o.rings[0].map(p => p[1]);
  near(Math.min(...xs), 15, 0.3, 'left'); near(Math.max(...xs), 45, 0.3, 'right'); near(Math.min(...ys), 20, 0.3, 'top'); near(Math.max(...ys), 40, 0.3, 'bottom');
  ok(o.rings[0].length <= 12, 'a rectangle needs few points, got ' + o.rings[0].length);
  // real corners must stay corners: some vertex within 0.35 mm of each true corner
  for (const c of [[15, 20], [45, 20], [45, 40], [15, 40]]) ok(o.rings[0].some(p => Math.hypot(p[0] - c[0], p[1] - c[1]) < 0.35), 'corner ' + c + ' was rounded off');
  eq(res.size.width, 60); eq(res.size.height, 60);
});

test('background "off" keeps the page as a shape that goes under the rectangle', () => {
  const img = paint(240, 240, WHITE, [rect(60, 80, 180, 160, RED)]);
  const res = Trace.trace(img, { width: 60, background: 'off' });
  full(res, 'rect+page');
  eq(res.objects.length, 2); eq(res.background.removed, false);
  const [page, box] = res.objects;
  ok(colorDist(page.color, WHITE) < 12 && colorDist(box.color, RED) < 12, 'page first, then the rectangle');
  eq(page.rings.length, 2, 'the page has a hole under the rectangle');
  const hole = Math.abs(signedArea(page.rings[1]));
  within(hole, 600 * 0.80, 600 * 0.995, 'the hole is a little smaller than the rectangle (the page tucks under it)');
  const c = compare(res, () => 'x', 0.3);
  eq(c.bare, 0, 'bare cloth');
  eq(Trace.trace(img, { width: 60, background: false }).objects.length, 2, 'background:false means "off"');
  ok(!Trace.trace(img, { width: 60, background: true }).warnings.some(w => w.code === 'INVALID_OPTION'), 'background:true is accepted');
});

test('ring: the hole stays a hole, soft edges do not become extra shapes', () => {
  const img = paint(240, 240, WHITE, [ring(120, 120, 88, 48, BLUE)]);
  const res = Trace.trace(img, opts60);
  full(res, 'ring');
  eq(res.objects.length, 1, 'objects'); eq(res.colors.length, 1, 'colours (the blended edge pixels are not a colour)');
  const o = res.objects[0];
  eq(o.rings.length, 2, 'one hole');
  near(pathArea(o), Math.PI * (22 * 22 - 12 * 12), Math.PI * (22 * 22 - 12 * 12) * 0.02, 'area mm2');
  for (const p of o.rings[0]) near(Math.hypot(p[0] - 30, p[1] - 30), 22, 0.25, 'outer edge radius');
  for (const p of o.rings[1]) near(Math.hypot(p[0] - 30, p[1] - 30), 12, 0.25, 'hole radius');
  ok(o.rings[0].length >= 24 && o.rings[0].length <= 140, 'outer ring points ' + o.rings[0].length);
  // smooth, not a staircase: no turn sharper than 35 degrees anywhere on a circle
  for (const r of o.rings) for (let i = 0; i < r.length; i++) {
    const a = r[(i + r.length - 1) % r.length], b = r[i], c = r[(i + 1) % r.length];
    const t = Math.abs(Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])));
    ok(t < 35 * Math.PI / 180, 'jagged turn of ' + Math.round(t * 180 / Math.PI) + ' degrees on a circle');
  }
  const c = compare(res, (x, y) => { const d = Math.hypot(x - 30, y - 30); return d <= 22 && d >= 12 ? 'b' : null; }, 0.3);
  eq(c.bare, 0, 'bare'); eq(c.spill, 0, 'thread in the hole or outside');
});

test('small hole (3 mm) in a shape is kept; a pinhole (0.5 mm) is closed', () => {
  const img = paint(240, 240, CLEAR, [rect(40, 40, 200, 200, GREEN), disc(90, 120, 6, CLEAR), disc(160, 120, 1, CLEAR)]);
  const res = Trace.trace(img, opts60);
  full(res, 'holes');
  eq(res.objects.length, 1);
  eq(res.objects[0].rings.length, 2, 'exactly the 3 mm hole');
  near(Math.abs(signedArea(res.objects[0].rings[1])), Math.PI * 1.5 * 1.5, 1.2, 'hole area');
  const h = res.objects[0].rings[1], cx = h.reduce((s, p) => s + p[0], 0) / h.length;
  near(cx, 22.5, 0.4, 'it is the left hole');
});

test('concentric discs: three colours, nested holes, biggest first', () => {
  const img = paint(240, 240, WHITE, [disc(120, 120, 96, BLUE), disc(120, 120, 60, YELLOW), disc(120, 120, 24, RED)]);
  const res = Trace.trace(img, opts60);
  full(res, 'concentric');
  eq(res.objects.length, 3); eq(res.colors.length, 3);
  const who = nameOf({ blue: BLUE, yellow: YELLOW, red: RED });
  eq(res.objects.map(who).join(','), 'blue,yellow,red', 'sewing order');
  eq(res.objects[0].rings.length, 2, 'blue has a hole'); eq(res.objects[1].rings.length, 2, 'yellow has a hole'); eq(res.objects[2].rings.length, 1, 'red is solid');
  // each lower shape tucks under the next: its hole is smaller than the shape above, but not filled in
  within(Math.abs(signedArea(res.objects[0].rings[1])), Math.PI * 15 * 15 * 0.85, Math.PI * 15 * 15 * 0.999, 'blue hole under yellow');
  within(Math.abs(signedArea(res.objects[1].rings[1])), Math.PI * 6 * 6 * 0.70, Math.PI * 6 * 6 * 0.999, 'yellow hole under red');
  near(Math.abs(signedArea(res.objects[2].rings[0])), Math.PI * 36, Math.PI * 36 * 0.04, 'red area');
  const truth = (x, y) => { const d = Math.hypot(x - 30, y - 30); return d <= 6 ? 'red' : d <= 15 ? 'yellow' : d <= 24 ? 'blue' : null; };
  const c = compare(res, truth, 0.3, who);
  eq(c.bare, 0, 'bare cloth between the colours'); eq(c.spill, 0, 'spill'); eq(c.wrong, 0, 'wrong colour on top');
  eq(c.triple, 0, 'never three layers');
  within(c.double, 20, 140, 'overlap between neighbours, mm2');
});

test('two touching colours: no gap at the seam, the first one tucks under the second', () => {
  const img = paint(240, 160, CLEAR, [rect(30, 30, 120, 130, RED), rect(120, 30, 210, 130, BLUE)], 1);
  const res = Trace.trace(img, opts60);
  full(res, 'seam');
  eq(res.objects.length, 2); eq(res.background.reason, 'transparent');
  // which half is sewn first is the tracer's choice; whichever it is must reach under the other, which stops at the seam
  const [a, b] = res.objects, xsA = a.rings[0].map(p => p[0]), xsB = b.rings[0].map(p => p[0]);
  const aIsLeft = Math.min(...xsA) < Math.min(...xsB);
  const reach = aIsLeft ? Math.max(...xsA) - 30 : 30 - Math.min(...xsA), edge = aIsLeft ? Math.min(...xsB) : Math.max(...xsB);
  near(edge, 30, 0.15, 'the second shape ends exactly at the seam');
  within(reach, 0.25, 0.8, 'the first shape reaches under the second by (mm)');
  // strictest form: no margin at all along the seam, only around the outside
  const c = compare(res, (x, y) => (x >= 7.5 && x <= 52.5 && y >= 7.5 && y <= 32.5) ? 't' : null, 0.3);
  eq(c.bare, 0, 'bare cloth'); eq(c.spill, 0, 'spill');
  const R = raster(res);
  for (let y = Math.round(9 / R.g); y < Math.round(31 / R.g); y++) for (let x = Math.round(28 / R.g); x < Math.round(32 / R.g); x++) ok(R.owner[y * R.W + x] >= 0, 'gap at the seam at ' + x * R.g + ',' + y * R.g);
  ok(Math.abs(a.fill.angle - b.fill.angle) >= 30, 'touching shapes get different stitch directions (' + a.fill.angle + ', ' + b.fill.angle + ')');
});

test('thin lines: hairline -> running/bean line, 2 mm stroke -> satin of that width, neither becomes a fill', () => {
  const img = paint(240, 240, WHITE, [band(30, 40, 210, 60, 1.6, BLACK), band(30, 120, 210, 150, 8, BLACK), ring(120, 200, 26, 22.5, RED)]);
  const res = Trace.trace(img, opts60);
  full(res, 'lines');
  eq(fills(res).length, 0, 'fills');
  const L = lines(res);
  eq(L.length, 3, 'lines');
  const hair = L.find(o => o.points[0][1] < 20), stroke = L.find(o => o.points[0][1] > 25 && o.points[0][1] < 42), loop = L.find(o => o.points[0][1] > 42);
  ok(hair && stroke && loop, 'all three found');
  ok(hair.line.type === 'bean' || hair.line.type === 'running', 'hairline type ' + hair.line.type);
  near(hair.trace.lengthMm, Math.hypot(45, 5), 1.2, 'hairline length');
  for (const p of hair.points) near(p[1], 10 + (p[0] - 7.5) / 45 * 5, 0.2, 'hairline stays on the line');
  eq(stroke.line.type, 'satin'); near(stroke.line.width, 2.0, 0.3, 'satin width');
  near(stroke.trace.lengthMm, Math.hypot(45, 7.5), 2.2, 'stroke length');
  for (const p of stroke.points) near(p[1], 30 + (p[0] - 7.5) / 45 * 7.5, 0.25, 'satin runs along the middle of the stroke');
  ok(stroke.points.length <= 6, 'a straight stroke needs few points, got ' + stroke.points.length);
  eq(loop.closed, true, 'the circle outline is a closed line');
  for (const p of loop.points) near(Math.hypot(p[0] - 30, p[1] - 50), (26 + 22.5) / 2 / MM, 0.25, 'circle outline radius');
  ok(colorDist(loop.color, RED) < 14 && colorDist(hair.color, BLACK) < 14, 'colours');
});

test('soft-edged disc at three picture resolutions gives the same shape', () => {
  const areas = [];
  for (const px of [120, 240, 720]) {
    const k = px / 60, img = paint(px, px, CLEAR, [disc(30 * k, 30 * k, 15 * k, RED)]);
    const res = Trace.trace(img, opts60);
    full(res, 'disc' + px);
    eq(res.objects.length, 1, 'objects at ' + px); eq(res.colors.length, 1, 'colours at ' + px);
    ok(colorDist(res.objects[0].color, RED) < 12, 'colour not dirtied by the soft edge: ' + res.objects[0].color);
    const tol = px === 120 ? 0.3 : 0.2;
    for (const p of res.objects[0].rings[0]) near(Math.hypot(p[0] - 30, p[1] - 30), 15, tol, 'radius at ' + px + ' px');
    areas.push(pathArea(res.objects[0]));
  }
  for (const a of areas) near(a, Math.PI * 225, Math.PI * 225 * 0.02, 'area');
});

test('specks: single-pixel dirt disappears, the shape stays whole', () => {
  const r = rng(7), dots = [];
  for (let i = 0; i < 160; i++) dots.push(rect(44 + Math.floor(r() * 150), 44 + Math.floor(r() * 150), 0, 0, i % 2 ? BLACK : WHITE));
  dots.forEach(d => { const x = d.in; }); // (placeholders replaced below)
  const img = paint(240, 240, WHITE, [rect(40, 40, 200, 200, GREEN)], 1);
  const rr = rng(7);
  for (let i = 0; i < 160; i++) { const x = 44 + Math.floor(rr() * 150), y = 44 + Math.floor(rr() * 150), c = i % 2 ? BLACK : WHITE, o = (y * 240 + x) * 4; img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; }
  const res = Trace.trace(img, opts60);
  full(res, 'specks');
  eq(res.objects.length, 1, 'objects'); eq(res.objects[0].rings.length, 1, 'no holes'); eq(res.colors.length, 1);
  near(pathArea(res.objects[0]), 1600, 1600 * 0.02, 'area');
});

test('checkerboard of 0.5 mm squares: too fine to sew, must not become hundreds of shapes', () => {
  const img = paint(160, 160, WHITE, [{ color: BLACK, in: (x, y) => x >= 20 && x < 140 && y >= 20 && y < 140 && ((Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0) }], 1);
  const res = Trace.trace(img, { width: 40 });
  ok(res.ok || res.warnings.some(w => w.code === 'EMPTY_IMAGE'), 'well-formed answer');
  checkShapes(res, 'checker');
  ok(res.objects.length <= 6, 'objects ' + res.objects.length);
  if (res.objects.length) checkEngine(res, 'checker', ['TOO_DENSE']);
});

test('checkerboard of 5 mm squares: every square is found', () => {
  const img = paint(240, 240, WHITE, [{ color: BLACK, in: (x, y) => x >= 40 && x < 200 && y >= 40 && y < 200 && ((Math.floor((x - 40) / 20) + Math.floor((y - 40) / 20)) % 2 === 0) }], 1);
  const res = Trace.trace(img, opts60);
  full(res, 'checker5');
  // 32 black squares that touch only at corners: 4-connected, so 32 separate shapes of 25 mm2
  eq(fills(res).length, 32, 'squares'); eq(res.colors.length, 1);
  // edges are found on the working grid (0.22 mm a cell at medium detail), so each side of a 5 mm square can be
  // off by up to a cell: 4.8 x 4.8 = 23 mm2 is as near as this method gets
  for (const o of fills(res)) { eq(o.rings.length, 1); near(pathArea(o), 25, 2.2, 'square area'); }
  const c = compare(res, (x, y) => (x >= 10 && x < 50 && y >= 10 && y < 50 && ((Math.floor((x - 10) / 5) + Math.floor((y - 10) / 5)) % 2 === 0)) ? 'k' : null, 0.3);
  eq(c.bare, 0); eq(c.spill, 0);
});

test('smooth gradient: banded into the asked number of colours, covered without gaps, says so', () => {
  const w = 300, h = 200, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4, t = x / (w - 1); data[o] = 30 + 200 * t; data[o + 1] = 60 + 60 * t; data[o + 2] = 200 - 150 * t; data[o + 3] = 255; }
  const res = Trace.trace({ width: w, height: h, data }, { width: 75, colors: 4 });
  full(res, 'gradient');
  within(res.colors.length, 3, 4, 'colours');
  within(res.objects.length, 3, 8, 'bands');
  eq(res.mode, 'photo'); ok(res.warnings.some(x => x.code === 'PHOTO_POSTERIZED'), 'warns that shading becomes bands');
  const c = compare(res, () => 't', 0.3);
  eq(c.bare, 0, 'bare cloth'); eq(c.triple, 0, 'three layers');
  // bands in order left to right, each a vertical strip
  const mids = fills(res).map(o => ({ x: o.rings[0].reduce((s, p) => s + p[0], 0) / o.rings[0].length, L: hexRgb(o.color)[0] })).sort((a, b) => a.x - b.x);
  for (let i = 1; i < mids.length; i++) ok(mids[i].L >= mids[i - 1].L - 2, 'bands follow the gradient');
});

test('pure noise: stays bounded, valid and quick', () => {
  const r = rng(99), w = 200, h = 200, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r() * 256; data[i * 4 + 1] = r() * 256; data[i * 4 + 2] = r() * 256; data[i * 4 + 3] = 255; }
  const t0 = Date.now();
  const res = Trace.trace({ width: w, height: h, data }, { width: 50, colors: 8 });
  const ms = Date.now() - t0;
  checkShapes(res, 'noise');
  ok(res.objects.length <= 150, 'objects ' + res.objects.length);
  ok(ms < 3000, 'took ' + ms + ' ms');
  if (res.objects.length) checkEngine(res, 'noise', ['TOO_DENSE', 'MANY_TRIMS', 'SMALL_OBJECT']);
});

test('coloured noise on a logo (like a bad JPEG) does not change what is found', () => {
  const img = paint(240, 240, WHITE, [disc(120, 120, 90, BLUE), rect(90, 90, 150, 150, YELLOW)]);
  const r = rng(5);
  for (let i = 0; i < img.data.length; i += 4) for (let c = 0; c < 3; c++) img.data[i + c] = Math.max(0, Math.min(255, img.data[i + c] + (r() - 0.5) * 24));
  const res = Trace.trace(img, opts60);
  full(res, 'noisy logo');
  eq(res.mode, 'logo'); eq(res.objects.length, 2); eq(res.colors.length, 2);
  eq(res.objects[0].rings.length, 2); eq(res.objects[1].rings.length, 1);
  near(pathArea(res.objects[1]), 225, 225 * 0.04, 'square area');
});

test('transparent background with soft alpha edges', () => {
  const img = paint(240, 240, CLEAR, [disc(120, 120, 80, RED), disc(120, 120, 30, CLEAR)]);
  const res = Trace.trace(img, opts60);
  full(res, 'alpha');
  eq(res.background.removed, true); eq(res.background.reason, 'transparent');
  eq(res.objects.length, 1); eq(res.objects[0].rings.length, 2); eq(res.colors.length, 1);
  ok(colorDist(res.objects[0].color, RED) < 12, 'half-transparent edge pixels do not darken the colour: ' + res.objects[0].color);
  near(pathArea(res.objects[0]), Math.PI * (400 - 56.25), 1080 * 0.02, 'area');
  // black hidden under fully transparent pixels must not leak in
  const img2 = paint(240, 240, CLEAR, [disc(120, 120, 80, RED)]);
  for (let i = 0; i < img2.data.length; i += 4) if (img2.data[i + 3] === 0) { img2.data[i] = 0; img2.data[i + 1] = 255; img2.data[i + 2] = 0; }
  const res2 = Trace.trace(img2, opts60);
  eq(res2.colors.length, 1); ok(colorDist(res2.objects[0].color, RED) < 12, 'hidden colour leaked: ' + res2.objects[0].color);
});

test('one-colour picture: a single filled shape of the whole picture', () => {
  const img = paint(120, 80, GREEN, [], 1);
  const res = Trace.trace(img, opts60);
  full(res, 'flat');
  eq(res.objects.length, 1); eq(res.colors.length, 1); eq(res.objects[0].rings.length, 1);
  near(pathArea(res.objects[0]), 60 * 40, 60 * 40 * 0.01, 'area');
  ok(res.warnings.some(w => w.code === 'SINGLE_COLOR'), 'SINGLE_COLOR');
  eq(res.size.height, 40, 'height follows the picture');
});

test('empty and broken pictures: a clear answer, never a throw', () => {
  const empty = Trace.trace(paint(64, 64, CLEAR, [], 1), opts60);
  eq(empty.ok, false); eq(empty.objects.length, 0); ok(empty.warnings.some(w => w.code === 'EMPTY_IMAGE' && w.severity === 'error'));
  for (const bad of [null, undefined, 5, 'x', {}, { width: 0, height: 0, data: [] }, { width: 2, height: 2, data: new Uint8ClampedArray(3) }, { width: -1, height: 4, data: new Uint8ClampedArray(16) }, { width: 2.5, height: 2, data: new Uint8ClampedArray(20) }, { width: NaN, height: 1, data: [] }]) {
    const r = Trace.trace(bad, opts60);
    eq(r.ok, false, 'ok for ' + JSON.stringify(bad)); eq(r.objects.length, 0);
    ok(r.warnings.some(w => w.code === 'INVALID_IMAGE' && w.severity === 'error'), 'INVALID_IMAGE for ' + JSON.stringify(bad));
    ok(r.colors && r.size && r.stats && r.version, 'same shape of answer');
  }
});

test('1x1, 1xN and 2x2 pictures', () => {
  for (const [w, h] of [[1, 1], [1, 9], [9, 1], [2, 2], [3, 3]]) {
    const res = Trace.trace(paint(w, h, RED, [], 1), { width: 30 });
    ok(res.ok, w + 'x' + h + ' ok'); checkShapes(res, w + 'x' + h);
    eq(res.objects.length, 1);
    if (res.size.height >= 3) checkEngine(res, w + 'x' + h);
  }
  const res = Trace.trace({ width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255]) }, { width: 30 });
  ok(res.ok); checkShapes(res, '2x2'); checkEngine(res, '2x2');
  ok(res.warnings.some(w => w.code === 'LOW_RESOLUTION'), 'LOW_RESOLUTION');
});

test('absurd options are clamped and reported, plain arrays and wrong types are survived', () => {
  const img = paint(120, 120, WHITE, [disc(60, 60, 40, BLUE)]);
  const res = Trace.trace(img, { width: -5, colors: 999, detail: 'banana', mode: 3, background: {}, hoop: { width: 'x' }, x: 'left', y: Infinity, nonsense: 1 });
  full(res, 'absurd');
  const params = res.warnings.filter(w => w.code === 'INVALID_OPTION').map(w => w.param).sort().join(',');
  eq(params, 'background,colors,detail,hoop,mode,width,x,y', 'which options were reported');
  eq(res.size.width, Trace.LIMITS.width[0], 'width clamped to the minimum');
  for (const o of [undefined, null, 7, 'x', [], { width: 1e9 }, { width: NaN }, { colors: 2.6 }, { colors: '6' }, { detail: null }]) { const r = Trace.trace(img, o); ok(r.ok, 'options ' + JSON.stringify(o)); checkShapes(r, 'opt'); }
  eq(Trace.trace(img, { width: 1e9 }).size.width, Trace.LIMITS.width[1]);
  const plain = Trace.trace({ width: 120, height: 120, data: Array.from(img.data) }, opts60);
  eq(plain.objects.length, 1, 'a plain array of numbers works as pixel data');
  const huge = Trace.trace({ width: 40000, height: 40000, data: { length: 40000 * 40000 * 4 } }, opts60);
  eq(huge.ok, false); ok(huge.warnings.some(w => w.code === 'IMAGE_TOO_LARGE'), 'IMAGE_TOO_LARGE before any work is done');
});

test('options: colours limit, width, detail, position, hoop', () => {
  const sh = [rect(20, 20, 220, 220, BLUE), rect(40, 40, 110, 110, RED), rect(130, 40, 200, 110, YELLOW), rect(40, 130, 110, 200, GREEN), rect(130, 130, 200, 200, BLACK)];
  const img = paint(240, 240, WHITE, sh, 1);
  eq(Trace.trace(img, opts60).colors.length, 5, 'five flat colours found with the default limit');
  for (const n of [2, 3, 4]) { const r = Trace.trace(img, { width: 60, colors: n }); full(r, 'colors=' + n); ok(r.colors.length <= n, 'colors ' + r.colors.length + ' <= ' + n); }
  const big = Trace.trace(img, { width: 120 }), small = Trace.trace(img, { width: 30 });
  eq(big.size.width, 120); eq(small.size.height, 30);
  const one = paint(240, 240, WHITE, [disc(120, 120, 90, BLUE)]);
  const a30 = pathArea(Trace.trace(one, { width: 30 }).objects[0]), a120 = pathArea(Trace.trace(one, { width: 120 }).objects[0]);
  near(a120 / a30, 16, 0.5, 'area grows with the square of the width');
  near(a120, Math.PI * 45 * 45, Math.PI * 45 * 45 * 0.01, 'disc area at 120 mm');
  for (const d of ['low', 'medium', 'high']) { const r = Trace.trace(img, { width: 60, detail: d }); full(r, d); eq(r.objects.length, 5, d + ' objects'); }
  ok(Trace.trace(img, { width: 60, detail: 'high' }).stats.mmPerPixel < Trace.trace(img, { width: 60, detail: 'low' }).stats.mmPerPixel, 'detail changes the working resolution');
  const moved = Trace.trace(img, { width: 60, x: 20, y: 35 }), base = Trace.trace(img, opts60);
  eq(moved.origin.x, 20); eq(moved.origin.y, 35);
  moved.objects.forEach((o, i) => o.rings.forEach((r, j) => r.forEach((p, k) => { near(p[0] - 20, base.objects[i].rings[j][k][0], 1e-6, 'x'); near(p[1] - 35, base.objects[i].rings[j][k][1], 1e-6, 'y'); })));
  checkShapes(moved, 'moved');
  ok(Trace.trace(img, { width: 150, hoop: { width: 100, height: 100 } }).warnings.some(w => w.code === 'EXCEEDS_HOOP'), 'EXCEEDS_HOOP');
  ok(!Trace.trace(img, { width: 90, hoop: { width: 100, height: 100 } }).warnings.some(w => w.code === 'EXCEEDS_HOOP'), 'fits the hoop');
});

test('mode: flat art is "logo", a shaded picture is "photo", and the hint wins', () => {
  const logo = paint(240, 240, WHITE, [disc(120, 120, 90, BLUE), rect(90, 90, 150, 150, YELLOW)]);
  eq(Trace.trace(logo, opts60).mode, 'logo');
  eq(Trace.trace(logo, { width: 60, mode: 'photo' }).mode, 'photo');
  const w = 240, h = 240, data = new Uint8ClampedArray(w * h * 4), r = rng(3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4, a = Math.sin(x / 31) + Math.cos(y / 23) + Math.sin((x + y) / 47); data[o] = 128 + 50 * a + r() * 10; data[o + 1] = 120 + 40 * Math.sin(a * 2) + r() * 10; data[o + 2] = 100 - 30 * a + r() * 10; data[o + 3] = 255; }
  const photo = { width: w, height: h, data };
  const p = Trace.trace(photo, opts60);
  eq(p.mode, 'photo'); full(p, 'photo', ['TOO_DENSE']);
  ok(p.objects.every(o => o.type !== 'path' || o.fill.underlay === false), 'photograph fills carry underlay:false');
  eq(Trace.trace(photo, { width: 60, mode: 'logo' }).mode, 'logo');
  const c = compare(p, () => 't', 0.3); ok(c.bare < 0.01 * c.want, 'photo covered: bare ' + c.bare.toFixed(1) + ' of ' + c.want.toFixed(0) + ' mm2');
  // neighbouring outlines are smoothed separately, so slivers of a third layer can appear where three regions meet
  ok(c.triple < 0.001 * c.want, 'three layers only as slivers: ' + c.triple.toFixed(2) + ' mm2');
});

test('a small logo scene: every part found, right colours on top, no gaps, no spill', () => {
  const named = { blue: BLUE, cream: [244, 241, 232, 255], red: RED, yellow: YELLOW };
  const sh = [disc(200, 200, 180, BLUE), disc(200, 200, 150, named.cream), rect(130, 300, 270, 318, YELLOW),
    { color: RED, in: (x, y) => { const dx = x - 200, dy = y - 170; return Math.hypot(dx, dy) <= starR(Math.atan2(dy, dx) + Math.PI / 2); } }];
  function starR(a) { const k = Math.PI / 5; let m = ((a % (2 * k)) + 2 * k) % (2 * k); if (m > k) m = 2 * k - m; const R = 70, r = 28; return R * r * Math.sin(k) / (r * Math.sin(k - m) + R * Math.sin(m)); }   // R at a tip (m = 0), r in a notch (m = k)
  const img = paint(400, 400, WHITE, sh);
  const res = Trace.trace(img, { width: 100 });
  const gen = full(res, 'scene');
  eq(res.mode, 'logo'); eq(res.colors.length, 4);
  const who = nameOf(named);
  const byName = {}; for (const o of res.objects) (byName[who(o)] = byName[who(o)] || []).push(o);
  eq(Object.keys(byName).sort().join(','), 'blue,cream,red,yellow');
  eq(fills(res).length, 4, 'four fills'); eq(lines(res).length, 0, 'no stray lines');
  eq(byName.blue[0].rings.length, 2, 'the ring keeps its hole');
  near(pathArea(byName.red[0]), starArea(70 / 4, 28 / 4), 0.04 * starArea(70 / 4, 28 / 4), 'star area');
  function starArea(R, r) { return 5 * R * r * Math.sin(Math.PI / 5); }
  // the five star tips stay sharp: a vertex within 0.6 mm of each
  for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / 5, tip = [50 + 17.5 * Math.cos(a), 42.5 + 17.5 * Math.sin(a)]; ok(byName.red[0].rings[0].some(p => Math.hypot(p[0] - tip[0], p[1] - tip[1]) < 0.6), 'star tip ' + i + ' was rounded off'); }
  const truth = (x, y) => { for (let i = sh.length - 1; i >= 0; i--) if (sh[i].in(x * 4, y * 4)) return ['blue', 'cream', 'yellow', 'red'][i]; return null; };
  const c = compare(res, truth, 0.3, who);
  eq(c.bare, 0, 'bare cloth'); eq(c.spill, 0, 'spill'); eq(c.wrong, 0, 'wrong colour on top'); eq(c.triple, 0, 'three layers');
  eq(gen.totals.colorChanges, 3, 'one thread change per colour');
  within(res.stats.estimatedStitches / gen.totals.stitches, 0.8, 1.25, 'stitch estimate against the engine (' + res.stats.estimatedStitches + ' vs ' + gen.totals.stitches + ')');
  ok(res.colors.every(cl => cl.thread && cl.thread.chart === 'Brother' && cl.thread.name), 'thread names');
  near(res.colors.reduce((s, cl) => s + cl.share, 0), 1, 0.01, 'shares add up');
});

test('same input, same output; input pixels are not changed', () => {
  const img = paint(200, 200, WHITE, [disc(100, 100, 80, BLUE), band(40, 40, 160, 160, 12, YELLOW), disc(100, 100, 20, RED)]);
  const before = Buffer.from(img.data).toString('base64');
  const strip = r => JSON.stringify(Object.assign({}, r, { stats: Object.assign({}, r.stats, { timeMs: 0, stages: null }) }));
  const a = strip(Trace.trace(img, opts60)), b = strip(Trace.trace(img, opts60));
  eq(a, b, 'two runs differ');
  eq(Buffer.from(img.data).toString('base64'), before, 'the picture was modified');
  ok(JSON.parse(a).objects.length >= 3);
});

test('progress, cancelling and the sliced (async) run', async () => {
  const img = paint(300, 300, WHITE, [disc(150, 150, 120, BLUE), rect(100, 100, 200, 200, YELLOW)]);
  const seen = [];
  const sync = Trace.trace(img, opts60, { onProgress: f => seen.push(f) });
  ok(seen.length >= 5, 'progress steps ' + seen.length);
  for (let i = 1; i < seen.length; i++) ok(seen[i] >= seen[i - 1] && seen[i] <= 1, 'progress goes backwards at ' + i);
  eq(seen[seen.length - 1], 1, 'ends at 1');
  let n = 0, err = null;
  try { Trace.trace(img, opts60, { shouldCancel: () => ++n >= 3 }); } catch (e) { err = e; }
  ok(err && err.code === 'CANCELLED', 'sync cancel'); eq(n, 3, 'stopped at once');
  const strip = r => JSON.stringify(Object.assign({}, r, { stats: null }));
  const asyncSeen = [];
  const res = await Trace.traceAsync(img, opts60, { onProgress: f => asyncSeen.push(f) });
  eq(strip(res), strip(sync), 'async result differs from sync');
  eq(asyncSeen[asyncSeen.length - 1], 1);
  let c = 0; err = null;
  try { await Trace.traceAsync(img, opts60, { shouldCancel: () => ++c > 1 }); } catch (e) { err = e; }
  ok(err && err.code === 'CANCELLED', 'async cancel');
  if (typeof AbortController === 'function') {
    const ac = new AbortController(); err = null;
    const p = Trace.traceAsync(img, opts60, { signal: ac.signal }); ac.abort();
    try { await p; } catch (e) { err = e; }
    ok(err && err.code === 'CANCELLED', 'abort signal');
  }
});

test('client on the main thread (what a file:// page gets): result, progress, newest job wins, cancel', async () => {
  const img = paint(300, 300, WHITE, [disc(150, 150, 120, BLUE), rect(100, 100, 200, 200, YELLOW)]);
  const modes = [];
  const client = Trace.createClient({ forceMainThread: true, onModeChange: m => modes.push(m) });
  eq(await client.ready, 'main'); eq(client.mode, 'main'); eq(modes.join(), 'main');
  const prog = [];
  const res = await client.trace(img, opts60, { onProgress: f => prog.push(f) });
  eq(res.objects.length, 2); eq(prog[prog.length - 1], 1);
  const first = client.trace(img, opts60), second = client.trace(img, { width: 30 });
  let err = null; try { await first; } catch (e) { err = e; }
  ok(err && err.code === 'CANCELLED', 'the older job is cancelled by the newer one');
  eq((await second).size.width, 30);
  const third = client.trace(img, opts60); eq(client.cancel(), true); err = null;
  try { await third; } catch (e) { err = e; }
  ok(err && err.code === 'CANCELLED', 'cancel()'); eq(client.cancel(), false, 'nothing left to cancel');
  client.terminate(); err = null;
  try { await client.trace(img, opts60); } catch (e) { err = e; }
  ok(err && err.code === 'TERMINATED', 'closed client');
});

test('worker.js speaks the documented messages (run inside a fake worker)', () => {
  const out = [];
  // a worker's global object is its own `self`; trace.js attaches Trace to it and worker.js reads it from there
  const box = vm.createContext({ Date, console });
  const self = vm.runInContext('this', box);
  self.self = self;
  self.postMessage = m => out.push(JSON.parse(JSON.stringify(m)));
  self.importScripts = (...names) => names.forEach(n => vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'trace', n), 'utf8'), box, { filename: n }));
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'trace', 'worker.js'), 'utf8'), box, { filename: 'worker.js' });
  ok(self.Trace && typeof self.Trace.trace === 'function', 'trace.js loaded inside the worker');
  eq(out[0].type, 'ready'); eq(out[0].version, Trace.version);
  const img = paint(200, 200, WHITE, [disc(100, 100, 80, BLUE)]);
  self.onmessage({ data: { type: 'trace', id: 41, image: { width: 200, height: 200, data: img.data }, options: opts60 } });
  const last = out[out.length - 1];
  eq(last.type, 'result'); eq(last.id, 41); eq(last.result.objects.length, 1);
  ok(out.some(m => m.type === 'progress' && m.id === 41 && m.fraction === 1), 'progress reaches 1');
  self.onmessage({ data: { type: 'nope', id: 42 } });
  eq(out[out.length - 1].type, 'error'); eq(out[out.length - 1].error.code, 'UNKNOWN_MESSAGE'); eq(out[out.length - 1].id, 42);
  self.onmessage({ data: null }); self.onmessage({ data: { type: 'trace', id: 43, image: null } });
  eq(out[out.length - 1].type, 'result', 'a broken picture is an answer, not a crash'); eq(out[out.length - 1].result.ok, false);
});

test('editor mapping: toPolygon keeps the area and the hole; toEditorObjects fits the editor model', () => {
  const img = paint(240, 240, WHITE, [ring(120, 120, 88, 48, BLUE), band(30, 225, 210, 225, 8, RED), disc(120, 120, 20, YELLOW)]);
  const res = Trace.trace(img, opts60);
  full(res, 'editor');
  const ringObj = fills(res).find(o => o.rings.length === 2);
  ok(ringObj, 'ring found');
  const poly = Trace.toPolygon(ringObj.rings);
  near(Math.abs(signedArea(poly)), pathArea(ringObj), 0.05, 'keyhole polygon area equals outline minus hole');
  ok(!inRingEvenOdd([30, 30], poly), 'the middle of the ring is still a hole');
  ok(inRingEvenOdd([30, 30 - 17], poly), 'the band of the ring is still inside');
  function inRingEvenOdd(p, r) { return inRing(p, r); }
  eq(Trace.toPolygon([ringObj.rings[0]]).length, ringObj.rings[0].length, 'no holes: the outline itself');
  // toEditorObjects gives what the editor's M.addMany takes: [{ geom, style }] (js/editor/model.js)
  const ed = Trace.toEditorObjects(res);
  eq(ed.length, res.objects.length);
  ed.forEach((e, i) => {
    const src = res.objects[i], g = e.geom, st = e.style;
    ok(g && st, 'geom and style');
    ok(typeof st.name === 'string' && st.name.length > 0, 'name'); ok(/^#[0-9a-f]{6}$/.test(st.color), 'color');
    ok(Number.isInteger(st.angle) && st.angle >= 0 && st.angle <= 175, 'angle ' + st.angle);
    if (src.type === 'polyline') {
      eq(g.type, 'pen'); eq(g.closed, !!src.closed); eq(st.paint, 'line'); ok(['running', 'bean', 'satin'].includes(st.lineType), 'lineType');
      ok(g.pts.length >= 2 && g.pts.length <= 20000 && g.pts.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])), 'pts');
      if (st.lineType === 'satin') within(st.lineWidth, 1, 12, 'lineWidth');
    } else {
      eq(st.paint, 'fill'); within(st.spacing, 0.2, 2, 'spacing');
      if (src.rings.length > 1) {
        eq(g.type, 'path'); eq(g.fillRule, 'nonzero'); eq(g.rings.length, src.rings.length);
        // with the nonzero rule a hole only stays a hole when it is wound against its outline
        for (let h = 1; h < g.rings.length; h++) ok(signedArea(g.rings[h]) * signedArea(g.rings[0]) < 0, 'hole wound against the outline');
        ok(g.rings.length <= 2000 && g.rings.reduce((n, r) => n + r.length, 0) <= 20000, 'within the editor limits');
      } else { eq(g.type, 'polygon'); eq(g.pts.length, src.rings[0].length); }
    }
  });
  ok(ed.some(e => e.geom.type === 'path') && ed.some(e => e.geom.type === 'pen') && ed.some(e => e.geom.type === 'polygon'), 'all three kinds appear in this scene');
  // for an editor without compound paths: every fill as one polygon, holes cut in with a slit
  const flat = Trace.toEditorObjects(res, { holes: 'polygon' });
  ok(flat.every(e => e.geom.type === 'polygon' || e.geom.type === 'pen'), 'holes: polygon gives no path objects');
  const fr = flat[res.objects.indexOf(ringObj)].geom.pts;
  near(Math.abs(signedArea(fr)), pathArea(ringObj), 0.05, 'the slit polygon keeps the area');
  // the editor model itself must take them. model.js is a page script (window.Editor), so it runs in a sandbox here;
  // it belongs to another part of the project, so when it cannot be loaded this says so instead of failing.
  let M = null, why = '';
  try {
    const win = { Engine }; win.window = win; win.console = console; win.Date = Date; win.Math = Math;
    const box = vm.createContext(win);
    for (const n of ['geom.js', 'model.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'editor', n), 'utf8'), box, { filename: n });
    M = win.Editor && win.Editor.Model;
    if (M && !M.doc && typeof M.load === 'function') M.load(null);
    if (!M || typeof M.addMany !== 'function' || !M.doc) { why = 'no Model.addMany'; M = null; }
  } catch (e) { why = String(e && e.message); M = null; }
  if (M) {
    const before = M.doc.objects.length, made = M.addMany(ed, 'Trace picture');
    eq(made.length, ed.length, 'the editor took every object');
    eq(M.doc.objects.length, before + ed.length);
    made.forEach((o, i) => { eq(o.type, ed[i].geom.type, 'type kept'); eq(o.color, ed[i].style.color, 'colour kept'); eq(o.paint, ed[i].style.paint, 'paint kept'); eq(o.name, ed[i].style.name, 'name kept'); });
    const gen = Engine.generate(JSON.parse(JSON.stringify(M.toEngine())));
    ok(gen.ok && gen.totals.stitches > 0, 'the engine takes the editor document made from a trace: ' + JSON.stringify(gen.warnings.slice(0, 2)));
    const direct = checkEngine(res, 'editor direct');
    within(gen.totals.stitches / direct.totals.stitches, 0.9, 1.1, 'through the editor the design sews about the same (' + gen.totals.stitches + ' vs ' + direct.totals.stitches + ' stitches)');
    notes.push('editor mapping checked against js/editor/model.js: addMany + toEngine + Engine.generate gave ' + gen.totals.stitches + ' stitches (direct: ' + direct.totals.stitches + ')');
  } else notes.push('editor mapping: js/editor/model.js could not be loaded here (' + why + '), so only the shape of the list was checked');
});

test('speed: a 1000 px logo at 100 mm well under 2 s, a 1200 px photo-like picture under 5 s (this machine)', () => {
  const k = 2.5, sh = [disc(500, 500, 450, BLUE), disc(500, 500, 375, [244, 241, 232, 255]), rect(325, 750, 675, 795, YELLOW), disc(500, 420, 150, RED)];
  const logo = paint(1000, 1000, WHITE, sh, 2);
  let t0 = Date.now(); const a = Trace.trace(logo, { width: 100 }); const logoMs = Date.now() - t0;
  eq(a.mode, 'logo'); eq(fills(a).length, 4);
  ok(logoMs < 1500, 'logo took ' + logoMs + ' ms');
  const w = 1200, h = 900, data = new Uint8ClampedArray(w * h * 4), r = rng(11);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4, q = Math.sin(x / 90) + Math.cos(y / 70) + Math.sin((x + y) / 140) + 0.5 * Math.sin(x / 17) * Math.cos(y / 13); data[o] = 128 + 45 * q + r() * 16; data[o + 1] = 120 + 40 * Math.sin(q * 2) + r() * 16; data[o + 2] = 100 - 30 * q + r() * 16; data[o + 3] = 255; }
  t0 = Date.now(); const b = Trace.trace({ width: w, height: h, data }, { width: 100 }); const photoMs = Date.now() - t0;
  eq(b.mode, 'photo'); ok(photoMs < 4000, 'photo took ' + photoMs + ' ms');
  t0 = Date.now(); const c = Trace.trace({ width: w, height: h, data }, { width: 400, detail: 'high', colors: 12 }); const worstMs = Date.now() - t0;
  ok(c.ok && worstMs < 15000, 'largest size, most detail, most colours took ' + worstMs + ' ms');
  ok(c.stats.workWidth * c.stats.workHeight <= Trace.LIMITS.workPixels * 1.02, 'working size is capped');
  notes.push('speed: logo 1000 px ' + logoMs + ' ms, photo-like 1200x900 ' + photoMs + ' ms, 400 mm/high/12 colours ' + worstMs + ' ms');
  void k;
});

test('machine file: PES and DST written by the engine read back with pyembroidery and match', () => {
  if (flag('no-python')) throw new Skip('--no-python');
  const py = e2e.findPython();
  if (!py) throw new Skip('no python with pyembroidery + Pillow + numpy (set EMB_PYTHON or create venv/)');
  const dir = KEEP ? path.resolve(KEEP) : fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));
  try {
    const cream = [244, 241, 232, 255];
    const scenes = {
      logo: paint(400, 400, WHITE, [disc(200, 200, 180, BLUE), disc(200, 200, 150, cream), rect(130, 300, 270, 318, YELLOW), disc(200, 170, 60, RED), band(120, 260, 280, 260, 8, BLUE)]),
      alpha: paint(300, 200, CLEAR, [rect(30, 30, 150, 170, RED), rect(150, 30, 270, 170, BLUE), disc(150, 100, 30, YELLOW)]),
    };
    for (const name in scenes) for (const format of ['pes', 'dst']) {
      const r = e2e.sew(scenes[name], { width: 80 }, { dir, name: name + '_' + format, format, render: format === 'pes', title: name });
      const label = name + '.' + format;
      ok(r.traced.ok && r.gen && r.gen.canExport && r.read, label + ': did not get as far as a file');
      eq(r.read.stitches, r.gen.totals.stitches, label + ': stitches in the file');
      eq(r.read.colorChanges, r.traced.colors.length - 1, label + ': colour changes in the file');
      ok(r.read.longest <= 12.2, label + ': longest stitch ' + r.read.longest);
      const b = r.read.bounds;
      ok(b[2] - b[0] <= r.traced.size.width + 1 && b[3] - b[1] <= r.traced.size.height + 1, label + ': file is larger than the design ' + b);
      ok(b[2] - b[0] >= r.traced.size.width * 0.75, label + ': file is much smaller than the design ' + b);
      if (format === 'pes') {
        ok(r.read.coverage >= 0.95, label + ': thread covers ' + r.read.coverage + ' of the traced shapes');
        ok(r.read.spill <= 0.08, label + ': thread outside the traced shapes ' + r.read.spill);
        eq(r.read.threads.length, r.traced.colors.length, label + ': threads listed in the file');
        ok(fs.statSync(r.read.png).size > 2000, label + ': picture of the stitches');
      }
      notes.push(label + ': ' + r.read.stitches + ' stitches, ' + r.read.colorChanges + ' colour changes' + (format === 'pes' ? ', coverage ' + r.read.coverage : ''));
    }
  } finally { if (!KEEP) fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ run
const notes = [];
(async () => {
  let pass = 0, fail = 0; const skipped = [], t0 = Date.now();
  for (const t of tests) {
    if (ONLY && !t.name.toLowerCase().includes(ONLY.toLowerCase())) continue;
    const s = Date.now();
    try { await t.fn(); pass++; if (VERBOSE) console.log('  ok    ' + t.name + '  (' + (Date.now() - s) + ' ms)'); }
    catch (e) {
      if (e instanceof Skip) { skipped.push(t.name + ' -- ' + e.message); console.log('  SKIP  ' + t.name + ' -- ' + e.message); }
      else { fail++; console.log('  FAIL  ' + t.name + '\n        ' + (e && e.message) + (VERBOSE && e && e.stack ? '\n' + e.stack.split('\n').slice(1, 4).join('\n') : '')); }
    }
  }
  for (const n of notes) console.log('  note  ' + n);
  console.log('\ntrace tests: ' + pass + ' passed, ' + fail + ' failed, ' + skipped.length + ' skipped  (' + (Date.now() - t0) + ' ms)');
  process.exit(fail ? 1 : 0);
})();
