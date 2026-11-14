/* ==========================================================================
   EMBROIDERY LABS - js/editor/mockup.js
   Mockup view: the stitched design on a hoodie or a T-shirt. Creates Editor.Mockup.

   - The garment is a photo of a white blank (mockups/*.webp, greyscale + alpha). It is tinted to
     any colour here, per pixel, so one small picture gives every colour.
   - Each open design (a tab) is drawn once by the realistic renderer (js/realistic, loaded the first
     time the mockup is opened) as thread only, at up to 8 px per mm, then placed on the garment at
     true size.
   - Layers: every side has a list of layers, bottom first. A layer is an embroidery placement
     ({ kind: 'design', tab }) or a picture ({ kind: 'image', src: data URL, mmW, mmH, opacity, blend }).
     Every layer has dx / dy (mm from the middle of the chest), scale, rot (degrees) and hidden.
     Layers are drawn onto the cloth and clipped to it; pictures can blend with it (multiply, screen).
   - Direct manipulation like the Design editor: a box with four corner handles (uniform scale, Alt
     from the centre) and a round rotate handle above it (Shift snaps to 15 degrees); drag inside to
     move. R / Shift+R turn the picked layer 15 degrees; Cmd/Ctrl+] and [ move it up and down.
   - Front and back keep their own layers. Everything is stored in localStorage['el-editor-mockup-v1'];
     if pictures make that too big they stay in memory for this visit. Pictures are cut down to 2048 px.

   Events (Editor.on):  'mockup'  the view was opened or closed
   ========================================================================== */
(function () {
  'use strict';
  var Editor = window.Editor = window.Editor || {};
  var M = Editor.Model, V = Editor.View;
  var KEY = 'el-editor-mockup-v1', SIZE = 2000, MARGIN_MM = 3, MAX_DESIGN_PX = 2400, MAX_PPM = 8;
  var MIN_SCALE = 0.1, MAX_SCALE = 4, MAX_LAYERS = 24, MAX_IMG = 2048, IMG_MM = 100, ROT_STEP = 15, STORE_BUDGET = 1500000;
  var BLENDS = { normal: 'source-over', multiply: 'multiply', screen: 'screen' };

  /* anchor = the middle of the chest in picture pixels; pxPerMm from the body width of the blank */
  var GARMENTS = {
    hoodie: { label: 'Hoodie', fabric: 'fleece', pxPerMm: 2.02, sides: {
      front: { src: 'mockups/hoodie-front.webp', ref: 0.792, anchor: [1000, 930] },
      back: { src: 'mockups/hoodie-back.webp', ref: 0.776, anchor: [1000, 900] } } },
    tee: { label: 'T-shirt', fabric: 'jersey', pxPerMm: 2.17, sides: {
      front: { src: 'mockups/tee-front.webp', ref: 0.847, anchor: [1010, 800] },
      back: { src: 'mockups/tee-back.webp', ref: 0.820, anchor: [1000, 780] } } }
  };
  var COLORS = [['White', '#F4F3F0'], ['Cream', '#EFE6D2'], ['Sand', '#D9C7A8'], ['Heather grey', '#B9BABD'], ['Charcoal', '#4A4D52'], ['Black', '#1B1B1D'],
    ['Navy', '#1F2A44'], ['Royal blue', '#2F56B0'], ['Sky blue', '#9CC3E6'], ['Forest green', '#24462F'], ['Mint', '#A9DCC3'], ['Maroon', '#6B1F2A'],
    ['Red', '#C8262E'], ['Orange', '#E8792B'], ['Gold', '#E9B93A'], ['Pink', '#F2B6C6'], ['Purple', '#5B3A8C'], ['Brown', '#5A3E2B']];
  var WHITE = '#FFFFFF';
  /* the rotate cursor: a curved arrow, white under dark so it reads on any cloth */
  var ROT_ARROW = '<path d="M7.5 15.5A6.5 6.5 0 1 0 8.4 7.3"/><path d="M5 5.6 8.6 7.1 7.4 10.8"/>';
  var ROT_CURSOR = 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
    '<g stroke="#fff" stroke-width="4">' + ROT_ARROW + '</g><g stroke="#2B2D31" stroke-width="1.6">' + ROT_ARROW + '</g></svg>') + '") 12 12, alias';

  var Mock = Editor.Mockup = { GARMENTS: GARMENTS };
  var el = {}, open = false, state = { garment: 'hoodie', side: 'front', color: '#4A4D52', scene: 'studio', placements: { front: [], back: [] } };
  var selected = null, view = { scale: 1, ox: 0, oy: 0, auto: true }, raf = 0, recolorRaf = 0;
  var blank = { key: '', grey: null, alpha: null, canvas: null, loading: null };     /* the garment picture in use */
  var designs = {};                                                                  /* tab id -> { sig, canvas, ppm, w, h, name, busy, empty, result } */
  var pics = {};                                                                     /* image layer id -> { src, img, ready } */
  var libs = null, saveTimer = 0, quotaWarned = false;

  function $(id) { return document.getElementById(id); }
  function toast(msg, opts) { if (window.EL) window.EL.toast(msg, opts); }
  function say(msg) { if (Editor.say) Editor.say(msg); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function garment() { return GARMENTS[state.garment] || GARMENTS.hoodie; }
  function sideInfo() { return garment().sides[state.side] || garment().sides.front; }
  function items() { return state.placements[state.side] || (state.placements[state.side] = []); }
  function isImage(p) { return p && p.kind === 'image'; }
  function newId() { return 'm' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36); }
  /* any angle -> -180 ... 180, one decimal */
  function normRot(r) { r = +r || 0; r = ((r + 180) % 360 + 360) % 360 - 180; r = Math.round(r * 10) / 10; return r === -180 ? 180 : r || 0; }

  /* ---------- colour ------------------------------------------------------------------ */
  function hexToRgb(hex) { var m = /^#?([0-9a-f]{6})$/i.exec(String(hex)); if (!m) return [74, 77, 82]; var n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function rgbToHex(r, g, b) { return '#' + [r, g, b].map(function (v) { v = Math.round(clamp(v, 0, 255)); return (v < 16 ? '0' : '') + v.toString(16); }).join(''); }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), h = 0, s = 0, l = (max + min) / 2, d = max - min;
    if (d) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return [Math.round(h) % 360, Math.round(s * 100), Math.round(l * 100)];
  }
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360; s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100;
    if (!s) return [l * 255, l * 255, l * 255];
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    function f(t) { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }

  /* ---------- the garment: load the blank, tint it ------------------------------------- */
  function loadBlank() {
    var info = sideInfo(), key = state.garment + ':' + state.side;
    if (blank.key === key && blank.grey) return Promise.resolve(true);
    if (blank.loading && blank.loadingKey === key) return blank.loading;
    blank.loadingKey = key;
    setBusy('Loading the ' + garment().label.toLowerCase() + '...');
    blank.loading = new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        if (blank.loadingKey !== key) { resolve(false); return; }
        try {
          var c = document.createElement('canvas'); c.width = SIZE; c.height = SIZE;
          var x = c.getContext('2d', { willReadFrequently: true });
          x.drawImage(img, 0, 0, SIZE, SIZE);
          var d = x.getImageData(0, 0, SIZE, SIZE).data, n = SIZE * SIZE, grey = new Uint8Array(n), alpha = new Uint8Array(n);
          for (var i = 0, j = 0; i < n; i++, j += 4) { grey[i] = d[j]; alpha[i] = d[j + 3]; }
          blank.grey = grey; blank.alpha = alpha; blank.key = key; blank.ref = info.ref;
          if (!blank.canvas) { blank.canvas = document.createElement('canvas'); blank.canvas.width = SIZE; blank.canvas.height = SIZE; }
          recolor(); setBusy(''); resolve(true);
        } catch (e) { setBusy(''); toast('The garment picture could not be read.', { kind: 'bad', label: 'Mockup' }); resolve(false); }
      };
      img.onerror = function () { setBusy(''); toast('The garment picture could not be loaded.', { kind: 'bad', label: 'Mockup' }); resolve(false); };
      img.src = info.src;
    });
    return blank.loading;
  }
  /* cloth colour x the light and shade of the photo. Dark cloth keeps a little sheen in the folds. */
  function recolor() {
    if (!blank.grey || !blank.canvas) return;
    var rgb = hexToRgb(state.color), ref = blank.ref || 0.8, lutR = new Uint8ClampedArray(256), lutG = new Uint8ClampedArray(256), lutB = new Uint8ClampedArray(256);
    var lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255, lift = (1 - lum) * 16, v;
    for (v = 0; v < 256; v++) {
      var s = v / 255 / ref, shade = Math.min(1.22, Math.pow(s, 1.18)), sheen = lift * Math.pow(Math.min(1.3, s), 3);
      lutR[v] = rgb[0] * shade + sheen; lutG[v] = rgb[1] * shade + sheen; lutB[v] = rgb[2] * shade + sheen;
    }
    var x = blank.canvas.getContext('2d'), img = x.createImageData(SIZE, SIZE), d = img.data, grey = blank.grey, alpha = blank.alpha, n = SIZE * SIZE;
    for (var i = 0, j = 0; i < n; i++, j += 4) { var gv = grey[i]; d[j] = lutR[gv]; d[j + 1] = lutG[gv]; d[j + 2] = lutB[gv]; d[j + 3] = alpha[i]; }
    x.putImageData(img, 0, 0);
    invalidate();
  }
  function recolorSoon() { if (!recolorRaf) recolorRaf = requestAnimationFrame(function () { recolorRaf = 0; recolor(); }); }

  /* ---------- the designs: stitches drawn as thread, once per design -------------------- */
  function loadLibs() {
    if (window.Realistic) return Promise.resolve(true);
    if (libs) return libs;
    function script(src) { return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
    libs = script('js/realistic/core.js').then(function () { return script('js/realistic/realistic.js'); }).then(function () { return !!window.Realistic; }, function () { libs = null; return false; });
    return libs;
  }
  function signature(doc) {
    var s = JSON.stringify([doc.hoop, doc.objects]), h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return s.length + ':' + h;
  }
  function renderOpts(d, ppm) {
    var b = d.result.bounds;
    return { scene: 'swatch', transparent: true, fabric: garment().fabric, fabricColor: state.color, pixelsPerMm: ppm, origin: [(MARGIN_MM - b.minX) * ppm, (MARGIN_MM - b.minY) * ppm] };
  }
  /* Make (or reuse) the thread picture of one open design. Resolves with the entry, or null. */
  function prepare(tab) {
    if (!tab || !tab.doc || !Array.isArray(tab.doc.objects) || !tab.doc.objects.length) return Promise.resolve(null);
    var sig = signature(tab.doc) + ':' + garment().fabric, d = designs[tab.id];
    if (d && d.sig === sig) { d.name = tab.name; return d.promise || Promise.resolve(d); }
    d = designs[tab.id] = { sig: sig, name: tab.name, canvas: null, busy: true, empty: false };
    d.promise = loadLibs().then(function (ok) {
      if (!ok) { d.busy = false; d.failed = true; toast('The realistic stitch renderer could not be loaded.', { kind: 'bad', label: 'Mockup' }); return null; }
      var result = null;
      try { result = window.Engine.generate(M.toEngine(tab.doc)); } catch (e) { result = null; }
      var b = result && result.bounds;
      if (!result || !b || !(b.width > 0) || !(b.height > 0) || !result.totals || !result.totals.stitches) { d.busy = false; d.empty = true; return null; }
      var w = b.width + MARGIN_MM * 2, h = b.height + MARGIN_MM * 2, ppm = Math.min(MAX_PPM, MAX_DESIGN_PX / Math.max(w, h));
      var c = document.createElement('canvas'); c.width = Math.max(8, Math.ceil(w * ppm)); c.height = Math.max(8, Math.ceil(h * ppm));
      d.canvas = c; d.ppm = ppm; d.w = w; d.h = h; d.result = result; d.stitches = result.totals.stitches; d.mm = { w: b.width, h: b.height };
      var o = renderOpts(d, ppm);
      o.onProgress = function () { invalidate(); }; o.onFirstFrame = function () { invalidate(); };
      var job = window.Realistic.render(c, result, o);
      return Promise.resolve(job).then(function (stats) {
        if (designs[tab.id] !== d) return null;
        d.busy = false; d.promise = null;
        if (!stats || !stats.ok) { if (!(stats && stats.cancelled)) d.failed = true; }
        invalidate(); renderLists();
        return d;
      });
    });
    return d.promise;
  }
  /* a sharper copy of a design for the "stitching only" file (up to 16 px per mm, 4000 px) */
  function hiRes(d) {
    if (d.hi) return d.hi;
    var ppm = Math.min(16, 4000 / Math.max(d.w, d.h)), low = { canvas: d.canvas, ppm: d.ppm };
    if (!window.Realistic || !d.result || ppm <= d.ppm * 1.05) return Promise.resolve(low);
    var c = document.createElement('canvas'); c.width = Math.max(8, Math.ceil(d.w * ppm)); c.height = Math.max(8, Math.ceil(d.h * ppm));
    d.hi = Promise.resolve(window.Realistic.render(c, d.result, renderOpts(d, ppm)))
      .then(function (stats) { return stats && stats.ok ? { canvas: c, ppm: ppm } : low; }, function () { return low; });
    return d.hi;
  }
  function tabs() { return Editor.Tabs ? Editor.Tabs.designs() : [{ id: 'only', name: M.doc.name, doc: M.serialize(), shapes: M.doc.objects.length, active: true }]; }
  function tabById(id) { var list = tabs(); for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function prepareAll() {
    var need = {}, list = tabs();
    ['front', 'back'].forEach(function (s) { (state.placements[s] || []).forEach(function (p) { if (!isImage(p)) need[p.tab] = 1; }); });
    /* placements of designs that were closed are dropped; pictures stay */
    ['front', 'back'].forEach(function (s) { state.placements[s] = (state.placements[s] || []).filter(function (p) { return isImage(p) || list.some(function (t) { return t.id === p.tab; }); }); });
    return Promise.all(list.filter(function (t) { return need[t.id]; }).map(prepare));
  }

  /* ---------- pictures ------------------------------------------------------------------- */
  function pic(p) {
    var e = pics[p.id];
    if (e && e.src === p.src) return e;
    e = pics[p.id] = { src: p.src, img: new Image(), ready: false };
    e.img.onload = function () { if (pics[p.id] === e) { e.ready = true; invalidate(); renderLists(); } };
    e.img.onerror = function () { if (pics[p.id] === e) e.failed = true; };
    e.img.src = p.src;
    return e;
  }
  function isPicture(file) {
    var t = String(file && file.type || '').toLowerCase(), n = String(file && file.name || '');
    if (/^image\/(png|jpeg|webp|svg\+xml)$/.test(t)) return true;
    return (!t || t === 'application/octet-stream') && /\.(png|jpe?g|webp|svg)$/i.test(n);
  }
  /* file -> { src (data URL, at most 2048 px), img, w, h } or null */
  function readPicture(file) {
    var t = String(file.type || '').toLowerCase(), n = String(file.name || ''), svg = /svg/.test(t) || /\.svg$/i.test(n), jpg = /jpe?g/.test(t) || /\.jpe?g$/i.test(n);
    return new Promise(function (resolve) {
      var url = null, img = new Image();
      try { url = URL.createObjectURL(file); } catch (e) { resolve(null); return; }
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, src = '';
        if (!(w > 0 && h > 0)) { if (svg) { w = 1024; h = 1024; } else { URL.revokeObjectURL(url); resolve(null); return; } }
        var k = svg ? Math.min(MAX_IMG, 1536) / Math.max(w, h) : Math.min(1, MAX_IMG / Math.max(w, h));
        var cw = clamp(Math.round(w * k), 1, MAX_IMG), ch = clamp(Math.round(h * k), 1, MAX_IMG);
        try {
          var c = document.createElement('canvas'); c.width = cw; c.height = ch;
          var x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
          x.drawImage(img, 0, 0, cw, ch);
          src = c.toDataURL(jpg ? 'image/jpeg' : 'image/webp', 0.9);
          if (!/^data:image\/(webp|jpeg|png);base64,/.test(src)) src = c.toDataURL('image/png');
        } catch (e) { src = ''; }
        URL.revokeObjectURL(url);
        if (!src) { resolve(null); return; }
        var out = new Image();
        out.onload = function () { resolve({ src: src, img: out, w: cw, h: ch }); };
        out.onerror = function () { resolve(null); };
        out.src = src;
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
  Mock.addImage = function (file) {
    if (!file) return Promise.resolve(null);
    if (!isPicture(file)) { toast('Pick a PNG, JPG, WebP or SVG picture.', { label: 'Mockup' }); return Promise.resolve(null); }
    if (items().length >= MAX_LAYERS) { toast('This side has ' + MAX_LAYERS + ' layers already.', { label: 'Mockup' }); return Promise.resolve(null); }
    setBusy('Adding the picture...');
    return readPicture(file).then(function (r) {
      setBusy('');
      if (!r) { toast('That picture could not be opened.', { kind: 'bad', label: 'Mockup' }); return null; }
      var tall = r.h > r.w, mmW = tall ? IMG_MM * r.w / r.h : IMG_MM, mmH = tall ? IMG_MM : IMG_MM * r.h / r.w;
      var name = String(file.name || 'Picture').replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 60) || 'Picture';
      var p = { id: newId(), kind: 'image', name: name, src: r.src, mmW: mmW, mmH: mmH, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 100, blend: 'normal', hidden: false };
      pics[p.id] = { src: r.src, img: r.img, ready: true };
      items().push(p); selected = p.id; saveNow(); renderLists(); invalidate();
      say(name + ' added to the ' + state.side);
      return p;
    });
  };

  /* ---------- geometry of a layer -------------------------------------------------------- */
  function source(p) {
    if (isImage(p)) { var e = pic(p); return e.ready ? e.img : null; }
    var d = designs[p.tab]; return d && d.canvas ? d.canvas : null;
  }
  /* picture-pixel box of one layer: centre, size, angle (radians) and what to draw */
  function place(p) {
    var src = source(p); if (!src) return null;
    var g = garment(), a = sideInfo().anchor, mw, mh;
    if (isImage(p)) { mw = p.mmW; mh = p.mmH; } else { var d = designs[p.tab]; mw = d.w; mh = d.h; }
    var w = mw * g.pxPerMm * p.scale, h = mh * g.pxPerMm * p.scale, cx = a[0] + p.dx * g.pxPerMm, cy = a[1] + p.dy * g.pxPerMm;
    return { cx: cx, cy: cy, w: w, h: h, rot: (p.rot || 0) * Math.PI / 180, src: src };
  }
  function corner(r, sx, sy) {
    var c = Math.cos(r.rot), s = Math.sin(r.rot), lx = sx * r.w / 2, ly = sy * r.h / 2;
    return { x: r.cx + lx * c - ly * s, y: r.cy + lx * s + ly * c };
  }
  function inside(r, x, y) {
    var c = Math.cos(-r.rot), s = Math.sin(-r.rot), dx = x - r.cx, dy = y - r.cy, lx = dx * c - dy * s, ly = dx * s + dy * c;
    return Math.abs(lx) <= r.w / 2 && Math.abs(ly) <= r.h / 2;
  }
  /* draw one layer; the context is in picture pixels */
  function drawLayer(x, p, src) {
    var r = place(p); if (!r) return;
    x.save();
    x.translate(r.cx, r.cy); if (r.rot) x.rotate(r.rot);
    x.drawImage(src || r.src, -r.w / 2, -r.h / 2, r.w, r.h);
    x.restore();
  }

  /* ---------- drawing ------------------------------------------------------------------- */
  function invalidate() { if (open && !raf) raf = requestAnimationFrame(function () { raf = 0; draw(); }); }
  /* ---------- the wooden floor: drawn here once, no picture file -------------------------- */
  var wood = null;
  function makeWood() {
    if (wood) return wood;
    var c = document.createElement('canvas'); c.width = SIZE; c.height = SIZE;
    var x = c.getContext('2d'), seed = 20261113;
    function rnd() { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }
    var planks = 7, pw = SIZE / planks, i, k;
    for (i = 0; i < planks; i++) {
      var x0 = i * pw, y = -rnd() * 1100;
      while (y < SIZE) {                                                     /* boards end to end down each row */
        var len = 900 + rnd() * 900, hue = 27 + rnd() * 7, sat = 34 + rnd() * 10, lit = 55 + rnd() * 11;
        x.save(); x.beginPath(); x.rect(x0, y, pw, len); x.clip();
        x.fillStyle = 'hsl(' + hue + ',' + sat + '%,' + lit + '%)'; x.fillRect(x0, y, pw, len);
        for (k = 0; k < 150; k++) {                                          /* grain: long, slightly wavy lines */
          var gx = x0 + rnd() * pw, dark = rnd() < 0.62, a = 0.03 + rnd() * 0.09, ph = rnd() * 6.3, amp = 0.4 + rnd() * 1.6, yy;
          x.strokeStyle = dark ? 'rgba(74,44,18,' + a + ')' : 'rgba(255,236,200,' + a * 0.9 + ')'; x.lineWidth = 0.6 + rnd() * 2.4;
          x.beginPath(); x.moveTo(gx, y - 20);
          for (yy = y; yy <= y + len + 40; yy += 44) { gx += (rnd() - 0.5) * 3.2 + Math.sin(yy * 0.0045 + ph) * amp; x.lineTo(gx, yy); }
          x.stroke();
        }
        if (rnd() < 0.3) {                                                   /* now and then a knot, with the grain bending round it */
          var kx = x0 + pw * (0.2 + rnd() * 0.6), ky = y + len * (0.15 + rnd() * 0.7), kr = 14 + rnd() * 22;
          for (k = 5; k >= 0; k--) { x.strokeStyle = 'rgba(70,40,16,' + (0.10 + 0.05 * (5 - k)) + ')'; x.lineWidth = 2; x.beginPath(); x.ellipse(kx, ky, kr * (0.45 + k * 0.32), kr * (0.8 + k * 0.5), 0, 0, Math.PI * 2); x.stroke(); }
          var grad = x.createRadialGradient(kx, ky, 1, kx, ky, kr); grad.addColorStop(0, 'rgba(48,26,10,.85)'); grad.addColorStop(1, 'rgba(48,26,10,0)');
          x.fillStyle = grad; x.beginPath(); x.ellipse(kx, ky, kr * 0.6, kr, 0, 0, Math.PI * 2); x.fill();
        }
        x.restore();
        x.fillStyle = 'rgba(38,22,9,.55)'; x.fillRect(x0, y + len - 2, pw, 3);          /* the joint between two boards */
        x.fillStyle = 'rgba(255,238,210,.10)'; x.fillRect(x0, y + len + 1, pw, 1.5);
        y += len;
      }
      x.fillStyle = 'rgba(34,19,8,.62)'; x.fillRect(x0 - 1.5, 0, 3, SIZE);              /* the gap between two rows */
      x.fillStyle = 'rgba(255,238,210,.12)'; x.fillRect(x0 + 1.5, 0, 1.5, SIZE);
    }
    try {                                                                   /* fine speckle, so it reads as a photo and not a drawing */
      var img = x.getImageData(0, 0, SIZE, SIZE), d = img.data, n = SIZE * SIZE;
      for (i = 0, k = 0; i < n; i++, k += 4) { var v = (rnd() - 0.5) * 16; d[k] += v; d[k + 1] += v; d[k + 2] += v * 0.9; }
      x.putImageData(img, 0, 0);
    } catch (e) { /* the grain is enough */ }
    var light = x.createLinearGradient(0, 0, SIZE, SIZE);                    /* light from the upper left */
    light.addColorStop(0, 'rgba(255,246,228,.16)'); light.addColorStop(0.5, 'rgba(255,246,228,0)'); light.addColorStop(1, 'rgba(26,14,5,.26)');
    x.fillStyle = light; x.fillRect(0, 0, SIZE, SIZE);
    var vig = x.createRadialGradient(SIZE * 0.45, SIZE * 0.45, SIZE * 0.35, SIZE / 2, SIZE / 2, SIZE * 0.8);
    vig.addColorStop(0, 'rgba(20,10,4,0)'); vig.addColorStop(1, 'rgba(20,10,4,.30)');
    x.fillStyle = vig; x.fillRect(0, 0, SIZE, SIZE);
    wood = c; return c;
  }

  /* The garment with every visible layer on it, in target pixels (pr per CSS px) for the part that can be
     seen (plus room for the shadow). Each layer is put on with 'source-atop', so it never leaves the cloth and
     the cloth keeps its own edge; a multiply or screen picture is first blended with the cloth on a scratch
     canvas. Returns { canvas, x, y, w, h } in the caller's units, or null. */
  var dress = null, blendScratch = null;
  function dressed(scale, ox, oy, pr, vw, vh, layers) {
    var pad = Math.min(256, Math.ceil(140 * scale * pr));
    var x0 = Math.max(Math.floor(ox * pr), -pad), y0 = Math.max(Math.floor(oy * pr), -pad);
    var x1 = Math.min(Math.ceil((ox + SIZE * scale) * pr), Math.ceil(vw * pr) + pad), y1 = Math.min(Math.ceil((oy + SIZE * scale) * pr), Math.ceil(vh * pr) + pad);
    if (x1 <= x0 || y1 <= y0) return null;
    var W = x1 - x0, H = y1 - y0;
    if (!dress) dress = document.createElement('canvas');
    if (dress.width !== W || dress.height !== H) { dress.width = W; dress.height = H; }
    var x = dress.getContext('2d'), k = scale * pr, tx = ox * pr - x0, ty = oy * pr - y0;
    function reset(c) { c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; }
    reset(x); x.clearRect(0, 0, W, H);
    x.setTransform(k, 0, 0, k, tx, ty);
    x.drawImage(blank.canvas, 0, 0, SIZE, SIZE);
    layers.forEach(function (p) {
      var alpha = isImage(p) ? clamp(p.opacity, 0, 100) / 100 : 1, mode = isImage(p) ? BLENDS[p.blend] || 'source-over' : 'source-over';
      if (alpha <= 0) return;
      if (mode === 'source-over') {
        x.globalCompositeOperation = 'source-atop'; x.globalAlpha = alpha; drawLayer(x, p);
        x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1;
        return;
      }
      if (!blendScratch) blendScratch = document.createElement('canvas');
      if (blendScratch.width !== W || blendScratch.height !== H) { blendScratch.width = W; blendScratch.height = H; }
      var b = blendScratch.getContext('2d');
      reset(b); b.clearRect(0, 0, W, H); b.drawImage(dress, 0, 0);
      b.setTransform(k, 0, 0, k, tx, ty); b.globalCompositeOperation = mode; b.globalAlpha = alpha; drawLayer(b, p);
      x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'source-atop'; x.drawImage(blendScratch, 0, 0);
      x.globalCompositeOperation = 'source-over'; x.setTransform(k, 0, 0, k, tx, ty);
    });
    reset(x);
    return { canvas: dress, x: x0 / pr, y: y0 / pr, w: W / pr, h: H / pr };
  }
  function visibleLayers() { return items().filter(function (p) { return !p.hidden && place(p); }); }

  /* scene: 'studio' (white), 'wood' (wooden floor) or null (nothing behind the garment: the transparent file).
     pr = target pixels per unit of c (the screen's pixel ratio, or 1 for a file); vw x vh = the target in those units. */
  function paint(c, scale, ox, oy, forFile, scene, pr, vw, vh) {
    c.save();
    if (scene === 'wood') {                             /* the floor is the picture: nothing, not even the shadow, falls outside it */
      c.beginPath(); c.rect(ox, oy, SIZE * scale, SIZE * scale); c.clip();
      c.drawImage(makeWood(), ox, oy, SIZE * scale, SIZE * scale);
    }
    if (scene !== 'wood' && forFile && scene === 'studio') { c.fillStyle = WHITE; c.fillRect(0, 0, SIZE * scale, SIZE * scale); }
    var bg = scene;
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    if (blank.canvas && blank.grey) {
      var layers = visibleLayers(), g = layers.length ? dressed(scale, ox, oy, pr || 1, vw || SIZE, vh || SIZE, layers) : null;
      var img = g ? g.canvas : blank.canvas, gx = g ? g.x : ox, gy = g ? g.y : oy, gw = g ? g.w : SIZE * scale, gh = g ? g.h : SIZE * scale;
      if (scene === 'wood') {
        /* lying on the floor in light from the upper left: a long soft shadow to the right and below, and a tight one where the cloth touches */
        c.save(); c.shadowColor = 'rgba(30,16,6,.50)'; c.shadowBlur = 80 * scale; c.shadowOffsetX = 52 * scale; c.shadowOffsetY = 38 * scale;
        c.drawImage(img, gx, gy, gw, gh); c.restore();
        c.save(); c.shadowColor = 'rgba(22,12,4,.45)'; c.shadowBlur = 16 * scale; c.shadowOffsetX = 12 * scale; c.shadowOffsetY = 9 * scale;
        c.drawImage(img, gx, gy, gw, gh); c.restore();
      } else {
        c.save();
        if (bg) { c.shadowColor = 'rgba(40,35,25,.20)'; c.shadowBlur = 36 * scale; c.shadowOffsetY = 14 * scale; }   /* a soft shadow on white; none in the transparent file */
        c.drawImage(img, gx, gy, gw, gh);
        c.restore();
      }
    }
    c.restore();
  }
  function colors() {
    var tok = window.EL && window.EL.token;
    return { signal: (tok && tok('--fabric-signal')) || '#3E78B2', ink: (tok && tok('--fabric-ink')) || '#2B2D31' };
  }
  function draw() {
    var cv = el.canvas; if (!cv || !open) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5), w = el.stage.clientWidth, h = el.stage.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    if (view.auto) fit(w, h);
    var c = cv.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint(c, view.scale, view.ox, view.oy, false, state.scene, dpr, w, h);
    drawSelection(c);
    if (el.zoom) el.zoom.textContent = Math.round(view.scale / fitScale(w, h) * 100) + '%';
  }
  /* the box, four corner squares and the round rotate handle, like the Design editor's selection */
  function drawSelection(c) {
    var list = Mock.handles(); if (!list.length) return;
    var col = colors(), hs = handleSize(), i, pts = list.slice(0, 4), rot = list[4];
    c.save();
    c.lineWidth = 1; c.strokeStyle = col.signal; c.setLineDash([]);
    c.beginPath(); c.moveTo(pts[0].x, pts[0].y); for (i = 1; i < 4; i++) c.lineTo(pts[i].x, pts[i].y); c.closePath(); c.stroke();
    c.beginPath(); c.moveTo(rot.from.x, rot.from.y); c.lineTo(rot.x, rot.y); c.stroke();
    c.fillStyle = WHITE; c.strokeStyle = col.signal; c.lineWidth = 1.5;
    c.beginPath(); c.arc(rot.x, rot.y, hs / 2 + 1, 0, Math.PI * 2); c.fill(); c.stroke();
    c.lineWidth = 1;
    for (i = 0; i < 4; i++) {
      var hx = Math.round(pts[i].x - hs / 2) + 0.5, hy = Math.round(pts[i].y - hs / 2) + 0.5;
      c.fillStyle = col.signal; c.fillRect(hx, hy, hs, hs);
      c.strokeStyle = col.ink; c.strokeRect(hx, hy, hs, hs);
    }
    c.restore();
  }
  function fitScale(w, h) { return Math.max(0.02, Math.min(w, h) / SIZE * 0.96); }
  function fit(w, h) { view.scale = fitScale(w, h); view.ox = (w - SIZE * view.scale) / 2; view.oy = (h - SIZE * view.scale) / 2; }
  function zoomAt(px, py, factor) {
    var w = el.stage.clientWidth, h = el.stage.clientHeight, base = fitScale(w, h), next = clamp(view.scale * factor, base * 0.5, base * 12);
    var k = next / view.scale; view.ox = px - (px - view.ox) * k; view.oy = py - (py - view.oy) * k; view.scale = next; view.auto = false; invalidate();
  }

  /* ---------- handles (screen px, relative to the canvas) --------------------------------- */
  function coarse() { return !!(V && V.coarse); }
  function handleSize() { return V && V.handleSize ? V.handleSize() : 7; }
  function toScreen(g) { return { x: view.ox + g.x * view.scale, y: view.oy + g.y * view.scale }; }
  function toPicture(px, py) { return { x: (px - view.ox) / view.scale, y: (py - view.oy) / view.scale }; }
  var CORNERS = [['nw', -1, -1], ['ne', 1, -1], ['se', 1, 1], ['sw', -1, 1]];
  /* nw, ne, se, sw, then the rotate handle { k: 'rot', from: top middle } */
  Mock.handles = function () {
    var p = selectedItem(); if (!p || p.hidden || !open) return [];
    var r = place(p); if (!r) return [];
    var out = CORNERS.map(function (k) { var s = toScreen(corner(r, k[1], k[2])); return { k: k[0], sx: k[1], sy: k[2], x: s.x, y: s.y }; });
    var top = toScreen(corner(r, 0, -1)), gap = coarse() ? 30 : 22;
    out.push({ k: 'rot', x: top.x + Math.sin(r.rot) * gap, y: top.y - Math.cos(r.rot) * gap, from: top });
    return out;
  };
  function handleAt(px, py) {
    var list = Mock.handles(), hs = handleSize(), best = null, bestD = Infinity;
    list.forEach(function (h) {
      var reach = hs / 2 + (h.k === 'rot' ? (coarse() ? 12 : 6) : (coarse() ? 8 : 3)), dx = Math.abs(px - h.x), dy = Math.abs(py - h.y);
      if (dx <= reach && dy <= reach && dx + dy < bestD) { bestD = dx + dy; best = h; }
    });
    return best;
  }
  function handleCursor(h) {
    if (h.k === 'rot') return ROT_CURSOR;
    var r = place(selectedItem()), deg = (Math.atan2(h.sy * r.h, h.sx * r.w) + r.rot) * 180 / Math.PI, i = ((Math.round(deg / 45) % 4) + 4) % 4;
    return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][i];
  }

  /* ---------- layers ------------------------------------------------------------------------ */
  function selectedItem() { var list = items(); for (var i = 0; i < list.length; i++) if (list[i].id === selected) return list[i]; return null; }
  function stored() {
    return { v: 1, garment: state.garment, side: state.side, color: state.color, scene: state.scene, placements: state.placements };
  }
  /* write now; if the pictures make it too big for localStorage, keep them in memory and say so once */
  function saveNow() {
    clearTimeout(saveTimer); saveTimer = 0;
    if (!window.EL) return;
    /* the open designs share this browser's storage: pictures may use at most STORE_BUDGET characters of it */
    var full = stored(), size = 0;
    try { size = JSON.stringify(full).length; } catch (e) { size = Infinity; }
    if (size <= STORE_BUDGET && window.EL.store.set(KEY, full)) return;
    /* keep the pictures that still fit in the budget (in order), the rest stay in memory */
    var lite = stored(), room = STORE_BUDGET - 4096; lite.placements = {};
    ['front', 'back'].forEach(function (s) { lite.placements[s] = (state.placements[s] || []).filter(function (p) { if (!isImage(p)) return true; if (p.src.length > room) return false; room -= p.src.length; return true; }); });
    if (!window.EL.store.set(KEY, lite)) {
      ['front', 'back'].forEach(function (s) { lite.placements[s] = lite.placements[s].filter(function (p) { return !isImage(p); }); });
      window.EL.store.set(KEY, lite);
    }
    if (!quotaWarned && ['front', 'back'].some(function (s) { return (state.placements[s] || []).some(isImage); })) {
      quotaWarned = true;
      toast('The pictures are too big to keep in this browser. They stay until you close the page.', { label: 'Mockup', timeout: 7000 });
    }
  }
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 250); }
  function hit(px, py) {
    var list = items(), g = toPicture(px, py);
    for (var i = list.length - 1; i >= 0; i--) { if (list[i].hidden) continue; var r = place(list[i]); if (r && inside(r, g.x, g.y)) return list[i]; }
    return null;
  }
  function findIndex(id) { var list = items(); for (var i = 0; i < list.length; i++) if (list[i].id === id) return i; return -1; }
  function changed(text) { save(); renderLists(); invalidate(); if (text) say(text); }

  Mock.add = function (tabId) {
    var tab = tabById(tabId); if (!tab) return Promise.resolve(null);
    if (!tab.shapes) { toast('"' + tab.name + '" has nothing to sew yet.', { kind: 'bad', label: 'Mockup' }); return Promise.resolve(null); }
    if (items().length >= MAX_LAYERS) { toast('This side has ' + MAX_LAYERS + ' layers already.', { label: 'Mockup' }); return Promise.resolve(null); }
    setBusy('Stitching ' + tab.name + '...');
    return prepare(tab).then(function (d) {
      setBusy('');
      if (!d) { if (designs[tab.id] && designs[tab.id].empty) toast('"' + tab.name + '" makes no stitches.', { kind: 'bad', label: 'Mockup' }); return null; }
      var n = items().filter(function (q) { return !isImage(q); }).length;
      var p = { id: newId(), kind: 'design', tab: tab.id, dx: (n % 3) * 18, dy: (n % 3) * 18, scale: 1, rot: 0, hidden: false };
      items().push(p); selected = p.id; changed(tab.name + ' placed on the ' + state.side);
      return p;
    });
  };
  Mock.remove = function (id) {
    var list = items(), i = findIndex(id);
    if (i < 0) return;
    list.splice(i, 1); delete pics[id];
    if (selected === id) selected = list.length ? list[Math.max(0, i - 1)].id : null;     /* the layer that was under it */
    changed();
  };
  Mock.select = function (id) { selected = findIndex(id) >= 0 ? id : null; renderLists(); invalidate(); };
  Mock.selected = function () { return selected; };
  /* delta: +1 up (drawn later, over more), -1 down, or 'top' / 'bottom' */
  Mock.moveLayer = function (id, delta) {
    var list = items(), i = findIndex(id); if (i < 0) return false;
    var j = delta === 'top' ? list.length - 1 : delta === 'bottom' ? 0 : clamp(i + delta, 0, list.length - 1);
    if (j === i) return false;
    var p = list.splice(i, 1)[0]; list.splice(j, 0, p);
    changed(j > i ? 'Moved up' : 'Moved down');
    return true;
  };
  /* ids top first, as the Layers list shows them */
  Mock.reorder = function (topFirst) {
    var list = items(), byId = {};
    list.forEach(function (p) { byId[p.id] = p; });
    var next = topFirst.slice().reverse().map(function (id) { return byId[id]; }).filter(Boolean);
    if (next.length !== list.length) return false;
    list.length = 0; Array.prototype.push.apply(list, next);
    changed();
    return true;
  };
  Mock.setLayer = function (id, props) {
    var p = items()[findIndex(id)]; if (!p) return null;
    if ('rot' in props) p.rot = normRot(props.rot);
    if ('scale' in props) p.scale = clamp(+props.scale || 1, MIN_SCALE, MAX_SCALE);
    if ('dx' in props) p.dx = clamp(+props.dx || 0, -600, 600);
    if ('dy' in props) p.dy = clamp(+props.dy || 0, -700, 900);
    if ('hidden' in props) p.hidden = !!props.hidden;
    if (isImage(p) && 'opacity' in props) p.opacity = clamp(Math.round(+props.opacity), 0, 100) || 0;
    if (isImage(p) && 'blend' in props && BLENDS[props.blend]) p.blend = props.blend;
    changed();
    return p;
  };
  Mock.layers = function () {
    return items().map(function (p) {
      var o = {}; for (var k in p) if (k !== 'src') o[k] = p[k];
      if (isImage(p)) { var e = pics[p.id]; o.px = e && e.ready ? [e.img.naturalWidth, e.img.naturalHeight] : null; o.srcType = (/^data:([^;,]+)/.exec(p.src) || [])[1]; }
      o.ready = !!place(p);
      return o;
    });
  };
  function rotateSelected(by) {
    var s = selectedItem(); if (!s) return;
    s.rot = normRot((s.rot || 0) + by); save(); renderProps(); invalidate();
    say('Rotation ' + Math.round(s.rot) + ' degrees');
  }

  /* ---------- panels ---------------------------------------------------------------------- */
  function setBusy(text) { if (el.busy) { el.busy.textContent = text; el.busy.hidden = !text; } }
  function pressed(nodes, attr, value) { nodes.forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute(attr) === value ? 'true' : 'false'); }); }
  function sync(s) { if (window.EL && window.EL.syncSlider) window.EL.syncSlider(s); }
  function renderControls() {
    pressed(el.garmentBtns, 'data-garment', state.garment); pressed(el.sideBtns, 'data-side', state.side); pressed(el.sceneBtns, 'data-scene', state.scene);
    var rgb = hexToRgb(state.color), hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    el.color.value = state.color; el.hex.textContent = state.color.toUpperCase(); el.swatch.style.setProperty('--c', state.color);
    if (document.activeElement !== el.hue) el.hue.value = hsl[0];
    if (document.activeElement !== el.sat) el.sat.value = hsl[1];
    if (document.activeElement !== el.light) el.light.value = hsl[2];
    [el.hue, el.sat, el.light].forEach(sync);
    el.hueVal.textContent = el.hue.value + '°'; el.satVal.textContent = el.sat.value + '%'; el.lightVal.textContent = el.light.value + '%';
    Array.prototype.forEach.call(el.chips.children, function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-color').toLowerCase() === state.color.toLowerCase() ? 'true' : 'false'); });
  }
  function sizeText(p) {
    var mm = isImage(p) ? { w: p.mmW, h: p.mmH } : designs[p.tab] && designs[p.tab].mm;
    if (!mm || !Editor.Units) return '';
    return Editor.Units.sizeShort(mm.w * p.scale, mm.h * p.scale) + ' ' + Editor.Units.label();
  }
  function layerName(p) { if (isImage(p)) return p.name || 'Picture'; var d = designs[p.tab], t = d ? null : tabById(p.tab); return (d && d.name) || (t && t.name) || 'Design'; }
  var EYE_ON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6s1.8-3.5 5-3.5S11 6 11 6 9.2 9.5 6 9.5 1 6 1 6z"/><circle cx="6" cy="6" r="1.5"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6s1.8-3.5 5-3.5S11 6 11 6 9.2 9.5 6 9.5 1 6 1 6zM2 10 10 2"/></svg>';
  function thumb(p) {
    var c = document.createElement('canvas'), n = 56; c.width = n; c.height = n; c.className = 'mock__thumb'; c.setAttribute('aria-hidden', 'true');
    var src = source(p);
    if (src) {
      var sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight, k = Math.min(n / sw, n / sh) * 0.9, x = c.getContext('2d');
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      x.drawImage(src, (n - sw * k) / 2, (n - sh * k) / 2, sw * k, sh * k);
    }
    return c;
  }
  function renderLists() {
    if (!el.layers) return;
    var list = items(), frag = document.createDocumentFragment(), i;
    for (i = list.length - 1; i >= 0; i--) {                              /* top layer first */
      var p = list[i], d = !isImage(p) && designs[p.tab], row = document.createElement('div');
      row.className = 'mock__item' + (p.hidden ? ' is-hidden' : ''); row.setAttribute('role', 'option'); row.setAttribute('aria-selected', p.id === selected ? 'true' : 'false');
      row.setAttribute('data-item', p.id); row.tabIndex = p.id === selected || (!selected && i === list.length - 1) ? 0 : -1;
      var grip = document.createElement('span'); grip.className = 'mock__grip'; grip.setAttribute('aria-hidden', 'true');
      grip.innerHTML = '<svg viewBox="0 0 8 12"><circle cx="2" cy="2" r="1"/><circle cx="6" cy="2" r="1"/><circle cx="2" cy="6" r="1"/><circle cx="6" cy="6" r="1"/><circle cx="2" cy="10" r="1"/><circle cx="6" cy="10" r="1"/></svg>';
      var name = document.createElement('span'); name.className = 'name'; name.textContent = layerName(p);
      row.title = sizeText(p);
      row.appendChild(grip); row.appendChild(thumb(p)); row.appendChild(name);
      if (d && d.busy) { var busy = document.createElement('span'); busy.className = 'num'; busy.textContent = 'stitching...'; row.appendChild(busy); }
      var eye = document.createElement('button'); eye.type = 'button'; eye.className = 'mini mock__eye'; eye.setAttribute('data-eye', p.id);
      eye.setAttribute('aria-pressed', p.hidden ? 'false' : 'true'); eye.setAttribute('aria-label', p.hidden ? 'Show' : 'Hide'); eye.title = p.hidden ? 'Show' : 'Hide';
      eye.innerHTML = p.hidden ? EYE_OFF : EYE_ON;
      var x = document.createElement('button'); x.type = 'button'; x.className = 'mini'; x.setAttribute('aria-label', 'Delete layer'); x.title = 'Delete'; x.setAttribute('data-remove', p.id);
      x.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
      row.appendChild(eye); row.appendChild(x); frag.appendChild(row);
    }
    var focused = document.activeElement && el.layers.contains(document.activeElement) ? document.activeElement.getAttribute('data-item') : null;
    el.layers.textContent = ''; el.layers.appendChild(frag);
    if (focused) { var back = el.layers.querySelector('[data-item="' + focused + '"]'); if (back) back.focus({ preventScroll: true }); }
    el.layersEmpty.hidden = list.length > 0;
    el.sideName.textContent = state.side === 'front' ? 'Front' : 'Back';

    var all = tabs(), f2 = document.createDocumentFragment();
    all.forEach(function (t) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn--block mock__add'; b.setAttribute('data-add', t.id);
      var nm = document.createElement('span'); nm.textContent = t.name || 'untitled';
      var hint = document.createElement('small'); hint.textContent = t.shapes ? 'Add' : 'Empty';
      b.appendChild(nm); b.appendChild(hint);
      if (!t.shapes) b.setAttribute('aria-disabled', 'true');
      f2.appendChild(b);
    });
    el.adds.textContent = ''; el.adds.appendChild(f2);
    renderProps();
  }
  /* the controls of the picked layer */
  function renderProps() {
    if (!el.scale) return;
    var sel = selectedItem(), img = isImage(sel), active = document.activeElement;
    el.props.classList.toggle('is-off', !sel);
    [el.scaleRow, el.rotRow].forEach(function (r) { r.classList.toggle('is-off', !sel); });
    el.scale.disabled = !sel; el.rot.disabled = !sel; el.rotNum.disabled = !sel;
    el.scale.value = sel ? Math.round(sel.scale * 100) : 100; sync(el.scale);
    el.scaleVal.textContent = (sel ? Math.round(sel.scale * 100) : 100) + '%';
    var r = sel ? sel.rot || 0 : 0;
    el.rot.value = Math.round(r); sync(el.rot);
    if (active !== el.rotNum) el.rotNum.value = Math.round(r * 10) / 10;
    el.rotReset.disabled = !sel || !r;
    el.trueSize.hidden = img; el.trueSize.disabled = !sel || sel.scale === 1;
    el.imgProps.hidden = !img;
    if (img) {
      el.opacity.value = sel.opacity; sync(el.opacity); el.opacityVal.textContent = sel.opacity + '%';
      pressed(el.blendBtns, 'data-blend', sel.blend || 'normal');
    }
    var can = items().some(function (p) { return !isImage(p) && !p.hidden && designs[p.tab] && designs[p.tab].canvas; });
    if (el.dlThread) el.dlThread.setAttribute('aria-disabled', can ? 'false' : 'true');
  }

  /* ---------- files ------------------------------------------------------------------------- */
  function fileBase() {
    var sel = selectedItem(), list = items(), first = null, i;
    if (sel && !isImage(sel)) first = sel; else for (i = list.length - 1; i >= 0 && !first; i--) if (!isImage(list[i])) first = list[i];
    var d = first && designs[first.tab];
    return String((d && d.name) || M.doc.name || 'design').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim() || 'design';
  }
  function settle() {
    var waits = Object.keys(designs).map(function (k) { return designs[k].promise || null; });
    items().forEach(function (p) {
      if (!isImage(p)) return;
      var e = pic(p);
      if (!e.ready && !e.failed) waits.push(new Promise(function (res) { e.img.addEventListener('load', res); e.img.addEventListener('error', res); setTimeout(res, 4000); }));
    });
    return Promise.all(waits);
  }
  function toBlob(c) { return new Promise(function (res) { c.toBlob(function (b) { res(b); }, 'image/png'); }); }
  /* the 2000 x 2000 picture. transparent = false: in the scene shown (white or wood). true: nothing behind the garment. */
  Mock.renderImage = function (transparent) {
    var c = document.createElement('canvas'); c.width = SIZE; c.height = SIZE;
    paint(c.getContext('2d'), 1, 0, 0, true, transparent ? null : state.scene, 1, SIZE, SIZE);
    return c;
  };
  Mock.downloadImage = function (transparent) {
    if (!blank.grey) { toast('The garment is still loading.', { kind: 'bad', label: 'Mockup' }); return Promise.resolve(false); }
    setBusy('Making the picture...');
    return settle().then(function () { return toBlob(Mock.renderImage(transparent)); }).then(function (blob) {
      setBusy('');
      if (!blob) { toast('The picture could not be made.', { kind: 'bad', label: 'Mockup' }); return false; }
      var name = fileBase() + '-' + state.garment + '-' + state.side + (transparent ? '-transparent' : state.scene === 'wood' ? '-wood' : '') + '.png';
      window.EL.download(name, blob, 'image/png');
      toast(name + ' downloaded, ' + (transparent ? 'with a transparent background' : state.scene === 'wood' ? 'on the wood floor' : 'on a white background') + ' (' + SIZE + ' x ' + SIZE + ' px).', { kind: 'ok', label: 'Mockup', timeout: 6000 });
      return true;
    });
  };
  /* the visible embroidery layers alone, as placed (order, size, rotation), on nothing; cropped to the thread */
  Mock.renderStitching = function () {
    var list = items().filter(function (p) { return !isImage(p) && !p.hidden && place(p); });
    if (!list.length) return Promise.resolve(null);
    return Promise.all(list.map(function (p) { return hiRes(designs[p.tab]); })).then(function (hi) {
      hi = hi.filter(function (h, i) { return !!place(list[i]); });
      list = list.filter(function (p) { return !!place(p); });
      if (!list.length) return null;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, k = 1, g = garment();
      list.forEach(function (p, i) {
        var r = place(p);
        CORNERS.forEach(function (q) { var pt = corner(r, q[1], q[2]); minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y); maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y); });
        k = Math.max(k, hi[i].ppm / (g.pxPerMm * p.scale));
      });
      var bw = maxX - minX, bh = maxY - minY; k = Math.min(k, 4000 / Math.max(bw, bh));
      var W = Math.max(1, Math.ceil(bw * k)), H = Math.max(1, Math.ceil(bh * k));
      var c = document.createElement('canvas'); c.width = W; c.height = H;
      var x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      x.setTransform(k, 0, 0, k, -minX * k, -minY * k);
      list.forEach(function (p, i) { drawLayer(x, p, hi[i].canvas); });
      /* crop to the thread, with a little room */
      var d = x.getImageData(0, 0, W, H).data, x0 = W, y0 = H, x1 = -1, y1 = -1, xx, yy;
      for (yy = 0; yy < H; yy++) for (xx = 0; xx < W; xx++) if (d[(yy * W + xx) * 4 + 3] > 8) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
      if (x1 < 0) return null;
      var m = Math.round(Math.max(x1 - x0, y1 - y0) * 0.03) + 2;
      x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(W - 1, x1 + m); y1 = Math.min(H - 1, y1 + m);
      var out = document.createElement('canvas'); out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
      out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
      return out;
    });
  };
  Mock.downloadStitching = function () {
    var any = items().some(function (p) { return !isImage(p) && !p.hidden && place(p); });
    if (!any) { toast('Place a design on the garment first.', { kind: 'bad', label: 'Mockup' }); return Promise.resolve(false); }
    setBusy('Drawing the thread...');
    return settle().then(Mock.renderStitching).then(function (c) { return c ? toBlob(c).then(function (b) { return { blob: b, c: c }; }) : null; }).then(function (r) {
      setBusy('');
      if (!r || !r.blob) { toast('The stitching could not be drawn.', { kind: 'bad', label: 'Mockup' }); return false; }
      var name = fileBase() + '-stitching.png';
      window.EL.download(name, r.blob, 'image/png');
      toast(name + ' downloaded: the thread on a clear background (' + r.c.width + ' x ' + r.c.height + ' px).', { kind: 'ok', label: 'Mockup', timeout: 6000 });
      return true;
    }, function () { setBusy(''); toast('The stitching could not be drawn.', { kind: 'bad', label: 'Mockup' }); return false; });
  };

  /* ---------- open / close --------------------------------------------------------------------- */
  Mock.isOpen = function () { return open; };
  Mock.open = function () {
    if (!el.root) return Promise.resolve(false);
    if (Editor.Tools) Editor.Tools.cancel();
    if (Editor.IO) Editor.IO.saveNow();
    open = true; view.auto = true;
    el.app.classList.add('is-mock'); el.root.hidden = false;
    if (el.toggle) el.toggle.setAttribute('aria-pressed', 'true');
    if (Editor.Tabs) Editor.Tabs.render();
    renderControls(); renderLists(); invalidate();
    Editor.emit('mockup');
    say('Mockup view');
    var first = !state.placements.front.length && !state.placements.back.length;
    return Promise.all([loadBlank(), prepareAll()]).then(function () {
      renderLists(); invalidate();
      var cur = tabs().filter(function (t) { return t.active; })[0];
      if (first && cur && cur.shapes) return Mock.add(cur.id);
      return null;
    }).then(function () { return true; });
  };
  Mock.close = function () {
    if (!open) return;
    open = false;
    if (saveTimer) saveNow();
    el.app.classList.remove('is-mock'); el.root.hidden = true;
    if (el.toggle) el.toggle.setAttribute('aria-pressed', 'false');
    if (Editor.Tabs) Editor.Tabs.render();
    Editor.emit('mockup');
    V.resize();
  };
  Mock.toggle = function () { if (open) Mock.close(); else Mock.open(); };
  Mock.state = function () { return JSON.parse(JSON.stringify(state)); };
  Mock.saveNow = saveNow;

  function setGarmentSide(g, s) {
    var fabricChanged = g && g !== state.garment;
    if (g && GARMENTS[g]) state.garment = g;
    if (s === 'front' || s === 'back') { state.side = s; selected = null; }
    save(); renderControls(); renderLists();
    loadBlank().then(function () { invalidate(); });
    (fabricChanged ? prepareAll() : Promise.resolve()).then(function () { renderLists(); invalidate(); });
    invalidate();
  }
  function setColor(hex, fromSliders) {
    state.color = rgbToHex.apply(null, hexToRgb(hex)); save(); recolorSoon();
    if (!fromSliders) renderControls(); else { el.color.value = state.color; el.hex.textContent = state.color.toUpperCase(); el.swatch.style.setProperty('--c', state.color); el.hueVal.textContent = el.hue.value + '°'; el.satVal.textContent = el.sat.value + '%'; el.lightVal.textContent = el.light.value + '%'; Array.prototype.forEach.call(el.chips.children, function (b) { b.setAttribute('aria-pressed', 'false'); }); }
  }
  /* a stored layer -> a clean one, or null. Older states have no kind, rotation or visibility. */
  function cleanLayer(p) {
    if (!p || !isFinite(p.dx) || !isFinite(p.dy) || !isFinite(p.scale)) return null;
    /* ids go into attribute selectors: keep them to plain characters */
    var id = String(p.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || newId();
    var o = { id: id, dx: clamp(+p.dx, -600, 600), dy: clamp(+p.dy, -700, 900), scale: clamp(+p.scale, MIN_SCALE, MAX_SCALE), rot: normRot(isFinite(p.rot) ? +p.rot : 0), hidden: !!p.hidden };
    if (p.kind === 'image') {
      if (typeof p.src !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p.src)) return null;
      o.kind = 'image'; o.src = p.src; o.name = String(p.name || 'Picture').slice(0, 60);
      o.mmW = isFinite(p.mmW) ? clamp(+p.mmW, 1, 600) : IMG_MM; o.mmH = isFinite(p.mmH) ? clamp(+p.mmH, 1, 600) : IMG_MM;
      o.opacity = isFinite(p.opacity) ? clamp(Math.round(+p.opacity), 0, 100) : 100; o.blend = BLENDS[p.blend] ? p.blend : 'normal';
      return o;
    }
    if (typeof p.tab !== 'string') return null;
    o.kind = 'design'; o.tab = p.tab;
    return o;
  }
  function typing(t) {
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable) return true;
    var tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !/^(range|color|checkbox|radio|button|file)$/i.test(t.type || 'text');
    return false;
  }

  Mock.init = function () {
    el.root = $('mock'); el.app = $('app'); if (!el.root || !el.app) return;
    el.stage = $('mock-stage'); el.canvas = $('mock-canvas'); el.busy = $('mock-busy'); el.zoom = $('mock-zoom'); el.toggle = $('btn-mockup');
    el.garmentBtns = Array.prototype.slice.call(el.root.querySelectorAll('[data-garment]'));
    el.sideBtns = Array.prototype.slice.call(el.root.querySelectorAll('[data-side]'));
    el.sceneBtns = Array.prototype.slice.call(el.root.querySelectorAll('[data-scene]'));
    el.blendBtns = Array.prototype.slice.call(el.root.querySelectorAll('[data-blend]'));
    el.color = $('mock-color'); el.hex = $('mock-hex'); el.swatch = $('mock-swatch'); el.chips = $('mock-chips');
    el.hue = $('mock-hue'); el.sat = $('mock-sat'); el.light = $('mock-light'); el.hueVal = $('mock-hue-value'); el.satVal = $('mock-sat-value'); el.lightVal = $('mock-light-value');
    el.layers = $('mock-layers'); el.layersEmpty = $('mock-layers-empty'); el.sideName = $('mock-side-name'); el.adds = $('mock-adds');
    el.props = $('mock-props'); el.scaleRow = $('mock-scale-row'); el.scale = $('mock-scale'); el.scaleVal = $('mock-scale-value'); el.trueSize = $('mock-true-size');
    el.rotRow = $('mock-rot-row'); el.rot = $('mock-rot'); el.rotNum = $('mock-rot-value'); el.rotReset = $('mock-rot-reset');
    el.imgProps = $('mock-img-props'); el.opacity = $('mock-opacity'); el.opacityVal = $('mock-opacity-value');
    el.addImage = $('mock-add-image'); el.imageFile = $('mock-image-file');
    el.dlImage = $('mock-download'); el.dlMore = $('mock-download-more'); el.dlMenu = $('mock-download-menu'); el.dlGroup = $('mock-dl-group');
    el.dlThread = el.dlMenu ? el.dlMenu.querySelector('[data-dl="thread"]') : null;

    var saved = null;
    try { saved = window.EL.store.get(KEY, null); } catch (e) { saved = null; }
    if (saved && saved.v === 1) {
      if (GARMENTS[saved.garment]) state.garment = saved.garment;
      if (saved.side === 'front' || saved.side === 'back') state.side = saved.side;
      if (/^#[0-9a-f]{6}$/i.test(saved.color)) state.color = saved.color;
      if (saved.scene === 'wood' || saved.scene === 'studio') state.scene = saved.scene;
      ['front', 'back'].forEach(function (s) {
        var list = saved.placements && Array.isArray(saved.placements[s]) ? saved.placements[s] : [], seen = {};
        state.placements[s] = list.slice(0, MAX_LAYERS).map(cleanLayer).filter(function (p) { if (!p || seen[p.id]) return false; seen[p.id] = 1; return true; });
      });
    }

    COLORS.forEach(function (c) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'mock__chip'; b.setAttribute('data-color', c[1]); b.setAttribute('aria-label', c[0]); b.title = c[0]; b.setAttribute('aria-pressed', 'false');
      b.style.setProperty('--c', c[1]); el.chips.appendChild(b);
    });
    el.chips.addEventListener('click', function (e) { var b = e.target.closest ? e.target.closest('[data-color]') : null; if (b) setColor(b.getAttribute('data-color')); });
    el.color.addEventListener('input', function () { setColor(el.color.value); });
    function fromSliders() { var rgb = hslToRgb(+el.hue.value, +el.sat.value, +el.light.value); setColor(rgbToHex(rgb[0], rgb[1], rgb[2]), true); }
    [el.hue, el.sat, el.light].forEach(function (s) { s.addEventListener('input', fromSliders); });
    el.garmentBtns.forEach(function (b) { b.addEventListener('click', function () { setGarmentSide(b.getAttribute('data-garment'), null); }); });
    el.sideBtns.forEach(function (b) { b.addEventListener('click', function () { setGarmentSide(null, b.getAttribute('data-side')); }); });
    el.sceneBtns.forEach(function (b) { b.addEventListener('click', function () { state.scene = b.getAttribute('data-scene') === 'wood' ? 'wood' : 'studio'; save(); renderControls(); invalidate(); }); });

    /* ---- the Layers list: click to pick, eye, delete, drag to reorder */
    var rowDrag = null, justDragged = false;
    el.layers.addEventListener('click', function (e) {
      if (justDragged) return;
      var x = e.target.closest ? e.target.closest('[data-remove]') : null;
      if (x) { Mock.remove(x.getAttribute('data-remove')); return; }
      var eye = e.target.closest ? e.target.closest('[data-eye]') : null;
      if (eye) { var p = items()[findIndex(eye.getAttribute('data-eye'))]; if (p) Mock.setLayer(p.id, { hidden: !p.hidden }); return; }
      var row = e.target.closest ? e.target.closest('[data-item]') : null;
      if (row) { Mock.select(row.getAttribute('data-item')); var again = el.layers.querySelector('[data-item="' + selected + '"]'); if (again) again.focus({ preventScroll: true }); }
    });
    el.layers.addEventListener('keydown', function (e) {
      var row = e.target.closest ? e.target.closest('[data-item]') : null; if (!row || e.target !== row) return;
      var rows = Array.prototype.slice.call(el.layers.querySelectorAll('[data-item]')), i = rows.indexOf(row), k = e.key;
      if (k === 'Enter' || k === ' ') { e.preventDefault(); Mock.select(row.getAttribute('data-item')); var r2 = el.layers.querySelector('[data-item="' + selected + '"]'); if (r2) r2.focus(); }
      else if ((k === 'ArrowDown' || k === 'ArrowUp') && !e.altKey) { e.preventDefault(); var n = rows[clamp(i + (k === 'ArrowDown' ? 1 : -1), 0, rows.length - 1)]; if (n) { Mock.select(n.getAttribute('data-item')); var r3 = el.layers.querySelector('[data-item="' + selected + '"]'); if (r3) r3.focus(); } }
      else if ((k === 'ArrowDown' || k === 'ArrowUp') && e.altKey) { e.preventDefault(); Mock.moveLayer(row.getAttribute('data-item'), k === 'ArrowUp' ? 1 : -1); }
      else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); Mock.remove(row.getAttribute('data-item')); var f = el.layers.querySelector('[data-item="' + selected + '"]'); if (f) f.focus(); }
    });
    el.layers.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;
      var row = e.target.closest ? e.target.closest('[data-item]') : null;
      if (!row || e.target.closest('button')) return;
      if (e.pointerType === 'touch' && !e.target.closest('.mock__grip')) return;   /* on touch the grip drags, the rest scrolls */
      rowDrag = { row: row, id: row.getAttribute('data-item'), y0: e.clientY, pid: e.pointerId, moving: false, to: -1 };
      if (e.pointerType === 'touch') e.preventDefault();
    });
    function clearMarks() { Array.prototype.forEach.call(el.layers.querySelectorAll('.drop-before, .drop-after'), function (r) { r.classList.remove('drop-before', 'drop-after'); }); }
    window.addEventListener('pointermove', function (e) {
      if (!rowDrag || e.pointerId !== rowDrag.pid) return;
      var dy = e.clientY - rowDrag.y0;
      if (!rowDrag.moving) {
        if (Math.abs(dy) < 4) return;
        rowDrag.moving = true; rowDrag.row.classList.add('is-drag'); el.layers.classList.add('is-sorting');
        try { rowDrag.row.setPointerCapture(e.pointerId); } catch (x) { /* synthetic */ }
      }
      rowDrag.row.style.transform = 'translateY(' + dy + 'px)';
      var others = Array.prototype.slice.call(el.layers.querySelectorAll('[data-item]')).filter(function (r) { return r !== rowDrag.row; }), to = 0;
      others.forEach(function (r) { var b = r.getBoundingClientRect(); if (e.clientY > b.top + b.height / 2) to++; });
      rowDrag.to = to; clearMarks();
      if (others.length) { if (to < others.length) others[to].classList.add('drop-before'); else others[others.length - 1].classList.add('drop-after'); }
      e.preventDefault();
    });
    function endRowDrag(e) {
      if (!rowDrag || (e && e.pointerId !== rowDrag.pid)) return;
      var d = rowDrag; rowDrag = null;
      if (!d.moving) return;
      clearMarks(); el.layers.classList.remove('is-sorting'); d.row.classList.remove('is-drag'); d.row.style.transform = '';
      justDragged = true; setTimeout(function () { justDragged = false; }, 0);
      if (e && e.type === 'pointercancel') return;
      var ids = Array.prototype.slice.call(el.layers.querySelectorAll('[data-item]')).map(function (r) { return r.getAttribute('data-item'); }).filter(function (id) { return id !== d.id; });
      ids.splice(d.to, 0, d.id);
      selected = d.id; Mock.reorder(ids);
      var r = el.layers.querySelector('[data-item="' + d.id + '"]'); if (r) r.focus({ preventScroll: true });
    }
    window.addEventListener('pointerup', endRowDrag); window.addEventListener('pointercancel', endRowDrag);

    el.adds.addEventListener('click', function (e) { var b = e.target.closest ? e.target.closest('[data-add]') : null; if (b) Mock.add(b.getAttribute('data-add')); });
    el.addImage.addEventListener('click', function () { el.imageFile.click(); });
    function addFiles(files) {
      var list = Array.prototype.slice.call(files || []), pictures = list.filter(isPicture).slice(0, 8);
      if (list.length && !pictures.length) { toast('Pick a PNG, JPG, WebP or SVG picture.', { label: 'Mockup' }); return Promise.resolve([]); }
      return pictures.reduce(function (chain, f) { return chain.then(function (out) { return Mock.addImage(f).then(function (p) { if (p) out.push(p); return out; }); }); }, Promise.resolve([]));
    }
    el.imageFile.addEventListener('change', function () { var f = el.imageFile.files; addFiles(f).then(function () { el.imageFile.value = ''; }); });
    /* a picture dropped on the garment becomes a layer */
    function hasFiles(e) { var t = e.dataTransfer && e.dataTransfer.types; if (!t) return false; for (var i = 0; i < t.length; i++) if (t[i] === 'Files') return true; return false; }
    var dropDepth = 0;
    el.stage.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; e.preventDefault(); dropDepth++; el.stage.classList.add('is-over'); });
    el.stage.addEventListener('dragover', function (e) { if (!hasFiles(e)) return; e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch (x) { /* read-only */ } });
    el.stage.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; dropDepth = Math.max(0, dropDepth - 1); if (!dropDepth) el.stage.classList.remove('is-over'); });
    el.stage.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); e.stopPropagation(); dropDepth = 0; el.stage.classList.remove('is-over');
      addFiles(e.dataTransfer.files);
    });

    /* ---- the picked layer's controls */
    el.scale.addEventListener('input', function () {
      var s = selectedItem(); if (!s) return;
      s.scale = clamp(+el.scale.value / 100, MIN_SCALE, MAX_SCALE); el.scaleVal.textContent = el.scale.value + '%'; el.trueSize.disabled = s.scale === 1; save(); invalidate();
      var row = el.layers.querySelector('[data-item="' + s.id + '"]'); if (row) row.title = sizeText(s);
    });
    el.trueSize.addEventListener('click', function () { var s = selectedItem(); if (!s) return; s.scale = 1; changed(); });
    el.rot.addEventListener('input', function () { var s = selectedItem(); if (!s) return; s.rot = normRot(+el.rot.value); el.rotNum.value = s.rot; el.rotReset.disabled = !s.rot; save(); invalidate(); });
    function fromRotNum() { var s = selectedItem(), v = parseFloat(el.rotNum.value); if (!s || !isFinite(v)) return; s.rot = normRot(v); el.rot.value = Math.round(s.rot); sync(el.rot); el.rotReset.disabled = !s.rot; save(); invalidate(); }
    el.rotNum.addEventListener('input', fromRotNum);
    el.rotNum.addEventListener('change', function () { fromRotNum(); renderProps(); });
    el.rotNum.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); fromRotNum(); el.rotNum.blur(); renderProps(); } });
    el.rotReset.addEventListener('click', function () { var s = selectedItem(); if (!s) return; s.rot = 0; save(); renderProps(); invalidate(); });
    el.opacity.addEventListener('input', function () { var s = selectedItem(); if (!isImage(s)) return; s.opacity = clamp(Math.round(+el.opacity.value), 0, 100); el.opacityVal.textContent = s.opacity + '%'; save(); invalidate(); });
    el.blendBtns.forEach(function (b) { b.addEventListener('click', function () { var s = selectedItem(); if (!isImage(s)) return; s.blend = BLENDS[b.getAttribute('data-blend')] ? b.getAttribute('data-blend') : 'normal'; pressed(el.blendBtns, 'data-blend', s.blend); save(); invalidate(); }); });

    /* ---- downloads */
    el.dlImage.addEventListener('click', function () { Mock.downloadImage(false); });
    /* the arrow beside it: the same picture without a background, or the thread alone */
    var menuOpen = false;
    function closeMenu(focusBack) { if (!menuOpen) return; menuOpen = false; el.dlMenu.hidden = true; el.dlMore.setAttribute('aria-expanded', 'false'); if (focusBack) el.dlMore.focus(); }
    el.dlMore.addEventListener('click', function () {
      if (menuOpen) { closeMenu(false); return; }
      menuOpen = true; el.dlMenu.hidden = false; el.dlMore.setAttribute('aria-expanded', 'true');
      var first = el.dlMenu.querySelector('button'); if (first) first.focus();
    });
    el.dlMenu.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-dl]') : null; if (!b) return;
      var kind = b.getAttribute('data-dl');
      if (kind === 'thread' && b.getAttribute('aria-disabled') === 'true') { toast('Place a design on the garment first.', { kind: 'bad', label: 'Mockup' }); return; }
      closeMenu(false);
      if (kind === 'thread') Mock.downloadStitching(); else Mock.downloadImage(kind === 'transparent');
    });
    el.dlMenu.addEventListener('keydown', function (e) {
      var list = Array.prototype.slice.call(el.dlMenu.querySelectorAll('button')), i = list.indexOf(document.activeElement), k = e.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); list[(i + (k === 'ArrowDown' ? 1 : list.length - 1)) % list.length].focus(); }
      else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
      else if (k === 'Tab') closeMenu(false);
    });
    document.addEventListener('pointerdown', function (e) { if (menuOpen && !el.dlGroup.contains(e.target)) closeMenu(false); }, true);
    if (el.toggle) el.toggle.addEventListener('click', Mock.toggle);
    Array.prototype.forEach.call(document.querySelectorAll('[data-mock-zoom]'), function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-mock-zoom');
        if (k === 'fit') { view.auto = true; invalidate(); } else zoomAt(el.stage.clientWidth / 2, el.stage.clientHeight / 2, k === 'in' ? 1.4 : 1 / 1.4);
      });
    });

    /* ---- pointer on the garment: a handle resizes or turns, inside moves, outside pans */
    var drag = null;
    function local(e) { var r = el.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    el.canvas.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button > 1) return;
      var p = local(e), hnd = e.button === 1 ? null : handleAt(p.x, p.y), h = hnd || e.button === 1 ? null : hit(p.x, p.y);
      if (hnd) {
        var item = selectedItem(), r = place(item), g = toPicture(p.x, p.y);
        drag = hnd.k === 'rot'
          ? { mode: 'rot', item: item, r: r, x: p.x, y: p.y, a0: Math.atan2(g.y - r.cy, g.x - r.cx), rot0: item.rot || 0, moved: false }
          : { mode: 'scale', item: item, r: r, x: p.x, y: p.y, sx: hnd.sx, sy: hnd.sy, s0: item.scale, moved: false };
        el.canvas.style.cursor = handleCursor(hnd);
      } else if (h) { selected = h.id; drag = { mode: 'move', item: h, x: p.x, y: p.y, dx: h.dx, dy: h.dy, moved: false }; renderLists(); }
      else { drag = { mode: 'pan', x: p.x, y: p.y, ox: view.ox, oy: view.oy, moved: false, had: selected }; }
      try { el.canvas.setPointerCapture(e.pointerId); } catch (x) { /* synthetic pointer */ }
      el.canvas.focus({ preventScroll: true }); invalidate(); e.preventDefault();
    });
    el.canvas.addEventListener('pointermove', function (e) {
      var p = local(e);
      if (!drag) { var hh = handleAt(p.x, p.y); el.canvas.style.cursor = hh ? handleCursor(hh) : hit(p.x, p.y) ? 'move' : 'grab'; return; }
      if (!drag.moved && Math.abs(p.x - drag.x) + Math.abs(p.y - drag.y) < 3) return;
      drag.moved = true;
      var it = drag.item, g = toPicture(p.x, p.y), gm = garment(), a = sideInfo().anchor;
      if (drag.mode === 'pan') { view.ox = drag.ox + p.x - drag.x; view.oy = drag.oy + p.y - drag.y; view.auto = false; el.canvas.style.cursor = 'grabbing'; }
      else if (drag.mode === 'move') { var k = view.scale * gm.pxPerMm; it.dx = clamp(drag.dx + (p.x - drag.x) / k, -600, 600); it.dy = clamp(drag.dy + (p.y - drag.y) / k, -700, 900); }
      else if (drag.mode === 'rot') {
        var deg = drag.rot0 + (Math.atan2(g.y - drag.r.cy, g.x - drag.r.cx) - drag.a0) * 180 / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / ROT_STEP) * ROT_STEP;
        it.rot = normRot(deg); renderProps();
      } else {
        /* uniform scale along the corner's diagonal; the opposite corner stays put, or the centre with Alt */
        var r = drag.r, cr = corner(r, drag.sx, drag.sy), vx = cr.x - r.cx, vy = cr.y - r.cy, len2 = vx * vx + vy * vy || 1, t, cx, cy, ns;
        if (e.altKey) { t = ((g.x - r.cx) * vx + (g.y - r.cy) * vy) / len2; ns = clamp(drag.s0 * t, MIN_SCALE, MAX_SCALE); cx = r.cx; cy = r.cy; }
        else {
          var ax = r.cx - vx, ay = r.cy - vy; t = ((g.x - ax) * vx + (g.y - ay) * vy) / (2 * len2);
          ns = clamp(drag.s0 * t, MIN_SCALE, MAX_SCALE); var f = ns / drag.s0; cx = ax + vx * f; cy = ay + vy * f;
        }
        it.scale = ns; it.dx = clamp((cx - a[0]) / gm.pxPerMm, -600, 600); it.dy = clamp((cy - a[1]) / gm.pxPerMm, -700, 900);
        renderProps();
      }
      invalidate();
    });
    function up(e) {
      if (!drag) return;
      if (drag.mode === 'pan' && !drag.moved && drag.had) { selected = null; renderLists(); }
      if (drag.mode !== 'pan' && drag.moved) { save(); if (drag.mode === 'scale') { var row = el.layers.querySelector('[data-item="' + drag.item.id + '"]'); if (row) row.title = sizeText(drag.item); } }
      drag = null; invalidate();
      if (e) { var p = local(e), hh = handleAt(p.x, p.y); el.canvas.style.cursor = hh ? handleCursor(hh) : hit(p.x, p.y) ? 'move' : 'grab'; }
    }
    el.canvas.addEventListener('pointerup', up); el.canvas.addEventListener('pointercancel', up);
    el.canvas.addEventListener('wheel', function (e) { e.preventDefault(); var p = local(e); zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018))); }, { passive: false });
    el.canvas.addEventListener('dblclick', function () { view.auto = true; invalidate(); });
    el.canvas.addEventListener('keydown', function (e) {
      var s = selectedItem(); if (!s) return;
      var step = e.shiftKey ? 5 : 1, k = e.key;
      if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); e.stopPropagation(); Mock.remove(s.id); }
      else if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        s.dx += k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0; s.dy += k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0; save(); invalidate();
      }
    });
    /* R / Shift+R turn the picked layer; Cmd/Ctrl+] and [ move it up or down (with Shift: to the top or bottom) */
    document.addEventListener('keydown', function (e) {
      if (!open || e.defaultPrevented || e.isComposing || typing(e.target) || document.querySelector('dialog[open]')) return;
      var mod = e.metaKey || e.ctrlKey, k = e.key, code = e.code;
      if (mod && !e.altKey && (k === ']' || k === '[' || k === '}' || k === '{' || code === 'BracketRight' || code === 'BracketLeft')) {
        if (!selectedItem()) return;
        var upward = k === ']' || k === '}' || (code === 'BracketRight' && k !== '[' && k !== '{');
        e.preventDefault();
        Mock.moveLayer(selected, e.shiftKey ? (upward ? 'top' : 'bottom') : (upward ? 1 : -1));
        return;
      }
      if (!mod && !e.altKey && (k === 'r' || k === 'R' || code === 'KeyR')) {
        if (!selectedItem()) return;
        e.preventDefault(); rotateSelected(e.shiftKey ? -ROT_STEP : ROT_STEP);
      }
    }, true);
    window.addEventListener('pagehide', function () { if (saveTimer) saveNow(); });
    if (window.ResizeObserver) new ResizeObserver(function () { invalidate(); }).observe(el.stage);
    window.addEventListener('resize', invalidate);
    Editor.on('tabs', function () { if (open) { prepareAll().then(function () { renderLists(); invalidate(); }); renderLists(); } });
    Editor.on('units', function () { if (open) renderLists(); });
    renderControls();
  };
})();
