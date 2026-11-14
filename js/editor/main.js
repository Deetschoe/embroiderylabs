/* ==========================================================================
   EMBROIDERY LABS - js/editor/main.js
   Boot, and everything around the canvas that is not a panel or a tool:
     top bar (design name, saved tag, undo / redo, view mode, export + formats)
     keyboard shortcuts (ignored while typing in a field)
     zoom HUD, Clear, the tablet drawer, the phone sheet (detents, drag) / dock
     stitch-out playback, opening files (SVG -> svgimport.js, picture -> trace.js),
     the empty hoop and the example design, the help dialog, the tutorial hook (tutorial.js)
     Editor.say(): one line for screen readers (#live)
   ========================================================================== */
(function () {
  'use strict';
  var Editor = window.Editor;
  if (!Editor || !Editor.Model || !Editor.View || !Editor.IO || !Editor.Panels || !Editor.Tools) return;
  var M = Editor.Model, V = Editor.View, IO = Editor.IO, P = Editor.Panels, T = Editor.Tools;
  function $(id) { return document.getElementById(id); }
  function on(node, type, fn, opts) { if (node) node.addEventListener(type, fn, opts); }
  var toast = Editor.toast;
  var isMac = /mac|iphone|ipad|ipod/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');

  /* ---------- screen reader line ---------------------------------------------------- */
  var liveTimer = 0;
  Editor.say = function (msg) {
    var live = $('live'); if (!live) return;
    live.textContent = '';
    clearTimeout(liveTimer);
    liveTimer = setTimeout(function () { live.textContent = String(msg); }, 40);
  };

  /* ---------- design name ----------------------------------------------------------- */
  function initName() {
    var input = $('design-name');
    function show() { if (document.activeElement !== input) input.value = M.doc.name; }
    on(input, 'input', function () { M.setName(input.value); });
    on(input, 'change', function () { M.setName(input.value); input.value = M.doc.name; });
    on(input, 'blur', function () { input.value = M.doc.name; });
    on(input, 'keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); input.blur(); }
    });
    on(input, 'focus', function () { try { input.select(); } catch (e) { /* not selectable */ } });
    Editor.on('change', function (e) { if (e && e.reason === 'load') show(); });
    show();
  }

  /* ---------- saved tag ---------------------------------------------------------------- */
  function initSaved() {
    var tag = $('save-state'), was = IO.saveState;
    var WHY = 'Your design is not being saved: browser storage is off or full. Export a file to keep your work.';
    function render() {
      var s = IO.saveState;
      tag.textContent = s === 'failed' ? 'Not saved' : s === 'pending' ? 'Saving...' : 'Saved on this device';
      if (s === 'failed') tag.title = WHY; else tag.removeAttribute('title');
      tag.classList.toggle('tag--bad', s === 'failed');
      tag.classList.toggle('is-busy', s === 'pending');
      /* the tag is not on screen on a phone, so a failure is also said out loud, once */
      if (s === 'failed' && was !== 'failed') toast(WHY, { kind: 'bad', label: 'Not saved', timeout: 10000 });
      was = s;
    }
    Editor.on('saved', render);
    render();
  }

  /* ---------- undo / redo ---------------------------------------------------------------- */
  function undo() {
    if (T.undoPoint()) return;                 /* placing a polygon: take back the last point */
    T.cancel();
    var label = M.undo();
    if (label) Editor.say('Undid: ' + label); else Editor.say('Nothing to undo');
  }
  function redo() {
    if (T.busy()) return;
    var label = M.redo();
    if (label) Editor.say('Redid: ' + label); else Editor.say('Nothing to redo');
  }
  function initHistory() {
    var u = $('btn-undo'), r = $('btn-redo');
    function render() {
      u.disabled = !M.canUndo(); r.disabled = !M.canRedo();
      u.setAttribute('data-tip', M.canUndo() ? 'Undo: ' + M.undoLabel() : 'Undo');
      r.setAttribute('data-tip', M.canRedo() ? 'Redo: ' + M.redoLabel() : 'Redo');
    }
    on(u, 'click', undo); on(r, 'click', redo);
    Editor.on('history', render);
    render();
  }

  /* ---------- design / stitch-out view ---------------------------------------------------- */
  function initViewMode() {
    var btns = document.querySelectorAll('[data-view]'), i;   /* the bar, and a second switch on the stage for phones */
    function mock() { return !!(Editor.Mockup && Editor.Mockup.isOpen()); }
    function render() {
      var st = V.mode === 'stitch', current = mock() ? 'mockup' : st ? 'stitch' : 'design';
      for (var k = 0; k < btns.length; k++) btns[k].setAttribute('aria-pressed', btns[k].getAttribute('data-view') === current ? 'true' : 'false');
      V.el.view.classList.toggle('is-stitch', st);
    }
    for (i = 0; i < btns.length; i++) on(btns[i], 'click', function () {
      var want = this.getAttribute('data-view');
      if (want === 'mockup') { if (Editor.Mockup && !mock()) Editor.Mockup.open(); return; }
      var mode = want === 'stitch' ? 'stitch' : 'design', was = mock();
      if (was) Editor.Mockup.close();
      if (mode === V.mode) { if (was) render(); return; }
      T.cancel();
      V.setMode(mode); Editor.say(mode === 'stitch' ? 'Stitch-out view' : 'Design view');
    });
    Editor.on('viewmode', render);
    Editor.on('mockup', render);
    render();
  }

  /* ---------- stitch-out playback -------------------------------------------------------------
     In stitch-out view the design is drawn stitch by stitch in sewing order (view.js draws
     the first V.play.n stitches and the needle). Play runs the whole design in about 15 s.
     With "reduce motion" nothing animates: the button steps one thread colour at a time. */
  function initPlayback() {
    var bar = $('play'), btn = $('play-toggle'), scrub = $('play-scrub'), count = $('play-count');
    if (!bar || !btn || !scrub) return;
    var playing = false, raf = 0, lastT = 0, acc = 0;
    var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    function calm() { return !!(reduce && reduce.matches); }
    function total() { return V.stitch ? V.stitch.count : 0; }
    function pos() { return V.play ? Math.min(V.play.n, total()) : 0; }
    function render() {
      var n = total(), p = pos();
      bar.hidden = V.mode !== 'stitch';
      scrub.max = n; scrub.value = p; scrub.disabled = !n;
      scrub.setAttribute('aria-valuetext', 'Stitch ' + p + ' of ' + n);
      window.EL.syncSlider(scrub);
      btn.disabled = !n;
      btn.setAttribute('aria-pressed', playing ? 'true' : 'false');
      btn.setAttribute('aria-label', playing ? 'Pause' : calm() ? 'Sew the next colour' : 'Play the stitch-out');
      count.textContent = window.EL.num(p) + ' / ' + window.EL.num(n);
    }
    function stop() {
      if (!playing) return;
      playing = false; if (raf) cancelAnimationFrame(raf); raf = 0; render();
    }
    function frame(t) {
      raf = 0; if (!playing) return;
      var n = total(), dt = Math.max(0, Math.min(100, t - lastT)); lastT = t;
      acc += dt / 1000 * Math.max(150, n / 15);
      var add = Math.floor(acc); acc -= add;
      if (add) V.setPlay(pos() + add);
      if (pos() >= n) { playing = false; render(); Editor.say('Stitch-out finished'); return; }
      raf = requestAnimationFrame(frame);
    }
    function play() {
      var n = total(), p = pos(); if (!n) return;
      if (p >= n) p = 0;
      if (calm()) {                                          /* no animation: to the end of the next thread colour */
        var st = V.stitch, i;
        for (i = 0; i < st.ends.length; i++) if (st.ends[i] > p) break;
        while (i + 1 < st.runs.length && st.runs[i + 1].thread === st.runs[i].thread) i++;
        V.setPlay(st.ends[Math.min(i, st.ends.length - 1)]);
        Editor.say('Stitch ' + pos() + ' of ' + n);
        return;
      }
      V.setPlay(p);
      playing = true; acc = 0; lastT = window.performance ? performance.now() : 0; render();
      raf = requestAnimationFrame(frame);
    }
    on(btn, 'click', function () { if (playing) stop(); else play(); });
    on(scrub, 'input', function () { stop(); V.setPlay(Number(scrub.value)); });
    Editor.on('play', render);
    Editor.on('viewmode', function () { if (V.mode !== 'stitch') { stop(); V.setPlay(total()); } render(); });
    Editor.playback = { play: play, stop: stop, playing: function () { return playing; } };
    render();
  }

  /* ---------- File: new, open a saved design, save the design file ------------------------------
     A design file (.embroidr) is the autosave payload as JSON. Model.load checks every field of it,
     so a hand-edited or hostile file can only give valid shapes or nothing. */
  var PROJECT_MAX_BYTES = 30 * 1024 * 1024;
  function looksLikeProject(file) {
    var n = String(file.name || '').toLowerCase();
    return /\.(embroidr|json)$/.test(n) || file.type === 'application/json';
  }
  function hasWork() { return M.doc.objects.length > 0; }
  function confirmReplace(title, action) {
    if (!hasWork()) return Promise.resolve(true);
    return window.EL.confirm('This replaces the design on the hoop. Save it first (File > Save) if you want to keep it.', { title: title, confirmLabel: action, cancelLabel: 'Keep my design', danger: true });
  }
  function freshView() {
    if (T.current !== 'select') T.set('select');
    if (V.mode !== 'design') V.setMode('design');
    V.fit();
  }
  /* New never throws work away: the design gets its own tab and the others stay open. */
  function newDesign() {
    T.cancel();
    if (Editor.Mockup && Editor.Mockup.isOpen()) Editor.Mockup.close();
    if (Editor.Tabs) {
      if (!hasWork() && M.doc.name === 'untitled') { toast('This design is already empty.', { label: 'File', timeout: 3000 }); return Promise.resolve(true); }
      return Promise.resolve(!!Editor.Tabs.add());
    }
    return confirmReplace('New design', 'Start new').then(function (yes) {
      if (!yes) return false;
      M.load(null); freshView(); IO.saveSoon();
      Editor.say('New design');
      return true;
    });
  }
  function openProject(file) {
    if (file.size > PROJECT_MAX_BYTES) { toast('That design file is too large to open.', { kind: 'bad', label: 'Open file' }); return Promise.resolve(null); }
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onerror = function () { toast('The file could not be read.', { kind: 'bad', label: 'Open file' }); resolve(null); };
      reader.onload = function () {
        var data = null;
        try { data = JSON.parse(String(reader.result)); } catch (e) { data = null; }
        var doc = data && typeof data === 'object' ? (data.doc && typeof data.doc === 'object' ? data.doc : data) : null;
        if (!doc || !Array.isArray(doc.objects)) { toast('This is not an Embroidr design file.', { kind: 'bad', label: 'Open file' }); resolve(null); return; }
        if (Editor.Mockup && Editor.Mockup.isOpen()) Editor.Mockup.close();
        /* a design that is being worked on stays where it is: the file opens in a tab of its own */
        var ask = Editor.Tabs ? Promise.resolve(true) : confirmReplace('Open design', 'Open');
        ask.then(function (yes) {
          if (!yes) { resolve(null); return; }
          if (Editor.Tabs && hasWork() && !Editor.Tabs.add(null, true)) { resolve(null); return; }
          var dropped = IO.applyPayload(data), n = M.doc.objects.length;
          freshView(); IO.saveNow();
          if (!n) toast('The file had no shapes that could be read.', { kind: 'bad', label: 'Open file' });
          else toast('Opened ' + M.doc.name + ': ' + n + (n === 1 ? ' shape' : ' shapes') + (dropped ? ' (' + dropped + ' could not be read and ' + (dropped === 1 ? 'was' : 'were') + ' left out)' : '') + '.', { kind: 'ok', label: 'File', timeout: 6000 });
          Editor.say('Design opened: ' + n + (n === 1 ? ' shape' : ' shapes'));
          resolve(n ? { added: n } : null);
        });
      };
      reader.readAsText(file);
    });
  }
  /* A machine file (.pes, .pec, .dst) opens as its stitches: one stroke per run of thread, sewn point for
     point. It gets a tab of its own, in the smallest hoop that holds it. */
  var STITCH_MAX_BYTES = 12 * 1024 * 1024;
  function looksLikeStitches(file) { return /\.(pes|pec|dst)$/i.test(String(file.name || '')); }
  function openStitches(file) {
    if (!Editor.StitchFile) return Promise.resolve(null);
    if (file.size > STITCH_MAX_BYTES) { toast('That file is too large to open.', { kind: 'bad', label: 'Open file' }); return Promise.resolve(null); }
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onerror = function () { toast('The file could not be read.', { kind: 'bad', label: 'Open file' }); resolve(null); };
      reader.onload = function () {
        var parsed = Editor.StitchFile.read(new Uint8Array(reader.result), file.name);
        if (!parsed.ok) { toast(parsed.error, { kind: 'bad', label: 'Open file', timeout: 8000 }); resolve(null); return; }
        var made = Editor.StitchFile.toObjects(parsed, M.HOOPS, Editor.Prefs.hoop());
        var name = String(file.name || 'stitches').replace(/\.[^.]+$/, '').slice(0, 60) || 'stitches';
        if (Editor.Mockup && Editor.Mockup.isOpen()) Editor.Mockup.close();
        if (Editor.Tabs && hasWork() && !Editor.Tabs.add(null, true)) { resolve(null); return; }
        var dropped = IO.applyPayload({ doc: { name: name, hoop: made.hoop, objects: made.objects } }) + made.dropped, n = M.doc.objects.length;
        freshView(); IO.saveNow();
        if (!n) { toast('No stitches could be read from the file.', { kind: 'bad', label: 'Open file' }); resolve(null); return; }
        var U = Editor.Units, msg = 'Opened ' + file.name + ': ' + parsed.stitches.toLocaleString('en-US') + ' stitches, ' + parsed.colors + (parsed.colors === 1 ? ' colour, ' : ' colours, ') + U.size(made.width, made.height) + ' ' + U.label() + '.';
        if (dropped) msg += ' ' + dropped + ' runs of thread were left out (too many pieces).';
        msg += ' ' + parsed.notes.join(' ') + ' The stitches can be moved, recoloured, erased and exported again; they are not shapes, so fills cannot be changed.';
        toast(msg, { kind: 'ok', label: 'File', timeout: 12000 });
        Editor.say('Machine file opened: ' + parsed.stitches + ' stitches');
        resolve({ added: n });
      };
      reader.readAsArrayBuffer(file);
    });
  }
  /* A link from the design feed: app.html?design=<id> fetches designs/<id>.embroidr and opens it in a tab of
     its own. The address is cleaned afterwards, so a reload does not open it a second time. */
  function openFromLink() {
    var m = /[?&]design=([a-z0-9-]{1,60})(?:&|$)/.exec(window.location.search || '');
    if (!m || !window.fetch) return !!m;
    var id = m[1];
    try { window.history.replaceState(null, '', window.location.pathname); } catch (e) { /* file:// */ }
    fetch('designs/' + id + '.embroidr', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('missing'); return r.json(); }).then(function (data) {
      var doc = data && typeof data === 'object' ? (data.doc && typeof data.doc === 'object' ? data.doc : data) : null;
      if (!doc || !Array.isArray(doc.objects)) throw new Error('not a design');
      if (Editor.Mockup && Editor.Mockup.isOpen()) Editor.Mockup.close();
      if (Editor.Tabs && hasWork() && !Editor.Tabs.add(null, true)) return;
      IO.applyPayload(data); freshView(); IO.saveNow();
      var n = M.doc.objects.length;
      toast('Opened ' + M.doc.name + ': ' + n + (n === 1 ? ' shape' : ' shapes') + '. It is yours to change; File > Save keeps your version.', { kind: 'ok', label: 'Design', timeout: 7000 });
      Editor.say('Design opened: ' + M.doc.name);
    }).catch(function () { toast('That design could not be opened.', { kind: 'bad', label: 'Design' }); });
    return true;
  }
  function saveProject() {
    if (!hasWork()) { toast('Nothing to save yet. Draw a shape first.', { kind: 'bad', label: 'Save' }); return false; }
    var f = IO.projectFile();
    window.EL.download(f.filename, f.text, f.mime);
    toast(f.filename + ' saved. Open it again with File > Open to keep editing.', { kind: 'ok', label: 'Saved', timeout: 6000 });
    Editor.say('Design file saved');
    Editor.emit('project-saved');
    return true;
  }
  var fileMenuOpen = false;
  function closeFileMenu(focusBack) {
    if (!fileMenuOpen) return;
    fileMenuOpen = false; $('file-menu').hidden = true; $('btn-file').setAttribute('aria-expanded', 'false');
    if (focusBack) $('btn-file').focus();
  }
  function initFileMenu() {
    var btn = $('btn-file'), menu = $('file-menu'); if (!btn || !menu) return;
    var actions = { 'new': newDesign, open: browse, save: saveProject, 'export': function () { doExport('pes'); }, mockup: function () { if (Editor.Mockup) Editor.Mockup.open(); } };
    on(btn, 'click', function () {
      if (fileMenuOpen) return closeFileMenu(false);
      fileMenuOpen = true; menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
      var first = menu.querySelector('button'); if (first) first.focus();
    });
    Array.prototype.slice.call(menu.querySelectorAll('[data-file]')).forEach(function (b) {
      on(b, 'click', function () { closeFileMenu(false); var fn = actions[b.getAttribute('data-file')]; if (fn) fn(); });
    });
    on(menu, 'keydown', function (e) {
      var items = Array.prototype.slice.call(menu.querySelectorAll('button')), i = items.indexOf(document.activeElement), k = e.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); items[(i + (k === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
      else if (k === 'Home') { e.preventDefault(); items[0].focus(); }
      else if (k === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFileMenu(true); }
      else if (k === 'Tab') closeFileMenu(false);
    });
    document.addEventListener('pointerdown', function (e) { if (fileMenuOpen && !$('file-group').contains(e.target)) closeFileMenu(false); }, true);
    Editor.file = { 'new': newDesign, open: browse, save: saveProject, openProject: openProject };
  }

  /* ---------- files: a design file replaces the hoop, an SVG becomes shapes, a picture goes under the drawing */
  function openFile(file) {
    if (!file) return Promise.resolve(null);
    T.cancel();
    var job;
    if (looksLikeProject(file)) job = openProject(file);
    else if (looksLikeStitches(file)) job = openStitches(file);
    else if (Editor.SvgImport && Editor.SvgImport.looksLikeSvg(file)) job = Editor.SvgImport.importFile(file);
    else if (Editor.Trace && Editor.Trace.accepts(file)) job = Editor.Trace.load(file);
    else if (/\.(exp|jef|vp3|xxx|hus|pcs|sew|vip|art)$/i.test(file.name || '')) { toast('That machine format cannot be opened yet. PES, PEC and DST can.', { kind: 'bad', label: 'Open file', timeout: 8000 }); return Promise.resolve(null); }
    else { toast('Use a saved design (.embroidr), a PES or DST file, an SVG file, or a PNG, JPG, WebP or GIF picture.', { kind: 'bad', label: 'Open file' }); return Promise.resolve(null); }
    return Promise.resolve(job).then(function (r) {
      if (r && (r === true || r.added) && Editor.closeSheet) Editor.closeSheet();   /* phone: show what arrived */
      return r;
    });
  }
  function browse() { var input = $('trace-input'); if (input) input.click(); }
  function initFiles() {
    var input = $('trace-input'), up = $('trace-upload'), view = V.el.view;
    on(up, 'click', browse);
    on(input, 'change', function () { var f = input.files && input.files[0]; input.value = ''; openFile(f); });
    function hasFiles(e) {
      var t = e.dataTransfer && e.dataTransfer.types, i;
      if (!t) return false;
      for (i = 0; i < t.length; i++) if (t[i] === 'Files') return true;
      return false;
    }
    function target(node) {
      var depth = 0;
      function over(yes) { node.classList.toggle('is-over', yes); }
      on(node, 'dragenter', function (e) { if (!hasFiles(e)) return; e.preventDefault(); depth++; over(true); });
      on(node, 'dragover', function (e) { if (!hasFiles(e)) return; e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch (x) { /* read-only */ } });
      on(node, 'dragleave', function (e) { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) over(false); });
      on(node, 'drop', function (e) {
        if (!hasFiles(e)) return;
        e.preventDefault(); e.stopPropagation(); depth = 0; over(false);
        openFile(e.dataTransfer.files && e.dataTransfer.files[0]);
      });
    }
    target(view); target(up);
    /* a file dropped beside the hoop must not make the browser leave the page */
    window.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', function (e) { if (hasFiles(e)) e.preventDefault(); });
    Editor.openFile = openFile;
  }

  /* ---------- example design + the empty hoop --------------------------------------------------- */
  /* Two thread colours: a disc with a star-shaped hole (one compound shape), and a star sewn into the hole. */
  function loadExample() {
    T.cancel();
    var hoop = M.doc.hoop, cx = hoop.w / 2, cy = hoop.h / 2, R = Math.min(hoop.w, hoop.h) * 0.3, i, a;
    function star(ro, ri) {
      var pts = [];
      for (i = 0; i < 10; i++) { a = -Math.PI / 2 + i * Math.PI / 5; pts.push([cx + Math.cos(a) * (i % 2 ? ri : ro), cy + Math.sin(a) * (i % 2 ? ri : ro)]); }
      return pts;
    }
    var disc = [], n = 72;
    for (i = 0; i < n; i++) { a = i / n * Math.PI * 2; disc.push([cx + Math.cos(a) * R, cy + Math.sin(a) * R]); }
    var made = M.addMany([
      { geom: { type: 'path', rings: [disc, star(R * 0.66, R * 0.27)], fillRule: 'evenodd' }, style: { color: '#3157E0', paint: 'fill', name: 'Badge' } },
      { geom: { type: 'polygon', pts: star(R * 0.7, R * 0.3) }, style: { color: '#A87400', paint: 'fill', name: 'Star' } }
    ], 'Load example');
    if (!made.length) { toast('The example could not be added: the design is full.', { kind: 'bad', label: 'Example' }); return; }
    if (T.current !== 'select') T.set('select');
    if (V.mode !== 'design') V.setMode('design');
    if (Editor.closeSheet) Editor.closeSheet();
    Editor.say('Example design added: 2 shapes, 2 thread colours');
    toast('Example added: a badge and a star, two thread colours.', { kind: 'ok', label: 'Example', timeout: 6000, action: { label: 'Undo', onClick: function () { if (M.undoLabel() === 'Load example') M.undo(); } } });
  }
  function initEmpty() {
    var box = $('empty'), pressing = false; if (!box) return;
    function render() { box.hidden = !!(M.doc.objects.length || V.trace || V.mode !== 'design' || pressing || T.busy()); }
    on(V.el.canvas, 'pointerdown', function () { pressing = true; render(); });
    function up() { if (!pressing) return; pressing = false; setTimeout(render, 0); }
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    document.addEventListener('keyup', render);
    Editor.on('change', render); Editor.on('trace', render); Editor.on('viewmode', render); Editor.on('tool', render);
    on($('btn-example'), 'click', loadExample);
    on($('btn-open'), 'click', browse);
    render();
  }

  /* ---------- export ------------------------------------------------------------------------ */
  var MENU_FORMATS = ['pes', 'dst', 'pes6'];
  var FORMAT_NOTES = {
    pes: 'Brother and Babylock home machines. The safe choice.',
    dst: 'Tajima and most commercial machines. Stores stops, not colours.',
    pes6: 'Newer PES that keeps your exact thread colours.',
    pec: 'The stitch block of a PES on its own.'
  };
  var menuOpen = false;
  var onlySelection = false;              /* "Selection only" in the export menu; off again each time the menu closes */
  function closeMenu(focusBack) {
    if (!menuOpen) return;
    menuOpen = false;
    setOnlySelection(false);
    $('export-menu').hidden = true;
    $('btn-export-menu').setAttribute('aria-expanded', 'false');
    if (focusBack) $('btn-export-menu').focus();
  }
  function setOnlySelection(on) {
    var b = $('export-only-sel'); onlySelection = !!on;
    if (!b) return;
    var can = M.selection.length > 0;
    if (!can) onlySelection = false;
    b.setAttribute('aria-checked', onlySelection ? 'true' : 'false');
    b.setAttribute('aria-disabled', can ? 'false' : 'true');
    b.querySelector('.num').textContent = onlySelection ? 'On' : 'Off';
    var g = M.selectedGroup(), n = M.selection.length;
    b.querySelector('small').textContent = !can ? 'Select shapes or a group first.'
      : 'Just ' + (g ? g.name : n === 1 ? 'the selected shape' : 'the ' + n + ' selected shapes') + ', centred like the full design.';
  }
  function openMenu() {
    var menu = $('export-menu');
    setOnlySelection(false);
    menuOpen = true; menu.hidden = false;
    $('btn-export-menu').setAttribute('aria-expanded', 'true');
    var first = menu.querySelector('button'); if (first) first.focus();
  }
  function doExport(format, selection) {
    closeMenu(false);
    return IO.exportFile(format, selection ? { selection: true } : null).then(function (ok) {
      if (ok && IO.lastExport) Editor.say('Exported ' + (selection ? 'the selection as ' : '') + IO.lastExport.filename + ', ' + IO.lastExport.stitches + ' stitches');
      return ok;
    });
  }
  Editor.exportSelection = function (format) { return doExport(format || 'pes', true); };
  function initExport() {
    var btn = $('btn-export'), more = $('btn-export-menu'), menu = $('export-menu');
    function render() {
      var why = IO.blocker(), off = !!why;
      btn.setAttribute('aria-disabled', off ? 'true' : 'false');
      more.setAttribute('aria-disabled', off ? 'true' : 'false');
      if (off) { btn.title = why; more.title = why; } else { btn.removeAttribute('title'); more.removeAttribute('title'); }
    }
    /* first: export only the selected shapes / group (the formats below then make just that part) */
    var only = document.createElement('button');
    only.type = 'button'; only.id = 'export-only-sel'; only.setAttribute('role', 'menuitemcheckbox'); only.tabIndex = -1;
    only.setAttribute('aria-checked', 'false');
    var onlyName = document.createElement('span'); onlyName.textContent = 'Selection only';
    var onlyState = document.createElement('span'); onlyState.className = 'num'; onlyState.textContent = 'Off';
    only.appendChild(onlyName); only.appendChild(onlyState); only.appendChild(document.createElement('small'));
    only.addEventListener('click', function () {
      if (!M.selection.length) { toast('Select the shapes or the group to export first.', { label: 'Export' }); return; }
      setOnlySelection(!onlySelection);
      Editor.say(onlySelection ? 'Only the selection is exported' : 'The whole design is exported');
    });
    menu.appendChild(only);
    /* format menu, from the engine's own list */
    var all = IO.formats(), byId = {};
    all.forEach(function (f) { byId[f.id] = f; });
    MENU_FORMATS.forEach(function (id) {
      var f = byId[id]; if (!f) return;
      var b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'menuitem'); b.setAttribute('data-format', f.id); b.tabIndex = -1;
      var name = document.createElement('span'); name.textContent = f.label;
      var ext = document.createElement('span'); ext.className = 'num'; ext.textContent = '.' + String(f.ext || f.id).replace(/^\./, '');
      var note = document.createElement('small'); note.textContent = FORMAT_NOTES[f.id] || '';
      b.appendChild(name); b.appendChild(ext); b.appendChild(note);
      b.addEventListener('click', function () { doExport(f.id, onlySelection); });
      menu.appendChild(b);
    });
    /* last in the menu: see the stitches on a garment before (or instead of) sending them to a machine */
    if (Editor.Mockup) {
      var mk = document.createElement('button');
      mk.type = 'button'; mk.setAttribute('role', 'menuitem'); mk.setAttribute('data-format', 'mockup'); mk.tabIndex = -1;
      var mkName = document.createElement('span'); mkName.textContent = 'Preview on a garment';
      var mkExt = document.createElement('span'); mkExt.className = 'num'; mkExt.textContent = '.png';
      var mkNote = document.createElement('small'); mkNote.textContent = 'Realistic stitches on a hoodie or T-shirt, as a picture.';
      mk.appendChild(mkName); mk.appendChild(mkExt); mk.appendChild(mkNote);
      mk.addEventListener('click', function () { closeMenu(false); Editor.Mockup.open(); });
      menu.appendChild(mk);
    }
    on(btn, 'click', function () { doExport('pes'); });
    on(more, 'click', function () {
      if (menuOpen) return closeMenu(false);
      if (IO.blocker()) { toast(IO.blocker(), { kind: 'bad', label: 'Export' }); return; }
      if (!menu.children.length) { doExport('pes'); return; }
      openMenu();
    });
    on(menu, 'keydown', function (e) {
      var items = Array.prototype.slice.call(menu.querySelectorAll('button')), i = items.indexOf(document.activeElement), k = e.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); items[(i + (k === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
      else if (k === 'Home') { e.preventDefault(); items[0].focus(); }
      else if (k === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
      else if (k === 'Tab') closeMenu(false);
    });
    document.addEventListener('pointerdown', function (e) { if (menuOpen && !$('export-group').contains(e.target)) closeMenu(false); }, true);
    Editor.on('stitch', render); Editor.on('change', render); Editor.on('busy', render);
    Editor.on('selection', function () { if (menuOpen) setOnlySelection(onlySelection); });
    render();
  }

  /* ---------- right-click menu: group, ungroup, export the selection ---------------------------
     A right click on a shape (or a sewing-order row) that is not picked yet picks it first, as in Figma. */
  var ctx = null;
  function closeContext(focusBack) {
    if (!ctx) return;
    var m = ctx; ctx = null;
    if (m.el.parentNode) m.el.parentNode.removeChild(m.el);
    if (focusBack && m.back && m.back.focus) { try { m.back.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
  }
  function contextItems() {
    var mode = P.groupMode ? P.groupMode() : null, n = M.selection.length, mod = isMac ? '\u2318' : 'Ctrl+', smod = isMac ? '\u21e7\u2318' : 'Ctrl+Shift+';
    var list = [];
    if (mode === 'ungroup') list.push({ label: 'Ungroup', key: smod + 'G', run: function () { P.ungroupSelection(); } });
    else list.push({ label: n > 1 ? 'Group ' + n + ' shapes' : 'Group', key: mod + 'G', run: function () { P.groupSelection(); } });
    list.push({ label: 'Export selection', key: '.pes', run: function () { doExport('pes', true); } });
    list.push({ label: 'Export selection', key: '.dst', run: function () { doExport('dst', true); } });
    list.push({ label: 'Delete', key: '', run: function () { var k = M.selection.length; if (M.remove(M.selection.slice())) Editor.say(k === 1 ? 'Shape deleted' : k + ' shapes deleted'); } });
    return list;
  }
  function openContext(x, y, back) {
    closeContext(false); closeMenu(false); closeFileMenu(false);
    if (!M.selection.length) return;
    var menu = document.createElement('div');
    menu.className = 'menu'; menu.id = 'context-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Selection');
    contextItems().forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'menuitem'); b.tabIndex = -1;
      var a = document.createElement('span'); a.textContent = it.label;
      var k = document.createElement('span'); k.className = 'num'; k.textContent = it.key;
      b.appendChild(a); b.appendChild(k);
      b.addEventListener('click', function () { closeContext(false); it.run(); });
      menu.appendChild(b);
    });
    menu.style.position = 'fixed'; menu.style.right = 'auto'; menu.style.minWidth = '200px';
    menu.style.left = '0px'; menu.style.top = '0px'; menu.style.visibility = 'hidden';
    document.body.appendChild(menu);
    var w = menu.offsetWidth, h = menu.offsetHeight, vw = document.documentElement.clientWidth, vh = window.innerHeight;
    menu.style.left = Math.max(8, Math.min(x, vw - w - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, vh - h - 8)) + 'px';
    menu.style.visibility = '';
    menu.addEventListener('keydown', function (e) {
      var items = Array.prototype.slice.call(menu.querySelectorAll('button')), i = items.indexOf(document.activeElement), k = e.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); items[(i + (k === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
      else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); closeContext(true); }
      else if (k === 'Tab') { e.preventDefault(); closeContext(true); }
    });
    ctx = { el: menu, back: back };
    var first = menu.querySelector('button'); if (first) first.focus({ preventScroll: true });
  }
  function initContext() {
    on(V.el.canvas, 'contextmenu', function (e) {
      if (T.current !== 'select' || T.busy() || V.mode !== 'design') return;
      e.preventDefault();
      var p = V.toMm(e.clientX, e.clientY), o = V.hit(p.x, p.y);
      if (o && !M.isSelected(o.id)) M.select(T.pickUnit ? T.pickUnit(o) : [o.id]);
      openContext(e.clientX, e.clientY, V.el.canvas);
    });
    on($('layers-list'), 'contextmenu', function (e) {
      var row = e.target.closest ? e.target.closest('.layer') : null; if (!row) return;
      e.preventDefault();
      var ids = row._gid ? M.members(row._gid) : row._id ? [row._id] : [];
      if (ids.length && !ids.every(function (id) { return M.isSelected(id); })) M.select(ids);
      openContext(e.clientX, e.clientY, row);
    });
    document.addEventListener('pointerdown', function (e) { if (ctx && !ctx.el.contains(e.target)) closeContext(false); }, true);
    window.addEventListener('resize', function () { closeContext(false); });
    window.addEventListener('blur', function () { closeContext(false); });
  }

  /* ---------- clear -------------------------------------------------------------------------- */
  function clearDesign() {
    T.cancel();
    var n = M.doc.objects.length;
    if (!n) { toast('The hoop is already empty.', { label: 'Clear' }); return; }
    window.EL.confirm('Remove ' + (n === 1 ? 'the shape' : 'all ' + n + ' shapes') + ' from the hoop? You can undo this.', { title: 'Clear design', confirmLabel: 'Clear', cancelLabel: 'Keep', danger: true })
      .then(function (yes) {
        if (!yes) return;
        if (M.clear()) {
          Editor.say('Design cleared');
          toast('Design cleared.', { label: 'Clear', timeout: 7000, action: { label: 'Undo', onClick: function () { if (M.undoLabel() === 'Clear design') M.undo(); } } });
        }
      });
  }

  /* ---------- zoom HUD ------------------------------------------------------------------------ */
  function initZoom() {
    on($('zoom-in'), 'click', function () { V.zoomStep(1); });
    on($('zoom-out'), 'click', function () { V.zoomStep(-1); });
    on($('zoom-fit'), 'click', function () { V.fit(); });
  }

  /* ---------- tablet drawer (1100px and below) ------------------------------------------------ */
  function initDrawer() {
    var btn = $('btn-drawer'), side = $('side');
    function set(open) { side.classList.toggle('is-open', open); btn.setAttribute('aria-expanded', open ? 'true' : 'false'); }
    on(btn, 'click', function () { set(!side.classList.contains('is-open')); });
    document.addEventListener('pointerdown', function (e) {
      if (side.classList.contains('is-open') && !side.contains(e.target) && !btn.contains(e.target)) set(false);
    }, true);
    Editor.closeDrawer = function () { if (side.classList.contains('is-open')) { set(false); return true; } return false; };
  }

  /* ---------- phone: bottom sheet, dock, "more" (720px and below) ----------------------------
     The sheet has three detents (data-detent = peek | half | full). The grip cycles them on a
     click, steps them with Arrow Up / Down, and can be dragged: while it is dragged the height
     is --sheet-h in px with .is-dragging (no transition); on release both are removed and the
     sheet snaps to the nearest detent. The hoop is re-fitted above an open sheet. */
  function initPhone() {
    var sheet = $('sheet'), grip = $('sheet-grip'), more = $('more'), moreBtn = $('btn-more');
    var ORDER = ['peek', 'half', 'full'];
    function current() { var d = sheet.getAttribute('data-detent'); return ORDER.indexOf(d) === -1 ? 'peek' : d; }
    function detent(d) {
      sheet.setAttribute('data-detent', d);
      grip.setAttribute('aria-expanded', d === 'peek' ? 'false' : 'true');
      if (V.auto) V.fit();                                    /* keep the whole hoop in what is left of the stage */
    }
    function stepDetent(dir) {
      var i = Math.max(0, Math.min(ORDER.length - 1, ORDER.indexOf(current()) + dir));
      if (ORDER[i] !== current()) { detent(ORDER[i]); Editor.say('Settings panel ' + (ORDER[i] === 'peek' ? 'closed' : ORDER[i] === 'half' ? 'half open' : 'fully open')); }
    }
    function tab(name) {
      sheet.setAttribute('data-tab', name);
      var tabs = sheet.querySelectorAll('[data-sheet-tab]');
      for (var i = 0; i < tabs.length; i++) tabs[i].setAttribute('aria-selected', tabs[i].getAttribute('data-sheet-tab') === name ? 'true' : 'false');
    }
    function setMore(open) { more.hidden = !open; moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false'); }
    on($('sheet-open'), 'click', function () { detent(current() === 'peek' ? 'half' : 'peek'); });

    /* drag the grip */
    var drag = null, skipClick = 0;
    function heights() {
      var full = parseFloat(getComputedStyle(sheet).maxHeight);
      if (!isFinite(full) || full < 120) full = Math.max(120, window.innerHeight - 110);
      return { peek: 60, half: Math.min(full, Math.round(window.innerHeight * 0.46)), full: full };
    }
    on(grip, 'pointerdown', function (e) {
      if (!V.isPhone() || (e.pointerType === 'mouse' && e.button !== 0)) return;
      drag = { id: e.pointerId, y: e.clientY, h: sheet.getBoundingClientRect().height, cur: 0, moved: false, lastY: e.clientY, lastT: e.timeStamp, vy: 0 };
      drag.cur = drag.h;
      try { grip.setPointerCapture(e.pointerId); } catch (x) { /* synthetic pointer */ }
    });
    on(grip, 'pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dy = e.clientY - drag.y, hs = heights();
      if (!drag.moved) {
        if (Math.abs(dy) < 6) return;
        drag.moved = true; sheet.classList.add('is-dragging');
        if (current() === 'peek') { sheet.setAttribute('data-detent', 'half'); grip.setAttribute('aria-expanded', 'true'); }   /* show the panel while it is pulled up */
      }
      drag.cur = Math.max(hs.peek, Math.min(hs.full, drag.h - dy));
      var dt = e.timeStamp - drag.lastT;
      if (dt > 0) { drag.vy = 0.6 * drag.vy + 0.4 * (e.clientY - drag.lastY) / dt; drag.lastY = e.clientY; drag.lastT = e.timeStamp; }
      sheet.style.setProperty('--sheet-h', Math.round(drag.cur) + 'px');
    });
    function endDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      var d = drag; drag = null;
      try { grip.releasePointerCapture(d.id); } catch (x) { /* already released */ }
      if (!d.moved) return;                                   /* a plain press: the click cycles the detents */
      skipClick = Date.now();
      var hs = heights(), aim = d.cur - d.vy * 160, best = 'peek', bestD = Infinity;   /* a flick carries on a little */
      ORDER.forEach(function (name) { var gap = Math.abs(hs[name] - aim); if (gap < bestD) { bestD = gap; best = name; } });
      sheet.classList.remove('is-dragging');
      sheet.style.removeProperty('--sheet-h');
      detent(best);
    }
    on(grip, 'pointerup', endDrag); on(grip, 'pointercancel', endDrag);
    on(grip, 'click', function () {
      if (Date.now() - skipClick < 400) { skipClick = 0; return; }   /* the click that ends a drag */
      var d = current();
      detent(d === 'peek' ? 'half' : d === 'half' ? 'full' : 'peek');
    });
    on(grip, 'keydown', function (e) {
      if (e.key === 'ArrowUp') { e.preventDefault(); stepDetent(1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); stepDetent(-1); }
      else if (e.key === 'Escape' && current() !== 'peek') { e.preventDefault(); e.stopPropagation(); detent('peek'); }
    });

    var tabs = sheet.querySelectorAll('[data-sheet-tab]');
    for (var i = 0; i < tabs.length; i++) on(tabs[i], 'click', function () { tab(this.getAttribute('data-sheet-tab')); });
    on(moreBtn, 'click', function () { setMore(more.hidden); });
    on(more, 'click', function (e) { if (e.target.closest('button')) setMore(false); });
    document.addEventListener('pointerdown', function (e) {
      if (!more.hidden && !more.contains(e.target) && !moreBtn.contains(e.target)) setMore(false);
    }, true);
    on(more.querySelector('[data-action="clear"]'), 'click', clearDesign);
    on(more.querySelector('[data-action="import"]'), 'click', browse);
    on(more.querySelector('[data-action="new"]'), 'click', newDesign);
    on(more.querySelector('[data-action="save"]'), 'click', saveProject);
    on(more.querySelector('[data-action="mockup"]'), 'click', function () { if (Editor.Mockup) Editor.Mockup.open(); });
    on(more.querySelector('[data-action="example"]'), 'click', loadExample);
    /* the dock shows where the active tool is: on "More" when it lives in that menu */
    function renderMore() { moreBtn.setAttribute('aria-pressed', more.querySelector('[data-tool="' + T.current + '"]') ? 'true' : 'false'); }
    /* picking a tool on a phone gets the sheet out of the way of the hoop */
    Editor.on('tool', function () {
      renderMore();
      if (current() !== 'peek' && V.isPhone()) detent('peek');
    });
    renderMore();
    Editor.closeSheet = function () { if (V.isPhone() && current() !== 'peek') { detent('peek'); return true; } return false; };
    Editor.sheet = { set: detent, get: current, tab: tab };
  }

  /* ---------- tool rail: arrow keys move between tools ---------------------------------------- */
  function initRail() {
    var rail = document.querySelector('.rail'); if (!rail) return;
    on(rail, 'keydown', function (e) {
      var k = e.key; if (k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'Home' && k !== 'End') return;
      var items = Array.prototype.slice.call(rail.querySelectorAll('button')), i = items.indexOf(document.activeElement);
      if (i === -1) return;
      e.preventDefault();
      var j = k === 'Home' ? 0 : k === 'End' ? items.length - 1 : (i + (k === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      items[j].focus();
    });
    on($('btn-clear'), 'click', clearDesign);
  }

  /* ---------- keyboard -------------------------------------------------------------------------- */
  var TOOL_KEYS = { v: 'select', p: 'pen', l: 'line', r: 'rect', o: 'ellipse', g: 'polygon', e: 'eraser', k: 'cut', h: 'pan' };
  function isTyping(t) {
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable) return true;
    var tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !/^(range|color|checkbox|radio|button|file)$/i.test(t.type || 'text');
    return false;
  }
  /* A control that has its own use for arrows, Space or Enter. */
  function isControl(t) {
    return !!(t && t.closest && t.closest('button, a[href], input, select, textarea, summary, [role="option"], [role="menu"], [role="tab"], dialog'));
  }
  function onKeyDown(e) {
    if (e.defaultPrevented || e.isComposing) return;
    var t = e.target, key = e.key, k = key.length === 1 ? key.toLowerCase() : key;
    var mod = e.metaKey || e.ctrlKey;
    if (document.querySelector('dialog[open]')) return;
    if (isTyping(t)) return;
    var control = isControl(t);
    /* in the mockup the hoop is out of sight: only the file shortcuts mean anything there */
    if (Editor.Mockup && Editor.Mockup.isOpen()) {
      if (mod && !e.altKey && !e.shiftKey && k === 'o') { e.preventDefault(); browse(); }
      else if (mod && !e.altKey && !e.shiftKey && k === 's') { e.preventDefault(); saveProject(); }
      else if (key === 'Escape' && !document.querySelector('.menu:not([hidden])')) { e.preventDefault(); Editor.Mockup.close(); }
      return;
    }

    if (key === 'Escape') {
      if (ctx) { closeContext(true); e.preventDefault(); return; }
      if (menuOpen) { closeMenu(true); e.preventDefault(); return; }
      /* an open drawer lies on top of the stage, so it goes first (unless a shape is being drawn) */
      if (!T.busy() && Editor.closeDrawer && Editor.closeDrawer()) { e.preventDefault(); return; }
      if (T.key(e)) { e.preventDefault(); return; }
      if (Editor.closeSheet && Editor.closeSheet()) { e.preventDefault(); return; }
      return;
    }

    if (mod && !e.altKey) {
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (k === 'y' && !e.shiftKey) { e.preventDefault(); redo(); return; }
      if (k === 'e' && !e.shiftKey) { e.preventDefault(); doExport('pes'); return; }
      if (k === 'e' && e.shiftKey) {
        e.preventDefault();
        if (M.selection.length) doExport('pes', true); else toast('Select the shapes or the group to export first.', { label: 'Export' });
        return;
      }
      if (k === 'g') {
        e.preventDefault();                                   /* not the browser's "find next" */
        if (T.busy()) return;
        if (e.shiftKey) { if (!P.ungroupSelection()) Editor.say('Nothing to ungroup'); }
        else if (!P.groupSelection()) Editor.say(M.selection.length ? 'Already a group' : 'Select shapes to group');
        return;
      }
      if (k === 'o' && !e.shiftKey) { e.preventDefault(); browse(); return; }
      if (k === 's' && !e.shiftKey) { e.preventDefault(); saveProject(); return; }
      if (k === 'd' && !e.shiftKey) {
        e.preventDefault();
        var d = M.duplicate(); if (d) Editor.say(d === 1 ? 'Shape duplicated' : d + ' shapes duplicated');
        return;
      }
      if (k === 'a' && !e.shiftKey) {
        if (!M.doc.objects.length) return;
        e.preventDefault(); if (T.current !== 'select') T.set('select');
        M.select(M.doc.objects.map(function (o) { return o.id; }));
        return;
      }
      if (k === 'c' && !e.shiftKey) {
        var picked = window.getSelection ? String(window.getSelection()) : '';
        if (picked) return;                                   /* copying text off the page */
        var c = M.copy(); if (c) { e.preventDefault(); Editor.say(c === 1 ? 'Shape copied' : c + ' shapes copied'); }
        return;
      }
      if (k === 'x' && !e.shiftKey) {
        var x = M.copy(); if (x) { e.preventDefault(); M.remove(M.selection.slice(), 'Cut'); Editor.say(x === 1 ? 'Shape cut' : x + ' shapes cut'); }
        return;
      }
      if (k === 'v' && !e.shiftKey) {
        if (!M.clipboard) return;
        e.preventDefault();
        var v = M.paste(); if (v) Editor.say(v === 1 ? 'Shape pasted' : v + ' shapes pasted');
        return;
      }
      if (k === '=' || k === '+') { e.preventDefault(); V.zoomStep(1); return; }
      if (k === '-' || k === '_') { e.preventDefault(); V.zoomStep(-1); return; }
      if (k === '0') { e.preventDefault(); V.fit(); return; }
      return;
    }
    if (e.altKey) return;

    if (key === ' ' || e.code === 'Space') {
      if (control) return;                                    /* Space presses the focused button */
      e.preventDefault(); T.space(true); return;
    }
    if (key === 'Enter') { if (!control && T.key(e)) e.preventDefault(); return; }
    if (key === 'Delete' || key === 'Backspace') {
      if (T.key(e)) { e.preventDefault(); return; }
      if (M.selection.length) {
        e.preventDefault();
        var n = M.selection.length;
        M.remove(M.selection.slice());
        Editor.say(n === 1 ? 'Shape deleted' : n + ' shapes deleted');
      }
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
      if (control || !M.selection.length || T.busy()) return;
      e.preventDefault();
      var step = e.shiftKey ? 5 : 1;
      M.nudge(key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0, key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0);
      return;
    }
    if (key === '?') { e.preventDefault(); window.EL.dialog.open('help'); return; }
    if (e.shiftKey && k !== '+' && k !== '_') return;
    if (TOOL_KEYS[k]) { e.preventDefault(); T.set(TOOL_KEYS[k]); Editor.say(T.NAMES[TOOL_KEYS[k]] + ' tool'); return; }
    if (k === '+' || k === '=') { e.preventDefault(); V.zoomStep(1); return; }
    if (k === '-' || k === '_') { e.preventDefault(); V.zoomStep(-1); return; }
    if (k === '0') { e.preventDefault(); V.fit(); return; }
    if (k === '[') { e.preventDefault(); P.reorderSelection(-1); return; }
    if (k === ']') { e.preventDefault(); P.reorderSelection(1); return; }
  }
  function onKeyUp(e) { if (e.key === ' ' || e.code === 'Space') T.space(false); }

  /* ---------- the group shortcuts in the help table (added here, so the page markup stays as it is) */
  function initHelpRows() {
    var cells = document.querySelectorAll('dialog td'), i, dup = null, exp = null;
    for (i = 0; i < cells.length; i++) {
      var t = cells[i].textContent.replace(/\s+/g, ' ').trim();
      if (t === '\u2318D \u2318A') dup = cells[i].parentNode;
      if (t === '\u2318E') exp = cells[i].parentNode;
    }
    function row(after, keys, text) {
      if (!after || !after.parentNode) return;
      var tr = document.createElement('tr'), a = document.createElement('td'), b = document.createElement('td');
      keys.forEach(function (k, j) { if (j) a.appendChild(document.createTextNode(' ')); var kb = document.createElement('kbd'); kb.textContent = k; a.appendChild(kb); });
      b.textContent = text;
      tr.appendChild(a); tr.appendChild(b);
      after.parentNode.insertBefore(tr, after.nextSibling);
    }
    row(dup, ['\u2318G', '\u21e7\u2318G'], 'Group, ungroup. Double-click a grouped shape to pick just it');
    row(exp, ['\u21e7\u2318E'], 'Export just the selection as .PES');
  }

  /* ---------- key names for this platform --------------------------------------------------------- */
  function initKeyNames() {
    if (isMac) return;
    function fix(s) { return s.replace(/⇧⌘/g, 'Ctrl+Shift+').replace(/⌘/g, 'Ctrl+').replace(/⇧/g, 'Shift+'); }
    var kbd = document.querySelectorAll('kbd'), i;
    for (i = 0; i < kbd.length; i++) if (/[⌘⇧]/.test(kbd[i].textContent)) kbd[i].textContent = fix(kbd[i].textContent);
    var tips = document.querySelectorAll('[data-key]');
    for (i = 0; i < tips.length; i++) { var v = tips[i].getAttribute('data-key'); if (/[⌘⇧]/.test(v)) tips[i].setAttribute('data-key', fix(v)); }
  }

  /* The window moved to a screen with another pixel density (no resize event): redo the canvas. */
  function initDpr() {
    if (!window.matchMedia) return;
    (function arm() {
      var mq = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
      function changed() {
        if (mq.removeEventListener) mq.removeEventListener('change', changed); else if (mq.removeListener) mq.removeListener(changed);
        V.resize(); arm();
      }
      if (mq.addEventListener) mq.addEventListener('change', changed); else if (mq.addListener) mq.addListener(changed);
    })();
  }

  /* ---------- boot --------------------------------------------------------------------------------- */
  function step(name, fn) {
    try { return fn(); } catch (err) {
      if (window.console && console.error) console.error('Embroidr: ' + name + ' failed to start', err);
      return null;
    }
  }
  function boot() {
    if (!window.EL) return;
    step('view', V.init);
    step('panels', P.init);
    step('tools', T.init);
    if (Editor.Trace) step('picture', Editor.Trace.init);    /* before the saved tag: a stored picture gives way to the design first */
    step('name', initName); step('saved', initSaved); step('history', initHistory); step('view mode', initViewMode); step('pixel density', initDpr);
    step('zoom', initZoom); step('drawer', initDrawer); step('phone', initPhone); step('rail', initRail); step('help rows', initHelpRows); step('key names', initKeyNames);
    step('playback', initPlayback); step('files', initFiles); step('file menu', initFileMenu);
    var info = step('storage and engine', IO.init) || {};
    /* nothing stored (a first visit): start on the hoop that is picked for new designs, not the engine's 4 x 4 */
    if (!info.restored && !info.damaged && !M.doc.objects.length) step('first hoop', function () { M.load(M.blank()); V.fit(); });
    if (Editor.Tabs) step('tabs', Editor.Tabs.init);
    if (Editor.Mockup) step('mockup', Editor.Mockup.init);
    var linked = step('design link', openFromLink);
    /* app.html?market=<id> is opened by js/editor/publish.js (loaded after this file): no tutorial over it either */
    if (/[?&]market=[A-Za-z0-9_-]{1,64}(?:&|$)/.test(window.location.search || '')) linked = true;
    step('export', initExport); step('right-click menu', initContext); step('empty hoop', initEmpty);
    /* first visit (and not arriving with a design link): the tutorial opens in a tab of its own */
    if (Editor.Tutorial) step('tutorial', function () { Editor.Tutorial.boot({ linked: !!linked }); });
    step('render', P.render);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.documentElement.setAttribute('data-editor', 'ready');
    if (info.damaged) toast('The design saved on this device could not be read, so the hoop starts empty.', { kind: 'bad', label: 'Restore', timeout: 8000 });
    else if (info.restored && info.dropped) toast(info.dropped + (info.dropped === 1 ? ' shape' : ' shapes') + ' from your saved design could not be read and ' + (info.dropped === 1 ? 'was' : 'were') + ' left out.', { kind: 'bad', label: 'Restore', timeout: 8000 });
    else if (info.restored && info.objects) Editor.say('Your design from last time is back: ' + info.objects + (info.objects === 1 ? ' shape' : ' shapes'));
  }
  boot();
})();
