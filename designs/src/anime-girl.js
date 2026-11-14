'use strict';
/* Starter design: an original anime-style girl, head and shoulders, with long violet hair, a flower in
 * her hair and a sailor collar. One unit = 1 mm, 0,0 = middle of the design, y down. */
const L = require('./lib.js');
const { range, smooth, arc, leaf, rotate, mirror, scaleAbout, sm } = L;
const d = L.design('anime-girl', { hoop: { w: 130, h: 180 }, scale: 0.85, origin: [0, 3] });
const add = (name, geom, style) => d.add(name, geom, style);
const poly = p => d.poly(p), rings = l => d.rings(l), stroke = p => d.stroke(p), ell = (x, y, a, b) => d.ell(x, y, a, b);

const C = {
  skin: '#F8DCC8', shade: '#EBB59D', blush: '#F29C9C',
  hair: '#5A4A9E', hairDark: '#33286B', hairLight: '#A99BE6',
  ink: '#2A1B24', iris: '#1F7F86', irisLight: '#69CDBE', white: '#FCFAF4',
  navy: '#26345E', red: '#D23C4B', pink: '#F47FA6', yellow: '#F6C945',
};
const oval = (cx, cy, rx, ry, deg, n) => rotate(arc(cx, cy, rx, ry, 0, Math.PI * 2, n || 28).slice(0, -1), deg || 0, cx, cy);
/* a band of varying width along a centre line: w(t) = half width at t 0..1 */
function strip(center, w) {
  const a = [], b = [], n = center.length;
  for (let i = 0; i < n; i++) {
    const p = center[i], q = center[Math.min(n - 1, i + 1)], r = center[Math.max(0, i - 1)];
    let dx = q[0] - r[0], dy = q[1] - r[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const h = w(i / (n - 1));
    a.push([p[0] - dy * h, p[1] + dx * h]); b.unshift([p[0] + dy * h, p[1] - dx * h]);
  }
  return a.concat(b);
}

/* ---------------- geometry ---------------- */
/* face half-width by height: straight cheeks, then a soft pointed anime chin at y = 27 */
const CHIN = 27;
const fw = y => y <= -2 ? 29.5 - 1.6 * Math.pow((y + 2) / 34, 2) : 29.5 * Math.pow(Math.max(0, 1 - Math.pow((y + 2) / (CHIN + 2), 1.7)), 0.66);
/* neck */
const NW = 8.6, neckJoin = 23.3;
const chinAt = x => { let lo = -2, hi = CHIN; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (fw(m) > Math.abs(x)) lo = m; else hi = m; } return lo; };
/* eyes */
const EYE = [-1, 1].map(s => {
  const cx = s * 13.9, cy = -3.0, w = 9.4;
  const top = x => { const t = (x - cx) / w; return cy - 7.0 * Math.pow(Math.max(0, 1 - t * t), 0.55) + s * 1.4 * t - 0.6; };
  const bot = x => { const t = (x - cx) / w; return cy + 7.0 * Math.pow(Math.max(0, 1 - t * t), 0.8) + s * 0.6 * t; };
  const xs = range(cx - w, cx + w, 30);
  const white = xs.map(x => [x, top(x)]).concat(xs.slice().reverse().slice(1, -1).map(x => [x, bot(x)]));
  const ix = cx - s * 0.6, iy = cy + 0.6;
  const irisRaw = oval(ix, iy, 6.1, 7.5, 0, 36);
  const iris = irisRaw.map(p => [p[0], Math.max(top(p[0]) + 1.0, Math.min(bot(p[0]) - 0.3, p[1]))]);
  return { s, cx, cy, w, top, bot, white, ix, iy, iris };
});
/* mouth: small open smile */
const mouthTop = x => 16.2 + 0.9 * Math.pow(x / 3.6, 2);
const mouthBot = x => 16.2 + 0.9 * Math.pow(x / 3.6, 2) + 2.6 * Math.pow(Math.max(0, 1 - Math.pow(x / 3.6, 2)), 0.8);
const mouth = range(-3.6, 3.6, 16).map(x => [x, mouthTop(x)]).concat(range(3.6, -3.6, 16).slice(1, -1).map(x => [x, mouthBot(x)]));
/* flower */
const FL = [20, -39];
const flower = range(0, Math.PI * 2, 80).slice(0, -1).map(t => { const r = 4.6 + 4.6 * Math.pow(Math.abs(Math.cos(2.5 * (t + 0.3))), 0.7); return [FL[0] + r * Math.cos(t), FL[1] + r * Math.sin(t)]; });

const crown = (t, ins) => [(41 - ins) * Math.cos(t), -18 + (40 - ins) * Math.sin(t)];
/* lock tips across the forehead: x of tip, y of tip, sweep (tips curve) */
const tips = [[-22, -12, 1.5], [-11, -12.8, 2], [-2.5, -16.5, 1.5], [6.5, -12.8, -2], [15.5, -15, -2], [24.5, -10, -1.5]];
const notches = [[-15.5, -24.4], [-7, -23.6], [2, -24.4], [11, -23.9], [20, -24.4]];
function lockCurve(a, b, tip, sweep) {
  /* from notch a down to the tip and back up to notch b, each side bowed by sweep */
  const q = (p0, p1, c, n) => range(0, 1, n).map(t => [(1 - t) * (1 - t) * p0[0] + 2 * t * (1 - t) * c[0] + t * t * p1[0], (1 - t) * (1 - t) * p0[1] + 2 * t * (1 - t) * c[1] + t * t * p1[1]]);
  const tp = [tip[0], tip[1]];
  const c1 = [(a[0] + tp[0]) / 2 + sweep * 1.6 - 1, (a[1] + tp[1]) / 2];
  const c2 = [(b[0] + tp[0]) / 2 + sweep * 1.6 + 1, (b[1] + tp[1]) / 2];
  return q(a, tp, c1, 8).concat(q(tp, b, c2, 8).slice(1));
}
/* the lower edge of the bangs, left to right */
const bangEdge = (() => { const left = [-29, -22], right = [29, -21], edge = [left], pts = [left].concat(notches, [right]);
  for (let i = 0; i < tips.length; i++) edge.push(...lockCurve(pts[i], pts[i + 1], tips[i], tips[i][2]).slice(1));
  return edge; })();
/* the face only reaches 1 mm under the bangs, so the forehead is never two solid layers deep */
const faceTopY = x => { let best = null;
  for (let i = 1; i < bangEdge.length; i++) { const p = bangEdge[i - 1], q = bangEdge[i]; if ((p[0] - x) * (q[0] - x) <= 0 && p[0] !== q[0]) { const y = p[1] + (q[1] - p[1]) * (x - p[0]) / (q[0] - p[0]); if (best === null || y < best) best = y; } }
  return (best === null ? -22 : best) - 0.6; };
const faceOutline = (() => { const xs = range(-28.6, 28.6, 160), topPts = xs.map(x => [x, faceTopY(x)]);
  const yR = topPts[topPts.length - 1][1], yL = topPts[0][1];
  return topPts.concat(range(yR, CHIN, 50).slice(1).map(y => [Math.max(0.01, fw(y)), y]), range(CHIN, yL, 50).slice(1, -1).map(y => [-Math.max(0.01, fw(y)), y])); })();

/* ================= side locks (geometry) and back hair ================= */
const lockCenter = s => smooth([[s * 31, -23], [s * 32, -6], [s * 32.6, 16], [s * 36.5, 36], [s * 41, 52], [s * 43.5, 62]], 6);
const lockWidth = t => 0.6 + 1.4 * sm(0, 0.08, t) * (1 - sm(0.8, 1, t)) + 5.0 * Math.sin(Math.PI * Math.pow(t, 0.8)) * (1 - 0.25 * t);
const sideLock = s => strip(lockCenter(s), lockWidth);
/* the lock's edge nearest the face (inner) or farthest from it (outer), as x at a given y */
function lockEdgeX(s, which, y) {
  const c = lockCenter(s), n = c.length, e = [];
  for (let i = 0; i < n; i++) {
    const q = c[Math.min(n - 1, i + 1)], r = c[Math.max(0, i - 1)]; let dx = q[0] - r[0], dy = q[1] - r[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const h = lockWidth(i / (n - 1)), p1 = [c[i][0] - dy * h, c[i][1] + dx * h], p2 = [c[i][0] + dy * h, c[i][1] - dx * h];
    const inner = Math.abs(p1[0]) < Math.abs(p2[0]) ? p1 : p2; e.push(which === 'inner' ? inner : (inner === p1 ? p2 : p1));
  }
  for (let i = 1; i < e.length; i++) { const p = e[i - 1], q = e[i]; if ((p[1] - y) * (q[1] - y) <= 0 && p[1] !== q[1]) return p[0] + (q[0] - p[0]) * (y - p[1]) / (q[1] - p[1]); }
  return null;
}
{
  /* the back hair is sewn only where it shows: outside the side locks, and between the locks and the face/neck */
  const ins = 0.25, top = -21.6, bx = y => 40.6 + 4.4 * sm(-23, 40, y), tuck = 0.9;
  for (const s of [-1, 1]) {
    const o = [];
    range(top, 46.5, 30).forEach(y => o.push([s * bx(y), y]));
    o.push([s * 45, 47]);
    range(46, top, 30).forEach(y => { const x = lockEdgeX(s, 'outer', y); if (x !== null) o.push([x - s * tuck, y]); });
    add('Back hair ' + (s < 0 ? 'left' : 'right'), poly(o), { color: C.hairDark, angle: s < 0 ? 95 : 85, spacing: 0.45, stitchLen: 4.5 });
  }
  const o = [], Y0 = 7, Y1 = 40.6;
  range(Y0, Y1, 18).forEach(y => o.push([lockEdgeX(-1, 'inner', y) - tuck, y]));
  [[-30, 39.6], [-22, 37.4], [-13.5, 34.2], [13.5, 34.2], [22, 37.4], [30, 39.6]].forEach(p => o.push(p));
  range(Y1, Y0, 18).forEach(y => o.push([lockEdgeX(1, 'inner', y) + tuck, y]));
  range(Y0, neckJoin, 16).forEach(y => o.push([fw(y) - ins, y]));
  o.push([NW - ins, 30], [-NW + ins, 30]);
  range(neckJoin, Y0, 16).forEach(y => o.push([-(fw(y) - ins), y]));
  add('Back hair behind the neck', poly(o), { color: C.hairDark, angle: 90, spacing: 0.45, stitchLen: 4.5 });
}

/* ================= body: blouse, sailor collar, neck ================= */
const bodyOuter = smooth([[-10.5, 33], [-24, 37.5], [-38, 43], [-48, 50], [-52, 58]], 6).concat([[-52, 66], [52, 66]], smooth([[52, 58], [48, 50], [38, 43], [24, 37.5], [10.5, 33]], 6));
const collarOuter = [[-10.5, 33], [-24, 37.5], [-34, 42], [-30, 50], [-14, 61], [0, 66], [14, 61], [30, 50], [34, 42], [24, 37.5], [10.5, 33]];
const neckV = [[-10.2, 33.3], [-5, 42], [0, 50], [5, 42], [10.2, 33.3]];
/* the blouse runs round under the collar's lower edge; the collar covers the shoulders */
const blouse = [[-52, 66], [-52, 58]].concat(smooth([[-52, 58], [-48, 50], [-39, 43.4], [-35, 42.6]], 5).slice(1), smooth(collarOuter, 4).slice(8, 33).map(p => [p[0] * 0.995, p[1] - 0.35]), smooth([[35, 42.6], [39, 43.4], [48, 50], [52, 58]], 5), [[52, 66]]);
add('Blouse', poly(blouse), { color: C.white, angle: 10, pattern: 'brick', spacing: 0.5, stitchLen: 4.5 });
const chinShadow = range(-NW + 0.4, NW - 0.4, 16).map(x => [x, chinAt(x) + 0.3]).concat(range(NW - 0.4, -NW + 0.4, 16).map(x => [x, Math.max(chinAt(x) + 1.3, 29 - 2.4 * Math.pow(x / NW, 2))]));
add('Neck', rings([[[-NW, 30], [-10.4, 33.6], [-5, 42.5], [0, 51], [5, 42.5], [10.4, 33.6], [NW, 30]].concat(range(NW, -NW, 18).map(x => [x, chinAt(x) - 0.8])), chinShadow]), { color: C.skin, angle: 80, spacing: 0.45 });
add('Chin shadow', poly(chinShadow), { color: C.shade, angle: 0, spacing: 0.5, stitchLen: 2.5 });
add('Sailor collar', poly(smooth(collarOuter, 4).concat([[5, 42], [0, 50], [-5, 42]])), { color: C.navy, angle: 45, spacing: 0.5, stitchLen: 4 });
add('Blouse fold left', stroke(smooth([[-36, 52], [-40, 58], [-41, 64]])), { color: C.navy, paint: 'line', lineType: 'running', stitchLen: 2 });
add('Blouse fold right', stroke(smooth([[36, 52], [40, 58], [41, 64]])), { color: C.navy, paint: 'line', lineType: 'running', stitchLen: 2 });
/* collar stripe */
for (const s of [-1, 1]) add('Collar stripe ' + (s < 0 ? 'left' : 'right'), stroke(smooth([[s * 28.5, 42.5], [s * 25.5, 49], [s * 13, 58.5], [s * 3, 62.5]], 6)), { color: C.white, paint: 'line', lineType: 'satin', lineWidth: 1.2, spacing: 0.45 });

/* ================= face ================= */
add('Face', rings([faceOutline].concat(EYE.map(e => e.white), [mouth])), { color: C.skin, angle: 20, spacing: 0.45, stitchLen: 4.5 });
/* shadow under the chin on the neck, and the hair's shadow on the forehead */
add('Cheek shade left', poly(range(11, 24, 10).map(y => [-fw(y) + 1.3, y]).concat(range(24, 11, 10).map(y => [-fw(y) + 4.2 - 1.5 * sm(14, 24, y), y]))), { color: C.shade, angle: 70, spacing: 1.0 });
add('Cheek shade right', poly(range(11, 24, 10).map(y => [fw(y) - 1.3, y]).concat(range(24, 11, 10).map(y => [fw(y) - 4.2 + 1.5 * sm(14, 24, y), y]))), { color: C.shade, angle: 110, spacing: 1.0 });
/* blush with little hatch strokes */
for (const s of [-1, 1]) {
  add('Blush ' + (s < 0 ? 'left' : 'right'), ell(s * 18.5, 8.6, 5.4, 2.4), { color: C.blush, angle: 0, spacing: 1.0 });
  [-3, 0, 3].forEach((k, i) => add('Blush stroke ' + (s < 0 ? 'left ' : 'right ') + (i + 1), stroke([[s * 18.5 + k + 1.1, 7.0], [s * 18.5 + k - 1.1, 10.2]]), { color: C.red, paint: 'line', lineType: 'running', stitchLen: 1.2 }));
}
/* eyebrows: thin, sewn before the bangs so the locks cross them */
for (const s of [-1, 1]) add('Eyebrow ' + (s < 0 ? 'left' : 'right'), stroke(smooth([[s * 7.5, -15.2], [s * 13.5, -17.4], [s * 20.5, -16.2]])), { color: C.hairDark, paint: 'line', lineType: 'satin', lineWidth: 1.1, spacing: 0.45 });
/* nose and mouth */
add('Nose', stroke([[0.6, 8.6], [-0.4, 10.6], [0.8, 10.9]]), { color: C.shade, paint: 'line', lineType: 'bean', stitchLen: 1.2 });
add('Mouth', poly(mouth), { color: C.red, angle: 0, stitchLen: 1.6, spacing: 0.6 });

/* ================= eyes ================= */
EYE.forEach(e => add('Eye white ' + (e.s < 0 ? 'left' : 'right'), rings([e.white, scaleAbout(e.iris, e.ix, e.iy, 0.97)]), { color: C.white, angle: 0, stitchLen: 2, spacing: 0.62 }));
const pupil = e => oval(e.ix, e.iy + 0.3, 2.3, 2.7, 0, 20);
const hlBig = e => oval(e.ix - e.s * 2.2, e.iy - 2.9, 1.5, 1.9, -20 * e.s, 16);
const hlSmall = e => oval(e.ix + e.s * 3.1, e.iy + 1.7, 0.95, 0.95, 0, 12);
EYE.forEach(e => {
  const nm = e.s < 0 ? 'left' : 'right';
  /* the lower part of the iris glows lighter */
  const glow = range(e.ix - 4.0, e.ix + 4.0, 16).map(x => [x, e.iy + 3.1 + 0.6 * Math.pow((x - e.ix) / 4.6, 2)]).concat(range(e.ix + 4.0, e.ix - 4.0, 16).map(x => [x, Math.min(e.bot(x) - 0.3, e.iy + 6.4 * Math.sqrt(Math.max(0, 1 - Math.pow((x - e.ix) / 5.4, 2))))]));
  add('Iris ' + nm, rings([e.iris, scaleAbout(pupil(e), e.ix, e.iy + 0.3, 0.95), scaleAbout(hlBig(e), e.ix - e.s * 2.2, e.iy - 2.9, 0.95), scaleAbout(hlSmall(e), e.ix + e.s * 3.1, e.iy + 1.7, 0.9), glow]), { color: C.iris, angle: 90, stitchLen: 1.5, spacing: 0.5 });
  add('Iris glow ' + nm, poly(glow), { color: C.irisLight, angle: 0, stitchLen: 1.5, spacing: 0.5 });
});
EYE.forEach(e => add('Pupil ' + (e.s < 0 ? 'left' : 'right'), poly(pupil(e)), { color: C.ink, angle: 0, stitchLen: 1.4, spacing: 0.5 }));
EYE.forEach(e => {
  const nm = e.s < 0 ? 'left' : 'right';
  /* heavy upper lash line with a flick at the outer corner */
  const xs = range(e.cx - e.w - 0.4, e.cx + e.w + 0.4, 26);
  const lash = xs.map(x => [x, e.top(Math.max(e.cx - e.w, Math.min(e.cx + e.w, x))) - 0.35]);
  const outer = e.s < 0 ? lash[0] : lash[lash.length - 1];
  const flick = [outer[0] + e.s * 2.6, outer[1] - 1.6];
  const pts = e.s < 0 ? [flick].concat(lash) : lash.concat([flick]);
  add('Lash line ' + nm, stroke(pts), { color: C.ink, paint: 'line', lineType: 'satin', lineWidth: 1.9, spacing: 0.48 });
  add('Lower lash ' + nm, stroke(range(e.cx - e.s * 2, e.cx + e.s * (e.w - 0.6), 10).map(x => [x, e.bot(x) + 0.4])), { color: C.ink, paint: 'line', lineType: 'running', stitchLen: 1.2 });
  add('Eyelid crease ' + nm, stroke(range(e.cx - 5.5, e.cx + 6, 10).map(x => [x + e.s * 0.6, e.top(x) - 2.9])), { color: C.shade, paint: 'line', lineType: 'running', stitchLen: 1.4 });
  add('Lashes ' + nm, stroke([[e.cx + e.s * (e.w - 1), e.top(e.cx + e.s * (e.w - 1)) - 1.2], [e.cx + e.s * (e.w + 1.2), e.top(e.cx + e.s * (e.w - 1)) - 3.4], [e.cx + e.s * (e.w - 2.6), e.top(e.cx + e.s * (e.w - 2.6)) - 1.0], [e.cx + e.s * (e.w - 0.9), e.top(e.cx + e.s * (e.w - 2.6)) - 3.6]]), { color: C.ink, paint: 'line', lineType: 'bean', stitchLen: 1.0 });
});
EYE.forEach(e => { const nm = e.s < 0 ? 'left' : 'right';
  add('Eye shine ' + nm, poly(hlBig(e)), { color: C.white, angle: 30, stitchLen: 1, spacing: 0.45 });
  add('Eye glint ' + nm, poly(hlSmall(e)), { color: C.white, angle: 0, stitchLen: 1, spacing: 0.45 });
});
add('Mouth line', stroke(range(-4.1, 4.1, 14).map(x => [x, mouthTop(x) - 0.25])), { color: C.ink, paint: 'line', lineType: 'running', stitchLen: 1.2 });

/* ================= front hair: bangs over the crown ================= */
let bangs;
{
  const edge = bangEdge;
  const top = range(-0.02 * Math.PI, -0.98 * Math.PI, 50).map(t => crown(t, 0)).filter(p => p[1] < -22.4);
  bangs = edge.concat(top);
  add('Bangs', rings([bangs, flower]), { color: C.hair, angle: 70, spacing: 0.5, stitchLen: 4 });
}
/* a single springy strand on top of the head */
add('Ahoge', stroke(smooth([[-0.5, -54.5], [-2.5, -60.5], [-6.5, -64.5], [-2.5, -66.5], [2.5, -64]], 6)), { color: C.hair, paint: 'line', lineType: 'satin', lineWidth: 2.5, spacing: 0.45 });
/* side locks falling in front of the shoulders */
const innerLock = s => strip(smooth([[s * 28.4, -20], [s * 29.6, -2], [s * 28, 12], [s * 27.5, 22]], 6), t => 0.4 + 2.6 * Math.sin(Math.PI * Math.pow(t, 0.7)));
for (const s of [-1, 1]) add('Side lock ' + (s < 0 ? 'left' : 'right'), poly(sideLock(s)), { color: C.hair, angle: s < 0 ? 100 : 80, spacing: 0.5, stitchLen: 4 });

/* hair shading and the anime shine band */
for (const s of [-1, 1]) add('Lock shade ' + (s < 0 ? 'left' : 'right'), stroke(smooth([[s * 34.6, 18], [s * 37.6, 34], [s * 41.4, 48], [s * 43, 56]], 5)), { color: C.hairDark, paint: 'line', lineType: 'running', stitchLen: 2 });
add('Bangs shade', poly(range(-0.21 * Math.PI, -0.04 * Math.PI, 20).map(t => crown(t, 1.2)).concat(range(-0.04 * Math.PI, -0.21 * Math.PI, 20).map(t => crown(t, 1.4 + 4.0 * Math.sin(Math.PI * Math.pow((t + 0.21 * Math.PI) / (0.17 * Math.PI), 0.7)))))), { color: C.hairDark, angle: 60, spacing: 1.2 });
/* anime shine: a row of pointed glints across the crown */
range(-0.82 * Math.PI, -0.50 * Math.PI, 6).forEach((t, i) => {
  const a = crown(t, 11.5), b = crown(t, 19.5 + (i % 2) * 2), c = crown(t + 0.05, 14), e = crown(t - 0.05, 14);
  add('Hair shine ' + (i + 1), poly([a, c, b, e]), { color: C.hairLight, angle: 0, spacing: 0.5, stitchLen: 1.8 });
});
/* lock lines */
const darkLines = [
  [[-15.5, -27.5], [-18, -21], [-19.5, -16]], [[-7, -25.5], [-9.2, -18], [-10.3, -13.5]],
  [[2, -27.5], [0, -23], [-1.4, -20.5]], [[11, -26], [8.8, -19], [7.4, -14]], [[20, -27.5], [17.8, -22], [16.4, -18]],
  [[-12, -48], [-9, -38], [-6, -28]], [[4, -52], [3, -40], [2, -30]], [[-24, -42], [-19, -34], [-16, -28]],
];
darkLines.forEach((l, i) => add('Lock line ' + (i + 1), stroke(smooth(l, 5)), { color: C.hairDark, paint: 'line', lineType: i < 6 ? 'running' : 'bean', stitchLen: 1.8 }));
for (const s of [-1, 1]) {
  add('Side lock line ' + (s < 0 ? 'left' : 'right'), stroke(smooth([[s * 31.5, -18], [s * 33, 4], [s * 34.2, 22], [s * 38, 40], [s * 41.5, 55]], 5)), { color: C.hairDark, paint: 'line', lineType: 'bean', stitchLen: 2 });
  add('Back hair line ' + (s < 0 ? 'left' : 'right'), stroke(smooth([[s * 39.5, -16], [s * 40.5, 10], [s * 42.5, 30], [s * 43.5, 44]], 5)), { color: C.hair, paint: 'line', lineType: 'running', stitchLen: 2.2 });
}
for (const s of [-1, 1]) add('Lock light ' + (s < 0 ? 'left' : 'right'), stroke(smooth([[s * 30, -12], [s * 31, 8], [s * 33, 26], [s * 37.5, 44]], 5)), { color: C.hairLight, paint: 'line', lineType: 'running', stitchLen: 2.2 });

/* ================= flower in the hair ================= */
add('Flower', rings([flower, oval(FL[0], FL[1], 2.6, 2.6, 0, 16)]), { color: C.pink, angle: 30, stitchLen: 2, spacing: 0.5 });
for (let k = 0; k < 5; k++) {
  const t = k * 2 * Math.PI / 5 - 0.3 + Math.PI / 5;
  add('Petal line ' + (k + 1), stroke([[FL[0] + 3.0 * Math.cos(t), FL[1] + 3.0 * Math.sin(t)], [FL[0] + 7.6 * Math.cos(t), FL[1] + 7.6 * Math.sin(t)]]), { color: C.red, paint: 'line', lineType: 'running', stitchLen: 1.4 });
}
for (let k = 0; k < 5; k++) {
  const t = k * 2 * Math.PI / 5 - 0.3;
  add('Petal vein ' + (k + 1), stroke([[FL[0] + 3.4 * Math.cos(t), FL[1] + 3.4 * Math.sin(t)], [FL[0] + 6.6 * Math.cos(t), FL[1] + 6.6 * Math.sin(t)]]), { color: C.red, paint: 'line', lineType: 'running', stitchLen: 1.2 });
}
add('Flower centre', ell(FL[0], FL[1], 2.9, 2.9), { color: C.yellow, angle: 45, stitchLen: 1.4, spacing: 0.5 });

/* ================= ribbon bow on the collar ================= */
const BOW = [0, 56];
add('Bow tail left', poly(smooth([[-1.2, 57], [-3.6, 60.5], [-5.6, 64.2], [-3.4, 63.2], [-1.8, 64.6], [-0.2, 58.6]], 4)), { color: C.red, angle: 70, spacing: 0.5 });
add('Bow tail right', poly(smooth([[1.2, 57], [3.6, 60.5], [5.6, 64.2], [3.4, 63.2], [1.8, 64.6], [0.2, 58.6]], 4)), { color: C.red, angle: 110, spacing: 0.5 });
add('Bow loop left', poly(leaf(BOW[0] - 1.5, BOW[1], BOW[0] - 10, BOW[1] - 2.5, 3.6, 0.65)), { color: C.red, angle: 75 });
add('Bow loop right', poly(leaf(BOW[0] + 1.5, BOW[1], BOW[0] + 10, BOW[1] - 2.5, 3.6, 0.65)), { color: C.red, angle: 105 });
add('Bow knot', ell(BOW[0], BOW[1], 2.2, 2.6), { color: C.red, angle: 0, spacing: 0.5 });
for (const s of [-1, 1]) add('Bow fold ' + (s < 0 ? 'left' : 'right'), stroke([[s * 3, BOW[1] - 0.6], [s * 7, BOW[1] - 1.6]]), { color: C.ink, paint: 'line', lineType: 'running', stitchLen: 1.2 });

d.save();
