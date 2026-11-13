'use strict';
/*
 * Helpers for the scripts in this folder that build the starter designs (designs/*.embroidr).
 * A design is drawn in its own units with 0,0 at its centre, x to the right, y DOWN; `scale` turns one
 * unit into millimetres and the result is placed in the middle of the hoop.
 *
 *   const L = require('./lib.js');
 *   const d = L.design('name', { hoop: { w: 130, h: 180 }, scale: 50, origin: [0, 0] });
 *   d.add('Petal', d.poly(points), { color: '#cc3355', angle: 30 });
 *   d.add('Stem', d.stroke(points), { color: '#2f6b3a', paint: 'line', lineType: 'satin', lineWidth: 2 });
 *   d.save();                      // writes designs/name.embroidr and prints what it holds
 *
 * Shapes:  d.poly(pts)                 closed outline, filled
 *          d.rings([outer, hole...])   shape with holes (even-odd)
 *          d.ell(cx, cy, rx, ry)       ellipse
 *          d.stroke(pts)               open line (use paint: 'line')
 * Style:   color '#rrggbb', paint 'fill' | 'line' | 'both', angle (fill rows, degrees), spacing (mm between
 *          rows, 0.4 = solid, 0.8+ = open shading), stitchLen (mm), pattern ('smooth' | 'brick' | 'ribbed' |
 *          'diagonal' | 'crosshatch'), lineType ('running' | 'bean' | 'satin'), lineWidth (satin, mm, 1..12)
 * Order:   shapes are sewn in the order they are added; later ones lie on top.
 */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

const range = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => a + (b - a) * i / n);
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const g = (d, s) => Math.exp(-(d / s) * (d / s));
const lerp = (a, b, t) => a + (b - a) * t;
const scaleAbout = (pts, cx, cy, kx, ky) => pts.map(p => [cx + (p[0] - cx) * kx, cy + (p[1] - cy) * (ky === undefined ? kx : ky)]);
const rotate = (pts, deg, cx, cy) => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); cx = cx || 0; cy = cy || 0; return pts.map(p => [cx + (p[0] - cx) * c - (p[1] - cy) * s, cy + (p[0] - cx) * s + (p[1] - cy) * c]); };
const move = (pts, dx, dy) => pts.map(p => [p[0] + dx, p[1] + dy]);
const mirror = pts => pts.map(p => [-p[0], p[1]]).reverse();
/* points on an ellipse arc, angles in radians, 0 = right, PI/2 = down */
const arc = (cx, cy, rx, ry, a0, a1, n) => range(a0, a1, n || 24).map(t => [cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
/* a smooth curve through the points (Catmull-Rom); closed = true joins the ends smoothly */
function smooth(pts, per, closed) {
  per = per || 8; const n = pts.length, o = [];
  const at = i => closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      o.push([0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
              0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)]);
    }
  }
  if (!closed) o.push(pts[n - 1]);
  return o;
}
function inside(pt, pg) { let c = false; for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) { const a = pg[i], b = pg[j]; if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
/* a petal / leaf / wing shape from base to tip: width = widest half-width, bulge 0..1 = where it is widest */
function leaf(bx, by, tx, ty, width, bulge, n) {
  n = n || 14; bulge = bulge === undefined ? 0.5 : bulge;
  const dx = tx - bx, dy = ty - by, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len, nx = -uy, ny = ux, a = [], b = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, k = t < bulge ? Math.sin(t / bulge * Math.PI / 2) : Math.cos((t - bulge) / (1 - bulge) * Math.PI / 2), w = width * Math.pow(Math.max(0, k), 0.85);
    a.push([bx + dx * t + nx * w, by + dy * t + ny * w]); b.unshift([bx + dx * t - nx * w, by + dy * t - ny * w]);
  }
  return a.concat(b.slice(1, -1));
}

function design(name, opt) {
  opt = opt || {};
  const hoop = opt.hoop || { w: 130, h: 180 }, SC = opt.scale || 1, o = opt.origin || [0, 0];
  const OX = hoop.w / 2 + o[0], OY = hoop.h / 2 + o[1];
  const P = p => [Math.round((OX + SC * p[0]) * 100) / 100, Math.round((OY + SC * p[1]) * 100) / 100];
  const objects = []; let n = 0;
  const d = {
    name, hoop, objects,
    poly: pts => ({ type: 'polygon', pts: pts.map(P) }),
    rings: (list, rule) => ({ type: 'path', rings: list.map(r => r.map(P)), fillRule: rule || 'evenodd' }),
    ell: (cx, cy, rx, ry) => { const c = P([cx, cy]); return { type: 'ellipse', cx: c[0], cy: c[1], rx: +(rx * SC).toFixed(2), ry: +(ry * SC).toFixed(2) }; },
    stroke: pts => ({ type: 'pen', pts: pts.map(P), closed: false }),
    add(label, geom, style) {
      const base = { paint: 'fill', lineType: 'running', lineWidth: 2, spacing: 0.4, stitchLen: 3, angle: 0, pattern: 'smooth' };
      const open = geom.type === 'pen' && !geom.closed;
      objects.push(Object.assign({ id: 'p' + (++n), name: String(label).slice(0, 60) }, geom, base, open ? { paint: 'line' } : null, style));
      return d;
    },
    file() { return { v: 1, app: 'embroidr', savedAt: 0, doc: { name, hoop: { w: hoop.w, h: hoop.h }, objects, defaults: { color: opt.defaultColor || '#3157e0', paint: 'fill', lineType: 'running', lineWidth: 3, spacing: 0.4, stitchLen: 3, angle: 0, pattern: 'smooth' } }, view: { fabric: { mode: opt.fabric || 'light', color: opt.fabricColor || '#c9b99a' } } }; },
    save(file) {
      file = file || path.join(ROOT, 'designs', name + '.embroidr');
      fs.writeFileSync(file, JSON.stringify(d.file()));
      const r = check(d.file().doc);
      console.log(name + ': ' + objects.length + ' shapes, ' + new Set(objects.map(x => x.color.toLowerCase())).size + ' colours, ' + r.summary);
      r.problems.forEach(p => console.log('  ' + p));
      return r;
    }
  };
  return d;
}

/* What the editor would make of a design: stitches, size, and anything it would warn about. */
function toEngine(doc) {
  const closed = o => o.type === 'rect' || o.type === 'ellipse' || o.type === 'polygon' || o.type === 'path' || (o.type === 'pen' && !!o.closed);
  return { name: doc.name, hoop: { width: doc.hoop.w, height: doc.hoop.h }, objects: doc.objects.map(o => {
    const e = { id: o.id, color: o.color, paint: closed(o) ? o.paint : 'line', fill: { spacing: o.spacing, stitchLength: o.stitchLen, angle: o.angle, pattern: o.pattern || 'smooth' }, line: { type: o.lineType, stitchLength: o.stitchLen, width: o.lineWidth, spacing: o.spacing } };
    switch (o.type) {
      case 'rect': e.type = 'rect'; e.x = o.x; e.y = o.y; e.width = o.w; e.height = o.h; break;
      case 'ellipse': e.type = 'ellipse'; e.cx = o.cx; e.cy = o.cy; e.rx = o.rx; e.ry = o.ry; break;
      case 'line': e.type = 'line'; e.x1 = o.x1; e.y1 = o.y1; e.x2 = o.x2; e.y2 = o.y2; break;
      case 'polygon': e.type = 'polygon'; e.points = o.pts; break;
      case 'path': e.type = 'path'; e.rings = o.rings; e.fillRule = o.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'; break;
      default: e.type = 'polyline'; e.points = o.pts; e.closed = !!o.closed;
    }
    return e;
  }) };
}
function check(doc) {
  const Engine = require(path.join(ROOT, 'js', 'engine', 'engine.js'));
  const r = Engine.generate(toEngine(doc)), names = {}; doc.objects.forEach(o => { names[o.id] = o.name; });
  const b = r.bounds || { width: 0, height: 0 }, t = r.totals || {};
  const problems = (r.warnings || []).filter(w => w.code !== 'COLORS_MERGED' && w.code !== 'COLOR_SUBSTITUTED' && w.code !== 'THIN_FILL').map(w =>
    w.code + (w.objectId ? ' [' + (names[w.objectId] || w.objectId) + ']' : '') + (w.at ? ' at ' + w.at.x.toFixed(1) + ', ' + w.at.y.toFixed(1) + ' mm (density ' + w.densityMmPerMm2 + ', limit 8)' : '') + ': ' + String(w.message).slice(0, 110));
  return { result: r, problems, canExport: !!r.canExport,
    summary: (t.stitches || 0) + ' stitches, ' + b.width.toFixed(1) + ' x ' + b.height.toFixed(1) + ' mm, ' + (t.colors || 0) + ' thread stops, about ' + (t.timeMin || 0) + ' min, ' + (r.canExport ? 'exportable' : 'NOT exportable') + ', ' + problems.length + ' warning' + (problems.length === 1 ? '' : 's') };
}

module.exports = { ROOT, design, check, toEngine, range, sm, g, lerp, scaleAbout, rotate, move, mirror, arc, smooth, inside, leaf };
