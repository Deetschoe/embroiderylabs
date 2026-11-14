'use strict';
/* Starter design: a seven-spot ladybird on a green leaf, seen from above. One unit = 1 mm, 0,0 = middle, y down. */
const L = require('./lib.js');
const { range, smooth, arc, rotate, inside } = L;
const d = L.design('ladybug', { hoop: { w: 130, h: 180 }, scale: 1, origin: [0, 0] });

const C = {
  leaf: '#88C04C', leafDark: '#4A842C', vein: '#C8DF8E', edge: '#2F5E22',
  red: '#D8261E', redDark: '#97150F', pink: '#F59A86', white: '#FFF8EE', black: '#1B1818', dew: '#BFE2EC'
};
const circle = (cx, cy, r, n) => arc(cx, cy, r, r, 0, Math.PI * 2, n || 16).slice(0, -1);
const oval = (cx, cy, rx, ry, deg, n) => rotate(arc(cx, cy, rx, ry, 0, Math.PI * 2, n || 20).slice(0, -1), deg, cx, cy);

/* ---- the leaf: a curved midrib from the stem (bottom left) to the tip (top right) */
const LB = [-14, 60], LT = [18, -66], LEN = Math.hypot(LT[0] - LB[0], LT[1] - LB[1]);
const ux = (LT[0] - LB[0]) / LEN, uy = (LT[1] - LB[1]) / LEN, nx = -uy, ny = ux;
const BEND = 7;
const mid = t => [LB[0] + ux * LEN * t + nx * BEND * Math.sin(Math.PI * t), LB[1] + uy * LEN * t + ny * BEND * Math.sin(Math.PI * t)];
const halfW = t => 44 * Math.pow(Math.max(0, t < 0.42 ? Math.sin(t / 0.42 * Math.PI / 2) : Math.cos((t - 0.42) / 0.58 * Math.PI / 2)), 0.8);
const N = 48, TS = range(0, 1, N);
const side = s => TS.map(t => { const m = mid(t), w = halfW(t) * (1 + 0.025 * Math.sin(t * 34 + (s > 0 ? 0 : 1.3))); return [m[0] + s * nx * w, m[1] + s * ny * w]; });
const RIB = TS.map(mid);
const SA = side(1), SB = side(-1);           // SA = right-hand side when looking from stem to tip
const halfA = SA.concat(RIB.slice(1, -1).reverse());
const halfB = SB.concat(RIB.slice(1, -1).reverse());
const LEAF = SA.concat(SB.slice(1, -1).reverse());

/* ---- the ladybird, drawn head-up and then turned to sit along the leaf */
const TURN = 14, BX = 1, BY = 4;
const BS = 0.9, B = pts => rotate(pts.map(p => [p[0] * BS, p[1] * BS]), TURN, 0, 0).map(p => [p[0] + BX, p[1] + BY]);
const SH = smooth([[0, -14.6], [12, -15.2], [21, -9], [24.5, 3], [22.5, 16], [15.5, 27], [0, 32.5], [-15.5, 27], [-22.5, 16], [-24.5, 3], [-21, -9], [-12, -15.5]], 8, true);
const SHELL = B(SH);
/* each wing case: the right (x>0) or left half, split on the centre line */
const halfShell = s => s > 0 ? SH.slice(0, 49).concat([[-0.2, 32.5], [-0.2, -14.6]]) : SH.slice(48).concat([[0, -14.6], [0.2, -14.6], [0.2, 32.5]]);
const spots = s => [circle(s * 8.5, -1, 4.6, 16), circle(s * 16, 10, 4.2, 16), circle(s * 7.5, 21.5, 3.8, 14)];
const glint = oval(-16.8, -5.8, 7.2, 2.5, -58, 24), glintCore = oval(-17.6, -6.6, 4, 1.0, -58, 16);

const DROP = [22, -42];
const FRONT = B(oval(0, -22, 18, 10.5, 0, 24));
/* ===== sewing order ===== */
/* the leaf is left open under the shell (it tucks ~1.5 mm under the edge); the opening is split on the midrib
   so each half gets its own part, following the curve of the rib exactly */
const ribSide = p => { const dx = p[0] - LB[0], dy = p[1] - LB[1], u = dx * ux + dy * uy, v = dx * nx + dy * ny; return { u, f: v - BEND * Math.sin(Math.PI * Math.min(1, Math.max(0, u / LEN))) }; };
function clipToSide(poly, s) {
  const st = poly.findIndex(p => s * ribSide(p).f > 0); poly = poly.slice(st).concat(poly.slice(0, st));
  const out = []; let exitU = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], fa = s * ribSide(a).f, fb = s * ribSide(b).f;
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      let lo = 0, hi = 1; for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2, p = [a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m]; if ((s * ribSide(p).f >= 0) === (fa >= 0)) lo = m; else hi = m; }
      const x = [a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo], xu = ribSide(x).u;
      if (fa >= 0) { out.push(x); exitU = xu; }
      else {
        if (exitU !== null) { const n = Math.max(2, Math.round(Math.abs(xu - exitU) / 1.5)); for (let k = 1; k < n; k++) out.push(mid((exitU + (xu - exitU) * k / n) / LEN)); }
        out.push(x);
      }
    }
  }
  return out;
}
const holeR = [[0, -29.2], [4.8, -28.2], [6.2, -25.2], [9.2, -22.8], [13.7, -19.8], [13.4, -16.4], [20.2, -9.1], [23.8, 3], [21.9, 15.8], [15.1, 26.4], [0, 31.9]];
const HOLE = B(smooth(holeR.concat(holeR.slice(1, -1).reverse().map(p => [-p[0], p[1]])), 6, true));
d.add('Leaf light half', d.rings([halfA, clipToSide(HOLE, 1), oval(DROP[0], DROP[1], 5.0, 3.8, 30, 20)]), { color: C.leaf, angle: 55, spacing: 0.5 });
d.add('Leaf shaded half', d.rings([halfB, clipToSide(HOLE, -1)]), { color: C.leafDark, angle: 125, spacing: 0.5 });

/* veins, left out where the ladybird sits */
const veins = [];
for (const s of [1, -1]) for (const t of [0.1, 0.24, 0.38, 0.52, 0.66, 0.79]) {
  const m = mid(t), w = halfW(t + 0.13) * 0.86, f = mid(Math.min(0.97, t + 0.13));
  const end = [f[0] + s * nx * w, f[1] + s * ny * w], c = [lerpP(m, end, 0.5)[0] + ux * 2, lerpP(m, end, 0.5)[1] + uy * 2];
  let pts = smooth([m, c, end], 6);
  pts = pts.filter(p => !inside(p, L.scaleAbout(SHELL, BX, BY + 3, 1.12)) && !inside(p, FRONT) && Math.hypot(p[0] - DROP[0], p[1] - DROP[1]) > 8);
  if (pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) > 5) veins.push(pts);
}
function lerpP(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
veins.forEach((v, i) => d.add('Leaf vein ' + (i + 1), d.stroke(v), { color: C.vein, paint: 'line', lineType: 'satin', lineWidth: 1.0, spacing: 0.45 }));
const ribOut = RIB.filter(p => !inside(p, L.scaleAbout(SHELL, BX, BY + 3, 1.1)) && !inside(p, FRONT));
const ribTop = ribOut.filter(p => p[1] < BY), ribBot = ribOut.filter(p => p[1] >= BY);
d.add('Midrib lower', d.stroke(ribBot.slice(0, -1)), { color: C.vein, paint: 'line', lineType: 'satin', lineWidth: 2.0, spacing: 0.45 });
d.add('Midrib upper', d.stroke(ribTop.slice(1, -2)), { color: C.vein, paint: 'line', lineType: 'satin', lineWidth: 1.4, spacing: 0.45 });

d.add('Leaf edge', d.stroke(LEAF.concat([LEAF[0]])), { color: C.edge, paint: 'line', lineType: 'bean', stitchLen: 2.2 });
d.add('Stem', d.stroke(smooth([[LB[0] + 0.5, LB[1] - 2], [LB[0] - 2, LB[1] + 6], [LB[0] - 7, LB[1] + 12]], 6)), { color: C.edge, paint: 'line', lineType: 'satin', lineWidth: 3, spacing: 0.45 });

/* a dew drop on the leaf */
d.add('Dew drop', d.rings([oval(DROP[0], DROP[1], 5.6, 4.4, 30, 22), oval(DROP[0] - 2, DROP[1] - 1.5, 1.9, 1.1, 30, 12)]), { color: C.dew, angle: 120, spacing: 0.5 });
d.add('Dew shine', d.poly(oval(DROP[0] - 2, DROP[1] - 1.5, 2.1, 1.3, 30, 12)), { color: C.white, angle: 30, spacing: 0.5, stitchLen: 1.5 });

/* legs and antennae go under the shell */
const legs = [];
for (const s of [1, -1]) {
  legs.push([[s * 17.5, -9.5], [s * 24, -13], [s * 27, -20], [s * 30, -22]]);
  legs.push([[s * 22, 4], [s * 29, 5.5], [s * 33, 1], [s * 36, 0.5]]);
  legs.push([[s * 18.5, 22], [s * 25, 25.5], [s * 27, 33], [s * 30, 35]]);
}
legs.forEach((l, i) => d.add('Leg ' + (i + 1), d.stroke(B(smooth(l, 5))), { color: C.black, paint: 'line', lineType: 'satin', lineWidth: 1.5, spacing: 0.55 }));
for (const s of [1, -1]) d.add('Antenna ' + (s > 0 ? 'right' : 'left'), d.stroke(B(smooth([[s * 2.5, -28.5], [s * 4, -33], [s * 7.5, -36.5], [s * 11.5, -37.5]], 5))), { color: C.black, paint: 'line', lineType: 'satin', lineWidth: 1.0, spacing: 0.45 });
for (const s of [1, -1]) d.add('Antenna club ' + (s > 0 ? 'right' : 'left'), d.poly(B(oval(s * 12.3, -37.5, 1.7, 1.1, 0, 12))), { color: C.black, angle: 90, spacing: 0.5, stitchLen: 1.5 });

/* wing cases: red, with holes for the spots and the gloss */
for (const s of [1, -1]) {
  const holes = spots(s).concat(s < 0 ? [glint] : []);
  d.add('Wing case ' + (s > 0 ? 'right' : 'left'), d.rings([B(halfShell(s))].concat(holes.map(B))), { color: C.red, angle: s > 0 ? 60 : 120, spacing: 0.45 });
}
d.add('Shell shadow', d.poly(B(L.scaleAbout(smooth([[24.2, -2], [23, 15], [16, 27], [2, 32.6], [10, 24.5], [16.5, 14], [19.5, 2]], 6, true), 0, 9, 0.93))), { color: C.redDark, angle: 20, spacing: 1.15 });
d.add('Gloss', d.rings([B(glint), B(glintCore)]), { color: C.pink, angle: 50, spacing: 0.5 });
d.add('Gloss core', d.poly(B(glintCore)), { color: C.white, angle: 50, spacing: 0.5 });

/* black: spots, centre line, pronotum, head */
for (const s of [1, -1]) d.add('Spots ' + (s > 0 ? 'right' : 'left'), d.rings(spots(s).map(p => B(L.scaleAbout(p, p.reduce((a, q) => a + q[0], 0) / p.length, p.reduce((a, q) => a + q[1], 0) / p.length, 1.08)))), { color: C.black, angle: s > 0 ? 30 : 150, spacing: 0.5 });
d.add('Centre line', d.stroke(B([[0, -12.8], [0, 30.6]])), { color: C.black, paint: 'line', lineType: 'satin', lineWidth: 1.3, spacing: 0.45 });
const PRO = smooth([[0, -24.5], [9, -23.5], [15, -19], [14, -14.5], [0, -14.2], [-14, -14.5], [-15, -19], [-9, -23.5]], 6, true);
const proMarks = [oval(9.4, -18.6, 3.0, 2.3, -20, 14), oval(-9.4, -18.6, 3.0, 2.3, 20, 14)];
d.add('Pronotum', d.rings([B(PRO)].concat(proMarks.map(B))), { color: C.black, angle: 0, spacing: 0.5 });
d.add('Head', d.poly(B(smooth([[0, -30.5], [6, -28.8], [7.4, -24.6], [0, -23.6], [-7.4, -24.6], [-6, -28.8]], 5, true))), { color: C.black, angle: 90, spacing: 0.45 });
d.add('Pronotum marks', d.rings(proMarks.map(p => B(L.scaleAbout(p, p[0][0] > 0 ? 9.4 : -9.4, -18.6, 1.05)))), { color: C.white, angle: 90, spacing: 0.55 });
d.add('Eyes', d.rings([B(circle(3.6, -26.2, 1.0, 10)), B(circle(-3.6, -26.2, 1.0, 10))]), { color: C.white, angle: 0, spacing: 0.55, stitchLen: 1.5 });

d.save();
