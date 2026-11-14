'use strict';
/* Starter design: a sunflower seen from the front, on a stem with two leaves. Units are millimetres, y down. */
const L = require('./lib.js');
const { range, smooth } = L;
const d = L.design('sunflower', { hoop: { w: 130, h: 180 }, scale: 1, origin: [-0.5, 2.2] });
const add = (name, geom, style) => d.add(name, geom, style);
const poly = pts => d.poly(pts), rings = (list, rule) => d.rings(list, rule), ell = (cx, cy, rx, ry) => d.ell(cx, cy, rx, ry), stroke = pts => d.stroke(pts);
const deg = r => r * 180 / Math.PI, rad = a => a * Math.PI / 180;
/* a little repeatable irregularity */
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }, jit = k => (rnd() - 0.5) * 2 * k;

/* ---- thread */
const C = {
  stem: '#4C7A34', leaf: '#6A9E42', vein: '#2E5A28',
  back: '#DE9A1B', yellowA: '#F5C21B', yellowB: '#FBD84B', shade: '#D27A1C',
  disc: '#6A4222', ring: '#3A2212', seedc: '#B98444',
};

/* a blade (petal or leaf): a spine with a half-width on each side. Gives the outline, both halves and the spine. */
function blade(spine, wl, wr) {
  wr = wr || wl; const n = spine.length - 1, a = [], b = [];
  for (let i = 0; i <= n; i++) {
    const p = spine[i], q = spine[Math.min(n, i + 1)], o = spine[Math.max(0, i - 1)], dx = q[0] - o[0], dy = q[1] - o[1], len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, t = i / n;
    a.push([p[0] + nx * wl(t), p[1] + ny * wl(t)]); b.push([p[0] - nx * wr(t), p[1] - ny * wr(t)]);
  }
  const rev = x => x.slice().reverse();
  return { outline: a.concat(rev(b)), left: a.concat(rev(spine)), right: spine.concat(rev(b)), spine, a, b };
}
const dirOf = (p, q) => deg(Math.atan2(q[1] - p[1], q[0] - p[0]));

/* ================= layout ================= */
const HX = 0, HY = -30;                 /* the middle of the flower head */
const R = 17;                           /* the seed disc */
const N = 16, STEP = 2 * Math.PI / N;
const at = (a, r) => [HX + r * Math.cos(a), HY + r * Math.sin(a)];

/* ================= stem and leaves (behind the head) ================= */
const stemPts = smooth([[3.5, 69], [4.5, 55], [3.0, 36], [0.5, 18], [-0.5, 2], [0, -8]], 8);

function leafAt(name, base, tip, bend, width) {
  /* spine: a gentle curve from the stem to the tip */
  const mx = (base[0] + tip[0]) / 2, my = (base[1] + tip[1]) / 2, dx = tip[0] - base[0], dy = tip[1] - base[1], len = Math.hypot(dx, dy);
  const ctrl = [mx - dy / len * bend, my + dx / len * bend];
  const spine = range(0, 1, 22).map(t => [(1 - t) * (1 - t) * base[0] + 2 * t * (1 - t) * ctrl[0] + t * t * tip[0], (1 - t) * (1 - t) * base[1] + 2 * t * (1 - t) * ctrl[1] + t * t * tip[1]]);
  /* heart-shaped sunflower leaf: wide near the stalk, long point */
  const w = k => t => { const s = t < 0.30 ? Math.sin(t / 0.30 * Math.PI / 2) : Math.cos((t - 0.30) / 0.70 * Math.PI / 2); return width * k * Math.pow(Math.max(0, s), t < 0.30 ? 0.6 : 1.05) * (1 + 0.035 * Math.sin(t * 38)); };
  const bl = blade(spine, w(1), w(0.92));
  const a0 = dirOf(spine[4], spine[18]);
  return { name, bl, spine, a0, w: w(1), w2: w(0.92) };
}
const leaves = [];
/* stalks */
const stalk1 = smooth([[3.6, 44], [-3, 40], [-9, 37.5]], 6), stalk2 = smooth([[4.2, 56], [10, 51], [15, 48.5]], 6);
leaves.push(leafAt('Left leaf', [-8.5, 37.6], [-46, 22], -5, 12.5));
leaves.push(leafAt('Right leaf', [14.5, 48.8], [47, 30], 5.5, 12));
add('Left leaf stalk', stroke(stalk1), { color: C.stem, paint: 'line', lineType: 'satin', lineWidth: 2.2 });
add('Right leaf stalk', stroke(stalk2), { color: C.stem, paint: 'line', lineType: 'satin', lineWidth: 2.2 });
add('Stem', stroke(stemPts), { color: C.stem, paint: 'line', lineType: 'satin', lineWidth: 4.4 });
leaves.forEach(lf => add(lf.name + ' lower half', poly(lf.bl.right), { color: C.stem, angle: lf.a0 - 28, stitchLen: 2.8 }));

leaves.forEach(lf => add(lf.name + ' upper half', poly(lf.bl.left), { color: C.leaf, angle: lf.a0 + 28, stitchLen: 2.8 }));

/* veins: a bold midrib, fine side veins sewn out and back from it */
leaves.forEach(lf => {
  const sp = lf.spine, n = sp.length - 1;
  add(lf.name + ' midrib', stroke(sp.slice(0, n)), { color: C.vein, paint: 'line', lineType: 'bean', stitchLen: 2.2 });
  const pts = [];
  for (const t of [0.14, 0.27, 0.40, 0.53, 0.66, 0.79]) {
    const i = Math.round(t * n), p = sp[i], q = sp[Math.min(n, i + 4)], dx = q[0] - sp[i - 1][0], dy = q[1] - sp[i - 1][1], len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
    const reach = s => (s > 0 ? lf.w(t + 0.10) : lf.w2(t + 0.10)) * 0.78;
    for (const s of [1, -1]) {
      const r = reach(s), end = [p[0] + ux * r * 0.75 + s * nx * r, p[1] + uy * r * 0.75 + s * ny * r], mid = [p[0] + ux * r * 0.30 + s * nx * r * 0.55, p[1] + uy * r * 0.30 + s * ny * r * 0.55];
      pts.push(p, mid, end, mid, p);
    }
    const nxt = sp[Math.min(n, Math.round((t + 0.13) * n))];
    if (t < 0.79) for (let j = i + 1; j < Math.round((t + 0.13) * n); j++) pts.push(sp[j]);
    void nxt;
  }
  add(lf.name + ' veins', stroke(pts), { color: C.vein, paint: 'line', lineType: 'running', stitchLen: 2 });
});

/* ================= petals ================= */
/* front ring: the petals touch each other near the disc and taper to a point */
const tile = r => r * Math.tan(Math.PI / N);
function petal(a, r0, r1, wmax, tb, k, bend) {
  const len = r1 - r0, spine = range(0, 1, 20).map(t => { const r = r0 + len * t, off = bend * t * t; return at(a + off / Math.max(r, 1), r); });
  const w = t => { const r = r0 + len * t, tip = t <= tb ? wmax : wmax * Math.pow(Math.max(0, Math.cos((t - tb) / (1 - tb) * Math.PI / 2)), 0.9), base = k * tile(r); return Math.min(base, tip) - 0.35 * Math.exp(-Math.pow((base - tip) / 1.0, 2)); };
  return blade(spine, w);
}
const front = [], back = [];
for (let i = 0; i < N; i++) {
  const a = -Math.PI / 2 + i * STEP;
  front.push({ i, a, r1: 43.5 + jit(2.2), bend: jit(3.0) });
  const ab = -Math.PI / 2 + (i + 0.5) * STEP + rad(jit(2.5));
  back.push({ i, a: ab, r1: 45.5 + jit(2.5), bend: jit(2.5) });
}
back.forEach(p => { p.bl = petal(p.a, 26, p.r1, 5.3, 0.30, 0.74, p.bend); });
front.forEach(p => { p.bl = petal(p.a, R - 0.8, p.r1, 5.9, 0.36, 1.03, p.bend); });
const rowsAlong = p => dirOf(p.bl.spine[2], p.bl.spine[18]);

back.forEach(p => add('Back petal ' + (p.i + 1), poly(p.bl.outline), { color: C.back, angle: rowsAlong(p), stitchLen: 3 }));
front.filter(p => p.i % 2 === 0).forEach(p => add('Petal ' + (p.i + 1), poly(p.bl.outline), { color: C.yellowA, angle: rowsAlong(p), stitchLen: 3.2 }));
front.filter(p => p.i % 2 === 1).forEach(p => add('Petal ' + (p.i + 1), poly(p.bl.outline), { color: C.yellowB, angle: rowsAlong(p), stitchLen: 3.2 }));

/* a warm shadow at the foot of each front petal, sewn open */
front.forEach(p => {
  const sh = petal(p.a, R + 0.4, R + 8.4 + jit(1.0), 3.0, 0.15, 0.72, 0);
  add('Petal shade ' + (p.i + 1), poly(sh.outline), { color: C.shade, angle: rowsAlong(p), spacing: 1.0, stitchLen: 2.6 });
});
/* one line up the middle of every front petal; the way from petal to petal hides under the disc */
{
  const pts = [];
  front.forEach(p => { const sp = p.bl.spine, m = sp.slice(0, 15); m.forEach(q => pts.push(q)); m.slice(0, -1).reverse().forEach(q => pts.push(q)); });
  pts.push(front[0].bl.spine[0]);
  add('Petal centre lines', stroke(pts), { color: C.shade, paint: 'line', lineType: 'running', stitchLen: 2.4 });
}

/* ================= the seed disc ================= */
const circle = (r, n, wob) => range(0, Math.PI * 2, n || 60).slice(0, -1).map(t => at(t, r * (1 + (wob || 0) * Math.sin(t * 9))));
add('Seed disc', poly(circle(R, 72)), { color: C.disc, angle: 35, pattern: 'brick', stitchLen: 2.4 });
add('Dark ring', rings([circle(R - 1.6, 72), circle(8.6, 48)]), { color: C.ring, angle: 125, spacing: 0.9, stitchLen: 2 });
add('Disc rim', stroke(circle(R - 0.5, 60).concat([circle(R - 0.5, 60)[0]])), { color: C.ring, paint: 'line', lineType: 'bean', stitchLen: 2 });
/* seed spirals: two families of curves crossing, as in a real head */
function spirals(count, turn, r0, r1) {
  const pts = [];
  for (let k = 0; k < count; k++) {
    const a0 = k / count * Math.PI * 2, line = range(0, 1, 12).map(t => at(a0 + turn * t, r0 + (r1 - r0) * Math.pow(t, 0.8)));
    (k % 2 ? line.reverse() : line).forEach(q => pts.push(q));
  }
  return pts;
}
add('Seed spirals', stroke(spirals(14, 1.15, 5.2, R - 1.2)), { color: C.seedc, paint: 'line', lineType: 'running', stitchLen: 1.8 });
add('Seed spirals back', stroke(spirals(14, -1.15, 5.2, R - 1.2)), { color: C.seedc, paint: 'line', lineType: 'running', stitchLen: 1.8 });
add('Heart of the disc', poly(circle(5.4, 30)), { color: C.seedc, angle: 60, pattern: 'crosshatch', spacing: 0.4, stitchLen: 1.6 });

{
  const z = []; for (let k = 0; k <= 44; k++) z.push(at(k / 44 * Math.PI * 2, k % 2 ? 8.4 : 6.2));
  add('Floret ring', stroke(z), { color: C.back, paint: 'line', lineType: 'running', stitchLen: 3 });
}

const r = d.save();
const b = r.result.bounds;
if (b) console.log('  bounds x ' + b.minX.toFixed(1) + '..' + b.maxX.toFixed(1) + '  y ' + b.minY.toFixed(1) + '..' + b.maxY.toFixed(1) + '  margins L' + b.minX.toFixed(1) + ' R' + (130 - b.maxX).toFixed(1) + ' T' + b.minY.toFixed(1) + ' B' + (180 - b.maxY).toFixed(1));
