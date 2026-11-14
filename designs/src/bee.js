'use strict';
/* Starter design: a bumblebee seen from above, wings spread. Units are millimetres, 0,0 = middle, y down. */
const L = require('./lib.js');
const { range, smooth, mirror, arc } = L;
const d = L.design('bee', { hoop: { w: 130, h: 180 }, scale: 1, origin: [0, 2] });

const C = {
  gold: '#F2B51C', amber: '#C9800E', light: '#FBE07A', black: '#1C1A1A', char: '#4E4744',
  tail: '#F6EFDF', cream: '#D6C8AC', wing: '#BFDDEA', vein: '#5F8EA3', eye: '#5E4B42', white: '#FFFFFF',
};

/* ---- small helpers */
const circle = (cx, cy, r, n) => arc(cx, cy, r, r, 0, Math.PI * 2, n || 12).slice(0, -1);
const flip = style => Object.assign({}, style, style.angle === undefined ? null : { angle: 180 - style.angle });
const line = (color, type, extra) => Object.assign({ color, paint: 'line', lineType: type, stitchLen: 2 }, extra);
function walk(pts, n) {
  const acc = [0]; for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = acc[acc.length - 1], out = [];
  for (let k = 0; k <= n; k++) {
    const s = total * k / n; let i = 1; while (i < pts.length - 1 && acc[i] < s) i++;
    const t = (s - acc[i - 1]) / ((acc[i] - acc[i - 1]) || 1), a = pts[i - 1], b = pts[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    out.push({ p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], n: [-(b[1] - a[1]) / l, (b[0] - a[0]) / l] });
  }
  return out;
}
/* a fixed "random" so the hairs look uneven but the file is the same every run */
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
/* tufts of hair along a line: every other point pushed out (uneven length), the others pulled back in */
function fringe(pts, n, out, inn) {
  return walk(pts, n).map((w, k) => { const o = k % 2 ? out * (0.55 + 0.7 * rnd()) : -inn; return [w.p[0] + w.n[0] * o, w.p[1] + w.n[1] * o]; });
}
/* both sides of the bee */
function both(name, pts, style, shape) {
  shape = shape || (p => d.poly(p));
  d.add(name + ' right', shape(pts), style);
  d.add(name + ' left', shape(Array.isArray(pts[0][0]) ? pts.map(mirror) : mirror(pts)), flip(style));
}

/* ---- abdomen: half-width at height y */
const AB0 = -9, AB1 = 47;
const abW = y => { const u = Math.min(1, Math.max(-1, (y - 17) / 30)); return 19.5 * Math.pow(1 - u * u, 0.45); };
function band(y0, y1, k) {
  k = k || 1; const ys = range(y0, y1, 16), r = ys.map(y => [abW(y) * k, y]);
  return r.concat(r.slice().reverse().map(p => [-p[0], p[1]]));
}
/* a band edge, slightly curved like the rings of the abdomen */
const ring = (y, k) => range(-1, 1, 20).map(u => [u * abW(y) * (k || 1), y - 1.4 * (1 - u * u)]);
/* a band between two curved ring lines */
function seg(y0, y1) {
  const top = ring(y0), bot = ring(y1);
  const sideR = range(y0, y1, 8).map(y => [abW(y), y]).slice(1, -1), sideL = sideR.map(p => [-p[0], p[1]]).reverse();
  return y0 <= AB0 ? range(y0, y1, 16).map(y => [abW(y), y]).concat(bot.slice(1, -1).reverse(), range(y1, y0, 16).map(y => [-abW(y), y]))
    : y1 >= AB1 ? top.concat(range(y0, y1, 16).map(y => [abW(y), y]).slice(1)).concat(range(y1, y0, 16).map(y => [-abW(y), y]).slice(0, -1))
    : top.concat(sideR, bot.slice().reverse(), sideL);
}

/* ---- thorax: an ellipse split by a curved line into a gold collar and a black saddle */
const TC = -21, TRX = 16, TRY = 14;
const E = a => [TRX * Math.cos(a), TC + TRY * Math.sin(a)];
const cut = x => -22.5 + 3 * (x / TRX) * (x / TRX);
let lo = -Math.PI / 2, hi = Math.PI / 2; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2, p = E(m); if (p[1] < cut(p[0])) lo = m; else hi = m; }
const aR = lo, xc = E(aR)[0];
const cutLine = dy => range(xc, -xc, 16).map(x => [x, cut(x) + dy]);
const collar = range(Math.PI - aR, 2 * Math.PI + aR, 30).map(E).concat(cutLine(0.5).slice(1, -1));
const saddle = range(aR, Math.PI - aR, 30).map(E).concat(cutLine(-0.5).reverse().slice(1, -1));

/* ---- wings (right side): outline in a local frame, t = 0 base .. 1 tip, f = -1 front .. 1 back */
const wings = [
  { name: 'Hindwing', base: [9, -14], tip: [44, -1], width: 8.5, angle: 25 },
  { name: 'Forewing', base: [10, -25], tip: [54, -41], width: 11, angle: 150 },
];
const wingShape = [[0, 0], [0.12, -0.5], [0.4, -0.78], [0.72, -0.86], [0.92, -0.62], [1, -0.15], [0.96, 0.32], [0.8, 0.72], [0.55, 0.95], [0.28, 0.82], [0.08, 0.38]];
for (const w of wings) {
  const dx = w.tip[0] - w.base[0], dy = w.tip[1] - w.base[1], len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
  w.at = (t, f) => [w.base[0] + dx * t - uy * f * w.width, w.base[1] + dy * t + ux * f * w.width];
  w.outline = smooth(wingShape.map(p => w.at(p[0], p[1])), 8, true);
  w.vein = pts => smooth(pts.map(p => w.at(p[0], p[1])), 6);
}

/* ---- legs, sewn first so the body covers their roots: thigh, shin, foot */
const legs = [
  { thigh: [[10, -29], [16, -32], [19.5, -36]], shin: [[19.5, -36], [21, -41], [24.5, -45]] },
  { thigh: [[13, -6], [18, -1], [21.5, 4]], shin: [[21.5, 4], [25, 9], [30, 12]] },
  { thigh: [[16, 10], [21.5, 15], [24.5, 21]], shin: [[24.5, 21], [25.5, 29], [28.5, 35]] },
];
legs.forEach((g, i) => {
  both('Leg ' + (i + 1) + ' thigh', smooth(g.thigh, 5), line(C.black, 'satin', { lineWidth: i === 2 ? 2.4 : 1.9, spacing: 0.45 }), q => d.stroke(q));
  const s = g.shin, e = s[2], b = s[1], foot = [e, [e[0] + (e[0] - b[0]) * 0.4 + 0.8, e[1] + (e[1] - b[1]) * 0.4]];
  both('Leg ' + (i + 1) + ' shin', smooth(s, 5), line(C.black, 'satin', { lineWidth: 1.2, spacing: 0.45 }), q => d.stroke(q));
  both('Leg ' + (i + 1) + ' foot', foot, line(C.black, 'bean', { stitchLen: 1.2 }), q => d.stroke(q));
});

/* ---- wings: sheer open fill, veins, edge */
for (const w of wings) both(w.name, w.outline, { color: C.wing, angle: w.angle, spacing: 1.3, stitchLen: 2.6 });
for (const w of wings) {
  const v = [
    w.vein([[0.03, -0.45], [0.3, -0.7], [0.6, -0.72], [0.78, -0.55]]),
    w.vein([[0.05, 0.05], [0.32, -0.1], [0.55, -0.05], [0.72, 0.15]]),
    w.vein([[0.08, 0.35], [0.3, 0.5], [0.52, 0.55], [0.72, 0.15]]),
    w.vein([[0.32, -0.7], [0.32, -0.1], [0.3, 0.5], [0.3, 0.8]]),
    w.vein([[0.55, -0.05], [0.6, -0.4], [0.6, -0.72]]),
    w.vein([[0.78, -0.55], [0.82, -0.2], [0.72, 0.15]]),
  ];
  v.forEach((p, i) => both(w.name + ' vein ' + (i + 1), p, line(C.vein, 'bean', { stitchLen: 1.8 }), q => d.stroke(q)));
}
for (const w of wings) both(w.name + ' edge', w.outline.concat([w.outline[0]]), line(C.vein, 'bean', { stitchLen: 2 }), q => d.stroke(q));

/* ---- abdomen rings: gold, black, gold, black, pale tail */
const bands = [
  { y: [AB0, 6.4], color: C.gold, angle: 6 },
  { y: [5.6, 19.4], color: C.black, angle: 172 },
  { y: [18.6, 27.4], color: C.gold, angle: 10 },
  { y: [26.6, 33.4], color: C.black, angle: 168 },
  { y: [32.6, AB1], color: C.tail, angle: 8 },
];
bands.forEach((b, i) => d.add('Abdomen ring ' + (i + 1), d.poly(seg(b.y[0], b.y[1])), { color: b.color, angle: b.angle, spacing: 0.45, pattern: 'brick', stitchLen: 2.6 }));

/* ---- thorax */
d.add('Thorax saddle', d.poly(saddle), { color: C.black, angle: 95, spacing: 0.45, pattern: 'brick', stitchLen: 2.6 });
d.add('Thorax collar', d.poly(collar), { color: C.gold, angle: 175, spacing: 0.45, pattern: 'brick', stitchLen: 2.6 });

/* shading, open fills over the solid ones */
d.add('Collar shadow', d.poly(range(xc - 0.6, -xc + 0.6, 16).map(x => [x, cut(x) - 0.4]).concat(range(-xc + 0.6, xc - 0.6, 16).map(x => [x, cut(x) - 3.6 - 1.2 * (1 - (x / xc) * (x / xc))]))), { color: C.amber, angle: 160, spacing: 1.1, stitchLen: 2.2 });
d.add('Ring 1 shadow', d.poly(ring(6.0, 0.97).concat(ring(2.2, 0.97).reverse())), { color: C.amber, angle: 15, spacing: 1.1, stitchLen: 2.2 });
d.add('Ring 3 shadow', d.poly(ring(27.0, 0.97).concat(ring(24.4, 0.97).reverse())), { color: C.amber, angle: 15, spacing: 1.1, stitchLen: 2.2 });
d.add('Tail shadow', d.poly(range(40, 46, 10).map(y => [abW(y) * 0.9, y]).concat(range(46, 40, 10).map(y => [-abW(y) * 0.9, y]), ring(40, 0.9).slice(1, -1))), { color: C.cream, angle: 5, spacing: 1.0, stitchLen: 2.2 });

d.add('Collar shine', d.stroke(smooth([[-10.5, -27], [-6, -31], [0, -32.6], [5, -31.8]], 6)), line(C.light, 'bean', { stitchLen: 2 }));
d.add('Ring 1 shine', d.stroke(smooth([[-13.5, 2], [-12.5, -2.5], [-9, -5.5]], 6)), line(C.light, 'bean', { stitchLen: 2 }));
d.add('Ring 3 shine', d.stroke(smooth([[-15.5, 23.5], [-11, 22], [-6, 21.4]], 6)), line(C.light, 'bean', { stitchLen: 2 }));
/* fuzzy hair where the colours meet and around the edges */
const hair = (color, extra) => line(color, 'running', Object.assign({ stitchLen: 1.4 }, extra));
d.add('Collar fuzz', d.stroke(fringe(cutLine(0), 46, 1.8, 0.6)), hair(C.gold));
d.add('Ring 1 fuzz', d.stroke(fringe(ring(6.0), 46, -1.8, -0.6)), hair(C.gold));
d.add('Ring 3 fuzz', d.stroke(fringe(ring(27.0), 44, -1.7, -0.6)), hair(C.gold));
d.add('Ring 3 top fuzz', d.stroke(fringe(ring(19.0), 44, 1.5, 0.6)), hair(C.gold));
d.add('Collar rim fuzz', d.stroke(fringe(range(Math.PI - aR + 0.15, 2 * Math.PI + aR - 0.15, 30).map(a => E(a)), 70, -1.5, -0.4)), hair(C.gold));
const sideHair = [[AB0 + 4, 5.4, C.gold], [7, 18, C.char], [20, 26.2, C.gold], [28, 32.6, C.char], [34, 44, C.tail]];
const sideFuzz = col => sideHair.forEach((h, i) => { if (h[2] === col) both('Ring ' + (i + 1) + ' side fuzz', range(h[0], h[1], 12).map(y => [abW(y), y]), hair(col), q => d.stroke(fringe(q, Math.round((h[1] - h[0]) * 1.6), 1.3, 0.5))); });
sideFuzz(C.gold);
d.add('Tail fuzz', d.stroke(fringe(ring(33.0), 40, 1.5, 0.6)), hair(C.tail));
sideFuzz(C.tail);
sideFuzz(C.char);
d.add('Saddle fuzz', d.stroke(fringe(range(aR + 0.2, Math.PI - aR - 0.2, 24).map(a => E(a)), 50, -1.3, -0.4)), hair(C.char));

/* soft sheen on the black */
d.add('Saddle sheen', d.stroke(smooth([[-8, -15], [-3, -12.4], [3, -12.2]], 6)), line(C.char, 'bean', { stitchLen: 2 }));
d.add('Ring 2 sheen', d.stroke(smooth([[-15, 14], [-10, 15.5], [-4, 15.6]], 6)), line(C.char, 'bean', { stitchLen: 2 }));
d.add('Ring 4 sheen', d.stroke(smooth([[-13, 30.5], [-8, 31.2], [-3, 31]], 6)), line(C.char, 'bean', { stitchLen: 2 }));

/* ---- head, eyes, antennae */
const head = smooth([[0, -47.5], [6.5, -46.5], [9.6, -42], [9, -37.5], [5, -34.4], [0, -33.8], [-5, -34.4], [-9, -37.5], [-9.6, -42], [-6.5, -46.5]], 6, true);
const eye = smooth([[5.6, -45.8], [8.5, -44.6], [9.8, -41], [8.8, -37.2], [6.4, -36.2], [5, -40.6]], 6, true);
d.add('Head', d.rings([head, eye, mirror(eye)]), { color: C.black, angle: 0, spacing: 0.45, pattern: 'brick' });
both('Eye', eye, { color: C.eye, angle: 75, spacing: 0.45, stitchLen: 2 });
both('Eye shine', circle(7.4, -43.2, 0.9, 10), { color: C.white, angle: 0, spacing: 0.5, stitchLen: 1.5 });
d.add('Head fuzz', d.stroke(fringe(smooth([[-4, -46.8], [0, -47.6], [4, -46.8]], 5), 14, 1.2, 0.3)), hair(C.char, { stitchLen: 1.2 }));
both('Antenna', smooth([[2.4, -46.5], [3.4, -51.5], [4.8, -55.5], [9, -59], [13.5, -61.5]], 6), line(C.black, 'satin', { lineWidth: 1.3, spacing: 0.45 }), q => d.stroke(q));
both('Antenna tip', [[12.6, -61], [14.6, -62.1]], line(C.black, 'satin', { lineWidth: 1.8, spacing: 0.45 }), q => d.stroke(q));

d.save();
