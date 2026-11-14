/* ==========================================================================
   EMBROIDERY LABS - js/editor/cut.js
   Cut out: split shapes along a drawn region, so one part of a shape can get
   its own thread colour, paint, line type, fill pattern or stitch style.

     Editor.Cut.apply(lasso)   lasso: [[x, y], ...] in mm, a closed outline (it may cross itself).
                               Every SELECTED shape, or when nothing is selected every shape under the
                               region, is split into the part inside and the part outside. One undo
                               step "Cut out"; the inside parts become the selection.
                               Returns { split, whole, inside: [ids] } or null when nothing was cut.
     Editor.Cut.region(o)      the area the engine fills for a closed shape, as polygon-clipping
                               MultiPolygon [[[x, y], ...] rings ...] ...]
     Editor.Cut.splitShape(o, region)   { inside: [geom], outside: [geom] } or null (no overlap)
     Editor.Cut.splitLine(pts, closed, region)   { inside: [pts], outside: [pts] } open point lists
     Editor.Cut.area(multiPolygon)      area in mm2

   Filled shapes (paint Fill or Both, any type, compound paths and line art too) are cut with polygon
   booleans: inside = shape AND region, outside = shape MINUS region, each turned back into a polygon
   (one ring) or a path (rings, nonzero rule). Lines, open strokes and outline-only shapes are split
   where the region edge crosses them, into open strokes of the same thread, like the eraser does;
   the rings of an outline-only shape that the edge does not cross stay together as one closed shape.
   Nothing here touches the engine: a cut piece is an ordinary shape.

   Polygon booleans: polygon-clipping by Mike Fogel, MIT licence, vendored as
   js/vendor/polygon-clipping.min.js (loaded before this file, global `polygonClipping`).
     version 0.15.7, from `npm pack polygon-clipping@0.15.7`, file dist/polygon-clipping.umd.min.js,
     sha256 of that upstream file 7f8619e84a86ce8dd400c9b50430e9c8cf8f26027b19eeb479f109f5c1a9d688
     (the vendored copy is that file with a licence comment added on top).
   ========================================================================== */
(function () {
  'use strict';
  var Editor = window.Editor, G = Editor.Geom, M = Editor.Model;
  var PC = window.polygonClipping || null;
  var LIB = { name: 'polygon-clipping', version: '0.15.7', sha256: '7f8619e84a86ce8dd400c9b50430e9c8cf8f26027b19eeb479f109f5c1a9d688' };
  var MAX_RINGS = 2000;          /* what Model.load accepts for one path */
  var MIN_AREA = 0.02;           /* mm2: a sliver smaller than this is rounding, not a piece */
  var MIN_PIECE = 0.2;           /* mm: shorter line pieces are dropped */
  var C = Editor.Cut = { LIB: LIB, available: !!PC };

  function say(msg) { if (Editor.say) Editor.say(msg); }
  function toast(msg, opts) { if (Editor.toast) Editor.toast(msg, opts || { label: 'Cut out', timeout: 3500 }); }

  /* ---------- outlines as point rings ------------------------------------------- */
  /* An ellipse with chords no further than 0.02 mm from the curve (the engine flattens its own, about as fine). */
  function ellipseRing(o) {
    var r = Math.max(o.rx, o.ry), n = 16, pts = [], i;
    if (r > 0.02) n = Math.ceil(Math.PI / Math.acos(1 - 0.02 / r));
    n = Math.max(16, Math.min(720, n));
    for (i = 0; i < n; i++) pts.push([o.cx + o.rx * Math.cos(i / n * Math.PI * 2), o.cy + o.ry * Math.sin(i / n * Math.PI * 2)]);
    return pts;
  }
  function ringsOf(o) {
    switch (o.type) {
      case 'rect': return [[[o.x, o.y], [o.x + o.w, o.y], [o.x + o.w, o.y + o.h], [o.x, o.y + o.h]]];
      case 'ellipse': return [ellipseRing(o)];
      case 'path': return o.rings;
      default: return [o.pts];
    }
  }
  function lineOutlines(o) {
    if (o.type === 'ellipse') return [{ pts: ellipseRing(o), closed: true }];
    return G.outlines(o);
  }

  /* ---------- areas ------------------------------------------------------------- */
  function ringArea(r) { return G.area(r); }
  C.area = function (mp) {
    var a = 0;
    (mp || []).forEach(function (poly) { poly.forEach(function (ring, k) { a += k === 0 ? Math.abs(ringArea(ring)) : -Math.abs(ringArea(ring)); }); });
    return a;
  };
  function ringBox(r) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (var i = 0; i < r.length; i++) {
      var p = r[i];
      if (p[0] < b.x0) b.x0 = p[0]; if (p[0] > b.x1) b.x1 = p[0];
      if (p[1] < b.y0) b.y0 = p[1]; if (p[1] > b.y1) b.y1 = p[1];
    }
    return b;
  }
  function inRing(x, y, r) {
    var c = false;
    for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
      var a = r[i], b = r[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }

  /* ---------- the filled area of a shape ------------------------------------------ */
  /* nonzero equals evenodd when the rings do not cross and each one turns the opposite way to the
     one around it (what SVG import and every drawn shape give). Checked per ring, from one corner. */
  function nestsCleanly(rings) {
    var info = rings.map(function (r) { var a = ringArea(r); return { r: r, s: a > 0 ? 1 : a < 0 ? -1 : 0, b: ringBox(r) }; }), i, j;
    for (i = 0; i < info.length; i++) {
      if (!info[i].s) return false;
      var p = info[i].r[0], w = info[i].s, depth = 0;
      for (j = 0; j < info.length; j++) {
        if (j === i) continue;
        var b = info[j].b;
        if (p[0] < b.x0 || p[0] > b.x1 || p[1] < b.y0 || p[1] > b.y1) continue;
        if (inRing(p[0], p[1], info[j].r)) { depth++; w += info[j].s; }
      }
      if ((w !== 0) !== ((depth & 1) === 0)) return false;
    }
    return true;
  }
  function geomOfRing(r) { return [[r]]; }
  /* Exact nonzero for any rings: keep the area of every winding number apart, add one ring at a time. */
  function windingRegion(rings) {
    var map = {};                                   /* winding -> MultiPolygon */
    rings.forEach(function (r) {
      var a = ringArea(r), s = a > 0 ? 1 : a < 0 ? -1 : 0, R = geomOfRing(r), next = {}, covered = [];
      if (!s) return;
      function put(w, g) { if (!g || !g.length) return; next[w] = next[w] ? PC.union(next[w], g) : g; }
      Object.keys(map).forEach(function (k) {
        var w = +k, g = map[k];
        covered.push(g);
        put(w + s, PC.intersection(g, R));
        put(w, PC.difference(g, R));
      });
      put(s, covered.length ? PC.difference.apply(null, [R].concat(covered)) : PC.union(R));
      map = next;
    });
    var parts = Object.keys(map).filter(function (k) { return +k !== 0; }).map(function (k) { return map[k]; });
    if (!parts.length) return [];
    return parts.length === 1 ? parts[0] : PC.union.apply(null, parts);
  }
  C.region = function (o) {
    var rings = ringsOf(o).filter(function (r) { return r && r.length >= 3; });
    if (!rings.length) return [];
    if (rings.length === 1) return PC.union(geomOfRing(rings[0]));
    var geoms = rings.map(geomOfRing);
    if (o.fillRule === 'evenodd' || nestsCleanly(rings)) return PC.xor.apply(null, geoms);
    return windingRegion(rings);
  };
  /* The drawn region; a lasso that crosses itself keeps every loop. */
  function lassoRegion(pts) { return PC.union(geomOfRing(pts)); }

  /* ---------- MultiPolygon back to editor shapes ----------------------------------- */
  function cleanRing(r) {
    var out = [], i, p, q;
    for (i = 0; i < r.length; i++) {
      p = [G.r2(r[i][0]), G.r2(r[i][1])]; q = out[out.length - 1];
      if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
    }
    while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
    return out.length >= 3 && Math.abs(G.area(out)) >= 1e-4 ? out : null;
  }
  /* One island with its holes, rounded to 1/100 mm; null when nothing is left of it. */
  function cleanPoly(poly) {
    var outer = cleanRing(poly[0]);
    if (!outer || Math.abs(G.area(outer)) < MIN_AREA) return null;
    var rings = [outer];
    for (var k = 1; k < poly.length; k++) { var h = cleanRing(poly[k]); if (h) rings.push(h); }
    return rings;
  }
  function count(rings) { var n = 0; rings.forEach(function (r) { n += r.length; }); return n; }
  /* An island too big for one shape on its own: drop points until it fits. */
  function shrink(rings) {
    var tol = 0.02;
    while (count(rings) > M.MAX_POINTS && tol < 5) {
      rings = rings.map(function (r) { var s = G.simplify(r.concat([r[0]]), tol); s.pop(); return s; }).filter(function (r) { return r.length >= 3; });
      tol *= 2;
    }
    return rings;
  }
  function toGeoms(mp) {
    var groups = [], cur = null;
    (mp || []).forEach(function (poly) {
      var rings = cleanPoly(poly); if (!rings) return;
      if (count(rings) > M.MAX_POINTS) rings = shrink(rings);
      if (!rings.length) return;
      var n = count(rings);
      if (!cur || cur.n + n > M.MAX_POINTS || cur.rings.length + rings.length > MAX_RINGS) { cur = { rings: [], n: 0 }; groups.push(cur); }
      cur.rings = cur.rings.concat(rings); cur.n += n;
    });
    return groups.map(function (g) {
      return g.rings.length === 1 ? { type: 'polygon', pts: g.rings[0] } : { type: 'path', rings: g.rings, fillRule: 'nonzero' };
    });
  }

  /* ---------- filled shapes ------------------------------------------------------------ */
  C.splitShape = function (o, P) {
    var A = C.region(o);
    if (!A.length) return null;
    var inside = PC.intersection(A, P);
    if (C.area(inside) < MIN_AREA) return null;
    var outside = PC.difference(A, P);
    if (C.area(outside) < MIN_AREA) return { whole: true, inside: [], outside: [] };
    return { inside: toGeoms(inside), outside: toGeoms(outside), areaIn: C.area(inside), areaOut: C.area(outside), area: C.area(A) };
  };

  /* ---------- lines and strokes --------------------------------------------------------- */
  function edgesOf(P) {
    var e = [];
    P.forEach(function (poly) { poly.forEach(function (r) { for (var i = 0, j = r.length - 1; i < r.length; j = i++) e.push([r[j][0], r[j][1], r[i][0], r[i][1]]); }); });
    return e;
  }
  function inRegion(x, y, P) {
    var c = false;
    P.forEach(function (poly) { poly.forEach(function (r) { if (inRing(x, y, r)) c = !c; }); });   /* rings from polygon-clipping never cross */
    return c;
  }
  /* Where segment a-b crosses the region edges, as parameters 0 < t < 1, sorted. */
  function crossings(a, b, E) {
    var ts = [], dx = b[0] - a[0], dy = b[1] - a[1];
    var x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    for (var k = 0; k < E.length; k++) {
      var e = E[k];
      if (Math.max(e[0], e[2]) < x0 || Math.min(e[0], e[2]) > x1 || Math.max(e[1], e[3]) < y0 || Math.min(e[1], e[3]) > y1) continue;
      var ex = e[2] - e[0], ey = e[3] - e[1], den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;                   /* parallel: no single crossing point */
      var fx = e[0] - a[0], fy = e[1] - a[1];
      var t = (fx * ey - fy * ex) / den, u = (fx * dy - fy * dx) / den;
      if (t > 1e-9 && t < 1 - 1e-9 && u >= 0 && u <= 1) ts.push(t);
    }
    return ts.sort(function (p, q) { return p - q; });
  }
  function lineLen(p) { var n = 0; for (var k = 1; k < p.length; k++) n += G.dist(p[k - 1][0], p[k - 1][1], p[k][0], p[k][1]); return n; }
  C.splitLine = function (pts, closed, P) {
    var L = closed && pts.length > 2 ? pts.concat([pts[0]]) : pts.slice(), E = edgesOf(P), runs = [], cur = null, i, k;
    if (L.length < 2) return { inside: [], outside: [] };
    for (i = 0; i + 1 < L.length; i++) {
      var a = L[i], b = L[i + 1], ts = [0].concat(crossings(a, b, E), [1]);
      for (k = 0; k + 1 < ts.length; k++) {
        if (ts[k + 1] - ts[k] < 1e-12) continue;
        var tm = (ts[k] + ts[k + 1]) / 2, side = inRegion(a[0] + (b[0] - a[0]) * tm, a[1] + (b[1] - a[1]) * tm, P);
        var p0 = [a[0] + (b[0] - a[0]) * ts[k], a[1] + (b[1] - a[1]) * ts[k]], p1 = [a[0] + (b[0] - a[0]) * ts[k + 1], a[1] + (b[1] - a[1]) * ts[k + 1]];
        if (!cur || cur.side !== side) { cur = { side: side, pts: [p0] }; runs.push(cur); }   /* a new run starts where the last ended */
        var q = cur.pts[cur.pts.length - 1];
        if (q[0] !== p1[0] || q[1] !== p1[1]) cur.pts.push(p1);
      }
    }
    /* a ring: the last run goes on into the first when they are on the same side */
    if (closed && runs.length > 1 && runs[0].side === runs[runs.length - 1].side) {
      var last = runs.pop(); runs[0].pts = last.pts.concat(runs[0].pts.slice(1));
    }
    var res = { inside: [], outside: [] };
    if (closed && runs.length === 1) { res[runs[0].side ? 'inside' : 'outside'].push(runs[0].pts); res.whole = true; return res; }
    runs.forEach(function (r) { if (r.pts.length > 1 && lineLen(r.pts) >= MIN_PIECE) res[r.side ? 'inside' : 'outside'].push(r.pts); });
    return res;
  };
  /* An outline-only shape keeps the rings the region does not cross together, as one closed shape
     (a polygon, or a path when there are several), instead of one stroke per ring: an imported outline
     can have hundreds of rings. Only the rings the region edge crosses become open strokes. */
  function splitLines(o, P) {
    var inside = [], outside = [], inRings = [], outRings = [];
    lineOutlines(o).forEach(function (line) {
      var r = C.splitLine(line.pts, line.closed, P);
      if (r.whole && line.closed) { (r.inside.length ? inRings : outRings).push(line.pts); return; }
      inside = inside.concat(r.inside); outside = outside.concat(r.outside);
    });
    if (!inside.length && !inRings.length) return null;
    if (!outside.length && !outRings.length) return { whole: true, inside: [], outside: [] };
    return { lines: true, inside: inside, outside: outside, inRings: inRings, outRings: outRings };
  }
  /* Whole rings back to closed shapes: groups that fit Model's limits, the original fill rule kept. */
  function ringGeoms(rings, rule) {
    var groups = [], cur = null;
    (rings || []).forEach(function (r) {
      var c = cleanRing(r); if (!c) return;
      if (!cur || cur.n + c.length > M.MAX_POINTS || cur.rings.length >= MAX_RINGS) { cur = { rings: [], n: 0 }; groups.push(cur); }
      cur.rings.push(c); cur.n += c.length;
    });
    return groups.map(function (g) {
      return g.rings.length === 1 ? { type: 'polygon', pts: g.rings[0] } : { type: 'path', rings: g.rings, fillRule: rule === 'evenodd' ? 'evenodd' : 'nonzero' };
    });
  }

  /* ---------- the tool's action ------------------------------------------------------------ */
  function isFilled(o) { return G.isClosed(o) && M.paintOf(o) !== 'line'; }
  function strokeGeoms(list) { return list.map(function (pts) { return { type: 'pen', pts: pts.map(function (p) { return [G.r2(p[0]), G.r2(p[1])]; }), closed: false }; }); }

  /* lasso: [[x, y], ...] mm. opts.ids: shapes to cut (default: the selection, else everything under it). */
  C.apply = function (lasso, opts) {
    opts = opts || {};
    if (!PC) { toast('Cut out is not available: its geometry library did not load.'); return null; }
    var pts = (lasso || []).filter(function (p) { return p && isFinite(p[0]) && isFinite(p[1]); });
    if (pts.length < 3) { toast('Draw around the part you want to cut out.'); return null; }
    /* the area of the drawn region, not the signed area of the outline: a figure-8 has loops that cancel */
    var P, lb = ringBox(pts);
    try { P = lassoRegion(pts); } catch (e) { P = []; }
    if (!P.length || C.area(P) < 0.5) { toast('Draw around the part you want to cut out.'); return null; }
    var picked = opts.ids ? opts.ids.map(M.get).filter(Boolean) : M.selected();
    var targets = picked.length ? picked : M.doc.objects.slice();
    var results = {}, nSplit = 0, nWhole = 0, failed = 0, added = 0;
    targets.forEach(function (o) {
      if (!G.rectsTouch(G.bbox(o), lb)) return;
      var r = null;
      try { r = isFilled(o) ? C.splitShape(o, P) : splitLines(o, P); } catch (e) { failed++; return; }
      if (!r) return;
      if (r.whole) { results[o.id] = r; nWhole++; return; }
      r.made = {
        outside: (r.lines ? ringGeoms(r.outRings, o.fillRule).concat(strokeGeoms(r.outside)) : r.outside).map(function (g) { return M.piece(o, g, o.name); }),
        inside: (r.lines ? ringGeoms(r.inRings, o.fillRule).concat(strokeGeoms(r.inside)) : r.inside).map(function (g) { return M.piece(o, g, o.name + ' cut'); })
      };
      if (!r.made.inside.length) return;
      added += r.made.inside.length + r.made.outside.length - 1;
      results[o.id] = r; nSplit++;
    });
    if (!nSplit && !nWhole) {
      toast(failed ? 'That shape could not be cut. Try a simpler outline.' : picked.length ? 'The outline does not cross the selected shape.' : 'Nothing under that outline to cut.');
      return null;
    }
    if (M.doc.objects.length + added > M.MAX_OBJECTS) { toast('Too many shapes to cut that: the design is full.'); return null; }
    var inside = [];
    M.commit('Cut out', function () {
      var out = [];
      M.doc.objects.forEach(function (o) {
        var r = results[o.id];
        if (!r) { out.push(o); return; }
        if (r.whole) { out.push(o); inside.push(o.id); return; }
        r.made.outside.forEach(function (n) { out.push(n); });
        r.made.inside.forEach(function (n) { out.push(n); inside.push(n.id); });
      });
      M.doc.objects = out;
      M.selection = inside.slice();
    });
    var msg = nSplit ? (nSplit === 1 ? 'Cut out. The inside part is selected.' : 'Cut ' + nSplit + ' shapes. The inside parts are selected.') : 'Already inside the outline: selected.';
    say(msg);
    if (nSplit) toast(msg + ' Change its thread or stitch style.', { label: 'Cut out', timeout: 3500, action: { label: 'Undo', onClick: function () { if (M.undoLabel() === 'Cut out') M.undo(); } } });
    return { split: nSplit, whole: nWhole, inside: inside };
  };
})();
