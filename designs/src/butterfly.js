'use strict';
/* Starter design: a monarch butterfly seen from above. One unit = 0.93 mm, 0,0 = middle of the body, y down. */
const L = require('./lib.js');
const { range, smooth, mirror, inside, arc } = L;
const d = L.design('butterfly', { hoop: { w: 130, h: 180 }, scale: 0.93, origin: [0, 0.5] });

const C = { orange: '#F28A1E', deep: '#D2561A', pale: '#F9BE5C', black: '#1B1716', grey: '#7C736C', white: '#FCF9F1' };

/* ---- small helpers */
const circle = (cx, cy, r, n) => arc(cx, cy, r, r, 0, Math.PI * 2, n || 12).slice(0, -1);
const oval = (cx, cy, rx, ry, deg, n) => L.rotate(arc(cx, cy, rx, ry, 0, Math.PI * 2, n || 14).slice(0, -1), deg, cx, cy);
/* evenly spaced points along a line */
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
/* both sides: the right-hand shape as drawn, the left-hand one mirrored (with the fill angle mirrored too) */
function both(name, pts, style, shape) {
  shape = shape || (p => d.poly(p));
  d.add(name + ' right', shape(pts), style);
  d.add(name + ' left', shape(Array.isArray(pts[0][0]) ? pts.map(mirror) : mirror(pts)), Object.assign({}, style, style.angle === undefined ? null : { angle: 180 - style.angle }));
}

/* ---- wing outlines (right side) */
const fwCtl = [[2.2, -13], [12, -22.5], [26, -32.5], [40, -39], [50, -40], [55.5, -35], [54.5, -26], [50.5, -16], [45.5, -6.5], [39, 0.5], [28, -1.5], [15, -3.5], [2.2, -5]];
const FW = smooth(fwCtl, 8);
const hwCtl = [[2.2, -5.8], [14, -4.6], [27, -2.6], [37, -0.5], [43.5, 6], [46, 16], [42.5, 27], [34, 35.5], [22.5, 39], [12, 35.5], [5.5, 25], [2.2, 9]];
const HW = smooth(hwCtl, 8);
/* the orange fields, set in from the edge; the black border is sewn around them */
const FO = smooth([[3.6, -11.2], [12.5, -19.6], [25, -28.6], [34.5, -32.6], [39.6, -29.5], [42.8, -22.5], [43.4, -15], [39.4, -8], [34.4, -3.2], [27, -3.8], [15, -5.6], [3.6, -6.8]], 8);
const HO = smooth([[3.8, -5.5], [14, -4.4], [26, -2.5], [35.6, -0.5], [38.4, 8.4], [39.1, 16.5], [36.1, 24.4], [30, 29.9], [22.5, 31.9], [14.9, 29.3], [8.9, 22.5], [4.4, 9]], 8);
/* pale orange patches in the dark wing tip */
const tipSpots = [oval(41.5, -34.2, 2.7, 1.5, -12), oval(46.2, -30.4, 2.6, 1.5, 25), oval(48.8, -24.6, 2.4, 1.4, 55)];

/* ---- veins (drawn first as lines, sewn later in black satin over the orange) */
const fwCellTop = smooth([[5.6, -11], [13, -15.6], [22, -22.5], [30, -27.2]]);
const fwCellBot = smooth([[5.6, -9.2], [13, -10.8], [21, -13.7], [28.2, -17.2]]);
const fwCellEnd = smooth([[30, -27.2], [30.4, -22.5], [28.2, -17.2]]);
const fwVeins = [
  fwCellTop, fwCellBot, fwCellEnd,
  smooth([[30.3, -25], [36.5, -25.7], [43.6, -24.4]]),
  smooth([[30.2, -21.4], [37.5, -19.5], [44.2, -16.4]]),
  smooth([[28.2, -17.2], [34.6, -13.4], [40.6, -8.8]]),
  smooth([[20.5, -13.4], [28.4, -9], [35.4, -3.8]]),
  smooth([[10.5, -10.2], [19, -7.2], [27.5, -3.8]]),
];
const hwCellTop = smooth([[5.8, -2.4], [12, 1], [17.6, 6], [20.5, 12]]);
const hwCellBot = smooth([[5.8, 0.4], [9.6, 5.6], [14.4, 10.6], [20.5, 12]]);
const hwVeins = [
  hwCellTop, hwCellBot,
  smooth([[11.5, 0.7], [22, 0.9], [34, 3]]),
  smooth([[17.3, 5.6], [28, 6.8], [38.2, 9.3]]),
  smooth([[20.5, 12], [30, 14.4], [39, 17.2]]),
  smooth([[20.5, 12], [28.4, 19.2], [35, 25.2]]),
  smooth([[19.6, 12.4], [23.8, 21.5], [27.6, 30.6]]),
  smooth([[15, 10.8], [17.6, 21], [19.3, 31.6]]),
  smooth([[8.8, 4.4], [10.8, 15], [12.9, 27]]),
];

/* ---- orange */
both('Hindwing orange', HO.concat([[2.5, 8.4], [2.5, -4.6]]), { color: C.orange, angle: 140, spacing: 0.45 });
both('Forewing orange', FO.concat([[2.6, -7.2], [2.6, -10.8]]), { color: C.orange, angle: 38, spacing: 0.45 });
/* a deeper orange in the cells next to the body, sewn open; its edges end up under the veins */
both('Hindwing cell', hwCellTop.concat(hwCellBot.slice(0, -1).reverse()), { color: C.deep, angle: 140, spacing: 0.8 });
both('Forewing cell', fwCellTop.concat(fwCellEnd.slice(1), fwCellBot.slice(0, -1).reverse()), { color: C.deep, angle: 38, spacing: 0.8 });
both('Wing tip patches', tipSpots, { color: C.pale, angle: 38, spacing: 0.5 }, list => d.rings(list));

/* ---- black: borders with the orange fields left open */
const shrink = (pts, k) => { const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]); return L.scaleAbout(pts, c[0], c[1], k); };
/* the same line moved inwards by `by` (towards the inside of the closed shape it belongs to) */
function inset(pts, by) {
  let area = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a[0] * b[1] - b[0] * a[1]; }
  const sgn = area > 0 ? 1 : -1, n = pts.length;
  return pts.map((p, i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [p[0] - sgn * (b[1] - a[1]) / l * by, p[1] + sgn * (b[0] - a[0]) / l * by]; });
}
both('Hindwing border', [HW.slice(24).concat(inset(HO, 0.35).slice(24).reverse())], { color: C.black, angle: 20, spacing: 0.48 }, list => d.rings(list));
both('Forewing border', [FW.concat(inset(FO, 0.35).reverse())].concat(tipSpots.map(s => shrink(s, 0.85))), { color: C.black, angle: 160, spacing: 0.48 }, list => d.rings(list));
const vein = { color: C.black, paint: 'line', lineType: 'satin', lineWidth: 1.15, spacing: 0.45 };
hwVeins.forEach((v, i) => both('Hindwing vein ' + (i + 1), v, vein, p => d.stroke(p)));
fwVeins.forEach((v, i) => both('Forewing vein ' + (i + 1), v, vein, p => d.stroke(p)));

/* ---- body */
d.add('Abdomen', d.poly(smooth([[0, -5.4], [2.2, -2.6], [2.5, 4], [1.9, 12], [0.9, 18.6], [0, 20.6], [-0.9, 18.6], [-1.9, 12], [-2.5, 4], [-2.2, -2.6]], 6, true)), { color: C.black, angle: 0, spacing: 0.45 });
d.add('Thorax', d.ell(0, -11.2, 3.1, 6.2), { color: C.black, angle: 90, spacing: 0.45 });
d.add('Head', d.ell(0, -19.4, 2.5, 2.4), { color: C.black, angle: 0, spacing: 0.45 });
for (const s of [-1, 1]) {
  d.add('Antenna ' + (s < 0 ? 'left' : 'right'), d.stroke(smooth([[s * 1.1, -21.2], [s * 3.4, -28], [s * 7.2, -34.5], [s * 10.4, -38.6]])), { color: C.black, paint: 'line', lineType: 'bean', stitchLen: 2 });
  d.add('Antenna tip ' + (s < 0 ? 'left' : 'right'), d.stroke([[s * 9.9, -38], [s * 11.6, -40.2]]), { color: C.black, paint: 'line', lineType: 'satin', lineWidth: 1.3, spacing: 0.45 });
}
d.add('Body sheen', d.stroke(smooth([[-0.6, -15.5], [-0.8, -10], [-0.5, -3], [-0.4, 6], [-0.2, 14]])), { color: C.grey, paint: 'line', lineType: 'bean', stitchLen: 2.2 });

/* ---- white dots: two rows along the outer edges, a few in the wing tip and on the body.
        Dots of one row are far enough apart that the thread is cut between them. */
function row(outline, from, to, n, inset, r, half) {
  const seg = outline.slice(from, to + 1), steps = walk(seg, n * 2), out = [];
  for (let k = half ? 1 : 0; k <= n * 2; k += 2) {
    const w = steps[k]; let p = [w.p[0] + w.n[0] * inset, w.p[1] + w.n[1] * inset];
    if (!inside(p, outline)) p = [w.p[0] - w.n[0] * inset, w.p[1] - w.n[1] * inset];
    out.push(circle(p[0], p[1], r, 12));
  }
  return out;
}
const white = { color: C.white, angle: 0, spacing: 0.5, stitchLen: 1.6 };
const dots = (name, list) => both(name, list, white, l => d.rings(l));
dots('Hindwing dots outer', row(HW, 30, 78, 10, 1.9, 1.1, false));
dots('Hindwing dots inner', row(HW, 30, 78, 10, 4.7, 1.25, true));
dots('Forewing dots outer', row(FW, 45, 73, 6, 1.9, 1.1, false));
dots('Forewing dots inner', row(FW, 52, 73, 4, 4.7, 1.25, true));
dots('Wing tip dots', [circle(36.2, -35.2, 1.25), circle(45.2, -36.6, 1.1), circle(51.4, -33.6, 1.1), circle(51.8, -28, 1.1)]);
/* body dots in two crossed pairs, so no stitch joins neighbours */
d.add('Body dots 1', d.rings([circle(-1.4, -14.2, 0.85, 8), circle(1.4, -9.6, 0.85, 8)]), white);
d.add('Body dots 2', d.rings([circle(-1.4, -9.6, 0.85, 8), circle(1.4, -14.2, 0.85, 8)]), white);

d.save();
