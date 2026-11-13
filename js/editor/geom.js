/* ==========================================================================
   EMBROIDERY LABS - js/editor/geom.js
   Pure geometry and colour helpers for the editor. No DOM, no state.
   Everything is in millimetres, origin at the top-left corner of the hoop,
   y pointing down. Creates window.Editor and Editor.Geom.
   ========================================================================== */
(function () {
  'use strict';
  var Editor = window.Editor = window.Editor || {};
  var G = Editor.Geom = {};

  /* Coordinates are stored to 1/100 mm: far finer than a needle, short in JSON. */
  G.r2 = function (v) { return Math.round(v * 100) / 100; };
  G.clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };
  G.dist = function (ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy); };

  /* ---------- object geometry ---------------------------------------------
     rect    { x, y, w, h }          w, h > 0
     ellipse { cx, cy, rx, ry }      rx, ry > 0
     line    { x1, y1, x2, y2 }
     polygon { pts: [[x, y], ...] }  always closed
     pen     { pts, closed }         freehand stroke
     path    { rings: [[[x, y], ...], ...], fillRule }   compound shape: every ring is
             closed, further rings are holes (the letter O). Comes from SVG import.   */
  G.isClosed = function (o) { return o.type === 'rect' || o.type === 'ellipse' || o.type === 'polygon' || o.type === 'path' || (o.type === 'pen' && !!o.closed); };
  /* Every point list of an object that has one: [pts] or the rings of a path. */
  G.ringsOf = function (o) { return o.type === 'path' ? o.rings : o.pts ? [o.pts] : []; };
  G.pointCount = function (o) { var n = 0; G.ringsOf(o).forEach(function (r) { n += r.length; }); return n; };
  /* The outline of an object as point lists: [{ pts, closed }]. Curves are sampled. */
  G.outlines = function (o) {
    var i, pts;
    switch (o.type) {
      case 'rect': return [{ pts: [[o.x, o.y], [o.x + o.w, o.y], [o.x + o.w, o.y + o.h], [o.x, o.y + o.h]], closed: true }];
      case 'ellipse':
        pts = [];
        for (i = 0; i < 64; i++) pts.push([o.cx + o.rx * Math.cos(i / 64 * Math.PI * 2), o.cy + o.ry * Math.sin(i / 64 * Math.PI * 2)]);
        return [{ pts: pts, closed: true }];
      case 'line': return [{ pts: [[o.x1, o.y1], [o.x2, o.y2]], closed: false }];
      case 'path': return o.rings.map(function (r) { return { pts: r, closed: true }; });
      case 'polygon': return [{ pts: o.pts, closed: true }];
      default: return [{ pts: o.pts, closed: !!o.closed }];
    }
  };
  /* Rub a disc (centre cx, cy, radius r) over a line. Returns the pieces that are left, each an open
     point list, or null when the disc does not touch the line. Pieces shorter than minLen are dropped. */
  G.eraseLine = function (pts, closed, cx, cy, r, minLen) {
    var P = closed && pts.length > 2 ? pts.concat([pts[0]]) : pts, pieces = [], cur = null, touched = false, r2 = r * r, i;
    function at(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
    function close() { if (cur && cur.length > 1) pieces.push(cur); cur = null; }
    for (i = 0; i + 1 < P.length; i++) {
      var a = P[i], b = P[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], fx = a[0] - cx, fy = a[1] - cy;
      var A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r2, t1 = 2, t2 = -1;
      if (A < 1e-12) { if (C <= 0) { touched = true; close(); } else if (!cur) cur = [a]; continue; }
      var disc = B * B - 4 * A * C;
      if (disc > 0) { var sq = Math.sqrt(disc); t1 = (-B - sq) / (2 * A); t2 = (-B + sq) / (2 * A); }
      if (disc <= 0 || t2 <= 0 || t1 >= 1) { if (!cur) cur = [a]; cur.push(b); continue; }     /* this piece is clear of the disc */
      touched = true;
      if (t1 > 0) { if (!cur) cur = [a]; cur.push(at(a, b, t1)); }                              /* up to where the disc starts */
      close();
      if (t2 < 1) cur = [at(a, b, t2), b];                                                     /* from where it ends */
    }
    close();
    if (!touched) return null;
    if (closed && pieces.length > 1) {                                                         /* a ring: the last piece runs on into the first */
      var first = pieces[0], last = pieces[pieces.length - 1];
      if (first[0][0] === P[0][0] && first[0][1] === P[0][1] && last[last.length - 1][0] === P[0][0] && last[last.length - 1][1] === P[0][1]) {
        pieces[0] = last.concat(first.slice(1)); pieces.pop();
      }
    }
    minLen = minLen || 0;
    return pieces.filter(function (p) {
      var len = 0; for (var k = 1; k < p.length; k++) len += G.dist(p[k - 1][0], p[k - 1][1], p[k][0], p[k][1]);
      return len >= minLen;
    });
  };

  /* Signed area of a ring (shoelace). */
  G.area = function (pts) {
    var a = 0, n = pts.length, i, j;
    for (i = 0, j = n - 1; i < n; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
    return a / 2;
  };

  G.bbox = function (o) {
    var i, p, x0, y0, x1, y1;
    switch (o.type) {
      case 'rect': return { x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.h };
      case 'ellipse': return { x0: o.cx - o.rx, y0: o.cy - o.ry, x1: o.cx + o.rx, y1: o.cy + o.ry };
      case 'line': return { x0: Math.min(o.x1, o.x2), y0: Math.min(o.y1, o.y2), x1: Math.max(o.x1, o.x2), y1: Math.max(o.y1, o.y2) };
      default:
        x0 = y0 = Infinity; x1 = y1 = -Infinity;
        G.ringsOf(o).forEach(function (pts) {
          for (i = 0; i < pts.length; i++) {
            p = pts[i];
            if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
            if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
          }
        });
        if (x0 === Infinity) return { x0: 0, y0: 0, x1: 0, y1: 0 };
        return { x0: x0, y0: y0, x1: x1, y1: y1 };
    }
  };
  G.union = function (objs) {
    if (!objs.length) return null;
    var u = G.bbox(objs[0]), i, b;
    for (i = 1; i < objs.length; i++) {
      b = G.bbox(objs[i]);
      if (b.x0 < u.x0) u.x0 = b.x0; if (b.y0 < u.y0) u.y0 = b.y0;
      if (b.x1 > u.x1) u.x1 = b.x1; if (b.y1 > u.y1) u.y1 = b.y1;
    }
    return u;
  };
  G.rectsTouch = function (a, b) { return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0; };

  /* Copy only the geometry fields of `src` onto `dst` (same type). */
  G.copyGeom = function (dst, src) {
    switch (src.type) {
      case 'rect': dst.x = src.x; dst.y = src.y; dst.w = src.w; dst.h = src.h; break;
      case 'ellipse': dst.cx = src.cx; dst.cy = src.cy; dst.rx = src.rx; dst.ry = src.ry; break;
      case 'line': dst.x1 = src.x1; dst.y1 = src.y1; dst.x2 = src.x2; dst.y2 = src.y2; break;
      case 'path':
        dst.rings = src.rings.map(function (r) { return r.map(function (p) { return [p[0], p[1]]; }); });
        dst.fillRule = src.fillRule === 'evenodd' ? 'evenodd' : 'nonzero';
        break;
      default: dst.pts = src.pts.map(function (p) { return [p[0], p[1]]; }); if (src.type === 'pen') dst.closed = !!src.closed;
    }
    return dst;
  };
  G.geomOf = function (o) { return G.copyGeom({ type: o.type }, o); };

  /* Apply x' = ax + (x - ax) * sx + dx (and the same for y) to an object, in place.
     A negative scale mirrors the shape; rect and ellipse are normalised again. */
  G.transform = function (o, ax, ay, sx, sy, dx, dy) {
    var r2 = G.r2;
    function X(x) { return r2(ax + (x - ax) * sx + dx); }
    function Y(y) { return r2(ay + (y - ay) * sy + dy); }
    var a, b, c, d, i;
    switch (o.type) {
      case 'rect':
        a = X(o.x); b = X(o.x + o.w); c = Y(o.y); d = Y(o.y + o.h);
        o.x = Math.min(a, b); o.w = r2(Math.abs(b - a)); o.y = Math.min(c, d); o.h = r2(Math.abs(d - c));
        break;
      case 'ellipse':
        o.cx = X(o.cx); o.cy = Y(o.cy); o.rx = r2(Math.abs(o.rx * sx)); o.ry = r2(Math.abs(o.ry * sy));
        break;
      case 'line':
        o.x1 = X(o.x1); o.y1 = Y(o.y1); o.x2 = X(o.x2); o.y2 = Y(o.y2);
        break;
      case 'path':                        /* new arrays: view.js caches the drawn outline by ring list */
        o.rings = o.rings.map(function (r) { return r.map(function (q) { return [X(q[0]), Y(q[1])]; }); });
        break;
      default:
        for (i = 0; i < o.pts.length; i++) o.pts[i] = [X(o.pts[i][0]), Y(o.pts[i][1])];
    }
    return o;
  };
  G.translate = function (o, dx, dy) { return G.transform(o, 0, 0, 1, 1, dx, dy); };

  G.pathLength = function (pts, closed) {
    var n = 0, i;
    for (i = 1; i < pts.length; i++) n += G.dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    if (closed && pts.length > 2) n += G.dist(pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1]);
    return n;
  };

  /* Ramer-Douglas-Peucker. Keeps the first and last point. Iterative, so a
     long freehand stroke cannot overflow the stack. */
  G.simplify = function (pts, tol) {
    var n = pts.length;
    if (n < 3) return pts.slice();
    var keep = new Uint8Array(n), stack = [[0, n - 1]], tol2 = tol * tol;
    keep[0] = keep[n - 1] = 1;
    while (stack.length) {
      var seg = stack.pop(), a = seg[0], b = seg[1];
      var ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
      var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy, best = -1, bestD = tol2, i;
      for (i = a + 1; i < b; i++) {
        var px = pts[i][0] - ax, py = pts[i][1] - ay, d;
        if (len2 === 0) d = px * px + py * py;
        else {
          var t = (px * dx + py * dy) / len2; t = t < 0 ? 0 : t > 1 ? 1 : t;
          var qx = px - t * dx, qy = py - t * dy; d = qx * qx + qy * qy;
        }
        if (d > bestD) { bestD = d; best = i; }
      }
      if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
    }
    var out = [];
    for (var k = 0; k < n; k++) if (keep[k]) out.push(pts[k]);
    return out;
  };

  /* ---------- colour -------------------------------------------------------- */
  /* '#rgb' | '#rrggbb' | 'rrggbb' (any case) -> '#rrggbb', anything else -> null */
  G.hex = function (v) {
    if (typeof v !== 'string') return null;
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
    if (!m) return null;
    var h = m[1].toLowerCase();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return '#' + h;
  };
  G.rgb = function (hex) { var n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  /* Any CSS colour the browser resolved (hex or rgb()) -> '#rrggbb' */
  G.cssToHex = function (v) {
    var h = G.hex(v); if (h) return h;
    var m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(String(v));
    if (!m) return null;
    return '#' + [m[1], m[2], m[3]].map(function (c) { var n = Math.round(parseFloat(c)); return (n < 16 ? '0' : '') + n.toString(16); }).join('');
  };
  /* WCAG relative luminance, 0 (black) to 1 (white) */
  G.luminance = function (hex) {
    var c = G.rgb(hex).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  /* A darker (or, for very dark colours, lighter) shade of the same thread:
     used so an outline is visible on a fill of the same colour. */
  G.shade = function (hex) {
    var c = G.rgb(hex), dark = G.luminance(hex) < 0.08;
    return '#' + c.map(function (v) {
      var n = Math.round(dark ? v + (255 - v) * 0.35 : v * 0.68);
      return (n < 16 ? '0' : '') + n.toString(16);
    }).join('');
  };
  G.rgba = function (hex, a) { var c = G.rgb(G.hex(hex) || '#000000'); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; };
})();
