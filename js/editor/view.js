/* ==========================================================================
   EMBROIDERY LABS - js/editor/view.js
   Everything that turns the document into pixels: the view transform (pan and
   zoom), the device-pixel-ratio canvas, the hoop element, rulers, the design
   and stitch-out renderings, the side preview, and hit testing.

   Screen px = mm * ppm + (ox, oy), measured from the top-left of the view.
   ppm (px per mm) = 4 * zoom, so 100% shows one millimetre as four CSS pixels.
   The main canvas covers the WHOLE view, not just the hoop, so a shape or a
   handle that pokes out of the hoop is never cropped.
   ========================================================================== */
(function () {
  'use strict';
  var Editor = window.Editor, G = Editor.Geom, M = Editor.Model;
  var BASE_PPM = 4, ZMIN = 0.1, ZMAX = 16;
  var ZSTEPS = [0.1, 0.15, 0.25, 0.33, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];
  var FABRIC_DARK = '#17191A';                 /* preset from the design system, section 11.4 */

  var V = Editor.View = {
    zoom: 1, ox: 0, oy: 0, w: 0, h: 0, dpr: 1,
    auto: true,              /* true until the visitor pans or zooms: then a resize re-fits */
    mode: 'design',          /* 'design' | 'stitch' */
    tool: 'select',
    hoverId: null,
    draft: null,             /* { obj } | { poly: { pts, cursor, canClose } } while drawing */
    marquee: null,           /* { x0, y0, x1, y1 } mm while rubber-banding */
    stitch: null,            /* { runs, jumps, bounds, count, jumpAt } from the engine */
    play: null,              /* { n }: stitch-out playback shows the first n stitches (null = all) */
    trace: null,             /* { img, x, y, w, h (mm), opacity 0..1, locked }: picture under the artwork */
    flags: {},               /* object id -> 'error' | 'warning' */
    fabric: { mode: 'light', color: '#c9b99a' },
    coarse: false
  };
  var el = {}, ctx = null, hitCtx = null, traceCtx = null, raf = 0;
  var pathCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  var colors = { ink: '#2B2D31', signal: '#3E78B2' };

  V.ppm = function () { return BASE_PPM * V.zoom; };
  V.toMm = function (clientX, clientY) {
    var r = el.canvas.getBoundingClientRect(), ppm = V.ppm();
    return { x: (clientX - r.left - V.ox) / ppm, y: (clientY - r.top - V.oy) / ppm, px: clientX - r.left, py: clientY - r.top };
  };
  V.toPx = function (x, y) { var ppm = V.ppm(); return { x: x * ppm + V.ox, y: y * ppm + V.oy }; };
  V.handleSize = function () { return V.coarse ? 11 : 7; };

  /* ---------- paths and hit testing ------------------------------------------ */
  function ruleOf(o) { return o.type === 'path' && o.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'; }
  function pathOf(o) {
    var p, pts, i;
    if (o.type === 'path') {
      /* imported shapes can have thousands of points: build the outline once per ring list
         (every edit replaces o.rings, see geom.js) */
      p = pathCache && pathCache.get(o.rings);
      if (p) return p;
      p = new Path2D();
      o.rings.forEach(function (r) {
        if (!r.length) return;
        p.moveTo(r[0][0], r[0][1]);
        for (i = 1; i < r.length; i++) p.lineTo(r[i][0], r[i][1]);
        p.closePath();
      });
      if (pathCache) pathCache.set(o.rings, p);
      return p;
    }
    p = new Path2D();
    switch (o.type) {
      case 'rect': p.rect(o.x, o.y, o.w, o.h); break;
      case 'ellipse': p.ellipse(o.cx, o.cy, o.rx, o.ry, 0, 0, Math.PI * 2); p.closePath(); break;
      case 'line': p.moveTo(o.x1, o.y1); p.lineTo(o.x2, o.y2); break;
      default:
        pts = o.pts;
        if (pts.length) {
          p.moveTo(pts[0][0], pts[0][1]);
          for (i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
          if (o.type === 'polygon' || o.closed) p.closePath();
        }
    }
    return p;
  }
  /* How wide the line is sewn, mm: a satin column has its width, a run is one thread. */
  function lineMm(o) { return o.lineType === 'satin' ? o.lineWidth : o.lineType === 'bean' ? 0.6 : 0.4; }

  /* Real geometry, not the bounding box: inside the fill, or within `tol` mm of
     the line as it is drawn. */
  function hitObject(o, x, y, tol) {
    var paint = M.paintOf(o), lw = paint === 'fill' ? 0 : lineMm(o), pad = lw / 2 + tol, b = G.bbox(o);
    if (x < b.x0 - pad || x > b.x1 + pad || y < b.y0 - pad || y > b.y1 + pad) return false;
    var p = pathOf(o);
    if (paint !== 'line' && hitCtx.isPointInPath(p, x, y, ruleOf(o))) return true;
    hitCtx.lineWidth = lw + tol * 2; hitCtx.lineJoin = 'round'; hitCtx.lineCap = 'round';
    return hitCtx.isPointInStroke(p, x, y);
  }
  V.tolerance = function () { return (V.coarse ? 10 : 4) / V.ppm(); };
  /* Topmost object under a point (mm), or null. Later in the list = sewn later = on top. */
  V.hit = function (x, y) {
    var objs = M.doc.objects, tol = V.tolerance();
    for (var i = objs.length - 1; i >= 0; i--) if (hitObject(objs[i], x, y, tol)) return objs[i];
    return null;
  };
  V.inRect = function (r) {
    return M.doc.objects.filter(function (o) { return G.rectsTouch(G.bbox(o), r); }).map(function (o) { return o.id; });
  };

  /* ---------- selection handles (screen px) ----------------------------------- */
  V.handles = function () {
    var sel = M.selected(); if (!sel.length || V.tool !== 'select') return [];
    if (sel.length === 1 && sel[0].type === 'line') {
      var a = V.toPx(sel[0].x1, sel[0].y1), b = V.toPx(sel[0].x2, sel[0].y2);
      return [{ k: 'p1', x: a.x, y: a.y }, { k: 'p2', x: b.x, y: b.y }];
    }
    var u = G.union(sel), p0 = V.toPx(u.x0, u.y0), p1 = V.toPx(u.x1, u.y1);
    var w = p1.x - p0.x, h = p1.y - p0.y, mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2, gap = V.handleSize() * 3, out = [];
    if (w < 1 && h < 1) return [];
    if (h < 1) return [{ k: 'w', x: p0.x, y: my }, { k: 'e', x: p1.x, y: my }];
    if (w < 1) return [{ k: 'n', x: mx, y: p0.y }, { k: 's', x: mx, y: p1.y }];
    out.push({ k: 'nw', x: p0.x, y: p0.y }, { k: 'ne', x: p1.x, y: p0.y }, { k: 'se', x: p1.x, y: p1.y }, { k: 'sw', x: p0.x, y: p1.y });
    if (w >= gap) out.push({ k: 'n', x: mx, y: p0.y }, { k: 's', x: mx, y: p1.y });
    if (h >= gap) out.push({ k: 'w', x: p0.x, y: my }, { k: 'e', x: p1.x, y: my });
    return out;
  };
  V.handleAt = function (px, py) {
    var list = V.handles(), reach = V.handleSize() / 2 + (V.coarse ? 8 : 3), best = null, bestD = Infinity;
    list.forEach(function (h) {
      var dx = Math.abs(px - h.x), dy = Math.abs(py - h.y);
      if (dx <= reach && dy <= reach && dx + dy < bestD) { bestD = dx + dy; best = h; }
    });
    return best;
  };

  /* ---------- view transform ---------------------------------------------------- */
  V.isPhone = function () { return getComputedStyle(el.sheet).position === 'fixed'; };
  /* How much of the bottom of the stage the phone sheet covers, px. A full sheet covers
     everything, so the hoop stays where it was under a peeking sheet. */
  V.sheetCover = function () {
    if (!V.isPhone()) return 0;
    var half = el.sheet.getAttribute('data-detent') === 'half';
    return half ? Math.min(Math.round(window.innerHeight * 0.46), Math.max(60, V.h - 150)) : 60;
  };
  function padding() {
    var st = V.mode === 'stitch';                       /* the playback bar sits along the top of the stage */
    if (!V.isPhone()) {
      var touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);   /* 44px controls take more room */
      return { l: 32, r: 32, t: st ? (touch ? 80 : 68) : 28, b: touch ? 62 : 44 };
    }
    return { l: 16, r: 16, t: st ? 122 : 60, b: V.sheetCover() + 56 };   /* phone: view switch on top; sheet and zoom buttons below */
  }
  function clampPan() {
    var ppm = V.ppm(), hw = M.doc.hoop.w * ppm, hh = M.doc.hoop.h * ppm, keep = 48;
    V.ox = Math.round(G.clamp(V.ox, keep - hw, Math.max(keep - hw, V.w - keep)));
    V.oy = Math.round(G.clamp(V.oy, keep - hh, Math.max(keep - hh, V.h - keep)));
  }
  /* Show the whole hoop, with its dimension line, as large as it will go. */
  V.fit = function () {
    if (!V.w || !V.h) return;
    var hoop = M.doc.hoop, p = padding();
    var aw = Math.max(40, V.w - p.l - p.r), ah = Math.max(40, V.h - p.t - p.b);
    var z = Math.min(aw / (hoop.w * BASE_PPM), ah / (hoop.h * BASE_PPM));
    V.zoom = G.clamp(Math.floor(z * 100) / 100, ZMIN, ZMAX);
    var ppm = V.ppm();
    V.ox = Math.round(p.l + (aw - hoop.w * ppm) / 2);
    V.oy = Math.round(p.t + (ah - hoop.h * ppm) / 2);
    V.auto = true;
    V.layout();
  };
  /* Zoom keeping the millimetre under (ax, ay) px where it is. */
  V.setZoom = function (z, ax, ay) {
    z = G.clamp(z, ZMIN, ZMAX);
    if (ax == null) { ax = V.w / 2; ay = V.h / 2; }
    var old = V.ppm(), mx = (ax - V.ox) / old, my = (ay - V.oy) / old;
    V.zoom = z;
    V.ox = ax - mx * V.ppm(); V.oy = ay - my * V.ppm();
    V.auto = false;
    clampPan(); V.layout();
  };
  V.zoomStep = function (dir) {
    var z = V.zoom, i;
    if (dir > 0) { for (i = 0; i < ZSTEPS.length; i++) if (ZSTEPS[i] > z * 1.01) return V.setZoom(ZSTEPS[i]); }
    else { for (i = ZSTEPS.length - 1; i >= 0; i--) if (ZSTEPS[i] < z * 0.99) return V.setZoom(ZSTEPS[i]); }
  };
  /* Zoom and place in one go (pinch): the millimetre (mx, my) sits under (px, py). */
  V.setView = function (z, mx, my, px, py) {
    V.zoom = G.clamp(z, ZMIN, ZMAX);
    V.ox = px - mx * V.ppm(); V.oy = py - my * V.ppm();
    V.auto = false;
    clampPan(); V.layout();
  };
  V.panBy = function (dx, dy) {
    V.ox += dx; V.oy += dy; V.auto = false;
    clampPan(); V.layout();
  };

  /* ---------- size ---------------------------------------------------------------- */
  V.resize = function () {
    var w = el.view.clientWidth, h = el.view.clientHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (!w || !h) return;
    var grew = { x: w - V.w, y: h - V.h }, first = !V.w;
    V.w = w; V.h = h; V.dpr = dpr;
    var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (el.canvas.width !== bw || el.canvas.height !== bh) { el.canvas.width = bw; el.canvas.height = bh; }
    if (el.trace.width !== bw || el.trace.height !== bh) { el.trace.width = bw; el.trace.height = bh; }
    if (V.auto || first) V.fit();
    else { V.ox += grew.x / 2; V.oy += grew.y / 2; clampPan(); V.layout(); }
  };

  /* ---------- rulers, hoop element, read-outs ------------------------------------- */
  /* step = distance between labels in display units, ppu = px per display unit */
  function labels(ruler, horizontal, origin, length, step, ppu) {
    var pool = ruler._labels || (ruler._labels = []), n = 0;
    var first = Math.ceil((-origin / ppu) / step - 1e-9), last = Math.floor(((length - origin) / ppu) / step + 1e-9);
    for (var i = first; i <= last && n < 400; i++) {
      var b = pool[n], v = i * step;
      if (!b) { b = document.createElement('b'); ruler.appendChild(b); pool.push(b); }
      var text = String(Math.round(v * 1000) / 1000);
      if (b._t !== text) { b.textContent = text; b._t = text; }
      b.style[horizontal ? 'left' : 'top'] = (origin + v * ppu + 3) + 'px';
      b.hidden = false;
      n++;
    }
    for (; n < pool.length; n++) pool[n].hidden = true;
  }
  /* Ruler scale for the current zoom: { ppu, step (label + long tick), tick (small tick) } in display units. */
  function rulerScale(ppm) {
    var U = Editor.Units, inches = U.get() === 'in', ppu = inches ? ppm * U.MM_PER_IN : ppm;
    var steps = inches ? [0.125, 0.25, 0.5, 1, 2, 5, 10, 20] : [1, 5, 10, 50, 100, 500];
    var step = steps[steps.length - 1], i;
    for (i = 0; i < steps.length; i++) if (steps[i] * ppu >= 34) { step = steps[i]; break; }
    var parts = inches ? [8, 4, 2, 1] : [10, 5, 2, 1], tick = step;
    for (i = 0; i < parts.length; i++) if (step / parts[i] * ppu >= 4) { tick = step / parts[i]; break; }
    return { ppu: ppu, step: step, tick: tick };
  }
  V.layout = function () {
    var ppm = V.ppm(), hoop = M.doc.hoop, hs = el.hoop.style;
    hs.width = (hoop.w * ppm) + 'px'; hs.height = (hoop.h * ppm) + 'px';
    hs.setProperty('--ox', V.ox + 'px'); hs.setProperty('--oy', V.oy + 'px');
    hs.setProperty('--vw', V.w + 'px'); hs.setProperty('--vh', V.h + 'px');
    /* rulers: a label and a long tick every `step`, small ticks every `tick`, in inches or millimetres */
    var U = Editor.Units, rs = rulerScale(ppm);
    [[el.rulerX, '--ox', V.ox], [el.rulerY, '--oy', V.oy]].forEach(function (r) {
      r[0].style.setProperty(r[1], r[2] + 'px');
      r[0].style.setProperty('--tick', (rs.tick * rs.ppu) + 'px');
      r[0].style.setProperty('--major', (rs.step * rs.ppu) + 'px');
    });
    if (el.rulerX.offsetParent !== null) {
      labels(el.rulerX, true, V.ox, V.w, rs.step, rs.ppu);
      labels(el.rulerY, false, V.oy, V.h, rs.step, rs.ppu);
    }
    el.zoomValue.textContent = Math.round(V.zoom * 100) + '%';
    var dim = U.sizeShort(hoop.w, hoop.h) + ' ' + U.label();
    if (el.info.textContent !== dim) {
      el.info.textContent = dim;
      el.canvas.setAttribute('aria-label', 'Design canvas, ' + U.short(hoop.w) + ' by ' + U.short(hoop.h) + ' ' + U.word() + ' hoop');
    }
    V.invalidate();
  };
  V.cursorAt = function (px, py) {
    el.cursorX.style.left = px + 'px'; el.cursorY.style.top = py + 'px';
  };

  /* ---------- fabric -------------------------------------------------------------- */
  /* The hoop is the garment, not the page: its colour is picked by the visitor and
     the marks drawn on it switch between a dark and a light set so that they stay
     visible (design system 11.4). */
  V.setFabric = function (mode, color) {
    if (mode !== 'light' && mode !== 'dark' && mode !== 'custom') mode = 'light';
    V.fabric = { mode: mode, color: G.hex(color) || V.fabric.color };
    V.applyFabric();
  };
  V.applyFabric = function () {
    var f = V.fabric, targets = [el.hoop, el.previewBox];
    var fixed = f.mode === 'dark' ? FABRIC_DARK : f.mode === 'custom' ? f.color : null;
    targets.forEach(function (t) { if (fixed) t.style.setProperty('--fabric', fixed); else t.style.removeProperty('--fabric'); });
    var resolved = G.cssToHex(fixed || window.EL.token('--fabric', el.hoop)) || '#fdfdfb';
    var dark = G.luminance(resolved) < 0.18;
    targets.forEach(function (t) {
      t.style.setProperty('--fabric-ink', dark ? '#E9E8E4' : '#2B2D31');
      t.style.setProperty('--fabric-signal', dark ? '#8DBBE6' : '#3E78B2');
    });
    colors.ink = G.cssToHex(window.EL.token('--fabric-ink', el.hoop)) || '#2B2D31';
    colors.signal = G.cssToHex(window.EL.token('--fabric-signal', el.hoop)) || '#3E78B2';
    V.fabricHex = resolved;
    V.invalidate(); V.drawPreview();
  };

  /* ---------- drawing ------------------------------------------------------------- */
  V.invalidate = function () { if (!raf) raf = requestAnimationFrame(draw); };

  function drawGrid(c, ppm, hoop) {
    var x0 = Math.max(0, V.ox), y0 = Math.max(0, V.oy), x1 = Math.min(V.w, V.ox + hoop.w * ppm), y1 = Math.min(V.h, V.oy + hoop.h * ppm);
    if (x1 <= x0 || y1 <= y0) return;
    c.save();
    c.beginPath(); c.rect(V.ox, V.oy, hoop.w * ppm, hoop.h * ppm); c.clip();
    function dots(stepMm, size, alpha) {
      var stepPx = stepMm * ppm;
      var i0 = Math.ceil((x0 - V.ox) / stepPx - 1e-6), j0 = Math.ceil((y0 - V.oy) / stepPx - 1e-6);
      var j1 = Math.floor((y1 - V.oy) / stepPx + 1e-6), sx = V.ox + i0 * stepPx - size / 2;
      c.beginPath();
      for (var j = j0; j <= j1; j++) { var y = V.oy + j * stepPx; c.moveTo(sx, y); c.lineTo(x1 + size, y); }
      c.setLineDash([size, stepPx - size]); c.lineWidth = size; c.strokeStyle = G.rgba(colors.ink, alpha); c.stroke();
    }
    /* the dot grid is off unless the visitor asks for it (Hoop > Show grid); it follows the display unit */
    if (Editor.Prefs.grid()) {
      if (Editor.Units.get() === 'in') {
        var inch = Editor.Units.MM_PER_IN;
        var fine = [inch / 8, inch / 4, inch / 2].filter(function (s) { return s * ppm >= 7; })[0];
        if (fine) dots(fine, 1, 0.14);
        dots(inch, inch * ppm >= 24 ? 2 : 1, 0.28);
      } else {
        var minor = [1, 2, 5].filter(function (s) { return s * ppm >= 7; })[0];
        var major = 10 * ppm >= 7 ? 10 : 50;
        if (minor && major === 10) dots(minor, 1, 0.14);
        dots(major, major === 10 && ppm >= 3 ? 2 : 1, 0.28);
      }
    }
    /* centre mark: where the machine starts */
    var cx = Math.round(V.ox + hoop.w * ppm / 2) + 0.5, cy = Math.round(V.oy + hoop.h * ppm / 2) + 0.5;
    c.setLineDash([]); c.lineWidth = 1; c.strokeStyle = G.rgba(colors.ink, 0.3);
    c.beginPath(); c.moveTo(cx - 6, cy); c.lineTo(cx + 6, cy); c.moveTo(cx, cy - 6); c.lineTo(cx, cy + 6); c.stroke();
    c.restore();
  }

  /* The design view shows what will be sewn: the fill in the thread colour, a satin
     line at its real width, a running or bean line as a thread. */
  function drawObject(c, o, ppm) {
    var p = pathOf(o), paint = M.paintOf(o);
    if (paint !== 'line') { c.fillStyle = o.color; c.fill(p, ruleOf(o)); }
    if (paint !== 'fill') {
      c.lineWidth = Math.max(lineMm(o), 1.5 / ppm);
      c.lineJoin = 'round'; c.lineCap = o.lineType === 'satin' ? 'butt' : 'round';
      c.strokeStyle = paint === 'both' ? G.shade(o.color) : o.color;
      c.stroke(p);
    }
  }
  function drawStitches(c, ppm) {
    var st = V.stitch; if (!st) return;
    var i, k, pts, n, take, shown = 0, limit = V.play ? V.play.n : Infinity, needle = null;
    c.lineJoin = 'round'; c.lineCap = 'round';
    if (st.jumps.length) {
      c.beginPath();
      for (i = 0; i < st.jumps.length; i++) {
        if (st.jumpAt[i] >= limit) continue;                 /* the needle has not travelled there yet */
        c.moveTo(st.jumps[i].x1, st.jumps[i].y1); c.lineTo(st.jumps[i].x2, st.jumps[i].y2);
      }
      c.lineWidth = 1 / ppm; c.setLineDash([3 / ppm, 3 / ppm]); c.strokeStyle = G.rgba(colors.ink, 0.28); c.stroke(); c.setLineDash([]);
    }
    c.lineWidth = G.clamp(0.22 * ppm, 1, 3) / ppm;
    for (i = 0; i < st.runs.length && shown < limit; i++) {
      pts = st.runs[i].points; n = pts.length / 2; take = Math.min(n, limit - shown); shown += take;
      if (take < 1) break;
      needle = [pts[take * 2 - 2], pts[take * 2 - 1]];
      if (take < 2) continue;
      c.beginPath(); c.moveTo(pts[0], pts[1]);
      for (k = 2; k < take * 2; k += 2) c.lineTo(pts[k], pts[k + 1]);
      c.strokeStyle = st.runs[i].color; c.stroke();
    }
    /* needle points, once they are far enough apart to read */
    if (ppm >= 8 && st.count < 120000) {
      var d = (ppm >= 20 ? 2 : 1) / ppm, vx0 = -V.ox / ppm, vy0 = -V.oy / ppm, vx1 = (V.w - V.ox) / ppm, vy1 = (V.h - V.oy) / ppm;
      c.fillStyle = G.rgba(colors.ink, 0.4);
      for (i = 0, shown = 0; i < st.runs.length && shown < limit; i++) {
        pts = st.runs[i].points; take = Math.min(pts.length / 2, limit - shown); shown += take;
        for (k = 0; k < take * 2; k += 2) {
          if (pts[k] < vx0 || pts[k] > vx1 || pts[k + 1] < vy0 || pts[k + 1] > vy1) continue;
          c.fillRect(pts[k] - d / 2, pts[k + 1] - d / 2, d, d);
        }
      }
    }
    V.needle = V.play && V.play.n < st.count ? needle : null;   /* where the needle is now, mm */
  }
  /* The trace picture: its own canvas under the artwork, clipped to the hoop, never exported. */
  function drawTrace() {
    var c = traceCtx; if (!c) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, el.trace.width, el.trace.height);
    var t = V.trace; if (!t || !t.img || V.mode === 'stitch') return;
    var dpr = V.dpr, ppm = V.ppm(), hoop = M.doc.hoop;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.save();
    c.beginPath(); c.rect(V.ox, V.oy, hoop.w * ppm, hoop.h * ppm); c.clip();
    c.globalAlpha = G.clamp(t.opacity, 0, 1); c.imageSmoothingQuality = 'high';
    try { c.drawImage(t.img, V.ox + t.x * ppm, V.oy + t.y * ppm, t.w * ppm, t.h * ppm); } catch (e) { /* a broken picture draws nothing */ }
    c.restore();
  }
  V.traceAt = function (x, y) { var t = V.trace; return !!(t && t.img && x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h); };
  function drawDraft(c, ppm) {
    var d = V.draft, i;
    if (d.lasso) {
      /* the cut-out outline: a soft tint inside, a dashed edge, closed back to the start */
      var lp = d.lasso.pts, lc = d.lasso.cursor;
      if (lp.length) {
        c.beginPath(); c.moveTo(lp[0][0], lp[0][1]);
        for (i = 1; i < lp.length; i++) c.lineTo(lp[i][0], lp[i][1]);
        if (lc) c.lineTo(lc[0], lc[1]);
        c.closePath();
        c.fillStyle = G.rgba(colors.signal, 0.1); c.fill();
        c.lineJoin = 'round'; c.lineCap = 'round';
        c.lineWidth = 1.5 / ppm; c.setLineDash([5 / ppm, 4 / ppm]); c.strokeStyle = colors.signal; c.stroke(); c.setLineDash([]);
      }
      if (d.lasso.marks) {
        for (i = 0; i < lp.length; i++) {
          var lbig = i === 0 && d.lasso.canClose, ls = (lbig ? 9 : 5) / ppm;
          c.fillStyle = colors.signal; c.fillRect(lp[i][0] - ls / 2, lp[i][1] - ls / 2, ls, ls);
          c.lineWidth = 1 / ppm; c.strokeStyle = colors.ink; c.strokeRect(lp[i][0] - ls / 2, lp[i][1] - ls / 2, ls, ls);
        }
      }
    }
    if (d.obj) { c.globalAlpha = 0.85; drawObject(c, d.obj, ppm); c.globalAlpha = 1; c.lineWidth = 1 / ppm; c.strokeStyle = colors.signal; c.setLineDash([]); c.stroke(pathOf(d.obj)); }
    if (d.poly) {
      var pts = d.poly.pts, cur = d.poly.cursor;
      c.lineJoin = 'round'; c.lineCap = 'round';
      if (pts.length > 1) {
        c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
        for (i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
        c.lineWidth = 1.5 / ppm; c.strokeStyle = M.defaults.color; c.stroke();
      }
      if (cur && pts.length) {
        c.beginPath(); c.moveTo(pts[pts.length - 1][0], pts[pts.length - 1][1]); c.lineTo(cur[0], cur[1]);
        if (pts.length > 1) c.lineTo(pts[0][0], pts[0][1]);
        c.lineWidth = 1 / ppm; c.setLineDash([4 / ppm, 3 / ppm]); c.strokeStyle = colors.signal; c.stroke(); c.setLineDash([]);
      }
      for (i = 0; i < pts.length; i++) {
        var big = i === 0 && d.poly.canClose, s = (big ? 9 : 5) / ppm;
        c.fillStyle = colors.signal; c.fillRect(pts[i][0] - s / 2, pts[i][1] - s / 2, s, s);
        c.lineWidth = 1 / ppm; c.strokeStyle = colors.ink; c.strokeRect(pts[i][0] - s / 2, pts[i][1] - s / 2, s, s);
      }
    }
  }
  function drawOverlays(c, ppm) {
    var dpr = V.dpr, sel = M.selected(), i, o, b, p0, p1;
    function mm() { c.setTransform(dpr * ppm, 0, 0, dpr * ppm, dpr * V.ox, dpr * V.oy); }
    function px() { c.setTransform(dpr, 0, 0, dpr, 0, 0); }
    function box(bb, grow) {
      p0 = V.toPx(bb.x0, bb.y0); p1 = V.toPx(bb.x1, bb.y1);
      var x = Math.round(p0.x) - grow + 0.5, y = Math.round(p0.y) - grow + 0.5;
      c.strokeRect(x, y, Math.round(p1.x) - Math.round(p0.x) + grow * 2, Math.round(p1.y) - Math.round(p0.y) + grow * 2);
    }
    c.lineJoin = 'miter'; c.lineCap = 'butt'; c.setLineDash([]);
    /* a trace picture that can still be moved: thin dashed frame */
    if (V.trace && V.trace.img && !V.trace.locked && V.mode !== 'stitch' && V.tool === 'select') {
      px(); c.lineWidth = 1; c.strokeStyle = G.rgba(colors.ink, 0.45); c.setLineDash([2, 3]);
      box({ x0: V.trace.x, y0: V.trace.y, x1: V.trace.x + V.trace.w, y1: V.trace.y + V.trace.h }, 0);
      c.setLineDash([]);
    }
    /* stitch-out playback: where the needle is */
    if (V.mode === 'stitch' && V.needle) {
      px(); p0 = V.toPx(V.needle[0], V.needle[1]);
      var nx = Math.round(p0.x) + 0.5, ny = Math.round(p0.y) + 0.5;
      c.lineWidth = 1; c.strokeStyle = colors.ink;
      c.beginPath(); c.moveTo(nx - 12, ny); c.lineTo(nx + 12, ny); c.moveTo(nx, ny - 12); c.lineTo(nx, ny + 12); c.stroke();
      c.fillStyle = colors.signal; c.fillRect(nx - 4.5, ny - 4.5, 9, 9); c.strokeRect(nx - 4.5, ny - 4.5, 9, 9);
    }
    /* objects the engine refused (outside the hoop): dashed box */
    px(); c.lineWidth = 1; c.strokeStyle = colors.signal; c.setLineDash([5, 3]);
    for (i = 0; i < M.doc.objects.length; i++) {
      o = M.doc.objects[i];
      if (V.flags[o.id] === 'error') box(G.bbox(o), 4);
    }
    c.setLineDash([]);
    /* hover */
    if (V.hoverId && V.tool === 'select' && !M.isSelected(V.hoverId) && (o = M.get(V.hoverId))) {
      mm(); c.lineWidth = 1.5 / ppm; c.strokeStyle = colors.signal; c.globalAlpha = 0.75; c.stroke(pathOf(o)); c.globalAlpha = 1;
    }
    if (sel.length) {
      mm(); c.lineWidth = 1 / ppm; c.strokeStyle = colors.signal;
      for (i = 0; i < sel.length; i++) c.stroke(pathOf(sel[i]));
      px(); c.lineWidth = 1; c.strokeStyle = colors.signal;
      if (!(sel.length === 1 && sel[0].type === 'line')) box(G.union(sel), 0);
      var hs = V.handleSize(), list = V.handles();
      for (i = 0; i < list.length; i++) {
        var hx = Math.round(list[i].x - hs / 2) + 0.5, hy = Math.round(list[i].y - hs / 2) + 0.5;
        c.fillStyle = colors.signal; c.fillRect(hx, hy, hs, hs);
        c.strokeStyle = colors.ink; c.strokeRect(hx, hy, hs, hs);
      }
    }
    if (V.eraser) {
      px();
      var er = V.eraser, ex = V.ox + er.x * ppm, ey = V.oy + er.y * ppm;
      c.setLineDash([]); c.lineWidth = 1.5; c.strokeStyle = G.rgba(colors.signal, 0.9); c.fillStyle = G.rgba(colors.signal, 0.10);
      c.beginPath(); c.arc(ex, ey, er.r * ppm, 0, Math.PI * 2); c.fill(); c.stroke();
    }
    if (V.marquee) {
      px(); b = V.marquee;
      c.fillStyle = G.rgba(colors.signal, 0.08); c.strokeStyle = colors.signal; c.lineWidth = 1; c.setLineDash([4, 3]);
      p0 = V.toPx(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1)); p1 = V.toPx(Math.max(b.x0, b.x1), Math.max(b.y0, b.y1));
      c.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      c.strokeRect(Math.round(p0.x) + 0.5, Math.round(p0.y) + 0.5, Math.round(p1.x - p0.x), Math.round(p1.y - p0.y));
      c.setLineDash([]);
    }
  }
  function draw() {
    raf = 0;
    if (!ctx || !V.w) return;
    /* the window moved to a screen with another pixel density: a new backing store, then draw */
    if (Math.min(window.devicePixelRatio || 1, 3) !== V.dpr) V.resize();
    var c = ctx, dpr = V.dpr, ppm = V.ppm(), objs = M.doc.objects, i;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, el.canvas.width, el.canvas.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTrace();
    drawGrid(c, ppm, M.doc.hoop);
    c.setTransform(dpr * ppm, 0, 0, dpr * ppm, dpr * V.ox, dpr * V.oy);
    c.setLineDash([]);
    V.needle = null;
    if (V.mode === 'stitch') drawStitches(c, ppm);
    else for (i = 0; i < objs.length; i++) drawObject(c, objs[i], ppm);
    if (V.draft) drawDraft(c, ppm);
    drawOverlays(c, ppm);
    V.frames = (V.frames || 0) + 1;
  }
  V.drawNow = function () { if (raf) { cancelAnimationFrame(raf); raf = 0; } draw(); };

  /* ---------- stitch data + side preview ------------------------------------------- */
  V.setStitch = function (preview, bounds) {
    var atEnd = !V.play || !V.stitch || V.play.n >= V.stitch.count;
    if (!preview) { V.stitch = null; }
    else {
      var count = 0, ends = [], r = 0;
      preview.runs.forEach(function (run) { count += run.points.length / 2; ends.push(count); });
      /* a jump leaves from the last stitch of a run: it is shown once that run is sewn */
      var jumpAt = preview.jumps.map(function (j) {
        for (var k = r; k < preview.runs.length; k++) {
          var p = preview.runs[k].points, n = p.length;
          if (n >= 2 && Math.abs(p[n - 2] - j.x1) < 0.06 && Math.abs(p[n - 1] - j.y1) < 0.06) { r = k; break; }
        }
        return ends[r] || 0;
      });
      V.stitch = { runs: preview.runs, jumps: preview.jumps, bounds: bounds || null, count: count, ends: ends, jumpAt: jumpAt };
    }
    /* playback: stay at the end when it was there, else keep the place if it still exists */
    var total = V.stitch ? V.stitch.count : 0;
    V.play = { n: atEnd ? total : Math.min(V.play.n, total) };
    V.invalidate(); V.drawPreview();
    Editor.emit('play');
  };
  V.setPlay = function (n) {
    var total = V.stitch ? V.stitch.count : 0;
    n = Math.round(G.clamp(Number(n) || 0, 0, total));
    if (V.play && V.play.n === n) return;
    V.play = { n: n };
    V.invalidate();
    Editor.emit('play');
  };
  V.setTrace = function (t) { V.trace = t || null; V.invalidate(); };
  /* Thumbnail: the design (not the hoop) fitted into the square, in thread colours. */
  V.drawPreview = function () {
    var cv = el.preview; if (!cv) return;
    var c = cv.getContext('2d'), S = cv.width, st = V.stitch, i, k, pts;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, S, cv.height);
    if (!st || !st.bounds || !st.runs.length) return;
    var b = st.bounds, pad = 40;
    var s = Math.min((S - pad * 2) / Math.max(b.width, 0.5), (S - pad * 2) / Math.max(b.height, 0.5), 48);
    c.setTransform(s, 0, 0, s, S / 2 - (b.minX + b.width / 2) * s, S / 2 - (b.minY + b.height / 2) * s);
    c.lineJoin = 'round'; c.lineCap = 'round';
    if (st.jumps.length) {
      c.beginPath();
      for (i = 0; i < st.jumps.length; i++) { c.moveTo(st.jumps[i].x1, st.jumps[i].y1); c.lineTo(st.jumps[i].x2, st.jumps[i].y2); }
      c.lineWidth = 1.5 / s; c.setLineDash([6 / s, 6 / s]); c.strokeStyle = G.rgba(colors.ink, 0.25); c.stroke(); c.setLineDash([]);
    }
    c.lineWidth = G.clamp(0.3 * s, 1.6, 6) / s;
    for (i = 0; i < st.runs.length; i++) {
      pts = st.runs[i].points; if (pts.length < 4) continue;
      c.beginPath(); c.moveTo(pts[0], pts[1]);
      for (k = 2; k < pts.length; k += 2) c.lineTo(pts[k], pts[k + 1]);
      c.strokeStyle = st.runs[i].color; c.stroke();
    }
  };

  V.setMode = function (mode) {
    mode = mode === 'stitch' ? 'stitch' : 'design';
    if (mode === V.mode) return;
    V.mode = mode;
    if (V.auto) V.fit(); else V.invalidate();     /* a phone makes room for the playback bar */
    Editor.emit('viewmode');
  };

  /* ---------- start ---------------------------------------------------------------- */
  V.init = function () {
    function $(id) { return document.getElementById(id); }
    el.view = $('canvas-wrapper'); el.hoop = $('hoop'); el.canvas = $('main-canvas'); el.info = $('canvas-info');
    el.rulerX = $('ruler-x'); el.rulerY = $('ruler-y'); el.zoomValue = $('zoom-value'); el.sheet = $('sheet');
    el.preview = $('preview-canvas'); el.previewBox = el.preview.parentNode;
    el.cursorX = el.rulerX.querySelector('.cursor'); el.cursorY = el.rulerY.querySelector('.cursor');
    V.el = el;
    el.trace = $('trace-canvas'); traceCtx = el.trace.getContext('2d');
    ctx = el.canvas.getContext('2d');
    hitCtx = document.createElement('canvas').getContext('2d');
    var mq = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;
    V.coarse = !!(mq && mq.matches);
    if (mq && mq.addEventListener) mq.addEventListener('change', function (e) { V.coarse = e.matches; V.invalidate(); });
    el.view.setAttribute('data-live', '');          /* CSS: the hoop is now placed by --ox / --oy */
    V.applyFabric();
    V.resize();
    if (window.ResizeObserver) new ResizeObserver(function () { V.resize(); }).observe(el.view);
    window.addEventListener('resize', function () { V.resize(); });
    document.addEventListener('el:themechange', function () { V.applyFabric(); });
    Editor.on('change', function (e) {
      if (e && (e.reason === 'Change hoop' || e.reason === 'load' || e.reason === 'undo' || e.reason === 'redo')) {
        var key = M.doc.hoop.w + 'x' + M.doc.hoop.h;
        if (key !== V._hoopKey) { V._hoopKey = key; V.fit(); return; }
      }
      V.invalidate();
    });
    V._hoopKey = M.doc.hoop.w + 'x' + M.doc.hoop.h;
    Editor.on('selection', V.invalidate);
    Editor.on('defaults', V.invalidate);
    Editor.on('units', function () { V.layout(); });
    Editor.on('prefs', V.invalidate);
  };
})();
