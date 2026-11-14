/*
 * trace.js - picture in, stitchable coloured shapes out. Contract: js/trace/API.md.
 *
 *   Trace.trace(image, options?, hooks?)        ImageData-like -> { objects, colors, size, stats, warnings }
 *   Trace.traceAsync(image, options?, hooks?)   the same as a Promise that lets the page breathe (main thread)
 *   Trace.toPolygon(rings)                      outer ring + holes -> ONE closed point list (keyhole cuts)
 *   Trace.toEditorObjects(result)               the objects in the shape js/editor/model.js stores
 *
 * The objects are input for Engine.generate (js/engine): type 'path' with rings (first ring = outline,
 * further rings = holes) for fills, type 'polyline' for hairlines. Millimetres, y down.
 *
 * Loads three ways, no bundler, no dependencies:
 *   page:    <script src="js/trace/trace.js">      -> window.Trace   (client.js adds Trace.createClient)
 *   worker:  importScripts('trace.js')             -> self.Trace     (this is what worker.js does)
 *   node:    const Trace = require('./js/trace/trace.js')
 *
 * Everything runs in the visitor's browser. Nothing here talks to a server. All code in this file was
 * written for this project; the ideas (crack-following outlines, corner-aware smoothing, speck removal,
 * colour clustering in a perceptual space, underlap between colours) are the usual ones of tracing and
 * auto-digitizing software.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    const made = factory(), old = root.Trace;
    if (old && typeof old === 'object') for (const k in old) if (!(k in made)) made[k] = old[k];
    root.Trace = made;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.1.0';
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  const DEFAULTS = {
    width: 100,            // mm, finished width of the picture; the height follows the picture's shape
    colors: 6,             // most thread colours to use, or 'auto': the fewest that show the picture well (see chooseColours)
    maxColors: 10,         // with colors 'auto': never more than this
    detail: 'medium',      // 'low' | 'medium' | 'high'
    background: 'auto',    // 'auto' | 'on' | 'off'  (remove the background?)
    mode: 'auto',          // 'auto' | 'logo' | 'photo'
    holes: true,           // when a background is removed, also remove areas of that colour enclosed by the design
    outline: false,        // add a thin running-stitch outline in the darkest colour (logos)
    x: 0, y: 0,            // mm, where the top-left corner of the picture goes
    hoop: null,            // { width, height } mm: centre the picture in it (unless x / y are given) and warn if it does not fit
  };
  const LIMITS = {
    width: [10, 400], colors: [2, 30],
    inputPixels: 40e6,     // refuse pictures larger than this (downsample with a canvas first, see API.md)
    workPixels: 1400000,   // the working raster never exceeds this; resolution is lowered for huge designs
    objects: 1500,         // more shapes than this are not returned (the smallest are dropped)
  };
  /* Per detail level. mmpp: working resolution; minArea: smallest sewable area for flat art, mm2;
     photoArea: the same for photographs (bigger, or the result is confetti); tol: outline tolerance, mm. */
  const DETAIL = {
    low:    { mmpp: 0.28, minArea: 3.0, photoArea: 10, tol: 0.16, photoIter: 4, maxRegions: 140 },
    medium: { mmpp: 0.22, minArea: 1.6, photoArea: 5.5, tol: 0.13, photoIter: 3, maxRegions: 260 },
    high:   { mmpp: 0.18, minArea: 1.0, photoArea: 3.0, tol: 0.10, photoIter: 2, maxRegions: 420 },
  };
  const SEW = {
    satinMaxWidth: 3.6,    // mm: bands of even width up to this are sewn as satin columns along their middle
    lineMaxWidth: 1.0,     // mm: anything narrower cannot hold a fill and is sewn as a line along its middle
    lineMinLength: 2.2,    // mm: shorter thin bits are not worth a line
    satinPull: 0,          // mm added to the width of satin columns (the engine already adds its own pull compensation)
    fullSpread: 0.3,       // OKLab: pictures whose colours span less than this get all colour thresholds scaled down
    inkCore: 0.08,        // a colour with less than this share of its pixels 0.5 mm or more inside it is 'thin everywhere'
    inkTouch: 0.2,        // share of such a colour's edge that must lie against the darker colour it is a paler shade of
    inkOff: 0.04,         // OKLab: how far it may sit off the straight mix of background and that colour
    overShare: 0.06,       // a line lies "on" another colour's fill when this share of it does (more would let that fill cut it)
    borderShare: 0.6,      // drawings: share of the picture's edge one plain colour needs to count as the background
    smallPrint: 3.2,       // mm: tangles of hairlines lower than this (tiny lettering) are left out
    runBelow: 0.35,        // mm: thinner source lines get a single running stitch, wider ones a bean stitch
    blendsAbove: 12,       // flat art traced with more colours than this: edge blends are not given a colour (withoutBlends)
    blendTexture: true,    // texture finer than thread can show is blended to its average colour
    inlaidShare: 0.3,      // a fill with at least this share of its edge against earlier fills is sewn without underlay
    underlap: 0.45,        // mm: how far an earlier colour reaches under the colours sewn after it
    holeFill: 4.0,         // mm2: holes smaller than this under a later colour are simply filled over
    fillSpacing: 0.4, fillStitch: 3.0, lineStitch: 2.0,
  };

  /* Brother PEC thread chart (index 1..64), the threads a PES v1 file can name. Plain data. */
  const THREADS = [
    [14, 31, 124, 'Prussian Blue'], [10, 85, 163, 'Blue'], [0, 135, 119, 'Teal Green'], [75, 107, 175, 'Cornflower Blue'],
    [237, 23, 31, 'Red'], [209, 92, 0, 'Reddish Brown'], [145, 54, 151, 'Magenta'], [228, 154, 203, 'Light Lilac'],
    [145, 95, 172, 'Lilac'], [158, 214, 125, 'Mint Green'], [232, 169, 0, 'Deep Gold'], [254, 186, 53, 'Orange'],
    [255, 255, 0, 'Yellow'], [112, 188, 31, 'Lime Green'], [186, 152, 0, 'Brass'], [168, 168, 168, 'Silver'],
    [125, 111, 0, 'Russet Brown'], [255, 255, 179, 'Cream Brown'], [79, 85, 86, 'Pewter'], [0, 0, 0, 'Black'],
    [11, 61, 145, 'Ultramarine'], [119, 1, 118, 'Royal Purple'], [41, 49, 51, 'Dark Gray'], [42, 19, 1, 'Dark Brown'],
    [246, 74, 138, 'Deep Rose'], [178, 118, 36, 'Light Brown'], [252, 187, 197, 'Salmon Pink'], [254, 55, 15, 'Vermilion'],
    [240, 240, 240, 'White'], [106, 28, 138, 'Violet'], [168, 221, 196, 'Seacrest'], [37, 132, 187, 'Sky Blue'],
    [254, 179, 67, 'Pumpkin'], [255, 243, 107, 'Cream Yellow'], [208, 166, 96, 'Khaki'], [209, 84, 0, 'Clay Brown'],
    [102, 186, 73, 'Leaf Green'], [19, 74, 70, 'Peacock Blue'], [135, 135, 135, 'Gray'], [216, 204, 198, 'Warm Gray'],
    [67, 86, 7, 'Dark Olive'], [253, 217, 222, 'Flesh Pink'], [249, 147, 188, 'Pink'], [0, 56, 34, 'Deep Green'],
    [178, 175, 212, 'Lavender'], [104, 106, 176, 'Wisteria Violet'], [239, 227, 185, 'Beige'], [247, 56, 102, 'Carmine'],
    [181, 75, 100, 'Amber Red'], [19, 43, 26, 'Olive Green'], [199, 1, 86, 'Dark Fuchsia'], [254, 158, 50, 'Tangerine'],
    [168, 222, 235, 'Light Blue'], [0, 103, 62, 'Emerald Green'], [78, 41, 144, 'Purple'], [47, 126, 32, 'Moss Green'],
    [255, 204, 204, 'Flesh Pink'], [255, 217, 17, 'Harvest Gold'], [9, 91, 166, 'Electric Blue'], [240, 249, 112, 'Lemon Yellow'],
    [227, 243, 91, 'Fresh Green'], [255, 153, 0, 'Orange'], [255, 240, 141, 'Cream Yellow'], [255, 200, 200, 'Applique'],
  ];

  let SPREADK_FORCE = 0;
  const INTERNAL = { hook: null };      // tests may set hook(stage, data) to look inside a run
  function makeError(code, message) { const e = new Error(message); e.code = code; return e; }

  // ====================================================================== colour maths
  const SRGB_LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; SRGB_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function linOf(v) { // v 0..255 float, linear interpolation in the table
    if (v <= 0) return 0; if (v >= 255) return 1;
    const i = v | 0, f = v - i; return SRGB_LIN[i] + (SRGB_LIN[i + 1] - SRGB_LIN[i]) * f;
  }
  function rgbToLab(r, g, b, out, o) {
    const R = linOf(r), G = linOf(g), B = linOf(b);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    out[o] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    out[o + 1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  }
  function gammaOf(v) { v = v <= 0 ? 0 : v >= 1 ? 1 : v; return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); }
  function labToRgb(L, a, b) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    return [gammaOf(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), gammaOf(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), gammaOf(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)];
  }
  const hex2 = v => (v < 16 ? '0' : '') + v.toString(16);
  const hexOf = rgb => '#' + hex2(rgb[0]) + hex2(rgb[1]) + hex2(rgb[2]);

  function colorName(L, a, b) {
    const C = Math.hypot(a, b);
    if (C < 0.035) return L < 0.22 ? 'Black' : L < 0.5 ? 'Dark grey' : L < 0.78 ? 'Grey' : L < 0.94 ? 'Light grey' : 'White';
    let h = Math.atan2(b, a) * 180 / Math.PI; if (h < 0) h += 360;
    let base;
    if (h < 12 || h >= 335) base = L > 0.68 ? 'Pink' : 'Red';
    else if (h < 42) base = L > 0.78 ? 'Pink' : 'Red';
    else if (h < 78) base = L < 0.55 ? 'Brown' : (C < 0.07 && L > 0.8 ? 'Beige' : 'Orange');
    else if (h < 118) base = L < 0.6 ? 'Olive' : (C < 0.07 && L > 0.85 ? 'Cream' : 'Yellow');
    else if (h < 165) base = 'Green';
    else if (h < 215) base = 'Teal';
    else if (h < 280) base = L < 0.33 ? 'Navy' : 'Blue';
    else if (h < 318) base = 'Purple';
    else base = L > 0.66 ? 'Pink' : 'Magenta';
    if (base === 'Navy' || base === 'Brown' || base === 'Olive' || base === 'Beige' || base === 'Cream' || base === 'Pink') return (base === 'Brown' || base === 'Olive') && L < 0.33 ? 'Dark ' + base.toLowerCase() : base;
    if (L > 0.82) return 'Light ' + base.toLowerCase();
    if (L < 0.42) return 'Dark ' + base.toLowerCase();
    return base;
  }
  /* Same colour distance the engine's PES writer uses to pick a chart thread (weighted RGB, "redmean"). */
  function nearestThread(rgb) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < THREADS.length; i++) {
      const t = THREADS[i], rm = Math.round((rgb[0] + t[0]) / 2), r = rgb[0] - t[0], g = rgb[1] - t[1], b = rgb[2] - t[2];
      const d = (((512 + rm) * r * r) >> 8) + 4 * g * g + (((767 - rm) * b * b) >> 8);
      if (d <= bestD) { bestD = d; best = i; }
    }
    const t = THREADS[best];
    return { chart: 'Brother', index: best + 1, name: t[3], hex: hexOf(t) };
  }

  // ====================================================================== options
  function normalizeOptions(o, warnings) {
    o = (o && typeof o === 'object') ? o : {};
    const out = {};
    const bad = (param, value, used) => warnings.push({ code: 'INVALID_OPTION', severity: 'info', param, value: String(value), message: 'The setting "' + param + '" was not understood, so ' + used + ' was used.' });
    const num = (k, lo, hi, integer) => {
      let v = o[k];
      if (v === undefined || v === null) return DEFAULTS[k];
      if (typeof v !== 'number' || !isFinite(v)) { bad(k, v, DEFAULTS[k]); return DEFAULTS[k]; }
      const c = Math.min(hi, Math.max(lo, integer ? Math.round(v) : v));
      if (c !== v) bad(k, v, c);
      return c;
    };
    const pick = (k, list) => {
      const v = o[k];
      if (v === undefined || v === null) return DEFAULTS[k];
      if (list.indexOf(v) === -1) { bad(k, v, '"' + DEFAULTS[k] + '"'); return DEFAULTS[k]; }
      return v;
    };
    out.width = num('width', LIMITS.width[0], LIMITS.width[1], false);
    out.maxColors = num('maxColors', LIMITS.colors[0], LIMITS.colors[1], true);
    if (o.colors === 'auto') out.colors = 'auto';
    else out.colors = num('colors', LIMITS.colors[0], LIMITS.colors[1], true);
    out.detail = pick('detail', ['low', 'medium', 'high']);
    if (o.background === true || o.background === false) out.background = o.background ? 'on' : 'off';
    else out.background = pick('background', ['auto', 'on', 'off']);
    out.mode = pick('mode', ['auto', 'logo', 'photo']);
    out.holes = o.holes === undefined ? DEFAULTS.holes : !!o.holes;
    out.outline = !!o.outline;
    out.hoop = null;
    if (o.hoop !== undefined && o.hoop !== null) {
      const hw = o.hoop && Number(o.hoop.width), hh = o.hoop && Number(o.hoop.height);
      if (isFinite(hw) && isFinite(hh) && hw >= 10 && hh >= 10 && hw <= 1000 && hh <= 1000) out.hoop = { width: hw, height: hh };
      else bad('hoop', JSON.stringify(o.hoop), 'no hoop');
    }
    const pos = k => {
      const v = o[k];
      if (v === undefined || v === null) return null;
      if (typeof v !== 'number' || !isFinite(v) || Math.abs(v) > 2000) { bad(k, v, 'the default'); return null; }
      return v;
    };
    out.x = pos('x'); out.y = pos('y');
    return out;
  }

  // ====================================================================== 1. prepare
  /* Weights for resampling n source samples to m: box average when shrinking, linear when enlarging. */
  function resampleTable(n, m) {
    const start = new Int32Array(m), count = new Int32Array(m), scale = n / m;
    const maxTaps = Math.max(2, Math.ceil(scale) + 1), w = new Float32Array(m * maxTaps);
    for (let i = 0; i < m; i++) {
      if (scale > 1) {
        const a = i * scale, b = Math.min(n, (i + 1) * scale);
        let s = Math.floor(a), e = Math.min(n, Math.ceil(b)), k = 0, sum = 0;
        if (e <= s) e = Math.min(n, s + 1);
        start[i] = s;
        for (let j = s; j < e && k < maxTaps; j++, k++) { const c = Math.max(0, Math.min(b, j + 1) - Math.max(a, j)); w[i * maxTaps + k] = c; sum += c; }
        count[i] = k;
        if (sum <= 0) { w[i * maxTaps] = 1; sum = 1; count[i] = 1; }
        for (let j = 0; j < k; j++) w[i * maxTaps + j] /= sum;
      } else {
        const c = (i + 0.5) * scale - 0.5; let s = Math.floor(c), f = c - s;
        if (s < 0) { s = 0; f = 0; }
        if (s >= n - 1) { s = Math.max(0, n - 1); start[i] = s; count[i] = 1; w[i * maxTaps] = 1; continue; }
        start[i] = s; count[i] = 2; w[i * maxTaps] = 1 - f; w[i * maxTaps + 1] = f;
      }
    }
    return { start, count, w, maxTaps };
  }
  /* RGBA (straight alpha) sw x sh  ->  premultiplied float RGBA W x H. */
  function resample(data, sw, sh, W, H) {
    const tx = resampleTable(sw, W), ty = resampleTable(sh, H);
    const mid = new Float32Array(W * sh * 4);
    for (let y = 0; y < sh; y++) {
      const row = y * sw * 4, orow = y * W * 4;
      for (let x = 0; x < W; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        const s = tx.start[x], c = tx.count[x], wo = x * tx.maxTaps;
        for (let k = 0; k < c; k++) {
          const p = row + (s + k) * 4, wt = tx.w[wo + k], al = data[p + 3] * wt;
          r += data[p] * al; g += data[p + 1] * al; b += data[p + 2] * al; a += al;
        }
        const o = orow + x * 4; mid[o] = r; mid[o + 1] = g; mid[o + 2] = b; mid[o + 3] = a;
      }
    }
    const out = new Float32Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      const s = ty.start[y], c = ty.count[y], wo = y * ty.maxTaps, orow = y * W * 4;
      for (let k = 0; k < c; k++) {
        const wt = ty.w[wo + k], row = (s + k) * W * 4;
        for (let i = 0; i < W * 4; i++) out[orow + i] += mid[row + i] * wt;
      }
    }
    return out; // r*a, g*a, b*a (a 0..255), a
  }

  function prepare(image, opt, D) {
    const sw = image.width, sh = image.height;
    const heightMm = opt.width * sh / sw;
    let mmpp = D.mmpp;
    let W = Math.max(1, Math.round(opt.width / mmpp)), H = Math.max(1, Math.round(heightMm / mmpp));
    let reduced = false;
    if (W * H > LIMITS.workPixels) {
      const f = Math.sqrt(W * H / LIMITS.workPixels); mmpp *= f; reduced = true;
      W = Math.max(1, Math.round(opt.width / mmpp)); H = Math.max(1, Math.round(heightMm / mmpp));
    }
    const pm = resample(image.data, sw, sh, W, H);
    const N = W * H, L = new Float32Array(N), A = new Float32Array(N), B = new Float32Array(N), opaque = new Uint8Array(N);
    const lab = [0, 0, 0];
    let nOpaque = 0, nSoft = 0;
    for (let i = 0; i < N; i++) {
      const a = pm[i * 4 + 3];
      if (a >= 127.5) {
        opaque[i] = 1; nOpaque++;
        rgbToLab(pm[i * 4] / a, pm[i * 4 + 1] / a, pm[i * 4 + 2] / a, lab, 0);
        L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2];
      } else if (a > 8) nSoft++;
    }
    return { W, H, N, L, A, B, opaque, nOpaque, mmpp, sx: opt.width / W, sy: heightMm / H, widthMm: opt.width, heightMm, reduced, srcPerMm: sw / opt.width };
  }

  /* Edge-preserving smoothing: a small bilateral filter in Lab. Transparent pixels neither give nor take. */
  function bilateral(P, radius, sigmaR, iterations) {
    const { W, H, N, opaque } = P;
    const side = 2 * radius + 1, sw = new Float32Array(side * side);
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) sw[(dy + radius) * side + dx + radius] = Math.exp(-(dx * dx + dy * dy) / (2 * radius * radius + 0.5));
    const LUTN = 512, maxD2 = 9 * sigmaR * sigmaR, lut = new Float32Array(LUTN + 1), k = LUTN / maxD2;
    for (let i = 0; i <= LUTN; i++) lut[i] = Math.exp(-(i / k) / (2 * sigmaR * sigmaR));
    let L = P.L, A = P.A, B = P.B;
    for (let it = 0; it < iterations; it++) {
      const L2 = new Float32Array(N), A2 = new Float32Array(N), B2 = new Float32Array(N);
      for (let y = 0; y < H; y++) {
        const y0 = Math.max(0, y - radius), y1 = Math.min(H - 1, y + radius);
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (!opaque[i]) continue;
          const l0 = L[i], a0 = A[i], b0 = B[i];
          let sl = 0, sa = 0, sb = 0, ws = 0;
          const x0 = Math.max(0, x - radius), x1 = Math.min(W - 1, x + radius);
          for (let yy = y0; yy <= y1; yy++) {
            const ro = yy * W, so = (yy - y + radius) * side - x + radius;
            for (let xx = x0; xx <= x1; xx++) {
              const j = ro + xx;
              if (!opaque[j]) continue;
              const dl = L[j] - l0, da = A[j] - a0, db = B[j] - b0, d2 = dl * dl + da * da + db * db;
              if (d2 >= maxD2) continue;
              const wt = sw[so + xx] * lut[(d2 * k) | 0];
              sl += L[j] * wt; sa += A[j] * wt; sb += B[j] * wt; ws += wt;
            }
          }
          L2[i] = sl / ws; A2[i] = sa / ws; B2[i] = sb / ws;
        }
      }
      L = L2; A = A2; B = B2;
    }
    P.L = L; P.A = A; P.B = B;
  }

  /* For every opaque pixel: 0 = core (a real colour of the picture), 1 = transition (an anti-aliased or
     blurred step between two colours: lies between its two opposite neighbours), 2 = ridge (a thin line:
     differs from both opposite neighbours, which resemble each other). Also the "flat" flag used for palette votes. */
  function classifyPixels(P, edgeT, flatT) {
    const { W, H, N, L, A, B, opaque } = P;
    const kind = new Uint8Array(N), flat = new Uint8Array(N), ridgeFrom = new Int32Array(N).fill(-1);
    const offs = [1, W, W + 1, W - 1], sides = new Int32Array(8), sideM = new Float64Array(8);
    const e2 = edgeT * edgeT, f2 = flatT * flatT;
    let nFlat = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!opaque[i]) continue;
      const l = L[i], a = A[i], b = B[i];
      let isFlat = 1, trans = 0, ridge = -1, ridgeD = 0, nSides = 0;
      for (let d = 0; d < 4; d++) {
        const dx = d === 1 ? 0 : (d === 3 ? -1 : 1), dy = d === 0 ? 0 : 1;
        const x1 = x - dx, y1 = y - dy, x2 = x + dx, y2 = y + dy;
        const in1 = x1 >= 0 && x1 < W && y1 >= 0, in2 = x2 >= 0 && x2 < W && y2 < H;
        const j1 = i - offs[d], j2 = i + offs[d];
        let d1 = -1, d2 = -1;
        if (in1 && opaque[j1]) { const p = L[j1] - l, q = A[j1] - a, r = B[j1] - b; d1 = p * p + q * q + r * r; if (d < 2 && d1 > f2) isFlat = 0; }
        else if (d < 2 && in1) isFlat = 0;
        if (in2 && opaque[j2]) { const p = L[j2] - l, q = A[j2] - a, r = B[j2] - b; d2 = p * p + q * q + r * r; if (d < 2 && d2 > f2) isFlat = 0; }
        else if (d < 2 && in2) isFlat = 0;
        if (d1 < 0 || d2 < 0) continue;
        const p = L[j1] - L[j2], q = A[j1] - A[j2], r = B[j1] - B[j2], dd = p * p + q * q + r * r;
        if (dd > e2) {
          // between: both distances a fair share of the step, and roughly on the line from one to the other
          const s1 = Math.sqrt(d1), s2 = Math.sqrt(d2), s = Math.sqrt(dd);
          if (s1 > 0.1 * s && s2 > 0.1 * s && s1 + s2 < 1.3 * s) trans = 1;
        }
        if (d1 > e2 * 0.36 && d2 > e2 * 0.36 && dd < 0.3 * Math.min(d1, d2)) { const m = Math.min(d1, d2); sideM[nSides] = m; sides[nSides++] = j1; if (m > ridgeD) { ridgeD = m; ridge = d1 <= d2 ? j1 : j2; } }
        // a hairline lying across two rows of pixels: neither is a ridge among its nearest neighbours (the other
        // half of the line is one of them), but both are among the next ones out
        const x3 = x - 2 * dx, y3 = y - 2 * dy, x4 = x + 2 * dx, y4 = y + 2 * dy;
        if (x3 >= 0 && x3 < W && y3 >= 0 && x4 >= 0 && x4 < W && y4 < H) {
          const k1 = i - 2 * offs[d], k2 = i + 2 * offs[d];
          if (opaque[k1] && opaque[k2]) {
            let p2 = L[k1] - l, q2 = A[k1] - a, r2 = B[k1] - b; const g1 = p2 * p2 + q2 * q2 + r2 * r2;
            p2 = L[k2] - l; q2 = A[k2] - a; r2 = B[k2] - b; const g2 = p2 * p2 + q2 * q2 + r2 * r2;
            p2 = L[k1] - L[k2]; q2 = A[k1] - A[k2]; r2 = B[k1] - B[k2]; const gg = p2 * p2 + q2 * q2 + r2 * r2;
            if (g1 > e2 * 0.36 && g2 > e2 * 0.36 && gg < 0.3 * Math.min(g1, g2)) { const m = Math.min(g1, g2); sideM[nSides] = m; sides[nSides++] = k1; if (m > ridgeD) { ridgeD = m; ridge = g1 <= g2 ? k1 : k2; } }
          }
        }
      }
      // where two shapes of one colour touch at a corner the pixel looks like a line in both colours at once
      // (dark on both sides one way, light on both sides the other, about equally strongly): that is a meeting
      // of edges, not a line. (Along a slanted hairline the same happens weakly, between lighter and darker
      // pixels of the line itself, which is why the strengths are compared.)
      if (ridge >= 0) for (let t = 0; t < nSides; t++) { if (sideM[t] < 0.5 * ridgeD) continue; const j = sides[t], p = L[j] - L[ridge], q = A[j] - A[ridge], r = B[j] - B[ridge]; if (p * p + q * q + r * r > e2) { ridge = -1; trans = 1; break; } }
      if (ridge >= 0) { kind[i] = 2; ridgeFrom[i] = ridge; }
      else if (trans) kind[i] = 1;
      if (isFlat) { flat[i] = 1; nFlat++; }
    }
    return { kind, flat, nFlat, ridgeFrom };
  }

  /* Texture finer than thread can show (a halftone, a tiny checker, coarse grain): a pixel with no evenly coloured
     pixel within R around it is replaced by the average of its surroundings, so the texture becomes the one
     colour the eye sees from a distance instead of a scatter of specks. Edges of real shapes always have even
     colour close by on at least one side and are left alone. Returns the number of pixels changed. */
  function blendFineTexture(P, flat, R, T) {
    const { W, H, N, opaque } = P;
    // how many set pixels of m lie in the (2r+1) square around each pixel
    const boxCount = (m, r) => {
      const row = new Uint16Array(N), out = new Uint16Array(N);
      for (let y = 0; y < H; y++) {
        let c = 0; const o = y * W;
        for (let x = 0; x < Math.min(W, r); x++) c += m[o + x];
        for (let x = 0; x < W; x++) { if (x + r < W) c += m[o + x + r]; if (x - r - 1 >= 0) c -= m[o + x - r - 1]; row[o + x] = c; }
      }
      for (let x = 0; x < W; x++) {
        let c = 0;
        for (let y = 0; y < Math.min(H, r); y++) c += row[y * W + x];
        for (let y = 0; y < H; y++) { if (y + r < H) c += row[(y + r) * W + x]; if (y - r - 1 >= 0) c -= row[(y - r - 1) * W + x]; out[y * W + x] = c; }
      }
      return out;
    };
    const nearFlat = boxCount(flat, R), isBusy = new Uint8Array(N);
    let nBusy = 0;
    for (let i = 0; i < N; i++) if (opaque[i] && !nearFlat[i]) { isBusy[i] = 1; nBusy++; }
    if (nBusy < (2 * T + 1) * (2 * T + 1)) return 0;
    // only where the texture is a real area (a few millimetres across): a line of small print or the rough edge
    // of a JPEG shape is busy too, but narrow
    const full = (2 * T + 1) * (2 * T + 1), cnt = boxCount(isBusy, T), core = new Uint8Array(N);
    let nCore = 0;
    for (let i = 0; i < N; i++) if (cnt[i] === full) { core[i] = 1; nCore++; }
    if (!nCore) return 0;
    const nearCore = boxCount(core, T), busy = [];
    for (let i = 0; i < N; i++) if (isBusy[i] && nearCore[i]) busy.push(i);
    for (let pass = 0; pass < 2; pass++) {
      const nl = new Float32Array(busy.length), na = new Float32Array(busy.length), nb = new Float32Array(busy.length);
      for (let t = 0; t < busy.length; t++) {
        const i = busy[t], x = i % W, y = (i / W) | 0;
        let sl = 0, sa = 0, sb = 0, n = 0;
        for (let yy = Math.max(0, y - R), y1 = Math.min(H - 1, y + R); yy <= y1; yy++) for (let j = yy * W + Math.max(0, x - R), j1 = yy * W + Math.min(W - 1, x + R); j <= j1; j++) {
          if (!opaque[j]) continue;
          sl += P.L[j]; sa += P.A[j]; sb += P.B[j]; n++;
        }
        nl[t] = sl / n; na[t] = sa / n; nb[t] = sb / n;
      }
      for (let t = 0; t < busy.length; t++) { const i = busy[t]; P.L[i] = nl[t]; P.A[i] = na[t]; P.B[i] = nb[t]; }
    }
    return busy.length;
  }

  /* The colour most of the picture's edge has, and the share of edge pixels that have it. */
  function borderColour(P, tol) {
    const { W, H, L, A, B, opaque } = P, idx = [];
    for (let x = 0; x < W; x++) { idx.push(x); if (H > 1) idx.push((H - 1) * W + x); }
    for (let y = 1; y < H - 1; y++) { idx.push(y * W); if (W > 1) idx.push(y * W + W - 1); }
    const bins = new Map();
    let n = 0;
    for (const i of idx) {
      if (!opaque[i]) continue;
      n++;
      const key = (((L[i] * 24) | 0) * 64 + (((A[i] + 0.4) * 30) | 0)) * 64 + (((B[i] + 0.4) * 30) | 0);
      bins.set(key, (bins.get(key) || 0) + 1);
    }
    if (!n) return null;
    let top = -1, tc = 0;
    bins.forEach((c, k) => { if (c > tc) { tc = c; top = k; } });
    let l = 0, a = 0, b = 0, m = 0;
    for (const i of idx) {
      if (!opaque[i]) continue;
      const key = (((L[i] * 24) | 0) * 64 + (((A[i] + 0.4) * 30) | 0)) * 64 + (((B[i] + 0.4) * 30) | 0);
      if (key === top) { l += L[i]; a += A[i]; b += B[i]; m++; }
    }
    l /= m; a /= m; b /= m;
    let hit = 0;
    for (const i of idx) { if (!opaque[i]) continue; const dl = L[i] - l, da = A[i] - a, db = B[i] - b; if (dl * dl + da * da + db * db < tol * tol) hit++; }
    return { L: l, a, b, share: hit / n };
  }

  // ====================================================================== 2. colours
  /* Weighted k-means in Lab over a colour histogram. Deterministic: no random numbers anywhere. */
  /* The colour histogram k-means works on: opaque pixels with a weight, binned in Lab. */
  function colourBins(P, weightOf) {
    const { N, L, A, B, opaque } = P;
    const QL = 64, QA = 64, bins = new Map();
    let pts = 0;
    const bw = [], bl = [], ba = [], bb = [];
    for (let i = 0; i < N; i++) {
      if (!opaque[i]) continue;
      const w = weightOf(i), l = L[i], a = A[i], b = B[i];
      if (w <= 0) continue;
      let ql = (l * (QL - 1) + 0.5) | 0, qa = ((a + 0.4) * (QA / 0.8)) | 0, qb = ((b + 0.4) * (QA / 0.8)) | 0;
      ql = ql < 0 ? 0 : ql >= QL ? QL - 1 : ql; qa = qa < 0 ? 0 : qa >= QA ? QA - 1 : qa; qb = qb < 0 ? 0 : qb >= QA ? QA - 1 : qb;
      const key = (ql * QA + qa) * QA + qb;
      let id = bins.get(key);
      if (id === undefined) { id = pts++; bins.set(key, id); bw.push(0); bl.push(0); ba.push(0); bb.push(0); }
      bw[id] += w; bl[id] += l * w; ba[id] += a * w; bb[id] += b * w;
    }
    let total = 0;
    for (let i = 0; i < pts; i++) { bl[i] /= bw[i]; ba[i] /= bw[i]; bb[i] /= bw[i]; total += bw[i]; }
    return { pts, bw, bl, ba, bb, total };
  }
  function buildPalette(P, weightOf, K) { return kmeansBins(colourBins(P, weightOf), K); }
  function kmeansBins(H, K) {
    const { pts, bw, bl, ba, bb, total } = H;
    if (!pts) return { centers: [], total: 0 };
    // Hue and colourfulness count double here, and a small patch counts for more than its size (weight ^ 0.6):
    // otherwise five shades of the largest colour are chosen and the one bright accent (an eye, a flower) is lost.
    // seeding: heaviest bin, then repeatedly the bin with the largest weight x squared distance to the chosen ones
    const CH = 2;
    const cl = [], ca = [], cb = [];
    let first = 0; for (let i = 1; i < pts; i++) if (bw[i] > bw[first]) first = i;
    cl.push(bl[first]); ca.push(ba[first]); cb.push(bb[first]);
    const near = new Float64Array(pts).fill(Infinity);
    while (cl.length < K) {
      const c = cl.length - 1; let best = -1, bestS = 0;
      for (let i = 0; i < pts; i++) {
        const dl = bl[i] - cl[c], da = ba[i] - ca[c], db = bb[i] - cb[c], d = dl * dl + CH * (da * da + db * db);
        if (d < near[i]) near[i] = d;
        const s = near[i] * Math.pow(bw[i], 0.6);
        if (s > bestS) { bestS = s; best = i; }
      }
      if (best < 0 || near[best] < 1e-5) break;
      cl.push(bl[best]); ca.push(ba[best]); cb.push(bb[best]);
    }
    let k = cl.length;
    const assign = new Int32Array(pts);
    for (let it = 0; it < 24; it++) {
      let moved = 0;
      const sl = new Float64Array(k), sa = new Float64Array(k), sb = new Float64Array(k), sw = new Float64Array(k);
      for (let i = 0; i < pts; i++) {
        let bj = 0, bd = Infinity;
        for (let j = 0; j < k; j++) { const dl = bl[i] - cl[j], da = ba[i] - ca[j], db = bb[i] - cb[j], d = dl * dl + CH * (da * da + db * db); if (d < bd) { bd = d; bj = j; } }
        if (assign[i] !== bj) { assign[i] = bj; moved++; }
        sl[bj] += bl[i] * bw[i]; sa[bj] += ba[i] * bw[i]; sb[bj] += bb[i] * bw[i]; sw[bj] += bw[i];
      }
      for (let j = 0; j < k; j++) if (sw[j] > 0) { cl[j] = sl[j] / sw[j]; ca[j] = sa[j] / sw[j]; cb[j] = sb[j] / sw[j]; }
      if (!moved && it > 0) break;
    }
    const wsum = new Float64Array(k); let err = 0;
    for (let i = 0; i < pts; i++) {
      const j = assign[i], dl = bl[i] - cl[j], da = ba[i] - ca[j], db = bb[i] - cb[j];
      wsum[j] += bw[i]; err += (dl * dl + da * da + db * db) * bw[i];
    }
    const centers = [];
    for (let j = 0; j < k; j++) if (wsum[j] > 0) centers.push({ L: cl[j], a: ca[j], b: cb[j], w: wsum[j] });
    return { centers, total, rms: Math.sqrt(err / total) };
  }
  /* Share of the histogram's weight lying further than `far` (OKLab) from every centre: a colour the palette misses. */
  function missedShare(H, centers, far) {
    let miss = 0; const f2 = far * far;
    for (let i = 0; i < H.pts; i++) {
      let bd = Infinity;
      for (const c of centers) { const dl = H.bl[i] - c.L, da = H.ba[i] - c.a, db = H.bb[i] - c.b, d = dl * dl + da * da + db * db; if (d < bd) bd = d; }
      if (bd > f2) miss += H.bw[i];
    }
    return H.total ? miss / H.total : 0;
  }
  /* colours 'auto': the fewest thread colours that show the picture well, never more than `cap`.
     Generator: yields progress 0..1, returns { colors, curve }. The palette step is run for k = 1, 2, ... on the same
     colour histogram the real palette uses (with the border background in it as one more colour, bgSlot = 1, when it
     will be taken out; it is not a thread and does not count against cap), and for each k two things are measured
     in OKLab: rms, the average colour error, and miss, the share of the picture further than AUTO.far from every
     palette colour (a colour with no thread close to it). The count is the smallest k >= 2 where either
       a) the picture is flat art and is fully explained: rms <= AUTO.flat, miss <= AUTO.flatMiss, and two more
          threads would lower rms by no more than a third of AUTO.flat (a pale picture's faint colours still count), or
       b) nothing sizeable is missed (miss <= AUTO.miss for photographs, AUTO.logoMiss for flat art) and two more threads would cut rms by less than AUTO.gain
          (diminishing returns: photographs, gradients),
     or `cap` when neither happens. Colour distances scale with the picture's contrast (spreadK) like everywhere else. */
  function* chooseColours(P, weightOf, spreadK, cap, bgSlot, photo) {
    const missOk = photo ? AUTO.miss : AUTO.logoMiss;
    const H = colourBins(P, weightOf);
    const curve = [];
    const last = Math.min(LIMITS.colors[1] + bgSlot, cap + bgSlot + 1);
    for (let k = 1; k <= last; k++) {
      const pal = kmeansBins(H, k);
      curve.push({ k, n: pal.centers.length, rms: pal.rms || 0, miss: missedShare(H, pal.centers, AUTO.far * spreadK) });
      yield k / last;
      if (pal.centers.length < k) break;            // the picture has no more distinct colours
    }
    const at = k => curve[Math.min(k, curve.length) - 1];
    let k = 0;
    for (let j = 2 + bgSlot; j <= cap + bgSlot && !k; j++) {
      const p = at(j);
      if (p.k < j) k = p.n;                                                     // ran out of colours
      else if (p.rms <= AUTO.flat * spreadK && p.miss <= AUTO.flatMiss && p.rms - at(j + 2).rms <= AUTO.flat * spreadK / 3) k = j;
      else if (p.miss <= missOk && p.rms > 0 && (p.rms - at(j + 2).rms) / p.rms < AUTO.gain) k = j;
    }
    if (!k) k = Math.min(cap + bgSlot, curve[curve.length - 1].n);
    curve.forEach(c => { c.rms = Math.round(c.rms * 1e4) / 1e4; c.miss = Math.round(c.miss * 1e4) / 1e4; });
    return { colors: Math.max(2, Math.min(cap, k - bgSlot)), curve, background: bgSlot };
  }
  const AUTO = { far: 0.07, flat: 0.012, flatMiss: 0.002, miss: 0.02, logoMiss: 0.005, gain: 0.2 };

  const labDist = (p, q) => Math.sqrt((p.L - q.L) * (p.L - q.L) + (p.a - q.a) * (p.a - q.a) + (p.b - q.b) * (p.b - q.b));
  /* Merge centres that would be the same thread, closest pair first; drop centres with too little weight. */
  function mergePalette(centers, mergeDist, minWeight, dropBlends) {
    centers = centers.map(c => ({ L: c.L, a: c.a, b: c.b, w: c.w }));
    if (dropBlends) centers = withoutBlends(centers, mergeDist, minWeight);
    for (;;) {
      if (centers.length <= 1) break;
      let bi = -1, bj = -1, bd = Infinity;
      for (let i = 0; i < centers.length; i++) for (let j = i + 1; j < centers.length; j++) {
        let d = labDist(centers[i], centers[j]);
        if (Math.min(centers[i].w, centers[j].w) < minWeight) d *= 0.5;       // a negligible colour merges more easily
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
      if (bd >= mergeDist) break;
      const p = centers[bi], q = centers[bj], w = p.w + q.w;
      // keep the heavier colour nearly as it is: a logo's red should stay that red
      const t = q.w / w, tt = t < 0.25 ? t * 0.5 : t > 0.75 ? 1 - (1 - t) * 0.5 : t;
      centers[bi] = { L: p.L + (q.L - p.L) * tt, a: p.a + (q.a - p.a) * tt, b: p.b + (q.b - p.b) * tt, w };
      centers.splice(bj, 1);
    }
    return centers;
  }

  /* Flat art with more palette slots than colours: the spare slots go to the blend along edges (between a colour and
     its neighbour, or the page), which would be sewn as hairlines of an in-between thread. A centre is such a blend when
     it lies on the straight line between two other centres (within mergeDist, not at either end) and holds less than a
     quarter of the lighter of them, or when it is too small to be a shape at all (under minWeight). It joins the nearer
     end. Lightest blends first, until none is left. */
  function withoutBlends(centers, mergeDist, minWeight) {
    for (let guard = 0; guard < 64 && centers.length > 2; guard++) {
      let drop = -1, into = -1;
      const order = centers.map((c, i) => i).sort((p, q) => centers[p].w - centers[q].w);
      for (const i of order) {
        const c = centers[i];
        let bestD = Infinity, bestTo = -1;
        for (let p = 0; p < centers.length; p++) for (let q = p + 1; q < centers.length; q++) {
          if (p === i || q === i) continue;
          const A = centers[p], B = centers[q];
          if (c.w * 4 > Math.min(A.w, B.w) && c.w >= minWeight) continue;
          const dl = B.L - A.L, da = B.a - A.a, db = B.b - A.b, len2 = dl * dl + da * da + db * db;
          if (len2 < 1e-9) continue;
          const t = ((c.L - A.L) * dl + (c.a - A.a) * da + (c.b - A.b) * db) / len2;
          if (t < 0.08 || t > 0.92) continue;
          const el = A.L + t * dl - c.L, ea = A.a + t * da - c.a, eb = A.b + t * db - c.b, d = Math.sqrt(el * el + ea * ea + eb * eb);
          if (d < mergeDist && d < bestD) { bestD = d; bestTo = t < 0.5 ? p : q; }
        }
        if (bestTo >= 0) { drop = i; into = bestTo; break; }
      }
      if (drop < 0) break;
      centers[into] = Object.assign({}, centers[into], { w: centers[into].w + centers[drop].w });
      centers.splice(drop, 1);
    }
    return centers;
  }

  /* Give every opaque pixel a palette index (label). Core pixels take the nearest colour; thin-line pixels
     are pushed away from their surroundings first (a half-covered black hairline reads grey, but is black);
     transition pixels take the colour of the side they are closer to, so an anti-aliased edge never becomes
     a thin region of a third colour. */
  /* A thin-line pixel is a blend of the line's colour and what lies beside it, so the line's colour is somewhere
     on the ray from the surroundings through the pixel and beyond. Returns the palette colour nearest to that
     ray (and how far off it is, squared, in out[0]). */
  function ridgeColour(P, i, j, centers, out) {
    const l = P.L[i], a = P.A[i], b = P.B[i], dl = l - P.L[j], da = a - P.A[j], db = b - P.B[j], dd = dl * dl + da * da + db * db || 1e-9;
    let best = 0, bd = Infinity;
    for (let c = 0; c < centers.length; c++) {
      const cl = centers[c].L - l, ca = centers[c].a - a, cb = centers[c].b - b;
      let t = (cl * dl + ca * da + cb * db) / dd; t = t < 0 ? 0 : t > 3 ? 3 : t;
      const el = cl - t * dl, ea = ca - t * da, eb = cb - t * db, d = el * el + ea * ea + eb * eb;
      if (d < bd) { bd = d; best = c; }
    }
    if (out) out[0] = bd;
    return best;
  }

  function assignLabels(P, cls, centers) {
    const { W, H, N, L, A, B, opaque } = P, K = centers.length;
    const label = new Int32Array(N).fill(-1);
    const cl = centers.map(c => c.L), ca = centers.map(c => c.a), cb = centers.map(c => c.b);
    const nearest = (l, a, b) => {
      let bj = 0, bd = Infinity;
      for (let j = 0; j < K; j++) { const dl = l - cl[j], da = a - ca[j], db = b - cb[j], d = dl * dl + da * da + db * db; if (d < bd) { bd = d; bj = j; } }
      return bj;
    };
    const pending = [];
    for (let i = 0; i < N; i++) {
      if (!opaque[i]) continue;
      const kd = cls.kind[i];
      if (kd === 1) { label[i] = -2; pending.push(i); continue; }
      if (kd === 2) {
        label[i] = ridgeColour(P, i, cls.ridgeFrom[i], centers, null);
      } else label[i] = nearest(L[i], A[i], B[i]);
    }
    // grow the resolved labels into the transition pixels, one ring per pass, both sides at once
    let list = pending;
    for (let pass = 0; pass < 8 && list.length; pass++) {
      const next = [], set = [];
      for (let t = 0; t < list.length; t++) {
        const i = list[t], x = i % W, y = (i / W) | 0;
        let best = -1, bd = Infinity;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= W || (!dx && !dy)) continue;
            const lb = label[yy * W + xx];
            if (lb < 0) continue;
            const dl = L[i] - cl[lb], da = A[i] - ca[lb], db = B[i] - cb[lb], d = dl * dl + da * da + db * db;
            if (d < bd) { bd = d; best = lb; }
          }
        }
        if (best >= 0) set.push(i, best); else next.push(i);
      }
      for (let t = 0; t < set.length; t += 2) label[set[t]] = set[t + 1];
      if (next.length === list.length) break;
      list = next;
    }
    for (let t = 0; t < list.length; t++) { const i = list[t]; if (label[i] === -2) label[i] = nearest(L[i], A[i], B[i]); }
    return label;
  }

  /* 3x3 majority vote on the label map (photographs: removes salt and pepper before regions are formed). */
  function majorityFilter(label, W, H, K, iterations) {
    const cnt = new Int32Array(K + 1);
    for (let it = 0; it < iterations; it++) {
      const out = new Int32Array(label);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, cur = label[i];
        if (cur < 0) continue;
        cnt.fill(0);
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= W) continue; const lb = label[yy * W + xx]; if (lb >= 0) cnt[lb]++; }
        }
        let best = cur, bc = cnt[cur];
        for (let j = 0; j < K; j++) if (cnt[j] > bc) { bc = cnt[j]; best = j; }
        out[i] = best;
      }
      label.set(out);
    }
  }

  // ====================================================================== 3. regions
  /* 4-connected components of equal label. order = pixel indices grouped by component. */
  function components(label, W, H) {
    const N = W * H, comp = new Int32Array(N).fill(-1), order = new Int32Array(N);
    const start = [], area = [], lab = [];
    let n = 0, head = 0, tail = 0;
    for (let s = 0; s < N; s++) {
      if (comp[s] !== -1) continue;
      const lb = label[s], id = n++;
      start.push(tail); lab.push(lb);
      comp[s] = id; order[tail++] = s;
      while (head < tail) {
        const i = order[head++], x = i % W;
        if (x > 0 && comp[i - 1] === -1 && label[i - 1] === lb) { comp[i - 1] = id; order[tail++] = i - 1; }
        if (x < W - 1 && comp[i + 1] === -1 && label[i + 1] === lb) { comp[i + 1] = id; order[tail++] = i + 1; }
        if (i >= W && comp[i - W] === -1 && label[i - W] === lb) { comp[i - W] = id; order[tail++] = i - W; }
        if (i < N - W && comp[i + W] === -1 && label[i + W] === lb) { comp[i + W] = id; order[tail++] = i + W; }
      }
      area.push(tail - start[id]);
    }
    start.push(tail);
    return { comp, order, start, area, lab, n };
  }

  /* Absorb components smaller than minPx into their best neighbour (longest shared border, similar colour
     preferred). Isolated specks (only background around them) vanish. Returns pixels changed. */
  function absorbSpecks(label, W, H, centers, minPx, isolatedPx, maxPasses, keepChains) {
    const N = W * H; let changedTotal = 0;
    for (let pass = 0; pass < maxPasses; pass++) {
      const cc = components(label, W, H), last = pass === maxPasses - 1;
      const target = new Int32Array(cc.n).fill(-3);
      let any = false;
      for (let id = 0; id < cc.n; id++) {
        const ar = cc.area[id];
        if (ar >= minPx) continue;
        const lb = cc.lab[id], tally = new Map();
        let touchesEdge = false;
        for (let t = cc.start[id]; t < cc.start[id + 1]; t++) {
          const i = cc.order[t], x = i % W;
          if (x > 0) { const c = cc.comp[i - 1]; if (c !== id) tally.set(c, (tally.get(c) || 0) + 1); } else touchesEdge = true;
          if (x < W - 1) { const c = cc.comp[i + 1]; if (c !== id) tally.set(c, (tally.get(c) || 0) + 1); } else touchesEdge = true;
          if (i >= W) { const c = cc.comp[i - W]; if (c !== id) tally.set(c, (tally.get(c) || 0) + 1); } else touchesEdge = true;
          if (i < N - W) { const c = cc.comp[i + W]; if (c !== id) tally.set(c, (tally.get(c) || 0) + 1); } else touchesEdge = true;
        }
        if (!tally.size) continue;                       // the whole picture is this one component
        if (keepChains) {
          // a hairline drawn on a slant is a chain of pixels that only touch at their corners: not a speck
          let chain = false;
          for (let t = cc.start[id]; t < cc.start[id + 1] && !chain; t++) {
            const i = cc.order[t], x = i % W, y = (i / W) | 0;
            for (let dy = -1; dy <= 1 && !chain; dy += 2) { const yy = y + dy; if (yy < 0 || yy >= H) continue; for (let dx = -1; dx <= 1; dx += 2) { const xx = x + dx; if (xx < 0 || xx >= W) continue; const j = yy * W + xx; if (label[j] === lb && cc.comp[j] !== id) { chain = true; break; } } }
          }
          if (chain) continue;
        }
        let onlyBackground = lb >= 0;
        tally.forEach((v, c) => { if (cc.lab[c] >= 0) onlyBackground = false; });
        if (onlyBackground && ar >= isolatedPx) continue; // a small dot on its own is still worth sewing
        if (lb < 0 && touchesEdge) continue;              // background reaching the picture edge is not a pinhole
        let best = -1, bs = -1;
        tally.forEach((v, c) => {
          if (!last && !(cc.area[c] > ar || (cc.area[c] === ar && c < id))) return;
          const ol = cc.lab[c];
          const d = (lb >= 0 && ol >= 0) ? labDist(centers[lb], centers[ol]) : 0.25;
          const s = v / (0.03 + d);
          if (s > bs) { bs = s; best = c; }
        });
        if (best >= 0) { target[id] = cc.lab[best]; any = true; }
      }
      if (!any) break;
      for (let id = 0; id < cc.n; id++) {
        if (target[id] === -3) continue;
        for (let t = cc.start[id]; t < cc.start[id + 1]; t++) label[cc.order[t]] = target[id];
        changedTotal += cc.area[id];
      }
    }
    return changedTotal;
  }

  /* Distance (pixels) from each pixel to the nearest pixel of another component, measured inside the
     component (two-pass chamfer). A pixel on the border has 0.5. */
  function distanceInside(comp, W, H) {
    const N = W * H, d = new Float32Array(N), BIG = 1e9, D1 = 1, D2 = 1.41421;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, c = comp[i];
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || comp[i - 1] !== c || comp[i + 1] !== c || comp[i - W] !== c || comp[i + W] !== c) d[i] = 0.5;
      else if (comp[i - W - 1] !== c || comp[i - W + 1] !== c || comp[i + W - 1] !== c || comp[i + W + 1] !== c) d[i] = 0.7071;
      else d[i] = BIG;
    }
    chamfer(d, comp, W, H, D1, D2);
    return d;
  }
  function chamfer(d, comp, W, H, D1, D2) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, c = comp[i]; let v = d[i];
      if (x > 0 && comp[i - 1] === c && d[i - 1] + D1 < v) v = d[i - 1] + D1;
      if (y > 0) {
        if (comp[i - W] === c && d[i - W] + D1 < v) v = d[i - W] + D1;
        if (x > 0 && comp[i - W - 1] === c && d[i - W - 1] + D2 < v) v = d[i - W - 1] + D2;
        if (x < W - 1 && comp[i - W + 1] === c && d[i - W + 1] + D2 < v) v = d[i - W + 1] + D2;
      }
      d[i] = v;
    }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x, c = comp[i]; let v = d[i];
      if (x < W - 1 && comp[i + 1] === c && d[i + 1] + D1 < v) v = d[i + 1] + D1;
      if (y < H - 1) {
        if (comp[i + W] === c && d[i + W] + D1 < v) v = d[i + W] + D1;
        if (x < W - 1 && comp[i + W + 1] === c && d[i + W + 1] + D2 < v) v = d[i + W + 1] + D2;
        if (x > 0 && comp[i + W - 1] === c && d[i + W - 1] + D2 < v) v = d[i + W - 1] + D2;
      }
      d[i] = v;
    }
  }

  // ---------------------------------------------------------------------- hairlines
  /* Zhang-Suen thinning of the pixels in `list` (flag array `on`); a neighbour counts only if it has the same group. */
  function thin(on, group, list, W) {
    let alive = list.slice();
    for (let guard = 0; guard < 80; guard++) {
      let removedAny = false;
      for (let sub = 0; sub < 2; sub++) {
        const kill = [];
        for (let t = 0; t < alive.length; t++) {
          const i = alive[t], g = group[i];
          const p2 = on[i - W] && group[i - W] === g ? 1 : 0, p3 = on[i - W + 1] && group[i - W + 1] === g ? 1 : 0;
          const p4 = on[i + 1] && group[i + 1] === g ? 1 : 0, p5 = on[i + W + 1] && group[i + W + 1] === g ? 1 : 0;
          const p6 = on[i + W] && group[i + W] === g ? 1 : 0, p7 = on[i + W - 1] && group[i + W - 1] === g ? 1 : 0;
          const p8 = on[i - 1] && group[i - 1] === g ? 1 : 0, p9 = on[i - W - 1] && group[i - W - 1] === g ? 1 : 0;
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const a = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (a !== 1) continue;
          if (sub === 0 ? (p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0) : (p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0)) kill.push(i);
        }
        if (kill.length) {
          removedAny = true;
          for (let t = 0; t < kill.length; t++) on[kill[t]] = 0;
          alive = alive.filter(i => on[i]);
        }
      }
      if (!removedAny) break;
    }
    return alive;
  }

  /* Skeleton pixels (flag `on`, same `group`) -> lines: [{ px: [pixel index...], free0, free1 }].
     Short side twigs (shorter than spurLen(junction pixel)) are removed; where two branches are left at a
     junction they become one line, and at a real junction the straightest pair is joined. free0 / free1
     say whether that end is a loose end (not attached to another line). */
  function skeletonPaths(on, group, pixels, W, spurLen) {
    const nbrs = i => {
      const g = group[i], out = [];
      const N_ = on[i - W] && group[i - W] === g, E_ = on[i + 1] && group[i + 1] === g, S_ = on[i + W] && group[i + W] === g, W_ = on[i - 1] && group[i - 1] === g;
      if (N_) out.push(i - W); if (E_) out.push(i + 1); if (S_) out.push(i + W); if (W_) out.push(i - 1);
      // a diagonal step counts only when no orthogonal detour exists (otherwise every corner is a triangle)
      if (!N_ && !E_ && on[i - W + 1] && group[i - W + 1] === g) out.push(i - W + 1);
      if (!S_ && !E_ && on[i + W + 1] && group[i + W + 1] === g) out.push(i + W + 1);
      if (!S_ && !W_ && on[i + W - 1] && group[i + W - 1] === g) out.push(i + W - 1);
      if (!N_ && !W_ && on[i - W - 1] && group[i - W - 1] === g) out.push(i - W - 1);
      return out;
    };
    const deg = new Map(), adj = new Map();
    for (const i of pixels) { const n = nbrs(i); adj.set(i, n); deg.set(i, n.length); }
    const used = new Set(), ekey = (a, b) => a < b ? a * 4294967296 + b : b * 4294967296 + a;
    let paths = [];
    const walk = (from, to) => {
      const path = [from, to]; used.add(ekey(from, to));
      let prev = from, cur = to;
      while (deg.get(cur) === 2) {
        const n = adj.get(cur), nx = n[0] === prev ? n[1] : n[0];
        if (used.has(ekey(cur, nx))) break;
        used.add(ekey(cur, nx)); path.push(nx); prev = cur; cur = nx;
        if (cur === from) break;
      }
      return path;
    };
    for (const i of pixels) if (deg.get(i) !== 2) for (const j of adj.get(i)) if (!used.has(ekey(i, j))) paths.push(walk(i, j));
    for (const i of pixels) if (deg.get(i) === 2) { const n = adj.get(i); if (!used.has(ekey(i, n[0]))) paths.push(walk(i, n[0])); }
    const xy = i => [i % W, (i / W) | 0];
    const dirAt = (path, atEnd) => {
      const n = path.length, a = xy(atEnd ? path[n - 1] : path[0]), b = xy(atEnd ? path[Math.max(0, n - 7)] : path[Math.min(n - 1, 6)]);
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l];
    };
    const endsMap = () => {
      const ends = new Map();
      paths.forEach((p, pi) => {
        if (!p || p.length < 2 || p[0] === p[p.length - 1]) return;
        for (const e of [0, 1]) { const node = e ? p[p.length - 1] : p[0]; if (!ends.has(node)) ends.set(node, []); ends.get(node).push([pi, e]); }
      });
      return ends;
    };
    for (let round = 0; round < 6; round++) {
      let changed = false;
      // 1. twigs: one loose end, the other end at a junction, and short
      let ends = endsMap();
      paths.forEach((p, pi) => {
        if (!p || p[0] === p[p.length - 1]) return;
        const a = ends.get(p[0]).length, b = ends.get(p[p.length - 1]).length;
        if ((a === 1) === (b === 1)) return;
        const junction = a === 1 ? p[p.length - 1] : p[0];
        if (ends.get(junction).length >= 3 && p.length - 1 < spurLen(junction)) { paths[pi] = null; changed = true; ends = endsMap(); }
      });
      // 2. join through junctions
      const touched = new Set();
      ends = endsMap();
      for (const [, list] of ends) {
        if (list.length < 2 || list.some(e => touched.has(e[0]))) continue;
        let best = null, bestDot = list.length === 2 ? 2 : -0.5;      // two branches always join; more need to be fairly straight
        for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
          if (list[a][0] === list[b][0]) continue;
          const da = dirAt(paths[list[a][0]], list[a][1]), db = dirAt(paths[list[b][0]], list[b][1]);
          const dot = da[0] * db[0] + da[1] * db[1];
          if (dot < bestDot) { bestDot = dot; best = [list[a], list[b]]; }
        }
        if (!best) continue;
        const [pa, ea] = best[0], [pb, eb] = best[1];
        const A = ea ? paths[pa] : paths[pa].slice().reverse();   // ends at the node
        const Bp = eb ? paths[pb].slice().reverse() : paths[pb];  // starts at the node
        paths[pa] = A.concat(Bp.slice(1)); paths[pb] = null; touched.add(pa); touched.add(pb); changed = true;
      }
      paths = paths.filter(Boolean);
      if (!changed) break;
    }
    paths = paths.filter(p => p && p.length >= 2);
    const count = new Map();
    for (const p of paths) for (let t = 0; t < p.length; t++) count.set(p[t], (count.get(p[t]) || 0) + 1);
    return paths.map(p => ({ px: p, free0: count.get(p[0]) === 1, free1: count.get(p[p.length - 1]) === 1 }));
  }

  // ====================================================================== 4. outlines
  /* Remove diagonal-only contacts (2x2 blocks "10/01"), so every outline is a simple ring. */
  function fixSaddles(m, w, h) {
    for (let guard = 0; guard < 12; guard++) {
      let changed = false;
      for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
        const i = y * w + x, a = m[i], b = m[i + 1], c = m[i + w], d = m[i + w + 1];
        if (a && d && !b && !c) { m[i + 1] = 1; m[i + w] = 1; changed = true; }
        else if (b && c && !a && !d) { m[i] = 1; m[i + w + 1] = 1; changed = true; }
      }
      if (!changed) break;
    }
  }
  /* Crack following. m has a border of at least one zero pixel. Returns rings as dense lattice paths
     [x0, y0, x1, y1, ...] (unit steps, closed, last point not repeated). Walks with the inside on the
     right-hand side on screen: outlines run clockwise (positive area with y down), holes the other way. */
  function traceRings(m, w, h) {
    const seen = new Uint8Array(w * h), rings = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const s = y * w + x;
      if (!m[s] || m[s - w] || seen[s]) continue;
      const pts = [];
      let vx = x, vy = y, dir = 0, area2 = 0, guard = 4 * w * h + 8;
      do {
        pts.push(vx, vy);
        const px = vx, py = vy;
        if (dir === 0) { seen[vy * w + vx] = 1; vx++; } else if (dir === 1) vy++; else if (dir === 2) vx--; else vy--;
        area2 += px * vy - vx * py;
        let r, l;
        if (dir === 0) { r = m[vy * w + vx]; l = m[(vy - 1) * w + vx]; }
        else if (dir === 1) { r = m[vy * w + vx - 1]; l = m[vy * w + vx]; }
        else if (dir === 2) { r = m[(vy - 1) * w + vx - 1]; l = m[vy * w + vx - 1]; }
        else { r = m[(vy - 1) * w + vx]; l = m[(vy - 1) * w + vx - 1]; }
        if (!r) dir = (dir + 1) & 3; else if (l) dir = (dir + 3) & 3;
      } while (!(vx === x && vy === y && dir === 0) && --guard > 0);
      rings.push({ pts, n: pts.length >> 1, area: area2 / 2 });
    }
    return rings;
  }

  const GAUSS = (sigma, r) => { const w = []; let s = 0; for (let j = -r; j <= r; j++) { const v = Math.exp(-j * j / (2 * sigma * sigma)); w.push(v); s += v; } return w.map(v => v / s); };
  const G_PRE = GAUSS(1.0, 3), G_FIN = GAUSS(1.25, 4);

  /* Douglas-Peucker on xs/ys[a..b]; marks kept points. */
  function dp(xs, ys, a, b, tol, keep) {
    const stack = [a, b], t2 = tol * tol; keep[a] = 1; keep[b] = 1;
    while (stack.length) {
      const e = stack.pop(), s = stack.pop();
      if (e - s < 2) continue;
      const ax = xs[s], ay = ys[s], dx = xs[e] - ax, dy = ys[e] - ay, len2 = dx * dx + dy * dy;
      let worst = -1, wd = t2;
      for (let i = s + 1; i < e; i++) {
        let d;
        if (len2 < 1e-12) { const px = xs[i] - ax, py = ys[i] - ay; d = px * px + py * py; }
        else { const c = (xs[i] - ax) * dy - (ys[i] - ay) * dx; d = c * c / len2; }
        if (d > wd) { wd = d; worst = i; }
      }
      if (worst >= 0) { keep[worst] = 1; stack.push(s, worst, worst, e); }
    }
  }

  /* Dense lattice ring -> smooth, simplified ring (array of [x, y] in pixels).
     Corners (a real change of direction, not a stair step) are kept exactly; the staircase in between
     is smoothed with a small Gaussian and then simplified. level 0 = full, 1 = tighter tolerance, 2 = raw lattice corners. */
  function smoothRing(pts, n, tol, level) {
    const X = i => pts[2 * (((i % n) + n) % n)], Y = i => pts[2 * (((i % n) + n) % n) + 1];
    if (level >= 2 || n <= 8) {
      const out = [];
      for (let i = 0; i < n; i++) { const dx1 = X(i) - X(i - 1), dy1 = Y(i) - Y(i - 1), dx2 = X(i + 1) - X(i), dy2 = Y(i + 1) - Y(i); if (dx1 !== dx2 || dy1 !== dy2) out.push([X(i), Y(i)]); }
      return out;
    }
    if (level === 1) tol *= 0.4;
    const k = Math.max(2, Math.min(5, (n / 6) | 0));
    const sx = new Float32Array(n), sy = new Float32Array(n);
    for (let i = 0; i < n; i++) { let x = 0, y = 0; for (let j = -3; j <= 3; j++) { x += G_PRE[j + 3] * X(i + j); y += G_PRE[j + 3] * Y(i + j); } sx[i] = x; sy[i] = y; }
    const S = (a, i) => a[((i % n) + n) % n];
    const turn = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ax = sx[i] - S(sx, i - k), ay = sy[i] - S(sy, i - k), bx = S(sx, i + k) - sx[i], by = S(sy, i + k) - sy[i];
      turn[i] = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
    }
    const TC = 0.75; // about 43 degrees
    let corners = [];
    for (let i = 0; i < n; i++) {
      if (turn[i] < TC) continue;
      let isMax = true;
      for (let j = 1; j <= k && isMax; j++) { if (S(turn, i - j) >= turn[i] || S(turn, i + j) > turn[i]) isMax = false; }
      if (!isMax) continue;
      // the lattice point near i that sticks out most from the chord
      const ax = S(sx, i - k), ay = S(sy, i - k), dx = S(sx, i + k) - ax, dy = S(sy, i + k) - ay, len = Math.hypot(dx, dy) || 1;
      let best = i, bd = -1;
      for (let j = -2; j <= 2; j++) { const d = Math.abs((X(i + j) - ax) * dy - (Y(i + j) - ay) * dx) / len; if (d > bd + 1e-6) { bd = d; best = i + j; } }
      corners.push(((best % n) + n) % n);
    }
    corners = Array.from(new Set(corners)).sort((a, b) => a - b);
    const out = [];
    const span = (c0, len, pin0, pin1) => {
      // points c0 .. c0+len along the ring; ends pinned to lattice points when they are corners
      const xs = new Float32Array(len + 1), ys = new Float32Array(len + 1), keep = new Uint8Array(len + 1);
      for (let t = 0; t <= len; t++) {
        let x = 0, y = 0;
        for (let j = -4; j <= 4; j++) {
          let u = t + j;
          if (pin0 && u < 0) u = 0; if (pin1 && u > len) u = len;
          x += G_FIN[j + 4] * X(c0 + u); y += G_FIN[j + 4] * Y(c0 + u);
        }
        xs[t] = x; ys[t] = y;
      }
      if (pin0) { xs[0] = X(c0); ys[0] = Y(c0); }
      if (pin1) { xs[len] = X(c0 + len); ys[len] = Y(c0 + len); }
      dp(xs, ys, 0, len, tol, keep);
      for (let t = 0; t < len; t++) if (keep[t]) out.push([xs[t], ys[t]]);
    };
    if (corners.length === 0) {
      // no corner: split at point 0 and the point farthest from it
      let far = 0, fd = -1;
      for (let i = 1; i < n; i++) { const d = (sx[i] - sx[0]) * (sx[i] - sx[0]) + (sy[i] - sy[0]) * (sy[i] - sy[0]); if (d > fd) { fd = d; far = i; } }
      span(0, far, false, false); span(far, n - far, false, false);
    } else {
      for (let c = 0; c < corners.length; c++) {
        const c0 = corners[c], c1 = corners[(c + 1) % corners.length];
        let len = c1 - c0; if (len <= 0) len += n;
        span(c0, len, true, true);
      }
    }
    // drop repeated points
    const res = [];
    for (let i = 0; i < out.length; i++) { const p = out[i], q = res.length ? res[res.length - 1] : null; if (!q || Math.abs(p[0] - q[0]) > 0.02 || Math.abs(p[1] - q[1]) > 0.02) res.push(p); }
    while (res.length > 1 && Math.abs(res[0][0] - res[res.length - 1][0]) <= 0.02 && Math.abs(res[0][1] - res[res.length - 1][1]) <= 0.02) res.pop();
    return res;
  }

  function ringArea(r) { let s = 0; for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; s += p[0] * q[1] - q[0] * p[1]; } return s / 2; }
  function ringLength(r, closed) { let s = 0; for (let i = 0, n = r.length, m = closed ? n : n - 1; i < m; i++) { const p = r[i], q = r[(i + 1) % n]; s += Math.hypot(q[0] - p[0], q[1] - p[1]); } return s; }

  /* Do any two segments of these closed rings cross or touch (other than neighbours sharing an end point)? */
  function ringsIntersect(rings) {
    const segs = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    rings.forEach((r, ri) => {
      for (let i = 0, n = r.length; i < n; i++) {
        const p = r[i], q = r[(i + 1) % n];
        segs.push([p[0], p[1], q[0], q[1], ri, i, n]);
        if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
      }
    });
    if (segs.length < 4) return false;
    const cell = Math.max(2, Math.sqrt(((maxX - minX) * (maxY - minY)) / segs.length) * 1.5 || 2);
    const gw = Math.max(1, Math.ceil((maxX - minX) / cell) + 1), grid = new Map();
    const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const EPS = 1e-9;
    const hit = (a, b) => {
      if (a[4] === b[4]) { const d = Math.abs(a[5] - b[5]); if (d === 0 || d === 1 || d === a[6] - 1) return adjacentOverlap(a, b); }
      const o1 = orient(a[0], a[1], a[2], a[3], b[0], b[1]), o2 = orient(a[0], a[1], a[2], a[3], b[2], b[3]);
      const o3 = orient(b[0], b[1], b[2], b[3], a[0], a[1]), o4 = orient(b[0], b[1], b[2], b[3], a[2], a[3]);
      if (((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS)) && ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))) return true;
      const on = (px, py, s) => Math.min(s[0], s[2]) - EPS <= px && px <= Math.max(s[0], s[2]) + EPS && Math.min(s[1], s[3]) - EPS <= py && py <= Math.max(s[1], s[3]) + EPS;
      if (Math.abs(o1) <= EPS && on(b[0], b[1], a)) return true;
      if (Math.abs(o2) <= EPS && on(b[2], b[3], a)) return true;
      if (Math.abs(o3) <= EPS && on(a[0], a[1], b)) return true;
      if (Math.abs(o4) <= EPS && on(a[2], a[3], b)) return true;
      return false;
    };
    // neighbours share one end point; they only "intersect" when one folds back onto the other
    const adjacentOverlap = (a, b) => {
      if (a === b) return false;
      const first = (a[5] + 1) % a[6] === b[5] ? a : b, second = first === a ? b : a;
      const ux = first[0] - first[2], uy = first[1] - first[3], vx = second[2] - second[0], vy = second[3] - second[1];
      const cross = ux * vy - uy * vx, dot = ux * vx + uy * vy;
      return Math.abs(cross) <= 1e-9 && dot > 0;
    };
    for (let s = 0; s < segs.length; s++) {
      const a = segs[s];
      const x0 = Math.floor((Math.min(a[0], a[2]) - minX) / cell), x1 = Math.floor((Math.max(a[0], a[2]) - minX) / cell);
      const y0 = Math.floor((Math.min(a[1], a[3]) - minY) / cell), y1 = Math.floor((Math.max(a[1], a[3]) - minY) / cell);
      for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
        const key = gy * gw + gx; let list = grid.get(key);
        if (!list) { list = []; grid.set(key, list); }
        for (let t = 0; t < list.length; t++) if (hit(segs[list[t]], a)) return true;
        list.push(s);
      }
    }
    return false;
  }

  // ====================================================================== keyhole + editor mapping
  /* rings[0] = outline, the rest = holes  ->  one closed point list that fills the same area: each hole
     is joined to the outline by a zero-width cut. For editors that only know single polygons. */
  function toPolygon(rings) {
    if (!Array.isArray(rings) || !rings.length) return [];
    const norm = r => (Array.isArray(r) ? r : (r && r.points) || []).map(p => Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]);
    let outer = norm(rings[0]);
    if (rings.length === 1) return outer;
    const holes = rings.slice(1).map(norm).filter(h => h.length >= 3);
    const segHit = (a, b, c, d) => {
      const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
      return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
    };
    // leftmost holes first, each joined to the nearest outline vertex it can see
    holes.sort((p, q) => Math.min.apply(null, p.map(v => v[0])) - Math.min.apply(null, q.map(v => v[0])));
    const pending = holes.slice();
    while (pending.length) {
      const hole = pending.shift();
      const cand = [];
      const stepH = Math.max(1, Math.floor(hole.length / 24)), stepO = Math.max(1, Math.floor(outer.length / 400));
      for (let i = 0; i < hole.length; i += stepH) for (let j = 0; j < outer.length; j += stepO) {
        const dx = hole[i][0] - outer[j][0], dy = hole[i][1] - outer[j][1];
        cand.push([dx * dx + dy * dy, i, j]);
      }
      cand.sort((p, q) => p[0] - q[0]);
      let pickI = cand[0][1], pickJ = cand[0][2];
      const others = pending;
      for (let c = 0; c < cand.length && c < 300; c++) {
        const a = hole[cand[c][1]], b = outer[cand[c][2]];
        let blocked = false;
        const test = ring => { for (let t = 0, n = ring.length; t < n && !blocked; t++) { const p = ring[t], q = ring[(t + 1) % n]; if (p === a || q === a || p === b || q === b) continue; if (segHit(a, b, p, q)) blocked = true; } };
        test(outer); test(hole); for (let h = 0; h < others.length && !blocked; h++) test(others[h]);
        if (!blocked) { pickI = cand[c][1]; pickJ = cand[c][2]; break; }
      }
      const rot = hole.slice(pickI).concat(hole.slice(0, pickI));
      outer = outer.slice(0, pickJ + 1).concat(rot, [rot[0].slice()], [outer[pickJ].slice()], outer.slice(pickJ + 1));
    }
    return outer;
  }

  /* The traced objects in the shape js/editor/model.js keeps (see API.md). */
  function toEditorObjects(result, how) {
    const out = [];
    const objs = (result && result.objects) || [];
    const keyhole = !!(how && how.holes === 'polygon');
    for (const o of objs) {
      const style = {
        name: o.name, color: o.color, paint: o.type === 'path' ? 'fill' : 'line',
        lineType: (o.line && o.line.type) || 'running', lineWidth: (o.line && o.line.width) || 3,
        spacing: (o.fill && o.fill.spacing) || SEW.fillSpacing,
        stitchLen: o.type === 'path' ? ((o.fill && o.fill.stitchLength) || SEW.fillStitch) : ((o.line && o.line.stitchLength) || SEW.lineStitch),
        angle: Math.min(175, Math.max(0, Math.round((o.fill && o.fill.angle) || 0))),
      };
      if (o.fill && o.fill.underlay === false) style.underlay = false;
      let geom;
      if (o.type !== 'path') geom = { type: 'pen', pts: o.points.map(p => [p[0], p[1]]), closed: !!o.closed };
      else if (keyhole || o.rings.length === 1) geom = { type: 'polygon', pts: toPolygon(o.rings) };
      else geom = { type: 'path', rings: o.rings.map(r => r.map(p => [p[0], p[1]])), fillRule: 'nonzero' };
      out.push({ geom, style });
    }
    return out;
  }

  // ====================================================================== the pipeline
  function* pipeline(image, rawOptions, out) {
    const warnings = out.warnings, t0 = now(), stages = {};
    let tStage = t0;
    const lap = name => { const t = now(); stages[name] = Math.round((t - tStage) * 10) / 10; tStage = t; };
    const warn = (code, severity, message, extra) => warnings.push(Object.assign({ code, severity, message }, extra || {}));
    const opt = normalizeOptions(rawOptions, warnings);
    const D = DETAIL[opt.detail];
    out.options = opt;

    const okImage = image && typeof image === 'object' && Number.isInteger(image.width) && Number.isInteger(image.height) && image.width > 0 && image.height > 0 &&
      image.data && typeof image.data.length === 'number' && image.data.length >= image.width * image.height * 4;
    if (!okImage) { warn('INVALID_IMAGE', 'error', 'That is not a picture this tool can read (it needs width, height and RGBA pixel data).'); return finish(null); }
    if (image.width * image.height > LIMITS.inputPixels) { warn('IMAGE_TOO_LARGE', 'error', 'The picture is too large (' + Math.round(image.width * image.height / 1e6) + ' megapixels). Make it smaller first.'); return finish(null); }
    if (image.width / image.height > 40 || image.height / image.width > 40) { warn('INVALID_IMAGE', 'error', 'The picture is far too long and thin to embroider.'); return finish(null); }

    // ---- 1. prepare
    const P = prepare(image, opt, D);
    const { W, H, N } = P;
    lap('resample');
    yield 0.08;
    if (P.reduced) warn('RESOLUTION_REDUCED', 'info', 'The design is very large, so it was traced a little more coarsely (' + P.mmpp.toFixed(2) + ' mm steps).');
    const lowRes = P.srcPerMm < 2;   // reported at the end, unless the picture turns out to be one flat colour
    const hasAlpha = P.nOpaque < N * 0.995;
    if (P.nOpaque < 4) { warn('EMPTY_IMAGE', 'error', 'The picture is completely transparent, so there is nothing to sew.'); return finish(null); }

    // ---- 2. logo or photo?
    // (flat art with more colours than 12 is still flat art when that many are asked for: the probe grows with the ask)
    const probe = buildPalette(P, () => 1, Math.max(12, opt.colors === 'auto' ? opt.maxColors : opt.colors));
    /* How far apart the picture's colours are at all (OKLab, between probe colours holding 1% of it or more).
       Every colour threshold below is written for a picture of ordinary contrast; a very pale one (cream on
       white, light grey on white) has all its colours inside what would otherwise count as "the same colour",
       and came out as one blob. For such a picture the thresholds shrink in proportion. */
    let spread = 0;
    {
      // the distance from the picture's main colour that 1% of it lies beyond (so a pencil drawing, a few percent of
      // dark line on paper, counts as a picture of full contrast)
      let c = probe.centers[0]; for (const q of probe.centers) if (q.w > c.w) c = q;
      const hist = new Int32Array(256);
      for (let i = 0; i < N; i++) { if (!P.opaque[i]) continue; const dl = P.L[i] - c.L, da = P.A[i] - c.a, db = P.B[i] - c.b; hist[Math.min(255, (Math.sqrt(dl * dl + da * da + db * db) * 200) | 0)]++; }
      let left = P.nOpaque * 0.01, k = 255;
      while (k > 0 && (left -= hist[k]) > 0) k--;
      spread = (k + 0.5) / 200;
    }
    const spreadK = SPREADK_FORCE || Math.max(0.3, Math.min(1, spread / SEW.fullSpread));
    let cls0 = classifyPixels(P, 0.07 * spreadK, 0.03 * spreadK);
    const blended = SEW.blendTexture ? blendFineTexture(P, cls0.flat, Math.max(2, Math.round(0.65 / Math.sqrt(P.sx * P.sy))), Math.max(3, Math.round(1.5 / Math.sqrt(P.sx * P.sy)))) : 0;
    if (blended) cls0 = classifyPixels(P, 0.07 * spreadK, 0.03 * spreadK);
    let explained = 0;
    {
      // share of pixels that are almost exactly one of 12 colours: flat artwork nearly all (0.86 and up, even as a
      // rough JPEG), photographs well under 0.6 even when they look flat
      const c = probe.centers, tol2 = 0.012 * 0.012 * spreadK * spreadK; let hit = 0;
      for (let i = 0; i < N; i++) {
        if (!P.opaque[i]) continue;
        let bd = Infinity;
        for (let j = 0; j < c.length; j++) { const dl = P.L[i] - c[j].L, da = P.A[i] - c[j].a, db = P.B[i] - c[j].b, d = dl * dl + da * da + db * db; if (d < bd) bd = d; }
        if (bd < tol2) hit++;
      }
      explained = hit / P.nOpaque;
    }
    const flatShare = cls0.nFlat / P.nOpaque;
    const mode = opt.mode !== 'auto' ? opt.mode : (explained >= 0.72 && flatShare >= 0.5 ? 'logo' : 'photo');
    const photo = mode === 'photo';
    lap('detect');
    yield 0.14;

    // ---- 3. smooth
    if (photo) {
      for (let it = 0; it < D.photoIter; it++) { bilateral(P, 2, 0.085 * spreadK, 1); yield 0.14 + 0.16 * (it + 1) / D.photoIter; }
    } else bilateral(P, 1, 0.05 * spreadK, 1);
    lap('smooth');
    yield 0.3;

    // ---- 4. palette and labels
    const cls = classifyPixels(P, 0.07 * spreadK, (photo ? 0.035 : 0.02) * spreadK);
    const useFlat = cls.nFlat > P.nOpaque * 0.06;
    const mmPx = Math.sqrt(P.sx * P.sy);
    const minPx = Math.max(4, (photo ? D.photoArea : D.minArea) / (P.sx * P.sy));
    // a plain colour all around the edge is the background; it must not use up one of the thread colours
    let bgLab = null, borderShare = 0;
    if (!hasAlpha && opt.background !== 'off') {
      const b = borderColour(P, 0.045 * spreadK);
      if (b) borderShare = b.share;
      // drawings: 0.6, so a subject cut off by one edge of the picture (a face cropped at the neck) still loses its page
      if (b && (opt.background === 'on' || b.share >= (photo ? 0.97 : SEW.borderShare))) bgLab = b;
    }
    const weightOf = photo ? (i => (cls.flat[i] ? 1 : 0.3)) : (useFlat ? (i => (cls.flat[i] ? 1 : 0)) : (() => 1));
    const mergeDist = (photo ? 0.03 : 0.04) * spreadK;
    let pal, centers, bgLabel = -1, label;
    const findBg = () => {
      bgLabel = -1;
      if (!bgLab) return;
      let bd = Infinity;
      for (let j = 0; j < centers.length; j++) { const d = labDist(centers[j], bgLab); if (d < bd) { bd = d; bgLabel = j; } }
      if (bd > 0.08 * spreadK && opt.background !== 'on') bgLabel = -1;
    };
    // colours 'auto': pick the count first, then everything below runs exactly as for a number asked for
    let autoColours = null;
    if (opt.colors === 'auto') {
      const gen = chooseColours(P, weightOf, spreadK, opt.maxColors, bgLab && opt.holes ? 1 : 0, photo);
      for (;;) { const s = gen.next(); if (s.done) { autoColours = s.value; break; } yield 0.3 + 0.06 * s.value; }
      opt.colors = autoColours.colors;
    }
    const manyColours = !photo && opt.colors > SEW.blendsAbove;     // see withoutBlends
    const colourise = extra => {
      pal = buildPalette(P, weightOf, opt.colors + extra);
      centers = mergePalette(pal.centers, mergeDist, photo ? 0 : minPx * 2, manyColours);
      findBg();
      if (bgLabel < 0 && centers.length > opt.colors) { pal = buildPalette(P, weightOf, opt.colors); centers = mergePalette(pal.centers, mergeDist, photo ? 0 : minPx * 2, manyColours); findBg(); }
      // a colour that only ever appears as hairlines (a pen drawing) has no solid pixels to vote for it: when many
      // thin-line pixels point at no colour of the palette, add the colour they point at
      if (!photo && centers.length < opt.colors + (bgLabel >= 0 && extra ? 1 : 0)) {
        const far = [0]; let n = 0, sl = 0, sa = 0, sb = 0;
        for (let i = 0; i < N; i++) {
          if (cls.kind[i] !== 2) continue;
          const j = cls.ridgeFrom[i];
          ridgeColour(P, i, j, centers, far);
          if (far[0] < 0.05 * 0.05 * spreadK * spreadK) continue;
          n++; sl += 2 * P.L[i] - P.L[j]; sa += 2 * P.A[i] - P.A[j]; sb += 2 * P.B[i] - P.B[j];
        }
        if (n >= Math.max(24, minPx)) centers.push({ L: Math.min(1, Math.max(0, sl / n)), a: sa / n, b: sb / n, w: n });
      }
      label = assignLabels(P, cls, centers);
      if (photo) majorityFilter(label, W, H, centers.length, opt.detail === 'low' ? 2 : 1);
    };
    const requested = opt.colors;

    // ---- 5. background
    let bgInfo = { removed: hasAlpha, reason: hasAlpha ? 'transparent' : null, color: null };
    /* Takes the background out of the label map. Returns true when enclosed areas of the background colour were
       kept as thread, i.e. the background colour is a thread colour of the design as well. */
    const removeBackground = () => {
      if (bgLabel < 0) return false;
      const cc = components(label, W, H);
      const drop = new Uint8Array(cc.n);       // 1 = background reaching the picture edge, 2 = a hole
      for (let x = 0; x < W; x++) { drop[cc.comp[x]] = 1; drop[cc.comp[(H - 1) * W + x]] = 1; }
      for (let y = 0; y < H; y++) { drop[cc.comp[y * W]] = 1; drop[cc.comp[y * W + W - 1]] = 1; }
      let kept = 0, sewn = 0;
      for (let id = 0; id < cc.n; id++) { if (cc.lab[id] !== bgLabel) drop[id] = 0; if (cc.lab[id] !== bgLabel && cc.lab[id] >= 0) kept += cc.area[id]; }
      if (kept === 0 && opt.background === 'auto') { bgLabel = -1; return false; }   // one flat colour and nothing else: sew it, an empty result helps nobody
      if (opt.holes && !photo) {
        /* An enclosed area of the background colour is a hole (the inside of an O, of a ring, of a pen drawing)
           when the shape around it stands on the background by itself: it touches the background and no other
           colour. Inside a coloured drawing (the white of an eye, white lettering on a badge, the belly of an
           outlined cartoon) the same colour is part of the picture and is sewn. In a photograph it always is. */
        const pairs = new Map();                 // shared border length per pair of touching components
        const add = (p, q) => { if (p === q) return; const k = p < q ? p * cc.n + q : q * cc.n + p; pairs.set(k, (pairs.get(k) || 0) + 1); };
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (x < W - 1) add(cc.comp[i], cc.comp[i + 1]);
          if (y < H - 1) add(cc.comp[i], cc.comp[i + W]);
        }
        const nb = Array.from({ length: cc.n }, () => []);
        pairs.forEach((v, k) => { const p = Math.floor(k / cc.n), q = k % cc.n; nb[p].push(q, v); nb[q].push(p, v); });
        // start from "every enclosed area is a hole" and take back the ones that fail, until nothing changes (so a
        // ring inside a ring, or a checkerboard, where one hole vouches for the next, comes out right)
        for (let id = 0; id < cc.n; id++) if (cc.lab[id] === bgLabel && !drop[id]) drop[id] = 2;
        for (let round = 0; round < 12; round++) {
          let changed = false;
          for (let id = 0; id < cc.n; id++) {
            if (drop[id] !== 2) continue;
            let all = 0, plain = 0;
            for (let t = 0; t < nb[id].length; t += 2) {
              const x = nb[id][t], v = nb[id][t + 1];
              if (cc.area[x] < minPx) continue;            // a speck on the edge (soft corners, JPEG): absorbed later, no say here
              all += v;
              if (cc.lab[x] < 0) continue;
              // is x a shape that stands on the background by itself?
              let bg = 0, colour = 0, tot = 0;
              for (let u = 0; u < nb[x].length; u += 2) { const o = nb[x][u], w = nb[x][u + 1]; tot += w; if (drop[o]) bg += w; else if (cc.lab[o] !== bgLabel && cc.lab[o] >= 0 && cc.area[o] >= minPx) colour += w; }
              if (bg >= 3 && colour <= Math.max(4, 0.06 * tot)) plain += v;
            }
            if (!(all && plain >= 0.85 * all)) { drop[id] = 0; changed = true; }
          }
          if (!changed) break;
        }
      }
      for (let id = 0; id < cc.n; id++) {
        if (cc.lab[id] !== bgLabel) continue;
        if (!drop[id]) { sewn += cc.area[id]; continue; }
        for (let t = cc.start[id]; t < cc.start[id + 1]; t++) label[cc.order[t]] = -1;
      }
      const c = centers[bgLabel];
      bgInfo = { removed: true, reason: 'border', color: hexOf(labToRgb(c.L, c.a, c.b)) };
      return sewn >= minPx;
    };
    colourise(bgLab && opt.holes ? 1 : 0);
    // the background colour turned out to be one of the picture's own colours too: it has to fit into the number asked for
    if (INTERNAL.hook) INTERNAL.hook('labels', { label: label.slice(), kind: cls.kind, W, H, centers, mmPx: P.mmpp });
    if (removeBackground() && bgLab && opt.holes && centers.length > opt.colors && !(autoColours && centers.length <= opt.maxColors)) { colourise(0); removeBackground(); }
    /* A line drawn with a pencil, a soft brush or at low resolution is dark in the middle and paler at its edge, and
       the paler shade can win a place in the palette. Sewn, that is one line cut into bits of two threads. A colour
       that (a) is a mixture of the background and another colour, (b) is thin everywhere, and (c) lies against that
       other colour, is the same ink: it joins the darker colour. A pale line that runs by itself is left alone. */
    let inkMerged = 0;
    if (!photo && bgLabel >= 0 && bgInfo.removed && centers.length > 1) {
      const K = centers.length, bgC = centers[bgLabel];
      for (let round = 0; round < 4; round++) {
        const n = new Float64Array(K), core = new Float64Array(K), border = new Float64Array(K), to = new Float64Array(K * K);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = y * W + x, c = label[i];
          if (c < 0) continue;
          n[c]++;
          let deep = x >= 2 && y >= 2 && x < W - 2 && y < H - 2;
          for (let dy = -2; deep && dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (label[i + dy * W + dx] !== c) { deep = false; break; }
          if (deep) core[c]++;
          const see = j => { const o = label[j]; if (o === c) return; border[c]++; if (o >= 0) to[c * K + o]++; };
          if (x > 0) see(i - 1); if (x < W - 1) see(i + 1); if (y > 0) see(i - W); if (y < H - 1) see(i + W);
        }
        const into = new Int32Array(K).fill(-1);
        let any = false;
        for (let c = 0; c < K; c++) {
          if (c === bgLabel || !n[c] || core[c] > SEW.inkCore * n[c]) continue;
          let best = -1, bv = 0;
          for (let d = 0; d < K; d++) {
            if (d === c || d === bgLabel || !n[d] || to[c * K + d] < SEW.inkTouch * border[c] || to[c * K + d] <= bv) continue;
            // c = background + t * (d - background), within a tolerance
            const ux = centers[d].L - bgC.L, uy = centers[d].a - bgC.a, uz = centers[d].b - bgC.b, uu = ux * ux + uy * uy + uz * uz;
            const vx = centers[c].L - bgC.L, vy = centers[c].a - bgC.a, vz = centers[c].b - bgC.b;
            if (uu < 1e-6) continue;
            const t = (ux * vx + uy * vy + uz * vz) / uu;
            if (t < 0.08 || t > 0.97) continue;
            const off = Math.sqrt(Math.max(0, vx * vx + vy * vy + vz * vz - t * t * uu));
            if (off > SEW.inkOff * Math.max(0.5, spreadK)) continue;
            best = d; bv = to[c * K + d];
          }
          if (best >= 0 && into[best] !== c) { into[c] = best; any = true; }
        }
        if (!any) break;
        for (let i = 0; i < N; i++) { const c = label[i]; if (c >= 0 && into[c] >= 0) { label[i] = into[c]; inkMerged++; } }
      }
    }
    lap('colours');
    yield 0.4;
    lap('background');

    // ---- 6. specks, pinholes, and things too thin to fill
    const isoPx = Math.max(3, minPx * 0.6);
    const lines = [];   // { label, pts: [[x, y] px...], closed, widthMm }
    let thinDropped = 0, lost = 0, smallPrint = 0;

    /* Thin parts of the picture (narrower than maxWidthMm) become lines along their middle, and their
       pixels are handed to whatever lies beside them, so the fills meet underneath the line.
       strokes = false: hairlines (running / bean stitch), anything thin and long enough.
       strokes = true:  bands of even width (satin columns); uneven ones are left to be filled. */
    function extractThin(maxWidthMm, minLenMm, strokes) {
      const cc = components(label, W, H), firstLine = lines.length;
      const dist = distanceInside(cc.comp, W, H);
      const r = Math.max(1.2, (maxWidthMm / mmPx) / 2);
      const toCore = new Float32Array(N), hasCore = new Uint8Array(cc.n);
      for (let i = 0; i < N; i++) { if (dist[i] >= r) { toCore[i] = 0; hasCore[cc.comp[i]] = 1; } else toCore[i] = 1e9; }
      chamfer(toCore, cc.comp, W, H, 1, 1.41421);
      const thinFlag = new Uint8Array(N), group = new Int32Array(N);
      const limit = r + 1.6;
      let nThin = 0;
      for (let i = 0; i < N; i++) if (label[i] >= 0 && toCore[i] > limit) { thinFlag[i] = 1; nThin++; }
      if (!nThin) return;
      const stack = [], groups = [];
      let ng = 0;
      for (let s = 0; s < N; s++) {
        if (!thinFlag[s] || group[s]) continue;
        const g = ++ng, c = cc.comp[s], px = [];
        group[s] = g; stack.push(s);
        while (stack.length) {
          const i = stack.pop(), x = i % W, y = (i / W) | 0; px.push(i);
          for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= W) continue; const j = yy * W + xx; if (thinFlag[j] && !group[j] && cc.comp[j] === c) { group[j] = g; stack.push(j); } } }
        }
        groups.push({ g, comp: c, px });
      }
      // thinning on a padded copy, so neighbour reads never leave the array
      const W2 = W + 2, on = new Uint8Array(W2 * (H + 2)), grp = new Int32Array(W2 * (H + 2));
      const toPad = i => (((i / W) | 0) + 1) * W2 + (i % W) + 1;
      const distAt = j => dist[(((j / W2) | 0) - 1) * W + (j % W2) - 1];
      const padList = [];
      const minLen = minLenMm / mmPx;
      for (const G of groups) {
        // groups that can never make a line are not thinned at all (most of them, in a photograph)
        if (G.px.length < minLen) { G.small = true; continue; }
        for (const i of G.px) { const j = toPad(i); on[j] = 1; grp[j] = G.g; padList.push(j); }
      }
      const skel = thin(on, grp, padList, W2);
      const byGroup = new Map();
      for (const j of skel) { const g = grp[j]; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(j); }
      const release = [], cands = [], scraps = [];
      for (const G of groups) {
        const sk = G.small ? [] : (byGroup.get(G.g) || []);
        const wholeComp = G.px.length === cc.area[G.comp];
        if (sk.length < minLen) {
          // too short for a line. A thin tip of a larger shape stays part of it; a thin scrap on its own goes.
          if (!strokes && wholeComp && !hasCore[G.comp]) {
            release.push(G.px); thinDropped += G.px.length;
            let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
            for (const i of G.px) { const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
            scraps.push({ box: { x0, y0, x1, y1, tiny: true, print: false } });
          }
          continue;
        }
        const dv = sk.map(distAt).sort((a, b) => a - b), med = dv[dv.length >> 1];
        let widen = 1;
        if (strokes) {
          let even = 0; for (const v of dv) if (v >= 0.6 * med && v <= 1.5 * med) even++;
          if (even < 0.8 * dv.length) continue;                                  // not a band of even width: fill it instead
        }
        const paths = skeletonPaths(on, grp, sk, W2, strokes ? (j => 1.2 * distAt(j) + 2) : (() => 3));
        if (strokes) {
          // width from area / length: the thinned middle line is often a pixel off centre, which makes the
          // distance read along it too small (each free end adds about half a width of length)
          let L = 0, ends = 0;
          for (const pth of paths) {
            const p = pth.px;
            for (let k = 1; k < p.length; k++) { const d = Math.abs(p[k] - p[k - 1]); L += (d === 1 || d === W2) ? 1 : 1.41421; }
            ends += (pth.free0 ? 1 : 0) + (pth.free1 ? 1 : 0);
          }
          if (L < 2) continue;
          const A = G.px.length, k2 = ends / 2;
          const wA = k2 > 0 ? (-L + Math.sqrt(L * L + 4 * k2 * A)) / (2 * k2) : A / L;
          const groupWidth = wA * mmPx;
          if (groupWidth < 0.9 || groupWidth > maxWidthMm * 1.05) continue;
          if (2 * med > wA * 1.3 || 2 * med < wA * 0.5) continue;
          widen = Math.max(1, Math.min(1.6, wA / (2 * med)));
        }
        const made = [];
        let box = null;
        if (!strokes) {
          // small print: a tangle of hairlines only a few millimetres high cannot be sewn, and half of it is worse than none
          let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, len = 0;
          for (const i of G.px) { const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          for (const pth of paths) len += pth.px.length;
          const bw = (x1 - x0 + 1) * mmPx, bh = (y1 - y0 + 1) * mmPx;
          const loop = paths.length === 1 && paths[0].px.length > 3 && paths[0].px[0] === paths[0].px[paths[0].px.length - 1];
          box = { x0, y0, x1, y1, tiny: Math.max(bw, bh) < SEW.smallPrint * 1.15, print: !loop && Math.min(bw, bh) < SEW.smallPrint && len * mmPx > 1.4 * (bw + bh) };
        }
        for (const pth of paths) {
          const p = pth.px, closed = p.length > 3 && p[0] === p[p.length - 1];
          const q = closed ? p.slice(0, -1) : p;
          const pv = q.map(distAt).sort((a, b) => a - b), half = pv[pv.length >> 1];
          const widthMm = strokes ? Math.max(1, 2 * half * widen * mmPx) : Math.max(0.2, 2 * half * mmPx);
          const need = strokes ? Math.max(4, 2.2 * half, minLen * 0.4) : Math.max(3, minLen * (paths.length > 1 ? 0.6 : 1));
          if (q.length < need) continue;
          const pts = q.map(j => [(j % W2) - 1 + 0.5, ((j / W2) | 0) - 1 + 0.5]);
          if (strokes) {
            // thinning leaves the middle line up to a pixel off centre: slide each point across the band to where the
            // distance to both edges is the same
            const n = pts.length, dAt = (x, y) => { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= W || y >= H) return 0; const i = y * W + x; return cc.comp[i] === G.comp ? dist[i] : 0; };
            const moved = pts.map((p, k) => {
              const a = pts[closed ? (k - 3 + n) % n : Math.max(0, k - 3)], b = pts[closed ? (k + 3) % n : Math.min(n - 1, k + 3)];
              let tx = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tx, ty); if (l < 1e-6) return p;
              tx /= l; ty /= l;
              const dp = dAt(p[0] - ty, p[1] + tx), dm = dAt(p[0] + ty, p[1] - tx);
              const off = Math.max(-1, Math.min(1, (dp - dm) / 2));
              return [p[0] - ty * off, p[1] + tx * off];
            });
            for (let k = 0; k < n; k++) pts[k] = moved[k];
          }
          if (strokes && !closed) {
            // the skeleton stops short of the end of a band by about half its width: put that back
            const grow = (end, free) => {
              if (!free) return;
              const n = pts.length, a = pts[end ? n - 1 : 0], b = pts[end ? Math.max(0, n - 1 - 6) : Math.min(n - 1, 6)];
              const dx = a[0] - b[0], dy = a[1] - b[1], l = Math.hypot(dx, dy);
              const e = Math.max(0, distAt(q[end ? q.length - 1 : 0]) - 0.5);
              if (l < 1e-6 || e < 0.5) return;
              const np = [a[0] + dx / l * e, a[1] + dy / l * e];
              if (end) pts.push(np); else pts.unshift(np);
            };
            grow(false, pth.free0); grow(true, pth.free1);
          }
          made.push({ label: cc.lab[G.comp], closed, widthMm, pts, stroke: strokes });
        }
        cands.push({ G, made, box, wholeComp });
      }
      // lettering is many tiny pieces side by side: a tiny piece with tiny or tangled neighbours belongs to it
      if (!strokes) {
        const gap = 2.5 / mmPx, boxed = cands.filter(c => c.box && (c.box.tiny || c.box.print)).concat(scraps);
        for (const c of boxed) {
          if (!c.G || c.box.print || !c.box.tiny) continue;
          let near = 0, nearPrint = false;
          for (const o of boxed) {
            if (o === c) continue;
            const dx = Math.max(0, o.box.x0 - c.box.x1, c.box.x0 - o.box.x1), dy = Math.max(0, o.box.y0 - c.box.y1, c.box.y0 - o.box.y1);
            if (dx > gap || dy > gap) continue;
            near++; if (o.box.print) nearPrint = true;
          }
          if (near >= 2 || nearPrint) c.box.among = true;
        }
        // ... and so does the letter at the end of a word, which has a neighbour on one side only
        for (let again = true; again;) {
          again = false;
          for (const c of boxed) {
            if (!c.G || c.box.print || c.box.among || !c.box.tiny) continue;
            for (const o of boxed) {
              if (o === c || !(o.box.print || o.box.among)) continue;
              const dx = Math.max(0, o.box.x0 - c.box.x1, c.box.x0 - o.box.x1), dy = Math.max(0, o.box.y0 - c.box.y1, c.box.y0 - o.box.y1);
              if (dx <= gap && dy <= gap) { c.box.among = true; again = true; break; }
            }
          }
        }
      }
      for (const c of cands) {
        const G = c.G, gone = c.box && (c.box.print || c.box.among);
        if (gone) { if (c.wholeComp || !hasCore[G.comp]) { release.push(G.px); thinDropped += G.px.length; smallPrint += G.px.length; } continue; }
        if (c.made.length) { for (const m of c.made) { m.px = G.px; lines.push(m); } release.push(G.px); }
        else if (!strokes && c.wholeComp) { release.push(G.px); thinDropped += G.px.length; }
      }
      if (!release.length) return;
      // hand the released pixels to whatever surrounds them, growing inwards one ring at a time
      let pend = [];
      for (const px of release) for (const i of px) { label[i] = -2; pend.push(i); }
      for (let pass = 0; pass < 40 && pend.length; pass++) {
        const set = [], next = [];
        for (const i of pend) {
          const x = i % W, y = (i / W) | 0; let votes = null, best = -3, bc = 0;
          for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= W || (!dx && !dy)) continue; const lb = label[yy * W + xx]; if (lb === -2) continue; votes = votes || new Map(); const v = (votes.get(lb) || 0) + ((dx && dy) ? 1 : 2); votes.set(lb, v); if (v > bc || (v === bc && lb > best)) { bc = v; best = lb; } } }
          if (votes) set.push(i, best); else next.push(i);
        }
        for (let t = 0; t < set.length; t += 2) label[set[t]] = set[t + 1];
        if (next.length === pend.length) break;
        pend = next;
      }
      for (const i of pend) if (label[i] === -2) label[i] = -1;
      // a line whose own ground was handed back to its own colour (the inside of a letter, once the letter around
      // it became a line) would be thread on thread of the same colour: leave it out
      for (let k = lines.length - 1; k >= firstLine; k--) {
        const m = lines[k], px = m.px; let same = 0;
        for (const i of px) if (label[i] === m.label) same++;
        m.px = null;
        if (same > 0.6 * px.length) lines.splice(k, 1);
      }
    }

    // bands of even width first (they become satin columns), then whatever is left that is too thin to fill
    if (photo) { lost += absorbSpecks(label, W, H, centers, minPx, isoPx, 7); lap('specks'); yield 0.46; }
    else absorbSpecks(label, W, H, centers, 5, 5, 2, true);      // pinholes (JPEG ringing) would make bands look uneven
    extractThin(SEW.satinMaxWidth, photo ? 6 : 2.5, true);
    lap('strokes'); yield 0.52;
    if (INTERNAL.hook) INTERNAL.hook('strokes', { label: label.slice(), W, H });
    extractThin(SEW.lineMaxWidth, photo ? 5 : SEW.lineMinLength, false);
    if (INTERNAL.hook) INTERNAL.hook('lines', { label: label.slice(), W, H });
    lap('lines'); yield 0.56;
    lost += absorbSpecks(label, W, H, centers, minPx, isoPx, photo ? 4 : 7);
    lap(photo ? 'specks2' : 'specks');
    yield 0.6;

    // ---- 8. photographs: keep the number of regions sane
    let cc = components(label, W, H);
    if (photo) {
      let grow = minPx;
      for (let guard = 0; guard < 5; guard++) {
        let regions = 0; for (let id = 0; id < cc.n; id++) if (cc.lab[id] >= 0) regions++;
        if (regions <= D.maxRegions) break;
        grow *= 1.6;
        lost += absorbSpecks(label, W, H, centers, grow, grow * 0.6, 5);
        cc = components(label, W, H);
      }
    }
    const dist = distanceInside(cc.comp, W, H);
    // per region facts
    const R = [];
    const rIndex = new Int32Array(cc.n).fill(-1);
    for (let id = 0; id < cc.n; id++) {
      if (cc.lab[id] < 0) continue;
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, x0 = W, y0 = H, x1 = 0, y1 = 0, inr = 0;
      for (let t = cc.start[id]; t < cc.start[id + 1]; t++) {
        const i = cc.order[t], x = i % W, y = (i / W) | 0;
        sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (dist[i] > inr) inr = dist[i];
      }
      const a = cc.area[id], cx = sx / a, cy = sy / a;
      rIndex[id] = R.length;
      R.push({ id, label: cc.lab[id], area: a, cx: cx + 0.5, cy: cy + 0.5, x0, y0, x1, y1, inr,
        mxx: sxx / a - cx * cx, myy: syy / a - cy * cy, mxy: sxy / a - cx * cy, nbrs: new Set() });
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, a = rIndex[cc.comp[i]];
      if (a < 0) continue;
      if (x < W - 1) { const b = rIndex[cc.comp[i + 1]]; if (b >= 0 && b !== a) { R[a].nbrs.add(b); R[b].nbrs.add(a); } }
      if (y < H - 1) { const b = rIndex[cc.comp[i + W]]; if (b >= 0 && b !== a) { R[a].nbrs.add(b); R[b].nbrs.add(a); } }
    }
    lap('regions');
    yield 0.66;

    // ---- 9. order: colours by how "bulky" they are (background-most first), nearest neighbour inside a colour
    const K = centers.length, cArea = new Float64Array(K), cBulk = new Float64Array(K), cLine = new Float64Array(K);
    for (const r of R) { cArea[r.label] += r.area; cBulk[r.label] += r.area * r.inr; }
    for (const ln of lines) cLine[ln.label] += ln.pts.length;
    const used = [];
    for (let j = 0; j < K; j++) if (cArea[j] > 0 || cLine[j] > 0) used.push(j);
    const bulk = j => (cArea[j] > 0 ? (cBulk[j] / cArea[j]) * Math.sqrt(cArea[j]) : 0);
    used.sort((p, q) => (bulk(q) - bulk(p)) || (p - q));
    // what lies under each line (its own pixels were handed to the shapes beside it)
    const under = new Map();
    for (const ln of lines) {
      const cnt = new Map(); let n = 0;
      const side = ln.stroke ? 0.4 * ln.widthMm / mmPx : 0, np = ln.pts.length;
      for (let t = 0; t < np; t += 2) {
        const p = ln.pts[t], a = ln.pts[Math.max(0, t - 2)], b = ln.pts[Math.min(np - 1, t + 2)];
        let nx = -(b[1] - a[1]), ny = b[0] - a[0]; const l = Math.hypot(nx, ny) || 1; nx *= side / l; ny *= side / l;
        for (let k = side ? -1 : 0; k <= (side ? 1 : 0); k++) {
          const x = Math.min(W - 1, Math.max(0, (p[0] + k * nx) | 0)), y = Math.min(H - 1, Math.max(0, (p[1] + k * ny) | 0)), lb = label[y * W + x];
          n++; if (lb >= 0 && lb !== ln.label) cnt.set(lb, (cnt.get(lb) || 0) + 1);
        }
      }
      ln.over = [];
      cnt.forEach((v, lb) => { if (v >= 2 && v >= SEW.overShare * n) ln.over.push(lb); });
      if (ln.over.length) { if (!under.has(ln.label)) under.set(ln.label, new Map()); const u = under.get(ln.label); for (const lb of ln.over) u.set(lb, (u.get(lb) || 0) + np * mmPx * Math.max(0.4, ln.widthMm)); }
    }
    // only lines of some size (mm2 of thread) may change the order of the colours; a scrap gives way instead (see below)
    const SHORT = 6;
    under.forEach((u, c) => { u.forEach((len, d) => { if (len < SHORT) u.delete(d); }); if (!u.size) under.delete(c); });
    // a colour that draws lines over another colour's fills goes after it, so each thread is used once
    if (under.size) {
      const pending = used.slice(), placed = new Set(); used.length = 0;
      while (pending.length) {
        let pick = -1;
        for (let i = 0; i < pending.length && pick < 0; i++) {
          const u = under.get(pending[i]); let ok = true;
          if (u) u.forEach((len, d) => { if (!placed.has(d) && pending.indexOf(d) >= 0) ok = false; });
          if (ok) pick = i;
        }
        if (pick < 0) pick = 0;        // colours that cross each other both ways: one of them is threaded twice
        const c = pending.splice(pick, 1)[0]; used.push(c); placed.add(c);
      }
    }
    const rank = new Int32Array(K).fill(-1);
    used.forEach((j, i) => { rank[j] = i; });
    const seq = [];
    {
      let px = 0, py = 0;
      for (const j of used) {
        const mine = R.filter(r => r.label === j);
        // big regions of a colour first (they sit under the small ones), then by nearness
        const big = mine.filter(r => r.area >= 40 * minPx).sort((p, q) => q.area - p.area), small = mine.filter(r => r.area < 40 * minPx);
        for (const r of big) { seq.push(r); px = r.cx; py = r.cy; }
        while (small.length) {
          let bi = 0, bd = Infinity;
          for (let t = 0; t < small.length; t++) { const d = (small[t].cx - px) * (small[t].cx - px) + (small[t].cy - py) * (small[t].cy - py); if (d < bd) { bd = d; bi = t; } }
          const r = small.splice(bi, 1)[0]; seq.push(r); px = r.cx; py = r.cy;
        }
      }
    }
    // a line is sewn once every fill underneath it is done (and with its own colour when that is possible)
    for (const ln of lines) {
      let s = rank[ln.label];
      for (const lb of ln.over) if (rank[lb] > s) s = rank[lb];
      // a scrap of a line that would need its thread a second time is left out: the fill beside it already covers the place
      if (s > rank[ln.label] && (photo || ln.pts.length * mmPx * Math.max(0.4, ln.widthMm) < SHORT)) { ln.slot = -1; thinDropped += ln.pts.length * Math.max(1, ln.widthMm / mmPx); continue; }
      ln.slot = s;
    }
    // fill angles: neighbours get different directions so they read as separate shapes
    const ANGLES = [45, 135, 0, 90];
    for (const r of seq) {
      const tr = r.mxx + r.myy, det = r.mxx * r.myy - r.mxy * r.mxy, sq = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const elong = (tr / 2 + sq) / Math.max(1e-6, tr / 2 - sq);
      const widthMm = 2 * r.inr * mmPx;
      if (elong > 6 && widthMm < 7) {
        // a narrow band: rows across it, like a satin column. (Angle a = rows along (cos a, sin a), y down.)
        const th = 0.5 * Math.atan2(2 * r.mxy, r.mxx - r.myy) * 180 / Math.PI;   // direction of the long axis
        let a = Math.round((th + 90) / 5) * 5; a = ((a % 180) + 180) % 180; if (a > 175) a = 0;
        r.angle = a; r.band = true;
      } else {
        const taken = new Set(); r.nbrs.forEach(b => { if (R[b].angle !== undefined) taken.add(R[b].angle); });
        let a = ANGLES[rank[r.label] % 2]; if (taken.has(a)) for (const c of ANGLES) if (!taken.has(c)) { a = c; break; }
        r.angle = a;
      }
    }
    lap('order');
    yield 0.7;

    // ---- 10. outlines
    const U = Math.max(1, Math.round(SEW.underlap / mmPx));
    const holeFillPx = SEW.holeFill / (P.sx * P.sy);
    const tolPx = D.tol / mmPx;
    const ox = out.origin.x = (opt.x !== null ? opt.x : (opt.hoop ? (opt.hoop.width - P.widthMm) / 2 : 0));
    const oy = out.origin.y = (opt.y !== null ? opt.y : (opt.hoop ? (opt.hoop.height - P.heightMm) / 2 : 0));
    const r2 = v => Math.round(v * 100) / 100;
    const toMm = p => [r2(ox + Math.min(W, Math.max(0, p[0])) * P.sx), r2(oy + Math.min(H, Math.max(0, p[1])) * P.sy)];
    const objects = [];
    let fallbackRings = 0, points = 0, tinyObjects = 0;
    const lapped = new Uint8Array(N);
    const traceRegion = (r, underlap) => {
      const pad = underlap + 2;
      const bx = r.x0 - pad, by = r.y0 - pad, w = r.x1 - r.x0 + 1 + 2 * pad, h = r.y1 - r.y0 + 1 + 2 * pad;
      const m = new Uint8Array(w * h), myRank = rank[r.label];
      for (let t = cc.start[r.id]; t < cc.start[r.id + 1]; t++) { const i = cc.order[t]; m[((i / W | 0) - by) * w + (i % W) - bx] = 1; }
      // later[] = pixels of colours sewn after this one (the only place this shape may grow into)
      const later = new Uint8Array(w * h);
      for (let y = Math.max(0, by); y < Math.min(H, by + h); y++) for (let x = Math.max(0, bx); x < Math.min(W, bx + w); x++) {
        const lb = label[y * W + x]; if (lb >= 0 && rank[lb] > myRank && !(underlap && lapped[y * W + x])) later[(y - by) * w + x - bx] = 1;
      }
      for (let it = 0; it < underlap; it++) {
        const add = [], diag = it % 2 === 1;
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (m[i] || !later[i]) continue;
          if (m[i - 1] || m[i + 1] || m[i - w] || m[i + w] || (diag && (m[i - w - 1] || m[i - w + 1] || m[i + w - 1] || m[i + w + 1]))) add.push(i);
        }
        if (!add.length) break;
        for (let t = 0; t < add.length; t++) m[add[t]] = 1;
      }
      if (underlap) {
        // small holes that lie entirely under later colours: fill over them
        const mark = new Uint8Array(w * h), st = [];
        for (let x = 0; x < w; x++) { st.push(x, (h - 1) * w + x); }
        for (let y = 0; y < h; y++) { st.push(y * w, y * w + w - 1); }
        while (st.length) { const i = st.pop(); if (mark[i] || m[i]) continue; mark[i] = 1; const x = i % w; if (x > 0) st.push(i - 1); if (x < w - 1) st.push(i + 1); if (i >= w) st.push(i - w); if (i < w * h - w) st.push(i + w); }
        for (let s = 0; s < w * h; s++) {
          if (m[s] || mark[s]) continue;
          const px = []; let allLater = true; st.push(s); mark[s] = 1;
          while (st.length) { const i = st.pop(); px.push(i); if (!later[i]) allLater = false; const x = i % w; for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < w * h && !m[j] && !mark[j]) { mark[j] = 1; st.push(j); } }
          if (allLater && px.length < holeFillPx) for (const i of px) m[i] = 1;
        }
      }
      if (underlap) {
        // never more than two layers of fill anywhere: where one shape already reaches under a later one, no other may
        for (let y = Math.max(0, by); y < Math.min(H, by + h); y++) for (let x = Math.max(0, bx); x < Math.min(W, bx + w); x++) {
          if (m[(y - by) * w + x - bx] && cc.comp[y * W + x] !== r.id) lapped[y * W + x] = 1;
        }
      }
      fixSaddles(m, w, h);
      const raw = traceRings(m, w, h);
      for (let level = 0; level < 3; level++) {
        const rings = [];
        for (const g of raw) {
          const pts = smoothRing(g.pts, g.n, tolPx, level);
          if (pts.length < 3) continue;
          const a = ringArea(pts);
          if (Math.abs(a) < 2) continue;                       // a sliver left by simplification
          rings.push({ pts: pts.map(p => [p[0] + bx, p[1] + by]), area: a, rawArea: g.area });
        }
        if (!rings.some(g => g.area > 0)) return null;
        if (level < 2 && (rings.some((g) => (g.area > 0) !== (g.rawArea > 0)) || ringsIntersect(rings.map(g => g.pts)))) continue;
        if (level > 0) fallbackRings++;
        rings.sort((p, q) => q.area - p.area);
        return rings;
      }
      return null;
    };
    let curX = 0, curY = 0;
    const emitLines = list => {
      // lines of one colour together; inside a colour, always the nearest end next
      const byColour = new Map();
      for (const ln of list) { if (!byColour.has(ln.label)) byColour.set(ln.label, []); byColour.get(ln.label).push(ln); }
      for (const [, rest] of byColour) {
        while (rest.length) {
          let bi = 0, bd = Infinity, flip = false;
          for (let t = 0; t < rest.length; t++) {
            const a = rest[t].pts[0], b = rest[t].pts[rest[t].pts.length - 1];
            const da = (a[0] - curX) * (a[0] - curX) + (a[1] - curY) * (a[1] - curY), db = (b[0] - curX) * (b[0] - curX) + (b[1] - curY) * (b[1] - curY);
            if (da < bd) { bd = da; bi = t; flip = false; }
            if (db < bd && !rest[t].closed) { bd = db; bi = t; flip = true; }
          }
          const ln = rest.splice(bi, 1)[0];
          let pts = flip ? ln.pts.slice().reverse() : ln.pts;
          pts = smoothLine(pts, ln.closed, Math.max(0.35, tolPx * (ln.stroke ? 1.3 : 0.8)), ln.stroke ? G_FIN : G_PRE);
          if (pts.length < 2) continue;
          const last = pts[pts.length - 1]; curX = last[0]; curY = last[1];
          const lenMm = ringLength(pts, ln.closed) * mmPx;
          const type = ln.stroke ? 'satin' : ln.widthMm < SEW.runBelow ? 'running' : 'bean';
          const line = type === 'satin' ? { type, width: Math.min(6, Math.max(1, Math.round((ln.widthMm + SEW.satinPull) * 10) / 10)), spacing: SEW.fillSpacing } : { type, stitchLength: SEW.lineStitch };
          const obj = {
            id: 't' + (objects.length + 1), name: '', type: 'polyline', points: pts.map(toMm), closed: ln.closed,
            color: '', paint: 'line', line,
            trace: { kind: 'line', color: ln.label, lengthMm: r2(lenMm), widthMm: r2(ln.widthMm) },
          };
          obj._len = lenMm;
          points += obj.points.length;
          objects.push(obj);
        }
      }
    };
    let done = 0;
    const underlaid = new Uint8Array(R.length);   // regions already emitted as fills WITH underlay
    const edgeOnEarlier = r => {
      let tot = 0, sh = 0;
      for (let t = cc.start[r.id]; t < cc.start[r.id + 1]; t++) {
        const i = cc.order[t], x = i % W;
        for (let q = 0; q < 4; q++) {
          const j = q === 0 ? (x > 0 ? i - 1 : -1) : q === 1 ? (x < W - 1 ? i + 1 : -1) : q === 2 ? i - W : (i + W < N ? i + W : -1);
          if (j >= 0 && cc.comp[j] === r.id) continue;
          tot++;
          if (j >= 0 && underlaid[cc.comp[j]]) sh++;
        }
      }
      return tot ? sh / tot : 0;
    };
    for (let s = 0; s < used.length; s++) {
      for (const r of seq) {
        if (rank[r.label] !== s) continue;
        const rings = traceRegion(r, U);
        done++;
        if (done % 12 === 0) yield 0.7 + 0.22 * done / seq.length;
        if (!rings) continue;
        curX = r.cx; curY = r.cy;
        const bare = photo || edgeOnEarlier(r) >= SEW.inlaidShare;
        if (!bare) underlaid[r.id] = 1;
        // one outline per object; if a mask ever produced several, each becomes its own object with the holes inside it
        const outers = rings.filter(g => g.area > 0), holes = rings.filter(g => g.area < 0);
        for (let oi = 0; oi < outers.length; oi++) {
          const o = outers[oi];
          const mine = outers.length === 1 ? holes : holes.filter(hh => pointInRing(hh.pts[0], o.pts));
          const all = [o].concat(mine);
          const areaMm = (o.area + mine.reduce((sum, g) => sum + g.area, 0)) * P.sx * P.sy;
          const obj = {
            id: 't' + (objects.length + 1), name: '', type: 'path', rings: all.map(g => g.pts.map(toMm)), fillRule: 'nonzero',
            color: '', paint: 'fill', fill: { angle: r.angle, spacing: SEW.fillSpacing, stitchLength: SEW.fillStitch },
            trace: { kind: 'fill', color: r.label, areaMm2: r2(areaMm), widthMm: r2(2 * r.inr * mmPx), holes: mine.length },
          };
          obj._len = all.reduce((sum, g) => sum + ringLength(g.pts, true), 0) * mmPx;
          // photographs are filled without underlay: with it, the many ragged shapes and the travel runs they need
          // stack more thread than is good for the cloth (the engine's TOO_DENSE warning on every sample photograph)
          // A shape set into (or lying along) a fill that is already sewn with underlay goes without it too: that fill
          // holds the cloth around it, and two sets of underlay edge runs side by side along one seam are what the
          // engine reports as TOO_DENSE (measured: 8.1-9.4 mm/mm2 with both, under 8 with one).
          if (bare) obj.fill.underlay = false;
          for (const g of obj.rings) points += g.length;
          if (areaMm < 2.5) tinyObjects++;
          objects.push(obj);
        }
      }
      // this colour's own lines first, so the thread is not changed for them
      const mineFirst = lines.filter(ln => ln.slot === s).sort((p, q) => ((p.label === used[s] ? -1 : rank[p.label]) - (q.label === used[s] ? -1 : rank[q.label])));
      if (mineFirst.length) emitLines(mineFirst);
    }
    lap('outlines');
    yield 0.93;

    // ---- 12. optional outline in the darkest colour
    if (opt.outline && objects.length) {
      let dark = -1; for (const j of used) if (dark < 0 || centers[j].L < centers[dark].L) dark = j;
      let n = 0;
      for (const r of seq) {
        if (r.label === dark) continue;
        const rings = traceRegion(r, 0);
        if (!rings) continue;
        for (const g of rings) {
          const pts = g.pts.map(toMm);
          const obj = { id: 't' + (objects.length + 1), name: '', type: 'polyline', points: pts, closed: true, color: '', paint: 'line', line: { type: 'running', stitchLength: SEW.lineStitch },
            trace: { kind: 'outline', color: dark, lengthMm: r2(ringLength(g.pts, true) * mmPx), widthMm: 0.3 } };
          obj._c = centers[dark]; obj._len = obj.trace.lengthMm; points += pts.length; objects.push(obj); n++;
        }
        if (n % 20 === 0) yield 0.95;
      }
    }
    lap('lines-out');

    // ---- 13. colours, names, stats, warnings
    let kept = objects;
    if (kept.length > LIMITS.objects) {
      const score = o => (o.trace.kind === 'fill' ? o.trace.areaMm2 : o.trace.lengthMm * 0.5);
      const cut = kept.map(score).sort((a, b) => b - a)[LIMITS.objects - 1];
      const before = kept.length; let room = LIMITS.objects;
      kept = kept.filter(o => score(o) >= cut && room-- > 0);
      warn('TOO_MANY_SHAPES', 'warning', 'The picture broke into ' + before + ' shapes; only the ' + kept.length + ' largest were kept. Try fewer colours or less detail.', { dropped: before - kept.length });
    }
    const colorSlot = new Map(), colors = [];
    let estStitches = 0;
    for (const o of kept) {
      const j = o.trace.color;
      if (!colorSlot.has(j)) {
        const c = centers[j], rgb = labToRgb(c.L, c.a, c.b);
        colorSlot.set(j, colors.length);
        colors.push({ index: colors.length, hex: hexOf(rgb), name: colorName(c.L, c.a, c.b), thread: nearestThread(rgb), objects: 0, areaMm2: 0, lengthMm: 0, share: 0 });
      }
      const col = colors[colorSlot.get(j)];
      o.color = col.hex; o.trace.color = col.index; col.objects++;
      let est;
      if (o.type === 'path') {
        col.areaMm2 += o.trace.areaMm2;
        // fitted to what the engine really makes for 270 traced shapes: rows of fill (+ underlay) by area, row turns
        // and travel runs by outline length
        est = Math.max(8, o.trace.areaMm2 * (o.fill.underlay === false ? 0.74 : 1.05) + o._len * 2.75);
      } else {
        col.lengthMm += o.trace.lengthMm;
        est = o.line.type === 'satin' ? o.trace.lengthMm * 6.4 + 10 : o.trace.lengthMm / SEW.lineStitch * (o.line.type === 'bean' ? 3 : 1) + 8;
      }
      o.trace.stitches = Math.round(est); estStitches += est;
      delete o._c; delete o._len;
    }
    // names: "Red 1", "Red 2" ... per colour, in sewing order
    {
      const dup = new Map(); colors.forEach(c => dup.set(c.name, (dup.get(c.name) || 0) + 1));
      const seenName = new Map();
      colors.forEach(c => { if (dup.get(c.name) > 1) { const n = (seenName.get(c.name) || 0) + 1; seenName.set(c.name, n); c.name = c.name + ' ' + n; } });
      const counter = new Map();
      for (const o of kept) { const c = colors[o.trace.color], n = (counter.get(c.index) || 0) + 1; counter.set(c.index, n); o.name = c.name + (o.trace.kind === 'fill' ? ' ' : o.trace.kind === 'outline' ? ' outline ' : ' line ') + n; }
    }
    const totalArea = colors.reduce((s, c) => s + c.areaMm2, 0) || 1;
    colors.forEach(c => { c.areaMm2 = r2(c.areaMm2); c.lengthMm = r2(c.lengthMm); c.share = Math.round(c.areaMm2 / totalArea * 1000) / 1000; });

    if (!kept.length) { warn('EMPTY_IMAGE', 'error', bgInfo.removed ? 'Nothing was left after the background was removed. Try it with the background kept.' : 'Nothing sewable was found in the picture.'); return finish(P, { background: bgInfo, mode }); }
    if (photo) warn('PHOTO_POSTERIZED', 'warning', 'This looks like a photograph. Embroidery cannot blend colours, so it was reduced to ' + colors.length + ' flat colours; soft shading becomes bands. Bold, simple pictures work best.');
    if (bgInfo.removed && bgInfo.reason === 'border') warn('BACKGROUND_REMOVED', 'info', 'The plain background (' + bgInfo.color + ') was left out, so the fabric shows there.', { color: bgInfo.color });
    if (lowRes && !(colors.length === 1 && kept.length === 1)) warn('LOW_RESOLUTION', 'warning', 'The picture is small for this size (' + image.width + ' pixels across ' + Math.round(opt.width) + ' mm), so edges may come out soft or wobbly. A larger picture traces better.', { pixels: image.width, widthMm: opt.width });
    if (colors.length === 1 && kept.length === 1 && !bgInfo.removed) warn('SINGLE_COLOR', 'info', 'The picture is one flat colour, so the result is a single filled shape.');
    if (!autoColours && !photo && colors.length < requested && pal.centers.length > centers.length) warn('COLORS_MERGED', 'info', 'The picture has only ' + colors.length + (colors.length === 1 ? ' clearly different colour, so 1 thread is' : ' clearly different colours, so ' + colors.length + ' threads are') + ' used instead of ' + requested + '.', { colors: colors.length, requested });
    const lostShare = lost / Math.max(1, P.nOpaque);
    if (lostShare > 0.03 || thinDropped > 0.004 * P.nOpaque) warn('DETAIL_LOST', lostShare > 0.12 ? 'warning' : 'info', 'Some fine detail is too small to sew at this size and was merged into its surroundings (about ' + Math.max(1, Math.round(lostShare * 100)) + '% of the picture). Small text under about 5 mm tall does not survive.', { share: Math.round(lostShare * 1000) / 1000 });
    if (tinyObjects > 25 || kept.length > 220) warn('MANY_SMALL_SHAPES', 'warning', 'There are ' + kept.length + ' separate shapes (' + tinyObjects + ' of them tiny). Every one costs a thread trim. Fewer colours or less detail gives a cleaner sew.', { shapes: kept.length, tiny: tinyObjects });
    if (opt.hoop && (P.widthMm > opt.hoop.width + 1e-6 || P.heightMm > opt.hoop.height + 1e-6)) warn('EXCEEDS_HOOP', 'warning', 'At ' + Math.round(P.widthMm) + ' x ' + Math.round(P.heightMm) + ' mm the design is larger than the ' + opt.hoop.width + ' x ' + opt.hoop.height + ' mm hoop. Choose a smaller width.');
    if (estStitches > 60000) warn('MANY_STITCHES', 'warning', 'About ' + Math.round(estStitches / 1000) + ',000 stitches: a long sew and a stiff patch of thread. A smaller size or leaving the background out helps.', { stitches: Math.round(estStitches) });
    if (fallbackRings) out.fallbackRings = fallbackRings;
    lap('finish');
    return finish(P, { objects: kept, colors, background: bgInfo, mode, points, estStitches, regions: seq.length, lines: kept.filter(o => o.type === 'polyline').length, explained, flatShare, borderShare, spread, autoColours });

    function finish(P_, x) {
      x = x || {};
      out.result = {
        ok: !warnings.some(w => w.severity === 'error'),
        objects: x.objects || [],
        colors: x.colors || [],
        size: P_ ? { width: r2m(P_.widthMm), height: r2m(P_.heightMm) } : { width: 0, height: 0 },
        origin: { x: out.origin.x || 0, y: out.origin.y || 0 },
        mode: x.mode || null,
        background: x.background || { removed: false, reason: null, color: null },
        stats: {
          objects: (x.objects || []).length, regions: x.regions || 0, lines: x.lines || 0, colors: (x.colors || []).length,
          points: x.points || 0, estimatedStitches: Math.round(x.estStitches || 0),
          workWidth: P_ ? P_.W : 0, workHeight: P_ ? P_.H : 0, mmPerPixel: P_ ? Math.round(P_.mmpp * 1000) / 1000 : 0,
          timeMs: Math.round((now() - t0) * 10) / 10, stages,
          autoColors: x.autoColours ? { picked: x.autoColours.colors, max: out.options.maxColors, curve: x.autoColours.curve } : null,
          detect: { explained: Math.round((x.explained || 0) * 1000) / 1000, flat: Math.round((x.flatShare || 0) * 1000) / 1000, border: Math.round((x.borderShare || 0) * 1000) / 1000, spread: Math.round((x.spread || 0) * 1000) / 1000 },
        },
        warnings,
        version: VERSION,
      };
      return out.result;
    }
  }
  const r2m = v => Math.round(v * 100) / 100;

  function pointInRing(p, ring) {
    let inside = false;
    for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }

  /* Skeleton polyline (pixel centres) -> smoothed, simplified. Ends stay where they are. */
  function smoothLine(pts, closed, tol, kernel) {
    kernel = kernel || G_PRE; const kr = (kernel.length - 1) >> 1;
    const n = pts.length;
    if (n < 3) return pts.slice();
    const xs = new Float32Array(n + (closed ? 1 : 0)), ys = new Float32Array(n + (closed ? 1 : 0));
    const at = i => closed ? pts[((i % n) + n) % n] : pts[i < 0 ? 0 : i >= n ? n - 1 : i];
    const m = closed ? n + 1 : n;
    for (let i = 0; i < m; i++) { let x = 0, y = 0; for (let j = -kr; j <= kr; j++) { const p = at(i + j); x += kernel[j + kr] * p[0]; y += kernel[j + kr] * p[1]; } xs[i] = x; ys[i] = y; }
    if (!closed) { xs[0] = pts[0][0]; ys[0] = pts[0][1]; xs[n - 1] = pts[n - 1][0]; ys[n - 1] = pts[n - 1][1]; }
    const keep = new Uint8Array(m);
    if (closed) {
      let far = 1, fd = -1; for (let i = 1; i < n; i++) { const d = (xs[i] - xs[0]) * (xs[i] - xs[0]) + (ys[i] - ys[0]) * (ys[i] - ys[0]); if (d > fd) { fd = d; far = i; } }
      dp(xs, ys, 0, far, tol, keep); dp(xs, ys, far, n, tol, keep);
    } else dp(xs, ys, 0, n - 1, tol, keep);
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push([xs[i], ys[i]]);
    return out;
  }

  // ====================================================================== drivers
  function start(image, options) {
    const out = { warnings: [], origin: { x: 0, y: 0 }, result: null };
    return { out, it: pipeline(image, options, out) };
  }
  /* Synchronous. hooks.onProgress(fraction 0..1); hooks.shouldCancel() -> true stops with an Error code 'CANCELLED'. */
  function trace(image, options, hooks) {
    const { out, it } = start(image, options);
    hooks = hooks || {};
    for (;;) {
      const s = it.next();
      if (s.done) break;
      if (hooks.onProgress) hooks.onProgress(s.value);
      if (hooks.shouldCancel && hooks.shouldCancel()) throw makeError('CANCELLED', 'Tracing was cancelled.');
    }
    if (hooks.onProgress) hooks.onProgress(1);
    return out.result;
  }
  /* The same work in slices, giving the event loop a turn between them (for the main thread).
     hooks.onProgress(fraction); hooks.signal (AbortSignal) or hooks.shouldCancel() cancels: rejects with code 'CANCELLED'. */
  function traceAsync(image, options, hooks) {
    hooks = hooks || {};
    return new Promise((resolve, reject) => {
      let run;
      try { run = start(image, options); } catch (e) { reject(e); return; }
      const cancelled = () => (hooks.signal && hooks.signal.aborted) || (hooks.shouldCancel && hooks.shouldCancel());
      const step = () => {
        try {
          if (cancelled()) { reject(makeError('CANCELLED', 'Tracing was cancelled.')); return; }
          const until = now() + 12;
          for (;;) {
            const s = run.it.next();
            if (s.done) { if (hooks.onProgress) hooks.onProgress(1); resolve(run.out.result); return; }
            if (hooks.onProgress) hooks.onProgress(s.value);
            if (now() >= until) break;
          }
          setTimeout(step, 0);
        } catch (e) { reject(e); }
      };
      setTimeout(step, 0);
    });
  }

  return {
    version: VERSION, DEFAULTS, LIMITS, THREADS: THREADS.map((t, i) => ({ index: i + 1, name: t[3], hex: hexOf(t) })),
    trace, traceAsync, toPolygon, toEditorObjects,
    // exposed for tests and tools; may change
    _internal: Object.assign(INTERNAL, { AUTO, SEW, DETAIL, resample, traceRings, smoothRing, ringsIntersect, ringArea, components, rgbToLab, labToRgb, colorName, nearestThread, fixSaddles, thin, skeletonPaths }),
  };
});
