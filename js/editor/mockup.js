/* ==========================================================================
   EMBROIDERY LABS - js/editor/mockup.js
   Mockup view: the stitched design on a hoodie or a T-shirt. Creates Editor.Mockup.

   - The garment is a photo of a white blank (mockups/*.webp, greyscale + alpha). It is tinted to
     any colour here, per pixel, so one small picture gives every colour.
   - Each open design (a tab) is drawn once by the realistic renderer (js/realistic, loaded the first
     time the mockup is opened) as thread only, at up to 8 px per mm, then placed on the garment at
     true size. Drag to move it, use Size to scale it.
   - Front and back keep their own placements. Everything is stored in
     localStorage['el-editor-mockup-v1']; the picture is made in the browser and downloaded as PNG.

   Events (Editor.on):  'mockup'  the view was opened or closed
   ========================================================================== */
(function () {
  'use strict';
  var Editor = window.Editor = window.Editor || {};
  var M = Editor.Model, V = Editor.View;
  var KEY = 'el-editor-mockup-v1', SIZE = 2000, MARGIN_MM = 3, MAX_DESIGN_PX = 2400, MAX_PPM = 8;

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

  var Mock = Editor.Mockup = { GARMENTS: GARMENTS };
  var el = {}, open = false, state = { garment: 'hoodie', side: 'front', color: '#4A4D52', placements: { front: [], back: [] } };
  var selected = null, view = { scale: 1, ox: 0, oy: 0, auto: true }, raf = 0, recolorRaf = 0;
  var blank = { key: '', grey: null, alpha: null, canvas: null, loading: null };     /* the garment picture in use */
  var designs = {};                                                                  /* tab id -> { sig, canvas, ppm, w, h, name, busy, empty, result } */
  var libs = null;

  function $(id) { return document.getElementById(id); }
  function toast(msg, opts) { if (window.EL) window.EL.toast(msg, opts); }
  function say(msg) { if (Editor.say) Editor.say(msg); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function garment() { return GARMENTS[state.garment] || GARMENTS.hoodie; }
  function sideInfo() { return garment().sides[state.side] || garment().sides.front; }
  function items() { return state.placements[state.side] || (state.placements[state.side] = []); }

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
      var job = window.Realistic.render(c, result, {
        scene: 'swatch', transparent: true, fabric: garment().fabric, fabricColor: state.color,
        pixelsPerMm: ppm, origin: [(MARGIN_MM - b.minX) * ppm, (MARGIN_MM - b.minY) * ppm],
        onProgress: function () { invalidate(); }, onFirstFrame: function () { invalidate(); }
      });
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
  function tabs() { return Editor.Tabs ? Editor.Tabs.designs() : [{ id: 'only', name: M.doc.name, doc: M.serialize(), shapes: M.doc.objects.length, active: true }]; }
  function tabById(id) { var list = tabs(); for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function prepareAll() {
    var need = {}, list = tabs();
    ['front', 'back'].forEach(function (s) { (state.placements[s] || []).forEach(function (p) { need[p.tab] = 1; }); });
    /* placements of designs that were closed are dropped */
    ['front', 'back'].forEach(function (s) { state.placements[s] = (state.placements[s] || []).filter(function (p) { return list.some(function (t) { return t.id === p.tab; }); }); });
    return Promise.all(list.filter(function (t) { return need[t.id]; }).map(prepare));
  }

  /* ---------- drawing ------------------------------------------------------------------- */
  function invalidate() { if (open && !raf) raf = requestAnimationFrame(function () { raf = 0; draw(); }); }
  function place(p) {                                   /* picture-pixel rectangle of one placed design */
    var d = designs[p.tab]; if (!d || !d.canvas) return null;
    var g = garment(), a = sideInfo().anchor, w = d.w * g.pxPerMm * p.scale, h = d.h * g.pxPerMm * p.scale;
    return { x: a[0] + p.dx * g.pxPerMm - w / 2, y: a[1] + p.dy * g.pxPerMm - h / 2, w: w, h: h, d: d };
  }
  /* bg: a colour to fill behind the garment in a file, or null for nothing (the screen and the transparent file) */
  function paint(c, scale, ox, oy, forFile, bg) {
    if (forFile && bg) { c.fillStyle = bg; c.fillRect(0, 0, SIZE * scale, SIZE * scale); }
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    if (blank.canvas && blank.grey) {
      c.save();
      if (bg || !forFile) { c.shadowColor = 'rgba(40,35,25,.20)'; c.shadowBlur = 36 * scale; c.shadowOffsetY = 14 * scale; }   /* a soft shadow on white; none in the transparent file */
      c.drawImage(blank.canvas, ox, oy, SIZE * scale, SIZE * scale);
      c.restore();
    }
    items().forEach(function (p) {
      var r = place(p); if (!r) return;
      c.drawImage(r.d.canvas, ox + r.x * scale, oy + r.y * scale, r.w * scale, r.h * scale);
    });
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
    paint(c, view.scale, view.ox, view.oy, false, null);
    var sel = selectedItem(), r = sel && place(sel);
    if (r) {
      var accent = (window.EL && window.EL.token && window.EL.token('--signal')) || '#4E7396';
      c.strokeStyle = accent; c.lineWidth = 1.5; c.setLineDash([5, 4]);
      c.strokeRect(Math.round(view.ox + r.x * view.scale) + 0.5, Math.round(view.oy + r.y * view.scale) + 0.5, Math.round(r.w * view.scale), Math.round(r.h * view.scale));
      c.setLineDash([]);
    }
    if (el.zoom) el.zoom.textContent = Math.round(view.scale / fitScale(w, h) * 100) + '%';
  }
  function fitScale(w, h) { return Math.max(0.02, Math.min(w, h) / SIZE * 0.96); }
  function fit(w, h) { view.scale = fitScale(w, h); view.ox = (w - SIZE * view.scale) / 2; view.oy = (h - SIZE * view.scale) / 2; }
  function zoomAt(px, py, factor) {
    var w = el.stage.clientWidth, h = el.stage.clientHeight, base = fitScale(w, h), next = clamp(view.scale * factor, base * 0.5, base * 12);
    var k = next / view.scale; view.ox = px - (px - view.ox) * k; view.oy = py - (py - view.oy) * k; view.scale = next; view.auto = false; invalidate();
  }

  /* ---------- placements ------------------------------------------------------------------ */
  function selectedItem() { var list = items(); for (var i = 0; i < list.length; i++) if (list[i].id === selected) return list[i]; return null; }
  function save() { if (window.EL) window.EL.store.set(KEY, { v: 1, garment: state.garment, side: state.side, color: state.color, placements: state.placements }); }
  function hit(px, py) {
    var list = items(), x = (px - view.ox) / view.scale, y = (py - view.oy) / view.scale;
    for (var i = list.length - 1; i >= 0; i--) { var r = place(list[i]); if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return list[i]; }
    return null;
  }
  Mock.add = function (tabId) {
    var tab = tabById(tabId); if (!tab) return Promise.resolve(null);
    if (!tab.shapes) { toast('"' + tab.name + '" has nothing to sew yet.', { kind: 'bad', label: 'Mockup' }); return Promise.resolve(null); }
    setBusy('Stitching ' + tab.name + '...');
    return prepare(tab).then(function (d) {
      setBusy('');
      if (!d) { if (designs[tab.id] && designs[tab.id].empty) toast('"' + tab.name + '" makes no stitches.', { kind: 'bad', label: 'Mockup' }); return null; }
      var n = items().length, p = { id: 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36), tab: tab.id, dx: (n % 3) * 18, dy: (n % 3) * 18, scale: 1 };
      items().push(p); selected = p.id; save(); renderLists(); invalidate();
      say(tab.name + ' placed on the ' + state.side);
      return p;
    });
  };
  Mock.remove = function (id) {
    var list = items(), i;
    for (i = 0; i < list.length; i++) if (list[i].id === id) { list.splice(i, 1); break; }
    if (selected === id) selected = list.length ? list[list.length - 1].id : null;
    save(); renderLists(); invalidate();
  };

  /* ---------- panels ---------------------------------------------------------------------- */
  function setBusy(text) { if (el.busy) { el.busy.textContent = text; el.busy.hidden = !text; } }
  function pressed(nodes, attr, value) { nodes.forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute(attr) === value ? 'true' : 'false'); }); }
  function renderControls() {
    pressed(el.garmentBtns, 'data-garment', state.garment); pressed(el.sideBtns, 'data-side', state.side);
    var rgb = hexToRgb(state.color), hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
    el.color.value = state.color; el.hex.textContent = state.color.toUpperCase(); el.swatch.style.setProperty('--c', state.color);
    if (document.activeElement !== el.hue) el.hue.value = hsl[0];
    if (document.activeElement !== el.sat) el.sat.value = hsl[1];
    if (document.activeElement !== el.light) el.light.value = hsl[2];
    [el.hue, el.sat, el.light].forEach(function (s) { if (window.EL && window.EL.syncSlider) window.EL.syncSlider(s); });
    el.hueVal.textContent = el.hue.value + '°'; el.satVal.textContent = el.sat.value + '%'; el.lightVal.textContent = el.light.value + '%';
    Array.prototype.forEach.call(el.chips.children, function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-color').toLowerCase() === state.color.toLowerCase() ? 'true' : 'false'); });
  }
  function sizeText(p) { var d = designs[p.tab]; if (!d || !d.mm) return ''; return Editor.Units.sizeShort(d.mm.w * p.scale, d.mm.h * p.scale) + ' ' + Editor.Units.label(); }
  function renderLists() {
    if (!el.placed) return;
    var list = items(), frag = document.createDocumentFragment();
    list.forEach(function (p) {
      var d = designs[p.tab], row = document.createElement('div');
      row.className = 'mock__item'; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', p.id === selected ? 'true' : 'false'); row.setAttribute('data-item', p.id); row.tabIndex = 0;
      var name = document.createElement('span'); name.className = 'name'; name.textContent = (d && d.name) || 'Design';
      var size = document.createElement('span'); size.className = 'num'; size.textContent = d && d.busy ? 'stitching...' : sizeText(p);
      var x = document.createElement('button'); x.type = 'button'; x.className = 'mini'; x.setAttribute('aria-label', 'Remove from the garment'); x.setAttribute('data-remove', p.id);
      x.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>';
      row.appendChild(name); row.appendChild(size); row.appendChild(x); frag.appendChild(row);
    });
    el.placed.textContent = ''; el.placed.appendChild(frag);
    el.placedEmpty.hidden = list.length > 0;
    el.sideName.textContent = state.side === 'front' ? 'On the front' : 'On the back';

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

    var sel = selectedItem();
    el.scaleRow.classList.toggle('is-off', !sel); el.scale.disabled = !sel; el.trueSize.disabled = !sel || sel.scale === 1;
    el.scale.value = sel ? Math.round(sel.scale * 100) : 100; if (window.EL && window.EL.syncSlider) window.EL.syncSlider(el.scale);
    el.scaleVal.textContent = el.scale.value + '%';
    var can = list.some(function (p) { return designs[p.tab] && designs[p.tab].canvas; });
    if (el.dlThread) el.dlThread.setAttribute('aria-disabled', can ? 'false' : 'true');
  }

  /* ---------- files ------------------------------------------------------------------------- */
  function fileBase() { var sel = selectedItem() || items()[0], d = sel && designs[sel.tab]; return String((d && d.name) || M.doc.name || 'design').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim() || 'design'; }
  function settle() { return Promise.all(Object.keys(designs).map(function (k) { return designs[k].promise || null; })); }
  /* transparent = false: the garment on white (the usual picture). true: nothing behind the garment. */
  Mock.downloadImage = function (transparent) {
    if (!blank.grey) { toast('The garment is still loading.', { kind: 'bad', label: 'Mockup' }); return Promise.resolve(false); }
    setBusy('Making the picture...');
    return settle().then(function () {
      var c = document.createElement('canvas'); c.width = SIZE; c.height = SIZE;
      paint(c.getContext('2d'), 1, 0, 0, true, transparent ? null : WHITE);
      return new Promise(function (resolve) {
        c.toBlob(function (blob) {
          setBusy('');
          if (!blob) { toast('The picture could not be made.', { kind: 'bad', label: 'Mockup' }); resolve(false); return; }
          var name = fileBase() + '-' + state.garment + '-' + state.side + (transparent ? '-transparent' : '') + '.png';
          window.EL.download(name, blob, 'image/png');
          toast(name + ' downloaded, ' + (transparent ? 'with a transparent background' : 'on a white background') + ' (' + SIZE + ' x ' + SIZE + ' px).', { kind: 'ok', label: 'Mockup', timeout: 6000 });
          resolve(true);
        }, 'image/png');
      });
    });
  };
  /* the stitches alone, thread on nothing, to drop into any other mockup or picture */
  Mock.downloadStitching = function () {
    var sel = selectedItem() || items()[0], d = sel && designs[sel.tab];
    if (!d || !d.result || !window.Realistic) { toast('Place a design on the garment first.', { kind: 'bad', label: 'Mockup' }); return Promise.resolve(false); }
    setBusy('Drawing the thread...');
    var ratio = d.mm.h / d.mm.w, w = ratio > 1 ? Math.round(1200 / ratio) : 1200, h = ratio > 1 ? 1200 : Math.round(1200 * ratio);
    return window.Realistic.exportImage(d.result, { scene: 'swatch', transparent: true, fabric: garment().fabric, fabricColor: state.color, width: Math.max(200, w), height: Math.max(200, h), scale: 2, margin: 0.04 })
      .then(function (blob) {
        setBusy('');
        var name = fileBase() + '-stitching.png';
        window.EL.download(name, blob, 'image/png');
        toast(name + ' downloaded: the thread on a clear background.', { kind: 'ok', label: 'Mockup', timeout: 6000 });
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
    el.app.classList.remove('is-mock'); el.root.hidden = true;
    if (el.toggle) el.toggle.setAttribute('aria-pressed', 'false');
    if (Editor.Tabs) Editor.Tabs.render();
    Editor.emit('mockup');
    V.resize();
  };
  Mock.toggle = function () { if (open) Mock.close(); else Mock.open(); };
  Mock.state = function () { return JSON.parse(JSON.stringify(state)); };

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

  Mock.init = function () {
    el.root = $('mock'); el.app = $('app'); if (!el.root || !el.app) return;
    el.stage = $('mock-stage'); el.canvas = $('mock-canvas'); el.busy = $('mock-busy'); el.zoom = $('mock-zoom'); el.toggle = $('btn-mockup');
    el.garmentBtns = Array.prototype.slice.call(el.root.querySelectorAll('[data-garment]'));
    el.sideBtns = Array.prototype.slice.call(el.root.querySelectorAll('[data-side]'));
    el.color = $('mock-color'); el.hex = $('mock-hex'); el.swatch = $('mock-swatch'); el.chips = $('mock-chips');
    el.hue = $('mock-hue'); el.sat = $('mock-sat'); el.light = $('mock-light'); el.hueVal = $('mock-hue-value'); el.satVal = $('mock-sat-value'); el.lightVal = $('mock-light-value');
    el.placed = $('mock-placed'); el.placedEmpty = $('mock-placed-empty'); el.sideName = $('mock-side-name'); el.adds = $('mock-adds');
    el.scaleRow = $('mock-scale-row'); el.scale = $('mock-scale'); el.scaleVal = $('mock-scale-value'); el.trueSize = $('mock-true-size');
    el.dlImage = $('mock-download'); el.dlMore = $('mock-download-more'); el.dlMenu = $('mock-download-menu'); el.dlGroup = $('mock-dl-group');
    el.dlThread = el.dlMenu ? el.dlMenu.querySelector('[data-dl="thread"]') : null;

    var stored = null;
    try { stored = window.EL.store.get(KEY, null); } catch (e) { stored = null; }
    if (stored && stored.v === 1) {
      if (GARMENTS[stored.garment]) state.garment = stored.garment;
      if (stored.side === 'front' || stored.side === 'back') state.side = stored.side;
      if (/^#[0-9a-f]{6}$/i.test(stored.color)) state.color = stored.color;
      ['front', 'back'].forEach(function (s) {
        var list = stored.placements && Array.isArray(stored.placements[s]) ? stored.placements[s] : [];
        state.placements[s] = list.slice(0, 24).filter(function (p) { return p && typeof p.tab === 'string' && isFinite(p.dx) && isFinite(p.dy) && isFinite(p.scale); })
          .map(function (p) { return { id: String(p.id || ('m' + Math.random().toString(36).slice(2))), tab: p.tab, dx: clamp(+p.dx, -600, 600), dy: clamp(+p.dy, -700, 900), scale: clamp(+p.scale, 0.25, 4) }; });
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

    el.placed.addEventListener('click', function (e) {
      var x = e.target.closest ? e.target.closest('[data-remove]') : null;
      if (x) { Mock.remove(x.getAttribute('data-remove')); return; }
      var row = e.target.closest ? e.target.closest('[data-item]') : null;
      if (row) { selected = row.getAttribute('data-item'); renderLists(); invalidate(); }
    });
    el.adds.addEventListener('click', function (e) { var b = e.target.closest ? e.target.closest('[data-add]') : null; if (b) Mock.add(b.getAttribute('data-add')); });
    el.scale.addEventListener('input', function () { var s = selectedItem(); if (!s) return; s.scale = clamp(+el.scale.value / 100, 0.25, 4); el.scaleVal.textContent = el.scale.value + '%'; el.trueSize.disabled = s.scale === 1; save(); invalidate(); var row = el.placed.querySelector('[data-item="' + s.id + '"] .num'); if (row) row.textContent = sizeText(s); });
    el.trueSize.addEventListener('click', function () { var s = selectedItem(); if (!s) return; s.scale = 1; save(); renderLists(); invalidate(); });
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

    /* pointer: drag a design, or the view */
    var drag = null;
    function local(e) { var r = el.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    el.canvas.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button > 1) return;
      var p = local(e), h = e.button === 1 ? null : hit(p.x, p.y);
      if (h) { selected = h.id; drag = { item: h, x: p.x, y: p.y, dx: h.dx, dy: h.dy, moved: false }; renderLists(); }
      else { drag = { pan: true, x: p.x, y: p.y, ox: view.ox, oy: view.oy, moved: false, had: selected }; }
      try { el.canvas.setPointerCapture(e.pointerId); } catch (x) { /* synthetic pointer */ }
      el.canvas.focus({ preventScroll: true }); invalidate(); e.preventDefault();
    });
    el.canvas.addEventListener('pointermove', function (e) {
      var p = local(e);
      if (!drag) { el.canvas.style.cursor = hit(p.x, p.y) ? 'move' : 'grab'; return; }
      if (!drag.moved && Math.abs(p.x - drag.x) + Math.abs(p.y - drag.y) < 3) return;
      drag.moved = true;
      if (drag.pan) { view.ox = drag.ox + p.x - drag.x; view.oy = drag.oy + p.y - drag.y; view.auto = false; el.canvas.style.cursor = 'grabbing'; }
      else { var k = view.scale * garment().pxPerMm; drag.item.dx = clamp(drag.dx + (p.x - drag.x) / k, -600, 600); drag.item.dy = clamp(drag.dy + (p.y - drag.y) / k, -700, 900); }
      invalidate();
    });
    function up() {
      if (!drag) return;
      if (drag.pan && !drag.moved && drag.had) { selected = null; renderLists(); }
      if (!drag.pan && drag.moved) save();
      drag = null; invalidate();
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
    if (window.ResizeObserver) new ResizeObserver(function () { invalidate(); }).observe(el.stage);
    window.addEventListener('resize', invalidate);
    document.addEventListener('el:themechange', invalidate);
    Editor.on('tabs', function () { if (open) { prepareAll().then(function () { renderLists(); invalidate(); }); renderLists(); } });
    Editor.on('units', function () { if (open) renderLists(); });
    renderControls();
  };
})();
