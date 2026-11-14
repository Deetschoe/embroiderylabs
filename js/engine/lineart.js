/*
 * lineart.js - the 'Auto (line art)' fill style: one filled region (traced line art, logos, lettering) sewn
 * the way a digitizer would by hand.
 *
 *   thin lines   -> along the line, picked by its measured width: satin (0.9 mm and up), a narrow ring out
 *                   along one edge and back along the other (0.65-0.9), a triple run spread over the width
 *                   (0.45-0.65), a running stitch along the centre (narrower)
 *   wide areas   -> (wider than `thin`, 2 mm) one running ring just inside the edge, plus the engine's own tatami
 *                   fill inside it
 *   anything the thread would still miss -> a small loop or a tack (residual pass)
 *   sewing order -> one thread per connected black area: the needle travels INSIDE the black from piece to
 *                   piece and the run is planned backwards, so most travel ends up under later stitches.
 *                   Separate black areas start with a trim, so no thread is ever laid across bare fabric.
 *
 * Loads like digitize.js: classic <script> (adds Engine.LineArt; load it BEFORE digitize.js), importScripts in
 * the worker, require in node. Pure functions, no DOM, no randomness, no clock: the same rings always give
 * the same stitches, in node and in a browser.
 *
 *   LineArt.build(rings, rule, opt, helpers) -> { parts: [{ points, kind, trimBefore? }], stats, warnings,
 *                                                 lowerBound, skipped? }
 *     rings    closed rings in mm, [{x, y}] (hoop top-left origin, y down)
 *     rule     'nonzero' | 'evenodd'
 *     opt      { detail, thin, satinMin, beanMin, res, spacing, stitchLen, angleDeg, pullComp, underlay,
 *                staggers, cross, maxStitches }     (see DEF below and API.md, fill.lineart)
 *     helpers  the digitizer (fillShape, runStitch, bean); found by itself when left out
 *   The parts are already in sewing order. A part with trimBefore starts a new thread (a trim before it).
 *   build() keeps the last 8 results (keyed by the rings and the options); buildUncached() does not.
 *   Diagnostics only: opt.timer (a clock function) adds stats.ms per step; opt.debug adds part.src (what each
 *   point belongs to: edge, core, satin, ring, bean, run, residual, tack, travel). Neither changes the stitches.
 *
 * How it works: the region is drawn onto a pixel grid (0.05 mm, coarser for very large designs), cleaned
 * (gaps and holes the thread cannot show are closed, specks dropped), and a distance transform gives the
 * local line width everywhere. Pixels deeper than thin/2 seed the 'wide' part; the rest is 'thin' and is
 * reduced to a one-pixel skeleton, traced into strokes and joined through junctions.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, typeof require === 'function' ? require : null);
  else { root.Engine = root.Engine || {}; root.Engine.LineArt = factory(root, null); }
})(typeof self !== 'undefined' ? self : this, function (root, req) {
  'use strict';

  // Tuning (mm). Public options are detail, thin, satinMin, beanMin and res; the rest is internal.
  const DEF = {
    detail: 'normal', thin: 2.0, satinMin: 0.9, beanMin: 0.45,
    closeGap: 0.2, holeArea: 0.3, minIsland: 0.2,           // clean-up at 'normal' detail (scaled by DETAIL)
    junctionArea: 0.3, junctionDepth: 0.25,                   // small deep blobs where lines cross are not 'wide'
    edge: 0.15, coreLevel: 0.35, edgeLen: 2.0, chordTol: 0.07, // wide part: edge ring and tatami core
    ringMin: 0.65, ringInset: 0.2,                            // 0.65 to satinMin: a narrow ring instead of a triple run
    runLen: 1.3, underlayLen: 1.5, satinStep: 0.2, satinPull: 0.24, satinHalf: [0.5, 1.2], fanDeg: 60,
    widthQ: 0.6,                                              // a line's width: this quantile of its widths along it (a
                                                              // tapering line leans towards the satin its base needs)
    spur: 0.35, minLen: 0.45, dpTol: 0.02, extend: 0.3,
    reach: 0.25, residualLevel: 0.04, tackBelow: 2.5, dropBelow: 0.6, residualPasses: 2,
    travelLen: 2.0, minStitch: 0.3, pad: 1.0,
    minRes: 0.05, maxPx: 6e6, reducedAbove: 0.1,
  };
  const DETAIL = { fine: 0.5, normal: 1, bold: 2 };
  const INF = 1e20;

  // ------------------------------------------------------------------ small helpers
  const D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const r2 = v => Math.round(v * 100) / 100; // output points are rounded to 0.01 mm
  function plen(p) { let L = 0; for (let i = 1; i < p.length; i++) L += D(p[i - 1], p[i]); return L; }
  function quantile(a, q) { const s = Array.from(a).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0; }
  function reversed(a) { const o = new Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[a.length - 1 - i]; return o; }

  function helpersOf(h) {
    if (h && h.fillShape) return h;
    if (root && root.Engine && root.Engine.Digitizer) return root.Engine.Digitizer;
    if (req) return req('./digitize.js');
    throw new Error('lineart.js: the digitizer is not loaded');
  }

  // ------------------------------------------------------------------ raster
  // Scanline fill at pixel centres with per-row edge buckets. mask[j * W + i] = 1 inside.
  function rasterize(rings, x0, y0, res, W, H, rule) {
    const cnt = new Int32Array(H + 1);
    const span = (ay, by) => { const lo = Math.min(ay, by), hi = Math.max(ay, by); return [Math.max(0, Math.ceil(lo - 0.5)), Math.min(H - 1, Math.ceil(hi - 0.5) - 1)]; };
    for (const r of rings) for (let i = 0, n = r.length; i < n; i++) {
      const a = r[i], b = r[(i + 1) % n], ay = (a.y - y0) / res, by = (b.y - y0) / res;
      if (ay === by) continue;
      const s = span(ay, by); for (let j = s[0]; j <= s[1]; j++) cnt[j + 1]++;
    }
    for (let j = 0; j < H; j++) cnt[j + 1] += cnt[j];
    const xs = new Float64Array(cnt[H]), ds = new Int8Array(cnt[H]), at = cnt.slice(0, H);
    for (const r of rings) for (let i = 0, n = r.length; i < n; i++) {
      const a = r[i], b = r[(i + 1) % n], ax = (a.x - x0) / res, ay = (a.y - y0) / res, bx = (b.x - x0) / res, by = (b.y - y0) / res;
      if (ay === by) continue;
      const s = span(ay, by), dir = by > ay ? 1 : -1;
      for (let j = s[0]; j <= s[1]; j++) { const yc = j + 0.5, k = at[j]++; xs[k] = ax + (bx - ax) * (yc - ay) / (by - ay); ds[k] = dir; }
    }
    const m = new Uint8Array(W * H), row = [];
    for (let j = 0; j < H; j++) {
      const s = cnt[j], e = cnt[j + 1]; if (e - s < 2) continue;
      row.length = 0; for (let k = s; k < e; k++) row.push(k);
      row.sort((p, q) => xs[p] - xs[q] || ds[p] - ds[q]);
      let w = 0, start = 0;
      for (let q = 0; q < row.length; q++) {
        const k = row[q], before = w;
        w = rule === 'evenodd' ? w ^ 1 : w + ds[k];
        if (before === 0 && w !== 0) start = xs[k];
        else if (before !== 0 && w === 0) {
          const i0 = Math.max(0, Math.ceil(start - 0.5)), i1 = Math.min(W - 1, Math.ceil(xs[k] - 0.5) - 1), o = j * W;
          for (let i = i0; i <= i1; i++) m[o + i] = 1;
        }
      }
    }
    return m;
  }

  // ------------------------------------------------------------------ exact squared distance transform
  // Felzenszwalb & Huttenlocher. out[i] = squared distance in pixels from i to the nearest pixel with
  // mask[i] === seedVal (INF-ish when there is none).
  function edt1(f, n, d, v, z) {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      // z[0] = -INF is never reached: f is 0 or INF and q - p >= 1, so s > -INF / 2
      let p = v[k], s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
      while (s <= z[k]) { k--; p = v[k]; s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const p = v[k]; d[q] = (q - p) * (q - p) + f[p]; }
  }
  function edt(out, mask, seedVal, W, H, bufs) {
    const f = bufs.f, d = bufs.d, v = bufs.v, z = bufs.z;
    for (let x = 0; x < W; x++) {
      let any = false;
      for (let y = 0, i = x; y < H; y++, i += W) { if (mask[i] === seedVal) { f[y] = 0; any = true; } else f[y] = INF; }
      if (!any) { for (let y = 0, i = x; y < H; y++, i += W) out[i] = INF; continue; }
      edt1(f, H, d, v, z);
      for (let y = 0, i = x; y < H; y++, i += W) out[i] = d[y];
    }
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) f[x] = out[o + x];
      edt1(f, W, d, v, z);
      for (let x = 0; x < W; x++) out[o + x] = d[x];
    }
    return out;
  }

  // The same, truncated: exact for distances up to r pixels, (r + 1)^2 or more beyond. A row pass gives the
  // horizontal distance to the nearest seed (capped), a column pass over 2r + 1 rows finishes it. Cheap for a
  // small r. out and h: Int32Arrays of W * H (h is scratch).
  function edtTrunc(out, mask, seedVal, W, H, r, h) {
    const cap = r + 1, far = cap * cap;
    for (let y = 0; y < H; y++) { // h = squared horizontal distance to the nearest seed in the row, capped
      const o = y * W; let last = -cap;
      for (let x = 0; x < W; x++) { if (mask[o + x] === seedVal) last = x; const d = x - last; h[o + x] = d < cap ? d : cap; }
      last = W + cap;
      for (let x = W - 1; x >= 0; x--) { if (mask[o + x] === seedVal) last = x; const d = last - x, c = h[o + x]; h[o + x] = d < c ? d * d : c * c; }
    }
    // column pass, row by row so memory is read in order: out = min over |dy| <= r of h(y + dy) + dy^2
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) out[o + x] = h[o + x];
      for (let dy = 1; dy <= r; dy++) {
        const dd = dy * dy;
        if (y - dy >= 0) { const q = (y - dy) * W; for (let x = 0; x < W; x++) { const d = h[q + x] + dd; if (d < out[o + x]) out[o + x] = d; } }
        if (y + dy < H) { const q = (y + dy) * W; for (let x = 0; x < W; x++) { const d = h[q + x] + dd; if (d < out[o + x]) out[o + x] = d; } }
      }
      for (let x = 0; x < W; x++) if (out[o + x] > far) out[o + x] = far;
    }
    return out;
  }

  // Pixel offsets within radius r, nearest first: { dx, dy, d2 } in three parallel arrays.
  function ringOffsets(r) {
    const l = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) l.push([dx * dx + dy * dy, dy, dx]);
    l.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    return { dx: Int32Array.from(l, e => e[2]), dy: Int32Array.from(l, e => e[1]), d2: Int32Array.from(l, e => e[0]) };
  }
  // squared distance (pixels) from pixel i to the nearest pixel with mask === val within the offsets' radius,
  // or `far` when there is none. Stops at the first hit, so it is cheap where the answer is small.
  function nearest2(mask, val, i, W, H, off, far) {
    const x = i % W, y = (i - x) / W, n = off.d2.length;
    for (let k = 0; k < n; k++) {
      const xx = x + off.dx[k], yy = y + off.dy[k];
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if (mask[yy * W + xx] === val) return off.d2[k];
    }
    return far;
  }

  // ------------------------------------------------------------------ connected components
  // Labels pixels with mask[i] === val. conn8: 8-connected, else 4. Returns { lab (-1 elsewhere), n, size }.
  function label(mask, val, W, H, conn8, stack) {
    const N = W * H, lab = new Int32Array(N).fill(-1), size = [];
    let n = 0;
    for (let s = 0; s < N; s++) {
      if (mask[s] !== val || lab[s] >= 0) continue;
      let sp = 0, cnt = 0; stack[sp++] = s; lab[s] = n;
      while (sp) {
        const i = stack[--sp], x = i % W; cnt++;
        const l = x > 0, r = x < W - 1, u = i >= W, d = i < N - W;
        let j;
        if (l && mask[j = i - 1] === val && lab[j] < 0) { lab[j] = n; stack[sp++] = j; }
        if (r && mask[j = i + 1] === val && lab[j] < 0) { lab[j] = n; stack[sp++] = j; }
        if (u && mask[j = i - W] === val && lab[j] < 0) { lab[j] = n; stack[sp++] = j; }
        if (d && mask[j = i + W] === val && lab[j] < 0) { lab[j] = n; stack[sp++] = j; }
        if (conn8) {
          if (u && l && mask[j = i - W - 1] === val && lab[j] < 0) { lab[j] = n; stack[sp++] = j; }
          if (u && r && mask[j = i - W + 1] === val && lab[j] < 0) { lab[j] = n; stack[sp++] = j; }
          if (d && l && mask[j = i + W - 1] === val && lab[j] < 0) { lab[j] = n; stack[sp++] = j; }
          if (d && r && mask[j = i + W + 1] === val && lab[j] < 0) { lab[j] = n; stack[sp++] = j; }
        }
      }
      size.push(cnt); n++;
    }
    return { lab, n, size };
  }

  // ------------------------------------------------------------------ marching squares
  // Closed iso-lines of field F (pixel centres) at level v, in pixel coordinates. Every line closes: the grid
  // has a margin and F is negative there. Only the box [bx0, bx1] x [by0, by1] of cells is scanned.
  function isoLoops(F, W, H, v, box) {
    const nb = new Map(), pts = new Map();
    const ep = id => {
      if (pts.has(id)) return;
      const p = id >> 1, py = (p / W) | 0, px = p - py * W, hz = (id & 1) === 0;
      const ax = px, ay = py, bx = hz ? px + 1 : px, by = hz ? py : py + 1;
      const fa = F[ay * W + ax], fb = F[by * W + bx], t = (v - fa) / (fb - fa);
      pts.set(id, [ax + (bx - ax) * t, ay + (by - ay) * t]);
    };
    const link = (a, b) => { ep(a); ep(b); let l = nb.get(a); if (!l) nb.set(a, l = []); l.push(b); l = nb.get(b); if (!l) nb.set(b, l = []); l.push(a); };
    const x0 = Math.max(0, box[0] - 1), x1 = Math.min(W - 2, box[1] + 1), y0 = Math.max(0, box[2] - 1), y1 = Math.min(H - 2, box[3] + 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      const a = F[i] > v, b = F[i + 1] > v, c = F[i + W + 1] > v, d = F[i + W] > v;
      const code = (a ? 8 : 0) | (b ? 4 : 0) | (c ? 2 : 0) | (d ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const T = 2 * i, R = 2 * (i + 1) + 1, B = 2 * (i + W), L = 2 * i + 1;
      switch (code) {
        case 1: case 14: link(L, B); break;
        case 2: case 13: link(B, R); break;
        case 3: case 12: link(L, R); break;
        case 4: case 11: link(T, R); break;
        case 6: case 9: link(T, B); break;
        case 7: case 8: link(L, T); break;
        default: { // saddles 5 and 10: decide by the centre value
          const ctr = (F[i] + F[i + 1] + F[i + W + 1] + F[i + W]) / 4 > v;
          if ((code === 10) === ctr) { link(L, B); link(T, R); } else { link(L, T); link(B, R); }
        }
      }
    }
    const used = new Set(), loops = [];
    for (const start of nb.keys()) {
      if (used.has(start)) continue;
      const loop = []; let prev = -1, cur = start;
      while (cur !== undefined && !used.has(cur)) {
        used.add(cur); loop.push(pts.get(cur));
        const l = nb.get(cur); let nxt;
        for (const n of l) if (n !== prev && !used.has(n)) { nxt = n; break; }
        prev = cur; cur = nxt;
      }
      if (loop.length >= 3) loops.push(loop); // always treated as closed (forced shut)
    }
    return loops;
  }

  // ------------------------------------------------------------------ loops -> stitches
  function smoothLoop(p, it) {
    let q = p;
    for (let k = 0; k < it; k++) { const n = q.length, o = new Array(n); for (let i = 0; i < n; i++) { const a = q[(i - 1 + n) % n], b = q[i], c = q[(i + 1) % n]; o[i] = { x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4 }; } q = o; }
    return q;
  }
  // A closed loop walked with the chord rule: a stitch ends where it would grow past maxLen or bend away from
  // the outline by more than tol. Long stitches on gentle curves, short ones only in tight bends.
  function stitchLoop(loop, maxLen, tol, minLen) {
    const p = loop.length > 8 ? smoothLoop(loop, 2) : loop, n = p.length;
    const o = [p[0]]; let i = 0;
    while (i < n) {
      const a = o[o.length - 1]; let best = i + 1;
      for (let j = i + 1; j <= n; j++) {
        const b = p[j % n], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
        if (L > maxLen) break;
        let ok = true;
        for (let k = i + 1; k < j; k++) { const c = p[k % n]; if (Math.abs((c.x - a.x) * dy - (c.y - a.y) * dx) / (L || 1) > tol) { ok = false; break; } }
        if (!ok) break; best = j;
      }
      if (best >= n) break;
      const b = p[best % n];
      if (D(a, b) >= minLen) o.push(b);
      i = best;
    }
    while (o.length > 2 && D(o[o.length - 1], o[0]) < minLen) o.pop();
    const r = [];
    for (let k = 0; k < o.length; k++) { const a = o[k], b = o[(k + 1) % o.length], m = Math.max(1, Math.ceil(D(a, b) / maxLen)); for (let s = 0; s < m; s++) r.push({ x: a.x + (b.x - a.x) * s / m, y: a.y + (b.y - a.y) * s / m }); }
    return r;
  }

  // ------------------------------------------------------------------ skeleton (Zhang-Suen with active pixel lists)
  // Only pixels whose neighbourhood changed since they were last looked at (by the same sub-iteration) are
  // looked at again, which gives exactly the classic result at a fraction of the work.
  function thinMask(m, W, H) {
    let list = [];
    for (let i = 0; i < m.length; i++) if (m[i]) { const x = i % W, y = (i - x) / W; if (x > 0 && y > 0 && x < W - 1 && y < H - 1) list.push(i); else m[i] = 0; }
    const nbo = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];
    const dirty = new Uint8Array(m.length), todo = [[], []];
    for (const i of list) { let edge = false; for (const o of nbo) if (!m[i + o]) { edge = true; break; } if (edge) { dirty[i] = 3; todo[0].push(i); todo[1].push(i); } }
    const del = [];
    for (let iter = 0; iter < 100000; iter++) {
      let changed = 0;
      for (let sub = 0; sub < 2; sub++) {
        const cur = todo[sub], bit = 1 << sub; todo[sub] = [];
        del.length = 0;
        for (let q = 0; q < cur.length; q++) {
          const i = cur[q]; dirty[i] &= ~bit; if (!m[i]) continue;
          const p2 = m[i - W], p3 = m[i - W + 1], p4 = m[i + 1], p5 = m[i + W + 1], p6 = m[i + W], p7 = m[i + W - 1], p8 = m[i - 1], p9 = m[i - W - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (A !== 1) continue;
          if (sub === 0) { if (p2 * p4 * p6 || p4 * p6 * p8) continue; } else if (p2 * p4 * p8 || p2 * p6 * p8) continue;
          del.push(i);
        }
        for (let q = 0; q < del.length; q++) m[del[q]] = 0;
        for (let q = 0; q < del.length; q++) for (const o of nbo) {
          const j = del[q] + o; if (!m[j]) continue;
          if (!(dirty[j] & 1)) { dirty[j] |= 1; todo[0].push(j); }
          if (!(dirty[j] & 2)) { dirty[j] |= 2; todo[1].push(j); }
        }
        changed += del.length;
      }
      if (!changed) break;
    }
    { const keep = []; for (let q = 0; q < list.length; q++) if (m[list[q]]) keep.push(list[q]); list = keep; }
    // staircase pixels: removable without breaking 8-connectivity
    for (let q = 0; q < list.length; q++) {
      const i = list[q]; if (!m[i]) continue;
      const N = m[i - W], E = m[i + 1], S = m[i + W], Wn = m[i - 1], NE = m[i - W + 1], SE = m[i + W + 1], SW = m[i + W - 1], NW = m[i - W - 1];
      if ((N && E && !S && !Wn && !SW) || (E && S && !N && !Wn && !NW) || (S && Wn && !N && !E && !NE) || (Wn && N && !S && !E && !SE)) m[i] = 0;
    }
    const out = []; for (let q = 0; q < list.length; q++) if (m[list[q]]) out.push(list[q]);
    return out;
  }

  // skeleton pixels -> graph of nodes (pixels with != 2 neighbours, clustered) and edges (pixel chains)
  function traceSkeleton(sk, W, pixels) {
    const nbo = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1], N = sk.length, deg = new Uint8Array(N);
    for (const i of pixels) { let c = 0; for (const o of nbo) c += sk[i + o]; deg[i] = c; }
    const node = new Int32Array(N).fill(-1), nodes = [];
    for (const i of pixels) {
      if (deg[i] === 2 || node[i] >= 0) continue;
      const id = nodes.length, st = [i], mem = []; node[i] = id;
      while (st.length) { const p = st.pop(); mem.push(p); for (const o of nbo) { const q = p + o; if (sk[q] && deg[q] !== 2 && node[q] < 0) { node[q] = id; st.push(q); } } }
      nodes.push({ id, px: mem, ends: [] });
    }
    const seen = new Uint8Array(N), edges = [];
    const walk = (start, first) => {
      const path = [start]; let prev = start, cur = first;
      for (let guard = 0; guard < N; guard++) {
        path.push(cur);
        if (node[cur] >= 0) break;
        seen[cur] = 1;
        let nxt = -1;
        for (const o of nbo) { const q = cur + o; if (q !== prev && sk[q] && !seen[q] && (node[q] < 0 || q !== start || path.length > 3)) { if (node[q] >= 0) { nxt = q; break; } if (nxt < 0) nxt = q; } }
        if (nxt < 0) break;
        prev = cur; cur = nxt;
      }
      return path;
    };
    for (const n of nodes) for (const p of n.px) for (const o of nbo) {
      const q = p + o;
      if (!sk[q] || node[q] >= 0 || seen[q]) continue;
      const path = walk(p, q), b = node[path[path.length - 1]];
      edges.push({ px: path, a: node[path[0]], b: b >= 0 ? b : -1 });
    }
    for (const n of nodes) for (const p of n.px) for (const o of nbo) { const q = p + o; if (sk[q] && node[q] > n.id) edges.push({ px: [p, q], a: n.id, b: node[q] }); }
    for (const i of pixels) { // rings of degree-2 pixels with no node on them
      if (deg[i] !== 2 || seen[i]) continue;
      const path = [i]; seen[i] = 1; let prev = -1, cur = i;
      for (;;) { let nxt = -1; for (const o of nbo) { const q = cur + o; if (q !== prev && sk[q] && !seen[q]) { nxt = q; break; } } if (nxt < 0) break; seen[nxt] = 1; path.push(nxt); prev = cur; cur = nxt; }
      path.push(i);
      edges.push({ px: path, a: -1, b: -1, loop: true });
    }
    return { nodes, edges };
  }

  function smoothPts(p, k) {
    if (p.length < 3) return p.slice();
    const out = [p[0]];
    for (let i = 1; i < p.length - 1; i++) {
      let sx = 0, sy = 0, c = 0; const r = Math.min(k, i, p.length - 1 - i);
      for (let j = -r; j <= r; j++) { sx += p[i + j].x; sy += p[i + j].y; c++; }
      out.push({ x: sx / c, y: sy / c });
    }
    out.push(p[p.length - 1]);
    return out;
  }
  function smoothArr(a, k) { const o = []; for (let i = 0; i < a.length; i++) { let s = 0, c = 0; for (let j = Math.max(0, i - k); j <= Math.min(a.length - 1, i + k); j++) { s += a[j]; c++; } o.push(s / c); } return o; }
  function dpKeep(p, tol) {
    const n = p.length, keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
    const st = [];
    if (n > 2 && D(p[0], p[n - 1]) < 1e-9) { let f = 1, fd = -1; for (let i = 1; i < n - 1; i++) { const d = D(p[i], p[0]); if (d > fd) { fd = d; f = i; } } keep[f] = 1; st.push(0, f, f, n - 1); }
    else st.push(0, n - 1);
    while (st.length) {
      const b = st.pop(), a = st.pop(); let bi = -1, bd = tol;
      const ax = p[a].x, ay = p[a].y, dx = p[b].x - ax, dy = p[b].y - ay, L = Math.hypot(dx, dy) || 1e-9;
      for (let i = a + 1; i < b; i++) { const d = Math.abs((p[i].x - ax) * dy - (p[i].y - ay) * dx) / L; if (d > bd) { bd = d; bi = i; } }
      if (bi >= 0) { keep[bi] = 1; st.push(a, bi, bi, b); }
    }
    return keep;
  }

  // ------------------------------------------------------------------ satin with a width that follows the drawing
  // c: centre points, w: line width at each (mm). A needle point every satinStep, alternating sides. At a sharp
  // bend (> fanDeg) the stitches on the inside of the bend are shortened (0.5 / 0.75) so they do not pile up.
  // onBlack(pt) limits each side: a needle point is pulled in until it is at most satinPull / 2 off the black.
  function satinVar(c, w, o, onBlack) {
    const cum = [0]; for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + D(c[i - 1], c[i]));
    const L = cum[cum.length - 1]; if (!(L > 1e-6)) return [];
    const at = t => { // point and width at arc length t (binary search over the cumulative lengths)
      let lo = 1, hi = c.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < t) lo = mid + 1; else hi = mid; }
      const j = lo, f = cum[j] === cum[j - 1] ? 0 : Math.min(1, Math.max(0, (t - cum[j - 1]) / (cum[j] - cum[j - 1])));
      return { x: c[j - 1].x + (c[j].x - c[j - 1].x) * f, y: c[j - 1].y + (c[j].y - c[j - 1].y) * f, w: w[j - 1] + (w[j] - w[j - 1]) * f };
    };
    const unit = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1; return { x: dx / l, y: dy / l }; };
    const n = Math.max(2, Math.ceil(L / o.satinStep)), out = [], cosFan = Math.cos(o.fanDeg * Math.PI / 180);
    // the widest half-width: satinHalf[1], or wider when `thin` was raised (every line up to `thin` is satin),
    // never past 3.5 (a 7 mm satin stitch)
    const hMax = Math.min(3.5, Math.max(o.satinHalf[1], (o.thin + o.satinPull) / 2));
    let fans = 0;
    for (let k = 0; k <= n; k++) {
      const t = L * k / n, p = at(t), a = at(Math.max(0, t - 0.35)), b = at(Math.min(L, t + 0.35));
      const pa = at(Math.max(0, t - 0.4)), pb = at(Math.min(L, t + 0.4));
      const tg = unit(a, b), s = k % 2 ? -1 : 1;
      let h = Math.min(hMax, Math.max(o.satinHalf[0], (p.w + o.satinPull) / 2));
      const t1 = unit(pa, p), t2 = unit(p, pb);
      if (t > 0.05 && t < L - 0.05 && t1.x * t2.x + t1.y * t2.y < cosFan) {
        const inner = t1.x * t2.y - t1.y * t2.x > 0 ? 1 : -1;
        if (inner === s) h *= (fans++ % 2) ? 0.75 : 0.5;
      }
      const nx = -tg.y * s, ny = tg.x * s, give = o.satinPull / 2;
      while (h > 0.15 && !onBlack({ x: p.x + nx * (h - give), y: p.y + ny * (h - give) })) h -= 0.05;
      out.push({ x: p.x + nx * h, y: p.y + ny * h });
    }
    return out;
  }

  // ------------------------------------------------------------------ the whole build
  function build(ringsIn, rule, optIn, helpers) {
    const Dz = helpersOf(helpers);
    const o = Object.assign({}, DEF, optIn || {});
    const tm = typeof o.timer === 'function' ? o.timer : null, ms = {}; let tLast = tm ? tm() : 0;
    const lap = k => { if (tm) { const t = tm(); ms[k] = Math.round(t - tLast); tLast = t; } };
    const scale = DETAIL[o.detail] || 1;
    const warnings = [], stats = { res: 0, W: 0, H: 0, components: 0, satin: 0, ring: 0, bean: 0, run: 0, edgeLoops: 0, coreRuns: 0, residualLoops: 0, tacks: 0, travelMm: 0, threads: 0, stranded: 0 };
    const empty = skipped => ({ parts: [], stats, warnings, lowerBound: 0, skipped });

    // canonical input: rings rounded to 1e-4 mm
    const rings = [];
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const r of ringsIn) {
      if (!r || r.length < 3) continue;
      const q = r.map(p => ({ x: Math.round(p.x * 1e4) / 1e4, y: Math.round(p.y * 1e4) / 1e4 }));
      for (const p of q) { if (p.x < bx0) bx0 = p.x; if (p.x > bx1) bx1 = p.x; if (p.y < by0) by0 = p.y; if (p.y > by1) by1 = p.y; }
      rings.push(q);
    }
    if (!rings.length) return empty('TOO_SMALL');
    const x0 = bx0 - o.pad, y0 = by0 - o.pad, spanX = bx1 - bx0 + 2 * o.pad, spanY = by1 - by0 + 2 * o.pad;
    let res = Math.max(o.minRes, Math.sqrt(spanX * spanY / o.maxPx));
    if (typeof o.res === 'number' && o.res > res) res = o.res;
    const W = Math.ceil(spanX / res) + 1, H = Math.ceil(spanY / res) + 1, N = W * H;
    stats.res = +res.toFixed(4); stats.W = W; stats.H = H;
    if (res > o.reducedAbove + 1e-9) warnings.push({ code: 'LINEART_REDUCED', extra: { resolutionMm: +res.toFixed(3) } });
    const toMm = (px, py) => ({ x: x0 + (px + 0.5) * res, y: y0 + (py + 0.5) * res });
    const pxOf = p => { const x = Math.floor((p.x - x0) / res), y = Math.floor((p.y - y0) / res); return x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1; };

    const n1 = Math.max(W, H);
    const bufs = { f: new Float64Array(n1), d: new Float64Array(n1), v: new Int32Array(n1), z: new Float64Array(n1 + 1) };
    const stack = new Int32Array(N), A = new Float32Array(N), Bf = new Float32Array(N), AI = new Int32Array(A.buffer); // AI: A seen as integers

    // 1. raster
    let m = rasterize(rings, x0, y0, res, W, H, rule === 'evenodd' ? 'evenodd' : 'nonzero');
    lap('raster');

    // 2. clean-up the thread could not show anyway
    const rc = o.closeGap * scale / 2 / res;
    if (rc >= 0.5) { // close white gaps narrower than closeGap (a morphological closing)
      const rt = Math.ceil(rc), rr = rc * rc;
      edtTrunc(AI, m, 1, W, H, rt, stack);
      const grown = new Uint8Array(N);
      for (let i = 0; i < N; i++) grown[i] = AI[i] <= rr ? 1 : 0;
      edtTrunc(AI, grown, 0, W, H, rt, stack);
      for (let i = 0; i < N; i++) if (!m[i] && grown[i] && AI[i] > rr) m[i] = 1;
    }
    const walk = m.slice(); // where travel may go: the black, but not the holes filled just below
    { // fill enclosed white holes smaller than holeArea
      const maxA = o.holeArea * scale / (res * res), L = label(m, 0, W, H, false, stack), small = new Uint8Array(L.n);
      for (let c = 0; c < L.n; c++) small[c] = L.size[c] <= maxA ? 1 : 0;
      for (let x = 0; x < W; x++) { const a = L.lab[x], b = L.lab[(H - 1) * W + x]; if (a >= 0) small[a] = 0; if (b >= 0) small[b] = 0; }
      for (let y = 0; y < H; y++) { const a = L.lab[y * W], b = L.lab[y * W + W - 1]; if (a >= 0) small[a] = 0; if (b >= 0) small[b] = 0; }
      for (let i = 0; i < N; i++) if (L.lab[i] >= 0 && small[L.lab[i]]) { m[i] = 1; walk[i] = 0; }
    }
    let comp; // black components (8-connected): one thread each, later
    { // drop black specks smaller than minIsland
      const minA = o.minIsland * scale / (res * res); comp = label(m, 1, W, H, true, stack);
      for (let i = 0; i < N; i++) { const c = comp.lab[i]; if (c >= 0 && comp.size[c] < minA) { m[i] = 0; comp.lab[i] = -1; } }
    }
    lap('cleanup');

    // 3. signed field F (mm): depth inside the black, -res/2 outside. Line width at a pixel = 2 F.
    edt(A, m, 0, W, H, bufs);
    const F = new Float32Array(N);
    let anyBlack = false;
    for (let i = 0; i < N; i++) { if (m[i]) { F[i] = (Math.sqrt(A[i]) - 0.5) * res; anyBlack = true; } else F[i] = -0.5 * res; }
    if (!anyBlack) return empty('TOO_SMALL');
    lap('edt');

    // 4. wide / thin split
    const R = o.thin / 2, Rpx = R / res;
    const core = new Uint8Array(N); let anyCore = false;
    for (let i = 0; i < N; i++) if (m[i] && F[i] > R) { core[i] = 1; anyCore = true; }
    const wide = new Uint8Array(N); let box = [W, -1, H, -1];
    if (anyCore) {
      const L = label(core, 1, W, H, true, stack), maxF = new Float32Array(L.n);
      for (let i = 0; i < N; i++) if (L.lab[i] >= 0 && F[i] > maxF[L.lab[i]]) maxF[L.lab[i]] = F[i];
      const minCore = o.junctionArea / (res * res);
      for (let i = 0; i < N; i++) { const c = L.lab[i]; if (c >= 0 && L.size[c] < minCore && maxF[c] < R + o.junctionDepth) core[i] = 0; }
      edt(A, core, 1, W, H, bufs);
      const lim = (Rpx + 1.5) * (Rpx + 1.5); // + 1.5 px: the core's pixel edge would leave a one-pixel rim along every wide shape
      for (let i = 0; i < N; i++) if (m[i] && A[i] <= lim) {
        wide[i] = 1; const x = i % W, y = (i - x) / W;
        if (x < box[0]) box[0] = x; if (x > box[1]) box[1] = x; if (y < box[2]) box[2] = y; if (y > box[3]) box[3] = y;
      }
    }
    lap('split');

    // pieces: { type: 'loop' | 'open' | 'fixed' | 'satin', kind: 'fill' | 'line', ... } (see options() below)
    const pieces = [];
    const cov = new Uint8Array(N); // where thread will lie (for the residual pass)

    // 5. wide part: an edge ring and a tatami core, both measured inside the wide part only
    if (box[1] >= 0) {
      edt(A, wide, 0, W, H, bufs);
      for (let i = 0; i < N; i++) Bf[i] = wide[i] ? (Math.sqrt(A[i]) - 0.5) * res : -0.5 * res;
      const loopMm = L => L.map(p => toMm(p[0], p[1]));
      for (const L of isoLoops(Bf, W, H, o.edge, box)) {
        const mm = loopMm(L); if (plen(mm) + D(mm[0], mm[mm.length - 1]) < 4 * o.minStitch) continue;
        const st = stitchLoop(mm, o.edgeLen, o.chordTol, o.minStitch);
        if (st.length >= 3) { pieces.push({ type: 'loop', kind: 'fill', pts: st, tag: 'edge' }); stats.edgeLoops++; }
      }
      const coreRings = isoLoops(Bf, W, H, o.coreLevel, box).map(loopMm).filter(r => r.length >= 3);
      if (coreRings.length) {
        const fopt = { spacing: o.spacing, stitchLen: o.stitchLen, angleDeg: o.angleDeg, pullComp: o.pullComp, underlay: o.underlay, rule: 'evenodd', maxStitches: o.maxStitches };
        if (o.staggers) fopt.staggers = o.staggers;
        const passes = o.cross ? [fopt.angleDeg, (fopt.angleDeg + 90) % 180] : [fopt.angleDeg];
        for (const ang of passes) {
          const res2 = Dz.fillShape(coreRings, Object.assign({}, fopt, { angleDeg: ang }));
          if (res2.skipped === 'OVER_LIMIT') return { parts: [], stats, warnings, lowerBound: res2.lowerBound, skipped: 'OVER_LIMIT' };
          if (res2.skipped) continue;
          let run = [];
          const flush = () => { if (run.length >= 2) { pieces.push({ type: 'fixed', kind: 'fill', pts: run, tag: 'core' }); stats.coreRuns++; } run = []; };
          for (const p of res2.points) { if (p.break) flush(); else run.push(p); }
          flush();
          // the core counts as covered as a whole: open row spacing (or crosshatch) is a look, not a gap to fill
          for (let i = 0; i < N; i++) if (Bf[i] >= o.coreLevel) cov[i] = 1;
        }
      }
    }
    lap('wide');

    // 6. thin part: skeleton -> strokes
    const sk = new Uint8Array(N); for (let i = 0; i < N; i++) sk[i] = m[i] && !wide[i] ? 1 : 0;
    const pixels = thinMask(sk, W, H);
    const { nodes, edges } = traceSkeleton(sk, W, pixels);
    const pxMm = i => { const x = i % W; return toMm(x, (i - x) / W); };
    const onBlack = p => { const i = pxOf(p); return i >= 0 && m[i] === 1; };
    const widthAt = i => Math.max(res, 2 * F[i]);
    for (const e of edges) { e.pts = e.px.map(pxMm); e.w = e.px.map(widthAt); e.len = plen(e.pts); e.dead = false; }
    const collectEnds = () => { for (const n of nodes) n.ends = []; for (let k = 0; k < edges.length; k++) { const e = edges[k]; if (e.dead || e.loop) continue; if (e.a >= 0) nodes[e.a].ends.push({ k, at: 0 }); if (e.b >= 0) nodes[e.b].ends.push({ k, at: 1 }); } };
    for (let pass = 0; pass < 3; pass++) { // spurs: short twigs from a junction to a free end
      collectEnds(); let cut = 0;
      for (const e of edges) {
        if (e.dead || e.loop) continue;
        const da = e.a >= 0 ? nodes[e.a].ends.length : 0, db = e.b >= 0 ? nodes[e.b].ends.length : 0;
        if ((da === 1 && db >= 3) || (db === 1 && da >= 3)) { const jw = da >= 3 ? e.w[0] : e.w[e.w.length - 1]; if (e.len < Math.max(o.spur, 0.6 * jw)) { e.dead = true; cut++; } }
      }
      if (!cut) break;
    }
    collectEnds();
    const dirAt = (e, at) => { const p = e.pts, n = p.length, a = at === 0 ? p[0] : p[n - 1]; let j = at === 0 ? 0 : n - 1, L = 0; while (L < 0.4 && (at === 0 ? j < n - 1 : j > 0)) { const q = at === 0 ? j + 1 : j - 1; L += D(p[j], p[q]); j = q; } const b = p[j], l = D(a, b) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };
    const link = new Map(); // edge end key (k * 2 + at) -> partner key: the straightest continuation through a node
    for (const n of nodes) {
      const E = n.ends; if (E.length < 2) continue;
      const pairs = [];
      for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) { if (E[i].k === E[j].k) continue; const a = dirAt(edges[E[i].k], E[i].at), b = dirAt(edges[E[j].k], E[j].at); pairs.push({ i, j, cos: a.x * b.x + a.y * b.y }); }
      pairs.sort((p, q) => p.cos - q.cos || p.i - q.i || p.j - q.j);
      const used = new Uint8Array(E.length);
      for (const pr of pairs) {
        if (used[pr.i] || used[pr.j]) continue;
        if (E.length > 2 && pr.cos > -0.35) continue;
        used[pr.i] = used[pr.j] = 1;
        const ka = E[pr.i].k * 2 + E[pr.i].at, kb = E[pr.j].k * 2 + E[pr.j].at; link.set(ka, kb); link.set(kb, ka);
      }
    }
    const raw = [], taken = new Uint8Array(edges.length);
    const chain = (k0, at0) => {
      const P = [], Wd = []; let k = k0, at = at0, closed = false;
      for (;;) {
        taken[k] = 1; const e = edges[k], p = at === 0 ? e.pts : reversed(e.pts), w = at === 0 ? e.w : reversed(e.w);
        for (let i = P.length ? 1 : 0; i < p.length; i++) { P.push(p[i]); Wd.push(w[i]); }
        const nx = link.get(k * 2 + (1 - at)); if (nx === undefined) break;
        const nk = nx >> 1; if (taken[nk]) { closed = nk === k0; break; }
        k = nk; at = nx & 1;
      }
      return { P, Wd, closed };
    };
    for (let k = 0; k < edges.length; k++) {
      if (taken[k] || edges[k].dead) continue;
      if (edges[k].loop) { taken[k] = 1; raw.push({ P: edges[k].pts, Wd: edges[k].w, closed: true }); continue; }
      if (!link.has(k * 2)) raw.push(chain(k, 0)); else if (!link.has(k * 2 + 1)) raw.push(chain(k, 1));
    }
    for (let k = 0; k < edges.length; k++) if (!taken[k] && !edges[k].dead) raw.push(chain(k, 0));
    const nearWide = p => { const i = Math.floor((p.x - x0) / res), j = Math.floor((p.y - y0) / res); for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const x = i + dx, y = j + dy; if (x >= 0 && y >= 0 && x < W && y < H && wide[y * W + x]) return true; } return false; };
    for (const s of raw) {
      if (s.P.length < 2) continue;
      let P = smoothPts(s.P, 3), Wd = smoothArr(s.Wd, 4);
      const keep = dpKeep(P, o.dpTol), P2 = [], W2 = [];
      for (let i = 0; i < P.length; i++) if (keep[i]) { P2.push(P[i]); W2.push(Wd[i]); }
      P = P2; Wd = W2;
      if (!s.closed && box[1] >= 0) for (const end of [0, 1]) { // run a little into the wide part so there is no gap at the joint
        const a = end ? P[P.length - 1] : P[0], b = end ? P[Math.max(0, P.length - 2)] : P[Math.min(P.length - 1, 1)];
        if (nearWide(a)) { const l = D(a, b) || 1, q = { x: a.x + (a.x - b.x) / l * o.extend, y: a.y + (a.y - b.y) / l * o.extend }; if (end) { P.push(q); Wd.push(Wd[Wd.length - 1]); } else { P.unshift(q); Wd.unshift(Wd[0]); } }
      }
      const len = plen(P), wMed = quantile(Wd, o.widthQ); let wMax = 0; for (const v of Wd) if (v > wMax) wMax = v;
      if (len < o.minLen && wMax < o.satinMin) continue; // the residual pass picks these up if they matter
      if (wMed >= o.satinMin && len >= o.minStitch) {
        const variant = (c, w) => { const body = satinVar(reversed(c), reversed(w), o, onBlack); return plen(c) >= o.underlayLen ? Dz.runStitch(c, o.underlayLen, { closed: false }).concat(body) : body; };
        const sA = variant(P, Wd), sB = variant(reversed(P), reversed(Wd));
        if (sA.length >= 2) { pieces.push({ type: 'satin', kind: 'line', variants: [sA, sB], tag: 'satin' }); stats.satin++; }
      } else if (wMed >= o.beanMin && !s.closed) {
        // A line too narrow for satin but wider than one thread: three passes like a triple run, spread over the
        // drawn width. Out along one edge (ringInset in from it), back along the other, out again along the middle
        // (from ringMin up: only the two edge passes, a narrow ring).
        const nrm = P.map((q, i) => { const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], l = D(a, b) || 1; return { x: -(b.y - a.y) / l, y: (b.x - a.x) / l }; });
        const side = sg => P.map((q, i) => { const d = Math.max(0, Wd[i] / 2 - o.ringInset) * sg; return { x: q.x + nrm[i].x * d, y: q.y + nrm[i].y * d }; });
        const out = Dz.runStitch(side(1), o.runLen, {}), back = reversed(Dz.runStitch(side(-1), o.runLen, {}));
        if (wMed >= o.ringMin) { const st = out.concat(back); if (st.length >= 3) { pieces.push({ type: 'loop', kind: 'line', pts: st, tag: 'ring' }); stats.ring++; } }
        else { const st = out.concat(back, Dz.runStitch(P, o.runLen, {})); if (st.length >= 3) { pieces.push({ type: 'open', kind: 'line', pts: st, tag: 'bean' }); stats.bean++; } }
      } else {
        let st = Dz.runStitch(P, o.runLen, { closed: s.closed });
        const bn = wMed >= o.beanMin; if (bn) { st = Dz.bean(st, 3); stats.bean++; } else stats.run++;
        if (st.length >= 2) pieces.push({ type: 'open', kind: 'line', pts: st, tag: bn ? 'bean' : 'run' });
      }
    }
    lap('thin');

    // 7. residual: black that no planned thread reaches gets a loop just inside its own edge (or a tack)
    const stampSeg = (a, b) => { const n = Math.max(1, Math.ceil(D(a, b) / (res * 0.7))); for (let k = 0; k <= n; k++) { const i = pxOf({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n }); if (i >= 0) cov[i] = 1; } };
    const stampPiece = pc => { const s = pc.type === 'satin' ? pc.variants[0] : pc.pts; for (let k = 1; k < s.length; k++) stampSeg(s[k - 1], s[k]); if (pc.type === 'loop' && s.length > 2) stampSeg(s[s.length - 1], s[0]); };
    for (const pc of pieces) stampPiece(pc);
    const reachPx = o.reach / res, reach2 = reachPx * reachPx, offReach = ringOffsets(Math.ceil(reachPx)), off3 = ringOffsets(3);
    let prevList = null; // coverage only grows: a later pass looks only at what the one before missed
    for (let pass = 0; pass < o.residualPasses; pass++) {
      const resid = new Uint8Array(N), list = []; let rb = [W, -1, H, -1];
      const check = i => {
        if (!(m[i] && nearest2(cov, 1, i, W, H, offReach, Infinity) > reach2)) return;
        resid[i] = 1; list.push(i); const x = i % W, y = (i - x) / W;
        if (x < rb[0]) rb[0] = x; if (x > rb[1]) rb[1] = x; if (y < rb[2]) rb[2] = y; if (y > rb[3]) rb[3] = y;
      };
      if (prevList) for (const i of prevList) check(i); else for (let i = 0; i < N; i++) if (m[i]) check(i);
      prevList = list;
      if (!list.length) break;
      // depth inside the residual (the loop level is 0.04 mm, so a few pixels of depth are enough)
      for (let y = Math.max(0, rb[2] - 2); y <= Math.min(H - 1, rb[3] + 2); y++) Bf.fill(-res, y * W + Math.max(0, rb[0] - 2), y * W + Math.min(W, rb[1] + 3));
      for (const i of list) Bf[i] = (Math.sqrt(nearest2(resid, 0, i, W, H, off3, 16)) - 0.5) * res;
      const before = pieces.length;
      for (const L of isoLoops(Bf, W, H, o.residualLevel, rb)) {
        const mm = L.map(p => toMm(p[0], p[1])), per = plen(mm) + D(mm[0], mm[mm.length - 1]);
        if (per < o.dropBelow) continue;
        if (per < o.tackBelow) { // a dash or a dot: one stitch there and back along its longest axis
          let a = mm[0], b = mm[0], bd = -1;
          for (let i = 0; i < mm.length; i++) for (let j = i + 1; j < mm.length; j++) { const d = D(mm[i], mm[j]); if (d > bd) { bd = d; a = mm[i]; b = mm[j]; } }
          if (bd < o.minStitch) continue;
          pieces.push({ type: 'loop', kind: 'line', pts: [a, b], tag: 'tack' }); stats.tacks++;
        } else {
          const st = stitchLoop(mm, o.travelLen, o.chordTol, o.minStitch);
          if (st.length >= 3) { pieces.push({ type: 'loop', kind: 'line', pts: st, tag: 'residual' }); stats.residualLoops++; }
        }
      }
      for (let k = before; k < pieces.length; k++) stampPiece(pieces[k]);
      if (pieces.length === before) break;
    }
    lap('residual');
    if (!pieces.length) return empty('TOO_SMALL');

    // 8. sewing order
    const lab = comp.lab;
    { let n = 0; const minA = o.minIsland * scale / (res * res); for (const c of comp.size) if (c >= minA) n++; stats.components = n; }
    // the nearest black pixel to p within a few pixels (stitch points can sit just outside, e.g. satin edges)
    const nearBlack = (p, want) => {
      const x = Math.floor((p.x - x0) / res), y = Math.floor((p.y - y0) / res);
      let best = -1, bd = Infinity;
      for (let r = 0; r <= 8 && best < 0; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const i = yy * W + xx; if (!walk[i] || (want !== undefined && lab[i] !== want)) continue;
        const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; }
      }
      return best;
    };
    // options of a piece: where the backwards plan may enter it, and what it then sews (in backwards order)
    for (const pc of pieces) {
      const opts = [];
      if (pc.type === 'loop') { const s = pc.pts; for (let v = 0; v < s.length; v++) opts.push({ at: s[v], seq: () => { const out = []; for (let k = 0; k <= s.length; k++) out.push(s[(v + k) % s.length]); return out; } }); }
      else if (pc.type === 'open') { const s = pc.pts; opts.push({ at: s[0], seq: () => s }, { at: s[s.length - 1], seq: () => reversed(s) }); }
      else if (pc.type === 'fixed') { const s = pc.pts; opts.push({ at: s[s.length - 1], seq: () => reversed(s) }); }
      else for (const s of pc.variants) if (s.length >= 2) opts.push({ at: s[s.length - 1], seq: () => reversed(s) });
      pc.opts = opts; pc.sewn = false; pc.comp = -1;
      for (const op of opts) { const i = nearBlack(op.at); if (i >= 0) { pc.comp = lab[i]; break; } }
    }
    const markP = new Int32Array(N).fill(-1), markO = new Int32Array(N);
    pieces.forEach((pc, id) => {
      if (pc.comp < 0) return;
      pc.opts.forEach((op, k) => {
        const i = nearBlack(op.at, pc.comp); op.px = i; if (i < 0) return;
        markP[i] = id; markO[i] = k;
        const x = i % W;
        for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) if (j >= 0 && j < N && m[j] && markP[j] < 0) { markP[j] = id; markO[j] = k; }
      });
    });
    const byComp = new Map(); // component -> piece ids, in piece order
    const strays = [];
    pieces.forEach((pc, id) => { if (pc.comp < 0) { strays.push(id); return; } let l = byComp.get(pc.comp); if (!l) byComp.set(pc.comp, l = []); l.push(id); });

    // breadth-first search through black pixels (8-connected) from pixel s until stop(i) holds
    const stamp = new Int32Array(A.buffer), from = new Int32Array(Bf.buffer); let gen = 0; // the float buffers are free now
    stamp.fill(0);
    const bfs = (s, stop) => {
      gen++; let qh = 0, qt = 0; stack[qt++] = s; stamp[s] = gen; from[s] = -1;
      while (qh < qt) {
        const i = stack[qh++];
        if (stop(i)) { const path = []; for (let j = i; j >= 0; j = from[j]) path.push(j); return { at: i, path: path.reverse() }; }
        const x = i % W;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue; const xx = x + dx; if (xx < 0 || xx >= W) continue;
          const j = i + dy * W + dx; if (j < 0 || j >= N || stamp[j] === gen || !walk[j]) continue;
          stamp[j] = gen; from[j] = i; stack[qt++] = j;
        }
      }
      return null;
    };
    const los = (a, b) => { const n = Math.max(1, Math.ceil(D(a, b) / (res * 0.5))); for (let k = 0; k <= n; k++) { const i = pxOf({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n }); if (i < 0 || !walk[i]) return false; } return true; };
    // travel from a to b along the pixel path, pulled straight wherever the line of sight stays on black
    const pull = (a, path, b) => {
      const P = [a]; for (let k = 1; k < path.length - 1; k++) P.push(pxMm(path[k])); P.push(b);
      const out = [a]; let i = 0;
      while (i < P.length - 1) {
        let lo = i + 1, step = 1;
        while (lo + step < P.length && los(P[i], P[lo + step])) { lo += step; step *= 2; }
        let hi = Math.min(P.length - 1, lo + step) - 1;
        while (hi > lo) { const mid = (lo + hi + 1) >> 1; if (los(P[i], P[mid])) lo = mid; else hi = mid - 1; }
        out.push(P[lo]); i = lo;
      }
      return out;
    };
    const travelPts = pts => { const out = []; for (let k = 1; k < pts.length; k++) { const a = pts[k - 1], b = pts[k], n = Math.max(1, Math.ceil(D(a, b) / o.travelLen)); for (let s = 1; s <= n; s++) out.push({ x: a.x + (b.x - a.x) * s / n, y: a.y + (b.y - a.y) * s / n }); } stats.travelMm += plen(pts); return out; };

    // one component, planned backwards: returns forward threads, each a list of { kind, pts } chunks
    const planComponent = ids => {
      const threads = []; let chunks = null, cur = null;
      const sew = (id, k) => { const pc = pieces[id]; pc.sewn = true; const s = pc.opts[k].seq(); chunks.push({ kind: pc.kind, pts: s, tag: pc.tag }); cur = s[s.length - 1]; };
      const left = () => ids.some(id => !pieces[id].sewn);
      const startNew = () => {
        // a new thread enters at the option furthest down and right: sewn forwards, it then ends there
        let bi = -1, bk = 0, bv = -Infinity;
        for (const id of ids) { const pc = pieces[id]; if (pc.sewn) continue; pc.opts.forEach((op, k) => { const v = op.at.x + op.at.y; if (v > bv) { bv = v; bi = id; bk = k; } }); }
        if (chunks) threads.push(chunks);
        chunks = []; sew(bi, bk);
      };
      startNew();
      while (left()) {
        const s = nearBlack(cur, pieces[ids[0]].comp);
        let r = s >= 0 ? bfs(s, i => markP[i] >= 0 && !pieces[markP[i]].sewn) : null;
        let id, k;
        if (r) { id = markP[r.at]; k = markO[r.at]; }
        else if (s >= 0) { // every mark of what is left was overwritten: go to the nearest leftover by its own pixel
          let bd = Infinity; id = -1;
          for (const j of ids) { const pc = pieces[j]; if (pc.sewn) continue; pc.opts.forEach((op, kk) => { if (op.px >= 0) { const d = D(op.at, cur); if (d < bd) { bd = d; id = j; k = kk; } } }); }
          if (id >= 0) { const t = pieces[id].opts[k].px; r = bfs(s, i => i === t); }
        }
        if (!r) { stats.stranded++; startNew(); continue; }
        const target = pieces[id].opts[k].at;
        const way = los(cur, target) ? [cur, target] : pull(cur, r.path, target);
        const tp = travelPts(way);
        if (tp.length) chunks.push({ kind: 'line', pts: [cur].concat(tp), tag: 'travel' });
        sew(id, k);
      }
      threads.push(chunks);
      // backwards -> forwards
      return threads.reverse().map(ch => ch.reverse().map(c => ({ kind: c.kind, pts: reversed(c.pts), tag: c.tag })));
    };
    const runs = []; // { first, last, threads }
    for (const [c, ids] of byComp) { // Map keeps insertion order: components in order of their first piece
      const th = planComponent(ids); if (!th.length) continue;
      const f = th[0][0].pts[0], lt = th[th.length - 1], lc = lt[lt.length - 1];
      runs.push({ c, first: f, last: lc.pts[lc.pts.length - 1], threads: th });
    }
    for (const id of strays) { const pc = pieces[id], s = pc.opts[0].seq(), fw = reversed(s); runs.push({ c: -1, first: fw[0], last: fw[fw.length - 1], threads: [[{ kind: pc.kind, pts: fw }]] }); }
    lap('order');

    // components: nearest first, starting from the hoop's top-left corner (ties: the earlier one)
    const parts = []; let at = { x: 0, y: 0 };
    const done = new Uint8Array(runs.length);
    for (let n = 0; n < runs.length; n++) {
      let bi = -1, bd = Infinity;
      for (let i = 0; i < runs.length; i++) if (!done[i]) { const d = D(at, runs[i].first); if (d < bd) { bd = d; bi = i; } }
      done[bi] = 1; const rn = runs[bi];
      for (const th of rn.threads) {
        stats.threads++;
        let part = null;
        for (const ch of th) {
          if (!part || part.kind !== ch.kind) { const prev = part; part = { points: [], kind: ch.kind }; if (o.debug) part.src = []; if (!prev) part.trimBefore = true; else { part.points.push(prev.points[prev.points.length - 1]); if (o.debug) part.src.push(ch.tag); } parts.push(part); }
          for (let k = part.points.length && ch.pts.length ? 1 : 0; k < ch.pts.length; k++) { part.points.push(ch.pts[k]); if (o.debug) part.src.push(ch.tag); }
        }
      }
      at = rn.last;
    }
    for (const p of parts) p.points = p.points.map(q => ({ x: r2(q.x), y: r2(q.y) }));
    stats.travelMm = +stats.travelMm.toFixed(1);
    lap('emit');
    if (tm) stats.ms = ms;

    // a number of stitches these parts cannot be sewn with fewer than (assemble keeps every point that is at
    // least 0.6 mm from the one before; a run may lose one more at its end)
    let lowerBound = 0;
    for (const p of parts) { let c = 0; for (let k = 1; k < p.points.length; k++) if (D(p.points[k - 1], p.points[k]) >= 0.6) c++; lowerBound += Math.max(0, c - 1); }
    return { parts, stats, warnings, lowerBound };
  }

  // ------------------------------------------------------------------ cache (a design is regenerated on every edit)
  // Keyed by an FNV-1a hash of the canonical input; the full key is kept to rule out collisions. 8 entries, LRU.
  const CACHE_MAX = 8, cache = new Map();
  function fnv1a(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16) + ':' + s.length; }
  function cacheKey(rings, rule, opt) {
    const o = {}; for (const k of Object.keys(opt || {}).sort()) if (k !== 'maxStitches' && k !== 'timer') o[k] = opt[k];
    let s = rule + '|' + JSON.stringify(o);
    for (const r of rings) { s += '|'; for (const p of r) s += Math.round(p.x * 1e4) + ',' + Math.round(p.y * 1e4) + ';'; }
    return s;
  }
  function buildCached(rings, rule, opt, helpers) {
    const key = cacheKey(rings, rule, opt), h = fnv1a(key), hit = cache.get(h);
    let out;
    if (hit && hit.key === key) { cache.delete(h); cache.set(h, hit); out = hit.out; }
    else {
      out = build(rings, rule, opt, helpers);
      if (!out.skipped || out.skipped === 'TOO_SMALL') { cache.set(h, { key, out }); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }
    }
    if (!out.skipped && opt && typeof opt.maxStitches === 'number' && out.lowerBound > opt.maxStitches) return { parts: [], stats: out.stats, warnings: out.warnings, lowerBound: out.lowerBound, skipped: 'OVER_LIMIT' };
    return { parts: out.parts.map(p => Object.assign({}, p)), stats: Object.assign({}, out.stats), warnings: out.warnings.slice(), lowerBound: out.lowerBound, skipped: out.skipped };
  }

  return { build: buildCached, buildUncached: build, DEFAULTS: DEF, DETAIL, clearCache: () => cache.clear(), _internal: { rasterize, edt, isoLoops, label, thinMask } };
});
