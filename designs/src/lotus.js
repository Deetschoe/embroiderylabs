'use strict';
/* Starter design: a lotus in bloom seen from the side, on two lily pads over still water.
   Units are millimetres, 0,0 near the middle, y down.
   Everything that overlaps is trimmed against what lies in front of it (a fine raster traced back into
   outlines), so petals and pads never pile up: each spot carries one fill plus a thin 0.7 mm underlap. */
const L = require('./lib.js');
const { range, smooth, inside, arc } = L;
const d = L.design('lotus', { hoop: { w: 130, h: 180 }, scale: 0.92, origin: [0, -2.5] });
const deg = r => r * 180 / Math.PI;

const C = {
  deep: '#C2346E', rose: '#E06A9A', light: '#F3A9C6', pale: '#FCE3EC', line: '#9C2052',
  yellow: '#F6C731', gold: '#E39A1E',
  pad: '#4F8A3B', padLight: '#7DB356', padDark: '#2E5C2A',
  water: '#7DB6D8', waterDeep: '#4D8DB8',
};

/* ---------------- geometry helpers ---------------- */
function bez(a, c, b, n) { return range(0, 1, n).map(t => [(1 - t) * (1 - t) * a[0] + 2 * t * (1 - t) * c[0] + t * t * b[0], (1 - t) * (1 - t) * a[1] + 2 * t * (1 - t) * c[1] + t * t * b[1]]); }
function blade(spine, w) {
  const n = spine.length - 1, a = [], b = [], nrm = [];
  for (let i = 0; i <= n; i++) {
    const p = spine[i], q = spine[Math.min(n, i + 1)], o = spine[Math.max(0, i - 1)], dx = q[0] - o[0], dy = q[1] - o[1], len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, t = i / n;
    nrm.push([nx, ny]); a.push([p[0] + nx * w(t), p[1] + ny * w(t)]); b.push([p[0] - nx * w(t), p[1] - ny * w(t)]);
  }
  return { outline: a.concat(b.slice().reverse()), spine, nrm };
}
function segDist(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1; let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); }
function edgeDist(p, pg) { let m = 1e9; for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) m = Math.min(m, segDist(p, pg[j], pg[i])); return m; }
function bboxOf(pg) { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; pg.forEach(p => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }); return [x0, y0, x1, y1]; }
const circ = (cx, cy, rx, ry, n) => arc(cx, cy, rx, ry, 0, Math.PI * 2, n || 64).slice(0, -1);

/* raster a test function over a box and trace the outline(s) back (marching squares, then smoothed) */
const RES = 0.2;
function trace(test, box) {
  const x0 = box[0] - 2 * RES, y0 = box[1] - 2 * RES, nx = Math.ceil((box[2] - x0) / RES) + 3, ny = Math.ceil((box[3] - y0) / RES) + 3;
  const v = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (i > 0 && j > 0 && i < nx - 1 && j < ny - 1) v[j * nx + i] = test([x0 + i * RES, y0 + j * RES]) ? 1 : 0;
  const at = (i, j) => v[j * nx + i], adj = new Map(), pos = new Map();
  const key = (h, i, j) => h + i + ',' + j;
  const link = (a, b) => { (adj.get(a) || adj.set(a, []).get(a)).push(b); (adj.get(b) || adj.set(b, []).get(b)).push(a); };
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const A = at(i, j), B = at(i + 1, j), Cc = at(i + 1, j + 1), D = at(i, j + 1);
    if (A === B && B === Cc && Cc === D) continue;
    const T = key('h', i, j), R = key('v', i + 1, j), Bo = key('h', i, j + 1), Le = key('v', i, j);
    pos.set(T, [x0 + (i + 0.5) * RES, y0 + j * RES]); pos.set(Bo, [x0 + (i + 0.5) * RES, y0 + (j + 1) * RES]);
    pos.set(Le, [x0 + i * RES, y0 + (j + 0.5) * RES]); pos.set(R, [x0 + (i + 1) * RES, y0 + (j + 0.5) * RES]);
    const e = []; if (A !== B) e.push(T); if (B !== Cc) e.push(R); if (D !== Cc) e.push(Bo); if (A !== D) e.push(Le);
    if (e.length === 2) link(e[0], e[1]);
    else if (A) { link(T, Le); link(R, Bo); } else { link(T, R); link(Bo, Le); }
  }
  const seen = new Set(), loops = [];
  for (const k of adj.keys()) {
    if (seen.has(k)) continue;
    const loop = []; let cur = k, prev = null;
    while (cur && !seen.has(cur)) { seen.add(cur); loop.push(pos.get(cur)); const nb = adj.get(cur); const nxt = nb[0] !== prev ? nb[0] : nb[1]; prev = cur; cur = nxt; }
    if (loop.length > 8) loops.push(loop);
  }
  return loops.map(lp => {
    let p = lp;
    for (let s = 0; s < 3; s++) p = p.map((q, i) => { const a = p[(i - 1 + p.length) % p.length], b = p[(i + 1) % p.length]; return [(a[0] + 2 * q[0] + b[0]) / 4, (a[1] + 2 * q[1] + b[1]) / 4]; });
    const out = [p[0]]; p.forEach(q => { const l = out[out.length - 1]; if (Math.hypot(q[0] - l[0], q[1] - l[1]) >= 0.5) out.push(q); });
    return out;
  }).filter(lp => Math.abs(area(lp)) > 2.5);
}
function area(pg) { let s = 0; for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) s += pg[j][0] * pg[i][1] - pg[i][0] * pg[j][1]; return s / 2; }

/* ---------------- the scene, back to front ---------------- */
/* each solid: { name, poly, test? } ; anything later in the list covers anything earlier */
const solids = [];
const OV = 0.5;           /* how far a shape runs on under the one in front */

/* petals: base, tip, sideways bend, widest half-width */
function petal(name, base, tip, bend, W, bulge, tones) {
  const mx = (base[0] + tip[0]) / 2, my = (base[1] + tip[1]) / 2, dx = tip[0] - base[0], dy = tip[1] - base[1], len = Math.hypot(dx, dy);
  const spine = bez(base, [mx - dy / len * bend, my + dx / len * bend], tip, 40);
  const w = t => { const s = t < bulge ? Math.sin(t / bulge * Math.PI / 2) : Math.cos((t - bulge) / (1 - bulge) * Math.PI / 2); return W * Math.pow(Math.max(0, s), t < bulge ? 0.55 : 1.15) + (t < 0.05 ? 0 : 0); };
  const bl = blade(spine, w);
  return { name, kind: 'petal', poly: bl.outline, spine, w, W, tones, len };
}
/* where along the petal (0 base .. 1 tip) a point sits, bent so the colour bands follow the tip's curve */
function along(pt, pe) {
  let best = 1e9, bi = 0; pe.spine.forEach((q, i) => { const dd = Math.hypot(pt[0] - q[0], pt[1] - q[1]); if (dd < best) { best = dd; bi = i; } });
  const t = bi / (pe.spine.length - 1), lat = best / pe.W;
  return t + 0.22 * lat * lat;
}

/* ---- the water and pads */
const PAD1 = { cx: -2, cy: 31, rx: 49, ry: 11.5 };
const PAD2 = { cx: -33, cy: 40.5, rx: 22, ry: 6.2 };
function padPoly(P, notchAng, notchW) {
  const pts = circ(P.cx, P.cy, P.rx, P.ry, 90).filter(p => { let a = Math.atan2((p[1] - P.cy) / P.ry, (p[0] - P.cx) / P.rx); let dd = Math.abs(((a - notchAng + 3 * Math.PI) % (2 * Math.PI)) - Math.PI); return dd > notchW; });
  /* the notch: a V running into the middle */
  const i = pts.findIndex((p, k) => k > 0 && Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]) > 6);
  const inner = [P.cx + Math.cos(notchAng) * P.rx * 0.1, P.cy + Math.sin(notchAng) * P.ry * 0.1];
  if (i > 0) pts.splice(i, 0, inner);
  return pts;
}
const pad1 = padPoly(PAD1, 1.95, 0.16), pad2 = padPoly(PAD2, 1.2, 0.2);

/* ---- the bud on its stem, upper right */
const budStem = smooth([[45, -21], [47.5, -5], [50, 10], [50.5, 22]], 8);
const bud = [
  petal('Bud back petal', [45, -20], [44.5, -45], 1.5, 6.4, 0.42, [C.deep, C.rose, C.light]),
  petal('Bud left petal', [44.5, -19.5], [39, -40.5], -2.4, 4.7, 0.45, [C.deep, C.rose, C.light]),
  petal('Bud right petal', [45.5, -19.5], [50.5, -39.5], 2.4, 4.7, 0.45, [C.deep, C.rose, C.light]),
];

/* ---- the flower */
const BX = 0, BY = 14;
const T3 = [C.deep, C.rose, C.light, C.pale];
const backC = petal('Back middle petal', [BX, BY], [0, -50], 0, 12.5, 0.45, [C.deep, C.rose, C.light, C.pale]);
const backL = petal('Back left petal', [BX - 1, BY], [-24, -37], -3, 11.5, 0.45, T3);
const backR = petal('Back right petal', [BX + 1, BY], [24, -37], 3, 11.5, 0.45, T3);
const outL = petal('Outer left petal', [BX - 3, BY + 1], [-45, 2], -7, 10, 0.45, T3);
const outR = petal('Outer right petal', [BX + 3, BY + 1], [45, 2], 7, 10, 0.45, T3);
const midL = petal('Left petal', [BX - 2, BY + 1], [-37, -17], -4, 11.5, 0.45, T3);
const midR = petal('Right petal', [BX + 2, BY + 1], [37, -17], 4, 11.5, 0.45, T3);
const frL = petal('Front left petal', [BX - 1, BY + 2], [-23, -26], 2.5, 9.5, 0.45, T3);
const frR = petal('Front right petal', [BX + 1, BY + 2], [23, -26], -2.5, 9.5, 0.45, T3);
const lowC = petal('Front low petal', [BX, BY + 3], [0, -11], 0, 8.5, 0.42, T3);

/* the seed pod, between the back and the front petals */
const pod = smooth([[-9, -19.5], [-4.5, -22.2], [4.5, -22.2], [9, -19.5], [7, -11], [0, -7], [-7, -11]], 6, true);

solids.push({ name: 'Water', kind: 'none', poly: [] });
solids.push({ name: 'Bud stem', kind: 'none', poly: [] });
solids.push({ name: 'Big lily pad', kind: 'pad', poly: pad1, P: PAD1 });
solids.push({ name: 'Small lily pad', kind: 'pad', poly: pad2, P: PAD2 });
bud.forEach(b => solids.push(b));
[backC, backL, backR].forEach(p => solids.push(p));
solids.push({ name: 'Seed pod', kind: 'pod', poly: pod });
[outL, outR, midL, midR, frL, frR, lowC].forEach(p => solids.push(p));
solids.forEach((s, i) => { s.z = i; if (s.poly.length) s.box = bboxOf(s.poly); });

/* is this point covered (deeper than the underlap) by anything in front of solid z? */
function covered(pt, z, ov) {
  for (let k = z + 1; k < solids.length; k++) {
    const s = solids[k]; if (!s.poly.length) continue; const b = s.box;
    if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) continue;
    if (inside(pt, s.poly) && (ov <= 0 || edgeDist(pt, s.poly) > ov)) return true;
  }
  return false;
}
/* within m of anything in front of z? */
function near(pt, z, m) {
  for (let k = z + 1; k < solids.length; k++) {
    const s = solids[k]; if (!s.poly.length) continue; const b = s.box;
    if (pt[0] < b[0] - m || pt[0] > b[2] + m || pt[1] < b[1] - m || pt[1] > b[3] + m) continue;
    if (inside(pt, s.poly) || edgeDist(pt, s.poly) < m) return true;
  }
  return false;
}
/* a line, cut where something in front of z covers it */
function clipLine(pts, z) {
  const out = []; let cur = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.4));
    for (let k = 0; k < n; k++) { const p = [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]; if (covered(p, z, -1)) { if (cur.length > 1) out.push(cur); cur = []; } else cur.push(p); }
  }
  const last = pts[pts.length - 1]; if (!covered(last, z, -1)) cur.push(last);
  if (cur.length > 1) out.push(cur);
  return out.filter(l => { let s = 0; for (let i = 1; i < l.length; i++) s += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]); return s > 1.5; })
    .map(l => { const o = [l[0]]; l.forEach(q => { const p = o[o.length - 1]; if (Math.hypot(q[0] - p[0], q[1] - p[1]) > 0.8) o.push(q); }); if (o[o.length - 1] !== l[l.length - 1]) o.push(l[l.length - 1]); return o; });
}

/* ---------------- build every sewn piece as a node with a colour and a layer ---------------- */
const items = [];   /* { name, geom, style, z, sub } ; z = layer, sub = order inside the layer */
const put = (name, geom, style, z, sub) => items.push({ name, geom, style, z, sub: sub || 0 });

/* water: a few long ripples below and around the pads */
const waterZ = 0;
{
  const wave = (x0, x1, y, amp, ph) => range(x0, x1, Math.round((x1 - x0) / 1.2)).map(x => [x, y + amp * Math.sin(x / 6.5 + ph)]);
  const lines = [wave(-50, 46, 49.5, 0.7, 0), wave(-36, 30, 53.5, 0.6, 1.4), wave(16, 54, 44.5, 0.6, 2.1), wave(-58, -40, 32, 0.5, 0.4), wave(42, 56, 36, 0.5, 1.0)];
  /* rings where the bud's stem meets the water */
  const ripple = (rx, ry) => arc(50.5, 22.5, rx, ry, 0.1, Math.PI - 0.1, 18);
  lines.push(ripple(4, 1.3), ripple(7.5, 2.3));
  lines.forEach((l, i) => clipLine(l, waterZ).forEach((s, k) => put('Water line ' + (i + 1) + (k ? '.' + k : ''), d.stroke(s), { color: i < 2 ? C.waterDeep : C.water, paint: 'line', lineType: i < 2 ? 'satin' : 'bean', lineWidth: 1.1, spacing: 0.45, stitchLen: 2.2 }, waterZ)));
}
/* bud stem */
clipLine(budStem, 1).forEach((s, k) => put('Bud stem' + (k ? ' ' + k : ''), d.stroke(s), { color: C.pad, paint: 'line', lineType: 'satin', lineWidth: 2.6, spacing: 0.45 }, 1));

/* pads: darker underside rim, lighter top, veins, rim line */
solids.filter(s => s.kind === 'pad').forEach(s => {
  const P = s.P;
  const top = q => { const ex = (q[0] - P.cx) / P.rx, ey = (q[1] - P.cy + P.ry * 0.12) / (P.ry * 0.82); return ex * ex + ey * ey < 1; };
  const vis = q => inside(q, s.poly) && !covered(q, s.z, 0.45);
  const rim = trace(q => vis(q) && !top(q), s.box);
  const topX = q => { const ex = (q[0] - P.cx) / (P.rx + 0.2), ey = (q[1] - P.cy + P.ry * 0.12) / (P.ry * 0.82 + 0.25); return ex * ex + ey * ey < 1; };
  const shn = q => { const ex = (q[0] - P.cx) / (P.rx * 0.62), ey = (q[1] - P.cy + P.ry * 0.42) / (P.ry * 0.36); return ex * ex + ey * ey < 1; };
  const shn2 = q => { const ex = (q[0] - P.cx) / (P.rx * 0.62 + 0.35), ey = (q[1] - P.cy + P.ry * 0.42) / (P.ry * 0.36 + 0.35); return ex * ex + ey * ey < 1; };
  put(s.name + ' edge', d.rings(rim), { color: C.padDark, angle: 80, spacing: 0.45, stitchLen: 2.6 }, s.z, 0);
  put(s.name, d.rings(trace(q => vis(q) && topX(q) && !shn(q), s.box)), { color: C.pad, angle: 18, stitchLen: 3.8, spacing: 0.45 }, s.z, 1);
  /* a lighter sheen across the back half, sewn as its own area */
  const sheen = trace(q => inside(q, s.poly) && !near(q, s.z, 1.2) && top(q) && shn2(q), s.box);
  if (sheen.length) put(s.name + ' sheen', d.rings(sheen), { color: C.padLight, angle: 160, stitchLen: 3.6, spacing: 0.45 }, s.z, 2);
  /* a light edge along the far rim */
  const far = arc(P.cx, P.cy - P.ry * 0.12, P.rx - 1.4, P.ry * 0.82 - 1.0, Math.PI * 1.08, Math.PI * 1.92, 40).filter(q => inside(q, s.poly));
  clipLine(far, s.z).forEach((c, k) => put(s.name + ' far rim' + (k ? ' ' + k : ''), d.stroke(c), { color: C.padLight, paint: 'line', lineType: 'running', stitchLen: 2.2 }, s.z, 4));
  /* radial veins from the middle */
  const veins = [];
  const nV = s.kind === 'pad' && P.rx > 30 ? 16 : 9;
  for (let k = 0; k < nV; k++) {
    const a = (k + 0.5) / nV * Math.PI * 2; const end = [P.cx + Math.cos(a) * P.rx * 0.86, P.cy - P.ry * 0.1 + Math.sin(a) * P.ry * 0.78];
    const v = [[P.cx, P.cy - P.ry * 0.1], end].filter(Boolean);
    if (inside([P.cx + Math.cos(a) * P.rx * 0.5, P.cy - P.ry * 0.1 + Math.sin(a) * P.ry * 0.4], s.poly)) veins.push(v);
  }
  /* out along one line, back along a slightly turned one, so no stretch is sewn twice */
  const chain = []; veins.forEach(v => { const c = [P.cx, P.cy - P.ry * 0.1], e = v[1], rot = 0.05, ex = e[0] - c[0], ey = (e[1] - c[1]) / P.ry * P.rx, rx = ex * Math.cos(rot) - ey * Math.sin(rot), ry = ex * Math.sin(rot) + ey * Math.cos(rot); chain.push(c, e, [c[0] + rx * 0.92, c[1] + ry * 0.92 / P.rx * P.ry], c); });
  clipLine(chain, s.z).forEach((c, k) => put(s.name + ' veins' + (k ? ' ' + k : ''), d.stroke(c), { color: C.padDark, paint: 'line', lineType: 'running', stitchLen: 2.2 }, s.z, 3));
});

/* petals: colour bands from the base to the tip, trimmed against everything in front */
function petalPieces(pe) {
  const tones = pe.tones, nb = tones.length, cuts = nb === 4 ? [0, 0.3, 0.55, 0.78, 9] : [0, 0.38, 0.7, 9];
  const vis = q => inside(q, pe.poly) && !covered(q, pe.z, /^Bud/.test(pe.name) ? 0.4 : OV);
  const dir = deg(Math.atan2(pe.spine[36][1] - pe.spine[4][1], pe.spine[36][0] - pe.spine[4][0]));
  for (let b = 0; b < nb; b++) {
    const lo = b === 0 ? -9 : cuts[b] - 0.4 / pe.len, hi = cuts[b + 1];
    const rg = trace(q => { if (!vis(q)) return false; const t = along(q, pe); return t >= lo && t < hi; }, pe.box);
    if (rg.length) put(pe.name + ' ' + ['base', 'middle', 'upper', 'tip'][b + (nb === 3 ? (b === 2 ? 1 : 0) : 0)], d.rings(rg), { color: tones[b], angle: dir + (b % 2 ? 12 : -12), stitchLen: 3.6, spacing: 0.5 }, pe.z, b);
  }
  /* veins: three fine lines up the petal, sewn only where the petal shows */
  const vlines = [];
  for (const f of [-0.45, 0, 0.45]) {
    const l = pe.spine.slice(3, 31).map((q, i) => { const t = (i + 3) / 40, n0 = pe.spine[Math.min(40, i + 4)], n1 = pe.spine[i + 2], dx = n0[0] - n1[0], dy = n0[1] - n1[1], ll = Math.hypot(dx, dy) || 1; return [q[0] - dy / ll * pe.w(t) * f, q[1] + dx / ll * pe.w(t) * f]; });
    vlines.push(l);
  }
  const vis0 = q => inside(q, pe.poly) && !covered(q, pe.z, -1);
  vlines.forEach((l, i) => {
    const segs = []; let cur = [];
    l.forEach(q => { if (vis0(q) && edgeDist(q, pe.poly) > 0.8) cur.push(q); else { if (cur.length > 3) segs.push(cur); cur = []; } });
    if (cur.length > 3) segs.push(cur);
    segs.forEach((s, k) => put(pe.name + ' vein ' + (i + 1) + (k ? '.' + k : ''), d.stroke(s), { color: C.deep, paint: 'line', lineType: 'running', stitchLen: 2.2 }, pe.z, 10));
  });
  /* outline of what shows */
  trace(q => inside(q, pe.poly) && !covered(q, pe.z, -0.01), pe.box).forEach((lp, k) => put(pe.name + ' outline' + (k ? ' ' + k : ''), d.stroke(lp.concat([lp[0]])), { color: C.line, paint: 'line', lineType: 'running', stitchLen: 2 }, pe.z, 20));
}
solids.filter(s => s.kind === 'petal').forEach(petalPieces);

/* seed pod: gold body, yellow top, stamens around it */
{
  const s = solids.find(x => x.kind === 'pod');
  const vis = q => inside(q, s.poly) && !covered(q, s.z, OV);
  const topE = q => { const ex = q[0] / 8.6, ey = (q[1] + 20) / 2.9; return ex * ex + ey * ey < 1; };
  put('Seed pod', d.rings(trace(q => vis(q) && !topE(q), s.box)), { color: C.gold, angle: 90, stitchLen: 2.4 }, s.z, 0);
  const seedAt = k => [-5.2 + k * 2.6, -19.3 + Math.abs(-5.2 + k * 2.6) * 0.06];
  const onSeed = (q, r) => [0, 1, 2, 3, 4].some(k => { const c = seedAt(k); return Math.hypot(q[0] - c[0], q[1] - c[1]) < r; });
  put('Seed pod top', d.rings(trace(q => vis(q) && topE(q) , s.box)), { color: C.yellow, angle: 0, spacing: 0.45, stitchLen: 2.2 }, s.z, 1);
  /* stamens: a fringe of short yellow strands rising round the pod */
  const st = [];
  for (let k = 0; k < 15; k++) { const x = -10 + k * 20 / 14, base = [x * 0.75, -16.5 + Math.abs(x) * 0.15], tip = [x * 1.08, -25 + Math.abs(x) * 0.25 - (k % 2) * 1.6]; st.push(base, tip, base); }
  clipLine(st, s.z).forEach((c, k) => put('Stamens' + (k ? ' ' + k : ''), d.stroke(c), { color: C.yellow, paint: 'line', lineType: 'running', stitchLen: 1.5 }, s.z, 5));
  /* the pod's flat top, ringed in gold with a few seed dots sewn as tiny crosses */
  const ringTop = arc(0, -20, 8.0, 2.4, 0, Math.PI * 2, 40);
  clipLine(ringTop, s.z).forEach((c, k) => put('Pod rim' + (k ? ' ' + k : ''), d.stroke(c), { color: C.gold, paint: 'line', lineType: 'running', stitchLen: 1.6 }, s.z, 6));
}

/* ---------------- sewing order: fills back to front, but a later fill only has to wait for the fills it
   actually touches (they underlap by 0.7 mm), so same colours can be sewn together. Lines go on last. */
const isLine = it => it.style.paint === 'line';
items.forEach((it, i) => { it.i = i; it.pts = it.geom.rings ? [].concat(...it.geom.rings) : it.geom.pts; it.box = bboxOf(it.pts); });
function touch(a, b) {
  if (a.box[2] + 1.5 < b.box[0] || b.box[2] + 1.5 < a.box[0] || a.box[3] + 1.5 < b.box[1] || b.box[3] + 1.5 < a.box[1]) return false;
  return a.pts.some(p => b.pts.some(q => Math.abs(p[0] - q[0]) < 1.5 && Math.abs(p[1] - q[1]) < 1.5));
}
const rank = it => it.z * 100 + it.sub;
function sequence(list) {
  const before = new Map(list.map(it => [it.i, list.filter(o => o !== it && rank(o) < rank(it) && touch(o, it))]));
  const done = new Set(), out = []; let colour = null;
  while (out.length < list.length) {
    const ready = list.filter(it => !done.has(it.i) && before.get(it.i).every(o => done.has(o.i))).sort((a, b) => rank(a) - rank(b));
    const pick = ready.find(it => it.style.color === colour) || ready[0];
    done.add(pick.i); out.push(pick); colour = pick.style.color;
  }
  return out;
}
const fills = items.filter(it => !isLine(it)), lines = items.filter(isLine);
/* lines: by colour, outlines and veins of the flower after the pads' */
const order = sequence(fills).concat(sequence(lines.map(l => Object.assign(l, { z: 0, sub: 0 }))));
order.forEach(it => d.add(it.name, it.geom, it.style));

const r = d.save();
const b = r.result.bounds;
if (b) console.log('  bounds x ' + b.minX.toFixed(1) + '..' + b.maxX.toFixed(1) + '  y ' + b.minY.toFixed(1) + '..' + b.maxY.toFixed(1));
