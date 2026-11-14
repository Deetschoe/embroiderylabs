/* ==========================================================================
   EMBROIDERY LABS - js/editor/trace.js
   A picture (PNG / JPG / WebP / GIF) under the artwork: to trace over by
   hand, or to turn into stitches in one go.

   The picture itself is a guide, not part of the design: it never reaches
   Model.toEngine(), so it is not sewn and not exported, and it is not in the
   undo history. The state lives in Editor.View.trace = { img, pic, x, y, w,
   h (mm), opacity 0..1, locked, hidden }; `pic` is the picture, `img` is the
   same picture or null while it is hidden (view.js draws `img` on
   #trace-canvas, hidden in stitch-out view, and tools.js lets the select tool
   drag it until it is locked; a hidden picture is neither drawn nor dragged).

   The picture is decoded by the browser as a bitmap and copied to a canvas of
   at most 1600 px; nothing is uploaded. It is kept in localStorage next to
   the design ONLY if it fits: on a quota error a smaller copy is tried, and
   if that fails too the picture simply stays until the page is closed (the
   visitor is told). If the design itself can no longer be saved, the stored
   picture is dropped first: the design matters more.

   "Turn into stitches" (bottom half of this file) runs the picture tracer
   (global `Trace`, js/trace/, in a Web Worker; on the main thread in slices
   from file://) over the picture at its size on the hoop. Colours: automatic
   (the fewest that show the picture, at most 10; see js/trace NOTES) or a
   number from 2 to 30. The result is shown first (thread swatches with the
   nearest Brother thread name, stitch count, size) and added as shapes in ONE
   undo step; the picture is then hidden, not removed.

   Public: Editor.Trace.load(file) -> Promise<boolean>, .moveTo(x, y),
           .setWidth(mm), .setOpacity(0..1), .setLocked(bool), .setHidden(bool),
           .fit(), .remove(), .save(), .accepts(file), .has(), .init()
           .stitch() -> Promise<objects added | null>   (the primary action)
           .setColors('auto' | 2..30), .cancel(), .preview() -> current state
   Event:  'trace' whenever the picture is added, changed or removed.
   ========================================================================== */
(function () {
  'use strict';
  var Editor = window.Editor;
  if (!Editor || !Editor.View || !Editor.Model || !Editor.Geom) return;
  var V = Editor.View, M = Editor.Model, G = Editor.Geom;
  var Tr = Editor.Trace = {};

  var KEY = 'el-editor-trace-v1';
  var TYPES = /^image\/(png|jpeg|webp|gif)$/;
  var SAFE_SRC = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/;
  var MAX_FILE = 25 * 1024 * 1024;   /* bytes */
  var MAX_SIDE = 1600;               /* px kept in memory */
  var MIN_W = 10;                    /* mm */
  var KEEP = 8;                      /* mm of the picture that must stay on the hoop */
  var stored = false, saveTimer = 0, told = false, lastHoop = null, picSeq = 0;

  function $(id) { return document.getElementById(id); }
  function toast(msg, opts) { return Editor.toast ? Editor.toast(msg, opts) : null; }
  function say(msg) { if (Editor.say) Editor.say(msg); }
  function maxWidth() { var h = M.doc.hoop; return Math.round(Math.max(h.w, h.h) * 2); }
  function changed() { V.setTrace(V.trace); render(); Editor.emit('trace'); }
  function clampIn(t) {
    var hoop = M.doc.hoop;
    t.x = G.r2(G.clamp(t.x, KEEP - t.w, hoop.w - KEEP));
    t.y = G.r2(G.clamp(t.y, KEEP - t.h, hoop.h - KEEP));
  }
  function picOf(t) { return t ? (t.pic || t.img) : null; }

  /* ---------- keeping it between visits ------------------------------------------- */
  function encode(img, side, quality) {
    var w = img.width, h = img.height; if (!w || !h) return null;
    var k = Math.min(1, side / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    try {
      var x = c.getContext('2d');
      x.drawImage(img, 0, 0, c.width, c.height);
      var url = c.toDataURL('image/webp', quality);
      if (url.slice(0, 15) !== 'data:image/webp') {          /* this browser cannot write WebP: JPEG on white */
        x.globalCompositeOperation = 'destination-over'; x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height);
        url = c.toDataURL('image/jpeg', quality);
      }
      return SAFE_SRC.test(url) ? url : null;
    } catch (e) { return null; }
  }
  function forget() { if (window.EL) window.EL.store.remove(KEY); stored = false; }
  Tr.save = function () {
    clearTimeout(saveTimer); saveTimer = 0;
    var t = V.trace, EL = window.EL;
    if (!EL) return false;
    if (!t) { forget(); return true; }
    if (t.keep === false) return false;                       /* already found not to fit */
    var sizes = [[MAX_SIDE, 0.8], [1024, 0.7], [640, 0.6]], i;
    for (i = t.tier || 0; i < sizes.length; i++) {
      if (!t.src) t.src = encode(picOf(t), sizes[i][0], sizes[i][1]);
      if (t.src && EL.store.set(KEY, { v: 1, src: t.src, x: t.x, y: t.y, w: t.w, h: t.h, opacity: t.opacity, locked: !!t.locked, hidden: !!t.hidden })) {
        t.tier = i; stored = true; return true;
      }
      t.src = null;                                           /* did not fit: try a smaller copy */
    }
    t.keep = false; forget();
    if (!told) { told = true; toast('This picture is too big to keep in your browser. It stays here until you close the page.', { label: 'Picture', timeout: 8000 }); }
    return false;
  };
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(Tr.save, 400); }

  function restore() {
    var d = null;
    try { d = window.EL.store.get(KEY, null); } catch (e) { d = null; }
    if (d == null) return;
    var ok = d && d.v === 1 && typeof d.src === 'string' && d.src.length < 8e6 && SAFE_SRC.test(d.src)
      && [d.x, d.y, d.w, d.h, d.opacity].every(function (n) { return typeof n === 'number' && isFinite(n) && Math.abs(n) < 1e5; }) && d.w >= 1 && d.h >= 1;
    if (!ok) { forget(); return; }
    var img = new Image();
    img.onload = function () {
      if (V.trace || !img.width || !img.height) return;       /* a new picture was loaded meanwhile */
      var hidden = d.hidden === true;
      var t = { img: hidden ? null : img, pic: img, uid: ++picSeq, src: d.src, x: d.x, y: d.y, w: G.clamp(d.w, MIN_W, maxWidth()), h: 0, opacity: G.clamp(d.opacity, 0.05, 1), locked: d.locked === true, hidden: hidden };
      t.h = t.w * img.height / img.width;
      clampIn(t); stored = true; V.trace = t; changed();
    };
    img.onerror = function () { forget(); };
    img.src = d.src;
  }

  /* ---------- public ------------------------------------------------------------------ */
  Tr.accepts = function (file) { return !!file && TYPES.test(file.type || ''); };
  Tr.has = function () { return !!V.trace; };

  /* Read a picture file and lay it under the drawing, fitted inside the hoop. */
  Tr.load = function (file) {
    if (!Tr.accepts(file)) { toast('Use an SVG file, or a PNG, JPG, WebP or GIF picture.', { kind: 'bad', label: 'Picture' }); return Promise.resolve(false); }
    if (file.size > MAX_FILE) { toast('This picture is larger than 25 MB. Save a smaller copy and try again.', { kind: 'bad', label: 'Picture', timeout: 8000 }); return Promise.resolve(false); }
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file), img = new Image();
      function done() { try { URL.revokeObjectURL(url); } catch (e) { /* gone */ } }
      img.onerror = function () { done(); toast('This picture could not be opened.', { kind: 'bad', label: 'Picture' }); resolve(false); };
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, c, ok = !!(w && h);
        if (ok) {
          try {
            var k = Math.min(1, MAX_SIDE / Math.max(w, h));
            c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          } catch (e) { ok = false; }
        }
        done();
        if (!ok) { toast('This picture could not be opened.', { kind: 'bad', label: 'Picture' }); resolve(false); return; }
        var hoop = M.doc.hoop, s = Math.min(hoop.w * 0.8 / c.width, hoop.h * 0.8 / c.height);
        var t = { img: c, pic: c, uid: ++picSeq, src: null, w: c.width * s, h: c.height * s, x: 0, y: 0, opacity: 0.5, locked: false, hidden: false };
        t.x = G.r2((hoop.w - t.w) / 2); t.y = G.r2((hoop.h - t.h) / 2);
        V.trace = t; told = false;
        if (V.mode !== 'design') V.setMode('design');
        changed(); Tr.save();
        toast('Picture added. Trace over it, or turn it into stitches.', { kind: 'ok', label: 'Picture', timeout: 7000, action: { label: 'Turn into stitches', onClick: function () { Tr.stitch(); } } });
        say('Picture added under the drawing');
        resolve(true);
      };
      img.src = url;
    });
  };
  Tr.moveTo = function (x, y) {
    var t = V.trace; if (!t || !isFinite(x) || !isFinite(y)) return;
    t.x = x; t.y = y; clampIn(t); V.invalidate();
  };
  Tr.setWidth = function (w) {
    var t = V.trace; w = Number(w); if (!t || !isFinite(w)) return;
    w = G.clamp(w, MIN_W, maxWidth());
    var cx = t.x + t.w / 2, cy = t.y + t.h / 2, ratio = t.h / t.w;
    t.w = w; t.h = w * ratio; t.x = cx - t.w / 2; t.y = cy - t.h / 2;
    clampIn(t); changed(); saveSoon();
  };
  Tr.setOpacity = function (a) {
    var t = V.trace; a = Number(a); if (!t || !isFinite(a)) return;
    t.opacity = G.clamp(a, 0.05, 1); changed(); saveSoon();
  };
  Tr.setLocked = function (on) {
    var t = V.trace; if (!t) return;
    t.locked = !!on; changed(); Tr.save();
  };
  /* A hidden picture stays (with its place, size and settings) but is not drawn and cannot be dragged. */
  Tr.setHidden = function (on) {
    var t = V.trace; if (!t) return;
    on = !!on; if (on === !!t.hidden) return;
    t.hidden = on; t.img = on ? null : picOf(t); changed(); Tr.save();
  };
  Tr.fit = function () {
    var t = V.trace; if (!t) return;
    var hoop = M.doc.hoop, ratio = t.h / t.w, w = Math.min(hoop.w, hoop.h / ratio);
    t.w = w; t.h = w * ratio; t.x = G.r2((hoop.w - t.w) / 2); t.y = G.r2((hoop.h - t.h) / 2);
    changed(); Tr.save();
  };
  Tr.remove = function () {
    var old = V.trace; if (!old) return;
    V.trace = null; changed(); Tr.save();
    say('Picture removed');
    toast('Picture removed.', { label: 'Picture', timeout: 7000, action: { label: 'Undo', onClick: function () { if (!V.trace) { V.trace = old; clampIn(old); changed(); Tr.save(); } } } });
  };

  /* ---------- the controls in the properties panel ------------------------------------- */
  function render() {
    var box = $('trace-controls'), t = V.trace; if (!box) return;
    box.hidden = !t;
    if (!t) { renderStitch(); return; }
    var op = $('trace-opacity'), size = $('trace-size'), lock = $('trace-lock'), show = $('trace-show'), pct = Math.round(t.opacity * 100), mm = Math.round(t.w);
    if (op) { op.value = pct; if (window.EL) window.EL.syncSlider(op); }
    if ($('opacity-value')) $('opacity-value').textContent = pct + '%';
    if (size) { size.max = maxWidth(); size.value = mm; if (window.EL) window.EL.syncSlider(size); }
    if ($('trace-size-value')) $('trace-size-value').textContent = Editor.Units.text(mm);
    if (lock) lock.checked = !!t.locked;
    if (show) show.checked = !t.hidden;
    renderStitch();
  }

  /* ==========================================================================
     Turn into stitches
     ========================================================================== */
  var AUTO_MAX = 10, MAX_COLOURS = 30, MAX_TRACE_W = 400, PREFS = 'el-editor-stitchify-v1';
  var S = {
    client: null, pixels: null, pixelsOf: null,
    seq: 0,            /* bumped by every new run and by cancel: older answers are ignored */
    key: '',           /* what the current result (or running job) is for */
    job: false, progress: 0, result: null, stitches: 0, names: null, error: '', cancelled: false,
    waiters: [],       /* stitch() calls waiting for the running job */
    timer: 0
  };
  var colours = { auto: true, n: 6 };
  (function () {
    var p = null; try { p = window.EL && window.EL.store.get(PREFS, null); } catch (e) { p = null; }
    if (p && typeof p === 'object') {
      if (typeof p.auto === 'boolean') colours.auto = p.auto;
      if (typeof p.n === 'number' && isFinite(p.n)) colours.n = G.clamp(Math.round(p.n), 2, MAX_COLOURS);
    }
  })();
  function saveColours() { try { if (window.EL) window.EL.store.set(PREFS, { auto: colours.auto, n: colours.n }); } catch (e) { /* only a convenience */ } }

  function tracer() {
    var T = window.Trace;
    if (!T || typeof T.createClient !== 'function') return null;
    if (!S.client) S.client = T.createClient();
    return S.client;
  }
  function traceWidth(t) { return G.clamp(t.w, MIN_W, MAX_TRACE_W); }
  function keyOf(t) { return t ? [t.uid, Math.round(traceWidth(t) * 2) / 2, colours.auto ? 'auto' : colours.n].join('|') : ''; }
  function fresh() { var t = V.trace; return !!(t && S.result && !S.job && S.key === keyOf(t)); }

  /* The picture as pixels, made once per picture (Trace.imageDataFrom shrinks to 1600 px; ours already is). */
  function pixelsOf(t) {
    var pic = picOf(t);
    if (S.pixels && S.pixelsOf === pic) return Promise.resolve(S.pixels);
    return window.Trace.imageDataFrom(pic, { maxSide: MAX_SIDE }).then(function (img) { S.pixels = img; S.pixelsOf = pic; return img; });
  }

  /* The Brother thread each colour will be listed as in a .pes file: what the engine's writer picks (the nearest
     entry still free, so two close shades get two different names), else the tracer's nearest thread. */
  function threadNames(res) {
    var W = window.Engine && window.Engine.Writer, names = res.colors.map(function (c) { return c.thread.name; });
    if (!W || typeof W.buildUniquePalette !== 'function' || !W.PEC_THREADS) return names;
    try {
      var shown = W.buildUniquePalette(res.colors.map(function (c) { return parseInt(c.hex.slice(1), 16); }));
      return res.colors.map(function (c, i) { var e = W.PEC_THREADS[shown[i]]; return e && typeof e[3] === 'string' ? e[3] : names[i]; });
    } catch (e) { return names; }
  }
  /* The list Model.addMany takes, placed where the picture is. Traced at x = y = 0 and `traceWidth`, so
     moving the picture never needs a new trace; a picture wider than the tracer allows is scaled up.
     Shapes are named after their thread ("Khaki", "Khaki 2", "Black line 3"), as the swatches are. */
  function editorList(res, t) {
    var list = window.Trace.toEditorObjects(res), k = t ? t.w / traceWidth(t) : 1, ox = t ? t.x : 0, oy = t ? t.y : 0;
    var names = threadNames(res), total = {}, seen = {};
    function at(p) { return [G.r2(ox + p[0] * k), G.r2(oy + p[1] * k)]; }
    function key(o) { return o.trace.color + (o.trace.kind === 'fill' ? 'f' : 'l'); }
    res.objects.forEach(function (o) { total[key(o)] = (total[key(o)] || 0) + 1; });
    list.forEach(function (it, i) {
      var g = it.geom, o = res.objects[i];
      if (t) {
        if (g.pts) g.pts = g.pts.map(at);
        if (g.rings) g.rings = g.rings.map(function (r) { return r.map(at); });
      }
      if (o && o.trace && names[o.trace.color]) {
        var kk = key(o), n = seen[kk] = (seen[kk] || 0) + 1;
        it.style.name = names[o.trace.color] + (o.trace.kind === 'fill' ? '' : ' line') + (total[kk] > 1 ? ' ' + n : '');
      }
    });
    return list;
  }
  /* Stitches as the editor will sew them: the shapes through Model.toEngine() and the real engine (a few
     milliseconds; the tracer's own estimate is 5 to 17% off). Falls back to that estimate. */
  function countStitches(res) {
    var est = (res.stats && res.stats.estimatedStitches) || 0;
    if (!window.Engine || typeof window.Engine.generate !== 'function' || !res.objects.length) return est;
    try {
      var list = editorList(res, null), objs = list.map(function (it, i) {
        return Object.assign({ id: 'p' + i, pattern: 'smooth' }, it.geom, it.style);
      });
      var gen = window.Engine.generate(M.toEngine({ name: 'preview', hoop: { w: Math.max(10, res.size.width + 2), h: Math.max(10, res.size.height + 2) }, objects: objs }));
      return gen && gen.totals && gen.totals.stitches ? gen.totals.stitches : est;
    } catch (e) { return est; }
  }

  function settle(value) { var w = S.waiters; S.waiters = []; w.forEach(function (f) { f(value); }); }
  /* Trace the picture with the current settings. Answers for an older picture / size / colour setting are dropped. */
  function run() {
    clearTimeout(S.timer); S.timer = 0;
    var t = V.trace, client = tracer();
    if (!t) return;
    if (!client || typeof window.Trace.imageDataFrom !== 'function') { S.error = 'Turning pictures into stitches is not available in this browser.'; renderStitch(); settle(false); return; }
    var my = ++S.seq, key = keyOf(t);
    S.key = key; S.job = true; S.progress = 0; S.result = null; S.error = ''; S.cancelled = false;
    renderStitch();
    var opts = { width: traceWidth(t), colors: colours.auto ? 'auto' : colours.n, maxColors: AUTO_MAX, x: 0, y: 0 };
    pixelsOf(t).then(function (img) {
      if (my !== S.seq) return null;
      return client.trace(img, opts, { onProgress: function (f) { if (my === S.seq) { S.progress = f; renderProgress(); } } });
    }).then(function (res) {
      if (my !== S.seq || !res) return;
      S.job = false; S.result = res;
      S.stitches = res.ok ? countStitches(res) : 0;
      S.names = res.ok ? threadNames(res) : null;
      if (!res.ok) S.error = (res.warnings.filter(function (w) { return w.severity === 'error'; })[0] || {}).message || 'Nothing in this picture can be sewn.';
      renderStitch();
      settle(res.ok);
    }).catch(function (e) {
      if (my !== S.seq) return;
      S.job = false; S.result = null;
      if (e && e.code === 'CANCELLED') S.cancelled = true;
      else S.error = 'This picture could not be turned into stitches.';
      renderStitch();
      settle(false);
    });
  }
  /* Run again soon when the picture, its size or the colour setting changed (not for moves or opacity). */
  function schedule(delay, asked) {
    var t = V.trace;
    if (!t) { reset(); return; }
    if (t.hidden && !asked) return;                           /* already turned into stitches: no work until asked */
    if (S.key === keyOf(t) && (S.job || S.result || S.error)) return;
    if (S.cancelled && S.key === keyOf(t)) return;
    clearTimeout(S.timer); S.timer = setTimeout(run, delay == null ? 300 : delay);
  }
  function reset() {
    clearTimeout(S.timer); S.timer = 0;
    if (S.job && S.client) { S.seq++; S.client.cancel(); }
    S.seq++; S.key = ''; S.job = false; S.result = null; S.error = ''; S.cancelled = false; S.pixels = null; S.pixelsOf = null;
    settle(false); renderStitch();
  }
  Tr.cancel = function () {
    if (!S.job && !S.timer) return false;
    clearTimeout(S.timer); S.timer = 0;
    S.seq++; if (S.client) S.client.cancel();
    S.job = false; S.result = null; S.cancelled = true; S.key = keyOf(V.trace);
    settle(false); renderStitch();
    say('Stopped');
    return true;
  };
  Tr.setColors = function (v) {
    if (v === 'auto') colours.auto = true;
    else { var n = Number(v); if (!isFinite(n)) return; colours.auto = false; colours.n = G.clamp(Math.round(n), 2, MAX_COLOURS); }
    saveColours(); S.cancelled = false; renderStitch(); schedule(250, true);
  };
  Tr.preview = function () {
    var r = S.result;
    return { key: S.key, busy: S.job, progress: S.progress, error: S.error, cancelled: S.cancelled, auto: colours.auto, n: colours.n, fresh: fresh(),
      colors: r && r.ok ? r.colors.map(function (c, i) { return { hex: c.hex, thread: (S.names || [])[i] || c.thread.name, nearest: c.thread.name, share: c.share }; }) : [],
      stitches: S.stitches, picked: r && r.stats && r.stats.autoColors ? r.stats.autoColors.picked : null };
  };

  /* The primary action: add the traced shapes (as ONE undo step) where the picture is, then hide the picture. */
  Tr.stitch = function () {
    var t = V.trace;
    if (!t) return Promise.resolve(null);
    if (fresh()) return Promise.resolve(apply());
    return new Promise(function (resolve) {
      S.waiters.push(function (ok) { resolve(ok && fresh() ? apply() : null); });
      if (!(S.job && S.key === keyOf(t))) run();
      else renderStitch();
    });
  };
  function apply() {
    var t = V.trace, res = S.result;
    if (!t || !res || !res.ok) return null;
    var list = editorList(res, t);
    var made = M.addMany(list, 'Turn picture into stitches');
    if (!made.length) {
      toast('That would be more than ' + M.MAX_OBJECTS + ' shapes in one design. Try fewer colours, or start a new design.', { kind: 'bad', label: 'Stitches', timeout: 8000 });
      return null;
    }
    if (V.mode !== 'design' && V.setMode) V.setMode('design');
    Tr.setHidden(true);
    var n = res.colors.length;
    toast('Added ' + made.length + (made.length === 1 ? ' shape' : ' shapes') + ' in ' + n + (n === 1 ? ' colour' : ' colours') + '. The picture is hidden; tick Show picture to see it again.', { kind: 'ok', label: 'Stitches', timeout: 7000 });
    say('Picture turned into ' + made.length + ' shapes');
    return made;
  }

  /* ---------- drawing the stitch part of the panel ---------------------------------------- */
  function fmt(n) { return window.EL ? window.EL.num(n) : String(n); }
  function renderProgress() {
    var bar = $('trace-bar'), txt = $('trace-busy-text');
    var pct = Math.round(Math.max(0, Math.min(1, S.progress)) * 100);
    if (bar) bar.style.width = Math.max(4, pct) + '%';
    if (txt) txt.textContent = (S.progress < 0.36 && colours.auto ? 'Choosing colours ' : 'Working ') + pct + '%';
  }
  function swatch(c, thread) {
    var row = document.createElement('span');
    row.className = 'stitchify__swatch'; row.setAttribute('role', 'listitem');
    row.title = 'Brother thread ' + thread + ' for ' + c.hex + ' (' + Math.max(1, Math.round(c.share * 100)) + '% of the picture)';
    var dot = document.createElement('span'); dot.className = 'thread'; dot.style.setProperty('--c', c.hex);
    var name = document.createElement('span'); name.className = 'stitchify__name'; name.textContent = thread;
    row.appendChild(dot); row.appendChild(name);
    return row;
  }
  function renderStitch() {
    var t = V.trace, box = $('stitchify'); if (!box) return;
    var slider = $('trace-colors'), auto = $('trace-colors-auto'), val = $('trace-colors-value'), sw = $('trace-swatches'),
      busy = $('trace-busy'), meta = $('trace-meta'), note = $('trace-note'), btn = $('trace-stitch');
    var r = S.result && S.result.ok && S.key === keyOf(t) ? S.result : null;
    var picked = r && r.stats.autoColors ? r.stats.autoColors.picked : null;
    if (auto) auto.checked = colours.auto;
    if (slider) {
      slider.value = colours.auto ? (r ? r.colors.length : (picked || 6)) : colours.n;
      slider.classList.toggle('is-auto', colours.auto);
      if (window.EL) window.EL.syncSlider(slider);
    }
    if (val) val.textContent = colours.auto ? (r ? 'Auto ' + r.colors.length : 'Auto') : String(colours.n);
    if (sw) {
      while (sw.firstChild) sw.removeChild(sw.firstChild);
      if (r) { var names = S.names || threadNames(r); r.colors.forEach(function (c, i) { sw.appendChild(swatch(c, names[i])); }); }
      sw.hidden = !r;
    }
    if (busy) busy.hidden = !S.job;
    if (S.job) renderProgress();
    if (meta) {
      var text = '';
      if (r) text = r.colors.length + (r.colors.length === 1 ? ' colour' : ' colours') + ' · ' + fmt(S.stitches) + ' stitches · ' + Editor.Units.size(t.w, t.w * r.size.height / r.size.width) + ' ' + Editor.Units.label();
      meta.textContent = text; meta.hidden = !text;
    }
    if (note) {
      var msg = '';
      if (S.error) msg = S.error;
      else if (S.cancelled) msg = 'Stopped. Press Turn into stitches to start again.';
      else if (r) {
        var hoop = M.doc.hoop, h = t.w * r.size.height / r.size.width;
        if (t.x < -0.5 || t.y < -0.5 || t.x + t.w > hoop.w + 0.5 || t.y + h > hoop.h + 0.5) msg = 'Part of the picture is off the hoop. Use Fit to hoop first, or those stitches cannot be sewn.';
        else if (!colours.auto && colours.n > AUTO_MAX) msg = 'More than ' + AUTO_MAX + ' colours means more thread changes and a longer sew.';
        else msg = shortWarning(r);
      }
      note.textContent = msg; note.hidden = !msg;
      note.classList.toggle('is-bad', !!S.error);
    }
    if (btn) {
      btn.disabled = !t || !!S.error;
      btn.textContent = S.waiters.length && S.job ? 'Adding when ready…' : 'Turn into stitches';
    }
  }
  /* One short sentence from the tracer's warnings, the ones a visitor can act on. */
  function shortWarning(r) {
    var by = {}; r.warnings.forEach(function (w) { by[w.code] = w; });
    if (by.LOW_RESOLUTION) return 'The picture is small for this size, so edges may come out soft. A larger picture works better.';
    if (by.PHOTO_POSTERIZED) return 'Looks like a photo: shading becomes flat bands of thread. Bold, simple pictures work best.';
    if (by.MANY_STITCHES) return 'A long sew. A smaller size or fewer colours helps.';
    if (by.DETAIL_LOST && by.DETAIL_LOST.severity === 'warning') return 'Some fine detail is too small to sew at this size.';
    if (by.TOO_MANY_SHAPES || by.MANY_SMALL_SHAPES) return 'Many small shapes. Fewer colours or a bigger size sews cleaner.';
    return '';
  }

  Tr.init = function () {
    function on(id, type, fn) { var n = $(id); if (n) n.addEventListener(type, fn); }
    on('trace-opacity', 'input', function () { Tr.setOpacity(Number(this.value) / 100); });
    on('trace-size', 'input', function () { Tr.setWidth(Number(this.value)); });
    on('trace-lock', 'change', function () { Tr.setLocked(this.checked); say(this.checked ? 'Picture locked' : 'Picture unlocked'); });
    on('trace-show', 'change', function () { Tr.setHidden(!this.checked); say(this.checked ? 'Picture shown' : 'Picture hidden'); });
    on('trace-fit', 'click', function () { Tr.fit(); });
    on('trace-remove', 'click', function () { Tr.remove(); });
    on('trace-colors', 'input', function () { Tr.setColors(Number(this.value)); });
    on('trace-colors-auto', 'change', function () { Tr.setColors(this.checked ? 'auto' : colours.n); say(this.checked ? 'Colours picked for you' : colours.n + ' colours'); });
    on('trace-stitch', 'click', function () { Tr.stitch(); });
    on('trace-cancel', 'click', function () { Tr.cancel(); });
    lastHoop = { w: M.doc.hoop.w, h: M.doc.hoop.h };
    /* a new hoop size keeps the artwork centred (Model.setHoop): the picture goes with it */
    Editor.on('change', function () {
      var hoop = M.doc.hoop, t = V.trace;
      if (hoop.w === lastHoop.w && hoop.h === lastHoop.h) return;
      if (t) { t.x += (hoop.w - lastHoop.w) / 2; t.y += (hoop.h - lastHoop.h) / 2; clampIn(t); changed(); saveSoon(); }
      lastHoop = { w: hoop.w, h: hoop.h };
    });
    /* a new picture, a new size: trace again (a move or a new opacity needs nothing) */
    Editor.on('trace', function () { if (!V.trace) reset(); else { schedule(); renderStitch(); } });
    Editor.on('units', renderStitch);
    /* the design could not be saved while a picture takes up storage: the picture gives way */
    Editor.on('saved', function () {
      if (!Editor.IO || Editor.IO.saveState !== 'failed' || !stored) return;
      forget(); if (V.trace) V.trace.keep = false;
      Editor.IO.saveNow();
      if (Editor.IO.saveState === 'saved') toast('Browser storage is full, so the picture is no longer kept between visits. Your design still is.', { label: 'Picture', timeout: 8000 });
    });
    window.addEventListener('pagehide', function () { if (saveTimer) Tr.save(); });
    render();
    restore();
  };
})();
