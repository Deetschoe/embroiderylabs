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

   Public:
     Editor.SvgImport.parse(text)            -> { ok, error?, list, report }   (no side effects)
     Editor.SvgImport.importText(text)       -> report (adds the shapes, shows a toast)
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
    return { added: 0, fills: 0, lines: 0, width: 0, height: 0, fitted: false, skipped: { text: 0, image: 0, gradient: 0, other: 0, tiny: 0, full: 0 } };
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
    return { shapes: shapes, real: real };
  }

  /* ---------- shapes -> editor objects on the hoop -------------------------------------- */
  function lineStyle(mm) {
    if (mm < 0.6) return { lineType: 'running' };
    if (mm < 1.2) return { lineType: 'bean' };
    return { lineType: 'satin', lineWidth: Math.round(G.clamp(mm, 1, 12) * 10) / 10 };
  }
  function ringOf(pts) {
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
    return pts;
  }
  function build(found, hoop, report, step) {
    var shapes = found.shapes, bb = null, i, j, k;
    /* bounds of the artwork in the file's px (curves sampled, half the stroke width added) */
    shapes.forEach(function (sh) {
      var pad = sh.stroke ? sh.sw / 2 : 0;
      sh.subs.forEach(function (s) {
        var pts = flatten(s, 1, 0, 0, 1e9);
        if (pts.length < 8) pts = flatten(s, 64, 0, 0, 8).map(function (p) { return [p[0] / 64, p[1] / 64]; });
        pts.forEach(function (p) {
          if (!bb) bb = { x0: p[0] - pad, y0: p[1] - pad, x1: p[0] + pad, y1: p[1] + pad };
          else { bb.x0 = Math.min(bb.x0, p[0] - pad); bb.y0 = Math.min(bb.y0, p[1] - pad); bb.x1 = Math.max(bb.x1, p[0] + pad); bb.y1 = Math.max(bb.y1, p[1] + pad); }
        });
      });
    });
    if (!bb) return [];
    var bw = bb.x1 - bb.x0, bh = bb.y1 - bb.y0;
    if (!(bw > 1e-9) && !(bh > 1e-9)) return [];
    var scale;
    if (found.real && bw * PX_MM <= hoop.w * 0.98 && bh * PX_MM <= hoop.h * 0.98) scale = PX_MM;   /* a real size that fits is kept */
    else { scale = Math.min(bw > 1e-9 ? hoop.w * FIT / bw : Infinity, bh > 1e-9 ? hoop.h * FIT / bh : Infinity); report.fitted = true; }
    if (!isFinite(scale) || scale <= 0) return [];
    var tx = hoop.w / 2 - (bb.x0 + bb.x1) / 2 * scale, ty = hoop.h / 2 - (bb.y0 + bb.y1) / 2 * scale;
    report.width = bw * scale; report.height = bh * scale;

    var list = [], total = 0;
    function push(geom, style, n) { list.push({ geom: geom, style: style }); total += n; }
    for (i = 0; i < shapes.length; i++) {
      var sh = shapes[i], flat = sh.subs.map(function (s) { return { pts: flatten(s, scale, tx, ty, step), closed: s.closed }; });
      var name = NAMES[sh.tag] || 'Shape', made = false, over = false, n = 0;
      var swmm = sh.sw * scale, ls = sh.stroke ? lineStyle(swmm) : null;
      var allClosed = flat.every(function (f) { return f.closed; });
      /* fill: every subpath is a ring (an open one is closed, as SVG does) */
      var fillObj = null;
      if (sh.fill) {
        var rings = [];
        flat.forEach(function (f) { var r = ringOf(f.pts); if (r.length >= 3 && Math.abs(G.area(r)) >= 0.05) rings.push(r); });
        n = 0; rings.forEach(function (r) { n += r.length; });
        if (rings.length && rings.length <= 2000 && n <= M.MAX_POINTS) {
          var geom = rings.length === 1 && sh.rule !== 'evenodd' ? { type: 'polygon', pts: rings[0] } : { type: 'path', rings: rings, fillRule: sh.rule };
          fillObj = { geom: geom, style: { color: sh.fill, paint: 'fill', name: name }, n: n, rings: rings.length };
        } else if (rings.length) over = true;                /* more points than one shape may have */
      }
      if (fillObj && sh.stroke && sh.stroke === sh.fill && allClosed && fillObj.rings === flat.length) {
        /* same thread for the inside and the edge: one object sewn as fill + line */
        fillObj.style.paint = 'both'; for (k in ls) fillObj.style[k] = ls[k];
        push(fillObj.geom, fillObj.style, fillObj.n); report.fills++; report.lines++; continue;
      }
      if (fillObj) { push(fillObj.geom, fillObj.style, fillObj.n); report.fills++; made = true; }
      if (sh.stroke) {
        var closedRings = [], st;
        flat.forEach(function (f) {
          var r;
          if (f.closed) { r = ringOf(f.pts); if (r.length >= 3) { closedRings.push(r); return; } }
          r = f.pts;
          if (r.length < 2 || G.pathLength(r, false) < 0.3) return;
          st = { color: sh.stroke, paint: 'line', name: name }; for (k in ls) st[k] = ls[k];
          if (r.length === 2) push({ type: 'line', x1: r[0][0], y1: r[0][1], x2: r[1][0], y2: r[1][1] }, st, 2);
          else if (r.length <= M.MAX_POINTS) push({ type: 'pen', pts: r, closed: false }, st, r.length);
          else { over = true; return; }
          report.lines++; made = true;
        });
        closedRings = closedRings.filter(function (r) { return G.pathLength(r, true) >= 0.3; });
        n = 0; closedRings.forEach(function (r) { n += r.length; });
        if (closedRings.length && n <= M.MAX_POINTS) {
          st = { color: sh.stroke, paint: 'line', name: name }; for (k in ls) st[k] = ls[k];
          push(closedRings.length === 1 ? { type: 'polygon', pts: closedRings[0] } : { type: 'path', rings: closedRings, fillRule: sh.rule }, st, n);
          report.lines++; made = true;
        } else if (closedRings.length) over = true;
      }
      if (!made) report.skipped[over ? 'full' : 'tiny']++;
    }
    list.total = total;
    for (j = 0; j < list.length; j++) if (list[j].geom.type === 'path') list[j].geom.fillRule = list[j].geom.fillRule === 'evenodd' ? 'evenodd' : 'nonzero';
    return list;
  }

  /* ---------- public ---------------------------------------------------------------------- */
  /* Text of an SVG file -> { ok, error, list: [{ geom, style }], report }. Changes nothing. */
  S.parse = function (text, hoop) {
    var report = emptyReport();
    hoop = hoop || M.doc.hoop;
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
        list = build(found, hoop, r2, step);
        if (list.total <= MAX_TOTAL_POINTS || ++tries > 3) { report.fills = r2.fills; report.lines = r2.lines; report.width = r2.width; report.height = r2.height; report.fitted = r2.fitted; break; }
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
    if (sk) msg += ' Left out: ' + sk + '.';
    if (report.skipped.text) msg += ' Turn text into outlines first.';
    return msg;
  };

  /* Add the shapes of an SVG to the design: one undo step. Always tells the visitor what happened. */
  S.importText = function (text) {
    var toast = Editor.toast || function () {};
    var res = S.parse(text, M.doc.hoop), report = res.report;
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
    window.EL.toast(msg, { kind: 'ok', label: 'Import SVG', timeout: 10000, action: { label: 'Undo', onClick: function () { if (M.undoLabel() === 'Import SVG') M.undo(); } } });
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
