'use strict';
/* Starter design: a dragonfly seen from above, wings spread. Units are millimetres, 0,0 = middle, y down. */
const L = require('./lib.js');
const { range, smooth, mirror, lerp } = L;
const d = L.design('dragonfly', { hoop: { w: 130, h: 180 }, scale: 1, origin: [0, 0] });

const C = { wing: '#9CD3E4', vein: '#4FA5BA', teal: '#1E8C8E', blue: '#2C6DB5', navy: '#16384E', shine: '#DDF6F3' };

/* ---- small helpers */
/* n + 1 evenly spaced points along a line */
function walk(pts, n) {
  const acc = [0]; for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = acc[acc.length - 1], out = [];
  for (let k = 0; k <= n; k++) {
    const s = total * k / n; let i = 1; while (i < pts.length - 1 && acc[i] < s) i++;
    const t = (s - acc[i - 1]) / ((acc[i] - acc[i - 1]) || 1), a = pts[i - 1], b = pts[i];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}
const flip = style => Object.assign({}, style, style.angle === undefined ? null : { angle: 180 - style.angle });
const line = (color, type, extra) => Object.assign({ color, paint: 'line', lineType: type, stitchLen: 2 }, extra);

/* ---- wings (right side): a leading edge, a trailing edge and a rounded tip */
const wings = [
  { name: 'Forewing', angle: 38,
    lead: [[3.5, -32.4], [16, -36.4], [30, -38.9], [44, -39.9], [51.6, -39.2]], tip: [[55.2, -36.2]],
    trail: [[3.5, -30.2], [10, -29.4], [20, -28.5], [32, -28.3], [44, -29.6], [51.4, -32.4]] },
  { name: 'Hindwing', angle: 52,
    lead: [[3.5, -26.6], [16, -27], [30, -25.4], [43, -22.4], [50.6, -19.6]], tip: [[54, -15.6]],
    trail: [[3.8, -22.4], [9, -16.6], [18, -12.6], [30, -10.9], [41, -10.6], [49.6, -12.4]] },
];
for (const w of wings) {
  w.outline = smooth(w.lead.concat(w.tip, w.trail.slice().reverse()), 8, true);
  const N = 40, a = walk(smooth(w.lead.concat(w.tip), 8), N), b = walk(smooth(w.trail.concat(w.tip), 8), N);
  /* a vein that runs along the wing, `f` of the way from the leading to the trailing edge */
  w.vein = (f, t0, t1) => range(Math.round(t0 * N), Math.round(t1 * N), Math.round((t1 - t0) * N)).map(i => { i = Math.round(i); return [lerp(a[i][0], b[i][0], f), lerp(a[i][1], b[i][1], f)]; });
  w.at = (f, t) => { const i = Math.round(t * N); return [lerp(a[i][0], b[i][0], f), lerp(a[i][1], b[i][1], f)]; };
}
const sides = [['right', p => p, s => s], ['left', mirror, flip]];

/* sheer wing membrane: an open grid, no solid fill */
for (const w of [wings[1], wings[0]]) for (const [side, M, S] of sides)
  d.add(w.name + ' ' + side, d.poly(M(w.outline)), S({ color: C.wing, angle: w.angle, pattern: 'crosshatch', spacing: 0.45, stitchLen: 2.5 }));

/* veins */
for (const w of [wings[1], wings[0]]) for (const [side, M] of sides) {
  d.add(w.name + ' vein 1 ' + side, d.stroke(M(w.vein(0.2, 0.04, 0.95))), line(C.vein, 'running'));
  d.add(w.name + ' vein 2 ' + side, d.stroke(M(w.vein(0.48, 0.06, 0.93))), line(C.vein, 'running'));
  d.add(w.name + ' vein 3 ' + side, d.stroke(M(w.vein(0.76, 0.16, 0.9))), line(C.vein, 'running'));
  d.add(w.name + ' cross veins ' + side, d.stroke(M([w.at(0.2, 0.3), w.at(0.48, 0.36), w.at(0.2, 0.44), w.at(0.02, 0.47), w.at(0.2, 0.5), w.at(0.48, 0.56), w.at(0.2, 0.64), w.at(0.48, 0.72), w.at(0.2, 0.8)])), line(C.vein, 'running'));
}

/* wing outlines */
for (const w of [wings[1], wings[0]]) for (const [side, M] of sides)
  d.add(w.name + ' edge ' + side, d.stroke(M(w.outline.concat([w.outline[0]]))), line(C.teal, 'bean', { stitchLen: 2.2 }));

/* ---- body */
const thorax = smooth([[0, -38.2], [3.2, -37.2], [4.9, -33.4], [5, -28.4], [3.7, -23.6], [2.1, -20.4], [0, -19.8], [-2.1, -20.4], [-3.7, -23.6], [-5, -28.4], [-4.9, -33.4], [-3.2, -37.2]], 6, true);
d.add('Thorax', d.poly(thorax), { color: C.teal, angle: 0, spacing: 0.42 });
d.add('Face', d.ell(0, -43.3, 2.3, 1.5), { color: C.teal, angle: 0, spacing: 0.45 });
/* abdomen: satin segments, teal and blue in turn */
const segs = [[-20.6, -14.6, 4.4], [-14.6, -6.6, 3.7], [-6.6, 2.4, 3.3], [2.4, 11.4, 3.1], [11.4, 20.4, 3.0], [20.4, 29.2, 3.0], [29.2, 36.6, 3.2], [36.6, 42.4, 3.4]];
segs.forEach((s, i) => { if (i % 2 === 0) d.add('Abdomen ' + (i + 1), d.stroke([[0, s[0]], [0, s[1] + 0.3]]), line(C.teal, 'satin', { lineWidth: s[2], spacing: 0.42 })); });
segs.forEach((s, i) => { if (i % 2 === 1) d.add('Abdomen ' + (i + 1), d.stroke([[0, s[0]], [0, s[1] + 0.3]]), line(C.blue, 'satin', { lineWidth: s[2], spacing: 0.42 })); });
d.add('Thorax saddle', d.poly(smooth([[0, -29.6], [2.6, -28.4], [2.2, -24.4], [0, -22.6], [-2.2, -24.4], [-2.6, -28.4]], 6, true)), { color: C.blue, angle: 90, spacing: 0.9 });

/* dark: eyes, joints, wing spots, tail */
for (const s of [-1, 1]) d.add('Eye ' + (s < 0 ? 'left' : 'right'), d.ell(s * 2.55, -40.4, 2.7, 2.5), { color: C.navy, angle: s < 0 ? 60 : 120, spacing: 0.42, stitchLen: 2 });
segs.slice(0, -1).forEach((s, i) => d.add('Joint ' + (i + 1), d.stroke([[-s[2] / 2 - 0.1, s[1] + 0.2], [s[2] / 2 + 0.1, s[1] + 0.2]]), line(C.navy, 'satin', { lineWidth: 1, spacing: 0.45 })));
for (const s of [-1, 1]) d.add('Tail ' + (s < 0 ? 'left' : 'right'), d.stroke([[s * 0.8, 42.6], [s * 1.5, 46.4]]), line(C.navy, 'bean', { stitchLen: 1.6 }));
for (const w of wings) for (const [side, M] of sides)
  d.add(w.name + ' spot ' + side, d.stroke(M([w.at(0.09, 0.83), w.at(0.09, 0.9)])), line(C.navy, 'satin', { lineWidth: 1.7, spacing: 0.42 }));

/* light: shine along the body, a glint in each eye, two shoulder stripes */
segs.forEach((s, i) => d.add('Shine ' + (i + 1), d.stroke([[-0.75, s[0] + 1.6], [-0.75, s[1] - 1.2]]), line(C.shine, 'bean', { stitchLen: 2.2 })));
for (const s of [-1, 1]) {
  d.add('Shoulder stripe ' + (s < 0 ? 'left' : 'right'), d.stroke(smooth([[s * 1.5, -36.4], [s * 2.1, -33.4], [s * 2.3, -30.6]])), line(C.shine, 'satin', { lineWidth: 1.1, spacing: 0.5 }));
  d.add('Eye glint ' + (s < 0 ? 'left' : 'right'), d.stroke([[s * 2.5 - 1.3, -40.8], [s * 2.5 - 0.5, -41.9]]), line(C.shine, 'bean', { stitchLen: 1.2 }));
}

d.save();
