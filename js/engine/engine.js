/*
 * engine.js - the public face of the Embroidery Labs engine. Contract: js/engine/API.md.
 *
 *   Engine.generate(design)            shapes in millimetres -> stitches, totals, warnings
 *   Engine.export(result, options)     stitches -> { bytes, filename, mime } (PES, DST, PEC)
 *   Engine.preview(result)             stitches -> polylines for drawing
 *   Engine.createClient()              the same two calls off the main thread (Web Worker),
 *                                      falling back to the main thread when a worker cannot start
 *
 * Loads three ways, no bundler:
 *   page:    <script src="js/engine/embwriter.js">, digitize.js, engine.js  -> window.Engine
 *   worker:  importScripts('embwriter.js', 'digitize.js', 'engine.js')      -> self.Engine
 *   node:    const Engine = require('./js/engine/engine.js')
 *
 * Everything runs in the browser. Nothing here talks to a server.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./embwriter.js'), require('./digitize.js'), root, {});
  } else {
    const E = root.Engine = root.Engine || {};
    if (!E.Writer || !E.Digitizer) throw new Error('engine.js: load embwriter.js and digitize.js first');
    factory(E.Writer, E.Digitizer, root, E);
  }
})(typeof self !== 'undefined' ? self : this, function (Writer, Digitizer, root, Engine) {
  'use strict';

  const VERSION = '1.0.0';
  const OP = Digitizer.OP;

  // Where worker.js lives: next to this file. Captured now because currentScript is only set while loading.
  let scriptUrl = '';
  try { if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) scriptUrl = document.currentScript.src; } catch (e) { /* not in a page */ }
  const defaultWorkerUrl = () => scriptUrl ? scriptUrl.replace(/engine\.js(\?[^#]*)?(#.*)?$/, 'worker.js$1') : 'js/engine/worker.js';

  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  function makeError(code, message) { const e = new Error(message); e.code = code; return e; }

  const FORMATS = ['pes', 'dst', 'pec', 'pes6'].map(id => {
    const f = Writer.FORMATS[id];
    return { id: f.id, ext: f.ext, mime: f.mime, label: f.label };
  });

  // ------------------------------------------------------------------ thread colours on the machine
  // Brother files (.pes, .pec) do not tell the machine a colour, they point into its fixed list of 64 thread
  // colours (Writer.PEC_THREADS). The writer gives every distinct design colour the nearest entry that is still
  // free, so that the machine's colour list has a different entry for each colour. Two things follow, and the
  // visitor is told about both here (which entry is chosen is the writer's business and is not changed):
  //   COLORS_MERGED      different design colours stored under ONE entry: in the block the machine reads once a
  //                      design has more than 64 colours; in the design section of a PES version 1 file whenever
  //                      two colours have the same nearest entry (close shades)
  //   COLOR_SUBSTITUTED  a colour listed under an entry that is not its nearest one, because that one was taken
  // The stitches and the stops are not affected: every colour change is written as a stop whatever the entries are.
  const PALETTE_FORMATS = ['pes', 'pec', 'pes6'];
  function paletteWarnings(threads) {
    const out = [];
    if (!Array.isArray(threads) || threads.length < 2) return out;
    const ints = [];
    for (const t of threads) { if (!t || !/^#[0-9a-f]{6}$/.test(t.color)) return out; ints.push(parseInt(t.color.slice(1), 16)); }
    const shown = Writer.buildUniquePalette(ints);                       // entry per thread in the PEC block
    const hex = v => '#' + ('00000' + v.toString(16)).slice(-6);
    const entry = i => ({ paletteIndex: i, paletteName: Writer.PEC_THREADS[i][3], paletteColor: hex(Writer.PEC_RGB[i]) });
    const colors = new Map();                                            // distinct design colours, first use first
    ints.forEach((c, i) => { if (!colors.has(c)) colors.set(c, { color: hex(c), shown: shown[i], nearest: Writer.nearestIndex(c, Writer.PEC_RGB) }); });
    const groupBy = key => { const m = new Map(); colors.forEach(c => { if (!m.has(c[key])) m.set(c[key], []); m.get(c[key]).push(c.color); }); return m; };
    const groups = [], merged = new Set();
    groupBy('shown').forEach((list, i) => { if (list.length > 1) { groups.push(Object.assign(entry(i), { colors: list, formats: PALETTE_FORMATS.slice() })); list.forEach(c => merged.add(c)); } });
    groupBy('nearest').forEach((list, i) => {
      if (list.length < 2 || groups.some(g => g.paletteIndex === i && g.colors.join() === list.join())) return;
      groups.push(Object.assign(entry(i), { colors: list, formats: ['pes'] }));
    });
    if (groups.length) {
      const g = groups[0];
      out.push({ code: 'COLORS_MERGED', severity: 'warning',
        message: 'Colours ' + g.colors.slice(0, 4).join(', ') + (g.colors.length > 4 ? ' and ' + (g.colors.length - 4) + ' more' : '') + ' are saved as the same Brother thread colour (' + g.paletteName + ')' +
          (groups.length > 1 ? ', and ' + (groups.length - 1) + ' more group' + (groups.length > 2 ? 's' : '') + ' like it' : '') + '. The machine still stops at every colour change: follow your own colour order.',
        groups });
    }
    const moved = [];
    colors.forEach(c => { if (c.shown !== c.nearest && !merged.has(c.color)) { const e = entry(c.shown), n = entry(c.nearest); moved.push({ color: c.color, paletteIndex: e.paletteIndex, paletteName: e.paletteName, paletteColor: e.paletteColor, nearestIndex: n.paletteIndex, nearestName: n.paletteName }); } });
    if (moved.length) {
      const m = moved[0];
      out.push({ code: 'COLOR_SUBSTITUTED', severity: 'info',
        message: 'The machine will list ' + m.color + ' as ' + m.paletteName + ', because ' + m.nearestName + ' is already taken by another colour' +
          (moved.length > 1 ? ' (and ' + (moved.length - 1) + ' more like it)' : '') + '. Only the name on the screen differs: the stitches and the stops are the same.',
        colors: moved, formats: PALETTE_FORMATS.slice() });
    }
    return out;
  }

  // ------------------------------------------------------------------ generate
  function generate(design, options) {
    const t0 = now();
    const result = Digitizer.digitize(design, options);
    if (result.canExport) { try { const extra = paletteWarnings(result.ir.threads); for (let i = 0; i < extra.length; i++) result.warnings.push(extra[i]); } catch (e) { /* never fail a design over a note about colour names */ } }
    result.version = VERSION;
    result.timeMs = Math.round((now() - t0) * 10) / 10;
    return result;
  }

  // ------------------------------------------------------------------ export
  // A safe file name stem: ASCII letters, digits, space, dash, underscore; never empty, never a dot file.
  function fileStem(name) {
    let s = Writer.sanitizeName(name, 0).replace(/[^A-Za-z0-9 _-]+/g, '_').replace(/_+/g, '_').replace(/^[ _-]+|[ _-]+$/g, '');
    if (s.length > 60) s = s.slice(0, 60).replace(/[ _-]+$/, '');
    return s || 'design';
  }
  function exportFile(result, options) {
    options = options || {};
    const id = String(options.format === undefined || options.format === null ? 'pes' : options.format).toLowerCase();
    const fmt = Writer.FORMATS[id];
    if (!fmt) throw makeError('UNKNOWN_FORMAT', 'Unknown export format "' + id.slice(0, 20) + '". Use one of: ' + FORMATS.map(f => f.id).join(', ') + '.');
    if (!result || !result.ir || !result.ir.commands) throw makeError('INVALID_RESULT', 'Nothing to export: pass the result of Engine.generate().');
    const blocking = (result.warnings || []).filter(w => w && w.severity === 'error');
    if (blocking.length || result.canExport === false) {
      const first = blocking[0];
      const e = makeError(first ? first.code : 'NOT_EXPORTABLE', first ? first.message : 'This design cannot be exported yet.');
      e.warnings = blocking;
      throw e;
    }
    const problems = Digitizer.validateIR(result.ir);
    if (problems.length) { const e = makeError('INVALID_IR', 'The stitch data is damaged and cannot be exported.'); e.detail = problems.slice(0, 5); throw e; }
    const rawName = typeof options.name === 'string' && options.name.trim() ? options.name : (typeof result.name === 'string' && result.name.trim() ? result.name : 'design');
    const pattern = Writer.fromIR(result.ir, { name: rawName });
    const bytes = Writer.encode(pattern, id);
    return { bytes, filename: fileStem(rawName) + '.' + fmt.ext, mime: fmt.mime, format: id, label: pattern.name, stitches: result.totals ? result.totals.stitches : undefined };
  }

  // ------------------------------------------------------------------ preview
  // One polyline per continuous run of thread (needle down to trim), in millimetres from the hoop's top-left
  // corner (the same coordinates the design uses). points = [x0, y0, x1, y1, ...].
  function preview(result) {
    const out = { runs: [], jumps: [] };
    if (!result || !result.ir || !result.ir.commands) return out;
    const ir = result.ir, c = ir.commands, ox = Math.round(ir.hoop.w / 2), oy = Math.round(ir.hoop.h / 2); // the IR origin in 0.1 mm
    let thread = 0, start = -1, lastX = null, lastY = null;
    const close = end => {
      if (start < 0) return;
      const n = (end - start) / 3, pts = new Float32Array(n * 2);
      for (let k = 0, i = start; i < end; i += 3, k += 2) { pts[k] = (c[i + 1] + ox) / 10; pts[k + 1] = (c[i + 2] + oy) / 10; }
      const t = ir.threads[thread] || { color: '#000000' };
      out.runs.push({ thread, color: t.color, points: pts });
      start = -1;
    };
    for (let i = 0; i + 2 < c.length; i += 3) {
      const op = c[i];
      if (op === OP.STITCH) { if (start < 0) start = i; lastX = c[i + 1]; lastY = c[i + 2]; }
      else {
        close(i);
        if (op === OP.JUMP) { if (lastX !== null) out.jumps.push({ x1: (lastX + ox) / 10, y1: (lastY + oy) / 10, x2: (c[i + 1] + ox) / 10, y2: (c[i + 2] + oy) / 10, thread }); }
        else if (op === OP.COLOR_CHANGE) thread++;
        else if (op === OP.END) break;
      }
    }
    return out;
  }

  function validate(resultOrIr) {
    const ir = resultOrIr && resultOrIr.ir ? resultOrIr.ir : resultOrIr;
    return Digitizer.validateIR(ir);
  }

  // ------------------------------------------------------------------ async client
  // What the worker needs for an export: the stitches and whatever blocks export. Plain data, structured-cloneable.
  function exportPayload(result) {
    if (!result || !result.ir) return result;
    return { ir: result.ir, name: result.name, canExport: result.canExport, warnings: (result.warnings || []).filter(w => w && w.severity === 'error'), totals: result.totals };
  }
  function errorFrom(o) { const e = makeError(o && o.code ? o.code : 'ENGINE_ERROR', o && o.message ? o.message : 'The stitch engine failed.'); if (o && o.warnings) e.warnings = o.warnings; return e; }

  /*
   * createClient(options) -> { generate, export, ready, mode, terminate }
   *   options.workerUrl        URL of worker.js (default: next to engine.js)
   *   options.forceMainThread  never start a worker
   *   options.readyTimeoutMs   how long to wait for the worker to start before falling back (default 4000)
   *   options.cancelAfterMs    a superseded generate() still running after this long is cancelled by restarting
   *                            the worker (default 800)
   *   options.onModeChange     called with 'worker' | 'main' when the mode is settled or changes
   */
  function createClient(options) {
    options = options || {};
    const readyTimeoutMs = options.readyTimeoutMs === undefined ? 4000 : options.readyTimeoutMs;
    const cancelAfterMs = options.cancelAfterMs === undefined ? 800 : options.cancelAfterMs;
    let mode = 'starting';          // 'starting' | 'worker' | 'main' | 'closed'
    let worker = null, workerReady = false, readyTimer = null, cancelTimer = null, mainTimer = null;
    let nextId = 1;
    let active = null;              // generate job posted to the worker: { id, design, resolve, onProgress, maxStitches, superseded }
    let queued = null;              // newest generate job not started yet
    const exportsPending = new Map(); // id -> { payload, options, resolve, reject, posted }
    let readyResolve;
    const ready = new Promise(res => { readyResolve = res; });
    const api = {};

    const settle = m => {
      if (mode === 'closed') return;
      const changed = mode !== m; mode = m;
      readyResolve(m);
      if (changed && typeof options.onModeChange === 'function') { try { options.onModeChange(m); } catch (e) { /* ignore */ } }
    };
    const swallow = ev => { if (ev && ev.preventDefault) ev.preventDefault(); };
    const clearTimers = () => { if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; } if (cancelTimer) { clearTimeout(cancelTimer); cancelTimer = null; } };
    const dropWorker = () => {
      if (!worker) return;
      // A worker being dropped can still report an error from a request it had already received: keep
      // swallowing those, or they surface as uncaught errors on the page.
      worker.onmessage = null; worker.onerror = swallow; worker.onmessageerror = null;
      try { worker.terminate(); } catch (e) { /* already gone */ }
      worker = null; workerReady = false;
    };

    // ---- main-thread mode
    const runMain = () => {
      mainTimer = null;
      if (mode !== 'main') return;
      exportsPending.forEach((job, id) => {
        exportsPending.delete(id);
        try { job.resolve(exportFile(job.payload, job.options)); } catch (e) { job.reject(e); }
      });
      const job = queued; queued = null;
      if (!job) return;
      let result;
      try { result = generate(job.design, { onProgress: job.onProgress, maxStitches: job.maxStitches }); }
      catch (e) { job.reject(e); return; }
      job.resolve(result);
    };
    const scheduleMain = () => { if (mainTimer === null) mainTimer = setTimeout(runMain, 0); };
    const toMain = () => {
      clearTimers(); dropWorker();
      if (active) { if (!queued) queued = active; else active.resolve(null); active = null; } // re-run what the worker did not finish
      settle('main');
      scheduleMain();
    };

    // ---- worker mode
    const postGenerate = () => {
      if (!workerReady || active || !queued) return;
      active = queued; queued = null;
      try { worker.postMessage({ type: 'generate', id: active.id, design: active.design, progress: typeof active.onProgress === 'function', maxStitches: active.maxStitches }); }
      catch (e) { // design is not structured-cloneable (functions, DOM nodes): do this one on the main thread
        const job = active; active = null;
        try { job.resolve(generate(job.design, { onProgress: job.onProgress, maxStitches: job.maxStitches })); } catch (err) { job.reject(err); }
        postGenerate();
      }
    };
    const postExports = () => {
      if (!workerReady) return;
      exportsPending.forEach((job, id) => {
        if (job.posted) return;
        job.posted = true;
        try { worker.postMessage({ type: 'export', id, result: job.payload, options: job.options }); }
        catch (e) { exportsPending.delete(id); try { job.resolve(exportFile(job.payload, job.options)); } catch (err) { job.reject(err); } }
      });
    };
    const onMessage = ev => {
      const m = ev.data; if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') {
        workerReady = true; if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
        settle('worker'); postExports(); postGenerate();
      } else if (m.type === 'progress') {
        if (active && m.id === active.id && typeof active.onProgress === 'function') { try { active.onProgress(m.done, m.total); } catch (e) { /* ignore */ } }
      } else if (m.type === 'result' || (m.type === 'error' && active && m.id === active.id)) {
        if (!active || m.id !== active.id) return; // a cancelled job
        const job = active; active = null;
        if (cancelTimer) { clearTimeout(cancelTimer); cancelTimer = null; }
        if (m.type === 'error') job.reject(errorFrom(m.error)); else job.resolve(m.result);
        postGenerate();
      } else if (m.type === 'exported' || m.type === 'error') {
        const job = exportsPending.get(m.id); if (!job) return;
        exportsPending.delete(m.id);
        if (m.type === 'error') job.reject(errorFrom(m.error)); else job.resolve(m.file);
      }
    };
    const startWorker = () => {
      let w;
      try { w = new root.Worker(options.workerUrl || defaultWorkerUrl()); }
      catch (e) { return false; }
      worker = w; workerReady = false;
      w.onmessage = onMessage;
      w.onerror = ev => { if (ev && ev.preventDefault) ev.preventDefault(); if (worker === w) toMain(); }; // could not load, or crashed: finish on the main thread
      w.onmessageerror = () => { if (worker === w) toMain(); };
      if (readyTimeoutMs > 0) readyTimer = setTimeout(() => { readyTimer = null; if (worker === w && !workerReady) toMain(); }, readyTimeoutMs);
      return true;
    };
    // The running job has been superseded and is taking long: restart the worker so the newest design starts now.
    const cancelActive = () => {
      cancelTimer = null;
      if (mode !== 'worker' || !active || !active.superseded) return;
      const job = active; active = null;
      dropWorker(); job.resolve(null);
      exportsPending.forEach(j => { j.posted = false; });
      if (!startWorker()) toMain();
    };

    api.generate = function (design, opts) {
      if (mode === 'closed') return Promise.reject(makeError('CLIENT_CLOSED', 'The engine client was closed.'));
      return new Promise((resolve, reject) => {
        const job = { id: nextId++, design, resolve, reject, onProgress: opts && opts.onProgress, maxStitches: opts && typeof opts.maxStitches === 'number' ? opts.maxStitches : undefined, superseded: false };
        if (queued) queued.resolve(null);       // never started: dropped
        queued = job;
        if (mode === 'main') { scheduleMain(); return; }
        if (active) { active.superseded = true; if (!cancelTimer && cancelAfterMs >= 0 && mode === 'worker') cancelTimer = setTimeout(cancelActive, cancelAfterMs); }
        postGenerate();
      });
    };
    api.export = function (result, opts) {
      if (mode === 'closed') return Promise.reject(makeError('CLIENT_CLOSED', 'The engine client was closed.'));
      return new Promise((resolve, reject) => {
        const id = nextId++;
        exportsPending.set(id, { payload: exportPayload(result), options: { format: opts && opts.format, name: opts && opts.name }, resolve, reject, posted: false });
        if (mode === 'main') scheduleMain(); else postExports();
      });
    };
    api.exportFile = api.export;
    api.ready = ready;
    Object.defineProperty(api, 'mode', { enumerable: true, get: () => mode });
    api.terminate = function () {
      if (mode === 'closed') return;
      clearTimers(); if (mainTimer !== null) { clearTimeout(mainTimer); mainTimer = null; }
      dropWorker();
      readyResolve('closed'); mode = 'closed';
      if (active) { active.resolve(null); active = null; }
      if (queued) { queued.resolve(null); queued = null; }
      exportsPending.forEach(job => job.reject(makeError('CLIENT_CLOSED', 'The engine client was closed.')));
      exportsPending.clear();
    };

    if (options.forceMainThread || typeof root.Worker !== 'function' || !startWorker()) settle('main');
    return api;
  }

  Engine.version = VERSION;
  Engine.OP = OP;
  Engine.DEFAULTS = Digitizer.DEFAULTS;
  Engine.LIMITS = Digitizer.LIMITS;
  Engine.FORMATS = FORMATS;
  Engine.generate = generate;
  Engine.export = exportFile;
  Engine.exportFile = exportFile; // same function, for code that prefers not to use a reserved word
  Engine.preview = preview;
  Engine.validate = validate;
  Engine.createClient = createClient;
  Engine.Writer = Writer;
  Engine.Digitizer = Digitizer;
  return Engine;
});
