/* EMBROIDERY LABS - js/hero.js (index.html only)
   The hero show: a starter design (the bee) draws itself as outlines, then sews stitch by stitch in the hoop,
   then the finished thread picture fades in and the hoodie it ends up on lifts. Draw -> stitch -> wear.

   - Runs only when <html> has the class "motion" (set in the head when prefers-reduced-motion is not "reduce").
     Without it, or without JS, or if anything fails, the hoop shows the finished picture (designs/home/bee-stitched.webp).
   - Starts after the page has loaded and is idle, and only once the hoop is on screen. Loads designs/bee.embroidr
     and runs the real engine in a Web Worker (js/engine/worker.js), so nothing heavy touches the first paint.
   - The canvas maps the design the same way the still picture does (fitted to 96% of a square, centred), so the
     cross-fade at the end lines up. */
(function () {
  'use strict';
  var DESIGN = 'designs/bee.embroidr', WORKER = 'js/engine/worker.js';
  var DRAW_MS = 1500, STITCH_MS = 6500, FIT = 0.96;
  var root = document.documentElement, show = document.getElementById('show');
  if (!show) return;
  var canvas = show.querySelector('.hoop__canvas'), cloth = show.querySelector('.hoop__cloth');
  var countEl = document.getElementById('show-count'), replay = document.getElementById('show-replay');
  var data = null, raf = 0, started = false;

  function still() { cancelAnimationFrame(raf); show.classList.remove('is-anim'); show.classList.add('is-still'); show.setAttribute('data-phase', 'idle'); }
  function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
  if (!root.classList.contains('motion') || !canvas || !canvas.getContext || !window.Worker || !window.fetch) { still(); return; }

  /* ---------- the design: editor document -> engine input (as Editor.Model.toEngine does) ---------- */
  function isClosed(o) { return o.type === 'rect' || o.type === 'ellipse' || o.type === 'polygon' || o.type === 'path' || (o.type === 'pen' && !!o.closed); }
  function toEngine(doc) {
    return { name: doc.name, hoop: { width: doc.hoop.w, height: doc.hoop.h }, objects: doc.objects.map(function (o) {
      var e = { id: o.id, color: o.color, paint: isClosed(o) ? o.paint : 'line',
        fill: { spacing: o.spacing, stitchLength: o.stitchLen, angle: o.angle, pattern: o.pattern || 'smooth' },
        line: { type: o.lineType, stitchLength: o.stitchLen, width: o.lineWidth, spacing: o.spacing } };
      if (o.fillStyle === 'lineart') { e.fill.style = 'lineart'; e.fill.lineart = { detail: o.lineDetail || 'normal' }; }
      if (o.underlay === false) e.fill.underlay = false;
      switch (o.type) {
        case 'rect': e.type = 'rect'; e.x = o.x; e.y = o.y; e.width = o.w; e.height = o.h; break;
        case 'ellipse': e.type = 'ellipse'; e.cx = o.cx; e.cy = o.cy; e.rx = o.rx; e.ry = o.ry; break;
        case 'line': e.type = 'line'; e.x1 = o.x1; e.y1 = o.y1; e.x2 = o.x2; e.y2 = o.y2; break;
        case 'polygon': e.type = 'polygon'; e.points = o.pts; break;
        case 'path': e.type = 'path'; e.rings = o.rings; e.fillRule = o.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'; break;
        default: e.type = 'polyline'; e.points = o.pts; e.closed = !!o.closed;
      }
      return e;
    }) };
  }
  /* Outlines of every shape, as point lists in mm (what "Draw" shows). */
  function outlines(doc) {
    var out = [];
    doc.objects.forEach(function (o) {
      var i, pts;
      if (o.type === 'rect') out.push({ pts: [[o.x, o.y], [o.x + o.w, o.y], [o.x + o.w, o.y + o.h], [o.x, o.y + o.h]], closed: true });
      else if (o.type === 'ellipse') { pts = []; for (i = 0; i < 48; i++) pts.push([o.cx + o.rx * Math.cos(i / 48 * 2 * Math.PI), o.cy + o.ry * Math.sin(i / 48 * 2 * Math.PI)]); out.push({ pts: pts, closed: true }); }
      else if (o.type === 'line') out.push({ pts: [[o.x1, o.y1], [o.x2, o.y2]], closed: false });
      else if (o.type === 'path' && Array.isArray(o.rings)) o.rings.forEach(function (r) { var p = Array.isArray(r) ? r : r && r.points; if (p && p.length > 1) out.push({ pts: p, closed: true }); });
      else if (Array.isArray(o.pts) && o.pts.length > 1) out.push({ pts: o.pts, closed: o.type === 'polygon' || !!o.closed });
    });
    return out;
  }
  /* Engine result -> flat segment list (0.1 mm, IR origin) with a thread index each, plus the bounding box. */
  function segments(result) {
    var ir = result.ir, c = ir.commands, n = c.length / 3, seg = new Float32Array(n * 4), col = new Uint16Array(n), k = 0, thread = 0;
    var px = null, py = null, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i + 2 < c.length; i += 3) {
      var op = c[i], x = c[i + 1], y = c[i + 2];
      if (op === 0) {
        if (px !== null && (px !== x || py !== y)) { seg[k * 4] = px; seg[k * 4 + 1] = py; seg[k * 4 + 2] = x; seg[k * 4 + 3] = y; col[k] = thread; k++; }
        px = x; py = y;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      } else { px = py = null; if (op === 3) thread++; else if (op === 4) break; }
    }
    return { seg: seg, col: col, n: k, colors: (ir.threads || []).map(function (t) { return t && t.color || '#2b2d31'; }),
      box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, ox: Math.round(ir.hoop.w / 2), oy: Math.round(ir.hoop.h / 2),
      stitches: result.totals && result.totals.stitches || k };
  }

  /* ---------- loading: the design file, then the engine in a worker ---------- */
  function load() {
    return fetch(DESIGN).then(function (r) { if (!r.ok) throw new Error('design'); return r.json(); }).then(function (file) {
      var doc = file && (file.doc || file);
      if (!doc || !doc.hoop || !Array.isArray(doc.objects)) throw new Error('design');
      return new Promise(function (resolve, reject) {
        var w, timer = setTimeout(function () { try { w.terminate(); } catch (e) { /* gone */ } reject(new Error('timeout')); }, 15000);
        try { w = new Worker(WORKER); } catch (e) { clearTimeout(timer); reject(e); return; }
        w.onerror = function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); clearTimeout(timer); w.terminate(); reject(new Error('worker')); };
        w.onmessage = function (ev) {
          var m = ev.data || {};
          if (m.type === 'ready') w.postMessage({ type: 'generate', id: 1, design: toEngine(doc) });
          else if (m.type === 'result' && m.id === 1) { clearTimeout(timer); w.terminate(); resolve({ doc: doc, s: segments(m.result) }); }
          else if (m.type === 'error') { clearTimeout(timer); w.terminate(); reject(new Error('engine')); }
        };
      });
    }).then(function (d) {
      if (!d.s.n || !(d.s.box.w > 0) || !(d.s.box.h > 0)) throw new Error('empty');
      d.lines = outlines(d.doc);
      return d;
    });
  }

  /* ---------- drawing ---------- */
  var ctx, scale, offX, offY, dpr, needle;
  function setup() {
    var rect = canvas.getBoundingClientRect(), size = Math.max(1, Math.round(rect.width));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr);
    ctx = canvas.getContext('2d');
    var b = data.s.box;
    scale = FIT * size * dpr / Math.max(b.w, b.h);                       /* device px per 0.1 mm */
    offX = size * dpr / 2 - (b.x + b.w / 2) * scale; offY = size * dpr / 2 - (b.y + b.h / 2) * scale;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (!needle) { needle = document.createElement('span'); needle.className = 'hoop__needle'; needle.setAttribute('aria-hidden', 'true');
      needle.style.cssText = 'position:absolute;left:0;top:0;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:#fff;box-shadow:0 0 0 2px var(--signal),0 2px 6px rgb(43 45 49 / .25);opacity:0;transition:opacity .3s;pointer-events:none';
      cloth.appendChild(needle); }
  }
  function mmX(x) { return (x * 10 - data.s.ox) * scale + offX; }
  function mmY(y) { return (y * 10 - data.s.oy) * scale + offY; }
  function moveNeedle(x, y) {   /* x, y in device px of the canvas */
    var cr = canvas.getBoundingClientRect(), pr = cloth.getBoundingClientRect();
    needle.style.transform = 'translate(' + (cr.left - pr.left + x / dpr) + 'px,' + (cr.top - pr.top + y / dpr) + 'px)';
  }

  /* outlines: drawn in order, each one growing to full length; t in 0..1 */
  function drawOutlines(t) {
    var lines = data.lines, total = 0, i, j, p;
    if (!lines._len) { lines._len = lines.map(function (l) { var s = 0; for (var k = 1; k < l.pts.length; k++) s += Math.hypot(l.pts[k][0] - l.pts[k - 1][0], l.pts[k][1] - l.pts[k - 1][1]); return s; }); }
    lines._len.forEach(function (s) { total += s; });
    var budget = total * t, last = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(83, 86, 92, .55)'; ctx.lineWidth = 1.1 * dpr; ctx.setLineDash([]);
    ctx.beginPath();
    for (i = 0; i < lines.length && budget > 0; i++) {
      p = lines[i].pts;
      ctx.moveTo(mmX(p[0][0]), mmY(p[0][1]));
      for (j = 1; j < p.length && budget > 0; j++) {
        var d = Math.hypot(p[j][0] - p[j - 1][0], p[j][1] - p[j - 1][1]);
        if (d > budget) { var f = budget / d; last = [mmX(p[j - 1][0] + (p[j][0] - p[j - 1][0]) * f), mmY(p[j - 1][1] + (p[j][1] - p[j - 1][1]) * f)]; ctx.lineTo(last[0], last[1]); budget = 0; break; }
        budget -= d; last = [mmX(p[j][0]), mmY(p[j][1])]; ctx.lineTo(last[0], last[1]);
      }
      if (budget > 0 && lines[i].closed) ctx.closePath();
    }
    ctx.stroke();
    if (last) moveNeedle(last[0], last[1]);
  }
  /* stitches from index a (inclusive) to b (exclusive), batched by thread colour */
  function drawStitches(a, b) {
    var s = data.s, seg = s.seg, col = s.col, w = Math.max(1.1 * dpr, 4 * scale);   /* 0.4 mm thread */
    var i = a;
    while (i < b) {
      var c = col[i], j = i;
      ctx.beginPath();
      while (j < b && col[j] === c) { var q = j * 4; ctx.moveTo(seg[q] * scale + offX, seg[q + 1] * scale + offY); ctx.lineTo(seg[q + 2] * scale + offX, seg[q + 3] * scale + offY); j++; }
      ctx.strokeStyle = s.colors[c] || '#2b2d31'; ctx.lineWidth = w; ctx.globalAlpha = 1; ctx.stroke();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = w * 0.35; ctx.globalAlpha = 0.22; ctx.stroke();      /* a little sheen */
      ctx.globalAlpha = 1;
      i = j;
    }
  }

  function phase(p) { show.setAttribute('data-phase', p); }
  function play() {
    cancelAnimationFrame(raf);
    show.classList.remove('is-done', 'is-still'); show.classList.add('is-anim');
    if (replay) replay.hidden = true;
    setup(); phase('draw');
    if (countEl) countEl.textContent = '0';
    needle.style.opacity = '1';
    var t0 = performance.now(), done = 0, s = data.s;
    function frame(now) {
      var t = now - t0;
      if (t < DRAW_MS) { drawOutlines(t / DRAW_MS); raf = requestAnimationFrame(frame); return; }
      if (show.getAttribute('data-phase') === 'draw') { drawOutlines(1); phase('stitch'); }
      var p = Math.min(1, (t - DRAW_MS) / STITCH_MS), upto = Math.round(s.n * p);
      if (upto > done) {
        drawStitches(done, upto); done = upto;
        var q = (upto - 1) * 4; moveNeedle(s.seg[q + 2] * scale + offX, s.seg[q + 3] * scale + offY);
        if (countEl) countEl.textContent = fmt(s.stitches * p);
      }
      if (p < 1) { raf = requestAnimationFrame(frame); return; }
      needle.style.opacity = '0';
      if (countEl) countEl.textContent = fmt(s.stitches);
      show.classList.add('is-done');
      setTimeout(function () { if (show.classList.contains('is-done')) { phase('wear'); if (replay) replay.hidden = false; } }, 500);
    }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (started) return; started = true;
    load().then(function (d) { data = d; play(); }).catch(function () { still(); });
  }
  /* after load, when idle, once the hoop is on screen */
  function whenIdle(fn) { if (window.requestIdleCallback) requestIdleCallback(fn, { timeout: 1200 }); else setTimeout(fn, 200); }
  function arm() {
    whenIdle(function () {
      if (!('IntersectionObserver' in window)) { start(); return; }
      var io = new IntersectionObserver(function (es) { if (es.some(function (e) { return e.isIntersecting; })) { io.disconnect(); start(); } }, { threshold: 0.25 });
      io.observe(show);
    });
  }
  if (replay) replay.addEventListener('click', function () { if (data) play(); });
  if (document.readyState === 'complete') arm(); else window.addEventListener('load', arm);
  /* if nothing has started within a few seconds of load (slow device, tab hidden), keep the still picture visible */
  window.addEventListener('load', function () { setTimeout(function () { if (!data && !show.classList.contains('is-still') && !started) still(); }, 6000); });
})();
