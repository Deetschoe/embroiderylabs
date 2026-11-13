/*
 * Embroidery Labs: realistic stitch renderer, CORE (pure maths, no DOM, no canvas).
 *
 * A software rasteriser on typed arrays: stitches are drawn in sewing order as lit thread capsules onto a
 * procedural fabric, in linear light, and come back as RGBA bytes. The same code runs on the main thread,
 * inside a Blob worker (realistic.js builds one from this file's own source text, so it works from file://)
 * and in node (tests/realistic). Classic script: window.RealisticCore. Node: require().
 *
 * IMPORTANT: the factory below must stay self-contained (no references to anything outside it), because
 * its source text is what the worker runs.
 */
(function (root, factory) {
  var core = factory();
  core.factory = factory;
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.RealisticCore = core;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var OP = { STITCH: 0, JUMP: 1, TRIM: 2, COLOR_CHANGE: 3, END: 4 };
  var FABRICS = ['jersey', 'fleece', 'twill', 'denim'];
  var SCENES = ['swatch', 'garment'];
  var GARMENTS = ['tshirt', 'hoodie'];
  var PLACEMENTS = ['left-chest', 'center-chest'];
  var MAX_SEGMENTS = 2000000;

  var DEFAULTS = {
    fabric: 'jersey',
    fabricColor: '#e8e4dc',
    scene: 'swatch',
    garment: 'tshirt',
    placement: 'left-chest',
    framing: 'garment',
    hoop: false,
    lightAngle: 315,
    lightElevation: 48,
    pixelsPerMm: null,
    origin: null,
    showJumps: false,
    seed: 1,
    threadWidth: 0.4,
    transparent: false,
    backdrop: '#f1efea',
    margin: 0.12
  };

  /* ---------- small maths ------------------------------------------------------------ */
  function hash2(a, b) {
    var h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b + 0x7f4a7c15) | 0, 0xc2b2ae35);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    return h >>> 0;
  }
  function rnd(a, b) { return hash2(a, b) / 4294967296; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /* sRGB <-> linear */
  var TO_LIN = new Float32Array(256);
  (function () { for (var i = 0; i < 256; i++) { var c = i / 255; TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); } })();
  /* linear [0,2) -> display byte, with a soft shoulder above 0.75 so highlights roll off instead of clipping */
  var OUT_N = 4096, OUT_SCALE = OUT_N / 2;
  var TO_BYTE = new Uint8Array(OUT_N);
  function tone(x) { return x < 0.75 ? x : 0.75 + 0.25 * (1 - Math.exp(-(x - 0.75) / 0.25)); }
  (function () {
    for (var i = 0; i < OUT_N; i++) {
      var x = tone((i + 0.5) / OUT_SCALE);
      var s = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
      TO_BYTE[i] = clamp(Math.round(s * 255), 0, 255);
    }
  })();

  /* '#rgb' | '#rrggbb' (hash optional, any case) -> [r, g, b] bytes, or null */
  function parseColor(c) {
    if (typeof c !== 'string') return null;
    var m = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i.exec(c.trim());
    if (m) return +m[1] > 255 || +m[2] > 255 || +m[3] > 255 ? null : [+m[1], +m[2], +m[3]];
    var s = c.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(s)) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    var n = parseInt(s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function toLinear(rgb) { return [TO_LIN[rgb[0]], TO_LIN[rgb[1]], TO_LIN[rgb[2]]]; }

  /* light: angle in degrees, the direction the light comes FROM, 0 = top of the screen, clockwise.
     Returns the unit vector pointing at the light (screen x right, y down, z towards the viewer) and the
     half vector between it and the viewer. */
  function lightVectors(angleDeg, elevationDeg) {
    var a = angleDeg * Math.PI / 180, e = clamp(elevationDeg, 10, 85) * Math.PI / 180;
    var lx = Math.sin(a) * Math.cos(e), ly = -Math.cos(a) * Math.cos(e), lz = Math.sin(e);
    var hx = lx, hy = ly, hz = lz + 1, hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
    return { lx: lx, ly: ly, lz: lz, hx: hx / hl, hy: hy / hl, hz: hz / hl };
  }

  /* The sheen of one stitch, as plain numbers (also what the tests check).
     tx, ty: unit direction of the stitch on screen. Returns { diffuse, specular } for the flat middle of
     the stitch: both are largest when the stitch lies ACROSS the light and smallest when it lies along it. */
  var SPEC_POWER = 15;
  function sheen(tx, ty, L) {
    var tl = tx * L.lx + ty * L.ly, th = tx * L.hx + ty * L.hy;
    return { diffuse: Math.sqrt(Math.max(0, 1 - tl * tl)), specular: Math.pow(Math.max(0, 1 - th * th), SPEC_POWER) };
  }

  /* ---------- options ---------------------------------------------------------------- */
  function normalizeOptions(o) {
    var out = {}, w = [], k;
    o = (o && typeof o === 'object') ? o : {};
    for (k in DEFAULTS) out[k] = DEFAULTS[k];
    function bad(name, value, used) { w.push({ code: 'BAD_OPTION', option: name, value: String(value).slice(0, 40), used: used }); }
    function oneOf(name, list) {
      if (o[name] === undefined || o[name] === null) return;
      if (list.indexOf(o[name]) >= 0) out[name] = o[name]; else bad(name, o[name], out[name]);
    }
    function num(name, lo, hi) {
      if (o[name] === undefined || o[name] === null) return;
      var v = Number(o[name]);
      if (!isFinite(v)) { bad(name, o[name], out[name]); return; }
      if (v < lo || v > hi) { v = clamp(v, lo, hi); bad(name, o[name], v); }
      out[name] = v;
    }
    function color(name) {
      if (o[name] === undefined || o[name] === null) return;
      var c = parseColor(o[name]);
      if (c) out[name] = '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1);
      else bad(name, o[name], out[name]);
    }
    oneOf('fabric', FABRICS); oneOf('scene', SCENES); oneOf('garment', GARMENTS); oneOf('placement', PLACEMENTS);
    oneOf('framing', ['garment', 'chest']);
    color('fabricColor'); color('backdrop');
    if (o.lightAngle !== undefined && o.lightAngle !== null) {
      var la = Number(o.lightAngle);
      if (isFinite(la)) out.lightAngle = ((la % 360) + 360) % 360; else bad('lightAngle', o.lightAngle, out.lightAngle);
    }
    num('lightElevation', 10, 85);
    num('pixelsPerMm', 0.2, 400);
    num('threadWidth', 0.15, 1.2);
    num('margin', 0, 0.45);
    if (o.seed !== undefined && o.seed !== null) {
      var sd = Number(o.seed);
      if (isFinite(sd)) out.seed = Math.floor(sd) | 0; else bad('seed', o.seed, out.seed);
    }
    out.hoop = !!o.hoop; out.showJumps = !!o.showJumps; out.transparent = !!o.transparent;
    if (o.origin !== undefined && o.origin !== null) {
      var og = o.origin, ox = og && (og.x !== undefined ? og.x : og[0]), oy = og && (og.y !== undefined ? og.y : og[1]);
      if (isNum(Number(ox)) && isNum(Number(oy)) && ox !== null && oy !== null && ox !== undefined && oy !== undefined) out.origin = [Number(ox), Number(oy)];
      else bad('origin', JSON.stringify(og), 'centred');
    }
    out.warnings = w;
    return out;
  }

  /* ---------- design -> segments ------------------------------------------------------- */
  /*
   * design: an Engine.generate() result, or { stitches, threads, unit?, offset?, hoop? } where stitches is a
   * flat list of (op, x, y) triples, mm = value * unit + offset. Never throws: bad data becomes warnings.
   * Returns segments in millimetres, in sewing order: ax, ay -> bx, by with a thread index.
   */
  function compile(design, options) {
    var o = options && options.warnings ? options : normalizeOptions(options);
    var warnings = [], cmds = null, threadsIn = null, unit = 0.1, offX = 0, offY = 0, hoop = null;
    function warn(code, message) { warnings.push({ code: code, message: message }); }
    try {
      if (design && typeof design === 'object') {
        if (design.ir && design.ir.commands) {
          cmds = design.ir.commands; threadsIn = design.ir.threads || design.threads;
          if (design.ir.hoop && isNum(design.ir.hoop.w) && isNum(design.ir.hoop.h)) { offX = Math.round(design.ir.hoop.w / 2) / 10; offY = Math.round(design.ir.hoop.h / 2) / 10; }
          if (design.hoop && isNum(design.hoop.width) && isNum(design.hoop.height)) hoop = { width: design.hoop.width, height: design.hoop.height };
          else if (design.ir.hoop && isNum(design.ir.hoop.w)) hoop = { width: design.ir.hoop.w / 10, height: design.ir.hoop.h / 10 };
        } else {
          cmds = design.stitches || design.commands; threadsIn = design.threads;
          if (design.unit !== undefined) { if (isNum(design.unit) && design.unit > 0) unit = design.unit; else warn('BAD_DESIGN', 'unit must be a positive number; 0.1 mm is used.'); }
          if (design.offset) {
            var fx = Number(design.offset.x !== undefined ? design.offset.x : design.offset[0]), fy = Number(design.offset.y !== undefined ? design.offset.y : design.offset[1]);
            if (isNum(fx) && isNum(fy)) { offX = fx; offY = fy; } else warn('BAD_DESIGN', 'offset must be two numbers; 0, 0 is used.');
          }
          if (design.hoop && isNum(design.hoop.width) && isNum(design.hoop.height) && design.hoop.width > 0 && design.hoop.height > 0) hoop = { width: design.hoop.width, height: design.hoop.height };
        }
      }
    } catch (e) { cmds = null; warn('BAD_DESIGN', 'The design could not be read.'); }
    if (!cmds || typeof cmds.length !== 'number' || cmds.length < 3) {
      if (!warnings.length) warn('EMPTY_DESIGN', 'There are no stitches to draw.');
      cmds = [];
    }
    var total = Math.floor(cmds.length / 3), cap = Math.min(total, MAX_SEGMENTS);
    var ax = new Float32Array(cap), ay = new Float32Array(cap), bx = new Float32Array(cap), by = new Float32Array(cap);
    var th = new Uint16Array(cap), jumps = [];
    var n = 0, thread = 0, down = false, px = 0, py = 0, havePos = false, lastX = 0, lastY = 0, haveLast = false, lastThread = -1;
    var pointId = 0, seed = o.seed | 0, jit = 0.04, badNumbers = 0, stitches = 0, i, op, x, y, jx, jy, d2, rawX = 0, rawY = 0;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (i = 0; i < total; i++) {
      op = cmds[i * 3]; x = cmds[i * 3 + 1] * unit + offX; y = cmds[i * 3 + 2] * unit + offY;
      if (op === OP.END) break;
      if (op === OP.COLOR_CHANGE) { thread++; down = false; continue; }
      if (op === OP.TRIM) { down = false; continue; }
      if (!(x === x && y === y) || x > 1e5 || x < -1e5 || y > 1e5 || y < -1e5) { badNumbers++; down = false; continue; }
      if (op === OP.JUMP) { down = false; px = x; py = y; havePos = true; continue; }
      if (op !== OP.STITCH) { badNumbers++; continue; }
      /* a needle point: nudge it a few hundredths of a millimetre, the same way every time */
      pointId++; stitches++;
      /* the needle going down in the very same place again draws nothing. This is decided on the point as given:
         after the nudge below two identical points would be a few hundredths apart and a pile of them a fuzzy knot */
      if (down && x === rawX && y === rawY) continue;
      rawX = x; rawY = y;
      jx = x + (rnd(pointId, seed) - 0.5) * 2 * jit; jy = y + (rnd(pointId, seed ^ 0x5bd1e995) - 0.5) * 2 * jit;
      if (down) {
        d2 = (jx - px) * (jx - px) + (jy - py) * (jy - py);
        if (d2 > 0.0025) {
          if (n >= cap) { warn('TOO_MANY_STITCHES', 'Only the first ' + cap + ' stitches are drawn.'); break; }
          ax[n] = px; ay[n] = py; bx[n] = jx; by[n] = jy; th[n] = thread > 65535 ? 65535 : thread; n++;
          if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py;
          if (jx < minX) minX = jx; if (jx > maxX) maxX = jx; if (jy < minY) minY = jy; if (jy > maxY) maxY = jy;
        } else continue; /* a repeat of the same hole: keep the previous point */
      } else if (haveLast && lastThread === thread) {
        if ((jx - lastX) * (jx - lastX) + (jy - lastY) * (jy - lastY) > 0.25) jumps.push(lastX, lastY, jx, jy, thread);
      }
      px = jx; py = jy; down = true; lastX = jx; lastY = jy; haveLast = true; lastThread = thread;
    }
    if (badNumbers) warn('BAD_STITCHES', badNumbers + ' stitch commands were not numbers or not known and were skipped.');
    var threadCount = thread + 1, colors = new Float32Array(threadCount * 3), hex = [], t, c;
    for (t = 0; t < threadCount; t++) {
      c = null;
      try { c = threadsIn && threadsIn[t] ? parseColor(typeof threadsIn[t] === 'string' ? threadsIn[t] : threadsIn[t].color) : null; } catch (e2) { c = null; }
      if (!c) { c = [0, 0, 0]; if (n) warn('BAD_THREAD_COLOR', 'Thread ' + (t + 1) + ' has no usable colour; black is used.'); }
      colors[t * 3] = TO_LIN[c[0]]; colors[t * 3 + 1] = TO_LIN[c[1]]; colors[t * 3 + 2] = TO_LIN[c[2]];
      hex.push('#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1));
    }
    if (!n && !warnings.length) warn('EMPTY_DESIGN', 'There are no stitches to draw.');
    /* threads sewn side by side closer than they are wide (a satin column: two passes in every 0.4 mm) are
       squeezed by their neighbours and lie next to each other, not half on top of one another. squeeze[i] is how
       much of its free width thread i keeps. Without this each thread would show only one flank, and how bright a
       satin looks would depend on which way round it was sewn. */
    var squeeze = new Float32Array(n), full = o.threadWidth, j, ddx, ddy, ll, mx, my, al, pp, best;
    for (i = 0; i < n; i++) {
      ddx = bx[i] - ax[i]; ddy = by[i] - ay[i]; ll = Math.sqrt(ddx * ddx + ddy * ddy) || 1; ddx /= ll; ddy /= ll; best = full;
      for (j = i - 1; j <= i + 1; j += 2) {
        if (j < 0 || j >= n || th[j] !== th[i]) continue;
        mx = (ax[j] + bx[j]) * 0.5 - (ax[i] + bx[i]) * 0.5; my = (ay[j] + by[j]) * 0.5 - (ay[i] + by[i]) * 0.5;
        al = mx * ddx + my * ddy; if (al < 0) al = -al; pp = -mx * ddy + my * ddx; if (pp < 0) pp = -pp;
        if (al < ll * 0.4 && pp < best) best = pp;
      }
      squeeze[i] = best >= full ? 1 : Math.max(0.78, best * 1.25 / full);
      if (squeeze[i] > 1) squeeze[i] = 1;
    }
    var out = {
      squeeze: squeeze,
      n: n, ax: n === cap ? ax : ax.slice(0, n), ay: n === cap ? ay : ay.slice(0, n), bx: n === cap ? bx : bx.slice(0, n), by: n === cap ? by : by.slice(0, n),
      thread: n === cap ? th : th.slice(0, n), jumps: new Float32Array(jumps), colors: colors, threadHex: hex, threads: threadCount,
      stitches: stitches, hoop: hoop,
      bounds: n ? { minX: minX, minY: minY, maxX: maxX, maxY: maxY, width: maxX - minX, height: maxY - minY } : null,
      warnings: warnings, loft: null
    };
    out.loft = computeLoft(out, o.threadWidth);
    return out;
  }

  /* ---------- how much thread lies where (coarse): drives the design's shadow and stitch lift ---------- */
  function boxBlur(src, w, h, r, passes) {
    var tmp = new Float32Array(w * h), a = src, b = tmp, p, x, y, s, i, n = 2 * r + 1, sw;
    for (p = 0; p < passes; p++) {
      for (y = 0; y < h; y++) {
        s = 0; i = y * w;
        for (x = -r; x <= r; x++) s += a[i + clamp(x, 0, w - 1)];
        for (x = 0; x < w; x++) { b[i + x] = s / n; s += a[i + clamp(x + r + 1, 0, w - 1)] - a[i + clamp(x - r, 0, w - 1)]; }
      }
      sw = a; a = b; b = sw;
      for (x = 0; x < w; x++) {
        s = 0;
        for (y = -r; y <= r; y++) s += a[clamp(y, 0, h - 1) * w + x];
        for (y = 0; y < h; y++) { b[y * w + x] = s / n; s += a[clamp(y + r + 1, 0, h - 1) * w + x] - a[clamp(y - r, 0, h - 1) * w + x]; }
      }
      sw = a; a = b; b = sw;
    }
    if (a !== src) src.set(a);
    return src;
  }
  function computeLoft(c, threadWidth) {
    if (!c.n) return null;
    var b = c.bounds, pad = 6, span = Math.max(b.width, b.height) + pad * 2;
    var cell = Math.max(0.4, span / 700), w = Math.ceil((b.width + pad * 2) / cell) + 1, h = Math.ceil((b.height + pad * 2) / cell) + 1;
    var x0 = b.minX - pad, y0 = b.minY - pad, cov = new Float32Array(w * h), i, k, ns, len, dx, dy, add, gx, gy;
    var inv = 1 / cell, tw = threadWidth || 0.38;
    for (i = 0; i < c.n; i++) {
      dx = c.bx[i] - c.ax[i]; dy = c.by[i] - c.ay[i]; len = Math.sqrt(dx * dx + dy * dy);
      ns = Math.max(1, Math.ceil(len * inv * 2)); add = (len / ns) * tw * inv * inv;
      for (k = 0; k < ns; k++) {
        gx = ((c.ax[i] + dx * (k + 0.5) / ns) - x0) * inv | 0; gy = ((c.ay[i] + dy * (k + 0.5) / ns) - y0) * inv | 0;
        if (gx >= 0 && gy >= 0 && gx < w && gy < h) cov[gy * w + gx] += add;
      }
    }
    /* layers: thread layers lying here (about 1 in a normal fill). shadow: a soft, wider version for the cloth. */
    var layers = boxBlur(cov, w, h, 1, 1), shadow = new Float32Array(w * h);
    for (i = 0; i < w * h; i++) shadow[i] = layers[i] > 1.2 ? 1 : layers[i] / 1.2;
    boxBlur(shadow, w, h, Math.max(1, Math.round(0.9 / cell)), 3);
    return { x0: x0, y0: y0, cell: cell, w: w, h: h, layers: layers, shadow: shadow };
  }
  function sampleGrid(g, arr, x, y) {
    var fx = (x - g.x0) / g.cell - 0.5, fy = (y - g.y0) / g.cell - 0.5;
    if (fx < 0 || fy < 0 || fx >= g.w - 1 || fy >= g.h - 1) return 0;
    var ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, i = iy * g.w + ix;
    return (arr[i] * (1 - tx) + arr[i + 1] * tx) * (1 - ty) + (arr[i + g.w] * (1 - tx) + arr[i + g.w + 1] * tx) * ty;
  }

  /* ---------- fabric: a tileable, lit patch of cloth, generated ---------------------------- */
  /* pitches in mm; n = how many repeats one tile holds (variation repeats only after a whole tile) */
  var FABRIC_SPECS = {
    jersey: { px: 0.72, py: 0.54, nx: 18, ny: 20, mult: 1, bump: 0.10, weft: 0 },
    fleece: { px: 0.98, py: 0.72, nx: 14, ny: 16, mult: 1, bump: 0.07, weft: 0 },
    twill: { px: 0.46, py: 0.42, nx: 24, ny: 24, mult: 3, bump: 0.09, weft: 0 },
    denim: { px: 0.36, py: 0.48, nx: 32, ny: 24, mult: 4, bump: 0.08, weft: 0.5 }
  };
  function prof(t) { return t < 1 ? Math.sqrt(1 - t * t) : 0; }
  /* periodic value noise: cells per period must be integers */
  function pnoise(x, y, cx, cy, salt) {
    var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var x0 = ((ix % cx) + cx) % cx, x1 = (x0 + 1) % cx, y0 = ((iy % cy) + cy) % cy, y1 = (y0 + 1) % cy;
    var a = rnd(x0 + y0 * 9973, salt), b = rnd(x1 + y0 * 9973, salt), c = rnd(x0 + y1 * 9973, salt), d = rnd(x1 + y1 * 9973, salt);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  /* height 0..1, tint multiplier, weft 0..1 at a point (mm) of one fabric. res[0..2]. */
  function fabricAt(kind, sp, nx, ny, x, y, res) {
    var gx = x / sp.px, gy = y / sp.py, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
    var wx = ((ix % nx) + nx) % nx, wy = ((iy % ny) + ny) % ny, h, tint = 1, weft = 0, j, j2, k, t, xl, dl, m;
    if (kind === 'jersey' || kind === 'fleece') {
      j = rnd(wx * 131 + wy, 11); j2 = rnd(wx, 12);
      /* the right side of a knit: wale after wale of stacked Vs. Each leg of a V is a slanting piece of yarn;
         legs lie tight against each other, with a groove between wales and a faint one down the middle. */
      xl = Math.abs(fx - 0.5) * 2;                                  /* 0 in the middle of the wale, 1 at its edge */
      t = gy + 0.62 * xl + (j2 - 0.5) * 0.08; t = t - Math.floor(t);
      dl = Math.abs(t - 0.5) * 2;                                   /* across the leg */
      h = Math.sqrt(Math.max(0, 1 - dl * dl * 0.96)) * (1 - 0.55 * Math.pow(xl, 5)) * (0.86 + 0.14 * Math.min(1, xl * 5));
      tint = 1 + 0.06 * (j - 0.5) + 0.07 * (pnoise(x / 0.1, y / 0.1, Math.round(nx * sp.px / 0.1), Math.round(ny * sp.py / 0.1), 5) - 0.5);
      if (kind === 'fleece') {
        /* brushed face: the knit is still there but fibres blur it and the colour is slightly heathered */
        m = pnoise(x / 0.16, y / 0.2, Math.round(nx * sp.px / 0.16), Math.round(ny * sp.py / 0.2), 7);
        h = 0.34 + h * 0.42 + (m - 0.5) * 0.36;
        tint = 1 + 0.10 * (pnoise(x / 0.45, y / 0.9, Math.round(nx * sp.px / 0.45), Math.round(ny * sp.py / 0.9), 8) - 0.5) + 0.07 * (m - 0.5);
      }
    } else {
      m = sp.mult; k = (((ix + iy) % m) + m) % m;
      j = rnd(wx, 21); j2 = rnd(wy, 22);
      /* every warp yarn is a little thicker here and thinner there */
      xl = 0.86 + 0.3 * pnoise(wx, y / 1.9, nx, Math.max(1, Math.round(ny * sp.py / 1.9)), 31);
      if (k === 0) {
        /* the weft comes up for one crossing: a small rounded bump lying across, lower than the warp around
           it, diving under the warp yarns on either side */
        j = rnd(wx * 57 + wy, 23);
        t = 2 * fx - 1 + (j - 0.5) * 0.3; dl = (2 * fy - 1) / (0.62 + 0.3 * j2); dl = t * t * 0.7 + dl * dl;
        if (dl < 1) { h = Math.sqrt(1 - dl) * 0.72; weft = Math.min(1, (1 - dl) * 1.7) * (0.55 + 0.45 * j); tint = 0.96 + 0.1 * (j2 - 0.5); }
        else { h = 0.04; tint = 0.72; }
      } else {
        /* the warp floats over the next (m - 1) crossings: a long bead, highest in the middle, pinched and
           sinking where it goes under at each end */
        t = Math.sin(Math.PI * (k - 1 + fy) / (m - 1));
        dl = Math.abs(2 * fx - 1) / (xl * (0.74 + 0.26 * Math.min(1, t * 2.5)));
        if (dl < 1) {
          h = Math.sqrt(1 - dl * dl) * (0.5 + 0.5 * Math.sqrt(t));
          tint = 1 + (kind === 'denim' ? 0.18 : 0.07) * (j - 0.5);
          if (kind === 'denim') tint += 0.2 * (xl - 1) + 0.16 * h * h;      /* thick places and ridge tops are worn paler */
          /* the yarn's own twist: faint slanting striations */
          tint *= 1 + 0.05 * Math.sin((gy * 2.2 + fx * 1.6 + j) * 6.2832);
        } else { h = 0.04; tint = 0.72; }
      }
      tint += 0.07 * (pnoise(x / 0.07, y / 0.07, Math.round(nx * sp.px / 0.07), Math.round(ny * sp.py / 0.07), 6) - 0.5);
    }
    res[0] = h; res[1] = tint; res[2] = weft;
  }
  var fabricCache = [], fabricShapes = [];
  /* -> { w, h, rgb: Float32Array(w*h*3) linear }, seamless in both directions */
  function makeFabric(kind, colorLin, ppm, L, draft) {
    /* draft: for a picture that is only shown for a moment (the quick first frame); several times cheaper to build */
    var key = kind + '|' + colorLin.join(',') + '|' + ppm.toFixed(4) + '|' + L.lx.toFixed(4) + ',' + L.ly.toFixed(4) + ',' + L.lz.toFixed(4) + (draft ? '|d' : ''), i;
    for (i = 0; i < fabricCache.length; i++) if (fabricCache[i].key === key) return fabricCache[i].tile;
    var sp = FABRIC_SPECS[kind] || FABRIC_SPECS.jersey, nx = sp.nx, ny = sp.ny;
    while (nx * sp.px * ppm > 640 && nx > sp.mult * 2) nx -= sp.mult;
    while (ny * sp.py * ppm > 640 && ny > sp.mult * 2) ny -= sp.mult;
    nx = Math.max(sp.mult, Math.round(nx / sp.mult) * sp.mult); ny = Math.max(sp.mult, Math.round(ny / sp.mult) * sp.mult);
    var tw = Math.max(1, Math.round(nx * sp.px * ppm)), th = Math.max(1, Math.round(ny * sp.py * ppm));
    /* work at a resolution that resolves the yarns, then average down: small scales stay calm, not sparkly */
    var pitchPx = Math.min(sp.px, sp.py) * ppm, k = clamp(Math.ceil(20 / pitchPx), 1, 8), most = draft ? 560 : 1600;
    while (k > 1 && (tw * k > most || th * k > most)) k--;
    /* the shape of the weave does not depend on colour or light: it is kept, so that a colour picker or a light
       slider only pays for the lighting below (the shape is by far the slower half) */
    var W = tw * k, H = th * k, gkey = kind + '|' + nx + '|' + ny + '|' + W + '|' + H, geo = null, hgt, tint, weft;
    var res = [0, 0, 0], perX = nx * sp.px, perY = ny * sp.py, x, y, o;
    for (i = 0; i < fabricShapes.length; i++) if (fabricShapes[i].key === gkey) geo = fabricShapes[i];
    if (geo) { hgt = geo.hgt; tint = geo.tint; weft = geo.weft; }
    else {
      hgt = new Float32Array(W * H); tint = new Float32Array(W * H); weft = sp.weft ? new Float32Array(W * H) : null;
      for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
        fabricAt(kind, sp, nx, ny, (x + 0.5) / W * perX, (y + 0.5) / H * perY, res);
        o = y * W + x; hgt[o] = res[0]; tint[o] = res[1]; if (weft) weft[o] = res[2];
      }
      if (W * H <= 1200000) { fabricShapes.unshift({ key: gkey, hgt: hgt, tint: tint, weft: weft }); if (fabricShapes.length > 2) fabricShapes.pop(); }
    }
    var shade = new Float32Array(W * H), stepX = perX / W, stepY = perY / H, sx, sy, nl, sum = 0, amb = 0.42, xm, xp, ym, yp, hh;
    for (y = 0; y < H; y++) {
      ym = (y + H - 1) % H; yp = (y + 1) % H;
      for (x = 0; x < W; x++) {
        xm = (x + W - 1) % W; xp = (x + 1) % W; o = y * W + x; hh = hgt[o];
        sx = (hgt[y * W + xp] - hgt[y * W + xm]) * sp.bump / (2 * stepX); sy = (hgt[yp * W + x] - hgt[ym * W + x]) * sp.bump / (2 * stepY);
        nl = (-sx * L.lx - sy * L.ly + L.lz) / Math.sqrt(sx * sx + sy * sy + 1);
        nl = (amb + (1 - amb) * Math.max(0, nl) / L.lz) * (0.5 + 0.5 * hh) * tint[o];
        shade[o] = nl; sum += nl;
      }
    }
    var norm = 0.98 / (sum / (W * H)), rgb = new Float32Array(tw * th * 3), inv = 1 / (k * k), wr = 0.78, wg = 0.78, wb = 0.74, r, g, b, s, wm, xx, yy, oo, fz;
    for (y = 0; y < th; y++) for (x = 0; x < tw; x++) {
      r = g = b = 0;
      for (yy = 0; yy < k; yy++) for (xx = 0; xx < k; xx++) {
        oo = (y * k + yy) * W + x * k + xx; s = shade[oo] * norm;
        /* the fibres on top of a lit yarn scatter a little light whatever the dye: it is what lets you see the
           knit of a black T-shirt at all. On pale cloth it is far too little to notice. */
        fz = s > 0.85 ? (s - 0.85) * 0.022 : 0;
        if (weft && weft[oo]) {
          wm = sp.weft * weft[oo];
          r += s * (colorLin[0] * (1 - wm) + wr * wm) + fz; g += s * (colorLin[1] * (1 - wm) + wg * wm) + fz; b += s * (colorLin[2] * (1 - wm) + wb * wm) + fz;
        } else { r += s * colorLin[0] + fz; g += s * colorLin[1] + fz; b += s * colorLin[2] + fz; }
      }
      o = (y * tw + x) * 3; rgb[o] = r * inv; rgb[o + 1] = g * inv; rgb[o + 2] = b * inv;
    }
    /* when a yarn is only a pixel or two wide the weave cannot be drawn honestly: fade it towards its average
       colour instead of letting it shimmer */
    var keep = clamp((pitchPx - 1.1) / 2.2, 0, 1), n3 = tw * th, mr = 0, mg = 0, mb = 0;
    if (keep < 1) {
      for (o = 0; o < n3; o++) { mr += rgb[o * 3]; mg += rgb[o * 3 + 1]; mb += rgb[o * 3 + 2]; }
      mr /= n3; mg /= n3; mb /= n3;
      for (o = 0; o < n3; o++) { rgb[o * 3] = mr + (rgb[o * 3] - mr) * keep; rgb[o * 3 + 1] = mg + (rgb[o * 3 + 1] - mg) * keep; rgb[o * 3 + 2] = mb + (rgb[o * 3 + 2] - mb) * keep; }
    }
    var tile = { w: tw, h: th, rgb: rgb, periodMm: [perX, perY] };
    fabricCache.unshift({ key: key, tile: tile }); if (fabricCache.length > 6) fabricCache.pop();
    return tile;
  }
  /* the tile as RGBA bytes (for a canvas pattern or a CSS background) */
  function fabricTileBytes(kind, colorHex, ppm, lightAngle, lightElevation) {
    var c = parseColor(colorHex) || parseColor(DEFAULTS.fabricColor), L = lightVectors(isNum(lightAngle) ? lightAngle : DEFAULTS.lightAngle, isNum(lightElevation) ? lightElevation : DEFAULTS.lightElevation);
    var t = makeFabric(FABRICS.indexOf(kind) >= 0 ? kind : 'jersey', toLinear(c), clamp(Number(ppm) || 8, 0.2, 400), L), n = t.w * t.h, out = new Uint8ClampedArray(n * 4), i;
    for (i = 0; i < n; i++) {
      out[i * 4] = TO_BYTE[Math.min(OUT_N - 1, (t.rgb[i * 3] * OUT_SCALE) | 0)]; out[i * 4 + 1] = TO_BYTE[Math.min(OUT_N - 1, (t.rgb[i * 3 + 1] * OUT_SCALE) | 0)];
      out[i * 4 + 2] = TO_BYTE[Math.min(OUT_N - 1, (t.rgb[i * 3 + 2] * OUT_SCALE) | 0)]; out[i * 4 + 3] = 255;
    }
    return { width: t.w, height: t.h, data: out };
  }

  /* ---------- lookup tables for the thread shader ------------------------------------------ */
  var NZ_N = 128, NZ = new Float32Array(NZ_N + 1), ASIN = new Float32Array(NZ_N + 1);
  var END_N = 64, TAPER = new Float32Array(END_N + 1), SLOPE = new Float32Array(END_N + 1), SLOPE_INV = new Float32Array(END_N + 1), END_AO = new Float32Array(END_N + 1);
  var PLY = new Float32Array(256), TWIST_COS = Math.cos(0.4), TWIST_SIN = Math.sin(0.4);
  var POW_N = 256, SPEC_LUT = new Float32Array(POW_N + 1), DIF_LUT = new Float32Array(POW_N + 1), NH_LUT = new Float32Array(POW_N + 1);
  var SIN_N = 256, SIN = new Float32Array(SIN_N), FIB = new Float32Array(256);
  (function () {
    var i, v, t;
    for (i = 0; i <= NZ_N; i++) { v = i / NZ_N * 2 - 1; NZ[i] = Math.sqrt(Math.max(0, 1 - v * v)); ASIN[i] = Math.asin(clamp(v, -1, 1)); }
    for (i = 0; i <= END_N; i++) {
      t = i / END_N;
      /* TAPER and END_AO: t = distance from the needle hole / 0.45 mm. The thread narrows and darkens as it dives in. */
      TAPER[i] = 0.55 + 0.45 * Math.sqrt(1 - (1 - t) * (1 - t));
      END_AO[i] = 1 - 0.68 * Math.exp(-5 * t);
      /* SLOPE: t = distance from the hole / length of the arc. How steeply the thread climbs out of the hole. */
      SLOPE[i] = 0.95 * (1 - t) * (1 - t) + 0.5 * Math.exp(-9 * t);
      SLOPE_INV[i] = 1 / Math.sqrt(1 + SLOPE[i] * SLOPE[i]);
    }
    for (i = 0; i <= POW_N; i++) {
      t = i / POW_N;                                           /* t = (T.H)^2 or (T.L)^2 or N.H */
      SPEC_LUT[i] = Math.pow(1 - t, SPEC_POWER); DIF_LUT[i] = Math.sqrt(1 - t); NH_LUT[i] = 0.3 * Math.pow(t, 3) + 0.7 * Math.pow(t, 26);
    }
    for (i = 0; i < SIN_N; i++) SIN[i] = Math.sin(i / SIN_N * 2 * Math.PI);
    /* two plies twisted together: round backs with a narrow dark groove between them */
    for (i = 0; i < 256; i++) { t = 0.5 + 0.5 * Math.sin(i / 256 * 2 * Math.PI); PLY[i] = 1.04 - 0.24 * t * t * t * t; }
    for (i = 0; i < 256; i++) FIB[i] = rnd(i, 99) - 0.5;
  })();

  /* ---------- a job: everything fixed for one picture ---------------------------------------- */
  /*
   * view: { width, height, ppm, ox, oy }: canvas pixel = mm * ppm + (ox, oy). tile: tile edge in pixels.
   * opts: normalizeOptions() output. frame: { falloff } soft light falloff across the picture (0 = none).
   */
  function supersampleFor(ppm) { return clamp(Math.ceil(13 / ppm), 1, 4); }
  function createJob(c, view, opts, tile) {
    var o = opts && opts.warnings ? opts : normalizeOptions(opts);
    var L = lightVectors(o.lightAngle, o.lightElevation), ppm = view.ppm;
    var fabCol = toLinear(parseColor(o.fabricColor) || [232, 228, 220]);
    var job = {
      c: c, view: { width: view.width | 0, height: view.height | 0, ppm: ppm, ox: view.ox, oy: view.oy },
      o: o, L: L, ss: supersampleFor(ppm), tile: tile | 0 || 256,
      fabric: o.transparent ? null : makeFabric(o.fabric, fabCol, ppm, L, view.draft === true),
      falloff: view.falloff === undefined ? 0.05 : view.falloff,
      nbx: 0, nby: 0, bins: null, buf: null, bufSize: 0
    };
    job.nbx = Math.max(1, Math.ceil(job.view.width / job.tile)); job.nby = Math.max(1, Math.ceil(job.view.height / job.tile));
    /* which segments touch which tile, in sewing order */
    var nb = job.nbx * job.nby, counts = new Int32Array(nb), pad = (o.threadWidth * 1.6 + 0.5) * ppm + 2, i, x0, x1, y0, y1, tx, ty, T = job.tile, pass, lists = null, fill = null;
    for (pass = 0; pass < 2; pass++) {
      if (pass === 1) { lists = new Array(nb); fill = new Int32Array(nb); for (i = 0; i < nb; i++) lists[i] = new Int32Array(counts[i]); }
      for (i = 0; i < c.n; i++) {
        x0 = Math.min(c.ax[i], c.bx[i]) * ppm + view.ox - pad; x1 = Math.max(c.ax[i], c.bx[i]) * ppm + view.ox + pad;
        y0 = Math.min(c.ay[i], c.by[i]) * ppm + view.oy - pad; y1 = Math.max(c.ay[i], c.by[i]) * ppm + view.oy + pad;
        if (x1 < 0 || y1 < 0 || x0 >= job.view.width || y0 >= job.view.height) continue;
        x0 = clamp(Math.floor(x0 / T), 0, job.nbx - 1); x1 = clamp(Math.floor(x1 / T), 0, job.nbx - 1);
        y0 = clamp(Math.floor(y0 / T), 0, job.nby - 1); y1 = clamp(Math.floor(y1 / T), 0, job.nby - 1);
        for (ty = y0; ty <= y1; ty++) for (tx = x0; tx <= x1; tx++) {
          if (pass === 0) counts[ty * job.nbx + tx]++; else lists[ty * job.nbx + tx][fill[ty * job.nbx + tx]++] = i;
        }
      }
    }
    job.bins = lists;
    return job;
  }

  /* low-frequency unevenness of the cloth (not periodic), about +-3 % */
  function macroNoise(x, y, seed) {
    var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    var a = rnd(ix * 7919 + iy, seed), b = rnd((ix + 1) * 7919 + iy, seed), c = rnd(ix * 7919 + iy + 1, seed), d = rnd((ix + 1) * 7919 + iy + 1, seed);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy - 0.5;
  }

  /*
   * Render tile (tx, ty) of a job. Returns { x, y, w, h, data: Uint8ClampedArray RGBA (not premultiplied), stitched }.
   */
  function renderTile(job, tx, ty) {
    var T = job.tile, V = job.view, x0 = tx * T, y0 = ty * T, w = Math.min(T, V.width - x0), h = Math.min(T, V.height - y0);
    if (w <= 0 || h <= 0) return { x: x0, y: y0, w: 0, h: 0, data: new Uint8ClampedArray(0), stitched: false };
    var list = job.bins[ty * job.nbx + tx], c = job.c, o = job.o, L = job.L, ppm = V.ppm;
    var jumps = o.showJumps && c.jumps.length ? c.jumps : null;
    var S = (list.length || jumps) ? job.ss : 1, W = w * S, H = h * S, need = W * H * 4;
    if (job.bufSize < need) { job.buf = new Float32Array(need); job.bufSize = need; }
    var buf = job.buf, fab = job.fabric, transparent = !fab, loft = c.loft, seed = o.seed | 0;
    var x, y, i, p, q, xx, yy;

    /* ----- cloth ----- */
    var fr, fg, fb, fa, mmx, mmy, mac, sh, fo, cxp = V.width / 2, cyp = V.height / 2, diag = Math.sqrt(cxp * cxp + cyp * cyp) || 1;
    var fox = Math.round(V.ox), foy = Math.round(V.oy), ftw = fab ? fab.w : 1, fth = fab ? fab.h : 1, frgb = fab ? fab.rgb : null, fx, fy;
    var shOff = 0.9, shX = -L.lx * shOff, shY = -L.ly * shOff;
    /* the two octaves of macroNoise(), written out: the four corner values of a lattice cell are kept for as long
       as the pixels stay inside it (same numbers as macroNoise, a fraction of the time) */
    var s1 = seed + 7, s2 = seed + 8, u1, u2, i1, i2, c1 = 0, c2 = 0, f1, f2, r1y, r2y, j1, j2, n1a = 0, n1b = 0, n1c = 0, n1d = 0, n2a = 0, n2b = 0, n2c = 0, n2d = 0, have1, have2;
    for (y = 0; y < h; y++) {
      mmy = (y0 + y + 0.5 - V.oy) / ppm;
      u1 = mmy / 23; j1 = Math.floor(u1); r1y = u1 - j1; r1y = r1y * r1y * (3 - 2 * r1y);
      u2 = mmy / 6.5; j2 = Math.floor(u2); r2y = u2 - j2; r2y = r2y * r2y * (3 - 2 * r2y);
      have1 = have2 = false;
      fy = fab ? ((((y0 + y - foy) % fth) + fth) % fth) : 0;
      for (x = 0; x < w; x++) {
        mmx = (x0 + x + 0.5 - V.ox) / ppm;
        sh = 0;
        if (loft && mmx > loft.x0 && mmy > loft.y0 && mmx < loft.x0 + loft.w * loft.cell && mmy < loft.y0 + loft.h * loft.cell)
        { sh = 0.36 * sampleGrid(loft, loft.shadow, mmx + shX, mmy + shY) + 0.12 * sampleGrid(loft, loft.shadow, mmx, mmy) + 0.4 * Math.min(1, sampleGrid(loft, loft.layers, mmx, mmy)); if (sh > 0.8) sh = 0.8; }
        if (fab) {
          fx = (((x0 + x - fox) % ftw) + ftw) % ftw; p = (fy * ftw + fx) * 3;
          u1 = mmx / 23; i1 = Math.floor(u1);
          if (!have1 || i1 !== c1) { c1 = i1; have1 = true; n1a = rnd(i1 * 7919 + j1, s1); n1b = rnd((i1 + 1) * 7919 + j1, s1); n1c = rnd(i1 * 7919 + j1 + 1, s1); n1d = rnd((i1 + 1) * 7919 + j1 + 1, s1); }
          f1 = u1 - i1; f1 = f1 * f1 * (3 - 2 * f1);
          u2 = mmx / 6.5; i2 = Math.floor(u2);
          if (!have2 || i2 !== c2) { c2 = i2; have2 = true; n2a = rnd(i2 * 7919 + j2, s2); n2b = rnd((i2 + 1) * 7919 + j2, s2); n2c = rnd(i2 * 7919 + j2 + 1, s2); n2d = rnd((i2 + 1) * 7919 + j2 + 1, s2); }
          f2 = u2 - i2; f2 = f2 * f2 * (3 - 2 * f2);
          mac = 1 + 0.06 * ((n1a * (1 - f1) + n1b * f1) * (1 - r1y) + (n1c * (1 - f1) + n1d * f1) * r1y - 0.5)
                  + 0.026 * ((n2a * (1 - f2) + n2b * f2) * (1 - r2y) + (n2c * (1 - f2) + n2d * f2) * r2y - 0.5);
          mac *= 1 + job.falloff * ((x0 + x - cxp) * L.lx + (y0 + y - cyp) * L.ly) / diag;
          mac *= 1 - sh;
          fr = frgb[p] * mac; fg = frgb[p + 1] * mac; fb = frgb[p + 2] * mac; fa = 1;
        } else { fr = fg = fb = 0; fa = sh * 0.8; }
        if (S === 1) { q = (y * W + x) * 4; buf[q] = fr; buf[q + 1] = fg; buf[q + 2] = fb; buf[q + 3] = fa; }
        else for (yy = 0; yy < S; yy++) for (xx = 0; xx < S; xx++) { q = ((y * S + yy) * W + x * S + xx) * 4; buf[q] = fr; buf[q + 1] = fg; buf[q + 2] = fb; buf[q + 3] = fa; }
      }
    }

    /* ----- thread ----- */
    var sc = ppm * S, bx0 = x0 * S, by0 = y0 * S;                 /* supersampled pixel = mm * sc + V.o* * S - b*0 */
    var offx = V.ox * S - bx0, offy = V.oy * S - by0;
    var rBase = o.threadWidth * 0.5 * sc, arcPx = 1.4 * sc, endK = END_N / (0.45 * sc), holeR = 0.2 * sc;
    var twistK = 256 / (0.8 * sc);                               /* a ply groove every 0.8 mm along the thread */
    var ca = TWIST_COS, sa = TWIST_SIN, ai, gi, lz = L.lz, hz = L.hz;
    var n = list.length, li, si, ax, ay, bxp, byp, dx, dy, len, tX, tY, r, rr, rv, bright, col, cr, cg, cb, sr, sg, sb;
    var tl0, th0, pl, ph, layers, m, so, offU, offD, R, E, ya, yb, xa, xb, u0, d0, lo, hi, a1, a2, u, d, au, e, ei, cov, v, vi, nz, sl, inv, tl, th, dif, spec, nl, nh, g, I, k, su, sd, asd, f, ef, endScale, phase, fibSalt, amb = 0.26, kd = 0.82, ks = 1.3, ksS, shortK, flat, flat2, plF, phF, nzf, wrap = 0.3, smax, cc, hx, hy, hr2, dd, ha;
    for (li = 0; li < n; li++) {
      si = list[li];
      ax = c.ax[si] * sc + offx; ay = c.ay[si] * sc + offy; bxp = c.bx[si] * sc + offx; byp = c.by[si] * sc + offy;
      dx = bxp - ax; dy = byp - ay; len = Math.sqrt(dx * dx + dy * dy); if (len < 1e-3) continue;
      tX = dx / len; tY = dy / len;
      rv = rnd(si, seed); r = rBase * (0.9 + 0.2 * rv) * (c.squeeze ? c.squeeze[si] : 1);
      bright = 0.93 + 0.14 * rnd(si, seed ^ 0x1234567);
      /* very short stitches are tie-offs: tiny, pulled tight, nothing for the light to catch */
      shortK = len / (0.9 * sc); if (shortK < 1) { if (shortK < 0.45) shortK = 0.45; r *= 0.6 + 0.4 * shortK; } else shortK = 1;
      /* each stitch catches the light at a very slightly different angle: this is what makes satin shimmer */
      k = (rnd(si, seed ^ 0x7654321) - 0.5) * 0.24;
      tl0 = (tX - tY * k) * L.lx + (tY + tX * k) * L.ly; th0 = (tX - tY * k) * L.hx + (tY + tX * k) * L.hy;
      /* packed threads show their tops, not their flanks: the rounder profile is kept for threads lying free */
      flat = c.squeeze && c.squeeze[si] < 1 ? 0.15 + 0.85 * (c.squeeze[si] - 0.78) / 0.22 : 1; flat2 = flat * flat;
      pl = -tY * L.lx + tX * L.ly; ph = -tY * L.hx + tX * L.hy; plF = pl * flat; phF = ph * flat;   /* the across-the-thread direction against light and half vector */
      col = c.thread[si] * 3; if (col >= c.colors.length) col = 0;
      cr = c.colors[col] * 0.97 + 0.012; cg = c.colors[col + 1] * 0.97 + 0.012; cb = c.colors[col + 2] * 0.97 + 0.012;   /* lit thread is about as bright as lit cloth of its colour: white thread on white cloth must not come out grey */
      sr = cr * 0.55 + 0.42; sg = cg * 0.55 + 0.42; sb = cb * 0.55 + 0.42;     /* highlight: the thread's colour, washed towards white */
      layers = loft ? sampleGrid(loft, loft.layers, (c.ax[si] + c.bx[si]) * 0.5, (c.ay[si] + c.by[si]) * 0.5) : 1;
      if (layers > 3) layers = 3;
      m = (0.13 + 0.06 * layers) * sc; so = (0.05 + 0.05 * layers) * sc; smax = 0.42 * shortK * shortK;
      offU = -(L.lx * tX + L.ly * tY) * so; offD = -(-L.lx * tY + L.ly * tX) * so;
      R = r + m + (offD < 0 ? -offD : offD) + 1; E = m + (offU < 0 ? -offU : offU) + 1;
      endScale = END_N / Math.min(arcPx, len * 0.5);
      /* some stitches lie a little prouder or flatter than their neighbours and flash, others stay dull */
      ksS = rnd(si, seed ^ 0x3c6ef35); ksS = ks * (0.55 + 1.0 * ksS * ksS) * (shortK < 1 ? shortK * shortK * shortK : 1);
      phase = rnd(si, seed ^ 0x2468ace) * 256; fibSalt = (hash2(si, seed ^ 0x13579b) & 255);

      /* needle hole where this stitch starts (the previous stitch dives into the same hole) */
      hr2 = holeR * holeR;
      ya = Math.max(0, Math.ceil(ay - holeR - 0.5)); yb = Math.min(H - 1, Math.floor(ay + holeR - 0.5));
      xa = Math.max(0, Math.ceil(ax - holeR - 0.5)); xb = Math.min(W - 1, Math.floor(ax + holeR - 0.5));
      for (y = ya; y <= yb; y++) for (x = xa; x <= xb; x++) {
        hx = x + 0.5 - ax; hy = y + 0.5 - ay; dd = hx * hx + hy * hy;
        if (dd < hr2) { ha = 1 - dd / hr2; ha = 1 - 0.5 * shortK * ha * ha; q = (y * W + x) * 4; buf[q] *= ha; buf[q + 1] *= ha; buf[q + 2] *= ha; buf[q + 3] = 1 - (1 - buf[q + 3]) * ha; }
      }

      ya = Math.max(0, Math.ceil((ay < byp ? ay : byp) - R - E - 0.5)); yb = Math.min(H - 1, Math.floor((ay > byp ? ay : byp) + R + E - 0.5));
      for (y = ya; y <= yb; y++) {
        /* the pixels of this row that can lie inside the stitch plus its shadow */
        u0 = (y + 0.5 - ay) * tY; d0 = (y + 0.5 - ay) * tX;
        lo = -1e9; hi = 1e9;
        if (tY > 1e-6 || tY < -1e-6) { a1 = (d0 - R) / tY; a2 = (d0 + R) / tY; if (a1 > a2) { k = a1; a1 = a2; a2 = k; } lo = a1; hi = a2; }
        else if (d0 > R || d0 < -R) continue;
        if (tX > 1e-6 || tX < -1e-6) { a1 = (-E - u0) / tX; a2 = (len + E - u0) / tX; if (a1 > a2) { k = a1; a1 = a2; a2 = k; } if (a1 > lo) lo = a1; if (a2 < hi) hi = a2; }
        else if (u0 < -E || u0 > len + E) continue;
        xa = Math.ceil(lo + ax - 0.5); if (xa < 0) xa = 0;
        xb = Math.floor(hi + ax - 0.5); if (xb > W - 1) xb = W - 1;
        if (xa > xb) continue;
        u = u0 + (xa + 0.5 - ax) * tX; d = d0 - (xa + 0.5 - ax) * tY;
        q = (y * W + xa) * 4;
        for (x = xa; x <= xb; x++, q += 4, u += tX, d -= tY) {
          cov = 0;
          if (u > -0.5 && u < len + 0.5) {
            e = u < len - u ? u : len - u;                         /* distance to the nearer needle hole */
            ei = e <= 0 ? 0 : (e * endScale) | 0; if (ei > END_N) ei = END_N;
            ai = e <= 0 ? 0 : (e * endK) | 0; if (ai > END_N) ai = END_N;
            rr = r * TAPER[ai];
            au = d < 0 ? -d : d;
            cov = rr >= 0.5 ? rr - au + 0.5 : (au < 0.5 + rr ? 2 * rr * (1 - au / (0.5 + rr)) : 0);
            if (cov > 0) {
              if (cov > 1) cov = 1;
              if (e < 0.5) cov *= e + 0.5;
              v = d / rr; if (v > 1) v = 1; else if (v < -1) v = -1;
              vi = ((v + 1) * 0.5 * NZ_N) | 0; nz = NZ[vi];
              sl = u < len - u ? SLOPE[ei] : -SLOPE[ei]; inv = SLOPE_INV[ei];
              /* the filaments wind round the thread, so what catches the light is the thread's direction turned by
                 the twist angle: that is why a real highlight sits as short slanted dashes, not one straight line */
              tl = ca * (tl0 + sl * lz) * inv + sa * (v * lz - nz * pl); th = ca * (th0 + sl * hz) * inv + sa * (v * hz - nz * ph);
              tl *= tl; th *= th; if (tl > 1) tl = 1; if (th > 1) th = 1;
              dif = DIF_LUT[(tl * POW_N) | 0]; spec = SPEC_LUT[(th * POW_N) | 0];
              nzf = 1 - flat2 * (1 - nz);
              nl = (v * plF + nzf * lz * inv + wrap) / (1 + wrap); if (nl < 0) nl = 0;
              nh = v * phF + nzf * hz * inv; if (nh < 0) nh = 0; else if (nh > 1) nh = 1;
              gi = u * twistK + ASIN[vi] * 81.5 + phase;
              g = PLY[(gi | 0) & 255];                              /* the groove between the two plies */
              f = FIB[(((gi * 0.034) | 0) + fibSalt) & 255];        /* single filaments, lying along the plies */
              I = (amb + kd * dif * nl) * g * END_AO[ai] * bright * (1 + 0.22 * f);
              k = ksS * spec * NH_LUT[(nh * POW_N) | 0] * g * END_AO[ai] * bright * (1 + 0.5 * f);
              cc = 1 - cov;
              buf[q] = buf[q] * cc + (cr * I + sr * k) * cov; buf[q + 1] = buf[q + 1] * cc + (cg * I + sg * k) * cov; buf[q + 2] = buf[q + 2] * cc + (cb * I + sb * k) * cov;
              buf[q + 3] = buf[q + 3] * cc + cov;
              if (cov >= 1) continue;
            } else cov = 0;
          }
          /* the stitch's own small shadow on whatever lies beneath it */
          /* on bare cloth it falls away from the light; on thread already sewn it stays close (neighbours in a
             satin lie at the same height: what shows there is the crease between them, whichever way the light is,
             and it must not depend on the order of sewing) */
          k = 1 - 0.85 * buf[q + 3]; su = u - offU * k; sd = d - offD * k; asd = sd < 0 ? -sd : sd;
          if (asd < r + m && su > -m && su < len + m) {
            f = 1 - (asd - r * 0.45) / (m + r * 0.55); if (f > 1) f = 1;
            ef = su < 0 ? 1 + su / m : su > len ? 1 - (su - len) / m : 1;
            f = 1 - smax * f * f * ef * (1 - cov);
            buf[q] *= f; buf[q + 1] *= f; buf[q + 2] *= f; buf[q + 3] = 1 - (1 - buf[q + 3]) * f;
          }
        }
      }
    }

    /* ----- jumps (off by default: they are cut away on the real garment) ----- */
    if (jumps) {
      var jr = Math.max(0.6, 0.09 * sc), jn = jumps.length / 5, ji, jc;
      for (ji = 0; ji < jn; ji++) {
        ax = jumps[ji * 5] * sc + offx; ay = jumps[ji * 5 + 1] * sc + offy; bxp = jumps[ji * 5 + 2] * sc + offx; byp = jumps[ji * 5 + 3] * sc + offy;
        if ((ax < -4 && bxp < -4) || (ay < -4 && byp < -4) || (ax > W + 4 && bxp > W + 4) || (ay > H + 4 && byp > H + 4)) continue;
        dx = bxp - ax; dy = byp - ay; len = Math.sqrt(dx * dx + dy * dy); if (len < 1e-3) continue;
        tX = dx / len; tY = dy / len; jc = jumps[ji * 5 + 4] * 3; if (jc >= c.colors.length) jc = 0;
        cr = c.colors[jc] * 0.8 + 0.02; cg = c.colors[jc + 1] * 0.8 + 0.02; cb = c.colors[jc + 2] * 0.8 + 0.02;
        R = jr + 1;
        ya = Math.max(0, Math.ceil((ay < byp ? ay : byp) - R - 0.5)); yb = Math.min(H - 1, Math.floor((ay > byp ? ay : byp) + R - 0.5));
        for (y = ya; y <= yb; y++) {
          u0 = (y + 0.5 - ay) * tY; d0 = (y + 0.5 - ay) * tX; lo = -1e9; hi = 1e9;
          if (tY > 1e-6 || tY < -1e-6) { a1 = (d0 - R) / tY; a2 = (d0 + R) / tY; if (a1 > a2) { k = a1; a1 = a2; a2 = k; } lo = a1; hi = a2; } else if (d0 > R || d0 < -R) continue;
          if (tX > 1e-6 || tX < -1e-6) { a1 = (-u0) / tX; a2 = (len - u0) / tX; if (a1 > a2) { k = a1; a1 = a2; a2 = k; } if (a1 > lo) lo = a1; if (a2 < hi) hi = a2; } else if (u0 < 0 || u0 > len) continue;
          xa = Math.ceil(lo + ax - 0.5); if (xa < 0) xa = 0; xb = Math.floor(hi + ax - 0.5); if (xb > W - 1) xb = W - 1;
          for (x = xa; x <= xb; x++) {
            d = d0 - (x + 0.5 - ax) * tY; au = d < 0 ? -d : d; cov = jr - au + 0.5; if (cov <= 0) continue; if (cov > 1) cov = 1;
            cov *= 0.42; cc = 1 - cov; q = (y * W + x) * 4;
            buf[q] = buf[q] * cc + cr * cov; buf[q + 1] = buf[q + 1] * cc + cg * cov; buf[q + 2] = buf[q + 2] * cc + cb * cov; buf[q + 3] = buf[q + 3] * cc + cov;
          }
        }
      }
    }

    /* ----- average down, to display bytes ----- */
    var out = new Uint8ClampedArray(w * h * 4), r1, g1, b1, a1v, invS = 1 / (S * S), qo, dn;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      if (S === 1) { q = (y * W + x) * 4; r1 = buf[q]; g1 = buf[q + 1]; b1 = buf[q + 2]; a1v = buf[q + 3]; }
      else {
        r1 = g1 = b1 = a1v = 0;
        for (yy = 0; yy < S; yy++) { q = ((y * S + yy) * W + x * S) * 4; for (xx = 0; xx < S; xx++, q += 4) { r1 += buf[q]; g1 += buf[q + 1]; b1 += buf[q + 2]; a1v += buf[q + 3]; } }
        r1 *= invS; g1 *= invS; b1 *= invS; a1v *= invS;
      }
      qo = (y * w + x) * 4;
      if (transparent) {
        if (a1v > 0.002) { r1 /= a1v; g1 /= a1v; b1 /= a1v; } else { r1 = g1 = b1 = 0; a1v = 0; }
        out[qo + 3] = a1v * 255 + 0.5;
      } else out[qo + 3] = 255;
      /* a hair of noise so smooth cloth does not band */
      dn = ((hash2(x0 + x, y0 + y) & 255) - 127.5) * (0.6 / 255 / 255);
      i = ((r1 + dn) * OUT_SCALE) | 0; out[qo] = TO_BYTE[i < 0 ? 0 : i >= OUT_N ? OUT_N - 1 : i];
      i = ((g1 + dn) * OUT_SCALE) | 0; out[qo + 1] = TO_BYTE[i < 0 ? 0 : i >= OUT_N ? OUT_N - 1 : i];
      i = ((b1 + dn) * OUT_SCALE) | 0; out[qo + 2] = TO_BYTE[i < 0 ? 0 : i >= OUT_N ? OUT_N - 1 : i];
    }
    return { x: x0, y: y0, w: w, h: h, data: out, stitched: n > 0 };
  }

  /* rough cost of a picture in supersampled pixel visits (used to decide whether a quick first frame is worth it) */
  function estimateCost(c, view, opts) {
    var ss = supersampleFor(view.ppm), sc = view.ppm * ss, tw = ((opts && opts.threadWidth) || 0.38), i, len = 0, step = Math.max(1, Math.floor(c.n / 4000));
    for (i = 0; i < c.n; i += step) len += Math.abs(c.bx[i] - c.ax[i]) + Math.abs(c.by[i] - c.ay[i]);
    len = len * (c.n / Math.max(1, Math.ceil(c.n / step))) * 0.8;
    return len * sc * (tw + 0.6) * sc + view.width * view.height;
  }

  return {
    version: '1.0.0', OP: OP, FABRICS: FABRICS, SCENES: SCENES, GARMENTS: GARMENTS, PLACEMENTS: PLACEMENTS, DEFAULTS: DEFAULTS, FABRIC_SPECS: FABRIC_SPECS,
    hash2: hash2, rnd: rnd, parseColor: parseColor, toLinear: toLinear, lightVectors: lightVectors, sheen: sheen,
    normalizeOptions: normalizeOptions, compile: compile, computeLoft: computeLoft, sampleGrid: sampleGrid,
    makeFabric: makeFabric, fabricTileBytes: fabricTileBytes, supersampleFor: supersampleFor,
    createJob: createJob, renderTile: renderTile, estimateCost: estimateCost
  };
});
