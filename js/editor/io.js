/* ==========================================================================
   EMBROIDERY LABS - js/editor/io.js
   Everything that leaves the document model:
     - live stitch generation through the engine client (debounced, stale
       results ignored)
     - export of a machine file (.pes / .dst ...) made by the engine
     - autosave to localStorage and restore on load

   Only the engine's public API is used (js/engine/API.md).

   Event (Editor.on):
     'stitch'   a new engine result is in Editor.IO.result (or null)
     'saved'    the autosave state changed: Editor.IO.saveState
   ========================================================================== */
(function () {
  'use strict';
  var Editor = window.Editor, M = Editor.Model, V = Editor.View;
  var KEY = 'el-editor-doc-v1';          /* bump the number if the stored shape ever changes */
  var GEN_MS = 50, GEN_LIVE_MS = 140, SAVE_MS = 400, FRESH_TIMEOUT_MS = 30000;

  var IO = Editor.IO = {
    KEY: KEY,
    result: null,             /* newest engine result that was applied */
    busy: false,              /* a newer document is waiting for its stitches */
    saveState: 'saved',       /* 'saved' | 'pending' | 'failed' */
    lastExport: null,         /* { filename, format, stitches, bytes, width, height, colors } */
    engineMode: 'starting'
  };

  var client = null;
  var rev = 0;                /* goes up with every change of the document */
  var resultRev = -1;         /* the revision IO.result was made from */
  var sentRev = -1;           /* the newest revision handed to the engine */
  var genTimer = 0, saveTimer = 0, exporting = false, engineFailed = false;
  var waiters = [];           /* export waiting for stitches of the current revision */

  /* Editor.toast: EL.toast, except that the same message is not stacked up while it is still fresh
     (pressing Export three times on an empty hoop gives one message, not three). */
  Editor.toast = function (msg, opts) {
    if (!window.EL) return null;
    var now = Date.now(), last = Editor.toast.last;
    if (last && last.msg === msg && now - last.at < 3000) return null;
    Editor.toast.last = { msg: msg, at: now };
    return window.EL.toast(msg, opts);
  };
  var toast = Editor.toast;
  function num(n) { return window.EL ? window.EL.num(n) : String(n); }

  /* ---------- live stitches ---------------------------------------------------- */
  function setBusy(b) { if (IO.busy !== b) { IO.busy = b; Editor.emit('busy'); } }

  function settle() {
    if (resultRev !== rev) return;
    setBusy(false);
    var list = waiters; waiters = [];
    list.forEach(function (w) { clearTimeout(w.timer); w.resolve(IO.result); });
  }
  function rejectWaiters(err) {
    var list = waiters; waiters = [];
    list.forEach(function (w) { clearTimeout(w.timer); w.reject(err); });
  }

  function apply(result, r) {
    resultRev = r;
    IO.result = result;
    engineFailed = false;
    /* which objects the engine complained about: id -> 'error' | 'warning' */
    var flags = {};
    function mark(id, sev) { if (id != null && flags[id] !== 'error') flags[id] = sev; }
    (result.warnings || []).forEach(function (w) {
      var sev = w.severity === 'error' ? 'error' : w.severity === 'warning' ? 'warning' : null;
      if (!sev) return;
      if (w.objectId != null) mark(w.objectId, sev);
      else if (typeof w.objectIndex === 'number' && result.objects[w.objectIndex]) mark(result.objects[w.objectIndex].id, sev);
      (w.objectIndexes || []).forEach(function (i) { if (result.objects[i]) mark(result.objects[i].id, sev); });
    });
    V.flags = flags;
    var preview = null;
    try { if (result.totals && result.totals.stitches > 0) preview = window.Engine.preview(result); } catch (e) { preview = null; }
    V.setStitch(preview, result.bounds);
    Editor.emit('stitch', result);
    settle();
  }

  function failed(err, r) {
    if (r < sentRev) return;                 /* a newer request is on its way */
    IO.result = null; resultRev = -1; V.flags = {};
    V.setStitch(null, null);
    Editor.emit('stitch', null);
    setBusy(false);
    rejectWaiters(err || new Error('The stitch engine failed.'));
    if (!engineFailed) {
      engineFailed = true;
      toast('The stitch engine could not process this design. Undo the last change and try again.', { kind: 'bad', label: 'Stitches', timeout: 8000 });
    }
  }

  function run() {
    if (genTimer) { clearTimeout(genTimer); genTimer = 0; }
    if (!client) return;
    var r = rev, p;
    sentRev = r;
    try { p = client.generate(M.toEngine()); } catch (e) { p = Promise.reject(e); }
    p.then(function (result) {
      if (!result) return;                   /* superseded by a newer call */
      if (r < resultRev) return;             /* older than what is already shown */
      apply(result, r);
    }, function (err) { failed(err, r); });
  }
  function schedule(ms) {
    if (genTimer) clearTimeout(genTimer);
    genTimer = setTimeout(run, ms);
    setBusy(true);
  }

  /* Promise of the engine result for the document as it is right now. */
  IO.fresh = function () {
    if (resultRev === rev && IO.result) return Promise.resolve(IO.result);
    return new Promise(function (resolve, reject) {
      var w = { resolve: resolve, reject: reject, timer: 0 };
      w.timer = setTimeout(function () {
        var i = waiters.indexOf(w); if (i !== -1) waiters.splice(i, 1);
        reject(new Error('Stitch generation took too long. Try a smaller or simpler design.'));
      }, FRESH_TIMEOUT_MS);
      waiters.push(w);
      if (genTimer || sentRev !== rev) run();
    });
  };

  /* ---------- export ------------------------------------------------------------- */
  IO.formats = function () { return (window.Engine && window.Engine.FORMATS) || []; };
  IO.canExport = function () { return M.doc.objects.length > 0 && !!IO.result && IO.result.canExport === true && resultRev === rev; };
  /* Why the current design cannot be exported, as a sentence, or '' */
  IO.blocker = function () {
    if (!M.doc.objects.length) return 'Nothing to export yet. Draw a shape first.';
    var r = IO.result;
    if (r && resultRev === rev && !r.canExport) {
      var e = (r.warnings || []).filter(function (w) { return w.severity === 'error'; })[0];
      return e ? e.message : 'This design cannot be exported.';
    }
    return '';
  };

  IO.exportFile = function (format) {
    format = format || 'pes';
    if (exporting) return Promise.resolve(false);
    if (!M.doc.objects.length) {
      toast('Nothing to export yet. Draw a shape first.', { kind: 'bad', label: 'Export' });
      return Promise.resolve(false);
    }
    if (!client) { toast('The stitch engine did not load. Reload the page and try again.', { kind: 'bad', label: 'Export' }); return Promise.resolve(false); }
    exporting = true;
    return IO.fresh().then(function (result) {
      if (!result || !result.canExport) {
        var e = result && (result.warnings || []).filter(function (w) { return w.severity === 'error'; })[0];
        toast(e ? e.message : 'This design cannot be exported yet.', { kind: 'bad', label: 'Export', timeout: 7000 });
        return false;
      }
      return client.export(result, { format: format, name: M.doc.name }).then(function (file) {
        if (!file || !file.bytes || !file.bytes.length) throw new Error('The engine returned an empty file.');
        window.EL.download(file.filename, file.bytes, file.mime);
        var b = result.bounds || { width: 0, height: 0 }, colors = result.totals.colors;
        IO.lastExport = { filename: file.filename, format: file.format, stitches: file.stitches, bytes: file.bytes.length, width: b.width, height: b.height, colors: colors };
        var what = format === 'dst'
          ? colors + (colors === 1 ? ' thread stop' : ' thread stops') + ' (DST stores no colours)'
          : colors + (colors === 1 ? ' colour' : ' colours');
        window.EL.toast(file.filename + ': ' + num(file.stitches) + ' stitches, ' + Editor.Units.size(b.width, b.height) + ' ' + Editor.Units.label() + ', ' + what,
          { kind: 'ok', label: 'Exported', timeout: 7000 });
        Editor.emit('exported', IO.lastExport);
        return true;
      });
    }).then(null, function (err) {
      toast(err && err.message ? err.message : 'Export failed.', { kind: 'bad', label: 'Export', timeout: 7000 });
      return false;
    }).then(function (ok) { exporting = false; return ok; });
  };

  /* ---------- autosave ------------------------------------------------------------ */
  function setSave(state) { if (IO.saveState !== state) { IO.saveState = state; Editor.emit('saved'); } }
  function payload() {
    return { v: 1, app: 'embroidr', savedAt: Date.now(), doc: M.serialize(), view: { fabric: { mode: V.fabric.mode, color: V.fabric.color } } };
  }
  /* The design as a file the visitor keeps: the same shape as the autosave, so File > Open reads both. */
  IO.PROJECT_EXT = '.embroidr';
  IO.projectFile = function () {
    var name = String(M.doc.name || 'untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '').trim() || 'untitled';
    return { filename: name + IO.PROJECT_EXT, text: JSON.stringify(payload()), mime: 'application/json' };
  };
  IO.payload = payload;
  /* Put a stored payload (a tab, a design file) on the hoop. Returns how many shapes could not be read. */
  IO.applyPayload = function (data) {
    var doc = data && typeof data === 'object' ? (data.doc && typeof data.doc === 'object' ? data.doc : data) : null;
    var dropped = M.load(doc);
    var f = data && data.view && data.view.fabric;
    if (f && typeof f === 'object') { V.setFabric(f.mode, f.color); Editor.emit('fabric'); }
    return dropped;
  };
  IO.saveNow = function () {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    if (M.inTransaction()) { IO.saveSoon(); return false; }         /* never store a half-finished drag */
    var ok = !!(window.EL && window.EL.store.set(KEY, payload()));
    setSave(ok ? 'saved' : 'failed');
    return ok;
  };
  IO.saveSoon = function () {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(IO.saveNow, SAVE_MS);
    if (IO.saveState !== 'failed') setSave('pending');
  };
  /* Put back what was stored. Never throws: a damaged entry gives an empty document. */
  IO.restore = function () {
    var data = null, dropped = 0;
    try { data = window.EL.store.get(KEY, null); } catch (e) { data = null; }
    if (!data || typeof data !== 'object' || data.v !== 1 || !data.doc || typeof data.doc !== 'object') return { restored: false, dropped: 0 };
    try {
      dropped = M.load(data.doc);
      var f = data.view && data.view.fabric;
      if (f && typeof f === 'object') { V.setFabric(f.mode, f.color); Editor.emit('fabric'); }
    } catch (e) {
      try { M.load(null); } catch (e2) { /* nothing more to do */ }
      return { restored: false, dropped: 0, damaged: true };
    }
    return { restored: true, dropped: dropped, objects: M.doc.objects.length };
  };

  /* ---------- start ----------------------------------------------------------------- */
  IO.init = function () {
    if (window.Engine && typeof window.Engine.createClient === 'function') {
      try {
        client = window.Engine.createClient({ onModeChange: function (m) { IO.engineMode = m; } });
      } catch (e) { client = null; }
    }
    if (!client) toast('The stitch engine did not load. Drawing works, but stitches and export do not. Reload the page.', { kind: 'bad', label: 'Engine', timeout: 0 });

    Editor.on('change', function (e) {
      var reason = e && e.reason;
      if (reason !== 'name') {
        rev++;
        if (client) schedule(reason === 'live' ? GEN_LIVE_MS : GEN_MS);
      }
      if (reason !== 'live' && reason !== 'load') IO.saveSoon();
    });
    Editor.on('defaults', function () { if (IO.ready) IO.saveSoon(); });
    Editor.on('fabric', function () { if (IO.ready) IO.saveSoon(); });

    var info = IO.restore();
    IO.ready = true;
    rev++;
    if (client) run();                         /* stitches for whatever was restored */

    function flush() { if (saveTimer) IO.saveNow(); }
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
    return info;
  };
})();
