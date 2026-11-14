/* ==========================================================================
   EMBROIDERY LABS - js/editor/vectorize.js
   "Picture to SVG": a studio that turns a picture into clean coloured shapes.

   A picture comes in by pasting (Cmd/Ctrl+V anywhere in the editor; main.js
   routes the paste event here), from File > Picture to SVG, from the "Picture
   to SVG" button on the picture card, or by dropping / picking a file in the
   studio. Everything stays in the browser: the picture is decoded once
   (Trace.imageDataFrom, at most 1600 px) and traced by the global `Trace` in
   its own worker (js/trace/client.js; a newer trace cancels an older one).

   What can be changed, and what it costs:
     - colours (Auto up to 10, or 2 to 30), background (Auto / Remove / Keep),
       detail (Low / Medium / High), width on the hoop: a new trace (250 ms);
     - keep / drop a colour, give it another colour, merge it into another
       colour, remove one shape with the shape eraser: applied to the last
       result at once, no new trace;
     - the brush erases pixels of a working copy of the picture: a new trace
       300 ms after the stroke. Erase steps have their own undo / redo
       (Cmd/Ctrl+Z inside the studio never touches the design).

   Erase steps are kept as a list ({ kind: 'brush', r, pts } in picture pixels,
   { kind: 'shape', rings | line } for a removed shape) and replayed over the
   original picture whenever the working copy is needed, so undo is cheap. A
   removed shape is also painted out of the working copy, so it stays gone
   after a later trace. Erased pixels are made transparent, except on an
   opaque picture whose plain border colour the tracer removes as background:
   there they are painted in that colour, so the background is still found.

   The output: "Add to design" (ONE Model.addMany, centred in the hoop, named
   after the thread colours, toast with Undo), "Download .svg" (mm sized, one
   path per shape: fills evenodd, lines stroked at their width) and "Use as
   reference" (the picture goes under the drawing through Editor.Trace.load).

   Public: Editor.Vectorize.open(source?, name?) -> Promise, .close(), .isOpen(),
           .takePaste(dataTransfer) -> boolean (true when it took a picture),
           .state() (for tests), .add(), .svg() -> string, .download(),
           .setTool('look' | 'brush' | 'shape'), .setView('before' | 'after' | 'split')
   ========================================================================== */
(function () {
  'use strict';
  var Editor = window.Editor;
  if (!Editor || !Editor.Model || !Editor.Geom) return;
  var M = Editor.Model, G = Editor.Geom;
  var Vz = Editor.Vectorize = {};

  var TYPES = /^image\/(png|jpeg|webp|gif|bmp)$/;
  var MAX_FILE = 25 * 1024 * 1024, MAX_SIDE = 1600, AUTO_MAX = 10, MAX_COLOURS = 30;
  var MIN_W = 10, MAX_W = 400, PREFS = 'el-editor-vectorize-v1';
  var MARK = 'application/x-embroidr';

  var S = {
    dlg: null, el: {},
    pic: null,          /* { canvas, w, h, name, uid, alpha, guess } the picture as decoded */
    disp: null,         /* the picture with the erased pixels cleared: what Before shows */
    steps: [], undo: [], redo: [], stepId: 0,
    set: { auto: true, n: 6, bg: 'auto', detail: 'medium', width: 100 },
    client: null, seq: 0, job: false, progress: 0, timer: 0, error: '', cancelled: false,
    res: null, resSeq: 0, baked: {}, bgSeen: null,
    keep: [], to: [], into: [], names: [],
    paths: [], widths: [],
    view: 'after', split: 0.5, tool: 'look', brush: 28,
    hover: -1, rect: null, dpr: 1, cache: null, cacheKey: '', editRev: 0,
    stroke: null, dragSplit: false, cursor: null, uid: 0
  };
  (function () {
    var p = null; try { p = window.EL && window.EL.store.get(PREFS, null); } catch (e) { p = null; }
    if (!p || typeof p !== 'object') return;
    if (typeof p.auto === 'boolean') S.set.auto = p.auto;
    if (typeof p.n === 'number' && isFinite(p.n)) S.set.n = G.clamp(Math.round(p.n), 2, MAX_COLOURS);
    if (p.bg === 'auto' || p.bg === 'on' || p.bg === 'off') S.set.bg = p.bg;
    if (p.detail === 'low' || p.detail === 'medium' || p.detail === 'high') S.set.detail = p.detail;
  })();
  function savePrefs() { try { if (window.EL) window.EL.store.set(PREFS, { auto: S.set.auto, n: S.set.n, bg: S.set.bg, detail: S.set.detail }); } catch (e) { /* a convenience only */ } }

  function toast(msg, opts) { return Editor.toast ? Editor.toast(msg, opts) : (window.EL ? window.EL.toast(msg, opts) : null); }
  function say(msg) { if (Editor.say) Editor.say(msg); }
  function fmt(n) { return window.EL ? window.EL.num(n) : String(n); }
  function units() { return Editor.Units; }
  function r2(v) { return Math.round(v * 100) / 100; }
  function h(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function icon(d, box) {
    var ns = 'http://www.w3.org/2000/svg', s = document.createElementNS(ns, 'svg'), p = document.createElementNS(ns, 'path');
    s.setAttribute('viewBox', box || '0 0 18 18'); s.setAttribute('aria-hidden', 'true'); p.setAttribute('d', d); s.appendChild(p); return s;
  }
  function canvas(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; }
  function hexRgb(hex) { var n = parseInt(String(hex).slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function dist(a, b) { var x = hexRgb(a), y = hexRgb(b); return Math.sqrt((x[0] - y[0]) * (x[0] - y[0]) + (x[1] - y[1]) * (x[1] - y[1]) + (x[2] - y[2]) * (x[2] - y[2])); }

  /* ==========================================================================
     The sheet
     ========================================================================== */
  var SEG = {
    view: [['before', 'Before'], ['after', 'After'], ['split', 'Split']],
    bg: [['auto', 'Auto'], ['on', 'Remove'], ['off', 'Keep']],
    detail: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]
  };
  var ICONS = {
    look: 'M4 2.5v12l3.2-3 2.1 4.5 1.8-.8-2.1-4.4H13.5z',
    brush: 'M15.5 2.5 8 10M8 10c-1.6-.6-3.4.4-3.6 2.2-.2 1.6-.9 2.5-1.9 3.3 2.7.4 5.6-.4 6.6-2.4.5-1.1.1-2.4-1.1-3.1z',
    shape: 'M6.5 15 2.5 11l8-8 5 5-7 7zM6 7.5l5 5M8.5 15H16',
    undo: 'M5 3 2 6l3 3M2 6h6.5a3.5 3.5 0 0 1 0 7H6',
    redo: 'M9 3l3 3-3 3M12 6H5.5a3.5 3.5 0 0 0 0 7H8',
    reset: 'M2.5 7a4.5 4.5 0 1 1 1.3 3.2M2.5 11V7.5H6',
    close: 'M3 3l8 8M11 3l-8 8'
  };
  function seg(name, list, label) {
    var g = h('div', 'seg'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', label); g.setAttribute('data-seg', name);
    list.forEach(function (it) { var b = h('button', null, it[1]); b.type = 'button'; b.setAttribute('data-v', it[0]); b.setAttribute('aria-pressed', 'false'); g.appendChild(b); });
    return g;
  }
  function iconBtn(name, label, box) {
    var b = h('button', 'btn btn--ghost btn--icon'); b.type = 'button'; b.setAttribute('aria-label', label); b.title = label; b.appendChild(icon(ICONS[name], box)); return b;
  }
  function section(title, id) {
    var s = h('section', 'vz__sec'); var l = h('span', 'label', title); if (id) l.id = id; s.appendChild(l); return s;
  }

  function build() {
    if (S.dlg) return S.dlg;
    var E = S.el, d = h('dialog', 'dialog vz'); d.id = 'vectorize'; d.setAttribute('aria-labelledby', 'vz-title');
    /* head */
    var head = h('div', 'dialog__head'), title = h('span', 'label', 'Picture to SVG'); title.id = 'vz-title';
    var hr = h('div', 'vz__headr');
    E.pick = h('button', 'btn btn--ghost', 'Open picture'); E.pick.type = 'button'; E.pick.id = 'vz-pick';
    var x = iconBtn('close', 'Close', '0 0 14 14'); x.setAttribute('data-dialog-close', '');
    hr.appendChild(E.pick); hr.appendChild(x); head.appendChild(title); head.appendChild(hr);
    E.input = h('input'); E.input.type = 'file'; E.input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp'; E.input.hidden = true; E.input.id = 'vz-input';

    /* main: tool bar, stage, status */
    var body = h('div', 'vz__body'), main = h('div', 'vz__main'), bar = h('div', 'vz__bar');
    E.view = seg('view', SEG.view, 'Show');
    E.tools = h('div', 'seg vz__tools'); E.tools.setAttribute('role', 'group'); E.tools.setAttribute('aria-label', 'Tool');
    [['look', 'Look (V)'], ['brush', 'Erase brush (B)'], ['shape', 'Erase a shape (E)']].forEach(function (t) {
      var b = h('button'); b.type = 'button'; b.setAttribute('data-tool', t[0]); b.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-label', t[1]); b.title = t[1];
      b.appendChild(icon(ICONS[t[0]])); E.tools.appendChild(b);
    });
    E.brushBox = h('label', 'vz__brush'); E.brushBox.title = 'Brush size ([ and ])';
    var bl = h('span', 'visually-hidden', 'Brush size');
    E.brushSize = h('input', 'slider'); E.brushSize.type = 'range'; E.brushSize.min = '6'; E.brushSize.max = '120'; E.brushSize.step = '1'; E.brushSize.id = 'vz-brush';
    E.brushBox.appendChild(bl); E.brushBox.appendChild(E.brushSize);
    var sp = h('span', 'vz__spacer');
    E.undo = iconBtn('undo', 'Undo erase', '0 0 14 14'); E.redo = iconBtn('redo', 'Redo erase', '0 0 14 14'); E.reset = iconBtn('reset', 'Bring back everything erased', '0 0 14 14');
    E.undo.id = 'vz-undo'; E.redo.id = 'vz-redo'; E.reset.id = 'vz-reset';
    [E.view, E.tools, E.brushBox, sp, E.undo, E.redo, E.reset].forEach(function (n) { bar.appendChild(n); });

    E.stage = h('div', 'vz__stage'); E.canvas = h('canvas'); E.canvas.id = 'vz-canvas'; E.canvas.setAttribute('aria-label', 'Preview');
    E.drop = h('button', 'vz__drop'); E.drop.type = 'button'; E.drop.id = 'vz-drop';
    E.drop.appendChild(h('span', 'vz__drop-big', 'Paste, drop or pick a picture'));
    E.drop.appendChild(h('span', 'vz__drop-small', 'PNG, JPG, WebP or GIF. It stays on this device.'));
    E.stage.appendChild(E.canvas); E.stage.appendChild(E.drop);

    var status = h('div', 'vz__status');
    E.meta = h('span', 'num vz__meta'); E.meta.id = 'vz-meta'; E.meta.setAttribute('aria-live', 'polite');
    E.busy = h('span', 'vz__busy'); E.busy.hidden = true;
    var barOut = h('span', 'vz__progress'); E.bar = h('i'); barOut.appendChild(E.bar);
    E.busyText = h('span', 'num', 'Working'); E.cancel = h('button', 'btn btn--ghost', 'Cancel'); E.cancel.type = 'button'; E.cancel.id = 'vz-cancel';
    E.busy.appendChild(barOut); E.busy.appendChild(E.busyText); E.busy.appendChild(E.cancel);
    E.note = h('span', 'vz__note'); E.note.id = 'vz-note';
    status.appendChild(E.meta); status.appendChild(E.busy); status.appendChild(E.note);
    main.appendChild(bar); main.appendChild(E.stage); main.appendChild(status);

    /* side panel */
    var side = h('div', 'vz__side');
    var sc = section('How many colours?', 'vz-colors-label');
    var autoRow = h('label', 'check-row vz__auto'); E.auto = h('input', 'check'); E.auto.type = 'checkbox'; E.auto.id = 'vz-auto';
    autoRow.appendChild(E.auto); autoRow.appendChild(h('span', null, 'Auto (up to 10)'));
    var cnt = h('div', 'vz__count'); E.count = h('input', 'slider'); E.count.type = 'range'; E.count.min = '2'; E.count.max = String(MAX_COLOURS); E.count.step = '1'; E.count.id = 'vz-count';
    E.count.setAttribute('aria-labelledby', 'vz-colors-label');
    E.countVal = h('span', 'num'); cnt.appendChild(E.count); cnt.appendChild(E.countVal);
    E.list = h('div', 'vz__colors'); E.list.id = 'vz-colors'; E.list.setAttribute('role', 'list'); E.list.setAttribute('aria-label', 'Colours');
    sc.appendChild(autoRow); sc.appendChild(cnt); sc.appendChild(E.list);
    var sb = section('Background'); E.bg = seg('bg', SEG.bg, 'Background'); E.bg.classList.add('seg--block'); sb.appendChild(E.bg);
    var sd = section('Detail'); E.detail = seg('detail', SEG.detail, 'Detail'); E.detail.classList.add('seg--block'); sd.appendChild(E.detail);
    var sw = section('Width', 'vz-width-label'); var wr = h('div', 'vz__count');
    E.width = h('input', 'slider'); E.width.type = 'range'; E.width.min = String(MIN_W); E.width.max = '300'; E.width.step = '1'; E.width.id = 'vz-width'; E.width.setAttribute('aria-labelledby', 'vz-width-label');
    E.widthVal = h('span', 'num'); wr.appendChild(E.width); wr.appendChild(E.widthVal); sw.appendChild(wr);
    [sc, sb, sd, sw].forEach(function (n) { side.appendChild(n); });
    body.appendChild(main); body.appendChild(side);

    /* foot */
    var foot = h('div', 'dialog__foot vz__foot');
    E.ref = h('button', 'btn btn--ghost vz__ref', 'Use as reference'); E.ref.type = 'button'; E.ref.id = 'vz-ref';
    E.svg = h('button', 'btn', 'Download .svg'); E.svg.type = 'button'; E.svg.id = 'vz-svg';
    E.add = h('button', 'btn btn--primary', 'Add to design'); E.add.type = 'button'; E.add.id = 'vz-add';
    foot.appendChild(E.ref); foot.appendChild(E.svg); foot.appendChild(E.add);

    d.appendChild(head); d.appendChild(E.input); d.appendChild(body); d.appendChild(foot);
    document.body.appendChild(d);
    S.dlg = d;
    wire();
    return d;
  }

  /* ==========================================================================
     Getting a picture in
     ========================================================================== */
  function accepts(file) { return !!file && TYPES.test(file.type || ''); }
  function baseName(name) { var n = String(name || '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^\w\- ]+/g, '').trim(); return n.slice(0, 60) || 'picture'; }

  /* The picture's own facts: has it real transparency, and is there a plain colour round its border. */
  function study(img) {
    var w = img.width, hh = img.height, d = img.data, i, n = w * hh, clear = 0;
    for (i = 3; i < d.length; i += 4) if (d[i] < 250) clear++;
    var buckets = {}, total = 0;
    function at(x, y) {
      var k = (y * w + x) * 4; if (d[k + 3] < 250) return;
      var key = (d[k] >> 4) << 8 | (d[k + 1] >> 4) << 4 | (d[k + 2] >> 4), b = buckets[key] || (buckets[key] = { n: 0, r: 0, g: 0, b: 0 });
      b.n++; b.r += d[k]; b.g += d[k + 1]; b.b += d[k + 2]; total++;
    }
    for (i = 0; i < w; i++) { at(i, 0); at(i, hh - 1); }
    for (i = 1; i < hh - 1; i++) { at(0, i); at(w - 1, i); }
    var best = null; Object.keys(buckets).forEach(function (k) { if (!best || buckets[k].n > best.n) best = buckets[k]; });
    var guess = null;
    if (best && total && best.n / total >= 0.6) {
      var hx = function (v) { var s = Math.round(v / best.n).toString(16); return s.length < 2 ? '0' + s : s; };
      guess = '#' + hx(best.r) + hx(best.g) + hx(best.b);
    }
    return { alpha: clear > n * 0.005, guess: guess };
  }

  function load(source, name) {
    var T = window.Trace;
    if (!T || typeof T.imageDataFrom !== 'function') { toast('Pictures cannot be read in this browser.', { kind: 'bad', label: 'Picture' }); return Promise.resolve(false); }
    if (source instanceof Blob) {
      if (!accepts(source)) { toast('Use a PNG, JPG, WebP or GIF picture.', { kind: 'bad', label: 'Picture' }); return Promise.resolve(false); }
      if (source.size > MAX_FILE) { toast('This picture is larger than 25 MB. Save a smaller copy and try again.', { kind: 'bad', label: 'Picture', timeout: 8000 }); return Promise.resolve(false); }
    }
    var uid = ++S.uid;
    return T.imageDataFrom(source, { maxSide: MAX_SIDE }).then(function (img) {
      if (uid !== S.uid) return false;
      var c = canvas(img.width, img.height), x = c.getContext('2d', { willReadFrequently: true });
      var data = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data);
      x.putImageData(new ImageData(data, img.width, img.height), 0, 0);
      var facts = study(img);
      cancelJob();
      S.pic = { canvas: c, w: img.width, h: img.height, name: baseName(name || (source && source.name)), uid: uid, alpha: facts.alpha, guess: facts.guess };
      S.disp = canvas(img.width, img.height);
      S.steps = []; S.undo = []; S.redo = []; S.res = null; S.baked = {}; S.bgSeen = null; S.error = ''; S.cancelled = false;
      S.keep = []; S.to = []; S.into = []; S.names = []; S.paths = []; S.hover = -1; S.cacheKey = ''; S.view = 'after';
      var hoop = M.doc.hoop, ratio = img.height / img.width;
      S.set.width = Math.round(G.clamp(Math.min(hoop.w * 0.8, hoop.h * 0.8 / ratio), MIN_W, MAX_W));
      redrawDisp();
      render(); layout(); draw();
      run();
      say('Picture ready to turn into shapes');
      return true;
    }).catch(function () {
      if (uid === S.uid) toast('This picture could not be opened.', { kind: 'bad', label: 'Picture' });
      return false;
    });
  }

  /* A picture on the clipboard: an image file, or a data: / http(s) address of one as text. */
  function pictureFrom(dt) {
    if (!dt) return null;
    var types = Array.prototype.slice.call(dt.types || []);
    if (types.indexOf(MARK) >= 0) return null;                  /* shapes copied in the editor */
    var i, items = dt.items;
    if (items) for (i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && TYPES.test(items[i].type || '')) { var f = items[i].getAsFile(); if (f) return { blob: f, name: f.name || 'pasted picture' }; }
    }
    if (dt.files) for (i = 0; i < dt.files.length; i++) if (accepts(dt.files[i])) return { blob: dt.files[i], name: dt.files[i].name };
    var text = '';
    try { text = (dt.getData('text/plain') || '').trim(); } catch (e) { text = ''; }
    var m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+\/=\s]+)$/.exec(text);
    if (m && text.length < 36e6) {
      try {
        var bin = atob(m[2].replace(/\s+/g, '')), bytes = new Uint8Array(bin.length);
        for (i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { blob: new Blob([bytes], { type: m[1] }), name: 'pasted picture' };
      } catch (e) { return null; }
    }
    if (/^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?\S*)?$/i.test(text) && text.length < 2048) return { url: text, name: text.split('/').pop().split('?')[0] };
    return null;
  }
  Vz.takePaste = function (dt) {
    var p = pictureFrom(dt); if (!p) return false;
    if (p.url) {
      Vz.open();
      fetch(p.url, { mode: 'cors', credentials: 'omit' }).then(function (r) { if (!r.ok) throw new Error('http'); return r.blob(); }).then(function (b) {
        if (!TYPES.test(b.type || '')) throw new Error('type');
        return load(b, p.name);
      }).catch(function () { toast('That picture could not be fetched. Copy the picture itself and paste again.', { kind: 'bad', label: 'Picture', timeout: 7000 }); });
      return true;
    }
    Vz.open(p.blob, p.name);
    return true;
  };

  /* ==========================================================================
     Erase steps and the working copy
     ========================================================================== */
  function paintSteps(x, steps, colour) {
    steps.forEach(function (s) {
      x.save();
      x.globalCompositeOperation = colour ? 'source-over' : 'destination-out';
      x.fillStyle = x.strokeStyle = colour || '#000';
      x.lineCap = 'round'; x.lineJoin = 'round';
      if (s.kind === 'brush') {
        x.lineWidth = s.r * 2;
        x.beginPath(); x.moveTo(s.pts[0][0], s.pts[0][1]);
        if (s.pts.length === 1) { x.arc(s.pts[0][0], s.pts[0][1], s.r, 0, Math.PI * 2); x.fill(); }
        else { for (var i = 1; i < s.pts.length; i++) x.lineTo(s.pts[i][0], s.pts[i][1]); x.stroke(); }
      } else if (s.rings) {
        var p = ringsPath(s.rings); x.fill(p, 'evenodd'); x.lineWidth = 3; x.stroke(p);
      } else if (s.line) {
        x.lineWidth = s.line.w + 3; x.stroke(linePath(s.line.pts, s.line.closed));
      }
      x.restore();
    });
  }
  function redrawDisp() {
    var p = S.pic; if (!p) return;
    var x = S.disp.getContext('2d');
    x.clearRect(0, 0, p.w, p.h); x.drawImage(p.canvas, 0, 0);
    paintSteps(x, S.steps, null);
  }
  /* What erased pixels become in the picture that is traced (see the head of the file). */
  function eraseColour() {
    var p = S.pic;
    if (!p || S.set.bg === 'off' || p.alpha) return null;
    return S.bgSeen || p.guess || null;
  }
  function traceImage() {
    var p = S.pic, c = canvas(p.w, p.h), x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(p.canvas, 0, 0);
    if (S.steps.length) paintSteps(x, S.steps, eraseColour());
    return x.getImageData(0, 0, p.w, p.h);
  }
  function pushSteps(next) {
    S.undo.push(S.steps); if (S.undo.length > 100) S.undo.shift();
    S.steps = next; S.redo = [];
    stepsChanged();
  }
  function stepsChanged() {
    redrawDisp(); S.hover = -1; S.cacheKey = '';
    if (needsTrace()) schedule(300); else { clearTimeout(S.timer); S.timer = 0; }
    render(); draw();
  }
  /* The last result is out of date when a step it was traced with is gone, or a new step is not just a shape
     removed from that very result. */
  function needsTrace() {
    if (!S.res) return !!S.pic;
    var have = {};
    S.steps.forEach(function (s) { have[s.id] = 1; });
    for (var id in S.baked) if (!have[id]) return true;
    return S.steps.some(function (s) { return !S.baked[s.id] && !(s.kind === 'shape' && s.resSeq === S.resSeq); });
  }
  function hiddenShapes() {
    var out = {};
    S.steps.forEach(function (s) { if (s.kind === 'shape' && s.resSeq === S.resSeq && !S.baked[s.id]) out[s.obj] = 1; });
    return out;
  }
  Vz.undo = function () { if (!S.undo.length) return false; S.redo.push(S.steps); S.steps = S.undo.pop(); stepsChanged(); say('Erase undone'); return true; };
  Vz.redo = function () { if (!S.redo.length) return false; S.undo.push(S.steps); S.steps = S.redo.pop(); stepsChanged(); say('Erase redone'); return true; };
  Vz.reset = function () { if (!S.steps.length) return false; pushSteps([]); say('Everything erased is back'); return true; };

  /* ==========================================================================
     Tracing
     ========================================================================== */
  function tracer() {
    var T = window.Trace;
    if (!T || typeof T.createClient !== 'function') return null;
    if (!S.client) S.client = T.createClient();
    return S.client;
  }
  function schedule(ms) { clearTimeout(S.timer); S.timer = setTimeout(run, ms == null ? 250 : ms); }
  function cancelJob() { clearTimeout(S.timer); S.timer = 0; if (S.job) { S.seq++; if (S.client) S.client.cancel(); S.job = false; } }
  Vz.cancel = function () {
    if (!S.job && !S.timer) return false;
    cancelJob(); S.cancelled = true; render(); draw(); say('Stopped'); return true;
  };
  function run() {
    clearTimeout(S.timer); S.timer = 0;
    if (!S.pic) return;
    var client = tracer();
    if (!client) { S.error = 'Turning pictures into shapes is not available in this browser.'; render(); return; }
    var my = ++S.seq, steps = S.steps.slice();
    S.job = true; S.progress = 0; S.error = ''; S.cancelled = false;
    render(); draw();
    var opts = { width: S.set.width, colors: S.set.auto ? 'auto' : S.set.n, maxColors: AUTO_MAX, detail: S.set.detail, background: S.set.bg, x: 0, y: 0 };
    client.trace(traceImage(), opts, { onProgress: function (f) { if (my === S.seq) { S.progress = f; renderProgress(); } } }).then(function (res) {
      if (my !== S.seq) return;
      S.job = false;
      if (!res || !res.ok) {
        S.error = res ? ((res.warnings.filter(function (w) { return w.severity === 'error'; })[0] || {}).message || 'Nothing in this picture can be turned into shapes.') : 'Nothing came back.';
        S.res = null; S.paths = []; render(); draw(); return;
      }
      var prev = S.res, edits = prev ? prev.colors.map(function (c, i) { return { hex: c.hex, keep: S.keep[i] !== false, to: S.to[i] || null, into: S.into[i] >= 0 ? prev.colors[S.into[i]].hex : null }; }) : [];
      S.res = res; S.resSeq = my; S.baked = {};
      steps.forEach(function (s) { S.baked[s.id] = 1; });
      if (res.background && res.background.reason === 'border' && res.background.color) S.bgSeen = res.background.color;
      carry(edits);
      buildPaths(); S.hover = -1; S.cacheKey = '';
      render(); draw();
      if (needsTrace()) schedule(150);                       /* steps were added while it worked */
    }).catch(function (e) {
      if (my !== S.seq) return;
      S.job = false;
      if (e && e.code === 'CANCELLED') S.cancelled = true; else S.error = 'This picture could not be turned into shapes.';
      render(); draw();
    });
  }
  /* Keep the visitor's colour choices over a new trace: matched by the picture colour they were made for. */
  function carry(edits) {
    var cs = S.res.colors;
    S.keep = cs.map(function () { return true; }); S.to = cs.map(function () { return null; }); S.into = cs.map(function () { return -1; });
    function nearest(hex, skip) {
      var best = -1, bd = 48;
      cs.forEach(function (c, j) { if (j === skip) return; var d0 = dist(c.hex, hex); if (d0 < bd) { bd = d0; best = j; } });
      return best;
    }
    function nearestEdit(hex) {
      var best = null, bd = 48;
      edits.forEach(function (e) { var d0 = dist(e.hex, hex); if (d0 < bd) { bd = d0; best = e; } });
      return best;
    }
    cs.forEach(function (c, j) {
      var e = nearestEdit(c.hex); if (!e) return;
      S.keep[j] = e.keep; S.to[j] = e.to;
      if (e.into) S.into[j] = nearest(e.into, j);
    });
    S.editRev++; names();
  }

  /* ---------- the result as it will be used: dropped, recoloured and merged colours applied ---------- */
  function finalIndex(c) {
    var guard = 0;
    while (S.into[c] >= 0 && guard++ < 32) c = S.into[c];
    return c;
  }
  function hexOf(c) { return S.to[c] || S.res.colors[c].hex; }
  function objectColour(i, hidden) {
    var o = S.res.objects[i], c0 = o.trace.color;
    if (hidden[i] || S.keep[c0] === false) return -1;
    var c = finalIndex(c0);
    return S.keep[c] === false ? -1 : c;
  }
  function lineWidth(o) {
    if (o.trace && o.trace.widthMm > 0) return o.trace.widthMm;
    if (o.line && o.line.width) return o.line.width;
    return o.line && o.line.type === 'bean' ? 1 : 0.5;
  }
  function ringsPath(rings) {
    var p = new Path2D();
    rings.forEach(function (r) { if (!r.length) return; p.moveTo(r[0][0], r[0][1]); for (var i = 1; i < r.length; i++) p.lineTo(r[i][0], r[i][1]); p.closePath(); });
    return p;
  }
  function linePath(pts, closed) {
    var p = new Path2D(); if (!pts.length) return p;
    p.moveTo(pts[0][0], pts[0][1]); for (var i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
    if (closed) p.closePath();
    return p;
  }
  function buildPaths() {
    S.paths = []; S.widths = [];
    if (!S.res) return;
    S.res.objects.forEach(function (o, i) {
      if (o.type === 'path') { S.paths[i] = ringsPath(o.rings); S.widths[i] = 0; }
      else { S.paths[i] = linePath(o.points, o.closed); S.widths[i] = lineWidth(o); }
    });
  }
  function names() {
    var r = S.res; if (!r) { S.names = []; return; }
    var fake = { colors: r.colors.map(function (c, i) { return { hex: hexOf(i), thread: { name: S.to[i] ? S.to[i].toUpperCase() : c.thread.name } }; }) };
    var T = Editor.Trace;
    S.names = T && typeof T.threadNames === 'function' ? T.threadNames(fake) : fake.colors.map(function (c) { return c.thread.name; });
  }
  /* The kept shapes, in sewing order, as a result object (colours renumbered to the ones in use). */
  function finalResult() {
    var r = S.res; if (!r) return null;
    var hidden = hiddenShapes(), map = {}, colors = [], objects = [];
    r.objects.forEach(function (o, i) {
      var c = objectColour(i, hidden); if (c < 0) return;
      if (map[c] == null) { map[c] = colors.length; colors.push({ index: colors.length, hex: hexOf(c), name: S.names[c], thread: { name: S.names[c] || r.colors[c].thread.name } }); }
      var n = Object.assign({}, o, { color: hexOf(c), trace: Object.assign({}, o.trace, { color: map[c] }) });
      objects.push(n);
    });
    return { ok: true, objects: objects, colors: colors, size: r.size, origin: r.origin, stats: r.stats, warnings: [] };
  }
  function bounds(objs) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    function add(p) { if (p[0] < b[0]) b[0] = p[0]; if (p[1] < b[1]) b[1] = p[1]; if (p[0] > b[2]) b[2] = p[0]; if (p[1] > b[3]) b[3] = p[1]; }
    objs.forEach(function (o) { if (o.rings) o.rings.forEach(function (r) { r.forEach(add); }); else if (o.points) o.points.forEach(add); });
    return b;
  }

  /* ==========================================================================
     Output
     ========================================================================== */
  Vz.add = function () {
    var fr = finalResult();
    if (!fr || !fr.objects.length) { toast('Nothing to add: every colour is switched off.', { label: 'Picture to SVG' }); return null; }
    var hoop = M.doc.hoop, b = bounds(fr.objects);
    var ox = r2(hoop.w / 2 - (b[0] + b[2]) / 2), oy = r2(hoop.h / 2 - (b[1] + b[3]) / 2);
    var list = Editor.Trace && Editor.Trace.editorList ? Editor.Trace.editorList(fr, { x: ox, y: oy, w: G.clamp(S.set.width, MIN_W, MAX_W) })
      : window.Trace.toEditorObjects(fr);
    var made = M.addMany(list, 'Picture to SVG');
    if (!made.length) { toast('That would be more than ' + M.MAX_OBJECTS + ' shapes in one design. Try fewer colours, or start a new design.', { kind: 'bad', label: 'Picture to SVG', timeout: 8000 }); return null; }
    var ids = made.map(function (o) { return o.id; });
    Vz.close();
    if (Editor.View && Editor.View.mode !== 'design' && Editor.View.setMode) Editor.View.setMode('design');
    var n = made.length;
    toast('Added ' + n + (n === 1 ? ' shape' : ' shapes') + ' in ' + fr.colors.length + (fr.colors.length === 1 ? ' colour.' : ' colours.'), { kind: 'ok', label: 'Picture to SVG', timeout: 7000, action: { label: 'Undo', onClick: function () {
      var have = {}; M.doc.objects.forEach(function (o) { have[o.id] = 1; });
      if (M.undoLabel() === 'Picture to SVG' && ids.some(function (id) { return have[id]; })) M.undo();
    } } });
    say('Picture added as ' + n + ' shapes');
    return made;
  };

  function num(v) { return String(r2(v)); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  Vz.svg = function () {
    var fr = finalResult(); if (!fr) return '';
    var W = fr.size.width, H = fr.size.height, out = [], run = -1;
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + num(W) + 'mm" height="' + num(H) + 'mm" viewBox="0 0 ' + num(W) + ' ' + num(H) + '">');
    out.push('<title>' + esc(S.pic ? S.pic.name : 'picture') + '</title>');
    fr.objects.forEach(function (o) {
      var c = o.trace.color;
      if (c !== run) { if (run >= 0) out.push('</g>'); out.push('<g data-thread="' + esc(fr.colors[c].thread.name) + '">'); run = c; }
      if (o.type === 'path') {
        var d = o.rings.map(function (r) { return 'M' + r.map(function (p) { return num(p[0]) + ',' + num(p[1]); }).join(' L') + ' Z'; }).join(' ');
        out.push('<path fill="' + o.color + '" fill-rule="evenodd" d="' + d + '"/>');
      } else {
        var dl = 'M' + o.points.map(function (p) { return num(p[0]) + ',' + num(p[1]); }).join(' L') + (o.closed ? ' Z' : '');
        out.push('<path fill="none" stroke="' + o.color + '" stroke-width="' + num(lineWidth(o)) + '" stroke-linecap="round" stroke-linejoin="round" d="' + dl + '"/>');
      }
    });
    if (run >= 0) out.push('</g>');
    out.push('</svg>');
    return out.join('\n') + '\n';
  };
  Vz.download = function () {
    var text = Vz.svg();
    if (!text || !finalResult().objects.length) { toast('Nothing to save yet.', { label: 'Picture to SVG' }); return false; }
    var name = (S.pic ? S.pic.name : 'picture') + '.svg';
    window.EL.download(name, text, 'image/svg+xml');
    toast(name + ' saved.', { kind: 'ok', label: 'Picture to SVG' });
    return true;
  };
  Vz.reference = function () {
    if (!S.pic || !Editor.Trace) return Promise.resolve(false);
    var name = S.pic.name;
    return new Promise(function (resolve) { S.disp.toBlob(resolve, 'image/png'); }).then(function (blob) {
      if (!blob) return false;
      var file = new File([blob], name + '.png', { type: 'image/png' });
      Vz.close();
      return Editor.Trace.load(file);
    });
  };

  /* ==========================================================================
     Preview canvas
     ========================================================================== */
  function layout() {
    var st = S.el.stage, c = S.el.canvas; if (!st) return;
    var w = st.clientWidth, hh = st.clientHeight, dpr = Math.min(3, window.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hh * dpr)) { c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(hh * dpr)); S.cacheKey = ''; }
    S.dpr = dpr; S.cw = w; S.ch = hh;
    var p = S.pic; if (!p) { S.rect = null; return; }
    var pad = w < 480 ? 12 : 24, k = Math.min((w - pad * 2) / p.w, (hh - pad * 2) / p.h);
    if (!(k > 0)) k = 0.01;
    var rw = p.w * k, rh = p.h * k;
    S.rect = { x: Math.round((w - rw) / 2), y: Math.round((hh - rh) / 2), w: rw, h: rh, k: k };
  }
  function mmScale() { return S.res && S.rect ? S.rect.w / S.res.size.width : 1; }
  var checker = null;
  function checkerPattern(x) {
    if (!checker) {
      var c = canvas(16, 16), g = c.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 16, 16); g.fillStyle = '#f1efea'; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
      checker = c;
    }
    return x.createPattern(checker, 'repeat');
  }
  function afterCanvas() {
    var r = S.rect, dpr = S.dpr, key = [S.resSeq, S.editRev, S.steps.length, S.steps.map(function (s) { return s.id; }).join(','), Math.round(r.w * dpr), Math.round(r.h * dpr)].join('|');
    if (S.cache && S.cacheKey === key) return S.cache;
    var c = S.cache && S.cache.width === Math.round(r.w * dpr) && S.cache.height === Math.round(r.h * dpr) ? S.cache : canvas(Math.round(r.w * dpr), Math.round(r.h * dpr));
    var x = c.getContext('2d'), k = mmScale() * dpr, hidden = hiddenShapes();
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height);
    x.setTransform(k, 0, 0, k, 0, 0); x.lineCap = 'round'; x.lineJoin = 'round';
    S.res.objects.forEach(function (o, i) {
      var cc = objectColour(i, hidden); if (cc < 0) return;
      var hex = hexOf(cc);
      if (o.type === 'path') { x.fillStyle = hex; x.fill(S.paths[i], 'evenodd'); }
      else { x.strokeStyle = hex; x.lineWidth = Math.max(S.widths[i], 1 / k); x.stroke(S.paths[i]); }
    });
    S.cache = c; S.cacheKey = key;
    return c;
  }
  function draw() {
    var c = S.el.canvas; if (!c || !S.dlg || !S.dlg.open) return;
    var x = c.getContext('2d'), dpr = S.dpr, r = S.rect;
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, c.width, c.height);
    S.el.drop.hidden = !!S.pic;
    S.el.stage.classList.toggle('is-empty', !S.pic);
    if (!S.pic || !r) return;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.save(); x.shadowColor = 'rgba(43,45,49,.10)'; x.shadowBlur = 12; x.shadowOffsetY = 2;
    x.fillStyle = '#fff'; x.fillRect(r.x, r.y, r.w, r.h); x.restore();
    x.fillStyle = checkerPattern(x); x.fillRect(r.x, r.y, r.w, r.h);
    var before = function () { x.imageSmoothingQuality = 'high'; x.drawImage(S.disp, r.x, r.y, r.w, r.h); };
    var after = function () {
      if (!S.res) { x.globalAlpha = 0.35; before(); x.globalAlpha = 1; return; }
      if (S.job) x.globalAlpha = 0.55;
      x.drawImage(afterCanvas(), r.x, r.y, r.w, r.h); x.globalAlpha = 1;
    };
    if (S.view === 'before') before();
    else if (S.view === 'after') after();
    else {
      var sx = r.x + r.w * S.split;
      x.save(); x.beginPath(); x.rect(r.x, r.y, sx - r.x, r.h); x.clip(); before(); x.restore();
      x.save(); x.beginPath(); x.rect(sx, r.y, r.x + r.w - sx, r.h); x.clip(); x.fillStyle = '#fff'; x.fillRect(sx, r.y, r.x + r.w - sx, r.h); x.fillStyle = checkerPattern(x); x.fillRect(sx, r.y, r.x + r.w - sx, r.h); after(); x.restore();
      x.fillStyle = '#ffffff'; x.fillRect(sx - 1, r.y, 2, r.h);
      x.beginPath(); x.arc(sx, r.y + r.h / 2, 11, 0, Math.PI * 2); x.fillStyle = '#fff'; x.fill(); x.strokeStyle = 'rgba(43,45,49,.25)'; x.lineWidth = 1; x.stroke();
      x.strokeStyle = '#6B6E74'; x.lineWidth = 1.5; x.beginPath(); x.moveTo(sx - 3, r.y + r.h / 2 - 4); x.lineTo(sx - 6, r.y + r.h / 2); x.lineTo(sx - 3, r.y + r.h / 2 + 4); x.moveTo(sx + 3, r.y + r.h / 2 - 4); x.lineTo(sx + 6, r.y + r.h / 2); x.lineTo(sx + 3, r.y + r.h / 2 + 4); x.stroke();
    }
    /* the shape under the shape eraser */
    if (S.tool === 'shape' && S.hover >= 0 && S.res && S.paths[S.hover]) {
      var k = mmScale();
      x.save(); x.translate(r.x, r.y); x.scale(k, k);
      x.lineJoin = 'round'; x.lineCap = 'round';
      var o = S.res.objects[S.hover];
      if (o.type === 'path') { x.fillStyle = 'rgba(181,71,90,.35)'; x.fill(S.paths[S.hover], 'evenodd'); x.strokeStyle = '#B5475A'; x.lineWidth = 2 / k; x.stroke(S.paths[S.hover]); }
      else { x.strokeStyle = 'rgba(181,71,90,.7)'; x.lineWidth = Math.max(S.widths[S.hover], 1 / k) + 3 / k; x.stroke(S.paths[S.hover]); }
      x.restore();
    }
    /* the brush */
    if (S.tool === 'brush' && S.cursor) {
      x.beginPath(); x.arc(S.cursor[0], S.cursor[1], S.brush / 2, 0, Math.PI * 2);
      x.lineWidth = 2.5; x.strokeStyle = 'rgba(255,255,255,.9)'; x.stroke();
      x.lineWidth = 1; x.strokeStyle = 'rgba(43,45,49,.75)'; x.stroke();
    }
  }

  /* ---------- pointer ---------- */
  function local(e) { var b = S.el.canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; }
  function toPic(p) { var r = S.rect; return [(p[0] - r.x) / r.k, (p[1] - r.y) / r.k]; }
  function toMm(p) { var r = S.rect, k = mmScale(); return [(p[0] - r.x) / k, (p[1] - r.y) / k]; }
  var hitCtx = null;
  function hit(p) {
    if (!S.res || !S.rect) return -1;
    if (!hitCtx) hitCtx = canvas(1, 1).getContext('2d');
    var m = toMm(p), k = mmScale(), hidden = hiddenShapes(), i;
    hitCtx.lineCap = 'round'; hitCtx.lineJoin = 'round';
    for (i = S.res.objects.length - 1; i >= 0; i--) {
      if (objectColour(i, hidden) < 0) continue;
      if (S.res.objects[i].type === 'path') { if (hitCtx.isPointInPath(S.paths[i], m[0], m[1], 'evenodd')) return i; }
      else { hitCtx.lineWidth = Math.max(S.widths[i], 10 / k); if (hitCtx.isPointInStroke(S.paths[i], m[0], m[1])) return i; }
    }
    return -1;
  }
  function nearSplit(p) { var r = S.rect; return S.view === 'split' && r && Math.abs(p[0] - (r.x + r.w * S.split)) < 14 && p[1] >= r.y && p[1] <= r.y + r.h; }
  function eraseShape(i) {
    var o = S.res.objects[i], k = S.pic.w / S.res.size.width;   /* picture pixels per mm */
    function px(q) { return [q[0] * k, q[1] * k]; }
    var step = { id: ++S.stepId, kind: 'shape', obj: i, resSeq: S.resSeq };
    if (o.type === 'path') step.rings = o.rings.map(function (r) { return r.map(px); });
    else step.line = { pts: o.points.map(px), closed: !!o.closed, w: S.widths[i] * k };
    pushSteps(S.steps.concat([step]));
    say('Shape removed');
  }
  function brushSegment(a, b, r) {
    var x = S.disp.getContext('2d');
    x.save(); x.globalCompositeOperation = 'destination-out'; x.lineCap = 'round'; x.lineWidth = r * 2; x.strokeStyle = '#000'; x.fillStyle = '#000';
    x.beginPath(); if (!b) { x.arc(a[0], a[1], r, 0, Math.PI * 2); x.fill(); } else { x.moveTo(a[0], a[1]); x.lineTo(b[0], b[1]); x.stroke(); }
    x.restore();
  }
  function wirePointer() {
    var c = S.el.canvas;
    c.addEventListener('pointerdown', function (e) {
      if (!S.pic || !S.rect || (e.button !== 0 && e.pointerType === 'mouse')) return;
      var p = local(e);
      if (nearSplit(p)) { S.dragSplit = true; c.setPointerCapture(e.pointerId); e.preventDefault(); return; }
      if (S.tool === 'brush') {
        var q = toPic(p), r = (S.brush / 2) / S.rect.k;
        S.stroke = { id: ++S.stepId, kind: 'brush', r: r, pts: [q], pid: e.pointerId };
        brushSegment(q, null, r); c.setPointerCapture(e.pointerId); e.preventDefault(); S.cursor = p; draw();
        return;
      }
      if (S.tool === 'shape') { S.press = { p: p, i: hit(p) }; c.setPointerCapture(e.pointerId); e.preventDefault(); }
    });
    c.addEventListener('pointermove', function (e) {
      if (!S.pic || !S.rect) return;
      var p = local(e);
      if (S.dragSplit) { S.split = G.clamp((p[0] - S.rect.x) / S.rect.w, 0.02, 0.98); draw(); return; }
      S.cursor = p;
      if (S.stroke && e.pointerId === S.stroke.pid) {
        var q = toPic(p), last = S.stroke.pts[S.stroke.pts.length - 1];
        if (Math.hypot(q[0] - last[0], q[1] - last[1]) >= S.stroke.r * 0.2) { S.stroke.pts.push(q); brushSegment(last, q, S.stroke.r); }
        draw(); return;
      }
      if (S.tool === 'shape') { var i = hit(p); if (i !== S.hover) { S.hover = i; } draw(); }
      else if (S.tool === 'brush') draw();
      c.style.cursor = nearSplit(p) ? 'ew-resize' : '';
    });
    function end(e) {
      if (S.dragSplit) { S.dragSplit = false; return; }
      if (S.stroke && e.pointerId === S.stroke.pid) {
        var s = S.stroke; S.stroke = null; delete s.pid;
        if (e.type === 'pointercancel') { redrawDisp(); draw(); return; }
        pushSteps(S.steps.concat([s]));
        say('Erased');
        return;
      }
      if (S.press) {
        var pr = S.press; S.press = null;
        if (e.type === 'pointerup' && pr.i >= 0) { var p = local(e); if (Math.hypot(p[0] - pr.p[0], p[1] - pr.p[1]) < 8 && hit(p) === pr.i) eraseShape(pr.i); }
      }
    }
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', function () { if (!S.stroke) { S.cursor = null; if (S.tool === 'shape') S.hover = -1; draw(); } });
    c.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  /* ==========================================================================
     The panel
     ========================================================================== */
  function pressSeg(g, v) { Array.prototype.forEach.call(g.querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-v') === v || b.getAttribute('data-tool') === v ? 'true' : 'false'); }); }
  function renderProgress() {
    var E = S.el, pct = Math.round(G.clamp(S.progress, 0, 1) * 100);
    E.bar.style.width = Math.max(4, pct) + '%';
    E.busyText.textContent = (S.progress < 0.36 && S.set.auto ? 'Choosing colours ' : 'Working ') + pct + '%';
  }
  function render() {
    var E = S.el; if (!S.dlg) return;
    var r = S.res, has = !!S.pic, U = units();
    pressSeg(E.view, S.view); pressSeg(E.tools, S.tool); pressSeg(E.bg, S.set.bg); pressSeg(E.detail, S.set.detail);
    S.el.stage.setAttribute('data-tool', S.tool);
    E.brushBox.hidden = S.tool !== 'brush';
    E.brushSize.value = S.brush; if (window.EL) window.EL.syncSlider(E.brushSize);
    E.undo.disabled = !S.undo.length; E.redo.disabled = !S.redo.length; E.reset.disabled = !S.steps.length;
    E.auto.checked = S.set.auto;
    E.count.value = S.set.auto ? (r ? r.colors.length : 6) : S.set.n;
    E.count.classList.toggle('is-auto', S.set.auto);
    if (window.EL) window.EL.syncSlider(E.count);
    E.countVal.textContent = S.set.auto ? (r ? 'Auto ' + r.colors.length : 'Auto') : String(S.set.n);
    E.width.max = String(Math.max(300, Math.round(Math.max(M.doc.hoop.w, M.doc.hoop.h)))); E.width.value = S.set.width;
    if (window.EL) window.EL.syncSlider(E.width);
    E.widthVal.textContent = U ? U.text(S.set.width) : S.set.width + ' mm';
    renderColours();
    E.busy.hidden = !S.job; if (S.job) renderProgress();
    var fr = r ? finalResult() : null, text = '';
    if (fr && has) {
      var st = fr.objects.reduce(function (a, o) { return a + ((o.trace && o.trace.stitches) || 0); }, 0);
      text = fr.objects.length + (fr.objects.length === 1 ? ' shape' : ' shapes') + ' · ' + fr.colors.length + (fr.colors.length === 1 ? ' colour' : ' colours') + ' · ~' + fmt(Math.round(st / 10) * 10) + ' stitches';
      if (U) text += ' · ' + U.sizeShort(r.size.width, r.size.height) + ' ' + U.label();
    }
    E.meta.textContent = S.job ? '' : text; E.meta.hidden = S.job || !text;
    var note = S.error || (S.cancelled ? 'Stopped. Change a setting to try again.' : '');
    E.note.textContent = note; E.note.hidden = !note || S.job; E.note.classList.toggle('is-bad', !!S.error);
    var ready = !!(fr && fr.objects.length && !S.job);
    E.add.disabled = !ready; E.svg.disabled = !ready; E.ref.disabled = !has;
    [E.count, E.auto, E.width].forEach(function (n) { n.disabled = !has; });
    Array.prototype.forEach.call(E.bg.querySelectorAll('button'), function (b) { b.disabled = !has; });
    Array.prototype.forEach.call(E.detail.querySelectorAll('button'), function (b) { b.disabled = !has; });
    Array.prototype.forEach.call(E.tools.querySelectorAll('button'), function (b) { b.disabled = !has; });
    Array.prototype.forEach.call(E.view.querySelectorAll('button'), function (b) { b.disabled = !has; });
  }
  function renderColours() {
    var list = S.el.list, r = S.res;
    while (list.firstChild) list.removeChild(list.firstChild);
    list.hidden = !r;
    if (!r) return;
    r.colors.forEach(function (c, i) {
      var row = h('div', 'vz__color'); row.setAttribute('role', 'listitem'); row.setAttribute('data-i', String(i));
      var merged = S.into[i] >= 0, off = S.keep[i] === false || (merged && S.keep[finalIndex(i)] === false);
      row.classList.toggle('is-off', off);
      var keep = h('input', 'check'); keep.type = 'checkbox'; keep.checked = S.keep[i] !== false; keep.setAttribute('aria-label', 'Keep ' + (S.names[i] || c.hex));
      keep.addEventListener('change', function () { S.keep[i] = keep.checked; edited(); say(keep.checked ? 'Colour kept' : 'Colour dropped'); });
      var sw = h('label', 'vz__swatch'); sw.title = 'Change colour'; sw.style.setProperty('--c', merged ? hexOf(finalIndex(i)) : hexOf(i));
      var pick = h('input'); pick.type = 'color'; pick.value = hexOf(i); pick.setAttribute('aria-label', 'Colour of ' + (S.names[i] || c.hex));
      pick.addEventListener('input', function () { S.to[i] = pick.value.toLowerCase() === c.hex.toLowerCase() ? null : pick.value.toLowerCase(); sw.style.setProperty('--c', hexOf(i)); edited(true); });
      pick.addEventListener('change', function () { renderColours(); });
      sw.appendChild(pick);
      var name = h('span', 'vz__name');
      name.appendChild(h('span', 'vz__thread', S.names[i] || c.thread.name));
      if (merged) name.appendChild(h('span', 'vz__into', '\u2192 ' + (S.names[finalIndex(i)] || '')));
      else name.appendChild(h('span', 'num vz__share', Math.max(1, Math.round(c.share * 100)) + '%'));
      var sel = h('select', 'vz__merge'); sel.setAttribute('aria-label', 'Merge ' + (S.names[i] || c.hex) + ' into');
      sel.title = 'Merge into another colour';
      var own = h('option', null, merged ? 'Own colour' : 'Merge into…'); own.value = '-1'; sel.appendChild(own);
      r.colors.forEach(function (c2, j) {
        if (j === i || S.into[j] >= 0) return;
        var op = h('option', null, 'Into ' + (S.names[j] || c2.hex)); op.value = String(j); sel.appendChild(op);
      });
      sel.value = String(S.into[i] >= 0 ? S.into[i] : -1);
      sel.addEventListener('change', function () {
        var j = Number(sel.value);
        S.into[i] = j >= 0 && j !== i ? j : -1;
        /* anything that was merged into this colour follows it */
        S.into.forEach(function (t, k) { if (t === i && S.into[i] >= 0) S.into[k] = S.into[i]; });
        edited(); say(S.into[i] >= 0 ? 'Colours merged' : 'Colour on its own again');
      });
      row.appendChild(keep); row.appendChild(sw); row.appendChild(name); row.appendChild(sel);
      row.classList.toggle('is-merged', merged);
      list.appendChild(row);
    });
  }
  /* A colour was kept, dropped, recoloured or merged: no new trace, just a new picture of the result. */
  function edited(soft) {
    S.editRev++; names(); S.cacheKey = '';
    if (soft) { draw(); renderMetaOnly(); return; }
    render(); draw();
  }
  function renderMetaOnly() {
    var r = S.res; if (!r) return;
    var fr = finalResult(), st = fr.objects.reduce(function (a, o) { return a + ((o.trace && o.trace.stitches) || 0); }, 0), U = units();
    S.el.meta.textContent = fr.objects.length + (fr.objects.length === 1 ? ' shape' : ' shapes') + ' · ' + fr.colors.length + (fr.colors.length === 1 ? ' colour' : ' colours') + ' · ~' + fmt(Math.round(st / 10) * 10) + ' stitches' + (U ? ' · ' + U.sizeShort(r.size.width, r.size.height) + ' ' + U.label() : '');
  }

  Vz.setTool = function (t) {
    if (t !== 'look' && t !== 'brush' && t !== 'shape') return;
    S.tool = t; S.hover = -1;
    if (t === 'brush' && S.view === 'after') S.view = 'before';
    if (t === 'shape' && S.view === 'before') S.view = 'after';
    render(); draw();
  };
  Vz.setView = function (v) { if (SEG.view.some(function (s) { return s[0] === v; })) { S.view = v; render(); draw(); } };
  function setBrush(px) { S.brush = G.clamp(Math.round(px), 6, 120); render(); draw(); }
  function settingChanged(ms) { savePrefs(); S.cancelled = false; render(); if (S.pic) schedule(ms); }

  function wire() {
    var E = S.el, d = S.dlg;
    E.view.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) Vz.setView(b.getAttribute('data-v')); });
    E.tools.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) Vz.setTool(b.getAttribute('data-tool')); });
    E.bg.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b && S.set.bg !== b.getAttribute('data-v')) { S.set.bg = b.getAttribute('data-v'); settingChanged(); } });
    E.detail.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b && S.set.detail !== b.getAttribute('data-v')) { S.set.detail = b.getAttribute('data-v'); settingChanged(); } });
    E.auto.addEventListener('change', function () { S.set.auto = E.auto.checked; settingChanged(); });
    E.count.addEventListener('input', function () { S.set.auto = false; S.set.n = G.clamp(Number(E.count.value) || 6, 2, MAX_COLOURS); settingChanged(); });
    E.width.addEventListener('input', function () { S.set.width = G.clamp(Number(E.width.value) || 100, MIN_W, MAX_W); S.el.widthVal.textContent = units() ? units().text(S.set.width) : S.set.width + ' mm'; if (S.pic) schedule(300); });
    E.brushSize.addEventListener('input', function () { setBrush(Number(E.brushSize.value)); });
    E.undo.addEventListener('click', Vz.undo); E.redo.addEventListener('click', Vz.redo); E.reset.addEventListener('click', Vz.reset);
    E.cancel.addEventListener('click', Vz.cancel);
    E.add.addEventListener('click', function () { Vz.add(); });
    E.svg.addEventListener('click', function () { Vz.download(); });
    E.ref.addEventListener('click', function () { Vz.reference(); });
    E.pick.addEventListener('click', function () { E.input.click(); });
    E.drop.addEventListener('click', function () { E.input.click(); });
    E.input.addEventListener('change', function () { var f = E.input.files && E.input.files[0]; E.input.value = ''; if (f) load(f, f.name); });
    /* drop a picture anywhere on the sheet */
    function files(e) { var t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0; }
    d.addEventListener('dragover', function (e) { if (!files(e)) return; e.preventDefault(); e.stopPropagation(); E.stage.classList.add('is-over'); });
    d.addEventListener('dragleave', function (e) { if (e.target === E.stage || e.target === E.canvas || e.target === E.drop) E.stage.classList.remove('is-over'); });
    d.addEventListener('drop', function (e) {
      if (!files(e)) return; e.preventDefault(); e.stopPropagation(); E.stage.classList.remove('is-over');
      var f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) load(f, f.name);
    });
    d.addEventListener('keydown', onKey);
    d.addEventListener('close', function () { cancelJob(); S.stroke = null; S.cursor = null; });
    wirePointer();
    window.addEventListener('resize', function () { if (d.open) { layout(); draw(); } });
    if (window.ResizeObserver) new ResizeObserver(function () { if (d.open) { layout(); draw(); } }).observe(E.stage);
    Editor.on('units', function () { if (d.open) render(); });
  }
  function onKey(e) {
    var t = e.target, tag = t && t.tagName, mod = e.metaKey || e.ctrlKey, k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    var typing = tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && !/^(range|checkbox|color|button|file)$/i.test(t.type));
    if (typing || e.isComposing) return;
    if (mod && !e.altKey && k === 'z') { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) Vz.redo(); else Vz.undo(); return; }
    if (mod && !e.altKey && !e.shiftKey && k === 'y') { e.preventDefault(); e.stopPropagation(); Vz.redo(); return; }
    if (mod || e.altKey) return;
    if (k === 'b') { e.preventDefault(); Vz.setTool('brush'); }
    else if (k === 'e') { e.preventDefault(); Vz.setTool('shape'); }
    else if (k === 'v') { e.preventDefault(); Vz.setTool('look'); }
    else if (k === '[') { e.preventDefault(); setBrush(S.brush / 1.25); }
    else if (k === ']') { e.preventDefault(); setBrush(S.brush * 1.25); }
  }

  /* ==========================================================================
     Open / close
     ========================================================================== */
  Vz.isOpen = function () { return !!(S.dlg && S.dlg.open); };
  Vz.open = function (source, name) {
    build();
    if (!S.dlg.open) { if (window.EL) window.EL.dialog.open(S.dlg); else S.dlg.showModal(); }
    render(); layout(); draw();
    if (source) return load(source, name);
    (S.pic ? S.el.add : S.el.drop).focus();
    if (S.pic && needsTrace() && !S.job) run();
    return Promise.resolve(!!S.pic);
  };
  Vz.close = function () { if (S.dlg && S.dlg.open) { if (window.EL) window.EL.dialog.close(S.dlg); else S.dlg.close(); } };
  Vz.state = function () {
    var fr = S.res ? finalResult() : null;
    return {
      open: Vz.isOpen(), picture: S.pic ? { w: S.pic.w, h: S.pic.h, name: S.pic.name, alpha: S.pic.alpha, guess: S.pic.guess } : null,
      busy: S.job, error: S.error, view: S.view, tool: S.tool, brush: S.brush, settings: Object.assign({}, S.set),
      steps: S.steps.length, canUndo: S.undo.length > 0, canRedo: S.redo.length > 0, resSeq: S.resSeq,
      colors: S.res ? S.res.colors.map(function (c, i) { return { hex: c.hex, now: hexOf(i), name: S.names[i], share: c.share, keep: S.keep[i] !== false, into: S.into[i] }; }) : [],
      background: S.res ? S.res.background : null, objects: S.res ? S.res.objects.length : 0,
      shapes: fr ? fr.objects.length : 0, rect: S.rect, mmScale: mmScale(), size: S.res ? S.res.size : null
    };
  };
  /* where (in page pixels) a traced shape can be clicked: a point inside it, for tests */
  Vz.pointOf = function (i) {
    if (!S.res || !S.rect) return null;
    var b = S.el.canvas.getBoundingClientRect(), k = mmScale(), o = S.res.objects[i], x, y;
    if (!o) return null;
    var bb = bounds([o]), steps = 24;
    if (!hitCtx) hitCtx = canvas(1, 1).getContext('2d');
    for (var a = 0; a <= steps; a++) for (var c = 0; c <= steps; c++) {
      x = bb[0] + (bb[2] - bb[0]) * (0.5 + (a % 2 ? 1 : -1) * Math.ceil(a / 2) / steps); y = bb[1] + (bb[3] - bb[1]) * (0.5 + (c % 2 ? 1 : -1) * Math.ceil(c / 2) / steps);
      if (o.type === 'path' ? hitCtx.isPointInPath(S.paths[i], x, y, 'evenodd') : true) {
        var p = [S.rect.x + x * k, S.rect.y + y * k];
        if (hit(p) === i) return [b.left + p[0], b.top + p[1]];
      }
    }
    return null;
  };
  Vz.picToPage = function (px, py) {
    if (!S.rect) return null;
    var b = S.el.canvas.getBoundingClientRect();
    return [b.left + S.rect.x + px * S.rect.k, b.top + S.rect.y + py * S.rect.k];
  };

  /* entry points: File > Picture to SVG, the phone's More menu, the picture card */
  document.addEventListener('click', function (e) {
    var t = e.target instanceof Element ? e.target : null; if (!t) return;
    if (t.closest('[data-action="vectorize"]')) { Vz.open(); return; }   /* File menu: main.js */
    if (t.closest('#trace-vectorize')) {
      var tr = Editor.View && Editor.View.trace, pic = tr ? (tr.pic || tr.img) : null;
      if (pic) Vz.open(pic, 'picture'); else Vz.open();
    }
  });
  Vz.MARK = MARK;
})();
