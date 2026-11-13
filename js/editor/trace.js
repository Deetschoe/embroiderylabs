/* ==========================================================================
   EMBROIDERY LABS - js/editor/trace.js
   A picture to trace over: a PNG / JPG / WebP / GIF shown UNDER the artwork.

   It is a guide, not part of the design: it never reaches Model.toEngine(),
   so it is not sewn and not exported, and it is not in the undo history.
   The state lives in Editor.View.trace = { img, x, y, w, h (mm), opacity 0..1,
   locked }; view.js draws it on #trace-canvas (hidden in stitch-out view) and
   tools.js lets the select tool drag it until it is locked.

   The picture is decoded by the browser as a bitmap and copied to a canvas of
   at most 1600 px; nothing is uploaded. It is kept in localStorage next to
   the design ONLY if it fits: on a quota error a smaller copy is tried, and
   if that fails too the picture simply stays until the page is closed (the
   visitor is told). If the design itself can no longer be saved, the stored
   picture is dropped first: the design matters more.

   Public: Editor.Trace.load(file) -> Promise<boolean>, .moveTo(x, y),
           .setWidth(mm), .setOpacity(0..1), .setLocked(bool), .fit(),
           .remove(), .save(), .accepts(file), .init()
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
  var stored = false, saveTimer = 0, told = false, lastHoop = null;

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
      if (!t.src) t.src = encode(t.img, sizes[i][0], sizes[i][1]);
      if (t.src && EL.store.set(KEY, { v: 1, src: t.src, x: t.x, y: t.y, w: t.w, h: t.h, opacity: t.opacity, locked: !!t.locked })) {
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
      var t = { img: img, src: d.src, x: d.x, y: d.y, w: G.clamp(d.w, MIN_W, maxWidth()), h: 0, opacity: G.clamp(d.opacity, 0.05, 1), locked: d.locked === true };
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
        var t = { img: c, src: null, w: c.width * s, h: c.height * s, x: 0, y: 0, opacity: 0.5, locked: false };
        t.x = G.r2((hoop.w - t.w) / 2); t.y = G.r2((hoop.h - t.h) / 2);
        V.trace = t; told = false;
        if (V.mode !== 'design') V.setMode('design');
        changed(); Tr.save();
        toast('Picture added under your drawing. It is not sewn and not exported.', { kind: 'ok', label: 'Picture', timeout: 6000 });
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
    if (!t) return;
    var op = $('trace-opacity'), size = $('trace-size'), lock = $('trace-lock'), pct = Math.round(t.opacity * 100), mm = Math.round(t.w);
    if (op) { op.value = pct; if (window.EL) window.EL.syncSlider(op); }
    if ($('opacity-value')) $('opacity-value').textContent = pct + '%';
    if (size) { size.max = maxWidth(); size.value = mm; if (window.EL) window.EL.syncSlider(size); }
    if ($('trace-size-value')) $('trace-size-value').textContent = Editor.Units.text(mm);
    if (lock) lock.checked = !!t.locked;
  }
  Tr.init = function () {
    function on(id, type, fn) { var n = $(id); if (n) n.addEventListener(type, fn); }
    on('trace-opacity', 'input', function () { Tr.setOpacity(Number(this.value) / 100); });
    on('trace-size', 'input', function () { Tr.setWidth(Number(this.value)); });
    on('trace-lock', 'change', function () { Tr.setLocked(this.checked); say(this.checked ? 'Picture locked' : 'Picture unlocked'); });
    on('trace-fit', 'click', function () { Tr.fit(); });
    on('trace-remove', 'click', function () { Tr.remove(); });
    lastHoop = { w: M.doc.hoop.w, h: M.doc.hoop.h };
    /* a new hoop size keeps the artwork centred (Model.setHoop): the picture goes with it */
    Editor.on('change', function () {
      var hoop = M.doc.hoop, t = V.trace;
      if (hoop.w === lastHoop.w && hoop.h === lastHoop.h) return;
      if (t) { t.x += (hoop.w - lastHoop.w) / 2; t.y += (hoop.h - lastHoop.h) / 2; clampIn(t); changed(); saveSoon(); }
      lastHoop = { w: hoop.w, h: hoop.h };
    });
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
