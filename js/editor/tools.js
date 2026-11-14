/* ==========================================================================
   EMBROIDERY LABS - js/editor/tools.js
   Pointer tools on the main canvas, with Pointer Events so mouse, pen and
   touch behave the same:
     select   click (real geometry, topmost first), Shift-click, drag to move,
              handles to resize (Shift keeps proportion), marquee on empty space.
              A click on a grouped shape picks its whole group; a double-click enters the
              group and picks that one shape (then clicks pick its other shapes), like Figma
     pen      freehand stroke; ends near its start = closed (can be filled)
     line / rect / ellipse    press, drag, release (Shift constrains)
     polygon  click points; click the first point, double-click or Enter closes;
              Backspace removes the last point; Esc cancels
     eraser   rub over a line, a stroke or an outline to remove just that part; press a filled shape to
              delete it (one undo step per rub)
     cut      draw around part of a shape (drag freehand, or click points and close like a polygon);
              the selected shapes, or every shape under it, are split into the part inside and the
              part outside (Editor.Cut, one undo step), and the inside part is selected
     pan      drag; also Space-drag and the middle mouse button with any tool
   Wheel: mouse wheel and pinch zoom to the cursor, two-finger scroll pans.

   One gesture at a time lives in `gesture`. Every document change goes through
   Model, so each gesture is exactly one undo step, or none if it is cancelled.

   HOW TO ADD A TOOL: see NOTES.md.
   ========================================================================== */
(function () {
  'use strict';
  var Editor = window.Editor, G = Editor.Geom, M = Editor.Model, V = Editor.View;
  var NAMES = { select: 'Select', pen: 'Pen', line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', eraser: 'Eraser', cut: 'Cut out', pan: 'Pan' };
  var T = Editor.Tools = { current: 'select', NAMES: NAMES };
  var el = {};
  var gesture = null;       /* the drag in progress: { type, pid, ... } */
  var touches = {};         /* touch pointers on the canvas: id -> { x, y } (client px) */
  var poly = null;          /* polygon being placed: { pts: [[x, y], ...] } */
  var lasso = null;         /* cut-out outline being placed by clicks: { pts: [[x, y], ...] } */
  var spaceDown = false;
  var hinted = {};
  var MIN_MM = 1;           /* a shape smaller than this in every direction is a slip, not a drawing */
  var CLICK_PX = 4;

  function say(msg) { if (Editor.say) Editor.say(msg); }
  function count(o) { var n = 0; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) n++; return n; }
  function snapAngle(ax, ay, x, y) {
    var dx = x - ax, dy = y - ay, len = Math.sqrt(dx * dx + dy * dy), a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return [ax + Math.cos(a) * len, ay + Math.sin(a) * len];
  }
  function hint(tool) {
    if (hinted[tool]) return; hinted[tool] = true;
    Editor.toast(tool === 'cut' ? 'Draw around the part to cut out: drag, or click points.' : 'Press and drag on the hoop to draw.', { label: NAMES[tool], timeout: 3500 });
  }

  /* ---------- tool switching ---------------------------------------------------- */
  T.set = function (name) {
    if (!NAMES[name]) return;
    endGesture(true);                         /* a drag in progress is cancelled ... */
    if (poly) finishPolygon(true);            /* ... a polygon with 3+ points is kept */
    if (lasso) finishLasso(false);            /* ... a cut-out outline is dropped: cutting is never implied */
    T.current = name; V.tool = name;
    V.hoverId = null;
    var btns = document.querySelectorAll('button[data-tool]');
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', btns[i].getAttribute('data-tool') === name ? 'true' : 'false');
    el.view.setAttribute('data-tool', name);
    el.view.style.cursor = '';
    el.footTool.textContent = NAMES[name];
    V.invalidate();
    Editor.emit('tool', name);
    if (name === 'cut') hint('cut');
  };
  /* True while something half-drawn would be lost by an unrelated action. */
  T.busy = function () { return !!gesture || !!poly || !!lasso; };

  /* ---------- drafts -------------------------------------------------------------- */
  function setDraft(d) { V.draft = d; V.invalidate(); }

  /* ---------- polygon ---------------------------------------------------------------- */
  function closeReach() { return (V.coarse ? 16 : 9) / V.ppm(); }
  function polyDraft(cursor) {
    if (!poly) return setDraft(null);
    var can = false;
    if (cursor && poly.pts.length >= 3) can = G.dist(cursor[0], cursor[1], poly.pts[0][0], poly.pts[0][1]) <= closeReach();
    setDraft({ poly: { pts: poly.pts, cursor: cursor || null, canClose: can } });
  }
  /* keep = true: a polygon with at least three points becomes a shape. */
  function finishPolygon(keep) {
    var p = poly; poly = null; setDraft(null);
    if (!p || !keep) return false;
    if (p.pts.length < 3) return false;
    var b = G.bbox({ type: 'polygon', pts: p.pts });
    if (b.x1 - b.x0 < MIN_MM && b.y1 - b.y0 < MIN_MM) return false;
    M.add({ type: 'polygon', pts: p.pts });
    say('Polygon with ' + p.pts.length + ' points added');
    return true;
  }
  function polygonDown(p, e) {
    if (!poly) poly = { pts: [] };
    var pts = poly.pts, n = pts.length;
    if (n >= 3 && G.dist(p.x, p.y, pts[0][0], pts[0][1]) <= closeReach()) { finishPolygon(true); return; }
    /* the second press of a double-click lands on the point just placed: not a new point */
    if (n && G.dist(p.x, p.y, pts[n - 1][0], pts[n - 1][1]) <= 3 / V.ppm()) { gesture = { type: 'polypoint', pid: e.pointerId, added: false }; return; }
    var q = [G.r2(p.x), G.r2(p.y)];
    if (e.shiftKey && n) { q = snapAngle(pts[n - 1][0], pts[n - 1][1], p.x, p.y); q = [G.r2(q[0]), G.r2(q[1])]; }
    pts.push(q);
    gesture = { type: 'polypoint', pid: e.pointerId, added: true };
    polyDraft(q);
  }

  /* ---------- cut out ------------------------------------------------------------------- */
  /* Drag to draw the outline freehand (it closes on release), or click points and close it like a
     polygon (click the first point, double-click or Enter). Then Editor.Cut splits the shapes. */
  function lassoDraft(cursor) {
    if (!lasso) return setDraft(null);
    var can = !!(cursor && lasso.pts.length >= 3 && G.dist(cursor[0], cursor[1], lasso.pts[0][0], lasso.pts[0][1]) <= closeReach());
    setDraft({ lasso: { pts: lasso.pts, cursor: cursor || null, marks: true, canClose: can } });
  }
  function cutWith(pts) {
    if (!Editor.Cut) { Editor.toast('Cut out did not load. Reload the page to try again.', { label: NAMES.cut, timeout: 3500 }); return false; }
    return !!Editor.Cut.apply(pts);
  }
  function finishLasso(keep) {
    var l = lasso; lasso = null; setDraft(null);
    if (!l || !keep) return false;
    if (l.pts.length < 3) { say('An outline needs at least 3 points'); return false; }
    return cutWith(l.pts);
  }
  function lassoClick(p, e) {
    var pts = lasso.pts, n = pts.length;
    if (n >= 3 && G.dist(p.x, p.y, pts[0][0], pts[0][1]) <= closeReach()) { finishLasso(true); return; }
    if (n && G.dist(p.x, p.y, pts[n - 1][0], pts[n - 1][1]) <= 3 / V.ppm()) { gesture = { type: 'lassopoint', pid: e.pointerId, added: false }; return; }
    pts.push([G.r2(p.x), G.r2(p.y)]);
    gesture = { type: 'lassopoint', pid: e.pointerId, added: true };
    lassoDraft([p.x, p.y]);
  }
  function lassoAdd(g, ev) {
    var p = V.toMm(ev.clientX, ev.clientY);
    if (Math.abs(p.px - g.lx) + Math.abs(p.py - g.ly) < 1.5) return;
    g.lx = p.px; g.ly = p.py;
    g.pts.push([G.r2(p.x), G.r2(p.y)]);
  }
  function lassoMove(g, p, e) {
    if (!g.free) {
      if (Math.abs(p.px - g.start.px) + Math.abs(p.py - g.start.py) < CLICK_PX) return;
      g.free = true;
    }
    var list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (list && list.length) list.forEach(function (ev) { lassoAdd(g, ev); }); else lassoAdd(g, e);
    setDraft({ lasso: { pts: g.pts, cursor: null, marks: false, closed: true } });
  }
  function lassoEnd(g) {
    setDraft(null);
    if (!g.free) {                                    /* a click: start an outline made of points */
      lasso = { pts: [[G.r2(g.start.x), G.r2(g.start.y)]] };
      lassoDraft([g.start.x, g.start.y]);
      return;
    }
    var pts = G.simplify(g.pts, Math.max(0.05, 0.6 / V.ppm()));
    if (pts.length < 3 || G.pathLength(pts, true) < 3) { hint('cut'); return; }
    cutWith(pts);
  }

  /* ---------- groups --------------------------------------------------------------------- */
  /* What a click on shape o picks: its whole group, unless the selection is already inside that
     group (a double-click entered it), then just o. A loose shape is itself. */
  function pickUnit(o) {
    var g = o.group ? M.group(o.group) : null;
    if (!g) return [o.id];
    var inside = M.insideGroup();
    if (inside && inside.id === g.id) return [o.id];
    return M.members(g.id);
  }
  T.pickUnit = pickUnit;

  /* ---------- gestures ------------------------------------------------------------------ */
  function originals() { return M.selected().map(function (o) { return { id: o.id, geom: G.geomOf(o) }; }); }
  function putBack(list, fn) {
    list.forEach(function (r) {
      var o = M.get(r.id); if (!o) return;
      G.copyGeom(o, r.geom);
      fn(o);
      if (o.type === 'rect') { if (o.w < 0.01) o.w = 0.01; if (o.h < 0.01) o.h = 0.01; }
      if (o.type === 'ellipse') { if (o.rx < 0.01) o.rx = 0.01; if (o.ry < 0.01) o.ry = 0.01; }
    });
    M.touch();
  }

  function startResize(h, p, e) {
    var sel = M.selected(), k = h.k;
    var g = { type: 'resize', pid: e.pointerId, k: k, start: p, moved: false, orig: originals() };
    if (k === 'p1' || k === 'p2') g.end = k === 'p1' ? 1 : 2;
    else {
      var u = G.union(sel);
      g.u = u;
      g.hx = k.indexOf('w') !== -1 ? u.x0 : k.indexOf('e') !== -1 ? u.x1 : null;
      g.hy = k.indexOf('n') !== -1 ? u.y0 : k.indexOf('s') !== -1 ? u.y1 : null;
      g.gx = g.hx === null ? 0 : p.x - g.hx;            /* where on the handle it was grabbed */
      g.gy = g.hy === null ? 0 : p.y - g.hy;
      g.ax = g.hx === null ? (u.x0 + u.x1) / 2 : (g.hx === u.x0 ? u.x1 : u.x0);
      g.ay = g.hy === null ? (u.y0 + u.y1) / 2 : (g.hy === u.y0 ? u.y1 : u.y0);
    }
    gesture = g;
  }
  function resizeMove(g, p, e) {
    if (!g.moved) {
      if (Math.abs(p.px - g.start.px) + Math.abs(p.py - g.start.py) < 2) return;
      g.moved = true; M.begin();
    }
    if (g.end) {
      putBack(g.orig, function (o) {
        var q = [p.x, p.y];
        if (e.shiftKey) q = g.end === 1 ? snapAngle(o.x2, o.y2, p.x, p.y) : snapAngle(o.x1, o.y1, p.x, p.y);
        if (g.end === 1) { o.x1 = G.r2(q[0]); o.y1 = G.r2(q[1]); } else { o.x2 = G.r2(q[0]); o.y2 = G.r2(q[1]); }
      });
      return;
    }
    var u = g.u, w0 = u.x1 - u.x0, h0 = u.y1 - u.y0, sx = 1, sy = 1, s;
    if (g.hx !== null && w0 > 0) sx = (p.x - g.gx - g.ax) / (g.hx - g.ax);
    if (g.hy !== null && h0 > 0) sy = (p.y - g.gy - g.ay) / (g.hy - g.ay);
    if (e.shiftKey) {
      if (g.hx !== null && g.hy !== null) { s = Math.max(Math.abs(sx), Math.abs(sy)); sx = (sx < 0 ? -s : s); sy = (sy < 0 ? -s : s); }
      else if (g.hx !== null) sy = Math.abs(sx);
      else sx = Math.abs(sy);
    }
    var mw = Math.min(0.5, w0), mh = Math.min(0.5, h0);
    if (w0 > 0 && Math.abs(sx) * w0 < mw) sx = (sx < 0 ? -1 : 1) * mw / w0;
    if (h0 > 0 && Math.abs(sy) * h0 < mh) sy = (sy < 0 ? -1 : 1) * mh / h0;
    putBack(g.orig, function (o) { G.transform(o, g.ax, g.ay, sx, sy, 0, 0); });
  }

  function moveMove(g, p, e) {
    if (!g.moved) {
      if (Math.abs(p.px - g.start.px) + Math.abs(p.py - g.start.py) < 3) return;
      g.moved = true; M.begin();
    }
    var dx = p.x - g.start.x, dy = p.y - g.start.y;
    if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
    putBack(g.orig, function (o) { G.translate(o, dx, dy); });
  }

  function marqueeMove(g, p) {
    if (!g.moved && Math.abs(p.px - g.start.px) + Math.abs(p.py - g.start.py) < CLICK_PX) return;
    g.moved = true;
    V.marquee = { x0: g.start.x, y0: g.start.y, x1: p.x, y1: p.y };
    var ids = V.inRect({ x0: Math.min(g.start.x, p.x), y0: Math.min(g.start.y, p.y), x1: Math.max(g.start.x, p.x), y1: Math.max(g.start.y, p.y) });
    var next = g.base.slice();
    /* a marquee that touches a grouped shape picks the whole group */
    ids.forEach(function (id) { M.unitOf(id).forEach(function (u) { if (next.indexOf(u) === -1) next.push(u); }); });
    M.select(next);
    V.invalidate();
  }

  function shapeMove(g, p, e) {
    var o = g.obj, a = g.start, x = p.x, y = p.y, q, s;
    if (g.shape === 'line') {
      if (e.shiftKey) { q = snapAngle(a.x, a.y, x, y); x = q[0]; y = q[1]; }
      o.x2 = G.r2(x); o.y2 = G.r2(y);
    } else {
      if (e.shiftKey) {                                   /* square / circle */
        s = Math.max(Math.abs(x - a.x), Math.abs(y - a.y));
        x = a.x + (x < a.x ? -s : s); y = a.y + (y < a.y ? -s : s);
      }
      var x0 = Math.min(a.x, x), y0 = Math.min(a.y, y), w = Math.abs(x - a.x), h = Math.abs(y - a.y);
      if (g.shape === 'rect') { o.x = G.r2(x0); o.y = G.r2(y0); o.w = G.r2(w); o.h = G.r2(h); }
      else { o.cx = G.r2(x0 + w / 2); o.cy = G.r2(y0 + h / 2); o.rx = G.r2(w / 2); o.ry = G.r2(h / 2); }
    }
    g.far = Math.abs(p.px - a.px) + Math.abs(p.py - a.py) >= CLICK_PX;
    V.invalidate();
  }
  function shapeEnd(g) {
    var o = g.obj, b = G.bbox(o), w = b.x1 - b.x0, h = b.y1 - b.y0;
    setDraft(null);
    var ok = g.far && (g.shape === 'line' ? G.dist(o.x1, o.y1, o.x2, o.y2) >= MIN_MM : (w >= 0.5 && h >= 0.5 && (w >= MIN_MM || h >= MIN_MM)));
    if (!ok) { hint(g.shape); return; }
    M.add(G.geomOf(o));
    say(M.TYPE_NAMES[o.type] + ' added, ' + Editor.Units.num(w) + ' by ' + Editor.Units.num(h) + ' ' + Editor.Units.word());
  }

  function penReach() { return Math.max(1.5, (V.coarse ? 14 : 9) / V.ppm()); }
  function penAdd(g, ev) {
    var p = V.toMm(ev.clientX, ev.clientY);
    if (Math.abs(p.px - g.lx) + Math.abs(p.py - g.ly) < 1.5) return;
    g.lx = p.px; g.ly = p.py;
    g.obj.pts.push([G.r2(p.x), G.r2(p.y)]);
  }
  function penCloses(pts) {
    var n = pts.length; if (n < 4) return false;
    var reach = penReach();
    return G.dist(pts[0][0], pts[0][1], pts[n - 1][0], pts[n - 1][1]) <= reach && G.pathLength(pts, false) > reach * 4;
  }
  function penMove(g, e) {
    var list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (list && list.length) list.forEach(function (ev) { penAdd(g, ev); }); else penAdd(g, e);
    g.obj.closed = penCloses(g.obj.pts);              /* shown filled while the end is back at the start */
    V.invalidate();
  }
  function penEnd(g) {
    var raw = g.obj.pts;
    setDraft(null);
    if (raw.length < 2 || G.pathLength(raw, false) < MIN_MM) { hint('pen'); return; }
    var closed = penCloses(raw);
    var pts = G.simplify(raw, Math.max(0.08, 0.6 / V.ppm()));
    if (closed && pts.length > 3) pts.pop();          /* the last point sits on the first */
    if (closed && pts.length < 3) closed = false;
    if (pts.length < 2) return;
    M.add({ type: 'pen', pts: pts, closed: closed });
    say(closed ? 'Closed stroke added' : 'Stroke added');
  }

  /* The eraser is a disc. Lines, strokes and outlines lose only the part under it; what is left
     becomes strokes of the same thread. A filled shape cannot lose a bite (that needs the fill to be
     cut), so pressing one without rubbing removes it whole, as before. */
  var MIN_PIECE_MM = 0.8;
  function eraserRadius() { return Math.max(0.8, (V.coarse ? 14 : 9) / V.ppm()); }
  function canRub(o) { return !G.isClosed(o) || M.paintOf(o) === 'line'; }
  function rubOnce(g, x, y, r) {
    var objs = M.doc.objects, out = null, i;
    for (i = 0; i < objs.length; i++) {
      var o = objs[i], b;
      if (canRub(o)) {
        b = G.bbox(o);
        if (x >= b.x0 - r && x <= b.x1 + r && y >= b.y0 - r && y <= b.y1 + r) {
          var left = [], hit = false;
          G.outlines(o).forEach(function (line) {
            var res = G.eraseLine(line.pts, line.closed, x, y, r, MIN_PIECE_MM);
            if (res === null) { left.push(line.closed && line.pts.length > 2 ? line.pts.concat([line.pts[0]]) : line.pts); return; }
            hit = true; res.forEach(function (piece) { left.push(piece); });
          });
          if (hit) {
            if (!out) out = objs.slice(0, i);
            left.forEach(function (pts) { if (pts.length > 1 && out.length < M.MAX_OBJECTS) out.push(M.strokePiece(o, pts)); });
            g.n++;
            continue;
          }
        }
      }
      if (out) out.push(o);
    }
    if (!out) return false;
    if (!g.moved) { g.moved = true; M.begin(); }
    M.doc.objects = out;
    var ids = {}; out.forEach(function (o) { ids[o.id] = 1; });
    M.selection = M.selection.filter(function (id) { return ids[id]; });
    return true;
  }
  function eraseAt(g, p) {
    var r = eraserRadius(), from = g.last || p, d = G.dist(from.x, from.y, p.x, p.y), steps = Math.max(1, Math.ceil(d / (r * 0.5))), any = false, i;
    g.travel = (g.travel || 0) + Math.abs(p.px - (g.lastPx || p.px)) + Math.abs(p.py - (g.lastPy || p.py));
    for (i = 1; i <= steps; i++) if (rubOnce(g, from.x + (p.x - from.x) * i / steps, from.y + (p.y - from.y) * i / steps, r)) any = true;
    g.last = { x: p.x, y: p.y }; g.lastPx = p.px; g.lastPy = p.py;
    V.eraser = { x: p.x, y: p.y, r: r };
    if (any) M.touch(); else V.invalidate();
  }
  /* A press that did not rub anything away: a filled shape under it is removed whole. */
  function eraseTap(g) {
    if (g.moved || (g.travel || 0) > 6 || !g.last) return false;
    var o = V.hit(g.last.x, g.last.y); if (!o) return false;
    return M.remove([o.id], 'Erase');
  }

  /* End the gesture. cancel = true puts the document back as it was. */
  function endGesture(cancel) {
    var g = gesture; if (!g) return;
    gesture = null;
    try { if (g.pid != null && el.canvas.hasPointerCapture && el.canvas.hasPointerCapture(g.pid)) el.canvas.releasePointerCapture(g.pid); } catch (e) { /* already released */ }
    el.view.classList.remove('is-panning');
    switch (g.type) {
      case 'move': case 'resize':
        if (!g.moved) { if (!cancel && g.collapse) M.select(g.collapse); break; }
        if (cancel) M.cancel(); else M.end(g.type === 'move' ? 'Move' : (g.end ? 'Reshape line' : 'Resize'));
        break;
      case 'marquee':
        V.marquee = null; V.invalidate();
        if (cancel) M.select(g.before); else if (!g.moved && !g.add) M.select([]);
        break;
      case 'trace':
        if (cancel) { if (g.moved && Editor.Trace) Editor.Trace.moveTo(g.x, g.y); }
        else if (g.moved) { if (Editor.Trace) Editor.Trace.save(); }
        else if (g.had) M.select([]);                       /* a click on the picture clears the selection */
        break;
      case 'shape': if (cancel) setDraft(null); else shapeEnd(g); break;
      case 'pen': if (cancel) setDraft(null); else penEnd(g); break;
      case 'erase':
        V.eraser = null; V.invalidate();
        if (!g.moved) { if (!cancel && eraseTap(g)) say('Shape erased'); break; }
        if (cancel) M.cancel();
        else if (M.end('Erase')) say('Erased');
        break;
      case 'polypoint':
        if (cancel && g.added && poly) { poly.pts.pop(); if (!poly.pts.length) { poly = null; setDraft(null); } else polyDraft(null); }
        break;
      case 'lasso': if (cancel) setDraft(null); else lassoEnd(g); break;
      case 'lassopoint':
        if (cancel && g.added && lasso) { lasso.pts.pop(); if (!lasso.pts.length) { lasso = null; setDraft(null); } else lassoDraft(null); }
        break;
    }
  }
  T.cancel = function () { endGesture(true); };

  /* ---------- pointer events ---------------------------------------------------------- */
  /* Two fingers: where they are now (view px) and how far apart. */
  function pinchState() {
    var ids = Object.keys(touches); if (ids.length < 2) return null;
    var a = touches[ids[0]], b = touches[ids[1]], r = el.view.getBoundingClientRect();
    return { d: Math.max(8, G.dist(a.x, a.y, b.x, b.y)), cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top };
  }
  /* A pinch is anchored: the millimetre that was under the midpoint when the second
     finger landed stays under the midpoint, and the zoom is the start zoom times how
     far the fingers have spread. Nothing is added up move by move, so the view cannot
     drift, and a finger that is lifted and put back somewhere else starts a new anchor
     instead of making the view jump. */
  function pinchAnchor() {
    var s = pinchState(); if (!s) return null;
    return { d: s.d, zoom: V.zoom, mx: (s.cx - V.ox) / V.ppm(), my: (s.cy - V.oy) / V.ppm() };
  }
  function movesTrace(p) {
    var t = V.trace;
    return !!(t && t.img && !t.locked && V.mode !== 'stitch' && V.traceAt(p.x, p.y));
  }

  function onDown(e) {
    if (e.pointerType === 'touch') {
      touches[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (count(touches) >= 2) {                         /* second finger: this is a pinch, not a drawing */
        e.preventDefault();
        if (gesture && gesture.type !== 'pinch') endGesture(true);
        if (!gesture) gesture = { type: 'pinch', pid: null };
        gesture.anchor = pinchAnchor();
        return;
      }
    }
    if (gesture) return;
    if (e.button !== 0 && e.button !== 1) return;         /* right button: nothing is drawn */
    e.preventDefault();
    /* phone: a press on the hoop while the sheet is open only puts the sheet away. The hoop
       re-fits as the sheet closes, so the press must not also draw at a spot that is moving. */
    if (Editor.closeSheet && Editor.closeSheet()) return;
    try { el.canvas.focus({ preventScroll: true }); } catch (x) { el.canvas.focus(); }
    var p = V.toMm(e.clientX, e.clientY), tool = T.current;
    if (e.button === 1 || tool === 'pan' || spaceDown) {
      gesture = { type: 'pan', pid: e.pointerId, x: e.clientX, y: e.clientY };
      el.view.classList.add('is-panning');
    } else if (tool === 'select') {
      var h = V.handleAt(p.px, p.py), o = h ? null : V.hit(p.x, p.y);
      if (h) startResize(h, p, e);
      else if (o) {
        var unit = pickUnit(o), was = unit.every(function (id) { return M.isSelected(id); });
        if (e.shiftKey) {
          var rest = M.selection.filter(function (id) { return unit.indexOf(id) === -1; });
          M.select(was ? rest : rest.concat(unit));
          gesture = { type: 'idle', pid: e.pointerId };
        } else {
          if (!was) M.select(unit);
          gesture = { type: 'move', pid: e.pointerId, start: p, moved: false, orig: originals(), collapse: was && M.selection.length > unit.length ? unit : null };
        }
      } else if (movesTrace(p) && !e.shiftKey) {
        /* the picture to trace is moved like a shape until it is locked */
        gesture = { type: 'trace', pid: e.pointerId, start: p, x: V.trace.x, y: V.trace.y, moved: false, had: M.selection.length };
      } else {
        gesture = { type: 'marquee', pid: e.pointerId, start: p, moved: false, add: e.shiftKey, before: M.selection.slice(), base: e.shiftKey ? M.selection.slice() : [] };
      }
    } else if (tool === 'pen') {
      var stroke = M.make({ type: 'pen', pts: [[p.x, p.y]], closed: false });
      gesture = { type: 'pen', pid: e.pointerId, obj: stroke, lx: p.px, ly: p.py };
      setDraft({ obj: stroke });
    } else if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
      var geom = tool === 'line' ? { type: 'line', x1: p.x, y1: p.y, x2: p.x, y2: p.y }
        : tool === 'rect' ? { type: 'rect', x: p.x, y: p.y, w: 0, h: 0 }
        : { type: 'ellipse', cx: p.x, cy: p.y, rx: 0, ry: 0 };
      gesture = { type: 'shape', pid: e.pointerId, shape: tool, start: p, obj: M.make(geom), far: false };
      setDraft({ obj: gesture.obj });
    } else if (tool === 'polygon') {
      polygonDown(p, e);
    } else if (tool === 'cut') {
      if (lasso) lassoClick(p, e);
      else { gesture = { type: 'lasso', pid: e.pointerId, start: p, pts: [[G.r2(p.x), G.r2(p.y)]], lx: p.px, ly: p.py, free: false }; }
    } else if (tool === 'eraser') {
      gesture = { type: 'erase', pid: e.pointerId, moved: false, n: 0, last: null };
      eraseAt(gesture, p);
    }
    if (gesture && gesture.pid != null) { try { el.canvas.setPointerCapture(e.pointerId); } catch (x) { /* synthetic pointer */ } }
  }

  function hover(p) {
    if (T.current !== 'select') { if (V.hoverId) { V.hoverId = null; V.invalidate(); } return; }
    var h = V.handleAt(p.px, p.py), o = h ? null : V.hit(p.x, p.y), cur = '';
    if (!h && !o && movesTrace(p)) cur = 'move';
    if (h) cur = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', p1: 'move', p2: 'move' }[h.k] || 'move';
    else if (o) cur = 'move';
    if (el.view.style.cursor !== cur) el.view.style.cursor = cur;
    var id = o ? o.id : null;
    if (id !== V.hoverId) { V.hoverId = id; V.invalidate(); }
  }

  function onMove(e) {
    if (e.pointerType === 'touch' && touches[e.pointerId]) { touches[e.pointerId].x = e.clientX; touches[e.pointerId].y = e.clientY; }
    var p = V.toMm(e.clientX, e.clientY), g = gesture;
    el.footX.textContent = Editor.Units.num(p.x); el.footY.textContent = Editor.Units.num(p.y);
    V.cursorAt(p.px, p.py);
    if (!g) {
      if (poly) { var c = [p.x, p.y]; if (e.shiftKey && poly.pts.length) c = snapAngle(poly.pts[poly.pts.length - 1][0], poly.pts[poly.pts.length - 1][1], p.x, p.y); polyDraft(c); }
      else if (lasso) lassoDraft([p.x, p.y]);
      else if (e.pointerType !== 'touch') hover(p);
      return;
    }
    if (g.type === 'pinch') {
      var now = pinchState(), a = g.anchor;
      if (now && a) V.setView(a.zoom * now.d / a.d, a.mx, a.my, now.cx, now.cy);
      return;
    }
    if (g.pid !== e.pointerId) return;
    switch (g.type) {
      case 'pan': V.panBy(e.clientX - g.x, e.clientY - g.y); g.x = e.clientX; g.y = e.clientY; break;
      case 'move': moveMove(g, p, e); break;
      case 'resize': resizeMove(g, p, e); break;
      case 'marquee': marqueeMove(g, p); break;
      case 'trace':
        if (!g.moved && Math.abs(p.px - g.start.px) + Math.abs(p.py - g.start.py) < 3) break;
        g.moved = true;
        if (Editor.Trace) Editor.Trace.moveTo(g.x + p.x - g.start.x, g.y + p.y - g.start.y);
        break;
      case 'shape': shapeMove(g, p, e); break;
      case 'pen': penMove(g, e); break;
      case 'erase': eraseAt(g, p); break;
      case 'lasso': lassoMove(g, p, e); break;
    }
  }

  function onUp(e) {
    if (e.pointerType === 'touch') delete touches[e.pointerId];
    var g = gesture; if (!g) return;
    if (g.type === 'pinch') {
      /* stay "in the pinch" until every finger is up, so a lifted finger draws nothing */
      if (!count(touches)) gesture = null; else g.anchor = pinchAnchor();
      return;
    }
    if (g.pid !== e.pointerId) return;
    if (g.type === 'pen') penMove(g, e);
    if (g.type === 'lasso' && g.free) lassoMove(g, V.toMm(e.clientX, e.clientY), e);
    endGesture(false);
    if (e.pointerType !== 'touch') hover(V.toMm(e.clientX, e.clientY));
  }
  function onCancel(e) {
    if (e.pointerType === 'touch') delete touches[e.pointerId];
    var g = gesture; if (!g) return;
    if (g.type === 'pinch') { if (!count(touches)) gesture = null; else g.anchor = pinchAnchor(); return; }
    if (g.pid === e.pointerId) endGesture(true);
  }

  function onDblClick(e) {
    if (T.current === 'select' && !gesture) {
      /* double-click a grouped shape: enter the group and pick just that shape */
      var p = V.toMm(e.clientX, e.clientY), o = V.hit(p.x, p.y);
      if (o && o.group && M.group(o.group)) {
        e.preventDefault();
        M.select([o.id]);
        say(o.name + ' selected in ' + M.group(o.group).name);
        return;
      }
    }
    if (T.current === 'cut' && lasso) {
      e.preventDefault();
      if (lasso.pts.length >= 3) finishLasso(true); else say('An outline needs at least 3 points');
      return;
    }
    if (T.current !== 'polygon' || !poly) return;
    e.preventDefault();
    if (poly.pts.length >= 3) finishPolygon(true);
    else { say('A polygon needs at least 3 points'); Editor.toast('A polygon needs at least 3 points. Keep clicking, or press Esc to cancel.', { label: 'Polygon', timeout: 3500 }); }
  }

  /* ---------- wheel ------------------------------------------------------------------- */
  function onWheel(e) {
    e.preventDefault();
    var r = el.canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    var dy = e.deltaY, dx = e.deltaX;
    if (e.deltaMode === 1) { dy *= 16; dx *= 16; } else if (e.deltaMode === 2) { dy *= 400; dx *= 400; }
    if (e.ctrlKey || e.metaKey) {                           /* trackpad pinch arrives as ctrl + wheel */
      V.setZoom(V.zoom * Math.exp(-G.clamp(dy, -60, 60) * 0.012), px, py);
      return;
    }
    /* A two-finger scroll on a trackpad reports wheelDelta = -3 x delta; a mouse wheel does not. */
    var trackpad = e.deltaMode === 0 && (typeof e.wheelDeltaY === 'number' ? (e.wheelDeltaY === -3 * e.deltaY && e.wheelDeltaX === -3 * e.deltaX) : (Math.abs(dy) < 50 || dx !== 0));
    if (trackpad || e.shiftKey) {
      if (e.shiftKey && !trackpad && !dx) { dx = dy; dy = 0; }
      V.panBy(-dx, -dy);
    } else {
      V.setZoom(V.zoom * Math.exp(-G.clamp(dy, -240, 240) * 0.0022), px, py);
    }
  }

  /* ---------- keys that belong to a tool (called by main.js) --------------------------- */
  /* Returns true when the key was used. */
  T.key = function (e) {
    var k = e.key;
    if (k === 'Escape') {
      if (gesture) { endGesture(true); return true; }
      if (poly) { finishPolygon(false); say('Polygon cancelled'); return true; }
      if (lasso) { finishLasso(false); say('Cut out cancelled'); return true; }
      var inside = M.insideGroup();                       /* inside a group: Esc steps out to the whole group */
      if (inside) { M.select(M.members(inside.id)); say(inside.name + ' selected'); return true; }
      if (M.selection.length) { M.select([]); return true; }
      return false;
    }
    if (poly) {
      if (k === 'Enter') {
        if (poly.pts.length >= 3) finishPolygon(true); else say('A polygon needs at least 3 points');
        return true;
      }
      if (k === 'Backspace' || k === 'Delete') { T.undoPoint(); return true; }
    }
    if (lasso) {
      if (k === 'Enter') { if (lasso.pts.length >= 3) finishLasso(true); else say('An outline needs at least 3 points'); return true; }
      if (k === 'Backspace' || k === 'Delete') { T.undoPoint(); return true; }
    }
    return false;
  };
  /* Take back the last polygon point (also what Undo does while placing points). */
  T.undoPoint = function () {
    if (lasso) {
      lasso.pts.pop();
      if (!lasso.pts.length) { lasso = null; setDraft(null); } else lassoDraft(null);
      return true;
    }
    if (!poly) return false;
    poly.pts.pop();
    if (!poly.pts.length) { poly = null; setDraft(null); } else polyDraft(null);
    return true;
  };
  T.space = function (down) {
    if (spaceDown === down) return;
    spaceDown = down;
    el.view.classList.toggle('is-pan-ready', down);
  };

  T.init = function () {
    el.view = document.getElementById('canvas-wrapper'); el.canvas = document.getElementById('main-canvas');
    el.footTool = document.getElementById('footer-tool'); el.footX = document.getElementById('footer-x'); el.footY = document.getElementById('footer-y');
    var c = el.canvas;
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointercancel', onCancel);
    c.addEventListener('lostpointercapture', function (e) { if (gesture && gesture.pid === e.pointerId) endGesture(true); });
    c.addEventListener('pointerleave', function () { if (!gesture && V.hoverId) { V.hoverId = null; V.invalidate(); } });
    c.addEventListener('dblclick', onDblClick);
    c.addEventListener('mousedown', function (e) { if (e.button === 1) e.preventDefault(); });      /* no auto-scroll puck */
    c.addEventListener('auxclick', function (e) { if (e.button === 1) e.preventDefault(); });
    el.view.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('blur', function () { T.space(false); });

    var btns = document.querySelectorAll('button[data-tool]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () { T.set(this.getAttribute('data-tool')); });
    }
    /* undo / redo / load while something is half drawn: drop the draft first */
    Editor.on('change', function (e) {
      var r = e && e.reason;
      if ((r === 'undo' || r === 'redo' || r === 'load') && (poly || lasso)) { poly = null; lasso = null; setDraft(null); }
    });
    T.set('select');
  };
})();
