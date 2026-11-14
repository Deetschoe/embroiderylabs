'use strict';
/* Starter design: an original anime-style boy, bust portrait, blue spiky hair, amber eyes, orange hoodie.
   Units are millimetres before the 0.92 scale, 0,0 near the middle, y down. */
const L = require('./lib.js');
const { range, sm, smooth, inside, scaleAbout, mirror } = L;
const d = L.design('anime-boy', { hoop: { w: 130, h: 180 }, scale: 0.92, origin: [0, 3] });
const add = (name, geom, style) => d.add(name, geom, style);
const poly = p => d.poly(p), rings = l => d.rings(l), ell = (a, b, c, e) => d.ell(a, b, c, e), stroke = p => d.stroke(p);

const C = {
  hair: '#2F4C8F', hairDark: '#1A2556', hairLight: '#7FA2E0',
  skin: '#F7DAC6', shade: '#E8B59B', line: '#9A5843', blush: '#EE9A8C',
  jacket: '#E2722F', jacketDark: '#A64A1D', white: '#FAF8F2',
  iris: '#D9962B', irisDark: '#7E4310', ink: '#221A2C',
};
const ln = (color, type, extra) => Object.assign({ color, paint: 'line', lineType: type, stitchLen: type === 'satin' ? 2 : 1.8 }, extra || {});

/* a polyline whose straight segments bow sideways by `bend` mm (gives spikes a curved, hooked look) */
function bowed(pts, bend, per) {
  per = per || 4; const o = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    for (let k = 0; k < per; k++) { const t = k / per, s = Math.sin(Math.PI * t) * bend; o.push([a[0] + dx * t - dy / len * s, a[1] + dy * t + dx / len * s]); }
  }
  o.push(pts[pts.length - 1]);
  return o;
}

/* ---- face outline: half width by height */
const FW = smooth([[-36, 23.6], [-30, 24.8], [-20, 25.6], [-10, 25.5], [-2, 24.5], [5, 22], [11, 17], [16, 10.5], [19.5, 4.6], [21.2, 0]], 10);
const hwF = y => { for (let i = 0; i < FW.length - 1; i++) { const a = FW[i], b = FW[i + 1]; if (y >= a[0] && y <= b[0]) return a[1] + (b[1] - a[1]) * (y - a[0]) / (b[0] - a[0] || 1); } return y < FW[0][0] ? FW[0][1] : 0; };
const faceR = range(-26, 21.2, 48).map(y => [hwF(y), y]);
/* the top edge tucks about 1 mm under the fringe */
const faceOutline = () => {
  /* a smooth line through the valleys between the fringe spikes, 1.2 mm above them, so the face has no thin wedges */
  const valleys = fringeBottom.filter(p => p[1] < -24).map(p => [p[0], p[1] - 1.2]);
  const top = smooth([[-22.6, -26]].concat(valleys.slice().reverse(), [[22.6, -26]]), 4).filter(p => Math.abs(p[0]) < 22.7);
  return faceR.concat(mirror(faceR).slice(1)).concat(top);
};

/* ---- eye geometry */
const eyeShape = s => smooth([[5.6, -6.4], [8, -11.2], [13, -13.3], [18.2, -12.4], [21, -9.6], [19.2, -5], [13.5, -1.9], [8.4, -3.2]].map(p => [s * p[0], p[1]]), 6, true);
const EYE = { '-1': eyeShape(-1), '1': eyeShape(1) };
/* the hole in the face reaches up under the lash line so the satin lies on one layer, not three */
const eyeHole = s => smooth([[5.2, -6.9], [7.8, -12.4], [13, -14.5], [18.4, -13.6], [21.4, -10.6], [19.2, -5], [13.5, -1.9], [8.4, -3.2]].map(p => [s * p[0], p[1]]), 6, true);
const IC = s => [s * 12.6, -7.2];

/* ================= fringe (front hair) ================= */
const fringeBottom = [[23.4, -10], [22.3, -22], [19.5, -28], [15.4, -20.6], [12.5, -29], [6.6, -18.2], [3.5, -28.5], [-2.6, -13.8], [-4.5, -28.5], [-12, -20.2],
  [-13.5, -28], [-20.5, -19], [-21.8, -25], [-23.6, -10]];
const fringe = (() => {
  const top = range(Math.PI * 1.10, Math.PI * 1.90, 30).map(t => [29.5 * Math.cos(t), -27 + 29.5 * Math.sin(t)]);
  const right = bowed([[28.3, -30], [30.3, -18], [26.6, 1.5]], 0.8, 5).slice(1);
  /* valleys get a short flat top so the fill does not pile up in a sharp notch */
  const fb = [];
  fringeBottom.forEach((p, i) => { if (p[1] < -24 && i > 0 && i < fringeBottom.length - 1) fb.push([p[0] + 1.1, p[1] + 0.2], [p[0] - 1.1, p[1] + 0.2]); else fb.push(p); });
  const bot = bowed([[26.6, 1.5]].concat(fb), 1.0, 5).slice(1);
  const left = bowed([[-26.6, 1.5], [-30.3, -18], [-28.3, -30]], 0.8, 5);
  return { all: top.concat(right, bot, left.slice(0, -1)), top, right, left, bot };
})();
/* ================= back hair (spiky silhouette around the head) ================= */
const SIL = [[-25.5, 4], [-30, 12.5], [-29.5, -1], [-36.5, 4.5], [-31.5, -11], [-42, -11.5], [-34.5, -23], [-46, -29], [-35.5, -37], [-43, -52], [-25.5, -49.5],
  [-27, -67], [-12.5, -56], [-3, -73], [5, -57.5], [20, -69], [22.5, -52.5], [40, -56.5], [34.5, -41], [47, -33.5], [35.5, -25.5], [43.5, -13.5], [32.5, -12],
  [38, 2.5], [30, -2], [31, 12.5], [25.5, 4]];
const silhouette = bowed(SIL, 1.8, 6);
{
  /* hidden under the fringe and the face, so cut both out (with a small overlap) */
  const sc = p => scaleAbout(p, 0, -22, 0.975);
  const pts = silhouette.slice();
  /* up the side of the face to just behind the sideburn tip, then along the outside of the fringe */
  range(4, -3, 7).forEach(y => pts.push([hwF(y) - 0.7, y]));
  pts.push([26.2, -3.4]);
  sc(fringe.right.slice().reverse()).forEach(p => pts.push(p));
  sc(fringe.top.slice().reverse()).forEach(p => pts.push(p));
  sc(fringe.left.slice().reverse()).forEach(p => pts.push(p));
  pts.push([-26.2, -3.4]);
  range(-3, 4, 7).forEach(y => pts.push([-(hwF(y) - 0.7), y]));
  add('Hair back', poly(pts), { color: C.hair, angle: 75, spacing: 0.5, stitchLen: 3.6 });
}

/* cel shading: the trailing side of every spike is darker */
for (let i = 1; i < SIL.length - 1; i += 2) {
  const tip = SIL[i], v = SIL[i + 1], u = SIL[i - 1], base = [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
  if (Math.hypot(tip[0] - base[0], tip[1] - base[1]) < 9) continue;
  const q = (a, b, t) => [L.lerp(a[0], b[0], t), L.lerp(a[1], b[1], t)];
  add('Hair shade spike ' + ((i + 1) / 2), poly([q(base, v, 0.12), q(base, v, 0.82), q(v, tip, 0.62), q(base, tip, 0.55)]), { color: C.hairDark, angle: Math.round(Math.atan2(base[1] - tip[1], tip[0] - base[0]) * 180 / Math.PI), spacing: 0.95, stitchLen: 2.5 });
}

/* ================= hoodie ================= */
const hoodOuter = smooth([[-22, 24.5], [-25.5, 31], [-20, 40.5], [-9, 48], [0, 50.5], [9, 48], [20, 40.5], [25.5, 31], [22, 24.5]], 6);
const hoodInner = smooth([[12.8, 24.5], [13.6, 31], [9, 38.5], [0, 42.5], [-9, 38.5], [-13.6, 31], [-12.8, 24.5]], 6);
{
  const sh = smooth([[-52, 53], [-49.5, 42], [-42, 34.5], [-31, 30], [-24.6, 28.6]], 6);
  const dip = scaleAbout(hoodOuter, 0, 36, 0.965).filter(p => p[1] > 29.5);
  const body = [[-52, 62]].concat(sh, dip, mirror(sh), [[52, 62]]);
  add('Hoodie', poly(body), { color: C.jacket, angle: 95, pattern: 'brick', spacing: 0.5, stitchLen: 3.6 });
  add('T-shirt', poly(smooth([[-13.2, 24], [-14.0, 31], [-9.2, 38.8], [0, 42.8], [9.2, 38.8], [14.0, 31], [13.2, 24]], 6)), { color: C.white, angle: 0, spacing: 0.45 });
  /* the top of the neck follows the jaw, 1 mm under the face */
  const jawAt = x => { let y = 0; for (const p of faceR) if (p[0] >= Math.abs(x)) y = p[1]; return y; };
  const neckTop = range(7.4, -7.4, 14).map(x => [x, Math.min(17, jawAt(x) - 1.0)]);
  add('Neck', poly(smooth([[-7.4, jawAt(7.4) - 1], [-7.4, 22], [-9.6, 30], [-5.6, 34.5], [0, 36.5], [5.6, 34.5], [9.6, 30], [7.4, 22], [7.4, jawAt(7.4) - 1]], 6).concat(neckTop.slice(1, -1))), { color: C.skin, angle: 80, spacing: 0.45 });
  add('Hood', poly(hoodOuter.concat([[17.4, 23.2]], hoodInner, [[-17.4, 23.2]])), { color: C.jacket, angle: 20, spacing: 0.45 });
}
/* hoodie shading and seams in the dark orange */
{
  const D = C.jacketDark;
  add('Hood inside shadow', poly(smooth([[-14.0, 26], [-14.0, 31.5], [-9.6, 38.8], [0, 42.6], [9.6, 38.8], [14.0, 31.5], [14.0, 26], [16.2, 27], [16.6, 32.5], [11.2, 41.6], [0, 45.6], [-11.2, 41.6], [-16.6, 32.5], [-16.2, 27]], 4, true)), { color: D, angle: 160, spacing: 1.4 });
  add('Shoulder shade right', poly(smooth([[30, 31], [43, 35.5], [50.5, 43], [51.4, 54], [51.4, 61.5], [44, 61.5], [44.5, 52], [40, 42], [30, 35]], 5, true)), { color: D, angle: 60, spacing: 1.3 });
  add('Hood fold left', stroke(smooth([[-21.5, 31], [-18, 37], [-11, 43]])), ln(D, 'bean'));
  add('Hood fold right', stroke(smooth([[21.5, 31], [18, 37], [11, 43]])), ln(D, 'bean'));
  add('Hood rim left', stroke(hoodOuter.filter(p => p[1] > 26.5 && p[0] < -8.5)), ln(D, 'running', { stitchLen: 2 }));
  add('Hood rim right', stroke(hoodOuter.filter(p => p[1] > 26.5 && p[0] > 8.5)), ln(D, 'running', { stitchLen: 2 }));
  add('Sleeve seam left', stroke(smooth([[-37, 33], [-41, 45], [-43, 55], [-43.5, 61.5]])), ln(D, 'bean', { stitchLen: 2.2 }));
  add('Sleeve seam right', stroke(smooth([[37, 33], [41, 45], [43, 55], [43.5, 61.5]])), ln(D, 'bean', { stitchLen: 2.2 }));
  add('Chest fold', stroke(smooth([[-30, 50], [-24, 55], [-21, 60]])), ln(D, 'running', { stitchLen: 2 }));
  for (const s of [-1, 1]) {
    add('Drawstring ' + (s < 0 ? 'left' : 'right'), stroke(smooth([[s * 5.5, 50.6], [s * 6.0, 54], [s * 6.6, 57.5]])), ln(C.white, 'satin', { lineWidth: 1.6, spacing: 0.75 }));
    add('Drawstring tip ' + (s < 0 ? 'left' : 'right'), stroke([[s * 6.6, 57.6], [s * 6.8, 60.6]]), ln(D, 'satin', { lineWidth: 1.7, spacing: 0.4 }));
  }
  add('T-shirt collar', stroke(smooth([[-10.8, 31.5], [-6, 36.6], [0, 38.5], [6, 36.6], [10.8, 31.5]])), ln('#D9D4CA', 'running', { stitchLen: 1.6 }));
}

/* ================= face (the ears are hidden under the hair) ================= */
add('Face', rings([faceOutline(), eyeHole(-1), eyeHole(1)]), { color: C.skin, angle: 20, spacing: 0.5, stitchLen: 3.5 });
{
  const jaw = range(-8.4, 8.4, 24).map(x => { let y = 0; for (const p of faceR) if (p[0] >= Math.abs(x)) y = p[1]; return [x, y - 0.3]; });
  add('Shade under chin', poly(jaw.concat(jaw.slice().reverse().map(p => [p[0] * 0.92, p[1] + 3.6 - 1.2 * Math.pow(p[0] / 8.4, 2)]))), { color: C.shade, angle: 0, spacing: 1.1 });
}
{
  /* cel shading: right side of the face and under the fringe */
  const so = range(-6, 15, 18).map(y => [hwF(y) - 0.4, y]);
  const si = range(15, -6, 18).map(y => [Math.max(1.5, hwF(y) - (1.8 + 4.2 * Math.sin(Math.PI * (y + 6) / 22))), y]);
  add('Shade cheek', poly(so.concat(si)), { color: C.shade, angle: 120, spacing: 0.85 });
}

/* ================= eyes ================= */
const irisPts = s => {
  const [cx, cy] = IC(s), e = scaleAbout(EYE[s], s * 13, -7.5, 0.92);
  return range(0, Math.PI * 2, 40).slice(0, -1).map(t => {
    let r = 1, p;
    do { p = [cx + 4.5 * r * Math.cos(t), cy + 5.7 * r * Math.sin(t)]; r -= 0.03; } while (!inside(p, e) && r > 0.2);
    return p;
  });
};
for (const s of [-1, 1]) {
  const nm = s < 0 ? 'left' : 'right';
  add('Eye white ' + nm, rings([scaleAbout(EYE[s], s * 13, -7.5, 1.0), scaleAbout(irisPts(s), IC(s)[0], IC(s)[1], 0.92)]), { color: C.white, angle: 0, stitchLen: 1.6, spacing: 0.65 });
}
for (const s of [-1, 1]) {
  const nm = s < 0 ? 'left' : 'right', [cx, cy] = IC(s);
  add('Iris ' + nm, poly(irisPts(s)), { color: C.iris, angle: 90, stitchLen: 1.6, spacing: 0.5 });
}
for (const s of [-1, 1]) {
  const nm = s < 0 ? 'left' : 'right', [cx, cy] = IC(s), ip = irisPts(s);
  const top = ip.filter(p => p[1] < cy - 1.2);
  add('Iris shadow ' + nm, poly(top.length > 4 ? ip.filter(p => p[1] < cy - 0.6) : ip), { color: C.irisDark, angle: 0, stitchLen: 1.5, spacing: 1.3 });
  add('Iris ring ' + nm, stroke(ip.filter(p => p[1] > cy - 2).concat([])), ln(C.irisDark, 'running', { stitchLen: 1.2 }));
}
for (const s of [-1, 1]) {
  const nm = s < 0 ? 'left' : 'right', [cx, cy] = IC(s);
  add('Pupil ' + nm, ell(cx, cy + 0.4, 1.9, 2.6), { color: C.ink, angle: 90, stitchLen: 1.4, spacing: 0.5 });
  /* upper lash line with a sharp flick at the outer corner */
  const lash = smooth([[s * 5.0, -6.9], [s * 8, -11.6], [s * 13, -13.6], [s * 18.4, -12.7], [s * 21.4, -10.1]], 6);
  add('Lash line ' + nm, stroke(lash), ln(C.ink, 'satin', { lineWidth: 1.5, spacing: 0.5 }));
  add('Lash flick ' + nm, stroke([[s * 20.6, -10.9], [s * 22.0, -11.3], [s * 23.0, -11.1]]), ln(C.ink, 'bean', { stitchLen: 1 }));
  add('Lower lid ' + nm, stroke(smooth([[s * 19.6, -6.2], [s * 17.8, -4.0], [s * 15.6, -2.9]])), ln(C.ink, 'running', { stitchLen: 1.2 }));
  add('Eyelid crease ' + nm, stroke(smooth([[s * 9.5, -14.6], [s * 14, -15.9], [s * 19, -14.6]])), ln(C.line, 'running', { stitchLen: 1.4 }));
}
for (const s of [-1, 1]) {
  const nm = s < 0 ? 'left' : 'right', [cx, cy] = IC(s);
  add('Eye shine big ' + nm, ell(cx - 1.6, cy - 2.4, 1.25, 1.5), { color: C.white, angle: 45, stitchLen: 1.2, spacing: 0.55 });
  add('Eye shine small ' + nm, stroke([[cx + 1.6, cy + 2.6], [cx + 2.4, cy + 1.9]]), ln(C.white, 'bean', { stitchLen: 1 }));
}

/* ================= nose, mouth, blush ================= */
add('Nose', stroke(smooth([[1.2, 3.2], [2.4, 6.4], [0.6, 7.4]])), ln(C.line, 'bean', { stitchLen: 1.3 }));
add('Smile', stroke(smooth([[-5, 12.2], [-1.5, 13.4], [2.5, 13.2], [5.4, 11.6], [6.4, 10.6]], 6)), ln(C.line, 'bean', { stitchLen: 1.3 }));
add('Smile corner', stroke([[6.6, 11.6], [5.8, 10.0]]), ln(C.line, 'running', { stitchLen: 1 }));
for (const s of [-1, 1]) for (let k = 0; k < 3; k++) {
  const x = s * (13.5 + k * 2.4), y = 2.4;
  add('Blush ' + (s < 0 ? 'left ' : 'right ') + (k + 1), stroke([[x - 0.6, y + 1.6], [x + 0.8, y - 1.4]]), ln(C.blush, 'bean', { stitchLen: 1 }));
}

add('Eyebrow left', stroke(smooth([[-5, -15.2], [-11, -16.9], [-17, -17.7], [-21.5, -16.9]])), ln(C.hairDark, 'satin', { lineWidth: 1.5, spacing: 0.55 }));
add('Eyebrow right', stroke(smooth([[5, -15.2], [11, -16.9], [17, -17.7], [21.5, -16.9]])), ln(C.hairDark, 'satin', { lineWidth: 1.5, spacing: 0.55 }));
add('Hair front', poly(fringe.all), { color: C.hair, angle: 95, spacing: 0.5, stitchLen: 3.5 });

/* hair highlights (open, so the blue shows through) */
{
  const band = [];
  range(Math.PI * 1.20, Math.PI * 1.72, 20).forEach(t => band.push([22.5 * Math.cos(t), -27 + 22.5 * Math.sin(t)]));
  range(Math.PI * 1.72, Math.PI * 1.20, 6).forEach((t, i) => { const r = i % 2 ? 14.5 : 18.8; band.push([r * Math.cos(t), -27 + r * Math.sin(t)]); });
  add('Hair shine front', poly(band), { color: C.hairLight, angle: 120, spacing: 1.1 });
}
/* strands: dark lines that follow each spike */
{
  const S = (a, pts) => add('Hair strand ' + a, stroke(smooth(pts)), ln(C.hairDark, 'bean', { stitchLen: 2 }));
  S('fringe 1', [[4, -46], [0.5, -32], [-1.2, -24.5]]);
  S('fringe 2', [[11, -44], [9, -33], [8, -27.5]]);
  S('fringe 3', [[-6, -45], [-9.5, -33], [-10.5, -27.5]]);
  S('fringe 4', [[19, -41], [17.5, -33], [16.8, -27.8]]);
  S('fringe 5', [[-15, -43], [-18, -33], [-18.8, -28]]);
  S('side right', [[25, -30], [27, -18], [26, -3]]);
  S('side left', [[-25, -30], [-27, -18], [-26, -3]]);
  add('Hair strand crown', stroke(range(Math.PI * 1.16, Math.PI * 1.84, 30).map(t => [27.2 * Math.cos(t), -27 + 27.2 * Math.sin(t)])), ln(C.hairDark, 'bean', { stitchLen: 2 }));
  /* one line up the middle of each big spike, from its base towards the tip */
  for (let i = 3; i < SIL.length - 3; i += 2) {
    const tip = SIL[i], base = [(SIL[i - 1][0] + SIL[i + 1][0]) / 2, (SIL[i - 1][1] + SIL[i + 1][1]) / 2];
    if (Math.hypot(tip[0] - base[0], tip[1] - base[1]) < 9) continue;
    const a = L.lerp, q = t => [a(base[0], tip[0], t), a(base[1], tip[1], t)];
    S('spike ' + i, [q(-0.05), q(0.35), q(0.68)]);
  }
}
add('Hair outline', stroke(silhouette), ln(C.hairDark, 'running', { stitchLen: 1.8 }));
d.save();
