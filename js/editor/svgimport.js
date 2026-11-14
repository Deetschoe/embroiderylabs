/* ==========================================================================
   EMBROIDERY LABS - js/editor/svgimport.js
   SVG file -> shapes on the hoop.

   SAFETY. The file is text from a stranger. It is parsed with DOMParser into
   a separate, inert document (no scripts run there, nothing is fetched) and
   this module only READS that tree: no node is ever adopted or inserted into
   the page, nothing goes through innerHTML, and no attribute string is used
   as anything but data. Numbers go through parseFloat and must be finite;
   colours must survive a strict character filter and are then normalised by
   a canvas to #rrggbb; names in the layer list are our own words, not text
   from the file. Geometry is computed here (own path parser, own transforms),
   so the file never has to be rendered.

   Supported: svg, g, a, switch, use (local #id), rect (rx / ry), circle,
   ellipse, line, polyline, polygon, path (every command, relative forms,
   compact numbers and arc flags), transform lists, viewBox, width / height
   with units, fill / stroke / stroke-width / fill-rule from attributes,
   style="" and simple <style> rules (tag, .class, #id), inheritance through
   groups, currentColor, display:none.
   Left out and counted: text, images, foreignObject, gradient and pattern
   paints, clip paths, masks, filters, markers, dashes, opacity blending.

   Result: fills become fill objects ('path' with every ring, so letters keep
   their holes; a simple outline becomes a 'polygon'), strokes become line
   objects with a stitch type picked from their width. Everything is fitted
   inside the hoop, centred, added to the design in ONE undo step.
   Clean-up on the way (see build()): a background is taken for fabric and left
   out, colours are reduced to a few threads (10 by default), hairlines, specks
   and stray bits are dropped, and each colour becomes one compound object where
   paint order allows. Traced line drawings get the 'lineart' stitch style.

   Public:
     Editor.SvgImport.parse(text, hoop?, opts?) -> { ok, error?, list, report }   (no side effects)
         opts.keepBackground  keep a detected background as an object
         opts.maxColors       at most this many threads, 2..30 (default 10)
         report.hygiene = { background, backgroundColor, stackedHoles, hairlines, degenerate, specks, pinholes, merged, lineart }
         report.colors  = { before, after, max }
     Editor.SvgImport.importText(text, opts?) -> report (adds the shapes, shows a toast)
     Editor.SvgImport.importFile(file)       -> Promise<report>
     Editor.SvgImport.looksLikeSvg(file)     -> boolean
   ========================================================================== */
(function () {
  'use strict';
  var Editor = window.Editor;
  if (!Editor || !Editor.Geom || !Editor.Model) return;
  var G = Editor.Geom, M = Editor.Model;
  var S = Editor.SvgImport = {};

  var SVGNS = 'http://www.w3.org/2000/svg', XLINK = 'http://www.w3.org/1999/xlink';
  var MAX_BYTES = 5 * 1024 * 1024;   /* bigger files are refused */
  var MAX_NODES = 20000;             /* elements visited, <use> copies included */
  var MAX_DEPTH = 120, MAX_USE_DEPTH = 8;
  var MAX_COORD = 1e7;               /* a coordinate beyond this is treated as damage */
  var MAX_TOTAL_POINTS = 60000;      /* points added by one import (undo keeps snapshots) */
  var STEP = 0.6;                    /* mm between points on a curve (engine: 0.5 to 1 is plenty) */
  var PX_MM = 25.4 / 96;             /* one CSS px in millimetres */
  var FIT = 0.8;                     /* a file with no real size fills this share of the hoop */
  var NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

  /* ---------- small maths ------------------------------------------------------ */
  function mul(m, n) {
    return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  }
  function okMatrix(m) { for (var i = 0; i < 6; i++) if (!isFinite(m[i]) || Math.abs(m[i]) > MAX_COORD) return false; return true; }
  function nums(s, max) {
    var out = [], m; s = String(s == null ? '' : s); NUM.lastIndex = 0; max = max || 1e9;
    while (out.length < max && (m = NUM.exec(s))) out.push(parseFloat(m[0]));
    return out;
  }
  function parseTransform(s) {
    var m = [1, 0, 0, 1, 0, 0];
    if (!s) return m;
    s = String(s); if (s.length > 4000) return m;
    var re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g, x, a, t, r, c, sn;
    while ((x = re.exec(s))) {
      a = nums(x[2], 6); t = null;
      switch (x[1]) {
        case 'matrix': if (a.length === 6) t = a; break;
        case 'translate': if (a.length >= 1) t = [1, 0, 0, 1, a[0], a.length > 1 ? a[1] : 0]; break;
        case 'scale': if (a.length >= 1) t = [a[0], 0, 0, a.length > 1 ? a[1] : a[0], 0, 0]; break;
        case 'rotate':
          if (a.length >= 1) {
            r = a[0] * Math.PI / 180; c = Math.cos(r); sn = Math.sin(r);
            t = [c, sn, -sn, c, 0, 0];
            if (a.length >= 3) t = mul(mul([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]);
          }
          break;
        case 'skewX': if (a.length >= 1) t = [1, 0, Math.tan(a[0] * Math.PI / 180), 1, 0, 0]; break;
        case 'skewY': if (a.length >= 1) t = [1, Math.tan(a[0] * Math.PI / 180), 0, 1, 0, 0]; break;
      }
      if (t && okMatrix(t)) m = mul(m, t);
    }
    return okMatrix(m) ? m : [1, 0, 0, 1, 0, 0];
  }
  /* A length in user units (CSS px). ref = what 100% stands for. */
  var REAL_UNIT = /(mm|cm|in|pt|pc|q)\s*$/i;
  function len(v, ref, dflt) {
    if (v == null) return dflt;
    var m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|mm|cm|in|pt|pc|q|em|rem|ex|%)?\s*$/i.exec(String(v).slice(0, 64));
    if (!m) return dflt;
    var n = parseFloat(m[1]);
    if (!isFinite(n) || Math.abs(n) > MAX_COORD) return dflt;
    switch ((m[2] || '').toLowerCase()) {
      case 'mm': return n * 96 / 25.4;
      case 'cm': return n * 96 / 2.54;
      case 'in': return n * 96;
      case 'pt': return n * 96 / 72;
      case 'pc': return n * 16;
      case 'q': return n * 96 / 101.6;
      case 'em': case 'rem': return n * 16;
      case 'ex': return n * 8;
      case '%': return ref == null ? dflt : n / 100 * ref;
    }
    return n;
  }

  /* ---------- colours ------------------------------------------------------------ */
  var cctx = null;
  /* '#rrggbb' + alpha for a CSS colour string, or null when it is not a colour. */
  function cssColor(v) {
    if (typeof v !== 'string') return null;
    v = v.trim();
    if (!v || v.length > 64 || !/^[#a-zA-Z0-9(),.%\s\/+-]+$/.test(v)) return null;
    if (!cctx) { try { cctx = document.createElement('canvas').getContext('2d'); } catch (e) { cctx = null; } }
    var m;
    if (!cctx) { m = /^#([0-9a-f]{6})$/i.exec(v); return m ? { hex: '#' + m[1].toUpperCase(), a: 1 } : null; }
    var a, b;
    cctx.fillStyle = '#000001'; cctx.fillStyle = v; a = cctx.fillStyle;
    cctx.fillStyle = '#fffffe'; cctx.fillStyle = v; b = cctx.fillStyle;
    if (typeof a !== 'string' || a !== b) return null;                 /* the canvas refused it: not a colour */
    if ((m = /^#([0-9a-f]{6})$/i.exec(a))) return { hex: '#' + m[1].toUpperCase(), a: 1 };
    if ((m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(a))) {
      var h = '#' + [m[1], m[2], m[3]].map(function (n) { n = Math.max(0, Math.min(255, parseInt(n, 10))); return (n < 16 ? '0' : '') + n.toString(16); }).join('').toUpperCase();
      return { hex: h, a: m[4] == null ? 1 : parseFloat(m[4]) };
    }
    return null;
  }
  /* What a fill / stroke value means: { none } | { grad } | { hex } | null (not valid: ignore the declaration) */
  function paintOf(v, color) {
    if (typeof v !== 'string') return null;
    v = v.trim();
    if (!v) return null;
    var low = v.toLowerCase();
    if (low === 'none' || low === 'transparent') return { none: true };
    if (low.slice(0, 4) === 'url(') return { grad: true };             /* gradient or pattern: never fetched, never followed */
    if (low === 'currentcolor') return color ? { hex: color } : { hex: '#000000' };
    if (low === 'context-fill' || low === 'context-stroke') return { none: true };
    var c = cssColor(v);
    if (!c) return null;
    if (c.a < 0.05) return { none: true };
    return { hex: c.hex };
  }

  /* ---------- styles ---------------------------------------------------------------- */
  var ATTRS = ['fill', 'stroke', 'stroke-width', 'fill-rule', 'fill-opacity', 'stroke-opacity', 'opacity', 'display', 'visibility', 'color'];
  var KNOWN = {}; ATTRS.forEach(function (k) { KNOWN[k] = 1; }); KNOWN.transform = 1;
  function parseDecls(text, into) {
    if (!text) return into;
    text = String(text); if (text.length > 20000) text = text.slice(0, 20000);
    text.split(';').forEach(function (part) {
      var i = part.indexOf(':'); if (i < 1) return;
      var k = part.slice(0, i).trim().toLowerCase();
      if (!KNOWN[k]) return;
      into[k] = part.slice(i + 1).replace(/!\s*important\s*$/i, '').trim();
    });
    return into;
  }
  /* <style> text -> simple rules. Only tag, .class and #id selectors (and their compounds) are understood. */
  function parseSheet(text, rules) {
    if (!text) return;
    text = String(text); if (text.length > 300000) return;
    text = text.replace(/\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g, '').replace(/<!--|-->/g, '');
    var re = /([^{}]+)\{([^{}]*)\}/g, m;
    while (rules.length < 3000 && (m = re.exec(text))) {
      var decls = parseDecls(m[2], {}), has = false, k;
      for (k in decls) { has = true; break; }
      if (!has) continue;
      m[1].split(',').forEach(function (sel) {
        var s = /^\s*([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+)*)\s*$/.exec(sel);
        if (!s || (!s[1] && !s[2])) return;
        var id = null, classes = [];
        (s[2].match(/[.#][\w-]+/g) || []).forEach(function (p) { if (p.charAt(0) === '#') id = p.slice(1); else classes.push(p.slice(1)); });
        var tag = s[1] && s[1] !== '*' ? s[1] : null;
        rules.push({ tag: tag, id: id, classes: classes, decls: decls, spec: (id ? 10000 : 0) + classes.length * 100 + (tag ? 1 : 0), order: rules.length });
      });
    }
  }
  function matches(rule, node, classes) {
    if (rule.tag && rule.tag !== node.localName) return false;
    if (rule.id && rule.id !== node.getAttribute('id')) return false;
    for (var i = 0; i < rule.classes.length; i++) if (classes.indexOf(rule.classes[i]) === -1) return false;
    return true;
  }

  /* ---------- path data -> subpaths --------------------------------------------------- */
  /* A subpath: { start: [x, y], segs: [[x, y] | [x1, y1, x2, y2, x, y]], closed } (line or cubic) */
  function arcSegs(x0, y0, rx, ry, rot, large, sweep, x, y) {
    if (x0 === x && y0 === y) return [];
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (!rx || !ry) return [[x, y]];
    var phi = rot * Math.PI / 180, cp = Math.cos(phi), sp = Math.sin(phi);
    var dx = (x0 - x) / 2, dy = (y0 - y) / 2;
    var x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
    var l = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry);
    if (l > 1) { l = Math.sqrt(l); rx *= l; ry *= l; }
    var den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    var k = den ? Math.sqrt(Math.max(0, (rx * rx * ry * ry - den) / den)) : 0;
    if (!!large === !!sweep) k = -k;
    var cxp = k * rx * y1 / ry, cyp = -k * ry * x1 / rx;
    var cx = cp * cxp - sp * cyp + (x0 + x) / 2, cy = sp * cxp + cp * cyp + (y0 + y) / 2;
    var t1 = Math.atan2((y1 - cyp) / ry, (x1 - cxp) / rx), t2 = Math.atan2((-y1 - cyp) / ry, (-x1 - cxp) / rx);
    var dt = t2 - t1;
    if (sweep && dt < 0) dt += 2 * Math.PI; else if (!sweep && dt > 0) dt -= 2 * Math.PI;
    var n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9)), step = dt / n, t = 4 / 3 * Math.tan(step / 4), out = [], i;
    function map(u, v) { return [cx + cp * rx * u - sp * ry * v, cy + sp * rx * u + cp * ry * v]; }
    for (i = 0; i < n; i++) {
      var a1 = t1 + i * step, a2 = a1 + step, c1 = Math.cos(a1), s1 = Math.sin(a1), c2 = Math.cos(a2), s2 = Math.sin(a2);
      var p1 = map(c1 - t * s1, s1 + t * c1), p2 = map(c2 + t * s2, s2 - t * c2), p = i === n - 1 ? [x, y] : map(c2, s2);
      out.push([p1[0], p1[1], p2[0], p2[1], p[0], p[1]]);
    }
    return out;
  }
  var NUM_AT = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  function parsePath(d) {
    var subs = [], cur = null;
    if (typeof d !== 'string' || d.length > 2000000) return subs;
    var i = 0, n = d.length, cmd = '', x = 0, y = 0, sx = 0, sy = 0, px = 0, py = 0, prev = '', first = true;
    function ws() { for (; i < n; i++) { var c = d.charCodeAt(i); if (c !== 32 && c !== 44 && c !== 9 && c !== 10 && c !== 13 && c !== 12) break; } }
    function num() { ws(); NUM_AT.lastIndex = i; var m = NUM_AT.exec(d); if (!m) return NaN; i = NUM_AT.lastIndex; return parseFloat(m[0]); }
    function flag() { ws(); var c = d.charAt(i); if (c === '0' || c === '1') { i++; return c === '1' ? 1 : 0; } return NaN; }
    function begin() { cur = { start: [x, y], segs: [], closed: false }; subs.push(cur); }
    function bad() { for (var k = 0; k < arguments.length; k++) if (!isFinite(arguments[k]) || Math.abs(arguments[k]) > MAX_COORD) return true; return false; }
    for (;;) {
      ws(); if (i >= n) break;
      var ch = d.charAt(i);
      if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
        if ('MmLlHhVvCcSsQqTtAaZz'.indexOf(ch) === -1) break;
        if (first && ch !== 'M' && ch !== 'm') break;
        cmd = ch; i++;
        if (cmd === 'Z' || cmd === 'z') { if (cur) cur.closed = true; cur = null; x = sx; y = sy; prev = 'Z'; continue; }
      } else if (!cmd || cmd === 'Z' || cmd === 'z') break;             /* a number with no command to belong to */
      first = false;
      var rel = cmd >= 'a', C = cmd.toUpperCase(), a, b, c1, c2, e, f, r1, r2, ro, fa, fs, list, k2;
      if (C === 'M') {
        a = num(); b = num(); if (bad(a, b)) break;
        if (rel) { a += x; b += y; }
        x = sx = a; y = sy = b; begin();
        cmd = rel ? 'l' : 'L'; prev = 'M'; continue;                     /* more pairs after a moveto are linetos */
      }
      if (C === 'L') { a = num(); b = num(); if (bad(a, b)) break; if (rel) { a += x; b += y; } }
      else if (C === 'H') { a = num(); if (bad(a)) break; if (rel) a += x; b = y; }
      else if (C === 'V') { b = num(); if (bad(b)) break; if (rel) b += y; a = x; }
      if (C === 'L' || C === 'H' || C === 'V') { if (!cur) begin(); cur.segs.push([a, b]); x = a; y = b; prev = 'L'; continue; }
      if (C === 'C') {
        a = num(); b = num(); c1 = num(); c2 = num(); e = num(); f = num(); if (bad(a, b, c1, c2, e, f)) break;
        if (rel) { a += x; b += y; c1 += x; c2 += y; e += x; f += y; }
      } else if (C === 'S') {
        c1 = num(); c2 = num(); e = num(); f = num(); if (bad(c1, c2, e, f)) break;
        if (rel) { c1 += x; c2 += y; e += x; f += y; }
        if (prev === 'C') { a = 2 * x - px; b = 2 * y - py; } else { a = x; b = y; }
      }
      if (C === 'C' || C === 'S') { if (!cur) begin(); cur.segs.push([a, b, c1, c2, e, f]); px = c1; py = c2; x = e; y = f; prev = 'C'; continue; }
      if (C === 'Q') {
        a = num(); b = num(); e = num(); f = num(); if (bad(a, b, e, f)) break;
        if (rel) { a += x; b += y; e += x; f += y; }
      } else if (C === 'T') {
        e = num(); f = num(); if (bad(e, f)) break;
        if (rel) { e += x; f += y; }
        if (prev === 'Q') { a = 2 * x - px; b = 2 * y - py; } else { a = x; b = y; }
      }
      if (C === 'Q' || C === 'T') {
        if (!cur) begin();
        cur.segs.push([x + 2 / 3 * (a - x), y + 2 / 3 * (b - y), e + 2 / 3 * (a - e), f + 2 / 3 * (b - f), e, f]);
        px = a; py = b; x = e; y = f; prev = 'Q'; continue;
      }
      if (C === 'A') {
        r1 = num(); r2 = num(); ro = num(); fa = flag(); fs = flag(); e = num(); f = num();
        if (bad(r1, r2, ro, fa, fs, e, f)) break;
        if (rel) { e += x; f += y; }
        if (!cur) begin();
        list = arcSegs(x, y, r1, r2, ro, fa, fs, e, f);
        for (k2 = 0; k2 < list.length; k2++) cur.segs.push(list[k2]);
        x = e; y = f; prev = 'A'; continue;
      }
      break;
    }
    return subs;
  }
  function ellipseSubs(cx, cy, rx, ry) {
    var s = { start: [cx + rx, cy], segs: [], closed: true };
    s.segs = arcSegs(cx + rx, cy, rx, ry, 0, 0, 1, cx - rx, cy).concat(arcSegs(cx - rx, cy, rx, ry, 0, 0, 1, cx + rx, cy));
    return [s];
  }
  function rectSubs(x, y, w, h, rx, ry) {
    if (!rx && !ry) return [{ start: [x, y], segs: [[x + w, y], [x + w, y + h], [x, y + h]], closed: true }];
    var s = { start: [x + rx, y], segs: [], closed: true }, q = s.segs;
    function arc(x0, y0, x1, y1) { arcSegs(x0, y0, rx, ry, 0, 0, 1, x1, y1).forEach(function (a) { q.push(a); }); }
    q.push([x + w - rx, y]); arc(x + w - rx, y, x + w, y + ry);
    q.push([x + w, y + h - ry]); arc(x + w, y + h - ry, x + w - rx, y + h);
    q.push([x + rx, y + h]); arc(x + rx, y + h, x, y + h - ry);
    q.push([x, y + ry]); arc(x, y + ry, x + rx, y);
    return [s];
  }
  function polySubs(text, closed) {
    var a = nums(text, 200000), pts = [], i;
    for (i = 0; i + 1 < a.length; i += 2) { if (!isFinite(a[i]) || !isFinite(a[i + 1]) || Math.abs(a[i]) > MAX_COORD || Math.abs(a[i + 1]) > MAX_COORD) return []; pts.push([a[i], a[i + 1]]); }
    if (pts.length < 2) return [];
    return [{ start: pts[0], segs: pts.slice(1), closed: closed }];
  }
  function applyMatrix(subs, m) {
    function X(x, y) { return m[0] * x + m[2] * y + m[4]; }
    function Y(x, y) { return m[1] * x + m[3] * y + m[5]; }
    return subs.map(function (s) {
      return {
        closed: s.closed, start: [X(s.start[0], s.start[1]), Y(s.start[0], s.start[1])],
        segs: s.segs.map(function (g) {
          var o = [], i; for (i = 0; i < g.length; i += 2) o.push(X(g[i], g[i + 1]), Y(g[i], g[i + 1]));
          return o;
        })
      };
    });
  }
  /* Subpath -> points. k, tx, ty map the file's px to hoop millimetres; step is the spacing on curves. */
  function flatten(s, k, tx, ty, step) {
    var pts = [], x = s.start[0], y = s.start[1], i, j;
    function put(px, py) {
      var q = [G.r2(px * k + tx), G.r2(py * k + ty)], l = pts[pts.length - 1];
      if (!l || l[0] !== q[0] || l[1] !== q[1]) pts.push(q);
    }
    put(x, y);
    for (i = 0; i < s.segs.length; i++) {
      var g = s.segs[i];
      if (g.length === 2) { put(g[0], g[1]); x = g[0]; y = g[1]; continue; }
      var chord = G.dist(x, y, g[4], g[5]), poly = G.dist(x, y, g[0], g[1]) + G.dist(g[0], g[1], g[2], g[3]) + G.dist(g[2], g[3], g[4], g[5]);
      var n = (poly - chord) * k < 0.01 ? 1 : Math.max(2, Math.min(600, Math.ceil((chord + poly) / 2 * k / step)));
      for (j = 1; j <= n; j++) {
        var t = j / n, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
        put(a * x + b * g[0] + c * g[2] + d * g[4], a * y + b * g[1] + c * g[3] + d * g[5]);
      }
      x = g[4]; y = g[5];
    }
    return pts;
  }

  /* ---------- the walk: parsed tree -> shapes in the file's px space ------------------- */
  function emptyReport() {
    return { added: 0, fills: 0, lines: 0, width: 0, height: 0, fitted: false, skipped: { text: 0, image: 0, gradient: 0, other: 0, tiny: 0, full: 0 },
      hygiene: null, colors: null };
  }
  var NO_RENDER = { defs: 1, symbol: 1, clipPath: 1, mask: 1, marker: 1, pattern: 1, linearGradient: 1, radialGradient: 1, metadata: 1, title: 1, desc: 1, style: 1, filter: 1 };
  var SHAPES = { rect: 1, circle: 1, ellipse: 1, line: 1, polyline: 1, polygon: 1, path: 1 };
  var NAMES = { rect: 'Rectangle', circle: 'Circle', ellipse: 'Ellipse', line: 'Line', polyline: 'Polyline', polygon: 'Polygon', path: 'Path' };

  function collect(root, report) {
    var shapes = [], rules = [], ids = {}, budget = MAX_NODES, i;
    /* one pass for ids and <style> text (read as text, never applied to the page) */
    var all = root.getElementsByTagName('*'), count = Math.min(all.length, 200000);
    for (i = 0; i < count; i++) {
      var id = all[i].getAttribute('id');
      if (id && !Object.prototype.hasOwnProperty.call(ids, id)) ids[id] = all[i];
      if (all[i].localName === 'style' && all[i].namespaceURI === SVGNS) parseSheet(all[i].textContent, rules);
    }
    rules.sort(function (a, b) { return a.spec - b.spec || a.order - b.order; });

    var vbA = nums(root.getAttribute('viewBox'), 4), vb = null;
    if (vbA.length === 4 && vbA[2] > 0 && vbA[3] > 0 && okMatrix([vbA[0], vbA[1], vbA[2], vbA[3], 0, 0])) vb = { x: vbA[0], y: vbA[1], w: vbA[2], h: vbA[3] };
    var wAttr = root.getAttribute('width'), hAttr = root.getAttribute('height');
    var real = REAL_UNIT.test(wAttr || '') || REAL_UNIT.test(hAttr || '');
    var w = len(wAttr, null, null), h = len(hAttr, null, null), base = [1, 0, 0, 1, 0, 0];
    if (!(w > 0)) w = null; if (!(h > 0)) h = null;
    if (vb) {
      if (w == null && h == null) { w = vb.w; h = vb.h; }
      else if (w == null) w = h * vb.w / vb.h;
      else if (h == null) h = w * vb.h / vb.w;
      var sx = w / vb.w, sy = h / vb.h, par = String(root.getAttribute('preserveAspectRatio') || '').slice(0, 40);
      if (!/none/.test(par)) { sx = sy = /slice/.test(par) ? Math.max(sx, sy) : Math.min(sx, sy); }
      base = [sx, 0, 0, sy, -vb.x * sx, -vb.y * sy];
      if (!okMatrix(base)) base = [1, 0, 0, 1, 0, 0];
    }
    var refW = vb ? vb.w : (w || 100), refH = vb ? vb.h : (h || 100), refD = Math.sqrt((refW * refW + refH * refH) / 2);

    function styleOf(node, parent) {
      var d = {}, k, v, cls = String(node.getAttribute('class') || '').split(/\s+/);
      for (k = 0; k < ATTRS.length; k++) { v = node.getAttribute(ATTRS[k]); if (v != null) d[ATTRS[k]] = String(v).trim(); }
      for (k = 0; k < rules.length; k++) if (matches(rules[k], node, cls)) for (v in rules[k].decls) d[v] = rules[k].decls[v];
      parseDecls(node.getAttribute('style'), d);
      var st = { fill: parent.fill, stroke: parent.stroke, sw: parent.sw, rule: parent.rule, color: parent.color, hidden: parent.hidden, tf: null };
      if (d.color != null) { var c = cssColor(d.color); if (c) st.color = c.hex; }
      var p;
      if (d.fill != null && d.fill.toLowerCase() !== 'inherit' && (p = paintOf(d.fill, st.color))) st.fill = p;
      if (d.stroke != null && d.stroke.toLowerCase() !== 'inherit' && (p = paintOf(d.stroke, st.color))) st.stroke = p;
      if (d['stroke-width'] != null) { v = len(d['stroke-width'], refD, null); if (v != null && v >= 0) st.sw = v; }
      if (d['fill-rule'] != null) { v = d['fill-rule'].toLowerCase(); if (v === 'evenodd' || v === 'nonzero') st.rule = v; }
      if (d['fill-opacity'] != null && parseFloat(d['fill-opacity']) < 0.05 && !st.fill.grad) st.fill = { none: true };
      if (d['stroke-opacity'] != null && parseFloat(d['stroke-opacity']) < 0.05 && !st.stroke.grad) st.stroke = { none: true };
      if (d.opacity != null && parseFloat(d.opacity) < 0.05) st.hidden = true;
      if (d.display != null && d.display.toLowerCase() === 'none') st.hidden = true;
      if (d.visibility != null) { v = d.visibility.toLowerCase(); if (v === 'hidden' || v === 'collapse') st.vis = false; else if (v === 'visible') st.vis = true; else st.vis = parent.vis; } else st.vis = parent.vis;
      if (d.transform != null) st.tf = d.transform;
      return st;
    }
    function matrixOf(node, st, m) {
      var t = node.getAttribute('transform');
      if (t) m = mul(m, parseTransform(t));
      if (st.tf) m = mul(m, parseTransform(st.tf));
      return okMatrix(m) ? m : null;
    }
    function shape(node, tag, st, m) {
      var a = function (name, ref, dflt) { return len(node.getAttribute(name), ref, dflt); }, subs = [];
      var x, y, ww, hh, rx, ry;
      if (tag === 'rect') {
        x = a('x', refW, 0); y = a('y', refH, 0); ww = a('width', refW, 0); hh = a('height', refH, 0);
        rx = a('rx', refW, null); ry = a('ry', refH, null);
        if (rx == null && ry == null) rx = ry = 0; else if (rx == null) rx = ry; else if (ry == null) ry = rx;
        rx = Math.max(0, Math.min(rx, ww / 2)); ry = Math.max(0, Math.min(ry, hh / 2));
        if (ww > 0 && hh > 0) subs = rectSubs(x, y, ww, hh, rx, ry);
      } else if (tag === 'circle') {
        rx = a('r', refD, 0); if (rx > 0) subs = ellipseSubs(a('cx', refW, 0), a('cy', refH, 0), rx, rx);
      } else if (tag === 'ellipse') {
        rx = a('rx', refW, 0); ry = a('ry', refH, 0); if (rx > 0 && ry > 0) subs = ellipseSubs(a('cx', refW, 0), a('cy', refH, 0), rx, ry);
      } else if (tag === 'line') {
        subs = [{ start: [a('x1', refW, 0), a('y1', refH, 0)], segs: [[a('x2', refW, 0), a('y2', refH, 0)]], closed: false }];
      } else if (tag === 'polyline' || tag === 'polygon') {
        subs = polySubs(node.getAttribute('points'), tag === 'polygon');
      } else if (tag === 'path') {
        subs = parsePath(node.getAttribute('d') || '');
      }
      subs = subs.filter(function (s) { return s.segs.length > 0; });
      if (!subs.length) { report.skipped.other++; return; }
      var fill = tag === 'line' ? { none: true } : st.fill, stroke = st.stroke;
      if (fill.grad) report.skipped.gradient++;
      if (stroke.grad) report.skipped.gradient++;
      var f = fill.hex || null, s = stroke.hex && st.sw > 0 ? stroke.hex : null;
      if (!f && !s) { if (!fill.grad && !stroke.grad) report.skipped.other++; return; }
      shapes.push({ tag: tag, subs: applyMatrix(subs, m), fill: f, stroke: s, sw: st.sw * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])), rule: st.rule });
    }
    function walk(node, parent, m, depth, useDepth, viaUse) {
      if (budget-- <= 0 || depth > MAX_DEPTH) { report.skipped.other++; return; }
      if (node.nodeType !== 1) return;
      var tag = node.localName;
      if (node.namespaceURI !== SVGNS) { report.skipped.other++; return; }
      if (tag === 'text' || tag === 'tspan' || tag === 'textPath') { report.skipped.text++; return; }
      if (tag === 'image') { report.skipped.image++; return; }
      if (tag === 'foreignObject' || tag === 'script' || tag === 'iframe' || tag === 'video' || tag === 'audio' || tag === 'animate' || tag === 'set' || tag === 'animateTransform' || tag === 'animateMotion') { if (tag === 'foreignObject') report.skipped.other++; return; }
      if (NO_RENDER[tag] && !(viaUse && tag === 'symbol')) return;
      var st = styleOf(node, parent);
      if (st.hidden) return;
      var mm = matrixOf(node, st, m);
      if (!mm) { report.skipped.other++; return; }
      var kids, i;
      if (tag === 'svg' || tag === 'g' || tag === 'a' || tag === 'symbol') {
        if (tag === 'svg' && node !== root) {
          var ox = len(node.getAttribute('x'), refW, 0), oy = len(node.getAttribute('y'), refH, 0);
          mm = mul(mm, [1, 0, 0, 1, ox, oy]);
        }
        kids = node.children || [];
        for (i = 0; i < kids.length; i++) walk(kids[i], st, mm, depth + 1, useDepth, false);
        return;
      }
      if (tag === 'switch') {                            /* the first branch that is drawing, not foreignObject */
        kids = node.children || [];
        for (i = 0; i < kids.length; i++) if (kids[i].namespaceURI === SVGNS && kids[i].localName !== 'foreignObject') { walk(kids[i], st, mm, depth + 1, useDepth, false); break; }
        return;
      }
      if (tag === 'use') {
        var href = node.getAttribute('href') || node.getAttributeNS(XLINK, 'href') || '';
        var ref = /^#(.+)$/.exec(String(href).slice(0, 300));             /* only a fragment of this same file */
        var target = ref && Object.prototype.hasOwnProperty.call(ids, ref[1]) ? ids[ref[1]] : null;
        if (!target || useDepth >= MAX_USE_DEPTH || target === node || target.contains(node)) { report.skipped.other++; return; }
        mm = mul(mm, [1, 0, 0, 1, len(node.getAttribute('x'), refW, 0), len(node.getAttribute('y'), refH, 0)]);
        walk(target, st, mm, depth + 1, useDepth + 1, true);
        return;
      }
      if (SHAPES[tag]) { if (st.vis !== false) shape(node, tag, st, mm); return; }
      report.skipped.other++;
    }
    walk(root, { fill: { hex: '#000000' }, stroke: { none: true }, sw: 1, rule: 'nonzero', color: '#000000', hidden: false, vis: true }, base, 0, 0, false);
    /* the canvas (in the same px as the shapes) when the file says how big it is: background detection needs it */
    return { shapes: shapes, real: real, canvas: w != null && h != null ? { w: w, h: h } : null };
  }

  /* ---------- colours: perceptual distance, reduction to a few threads --------------------- */
  /* Colours are compared in CIELAB with CIEDE2000 (about 1 = the smallest difference people see,
     2-4 = two threads from the same shelf, 25+ = clearly another colour). */
  var NEAR_DE = 4;          /* closer than this: the same thread, always merged */
  var ACCENT_DE = 25;       /* further than this from everything else: a real accent, merged last */
  var AUTO_COLORS = 10, MIN_COLORS = 2, MAX_COLORS = 30;
  var labCache = {};
  function rgbOf(hex) { var n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function lum(hex) { var c = rgbOf(hex); return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255; }
  function labOf(hex) {
    if (labCache[hex]) return labCache[hex];
    var c = rgbOf(hex).map(function (v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    var x = (0.4124564 * c[0] + 0.3575761 * c[1] + 0.1804375 * c[2]) / 0.95047;
    var y = 0.2126729 * c[0] + 0.7151522 * c[1] + 0.0721750 * c[2];
    var z = (0.0193339 * c[0] + 0.1191920 * c[1] + 0.9503041 * c[2]) / 1.08883;
    function f(t) { return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116; }
    var fx = f(x), fy = f(y), fz = f(z);
    return (labCache[hex] = [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]);
  }
  function deltaE(p, q) {                                               /* CIEDE2000 */
    var PI = Math.PI, RAD = PI / 180, P7 = 6103515625;                   /* 25^7 */
    var L1 = p[0], a1 = p[1], b1 = p[2], L2 = q[0], a2 = q[1], b2 = q[2];
    var Cb = (Math.sqrt(a1 * a1 + b1 * b1) + Math.sqrt(a2 * a2 + b2 * b2)) / 2, Cb7 = Math.pow(Cb, 7);
    var g = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + P7))), a1p = (1 + g) * a1, a2p = (1 + g) * a2;
    var C1 = Math.sqrt(a1p * a1p + b1 * b1), C2 = Math.sqrt(a2p * a2p + b2 * b2);
    var h1 = a1p === 0 && b1 === 0 ? 0 : Math.atan2(b1, a1p), h2 = a2p === 0 && b2 === 0 ? 0 : Math.atan2(b2, a2p);
    if (h1 < 0) h1 += 2 * PI; if (h2 < 0) h2 += 2 * PI;
    var dL = L2 - L1, dC = C2 - C1, dh = 0, hb = h1 + h2;
    if (C1 * C2 !== 0) {
      dh = h2 - h1; if (dh > PI) dh -= 2 * PI; else if (dh < -PI) dh += 2 * PI;
      hb = (h1 + h2) / 2; if (Math.abs(h1 - h2) > PI) hb += hb < PI ? PI : -PI;
    }
    var dH = 2 * Math.sqrt(C1 * C2) * Math.sin(dh / 2), Lb = (L1 + L2) / 2, Cp = (C1 + C2) / 2, Cp7 = Math.pow(Cp, 7);
    var T = 1 - 0.17 * Math.cos(hb - 30 * RAD) + 0.24 * Math.cos(2 * hb) + 0.32 * Math.cos(3 * hb + 6 * RAD) - 0.20 * Math.cos(4 * hb - 63 * RAD);
    var dTh = 30 * RAD * Math.exp(-Math.pow((hb / RAD - 275) / 25, 2)), Rc = 2 * Math.sqrt(Cp7 / (Cp7 + P7));
    var l50 = (Lb - 50) * (Lb - 50), Sl = 1 + 0.015 * l50 / Math.sqrt(20 + l50), Sc = 1 + 0.045 * Cp, Sh = 1 + 0.015 * Cp * T;
    var tl = dL / Sl, tc = dC / Sc, th = dH / Sh;
    return Math.sqrt(Math.max(0, tl * tl + tc * tc + th * th - Math.sin(2 * dTh) * Rc * tc * th));
  }
  S.deltaE = function (h1, h2) { return deltaE(labOf(h1), labOf(h2)); };

  /* weights: { '#rrggbb': how much of it is sewn (any unit) } -> { hex: hex it becomes }.
     cap = Infinity merges only near-identical colours. Otherwise clusters merge, cheapest first, until at most
     cap are left. Cost = distance, a little cheaper when one side is small (a stray shade folds into its
     neighbour), but anything further than ACCENT_DE from the rest is only merged when nothing else is left:
     a small, clearly different accent (an eye, a highlight) keeps its own thread. Every cluster is sewn in
     one of the file's own colours: the member nearest the cluster's weighted mean. Deterministic. */
  function clusterColors(weights, cap) {
    var hexes = Object.keys(weights).sort(function (a, b) { return weights[b] - weights[a] || (a < b ? -1 : a > b ? 1 : 0); });
    var map = {}, near = !isFinite(cap), total = 0, i, j;
    hexes.forEach(function (h) { map[h] = h; total += Math.max(0, weights[h]); });
    if (hexes.length < 2 || (!near && hexes.length <= cap)) return map;
    if (!(total > 0)) total = 1;
    var cl = hexes.map(function (h) { return { members: [h], w: Math.max(weights[h], total * 1e-9), lab: labOf(h).slice() }; });
    function absorb(A, B) {
      var w = A.w + B.w;
      for (var k = 0; k < 3; k++) A.lab[k] = (A.lab[k] * A.w + B.lab[k] * B.w) / w;
      A.w = w; Array.prototype.push.apply(A.members, B.members);
    }
    /* thousands of colours (a traced photo): first pool colours in small Lab cells, so the pairwise pass stays fast */
    for (var cell = 1.5; cl.length > 240; cell *= 1.5) {
      var cells = {}, kept = [];
      cl.forEach(function (c) {
        var key = Math.round(c.lab[0] / cell) + ',' + Math.round(c.lab[1] / cell) + ',' + Math.round(c.lab[2] / cell);
        if (cells[key]) absorb(cells[key], c); else { cells[key] = c; kept.push(c); }
      });
      cl = kept;
    }
    var n = cl.length, D = [], alive = n, dead = [];
    for (i = 0; i < n; i++) { D.push(new Float64Array(n)); dead.push(false); }
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) D[i][j] = D[j][i] = deltaE(cl[i].lab, cl[j].lab);
    function cost(a, b) {
      var d = D[a][b];
      if (near) return d;
      var s = Math.min(cl[a].w, cl[b].w) / total, f = Math.pow(s / 0.05, 0.25);
      return d * (f < 0.35 ? 0.35 : f > 1 ? 1 : f) + (d > ACCENT_DE ? 1000 : 0);
    }
    while (alive > 1 && (near || alive > cap)) {
      var best = Infinity, bi = -1, bj = -1, c;
      for (i = 0; i < n; i++) if (!dead[i]) for (j = i + 1; j < n; j++) if (!dead[j] && (c = cost(i, j)) < best) { best = c; bi = i; bj = j; }
      if (bi < 0 || (near && best >= NEAR_DE)) break;
      absorb(cl[bi], cl[bj]); dead[bj] = true; alive--;
      for (j = 0; j < n; j++) if (!dead[j] && j !== bi) D[bi][j] = D[j][bi] = deltaE(cl[bi].lab, cl[j].lab);
    }
    for (i = 0; i < n; i++) {
      if (dead[i]) continue;
      var rep = cl[i].members[0], rd = Infinity;
      cl[i].members.forEach(function (h) { var d = deltaE(labOf(h), cl[i].lab); if (d < rd - 1e-9) { rd = d; rep = h; } });
      cl[i].members.forEach(function (h) { map[h] = rep; });
    }
    return map;
  }

  /* ---------- import hygiene: shapes -> clean editor objects on the hoop -------------------------- */
  /* What build() does, in order:
       1. colours: near-identical colours become one (NEAR_DE).
       2. background: a fill in the lightest colour with a ring covering (almost) the whole canvas, or the light
          layer of a two-colour trace, is the fabric, not thread. It is left out (opts.keepBackground keeps it).
          Its rings that show on top of a darker fill painted BELOW it (a "stacked" trace) become holes in that fill.
       3. colours: what is left is clustered down to at most opts.maxColors threads (default 10).
       4. the artwork (background excluded) is fitted to the hoop.
       5. hairlines: a stroke in the fill's own colour thinner than HAIR mm is a tracer's anti-gap trick, not an
          outline: dropped. Degenerate subpaths (no length, no area) are dropped, never turned into pen lines.
          Specks (islands under SPECK mm2) and pinholes (holes under SPECK / 2 mm2 and HOLE_EXT mm across) too.
       6. one object per colour: fills of the same colour (and the same edge) are merged into ONE compound path
          unless something of another colour painted between them overlaps them (paint order is kept). Rings are
          oriented by depth parity (outer one way, holes the other) so 'nonzero' gives their union. An object
          over M.MAX_POINTS points or MAX_RINGS rings is split by top-level island, each island with its holes.
       7. line art: a compound of 20+ rings whose mean width (2 x area / perimeter) is under 1.5 mm is a
          drawing made of lines: it gets style.fillStyle = 'lineart'. Logos with wide shapes stay on 'tatami'. */
  var HAIR = 0.3, SPECK = 0.3, HOLE_EXT = 0.8, BG_COVER = 0.95, BG_TRACE = 0.5, BG_LUM = 0.85;
  var LINEART_WIDTH = 1.5, LINEART_RINGS = 20, MAX_RINGS = 2000;

  function lineStyle(mm) {
    if (mm < 0.6) return { lineType: 'running' };
    if (mm < 1.2) return { lineType: 'bean' };
    return { lineType: 'satin', lineWidth: Math.round(G.clamp(mm, 1, 12) * 10) / 10 };
  }
  function ringOf(pts) {
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
    return pts;
  }
  function bboxOf(r) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (var i = 0; i < r.length; i++) { var p = r[i]; if (p[0] < b.x0) b.x0 = p[0]; if (p[0] > b.x1) b.x1 = p[0]; if (p[1] < b.y0) b.y0 = p[1]; if (p[1] > b.y1) b.y1 = p[1]; }
    return b;
  }
  function bboxOfRings(rings) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    rings.forEach(function (r) { var c = bboxOf(r); b.x0 = Math.min(b.x0, c.x0); b.y0 = Math.min(b.y0, c.y0); b.x1 = Math.max(b.x1, c.x1); b.y1 = Math.max(b.y1, c.y1); });
    return b;
  }
  function boxUnion(a, b) { return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }; }
  /* boxes that overlap by more than a hair (shapes that only touch along an edge do not cover each other) */
  function boxHit(a, b) { var e = 0.01; return a.x0 < b.x1 - e && b.x0 < a.x1 - e && a.y0 < b.y1 - e && b.y0 < a.y1 - e; }
  function inRing(x, y, r) {
    var c = false;
    for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
      var a = r[i], b = r[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  /* a point just inside ring r, next to the middle of its longest edge (sa: its signed area) */
  function probe(r, sa) {
    var best = 0, k = 0, i;
    for (i = 0; i < r.length; i++) { var q = r[(i + 1) % r.length], d = (q[0] - r[i][0]) * (q[0] - r[i][0]) + (q[1] - r[i][1]) * (q[1] - r[i][1]); if (d > best) { best = d; k = i; } }
    var p = r[k], q2 = r[(k + 1) % r.length], L = Math.sqrt(best) || 1, eps = Math.min(L * 0.25, 0.02);
    var nx = -(q2[1] - p[1]) / L, ny = (q2[0] - p[0]) / L, sgn = sa > 0 ? -1 : 1;
    var mx = (p[0] + q2[0]) / 2, my = (p[1] + q2[1]) / 2, x = mx + sgn * nx * eps, y = my + sgn * ny * eps;
    if (!inRing(x, y, r)) { x = mx - sgn * nx * eps; y = my - sgn * ny * eps; }
    return [x, y, 2 * mx - x, 2 * my - y];          /* [inside x, y, the mirror point just outside x, y] */
  }
  /* rings with bboxes, probes and depth (how many larger rings hold the probe: even = outer, odd = hole) */
  function indexRings(rings) {
    var R = rings.map(function (r) { var sa = G.area(r); return { pts: r, bb: bboxOf(r), sa: sa, area: Math.abs(sa) }; });
    R.forEach(function (a) { a.pr = probe(a.pts, a.sa); });
    R.forEach(function (a, i) {
      var d = 0, x = a.pr[0], y = a.pr[1];
      for (var j = 0; j < R.length; j++) {
        if (j === i) continue; var b = R[j].bb;
        if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1 || R[j].area < a.area) continue;
        if (inRing(x, y, R[j].pts)) d++;
      }
      a.depth = d;
    });
    return R;
  }
  function filledAt(R, x, y) {
    var c = 0;
    for (var j = 0; j < R.length; j++) { var b = R[j].bb; if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue; if (inRing(x, y, R[j].pts)) c++; }
    return (c & 1) === 1;
  }
  /* how a fill as drawn covers x, y: its own rule over its own rings, minus the light rings stacked on it */
  function drawnAt(R, rule, x, y) {
    var w = 0, c = 0, h = 0;
    for (var j = 0; j < R.length; j++) {
      var b = R[j].bb, r = R[j].pts;
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
      if (R[j].stacked) { if (inRing(x, y, r)) h++; continue; }
      for (var i = 0, k = r.length - 1; i < r.length; k = i++) {
        var p = r[k], q = r[i];
        if ((p[1] > y) !== (q[1] > y) && x < (q[0] - p[0]) * (y - p[1]) / (q[1] - p[1]) + p[0]) { c++; w += q[1] > p[1] ? 1 : -1; }
      }
    }
    var own = rule === 'evenodd' ? (c & 1) === 1 : w !== 0;
    return own && (h & 1) === 0;
  }
  /* true when re-orienting the rings by depth parity (outer one way, holes the other, 'nonzero') sews the
     same area as drawn. Not so for subpaths that cross or overlap each other in one path (an icon drawn as
     two overlapping bars), or nested rings wound the same way under 'nonzero': those are left as drawn. */
  function nestsCleanly(R, rule) {
    for (var i = 0; i < R.length; i++) {
      var p = R[i].pr;
      if (filledAt(R, p[0], p[1]) !== drawnAt(R, rule, p[0], p[1]) || filledAt(R, p[2], p[3]) !== drawnAt(R, rule, p[2], p[3])) return false;
    }
    return true;
  }
  /* light ring L (indexed) and the fill below it (indexed rings): does L overlap it at all, and does it lie
     wholly inside it with none of its edges inside L (so L can be cut out of it as a plain hole)? */
  function overlapOf(L, R) {
    var hit = false, i, j;
    for (j = 0; j < R.length && !hit; j++) if (boxHit(L.bb, R[j].bb)) hit = true;
    if (!hit) return 0;
    var pts = L.pts, inside = 0;
    for (i = 0; i < pts.length; i++) if (filledAt(R, pts[i][0], pts[i][1])) inside++;
    var crossed = false;
    for (j = 0; j < R.length && !crossed; j++) {
      if (!boxHit(L.bb, R[j].bb)) continue;
      for (i = 0; i < R[j].pts.length; i++) { var v = R[j].pts[i]; if (inRing(v[0], v[1], pts)) { crossed = true; break; } }
    }
    if (!inside && !crossed && !filledAt(R, L.pr[0], L.pr[1])) return 0;          /* apart */
    return !crossed && filledAt(R, L.pr[0], L.pr[1]) && inside >= pts.length * 0.9 ? 2 : 1;   /* 2: inside, 1: partly */
  }
  function pointsIn(rings) { var n = 0; for (var i = 0; i < rings.length; i++) n += rings[i].length; return n; }
  function maxColorsOf(opts) {
    var n = opts && opts.maxColors != null ? Math.round(Number(opts.maxColors)) : AUTO_COLORS;
    return isFinite(n) ? G.clamp(n, MIN_COLORS, MAX_COLORS) : AUTO_COLORS;
  }

  function build(found, hoop, report, step, opts) {
    opts = opts || {};
    var i, j, k;
    /* a private copy: build runs again with a coarser step when the artwork is too detailed */
    var shapes = found.shapes.map(function (sh) { return { tag: sh.tag, subs: sh.subs, fill: sh.fill, stroke: sh.stroke, sw: sh.sw, rule: sh.rule, fill0: sh.fill, stroke0: sh.stroke }; });
    var H = report.hygiene = { background: 0, backgroundColor: null, stackedHoles: 0, hairlines: 0, degenerate: 0, specks: 0, pinholes: 0, merged: 0, lineart: 0 };
    report.colors = { before: 0, after: 0, max: maxColorsOf(opts) };
    if (!shapes.length) return [];

    /* coarse outlines in a normalised space (the canvas, or the artwork, is about 1000 units across) for the
       decisions that do not need precision: background, stacked holes, how much of each colour there is */
    var raw = null;
    shapes.forEach(function (sh) { sh.subs.forEach(function (s) { flatten(s, 1, 0, 0, 1e9).forEach(function (p) { raw = raw ? boxUnion(raw, { x0: p[0], y0: p[1], x1: p[0], y1: p[1] }) : { x0: p[0], y0: p[1], x1: p[0], y1: p[1] }; }); }); });
    var cv = found.canvas ? { x0: 0, y0: 0, x1: found.canvas.w, y1: found.canvas.h } : raw;
    if (!cv) return [];
    var k0 = 1000 / Math.max(cv.x1 - cv.x0, cv.y1 - cv.y0, 1e-9), cw = (cv.x1 - cv.x0) * k0, ch = (cv.y1 - cv.y0) * k0;
    var coarse = shapes.map(function (sh) {
      return sh.subs.map(function (s) { return flatten(s, k0, -cv.x0 * k0, -cv.y0 * k0, 4); });
    });
    var coarseRings = coarse.map(function (subs) { return subs.map(ringOf).filter(function (r) { return r.length >= 3; }); });
    function weighOut(into, useFill, useStroke) {
      shapes.forEach(function (sh, n) {
        if (!sh) return;
        if (useFill && sh.fill) { var a = 0; coarseRings[n].forEach(function (r) { a += G.area(r); }); into[sh.fill] = (into[sh.fill] || 0) + Math.abs(a); }
        if (useStroke && sh.stroke) { var l = 0; coarse[n].forEach(function (p) { l += G.pathLength(p, false); }); into[sh.stroke] = (into[sh.stroke] || 0) + l * Math.max(sh.sw * k0, 0.5); }
      });
      return into;
    }
    function recolor(map) { shapes.forEach(function (sh) { if (!sh) return; if (sh.fill) sh.fill = map[sh.fill] || sh.fill; if (sh.stroke) sh.stroke = map[sh.stroke] || sh.stroke; }); }

    /* 1. near-identical colours are one thread */
    recolor(clusterColors(weighOut({}, true, true), Infinity));

    /* 2. background */
    var fillCols = {};
    shapes.forEach(function (sh) { if (sh.fill) fillCols[sh.fill] = 1; });
    var cols = Object.keys(fillCols).sort(function (a, b) { return lum(b) - lum(a) || (a < b ? -1 : 1); }), lightest = cols[0];
    var bgIdx = -1, bgRing = -1;
    if (!opts.keepBackground && cols.length >= 2) {
      for (i = 0; i < shapes.length && bgIdx < 0; i++) {
        if (shapes[i].fill !== lightest) continue;
        for (j = 0; j < coarseRings[i].length; j++) {
          var b = bboxOf(coarseRings[i][j]);
          if (Math.max(0, Math.min(b.x1, cw) - Math.max(b.x0, 0)) * Math.max(0, Math.min(b.y1, ch) - Math.max(b.y0, 0)) >= BG_COVER * cw * ch) { bgIdx = i; bgRing = j; break; }
        }
      }
      if (bgIdx < 0 && cols.length === 2 && lum(lightest) > BG_LUM) {     /* a two-colour trace without a canvas ring */
        var lightArea = 0;
        shapes.forEach(function (sh, n) { if (sh.fill === lightest) coarseRings[n].forEach(function (r) { lightArea += G.area(r); }); });
        if (Math.abs(lightArea) >= BG_TRACE * cw * ch) for (i = 0; i < shapes.length; i++) if (shapes[i].fill === lightest) { bgIdx = i; break; }
      }
    }
    var holeSubs = {};
    if (bgIdx >= 0) {
      H.background = 1; H.backgroundColor = lightest;
      /* every fill in the background colour: the canvas layer, and island layers painted above darker fills */
      for (var li = 0; li < shapes.length; li++) {
        var sh0 = shapes[li];
        if (!sh0 || sh0.fill !== lightest) continue;
        var below = [];
        for (i = 0; i < li; i++) if (shapes[i] && shapes[i].fill && shapes[i].fill !== lightest) below.push({ i: i, R: indexRings(coarseRings[i]) });
        var keep = [];
        if (below.length) {
          var bgR = indexRings(coarseRings[li]), subOf = [], holeOf = {};
          coarse[li].forEach(function (p, n) { if (ringOf(p).length >= 3) subOf.push(sh0.subs[n]); });
          bgR.forEach(function (r, n) {
            if ((li === bgIdx && n === bgRing) || !filledAt(bgR, r.pr[0], r.pr[1])) return;
            /* the topmost darker fill it overlaps: wholly inside it, it is a hole in it (fabric shows);
               only partly over it, it stays a light fill sewn on top, as drawn. Over bare fabric: fabric. */
            for (var q = below.length - 1; q >= 0; q--) {
              var ov = overlapOf(r, below[q].R);
              if (ov === 2) { (holeSubs[below[q].i] = holeSubs[below[q].i] || []).push(subOf[n]); holeOf[n] = below[q].i; H.stackedHoles++; return; }
              if (ov === 1) { keep.push(n); return; }
            }
          });
          /* the holes of a light ring that was cut out show the fill below again: they go with it */
          bgR.forEach(function (r, n) {
            if (holeOf[n] != null || filledAt(bgR, r.pr[0], r.pr[1])) return;
            var par = -1;
            bgR.forEach(function (p, m) { if (m !== n && p.depth === r.depth - 1 && p.area > r.area && inRing(r.pr[0], r.pr[1], p.pts) && (par < 0 || p.area < bgR[par].area)) par = m; });
            if (par >= 0 && holeOf[par] != null) holeSubs[holeOf[par]].push(subOf[n]);
          });
        }
        if (keep.length) {                                               /* light thread on top of other colours */
          sh0.subs = keep.map(function (n) { return subOf[n]; });
          coarseRings[li] = keep.map(function (n) { return coarseRings[li][n]; });
          continue;
        }
        if (sh0.stroke && sh0.stroke !== sh0.fill) { sh0.fill = null; sh0.fill0 = null; }
        else shapes[li] = null;
        if (li !== bgIdx) H.background++;
      }
    }

    /* 3. at most maxColors threads for what is left */
    var before = {};
    shapes.forEach(function (sh) { if (!sh) return; if (sh.fill0) before[sh.fill0] = 1; if (sh.stroke0) before[sh.stroke0] = 1; });
    report.colors.before = Object.keys(before).length;
    recolor(clusterColors(weighOut({}, true, true), report.colors.max));

    /* 4. bounds of what is left, then the fit */
    var bb = null;
    shapes.forEach(function (sh) {
      if (!sh) return;
      var pad = sh.stroke && sh.stroke !== sh.fill ? sh.sw / 2 : 0;
      sh.subs.concat(holeSubs[shapes.indexOf(sh)] || []).forEach(function (s) {
        var pts = flatten(s, 1, 0, 0, 1e9);
        if (pts.length < 8) pts = flatten(s, 64, 0, 0, 8).map(function (p) { return [p[0] / 64, p[1] / 64]; });
        pts.forEach(function (p) {
          if (!bb) bb = { x0: p[0] - pad, y0: p[1] - pad, x1: p[0] + pad, y1: p[1] + pad };
          else { bb.x0 = Math.min(bb.x0, p[0] - pad); bb.y0 = Math.min(bb.y0, p[1] - pad); bb.x1 = Math.max(bb.x1, p[0] + pad); bb.y1 = Math.max(bb.y1, p[1] + pad); }
        });
      });
    });
    if (!bb) return [];
    var bw = bb.x1 - bb.x0, bh = bb.y1 - bb.y0, scale;
    if (!(bw > 1e-9) && !(bh > 1e-9)) return [];
    if (found.real && bw * PX_MM <= hoop.w * 0.98 && bh * PX_MM <= hoop.h * 0.98) scale = PX_MM;   /* a real size that fits is kept */
    else { scale = Math.min(bw > 1e-9 ? hoop.w * FIT / bw : Infinity, bh > 1e-9 ? hoop.h * FIT / bh : Infinity); report.fitted = true; }
    if (!isFinite(scale) || scale <= 0) return [];
    var tx = hoop.w / 2 - (bb.x0 + bb.x1) / 2 * scale, ty = hoop.h / 2 - (bb.y0 + bb.y1) / 2 * scale;
    report.width = bw * scale; report.height = bh * scale;

    /* 5. per shape: clean rings and lines */
    var items = [];                     /* { kind: 'fill' | 'line', color, rings | geom, rule, line, bb, n, name } */
    shapes.forEach(function (sh, si) {
      if (!sh) return;
      var subs = sh.subs.concat(holeSubs[si] || []), made = false;
      var flat = subs.map(function (s) { return { pts: flatten(s, scale, tx, ty, step), closed: s.closed }; });
      var swmm = sh.sw * scale, stroke = sh.stroke, name = NAMES[sh.tag] || 'Shape';
      if (stroke && sh.fill && stroke === sh.fill && swmm < HAIR) { stroke = null; H.hairlines++; }
      if (sh.fill) {
        var rings = [], stacked = [];
        flat.forEach(function (f, n) {
          var r = ringOf(f.pts);
          if (r.length < 3 || Math.abs(G.area(r)) < 0.05) { H.degenerate++; return; }
          rings.push(r); stacked.push(n >= sh.subs.length);              /* a light ring cut out of it */
        });
        /* islands under SPECK mm2 cannot hold a stitch; a hole that small AND short closes up under the
           thread (a long thin white gap between hatching lines is kept, or the lines would merge) */
        var clean = true;
        if (rings.length > 1 || (rings.length === 1 && Math.abs(G.area(rings[0])) < SPECK)) {
          var IR = indexRings(rings);
          IR.forEach(function (r, n) { r.stacked = stacked[n]; });
          clean = nestsCleanly(IR, sh.rule);
          rings = IR.filter(function (r) {
            var hole = (r.depth & 1) === 1, ext = Math.max(r.bb.x1 - r.bb.x0, r.bb.y1 - r.bb.y0);
            if (!hole && r.area < SPECK) { H.specks++; return false; }
            if (hole && r.area < SPECK / 2 && ext < HOLE_EXT) { H.pinholes++; return false; }
            return true;
          }).map(function (r) { return r.pts; });
        }
        if (rings.length) { items.push({ kind: 'fill', color: sh.fill, rings: rings, rule: sh.rule, orient: !!holeSubs[si], clean: clean, name: name, line: stroke && stroke === sh.fill ? lineStyle(swmm) : null, bb: bboxOfRings(rings) }); made = true; }
        if (stroke === sh.fill) stroke = null;                            /* same thread: sewn as 'both' */
      }
      if (stroke) {
        var ls = lineStyle(swmm), closedRings = [];
        flat.slice(0, sh.subs.length).forEach(function (f) {             /* its own outline, not the light rings cut out */
          var r = ringOf(f.pts);
          if (f.closed) {
            if (r.length >= 3 && G.pathLength(r, true) >= 0.3) closedRings.push(r); else H.degenerate++;
            return;
          }
          if (r.length < 2 || G.pathLength(r, false) < 0.3) { H.degenerate++; return; }
          if (r.length > M.MAX_POINTS) { report.skipped.full++; return; }
          items.push({ kind: 'line', color: stroke, ls: ls, name: name, geom: r.length === 2 ? { type: 'line', x1: r[0][0], y1: r[0][1], x2: r[1][0], y2: r[1][1] } : { type: 'pen', pts: r, closed: false }, n: r.length, bb: bboxOf(r) });
          made = true;
        });
        if (closedRings.length) {
          var cn = pointsIn(closedRings);
          if (cn <= M.MAX_POINTS && closedRings.length <= MAX_RINGS) {
            items.push({ kind: 'line', color: stroke, ls: ls, name: name, geom: closedRings.length === 1 ? { type: 'polygon', pts: closedRings[0] } : { type: 'path', rings: closedRings, fillRule: sh.rule === 'evenodd' ? 'evenodd' : 'nonzero' }, n: cn, bb: bboxOfRings(closedRings) });
            made = true;
          } else report.skipped.full++;
        }
      }
      if (!made && (sh.fill || sh.stroke)) report.skipped.tiny++;
    });

    /* 6. one compound per colour, where paint order allows it: walk back through what is already placed;
       a group of the same colour takes the item, a group of ANOTHER colour that overlaps it stops the walk */
    var groups = [];
    items.forEach(function (it) {
      if (it.kind === 'fill') {
        for (var g = groups.length - 1; g >= 0; g--) {
          var gr = groups[g];
          if (!gr.line && gr.color === it.color && it.clean && gr.items[0].clean && !!gr.items[0].line === !!it.line && (!it.line || gr.items[0].line.lineType === it.line.lineType)) {
            gr.items.push(it); gr.bb = boxUnion(gr.bb, it.bb); H.merged++; return;
          }
          if (gr.color !== it.color && boxHit(gr.bb, it.bb) && gr.items.some(function (x) { return boxHit(x.bb, it.bb); })) break;
        }
      }
      groups.push({ items: [it], color: it.color, line: it.kind === 'line', bb: it.bb });
    });

    var list = [], total = 0;
    function push(geom, style, n) { list.push({ geom: geom, style: style }); total += n; }
    groups.forEach(function (g) {
      var it = g.items[0], style, kk;
      if (g.line) {
        style = { color: it.color, paint: 'line', name: it.name }; for (kk in it.ls) style[kk] = it.ls[kk];
        push(it.geom, style, it.n); report.lines++; return;
      }
      var rings, rule;
      if (g.items.length === 1 && !it.orient) { rings = it.rings; rule = it.rule; }
      else {                                                             /* outer rings one way, holes the other: nonzero = union */
        rings = []; rule = 'nonzero';
        g.items.forEach(function (x) {
          indexRings(x.rings).forEach(function (r) {
            var outer = (r.depth & 1) === 0;
            rings.push((r.sa > 0) !== outer ? r.pts.slice().reverse() : r.pts);
          });
        });
      }
      /* an object holds at most M.MAX_POINTS points (and MAX_RINGS rings): split by top-level island, each with its holes */
      var chunks = [rings];
      if (pointsIn(rings) > M.MAX_POINTS || rings.length > MAX_RINGS) {
        var R = indexRings(rings), tops = R.filter(function (r) { return r.depth === 0; }), fam = tops.map(function (t) { return [t.pts]; });
        R.forEach(function (r) {
          if (r.depth === 0) return;
          for (var t = tops.length - 1; t >= 0; t--) {
            var b2 = tops[t].bb;
            if (r.pr[0] >= b2.x0 && r.pr[0] <= b2.x1 && r.pr[1] >= b2.y0 && r.pr[1] <= b2.y1 && inRing(r.pr[0], r.pr[1], tops[t].pts)) { fam[t].push(r.pts); return; }
          }
          fam.push([r.pts]);
        });
        chunks = [[]]; var cnt = 0;
        fam.forEach(function (f) {
          var m = pointsIn(f), last = chunks[chunks.length - 1];
          if (m > M.MAX_POINTS || f.length > MAX_RINGS) { report.skipped.full++; return; }
          if (last.length && (cnt + m > M.MAX_POINTS || last.length + f.length > MAX_RINGS)) { chunks.push(last = []); cnt = 0; }
          Array.prototype.push.apply(last, f); cnt += m;
        });
        chunks = chunks.filter(function (c) { return c.length; });
      }
      chunks.forEach(function (c) {
        var n = pointsIn(c), geom = c.length === 1 && rule !== 'evenodd' ? { type: 'polygon', pts: c[0] } : { type: 'path', rings: c, fillRule: rule === 'evenodd' ? 'evenodd' : 'nonzero' };
        style = { color: it.color, paint: it.line ? 'both' : 'fill', name: g.items.length > 1 ? 'Path' : it.name };
        if (it.line) for (kk in it.line) style[kk] = it.line[kk];
        /* 7. line art: many rings, thin on average */
        if (c.length >= LINEART_RINGS) {
          var area = 0, per = 0;
          indexRings(c).forEach(function (r) { area += (r.depth & 1) ? -r.area : r.area; per += G.pathLength(r.pts, true); });
          if (per > 0 && 2 * Math.abs(area) / per < LINEART_WIDTH) { style.fillStyle = 'lineart'; style.name = 'Line art'; H.lineart++; }
        }
        push(geom, style, n); report.fills++;
      });
    });
    var after = {};
    list.forEach(function (o) { after[o.style.color] = 1; });
    report.colors.after = Object.keys(after).length;
    list.total = total;
    return list;
  }

  /* ---------- public ---------------------------------------------------------------------- */
  /* Text of an SVG file -> { ok, error, list: [{ geom, style }], report }. Changes nothing.
     opts.keepBackground: true keeps a detected background as an object.
     opts.maxColors: 2..30 threads at most (default 10). */
  S.parse = function (text, hoop, opts) {
    var report = emptyReport();
    hoop = hoop || M.doc.hoop;
    opts = opts || {};
    if (typeof text !== 'string' || !text) return { ok: false, error: 'The file is empty.', list: [], report: report };
    if (text.length > MAX_BYTES) return { ok: false, error: 'This SVG is larger than 5 MB. Simplify it in your drawing program and try again.', list: [], report: report };
    /* entities that are built from other entities are how an XML "bomb" grows: refuse them unparsed */
    var ent = /<!ENTITY\s+[^>]*>/gi, e, ents = 0;
    while ((e = ent.exec(text))) { if (++ents > 64 || /[&%][#\w]/.test(e[0].replace(/^<!ENTITY\s+%?\s*/i, ''))) return { ok: false, error: 'This SVG uses nested entity definitions and was not opened.', list: [], report: report }; }
    var doc, root;
    try { doc = new DOMParser().parseFromString(text, 'image/svg+xml'); } catch (err) { doc = null; }
    root = doc && doc.documentElement;
    if (!root || root.localName !== 'svg' || root.namespaceURI !== SVGNS || doc.getElementsByTagName('parsererror').length) {
      return { ok: false, error: 'This file is not a readable SVG.', list: [], report: report };
    }
    var found, list, step = STEP, tries = 0;
    try {
      found = collect(root, report);
      for (;;) {
        var r2 = emptyReport(); r2.skipped = report.skipped;
        report.skipped.tiny = 0; report.skipped.full = 0;      /* counted afresh by each build */
        list = build(found, hoop, r2, step, opts);
        if (list.total <= MAX_TOTAL_POINTS || ++tries > 3) {
          ['fills', 'lines', 'width', 'height', 'fitted', 'hygiene', 'colors'].forEach(function (k) { report[k] = r2[k]; });
          break;
        }
        step *= 2;                                         /* very detailed artwork: coarser curves */
      }
    } catch (err2) {
      return { ok: false, error: 'This SVG could not be read.', list: [], report: report };
    }
    if (list.total > MAX_TOTAL_POINTS) return { ok: false, error: 'This SVG is too detailed to import. Simplify the paths in your drawing program first.', list: [], report: report };
    return { ok: true, list: list, report: report };
  };

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function skippedText(sk) {
    var out = [];
    if (sk.text) out.push(plural(sk.text, 'text', 'texts'));
    if (sk.image) out.push(plural(sk.image, 'image', 'images'));
    if (sk.gradient) out.push(plural(sk.gradient, 'gradient or pattern paint', 'gradient or pattern paints'));
    if (sk.tiny) out.push(plural(sk.tiny, 'shape too small to sew', 'shapes too small to sew'));
    if (sk.full) out.push(plural(sk.full, 'shape over the limit', 'shapes over the limit'));
    if (sk.other) out.push(plural(sk.other, 'other element', 'other elements'));
    return out.join(', ');
  }
  S.describe = function (report) {
    var sk = skippedText(report.skipped), msg;
    if (!report.added) return 'Nothing in this SVG could be imported.' + (sk ? ' Left out: ' + sk + '.' : '') + (report.skipped.text ? ' Turn text into outlines in your drawing program first.' : '');
    msg = 'Imported ' + plural(report.added, 'shape', 'shapes') + ' (' + plural(report.fills, 'fill', 'fills') + ', ' + plural(report.lines, 'line', 'lines') + '), '
      + Editor.Units.size(report.width, report.height) + ' ' + Editor.Units.label() + (report.fitted ? ', fitted to the hoop' : ', at its real size') + '.';
    if (report.hygiene && report.hygiene.background) msg += ' Background left out.';
    if (report.colors && report.colors.after < report.colors.before) msg += ' ' + report.colors.before + ' colours merged into ' + plural(report.colors.after, 'thread', 'threads') + '.';
    if (sk) msg += ' Left out: ' + sk + '.';
    if (report.skipped.text) msg += ' Turn text into outlines first.';
    return msg;
  };

  /* Add the shapes of an SVG to the design: one undo step. Always tells the visitor what happened. */
  S.importText = function (text, opts) {
    var toast = Editor.toast || function () {};
    opts = opts || {};
    var res = S.parse(text, M.doc.hoop, opts), report = res.report;
    if (!res.ok) { toast(res.error, { kind: 'bad', label: 'Import SVG', timeout: 8000 }); report.error = res.error; return report; }
    var list = res.list, room = M.MAX_OBJECTS - M.doc.objects.length;
    var cut = 0;
    if (list.length > room) { cut = list.length - Math.max(0, room); report.skipped.full += cut; list = list.slice(0, Math.max(0, room)); }
    var made = list.length ? M.addMany(list, 'Import SVG') : [];
    report.added = made.length;
    if (!made.length) {
      report.fills = 0; report.lines = 0;
      toast(S.describe(report), { kind: 'bad', label: 'Import SVG', timeout: 9000 });
      return report;
    }
    if (cut) {                                             /* count what really went in */
      report.fills = made.filter(function (o) { return M.paintOf(o) !== 'line'; }).length;
      report.lines = made.filter(function (o) { return M.paintOf(o) !== 'fill'; }).length;
    }
    if (Editor.Tools && Editor.Tools.current !== 'select') Editor.Tools.set('select');
    if (Editor.View && Editor.View.mode !== 'design') Editor.View.setMode('design');
    var msg = S.describe(report);
    var action = { label: 'Undo', onClick: function () { if (M.undoLabel() === 'Import SVG') M.undo(); } };
    if (report.hygiene && report.hygiene.background) {
      /* the background was taken for fabric: one click brings it back (Undo stays in the History menu) */
      action = { label: 'Keep background', onClick: function () {
        if (M.undoLabel() !== 'Import SVG') { toast('The design changed since the import. Undo back to it first, or import the file again.', { label: 'Import SVG', timeout: 6000 }); return; }
        M.undo();
        S.importText(text, { keepBackground: true, maxColors: opts.maxColors });
      } };
    }
    window.EL.toast(msg, { kind: 'ok', label: 'Import SVG', timeout: 10000, action: action });
    if (Editor.say) Editor.say(msg);
    return report;
  };

  S.looksLikeSvg = function (file) {
    return !!file && (file.type === 'image/svg+xml' || /\.svgz?$/i.test(file.name || ''));
  };
  S.importFile = function (file) {
    var toast = Editor.toast || function () {};
    if (!file) return Promise.resolve(null);
    if (/\.svgz$/i.test(file.name || '')) { toast('Compressed SVG (.svgz) is not supported. Save it as a plain .svg.', { kind: 'bad', label: 'Import SVG' }); return Promise.resolve(null); }
    if (file.size > MAX_BYTES) { toast('This SVG is larger than 5 MB. Simplify it in your drawing program and try again.', { kind: 'bad', label: 'Import SVG', timeout: 8000 }); return Promise.resolve(null); }
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = function () { resolve(S.importText(String(fr.result || ''))); };
      fr.onerror = function () { toast('The file could not be read.', { kind: 'bad', label: 'Import SVG' }); resolve(null); };
      fr.readAsText(file);
    });
  };
})();
