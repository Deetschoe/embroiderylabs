'use strict';
/* Starter design: a smiling man with short brown hair. Face units: x right, y down, 1 unit = 50 mm. */
const L = require('./lib.js');
const { range, sm, g, smooth, inside, scaleAbout } = L;
const d = L.design('smiling-man', { hoop: { w: 130, h: 180 }, scale: 50, origin: [0, 2] });
const add = (name, geom, style) => d.add(name, geom, style);
const poly = pts => d.poly(pts), rings = (list, rule) => d.rings(list, rule), ell = (cx, cy, rx, ry) => d.ell(cx, cy, rx, ry), stroke = pts => d.stroke(pts);

/* ---- colours (thread) */
const C = {
  shirt: '#3F5F80', shirtDark: '#2B4460',
  skin: '#EFC6A8', shade: '#D8A283', deep: '#BD8765', line: '#A9714F', blush: '#E9A796', light: '#FBE3D0',
  hair: '#6B4423', hairDark: '#432A17', hairLight: '#9B6B3E',
  lip: '#C56F68', lipLight: '#E3A29A', mouth: '#5E2B2E', white: '#FCFAF4', tooth: '#C9CCD1',
  iris: '#4E7FA8', ink: '#1E1512',
};

/* ---- head outline */
function hw(y) {
  if (y <= -0.05) return 0.47 * Math.sqrt(Math.max(0, 1 - Math.pow((y + 0.22) / 0.58, 2)));
  if (y <= 0.30) { const t = (y + 0.05) / 0.35; return 0.449 - (0.449 - 0.372) * Math.pow(t, 2.1); }
  const t = Math.min(1, (y - 0.30) / 0.205); return 0.372 * Math.pow(Math.max(0, 1 - Math.pow(t, 2.8)), 1 / 2.8);
}
const chinY = x => 0.30 + 0.205 * Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, Math.abs(x) / 0.372), 2.8)), 1 / 2.8);

/* ================= shirt, collar, neck ================= */
const sh = x => 0.615 + 0.15 * Math.pow(sm(0.17, 0.86, Math.abs(x)), 0.9);
const arc = (rx, ry, a0, a1, m) => range(a0, a1, m).map(t => [rx * Math.cos(t), 0.585 + ry * Math.sin(t)]);
{
  const pts = [[-0.86, 0.80]];
  range(-0.86, -0.25, 14).forEach(x => pts.push([x, sh(x)]));
  arc(0.255, 0.165, Math.PI - 0.2, 0.2, 28).forEach(p => pts.push(p));
  range(0.25, 0.86, 14).forEach(x => pts.push([x, sh(x)]));
  pts.push([0.86, 0.80]);
  add('Shirt', poly(pts), { color: C.shirt, angle: 0, pattern: 'brick' });
  add('Collar', stroke(arc(0.270, 0.180, Math.PI - 0.13, 0.13, 30)), { color: C.shirtDark, paint: 'line', lineType: 'satin', lineWidth: 2.4 });
  add('Shirt fold left', stroke(smooth([[-0.42, 0.705], [-0.50, 0.74], [-0.56, 0.795]])), { color: C.shirtDark, paint: 'line', lineType: 'bean', stitchLen: 2 });
  add('Shirt fold right', stroke(smooth([[0.44, 0.71], [0.52, 0.745], [0.57, 0.795]])), { color: C.shirtDark, paint: 'line', lineType: 'bean', stitchLen: 2 });
  add('Shoulder seam left', stroke(range(-0.34, -0.82, 12).map(x => [x, sh(x) + 0.034])), { color: C.shirtDark, paint: 'line', lineType: 'running', stitchLen: 2 });
  add('Shoulder seam right', stroke(range(0.34, 0.82, 12).map(x => [x, sh(x) + 0.034])), { color: C.shirtDark, paint: 'line', lineType: 'running', stitchLen: 2 });

  const neck = range(0.212, -0.212, 20).map(x => [x, chinY(x) - 0.014]).concat([[-0.222, 0.52], [-0.238, 0.60]]);
  arc(0.262, 0.172, Math.PI - 0.22, 0.22, 26).forEach(p => neck.push(p));
  neck.push([0.238, 0.60], [0.222, 0.52]);
  add('Neck', poly(neck), { color: C.shade, angle: 80 });
  const top = range(-0.205, 0.205, 20).map(x => [x, chinY(x) - 0.004]);
  const bot = range(0.205, -0.205, 20).map(x => [x, chinY(x) + 0.060 - 0.035 * Math.pow(x / 0.205, 2)]);
  add('Shadow under the chin', poly(top.concat(bot)), { color: C.deep, angle: 0, spacing: 0.85 });
  add('Neck line left', stroke(smooth([[-0.105, 0.535], [-0.085, 0.60], [-0.05, 0.67]])), { color: C.deep, paint: 'line', lineType: 'running', stitchLen: 2 });
  add('Neck line right', stroke(smooth([[0.105, 0.535], [0.085, 0.60], [0.05, 0.67]])), { color: C.deep, paint: 'line', lineType: 'running', stitchLen: 2 });
}

/* ================= ears ================= */
add('Ear right', ell(0.490, -0.055, 0.060, 0.140), { color: C.shade, angle: 60 });
add('Ear left', ell(-0.490, -0.055, 0.060, 0.140), { color: C.skin, angle: 120 });

/* ================= eyes and mouth geometry (needed for the holes in the face) ================= */
const EY = -0.140, EXC = 0.192, EW = 0.106;
function almond(side, gu, gl) {
  gu = gu || 0; gl = gl || 0; const ex = side * EXC, up = [], lo = [];
  range(-1, 1, 24).forEach(t => { const a = Math.max(0, 1 - t * t), tilt = -side * 0.006 * t; up.push([ex + EW * t, EY - 0.051 * Math.pow(a, 0.75) + tilt - gu]); });
  range(1, -1, 24).forEach(t => { const a = Math.max(0, 1 - t * t), tilt = -side * 0.006 * t; lo.push([ex + EW * t, EY + 0.024 * Math.pow(a, 0.9) + tilt + gl]); });
  return { up, lo, all: up.concat(lo.slice(1, -1)) };
}
const lidUp = (side, x) => { const t = Math.max(-1, Math.min(1, (x - side * EXC) / EW)); return EY - 0.051 * Math.pow(Math.max(0, 1 - t * t), 0.75) - side * 0.006 * t; };
const lidLo = (side, x) => { const t = Math.max(-1, Math.min(1, (x - side * EXC) / EW)); return EY + 0.024 * Math.pow(Math.max(0, 1 - t * t), 0.9) - side * 0.006 * t; };
const MX = 0.186;
const yUp = x => 0.262 - 0.022 * (x / MX) * (x / MX);
const yLo = x => 0.336 - 0.096 * (x / MX) * (x / MX);
const yTop = x => yUp(x) - 0.030 * Math.pow(Math.max(0, 1 - (x / MX) * (x / MX)), 0.55) + 0.007 * g(x, 0.022) - 0.004 * g(Math.abs(x) - 0.045, 0.03);
const yBot = x => yLo(x) + 0.044 * Math.pow(Math.max(0, 1 - (x / MX) * (x / MX)), 0.75);
const lipsOuter = range(-MX, MX, 36).map(x => [x, yTop(x)]).concat(range(MX, -MX, 36).slice(1, -1).map(x => [x, yBot(x)]));
const MO = MX * 0.90;
const opening = range(-MO, MO, 32).map(x => [x, yUp(x)]).concat(range(MO, -MO, 32).slice(1, -1).map(x => [x, yLo(x)]));

/* ================= face ================= */
{
  const left = [], right = [];
  for (let y = -0.50; y < 0.40; y += 0.02) left.push([-(hw(y) - 0.034 * sm(-0.03, -0.11, y)), y]);   /* tucked under the sideburn */
  for (let y = 0.40; y <= 0.5051; y += 0.0075) left.push([-hw(Math.min(y, 0.505)), Math.min(y, 0.505)]);
  for (let i = left.length - 2; i >= 0; i--) right.push([-left[i][0], left[i][1]]);
  /* the top edge tucks just under the hair, following the hairline */
  const hairline = x => -0.505 - 0.060 * g(Math.abs(x) - 0.285, 0.085) + 0.035 * x - 0.035 * g(x - 0.06, 0.16);
  const top = range(0.40, -0.40, 40).map(x => [x, hairline(x) - 0.016]);
  const outline = left.concat(right, top);
  const holes = [almond(-1, 0.013, 0.002).all, almond(1, 0.013, 0.002).all, scaleAbout(lipsOuter, 0, 0.292, 0.975, 0.93)];
  add('Face', rings([outline].concat(holes)), { color: C.skin, angle: 20 });

  /* shading, sewn open so the skin shows through */
  const so = [], si = [];
  for (let y = -0.02; y <= 0.461; y += 0.02) so.push([hw(y) - 0.004, y]);
  for (let y = 0.46; y >= -0.021; y -= 0.02) si.push([Math.max(0.06, hw(y) - (0.030 + 0.110 * Math.sin(Math.PI * (y + 0.02) / 0.48))), y]);
  add('Shade far cheek', poly(so.concat(si)), { color: C.shade, angle: 110, spacing: 0.8 });
  add('Shade nose', poly(smooth([[0.030, -0.105], [0.062, -0.10], [0.078, 0.0], [0.100, 0.072], [0.086, 0.104], [0.050, 0.084], [0.036, 0.0], [0.030, -0.105]], 5)), { color: C.shade, angle: 100, spacing: 0.7 });
  add('Shade under the nose', ell(0.004, 0.132, 0.066, 0.017), { color: C.shade, angle: 0, spacing: 0.9 });
  add('Shade under the lip', ell(0, 0.412, 0.082, 0.019), { color: C.shade, angle: 0, spacing: 0.6 });

  add('Blush left', ell(-0.275, 0.095, 0.075, 0.045), { color: C.blush, angle: 60, spacing: 0.95 });
  add('Blush right', ell(0.262, 0.095, 0.068, 0.043), { color: C.blush, angle: 60, spacing: 0.95 });

  add('Light forehead', ell(-0.10, -0.375, 0.170, 0.058), { color: C.light, angle: 150, spacing: 0.9 });
  add('Light cheekbone', ell(-0.285, -0.005, 0.062, 0.030), { color: C.light, angle: 150, spacing: 0.9 });
  add('Light chin', ell(-0.02, 0.447, 0.060, 0.026), { color: C.light, angle: 150, spacing: 0.9 });
  add('Light nose ridge', stroke([[-0.012, -0.10], [-0.013, -0.03], [-0.012, 0.045]]), { color: C.light, paint: 'line', lineType: 'satin', lineWidth: 1.3, spacing: 0.5 });
  add('Light nose tip', ell(-0.012, 0.066, 0.026, 0.022), { color: C.light, angle: 150, spacing: 0.8 });

  /* drawn lines that give the face its form */
  const L = { color: C.line, paint: 'line', lineType: 'bean', stitchLen: 1.8 };
  const R = { color: C.line, paint: 'line', lineType: 'running', stitchLen: 1.6 };
  add('Jaw', stroke(range(-0.36, 0.36, 40).map(x => [x, chinY(x) - 0.006])), L);
  add('Nose', stroke(smooth([[0.070, 0.040], [0.097, 0.078], [0.086, 0.113], [0.046, 0.121], [0.0, 0.129], [-0.046, 0.121], [-0.086, 0.113], [-0.097, 0.078], [-0.070, 0.040]], 6)), L);
  for (const side of [-1, 1]) {
    const nm = side < 0 ? 'left' : 'right';
    add('Smile line ' + nm, stroke(range(0, 1, 16).map(t => [side * (0.100 + 0.150 * Math.pow(Math.sin(t * Math.PI / 2), 1.25)), 0.088 + t * 0.212])), L);
    add('Dimple ' + nm, stroke(smooth([[side * 0.232, 0.205], [side * 0.243, 0.235], [side * 0.236, 0.268]])), R);
    add('Eyelid crease ' + nm, stroke(range(-0.95, 0.95, 16).map(t => [side * EXC + EW * t, lidUp(side, side * EXC + EW * t) - 0.027])), R);
    add('Lower lid ' + nm, stroke(range(-0.88, 0.88, 14).map(t => [side * EXC + EW * t, lidLo(side, side * EXC + EW * t) + 0.007])), R);
    add('Under-eye fold ' + nm, stroke(smooth([[side * 0.115, -0.085], [side * 0.19, -0.066], [side * 0.275, -0.082]])), R);
    add('Laugh line ' + nm + ' 1', stroke([[side * 0.305, -0.150], [side * 0.345, -0.162]]), R);
    add('Laugh line ' + nm + ' 2', stroke([[side * 0.307, -0.128], [side * 0.350, -0.122]]), R);
    add('Ear fold ' + nm, stroke(smooth([[side * 0.500, -0.150], [side * 0.528, -0.085], [side * 0.520, -0.005], [side * 0.498, 0.045]])), L);
    add('Ear inner ' + nm, stroke(smooth([[side * 0.494, -0.095], [side * 0.508, -0.055], [side * 0.494, -0.015]])), R);
  }
  add('Philtrum', stroke([[-0.016, 0.150], [-0.018, 0.205]]), R);
  add('Philtrum right', stroke([[0.016, 0.150], [0.018, 0.205]]), R);
  add('Chin crease', stroke(smooth([[-0.06, 0.388], [0, 0.398], [0.06, 0.388]])), R);
}

/* ================= hair ================= */
const hl = x => -0.505 - 0.060 * g(Math.abs(x) - 0.285, 0.085) + 0.035 * x - 0.035 * g(x - 0.06, 0.16) + 0.006 * Math.sin(x * 60);
const burn = y => hw(y) - 0.046 * sm(-0.04, -0.24, y);
let hairPoly;
{
  const o = [];
  range(Math.PI - 0.094, 2 * Math.PI + 0.094, 90).forEach(t => { const w = 1 + 0.012 * Math.sin(t * 17) + 0.008 * Math.sin(t * 41 + 1); o.push([0.01 + 0.512 * w * Math.cos(t), -0.235 + 0.690 * w * Math.sin(t)]); });
  range(-0.15, -0.035, 6).forEach(y => o.push([hw(y) + 0.014, y]));          /* right sideburn, outside */
  range(-0.035, -0.40, 16).forEach(y => o.push([burn(y), y]));               /* inside, up to the temple */
  range(0.40, -0.40, 60).forEach(x => o.push([x, hl(x)]));                   /* hairline */
  range(-0.40, -0.035, 16).forEach(y => o.push([-burn(y), y]));
  range(-0.035, -0.15, 6).forEach(y => o.push([-(hw(y) + 0.014), y]));
  hairPoly = o;
  add('Hair', poly(o), { color: C.hair, angle: 62 });
  /* volume: a lighter band where the light lands, a darker one on the far side, both sewn open */
  const band = (t0, t1, in0, in1) => range(t0, t1, 22).map(t => [0.01 + (0.512 - in0) * Math.cos(t), -0.235 + (0.690 - in0) * Math.sin(t)]).concat(range(t1, t0, 22).map(t => [0.01 + (0.512 - in1) * Math.cos(t), -0.235 + (0.690 - in1) * Math.sin(t)]));
  add('Hair sheen', poly(band(Math.PI * 1.25, Math.PI * 1.47, 0.070, 0.140)), { color: C.hairLight, angle: 62, spacing: 1.3 });
  add('Hair shade', poly(band(Math.PI * 1.62, Math.PI * 1.79, 0.040, 0.125)), { color: C.hairDark, angle: 62, spacing: 1.3 });

  /* strands: they leave the parting and follow the head */
  const CX = -0.19, CY = -0.66, strands = [];
  const total = 28;
  for (let k = 0; k < total; k++) {
    const phi = (k + 0.5) / total * Math.PI * 2, pts = [];
    for (let r = [0.075, 0.150, 0.105, 0.185][k % 4]; r < 0.9; r += 0.016) {
      const a = phi + 0.55 * r * (Math.cos(phi) > 0 ? 1 : -0.6), p = [CX + r * Math.cos(a), CY + r * Math.sin(a) * 0.93];
      const ahead = [CX + (r + 0.03) * Math.cos(a), CY + (r + 0.03) * Math.sin(a) * 0.93];
      if (!inside(p, o) || !inside(ahead, o)) break;
      pts.push(p);
    }
    if (pts.length >= 6) strands.push({ k, pts });
  }
  /* strands down the sides */
  for (const side of [-1, 1]) for (const inset of [0.022, 0.048]) {
    const pts = [];
    range(Math.PI * 1.5 + side * 0.55, Math.PI * 1.5 + side * 1.52, 26).forEach(t => { const p = [0.01 + (0.512 - inset) * Math.cos(t), -0.235 + (0.690 - inset) * Math.sin(t)]; if (inside(p, o)) pts.push(p); });
    if (pts.length >= 6) strands.push({ k: side < 0 ? (inset < 0.03 ? 1 : 0) : (inset < 0.03 ? 0 : 0), side, pts });
  }
  const dark = strands.filter(s => s.side ? s.side > 0 || s.k === 0 : s.k % 2 === 0), light = strands.filter(s => dark.indexOf(s) < 0);
  dark.forEach((s, i) => add('Hair strand dark ' + (i + 1), stroke(s.pts), { color: C.hairDark, paint: 'line', lineType: 'bean', stitchLen: 2.2 }));
  /* eyebrows in the same thread */
  for (const side of [-1, 1]) {
    const up = [], lo = [];
    range(0.066, 0.318, 22).forEach(bx => { const t = Math.max(0, (bx - 0.07) / 0.245), yb = -0.262 - 0.026 * Math.sin(Math.PI * Math.pow(t, 0.85)) + 0.030 * Math.pow(t, 2.4), th = 0.019 * (1 - 0.70 * Math.pow(t, 1.7)) * Math.pow(sm(0, 0.07, t), 0.4) + 0.0045; up.push([side * bx, yb - th]); lo.unshift([side * bx, yb + th]); });
    add('Eyebrow ' + (side < 0 ? 'left' : 'right'), poly(up.concat(lo)), { color: C.hairDark, angle: side < 0 ? 100 : 80, spacing: 0.4, stitchLen: 2 });
  }
  light.forEach((s, i) => add('Hair strand light ' + (i + 1), stroke(s.pts), { color: C.hairLight, paint: 'line', lineType: 'running', stitchLen: 2.2 }));
}

/* ================= mouth ================= */
add('Lips', rings([lipsOuter, scaleAbout(opening, 0, 0.292, 0.975, 0.88)]), { color: C.lip, angle: 90, stitchLen: 2, spacing: 0.5 });
add('Lip shine', stroke(range(-0.075, 0.035, 8).map(x => [x, yLo(x) + 0.021])), { color: C.lipLight, paint: 'line', lineType: 'satin', lineWidth: 1.2, spacing: 0.5 });
const TE = MX * 0.77, tEdge = x => Math.min(yUp(x) + 0.049 * Math.pow(Math.max(0, 1 - (x / MX) * (x / MX)), 0.55), yLo(x) - 0.007);
const teeth = range(-TE, TE, 28).map(x => [x, yUp(x) + 0.002]).concat(range(TE, -TE, 28).map(x => [x, tEdge(x)]));
add('Mouth', rings([opening, scaleAbout(teeth, 0, 0.283, 0.93, 0.72)]), { color: C.mouth, angle: 0, stitchLen: 2, spacing: 0.5 });
add('Teeth', poly(teeth), { color: C.white, angle: 90, stitchLen: 2, spacing: 0.5 });
/* eye whites share the thread with the teeth */
const eyes = [-1, 1].map(side => {
  const al = almond(side, -0.007, 0), ix = side * EXC + 0.004, iy = EY - 0.008, r = 0.040, iris = [];
  range(0, Math.PI * 2, 40).slice(0, -1).forEach(t => { const x = ix + r * Math.cos(t); let y = iy + r * Math.sin(t); y = Math.max(lidUp(side, x) + 0.004, Math.min(lidLo(side, x) - 0.003, y)); iris.push([x, y]); });
  return { side, al, ix, iy, iris };
});
eyes.forEach(e => add('Eye white ' + (e.side < 0 ? 'left' : 'right'), rings([e.al.all, scaleAbout(e.iris, e.ix, e.iy, 0.88)]), { color: C.white, angle: 0, stitchLen: 2, spacing: 0.7 }));
{
  const pts = [[-TE + 0.004, yUp(-TE) + 0.005]];
  for (let k = -4; k <= 4; k++) { const x = k * 0.0335; if (Math.abs(x) > TE - 0.012) continue; pts.push([x, yUp(x) + 0.005], [x, tEdge(x) - 0.004], [x, yUp(x) + 0.005]); }
  pts.push([TE - 0.004, yUp(TE) + 0.005]);
  add('Tooth lines', stroke(pts), { color: C.tooth, paint: 'line', lineType: 'running', stitchLen: 1.2 });
}

/* ================= eyes ================= */
eyes.forEach(e => add('Iris ' + (e.side < 0 ? 'left' : 'right'), rings([e.iris, range(0, Math.PI * 2, 16).slice(0, -1).map(t => [e.ix + 0.0115 * Math.cos(t), e.iy + 0.002 + 0.0115 * Math.sin(t)])]), { color: C.iris, angle: 90, stitchLen: 1.5, spacing: 0.7 }));
eyes.forEach(e => { const nm = e.side < 0 ? 'left' : 'right';
  add('Pupil ' + nm, ell(e.ix, e.iy + 0.002, 0.0170, 0.0170), { color: C.ink, angle: 0, stitchLen: 1.5, spacing: 0.5 });
  add('Lash line ' + nm, stroke(range(-1.04, 1.04, 22).map(t => [e.side * EXC + EW * t, lidUp(e.side, e.side * EXC + EW * Math.max(-1, Math.min(1, t))) - 0.004])), { color: C.ink, paint: 'line', lineType: 'satin', lineWidth: 1.2, spacing: 0.5 });
});
add('Nostril left', ell(-0.041, 0.112, 0.026, 0.012), { color: C.ink, angle: 0, stitchLen: 1.5 });
add('Nostril right', ell(0.041, 0.112, 0.026, 0.012), { color: C.ink, angle: 0, stitchLen: 1.5 });
add('Mouth corner left', stroke([[-MX - 0.016, 0.234], [-MX + 0.004, 0.242]]), { color: C.ink, paint: 'line', lineType: 'running', stitchLen: 1.2 });
add('Mouth corner right', stroke([[MX + 0.016, 0.234], [MX - 0.004, 0.242]]), { color: C.ink, paint: 'line', lineType: 'running', stitchLen: 1.2 });
eyes.forEach(e => add('Eye sparkle ' + (e.side < 0 ? 'left' : 'right'), stroke([[e.ix - 0.027, e.iy - 0.008], [e.ix - 0.009, e.iy - 0.021]]), { color: '#FFFFFF', paint: 'line', lineType: 'bean', stitchLen: 1 }));

d.save();
