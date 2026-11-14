'use strict';
/* Starter design: a branch of cherry blossom. Units are millimetres, y down. */
const L = require('./lib.js');
const { range, smooth } = L;
const d = L.design('cherry-blossom', { hoop: { w: 130, h: 180 }, scale: 1, origin: [0, 0] });
const add = (name, geom, style) => d.add(name, geom, style);
const poly = pts => d.poly(pts), ell = (cx, cy, rx, ry) => d.ell(cx, cy, rx, ry), stroke = pts => d.stroke(pts);
const deg = r => r * 180 / Math.PI, rad = a => a * Math.PI / 180;
let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }, jit = k => (rnd() - 0.5) * 2 * k;

/* ---- thread */
const C = {
  wood: '#5B3B2A', bark: '#39231A',
  leaf: '#86AD55', vein: '#4E7B38',
  pinkA: '#FBD5DF', pinkB: '#F6B9CB', rose: '#E9819F', heart: '#B03663', gold: '#EDBE3F',
};

/* a blade (branch, leaf, bud): a spine with a half-width on each side */
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
const line = (p, q, n) => range(0, 1, n || 6).map(t => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);

/* ================= branch ================= */
/* a twig is left out where it passes under the heart of a blossom (gaps: [x, y, r]) */
const twig = (name, pts, w, gaps) => {
  const all = smooth(pts, 8), parts = [[]];
  all.forEach(p => { if ((gaps || []).some(c => Math.hypot(p[0] - c[0], p[1] - c[1]) < c[2])) { if (parts[parts.length - 1].length) parts.push([]); } else parts[parts.length - 1].push(p); });
  parts.filter(q => q.length > 2).forEach((q, k, a) => add(name + (a.length > 1 ? ' ' + (k + 1) : ''), stroke(q), { color: C.wood, paint: 'line', lineType: 'satin', lineWidth: w }));
};
twig('Twig left', [[-20.6, 27.6], [-29, 16], [-36, 2], [-40, -10]], 2.3);
twig('Twig right', [[5, 6], [19, 6.5], [31, 2], [41, -6]], 2.2);
twig('Twig upper', [[14, -10], [6, -23], [0.5, -36], [-3, -49]], 2.0, [[0.5, -33.5, 7]]);
twig('Twig lower', [[-33, 42], [-27, 48.5], [-21, 52]], 2.0);
const mainSpine = smooth([[-47, 55], [-34, 43], [-20, 31], [-6, 19], [6, 5], [15, -11], [22, -28], [27, -44], [30, -55]], 8);
const mainW = t => 3.1 - 2.1 * Math.pow(t, 0.85) + 0.22 * Math.sin(t * 27) * (1 - t);
/* the branch is left out under the hearts of the blossoms that sit on it, so thread does not pile up there */
const onBranch = [[-12, 25.5, 7.5, 12.5], [11, -2.5, 8, 12], [26.5, -34, 7.5, 11.5]]; /* centre, branch gap, shadow gap */
const runsOf = j => {
  const n = mainSpine.length - 1, keep = mainSpine.map(p => onBranch.every(c => Math.hypot(p[0] - c[0], p[1] - c[1]) >= c[j])), out = [];
  let i0 = -1;
  for (let i = 0; i <= n + 1; i++) {
    if (i <= n && keep[i]) { if (i0 < 0) i0 = i; }
    else if (i0 >= 0) { if (i - 1 - i0 >= 2) out.push([i0, i - 1]); i0 = -1; }
  }
  return out;
}, runs = runsOf(2);
const N = mainSpine.length - 1, sub = (i0, i1) => mainSpine.slice(i0, i1 + 1), at = (i0, i1) => t => (i0 + t * (i1 - i0)) / N;
runs.forEach(([i0, i1], k) => add('Branch ' + (k + 1), poly(blade(sub(i0, i1), t => mainW(at(i0, i1)(t))).outline), { color: C.wood, angle: dirOf(mainSpine[0], mainSpine[40]) + 12, stitchLen: 2.6 }));
/* the underside in shadow, sewn open, and a few lines of bark */
{
  const n = mainSpine.length - 1, cut = Math.round(n * 0.8);
  runsOf(3).filter(([i0]) => i0 < cut).forEach(([i0, i1], k) => { i1 = Math.min(i1, cut);
    const sh = blade(sub(i0, i1), () => 0, t => mainW(at(i0, i1)(t)) * 0.95);
    add('Branch shadow ' + (k + 1), poly(sh.outline), { color: C.bark, angle: dirOf(mainSpine[0], mainSpine[40]) - 20, spacing: 0.85, stitchLen: 2.4 });
  });
  const off = (i0, i1, k) => mainSpine.slice(i0, i1).map((p, j) => { const i = i0 + j, q = mainSpine[Math.min(n, i + 1)], o = mainSpine[Math.max(0, i - 1)], dx = q[0] - o[0], dy = q[1] - o[1], len = Math.hypot(dx, dy); return [p[0] - dy / len * k * mainW(i / n), p[1] + dx / len * k * mainW(i / n)]; });
  add('Bark line 1', stroke(off(2, 13, 0.45)), { color: C.bark, paint: 'line', lineType: 'running', stitchLen: 2.2 });
  add('Bark line 2', stroke(off(27, 37, 0.35)), { color: C.bark, paint: 'line', lineType: 'running', stitchLen: 2.2 });
  add('Bark line 3', stroke(off(44, 56, 0.3)), { color: C.bark, paint: 'line', lineType: 'running', stitchLen: 2.2 });
}

/* ================= leaves ================= */
const leaves = [
  { name: 'Leaf 1', base: [-35.5, 5], tip: [-50.5, 6.5], bend: 1.6 },
  { name: 'Leaf 2', base: [25, 5], tip: [33.5, 18], bend: -1.5 },
  { name: 'Leaf 3', base: [20.5, -21], tip: [33.5, -17.5], bend: 1.4 },
  { name: 'Leaf 4', base: [-2, -45.5], tip: [-15.5, -51], bend: -1.5 },
  { name: 'Leaf 5', base: [-31, 37.6], tip: [-46, 32], bend: 1.6 },
  { name: 'Leaf 6', base: [29, -51], tip: [41.5, -57.5], bend: 1.5 },
];
leaves.forEach(lf => {
  const b = lf.base, t = lf.tip, dx = t[0] - b[0], dy = t[1] - b[1], len = Math.hypot(dx, dy), c = [(b[0] + t[0]) / 2 - dy / len * lf.bend, (b[1] + t[1]) / 2 + dx / len * lf.bend];
  lf.spine = range(0, 1, 16).map(u => [(1 - u) * (1 - u) * b[0] + 2 * u * (1 - u) * c[0] + u * u * t[0], (1 - u) * (1 - u) * b[1] + 2 * u * (1 - u) * c[1] + u * u * t[1]]);
  const w = u => 3.3 * Math.pow(Math.max(0, u < 0.42 ? Math.sin(u / 0.42 * Math.PI / 2) : Math.cos((u - 0.42) / 0.58 * Math.PI / 2)), 0.8);
  lf.bl = blade(lf.spine, w);
  add(lf.name, poly(lf.bl.outline), { color: C.leaf, angle: dirOf(b, t) + 30, stitchLen: 2.4 });
});
leaves.forEach(lf => add(lf.name + ' midrib', stroke(lf.spine.slice(0, 15)), { color: C.vein, paint: 'line', lineType: 'bean', stitchLen: 2 }));

/* ================= buds: stalks first (same thread as the midribs) ================= */
const buds = [
  { name: 'Bud 1', from: [30, -54.5], to: [31.5, -59], tip: [33, -66.5] },
  { name: 'Bud 2', from: [-3, -48.5], to: [-4.5, -52.5], tip: [-6.5, -59.5] },
  { name: 'Bud 3', from: [-29.5, 16], to: [-24.5, 10.5], tip: [-20.5, 4.5] },
  { name: 'Bud 4', from: [18, 6.5], to: [18.5, 13], tip: [20.5, 20] },
];
buds.forEach(b => add(b.name + ' stalk', stroke(line(b.from, b.to, 4)), { color: C.vein, paint: 'line', lineType: 'bean', stitchLen: 1.8 }));

/* ================= blossoms ================= */
/* A blossom is drawn round at 0,0 and then tilted (squashed along one direction), turned and moved into place. */
const flowers = [
  { name: 'Blossom 1', c: [-12, 25.5], R: 12.6, rot: 12, ky: 1 },
  { name: 'Blossom 2', c: [-39.5, -9.5], R: 11.4, rot: 40, ky: 0.86, tilt: 70 },
  { name: 'Blossom 3', c: [11, -2.5], R: 12.0, rot: -20, ky: 1 },
  { name: 'Blossom 4', c: [42, -6], R: 10.8, rot: 5, ky: 0.82, tilt: -35 },
  { name: 'Blossom 5', c: [0.5, -33.5], R: 11.0, rot: 58, ky: 0.93, tilt: 20 },
  { name: 'Blossom 6', c: [26.5, -34], R: 11.6, rot: -8, ky: 1 },
  { name: 'Blossom 7', c: [-20.5, 52], R: 9.6, rot: 30, ky: 0.88, tilt: -60 },
];
const J = 0.50, HALF = rad(36.6);
function place(f) {
  const tl = rad(f.tilt || 0), ct = Math.cos(tl), st = Math.sin(tl);
  return p => { /* squash along the direction at right angles to the tilt axis */
    const u = p[0] * ct + p[1] * st, v = (-p[0] * st + p[1] * ct) * f.ky;
    return [f.c[0] + u * ct - v * st, f.c[1] + u * st + v * ct];
  };
}
const pol = (a, r) => [r * Math.cos(a), r * Math.sin(a)];
function petalShape(a0, R, r0) {
  const pts = [];
  range(r0, J * R, 4).forEach(r => pts.push(pol(a0 - HALF, r)));
  range(-1, 1, 30).slice(1, -1).forEach(u => {
    const th = u * HALF, c = Math.cos(Math.PI / 2 * Math.abs(u));
    pts.push(pol(a0 + th, R * (J + (1 - J) * Math.pow(c, 0.55)) - R * 0.115 * Math.exp(-Math.pow(u / 0.13, 2))));
  });
  range(J * R, r0, 4).forEach(r => pts.push(pol(a0 + HALF, r)));
  range(HALF, -HALF, 4).slice(1, -1).forEach(th => pts.push(pol(a0 + th, r0)));
  return pts;
}
flowers.forEach(f => {
  const P = place(f); f.P = P; f.petals = [];
  for (let i = 0; i < 5; i++) {
    const a0 = rad(f.rot) + i * rad(72), R = f.R * (1 + jit(0.05));
    f.petals.push({ i, a0, R, pts: petalShape(a0, R, 1.5).map(P), angle: dirOf(P(pol(a0, 2)), P(pol(a0, R))) });
  }
});
const tone = i => (i === 1 || i === 3) ? 'B' : 'A';
flowers.forEach(f => f.petals.filter(p => tone(p.i) === 'A').forEach(p => add(f.name + ' petal ' + (p.i + 1), poly(p.pts), { color: C.pinkA, angle: p.angle, stitchLen: 2.6 })));

/* loose petals drifting down, in the same two pinks */
const loose = [
  { name: 'Falling petal 1', c: [23, 34], R: 8.2, rot: 62, ky: 0.8, tilt: 10, col: 'A' },
  { name: 'Falling petal 2', c: [39, 47], R: 7.4, rot: 155, ky: 0.7, tilt: 40, col: 'B' },
  { name: 'Falling petal 3', c: [6, 50], R: 7.0, rot: -30, ky: 0.75, tilt: -50, col: 'B' },
];
loose.forEach(f => {
  /* a single petal: the same outline, closed to a point at its foot */
  const P = place(f), a0 = rad(f.rot), h = rad(30), pts = [pol(a0, 0.6)];
  range(-1, 1, 30).forEach(u => { const c = Math.cos(Math.PI / 2 * Math.abs(u)); pts.push(pol(a0 + u * h, f.R * (0.30 + 0.70 * Math.pow(c, 0.5)) - f.R * 0.115 * Math.exp(-Math.pow(u / 0.13, 2)))); });
  f.P = P; f.pts = pts.map(P); f.angle = dirOf(P(pol(a0, 1)), P(pol(a0, f.R)));
});
loose.filter(f => f.col === 'A').forEach(f => add(f.name, poly(f.pts), { color: C.pinkA, angle: f.angle, stitchLen: 2.4 }));
flowers.forEach(f => f.petals.filter(p => tone(p.i) === 'B').forEach(p => add(f.name + ' petal ' + (p.i + 1), poly(p.pts), { color: C.pinkB, angle: p.angle, stitchLen: 2.6 })));
loose.filter(f => f.col === 'B').forEach(f => add(f.name, poly(f.pts), { color: C.pinkB, angle: f.angle, stitchLen: 2.4 }));

/* rose: the blush at the foot of every petal (fine rays sewn out and back), and the buds */
flowers.forEach(f => {
  const pts = [];
  f.petals.forEach(p => {
    [[-HALF, J * 0.96], [-0.36, 0.40], [-0.12, 0.50], [0.12, 0.52], [0.36, 0.40]].forEach(([th, k]) => {
      const a = p.a0 + th, o = f.P(pol(a, 1.7)), e = f.P(pol(a, p.R * k * (1 + jit(0.06))));
      pts.push(o, e, o);
    });
  });
  add(f.name + ' blush', stroke(pts), { color: C.rose, paint: 'line', lineType: 'running', stitchLen: 2.2 });
});
/* a fine rose edge round the outer rim of every petal, so neighbouring petals read apart */
flowers.forEach(f => add(f.name + ' edges', stroke([].concat(...f.petals.map(p => p.pts.slice(4, 35)))), { color: C.rose, paint: 'line', lineType: 'running', stitchLen: 1.8 }));
loose.forEach(f => add(f.name + ' edge', stroke(f.pts.slice(2, -1)), { color: C.rose, paint: 'line', lineType: 'running', stitchLen: 1.8 }));
loose.forEach(f => {
  const a0 = rad(f.rot), pts = [];
  [-0.2, 0, 0.2].forEach(th => { const o = f.P(pol(a0, 0.9)), e = f.P(pol(a0 + th, f.R * (th ? 0.5 : 0.62))); pts.push(o, e, o); });
  add(f.name + ' blush', stroke(pts), { color: C.rose, paint: 'line', lineType: 'running', stitchLen: 2 });
});
buds.forEach(b => {
  const sp = line(b.to, b.tip, 10), w = u => 2.5 * Math.pow(Math.max(0, u < 0.45 ? Math.sin((0.25 + 0.75 * u / 0.45) * Math.PI / 2) : Math.cos((u - 0.45) / 0.55 * Math.PI / 2)), 0.8);
  b.bl = blade(sp, w);
  add(b.name, poly(b.bl.outline), { color: C.rose, angle: dirOf(b.to, b.tip), stitchLen: 2.2, spacing: 0.45 });
});

/* deep pink: the heart of each blossom, the cup that holds each bud */
flowers.forEach(f => add(f.name + ' heart', poly(range(0, Math.PI * 2, 20).slice(0, -1).map(a => f.P(pol(a, 2.5)))), { color: C.heart, angle: 45, spacing: 0.5, stitchLen: 1.6 }));
buds.forEach(b => {
  const ux = b.tip[0] - b.to[0], uy = b.tip[1] - b.to[1], len = Math.hypot(ux, uy), p = k => [b.to[0] + ux / len * k, b.to[1] + uy / len * k];
  add(b.name + ' cup', stroke([p(-0.9), p(2.6)]), { color: C.heart, paint: 'line', lineType: 'satin', lineWidth: 2.6 });
  add(b.name + ' fold', stroke(line(p(2.8), p(len - 1.2), 3)), { color: C.heart, paint: 'line', lineType: 'running', stitchLen: 1.8 });
});

/* gold: stamens, each with a small knot at its end, joined by a ring round the heart */
flowers.forEach(f => {
  const pts = [], n = 9, a1 = rad(jit(180));
  for (let k = 0; k <= n; k++) {
    const a = a1 + k / n * Math.PI * 2;
    pts.push(f.P(pol(a - 0.2, 1.5)), f.P(pol(a, 1.5)));
    if (k === n) break;
    const r = f.R * (0.30 + 0.16 * rnd()), aa = a + jit(0.12), tip = pol(aa, r), nx = -Math.sin(aa) * 0.55, ny = Math.cos(aa) * 0.55;
    pts.push(f.P(tip), f.P([tip[0] + nx, tip[1] + ny]), f.P([tip[0] - nx, tip[1] - ny]), f.P(tip), f.P(pol(a, 1.5)));
  }
  add(f.name + ' stamens', stroke(pts), { color: C.gold, paint: 'line', lineType: 'running', stitchLen: 2.2 });
});

const r = d.save();
const b = r.result.bounds;
if (b) console.log('  bounds x ' + b.minX.toFixed(1) + '..' + b.maxX.toFixed(1) + '  y ' + b.minY.toFixed(1) + '..' + b.maxY.toFixed(1) + '  margins L' + b.minX.toFixed(1) + ' R' + (130 - b.maxX).toFixed(1) + ' T' + b.minY.toFixed(1) + ' B' + (180 - b.maxY).toFixed(1));
