/*
 * Geometry truth for the adversarial suite: an independent rasteriser (0.1 mm cells) for the shapes of
 * js/engine/API.md section 4, exact Euclidean distance transforms, and measurements of stitches against them.
 * Nothing here imports the engine.
 *
 * Shapes are read exactly as API.md words them:
 *   rect      x, y, width, height (negative sizes allowed), rotation clockwise on screen about the centre
 *   ellipse   cx, cy, rx, ry, rotation      circle  cx, cy, r
 *   polygon   points (closed)               polyline closed:true
 *   path      rings; fillRule 'nonzero' (default) or 'evenodd'
 * Ellipses are tested analytically (the true curve, not the engine's polygon).
 */
'use strict';

const RES = 0.1;                    // mm per cell
const pt = p => Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y };

function ringsOf(obj) {
  const t = String(obj.type).toLowerCase();
  if (t === 'rect') {
    const x = Math.min(obj.x, obj.x + obj.width), y = Math.min(obj.y, obj.y + obj.height), w = Math.abs(obj.width), h = Math.abs(obj.height);
    let pts = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    const deg = obj.rotation || 0;
    if (deg) { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), cx = x + w / 2, cy = y + h / 2; pts = pts.map(p => ({ x: cx + (p.x - cx) * c - (p.y - cy) * s, y: cy + (p.x - cx) * s + (p.y - cy) * c })); }
    return { rings: [pts], rule: 'nonzero' };
  }
  if (t === 'polygon') return { rings: [obj.points.map(pt)], rule: obj.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' };
  if (t === 'polyline') return { rings: obj.closed === true ? [obj.points.map(pt)] : [], open: obj.closed === true ? [] : [obj.points.map(pt)], rule: obj.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' };
  if (t === 'path') {
    const rings = [], open = [];
    for (const r of obj.rings) { if (Array.isArray(r)) rings.push(r.map(pt)); else if (r.closed === false) open.push(r.points.map(pt)); else rings.push(r.points.map(pt)); }
    return { rings, open, rule: obj.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' };
  }
  if (t === 'line') return { rings: [], open: [[{ x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 }]], rule: 'nonzero' };
  return null; // ellipse / circle: analytic
}

class Grid {
  // covers [x0, x0 + w*RES) x [y0, y0 + h*RES) in mm; cell (i, j) has its centre at (x0 + (i + .5)RES, y0 + (j + .5)RES)
  constructor(x0, y0, x1, y1) {
    this.x0 = Math.floor(x0 / RES) * RES; this.y0 = Math.floor(y0 / RES) * RES;
    this.w = Math.max(1, Math.ceil((x1 - this.x0) / RES)); this.h = Math.max(1, Math.ceil((y1 - this.y0) / RES));
    this.inside = new Uint8Array(this.w * this.h);
  }
  ix(x) { return Math.floor((x - this.x0) / RES); }
  iy(y) { return Math.floor((y - this.y0) / RES); }
  at(arr, x, y, outside) { const i = this.ix(x), j = this.iy(y); return (i < 0 || j < 0 || i >= this.w || j >= this.h) ? outside : arr[j * this.w + i]; }
  area() { let n = 0; for (let k = 0; k < this.inside.length; k++) n += this.inside[k]; return n * RES * RES; }
}

// rasterise one design object into a grid that covers `box` = { minX, minY, maxX, maxY } (mm)
function rasterise(obj, box) {
  const g = new Grid(box.minX, box.minY, box.maxX, box.maxY), t = String(obj.type).toLowerCase();
  if (t === 'ellipse' || t === 'circle') {
    const rx = Math.abs(obj.rx !== undefined ? obj.rx : obj.r), ry = Math.abs(obj.ry !== undefined ? obj.ry : obj.r);
    const a = -(obj.rotation || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
      const dx = g.x0 + (i + 0.5) * RES - obj.cx, dy = g.y0 + (j + 0.5) * RES - obj.cy, u = dx * c - dy * s, v = dx * s + dy * c;
      if ((u * u) / (rx * rx) + (v * v) / (ry * ry) <= 1) g.inside[j * g.w + i] = 1;
    }
    return g;
  }
  const geo = ringsOf(obj);
  if (!geo) return g;
  const evenodd = geo.rule === 'evenodd', edges = [];
  for (const r of geo.rings) for (let k = 0; k < r.length; k++) { const p = r[k], q = r[(k + 1) % r.length]; if (p.y !== q.y) edges.push(p.x, p.y, q.x, q.y); }
  const xs = [];
  for (let j = 0; j < g.h; j++) {
    const y = g.y0 + (j + 0.5) * RES; xs.length = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const y1 = edges[e + 1], y2 = edges[e + 3];
      if ((y1 <= y) !== (y2 <= y)) xs.push([edges[e] + (y - y1) / (y2 - y1) * (edges[e + 2] - edges[e]), y2 > y1 ? 1 : -1]);
    }
    xs.sort((p, q) => p[0] - q[0]);
    let wind = 0, cnt = 0, k = 0;
    for (let i = 0; i < g.w; i++) {
      const x = g.x0 + (i + 0.5) * RES;
      while (k < xs.length && xs[k][0] <= x) { wind += xs[k][1]; cnt++; k++; }
      if (evenodd ? (cnt & 1) : wind !== 0) g.inside[j * g.w + i] = 1;
    }
  }
  return g;
}

// exact Euclidean distance (in mm) from every cell to the nearest cell where src[k] is truthy (Felzenszwalb)
function distanceTo(src, w, h) {
  const INF = 1e12, n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const out = new Float32Array(w * h), tmp = new Float64Array(w * h);
  const dt = len => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s;
      for (;;) { const p = v[k]; s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); if (s <= z[k] && k > 0) k--; else break; }
      if (s <= z[k]) { v[k] = q; z[k] = -INF; z[k + 1] = INF; } else { k++; v[k] = q; z[k] = s; z[k + 1] = INF; }
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
  };
  for (let i = 0; i < w; i++) { for (let j = 0; j < h; j++) f[j] = src[j * w + i] ? 0 : INF; dt(h); for (let j = 0; j < h; j++) tmp[j * w + i] = d[j]; }
  for (let j = 0; j < h; j++) { for (let i = 0; i < w; i++) f[i] = tmp[j * w + i]; dt(w); for (let i = 0; i < w; i++) out[j * w + i] = Math.sqrt(d[i]) * RES; }
  return out;
}

/*
 * Everything the tests ask about one filled object.
 *   g        Grid with g.inside
 *   segs     Float64Array [x1, y1, x2, y2, ...] sewn segments in mm (needle to needle, thread on the fabric)
 * Returns:
 *   maxOutsideMm     furthest any sampled point of any segment lies from the shape (0 = always inside)
 *   outsideMm(tol)   thread length further than tol from the shape
 *   worst            { x, y, d } of the furthest sample
 *   uncovered(depth, reach) -> { cells, areaMm2, fraction, worstGapMm, at }: interior cells at least `depth`
 *                     from the edge that have no thread within `reach`
 */
function measure(g, segs) {
  const w = g.w, h = g.h;
  const toShape = distanceTo(g.inside, w, h);
  const outsideSrc = new Uint8Array(w * h);
  // a border of "outside" around the grid so depth is finite even for shapes that touch the grid edge
  for (let k = 0; k < outsideSrc.length; k++) outsideSrc[k] = g.inside[k] ? 0 : 1;
  const depth = distanceTo(outsideSrc, w, h);
  const thread = new Uint8Array(w * h), STEP = 0.05;
  let maxOut = 0, worst = null; const samples = [];
  for (let s = 0; s < segs.length; s += 4) {
    const x1 = segs[s], y1 = segs[s + 1], x2 = segs[s + 2], y2 = segs[s + 3], len = Math.hypot(x2 - x1, y2 - y1), n = Math.max(1, Math.ceil(len / STEP));
    for (let k = 0; k <= n; k++) {
      const x = x1 + (x2 - x1) * k / n, y = y1 + (y2 - y1) * k / n, i = g.ix(x), j = g.iy(y);
      let d;
      if (i < 0 || j < 0 || i >= w || j >= h) d = Math.hypot(Math.max(g.x0 - x, 0, x - (g.x0 + w * RES)), Math.max(g.y0 - y, 0, y - (g.y0 + h * RES))) + toShape[Math.min(h - 1, Math.max(0, j)) * w + Math.min(w - 1, Math.max(0, i))];
      else { d = toShape[j * w + i]; thread[j * w + i] = 1; }
      samples.push(d, len / n);
      if (d > maxOut) { maxOut = d; worst = { x: +x.toFixed(2), y: +y.toFixed(2), d: +d.toFixed(2) }; }
    }
  }
  let toThread = null;
  return {
    maxOutsideMm: maxOut, worst,
    outsideMm(tol) { let L = 0; for (let k = 0; k < samples.length; k += 2) if (samples[k] > tol) L += samples[k + 1]; return L; },
    uncovered(minDepth, reach) {
      if (!toThread) toThread = distanceTo(thread, w, h);
      let cells = 0, total = 0, worstGap = 0, at = null;
      for (let k = 0; k < w * h; k++) if (g.inside[k] && depth[k] >= minDepth) {
        total++;
        if (toThread[k] > reach) { cells++; if (toThread[k] > worstGap) { worstGap = toThread[k]; at = { x: +(g.x0 + (k % w + 0.5) * RES).toFixed(2), y: +(g.y0 + (Math.floor(k / w) + 0.5) * RES).toFixed(2) }; } }
      }
      return { cells, areaMm2: cells * RES * RES, fraction: total ? cells / total : 0, worstGapMm: worstGap, at, interiorCells: total };
    },
    depth, toShape,
  };
}

// distance (mm) from point p to the boundary of the shape: 0 on the edge, positive on both sides
function boundaryDistance(m, g, x, y) {
  const i = Math.min(g.w - 1, Math.max(0, g.ix(x))), j = Math.min(g.h - 1, Math.max(0, g.iy(y))), k = j * g.w + i;
  return g.inside[k] ? m.depth[k] : m.toShape[k];
}

module.exports = { RES, Grid, ringsOf, rasterise, distanceTo, measure, boundaryDistance };
