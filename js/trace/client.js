/*
 * client.js - the page-side half of the picture tracer. Load it after trace.js:
 *
 *   <script src="js/trace/trace.js"></script>
 *   <script src="js/trace/client.js"></script>
 *
 * It adds two things to the global `Trace`:
 *
 *   Trace.imageDataFrom(source, { maxSide })  -> Promise<{ width, height, data }>
 *       Turns a File/Blob, <img>, <canvas>, ImageBitmap or ImageData into pixels, scaled down with a canvas so
 *       that the longer side is at most maxSide (default 1600). Always go through this (or do the same yourself)
 *       before tracing: a 12-megapixel phone photo holds far more detail than thread can show.
 *
 *   Trace.createClient(options) -> { trace, cancel, ready, mode, terminate }
 *       Traces in a Web Worker (worker.js, found next to this file) so the page stays responsive, and falls back
 *       to the main thread in slices when a worker cannot be started (for example a page opened from file://).
 *
 * See API.md for the details. Nothing here talks to a server.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./trace.js'));
  else factory(root, root.Trace);
})(typeof self !== 'undefined' ? self : this, function (root, Trace) {
  'use strict';
  if (!Trace) throw new Error('client.js needs trace.js to be loaded first.');

  // Where worker.js lives: next to this file. Captured now because currentScript is only set while loading.
  let scriptUrl = '';
  try { if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) scriptUrl = document.currentScript.src; } catch (e) { /* not in a page */ }

  function makeError(code, message) { const e = new Error(message); e.code = code; return e; }
  const cancelledError = () => makeError('CANCELLED', 'Tracing was cancelled.');

  /*
   * createClient(options)
   *   options.workerUrl        where worker.js is (default: next to client.js)
   *   options.forceMainThread  never start a worker
   *   options.readyTimeoutMs   how long to wait for the worker to start before falling back (default 4000)
   *   options.onModeChange     called with 'worker' | 'main' when the mode is settled or changes
   *
   * client.trace(image, traceOptions, { onProgress(fraction), signal }) -> Promise<result>
   *   One job at a time: starting a new trace cancels the one still running (its promise rejects with
   *   code 'CANCELLED'), which is what a settings slider wants. The image is copied to the worker, so the
   *   caller keeps its pixels and can trace them again with other settings.
   * client.cancel()     cancels the running job, if any
   * client.ready        Promise<'worker' | 'main'>
   * client.mode         'starting' | 'worker' | 'main'
   * client.terminate()  ends the worker; the client cannot be used afterwards
   */
  function createClient(options) {
    options = options || {};
    const readyTimeoutMs = options.readyTimeoutMs === undefined ? 4000 : options.readyTimeoutMs;
    let workerUrl = options.workerUrl || '';
    if (!workerUrl && scriptUrl) workerUrl = scriptUrl.replace(/[^\/]*([?#].*)?$/, 'worker.js');

    let mode = 'starting', worker = null, workerReady = false, readyTimer = null, dead = false;
    let seq = 0, active = null;          // active = { id, image, options, hooks, resolve, reject, sent, cancelled }
    let readyResolve;
    const ready = new Promise(res => { readyResolve = res; });

    function settle(m) {
      const changed = mode !== m;
      mode = m;
      readyResolve(m);
      if (changed && typeof options.onModeChange === 'function') { try { options.onModeChange(m); } catch (e) { /* ignore */ } }
    }
    function stopWorker() {
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
      if (worker) { worker.onmessage = worker.onerror = worker.onmessageerror = null; try { worker.terminate(); } catch (e) { /* ignore */ } }
      worker = null; workerReady = false;
    }
    function toMain() {
      stopWorker();
      settle('main');
      if (active && !active.onMain) runOnMain(active);
    }
    function startWorker() {
      if (!workerUrl || typeof root.Worker !== 'function') return false;
      let w;
      try { w = new root.Worker(workerUrl); } catch (e) { return false; }
      worker = w; workerReady = false;
      w.onmessage = ev => {
        if (worker !== w) return;
        const m = ev.data || {};
        if (m.type === 'ready') {
          workerReady = true;
          if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
          settle('worker');
          if (active && !active.sent) send(active);
          return;
        }
        if (!active || m.id !== active.id) return;
        const job = active;
        if (m.type === 'progress') { if (job.hooks.onProgress) { try { job.hooks.onProgress(m.fraction); } catch (e) { /* ignore */ } } return; }
        active = null; unhook(job);
        if (m.type === 'result') job.resolve(m.result);
        else job.reject(makeError((m.error && m.error.code) || 'TRACE_ERROR', (m.error && m.error.message) || 'Tracing failed.'));
      };
      // a worker that cannot load (file://, blocked script) or dies: do the work on the main thread instead
      w.onerror = ev => { if (worker !== w) return; if (ev && ev.preventDefault) ev.preventDefault(); toMain(); };
      w.onmessageerror = () => { if (worker === w) toMain(); };
      if (readyTimeoutMs > 0) readyTimer = setTimeout(() => { readyTimer = null; if (worker === w && !workerReady) toMain(); }, readyTimeoutMs);
      return true;
    }
    function send(job) {
      job.sent = true;
      try { worker.postMessage({ type: 'trace', id: job.id, image: { width: job.image.width, height: job.image.height, data: job.image.data }, options: job.options }); }
      catch (e) { toMain(); }
    }
    function runOnMain(job) {
      job.onMain = true;
      Trace.traceAsync(job.image, job.options, { onProgress: job.hooks.onProgress, shouldCancel: () => job.cancelled }).then(
        result => { if (active === job) { active = null; unhook(job); job.resolve(result); } },
        err => { if (active === job) { active = null; unhook(job); job.reject(err); } });
    }
    function unhook(job) {
      if (job.signal && job.onAbort) { try { job.signal.removeEventListener('abort', job.onAbort); } catch (e) { /* ignore */ } }
    }
    function cancel() {
      const job = active;
      if (!job) return false;
      active = null; job.cancelled = true; unhook(job);
      // a worker in the middle of a trace cannot listen, so it is replaced; one that has not begun is kept
      if (job.sent && worker) { stopWorker(); if (!dead && mode === 'worker' && !startWorker()) settle('main'); }
      job.reject(cancelledError());
      return true;
    }
    function trace(image, traceOptions, hooks) {
      hooks = hooks || {};
      if (dead) return Promise.reject(makeError('TERMINATED', 'This tracer was closed.'));
      if (hooks.signal && hooks.signal.aborted) return Promise.reject(cancelledError());
      cancel();
      return new Promise((resolve, reject) => {
        const job = { id: ++seq, image, options: traceOptions || {}, hooks, resolve, reject, sent: false, cancelled: false, onMain: false, signal: hooks.signal || null, onAbort: null };
        if (job.signal) { job.onAbort = () => { if (active === job) cancel(); }; job.signal.addEventListener('abort', job.onAbort); }
        active = job;
        if (mode === 'main') runOnMain(job);
        else if (worker && workerReady) send(job);
        // otherwise the worker is still starting: 'ready' or the fallback picks the job up
      });
    }
    function terminate() {
      cancel();
      dead = true;
      stopWorker();
      if (mode === 'starting') settle('main');
    }

    if (options.forceMainThread || !startWorker()) settle('main');

    return {
      trace, cancel, terminate, ready,
      get mode() { return mode; },
    };
  }

  /*
   * imageDataFrom(source, { maxSide = 1600, background = null })
   *   source: File | Blob | HTMLImageElement | HTMLCanvasElement | ImageBitmap | ImageData | { width, height, data }
   *   Resolves to { width, height, data } (data is a Uint8ClampedArray of RGBA bytes) no larger than maxSide on
   *   its longer side. Pictures are only ever made smaller, never larger. Transparency is kept.
   *   Rejects with code 'IMAGE_UNREADABLE' when the browser cannot decode the file.
   */
  function imageDataFrom(source, opts) {
    opts = opts || {};
    const maxSide = Math.max(16, Math.min(8192, Number(opts.maxSide) || 1600));
    const unreadable = () => makeError('IMAGE_UNREADABLE', 'This file could not be read as a picture.');
    if (!source) return Promise.reject(unreadable());

    const isBlob = typeof Blob !== 'undefined' && source instanceof Blob;
    const hasPixels = source.data && source.width > 0 && source.height > 0 && source.data.length === source.width * source.height * 4;
    if (hasPixels && Math.max(source.width, source.height) <= maxSide) return Promise.resolve({ width: source.width, height: source.height, data: source.data });
    if (typeof document === 'undefined') return hasPixels ? Promise.resolve({ width: source.width, height: source.height, data: source.data }) : Promise.reject(unreadable());

    const fromDrawable = (img, w, h, done) => {
      if (!(w > 0 && h > 0)) throw unreadable();
      const k = Math.min(1, maxSide / Math.max(w, h));
      const tw = Math.max(1, Math.round(w * k)), th = Math.max(1, Math.round(h * k));
      // halve until within a factor of two of the target: a single big reduction skips pixels and leaves speckle
      let cur = img, cw = w, ch = h;
      while (cw / 2 >= tw * 1.0 && ch / 2 >= th * 1.0 && (cw / 2 > tw || ch / 2 > th)) {
        const nw = Math.max(tw, Math.round(cw / 2)), nh = Math.max(th, Math.round(ch / 2));
        const c = document.createElement('canvas'); c.width = nw; c.height = nh;
        const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
        g.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
        cur = c; cw = nw; ch = nh;
      }
      const c = document.createElement('canvas'); c.width = tw; c.height = th;
      const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(cur, 0, 0, cw, ch, 0, 0, tw, th);
      const id = g.getImageData(0, 0, tw, th);
      if (done) done();
      return { width: tw, height: th, data: id.data };
    };

    if (hasPixels) {
      const c = document.createElement('canvas'); c.width = source.width; c.height = source.height;
      const id = c.getContext('2d').createImageData(source.width, source.height); id.data.set(source.data);
      c.getContext('2d').putImageData(id, 0, 0);
      return Promise.resolve().then(() => fromDrawable(c, c.width, c.height));
    }
    if (isBlob) {
      const viaImg = () => new Promise((resolve, reject) => {
        const url = URL.createObjectURL(source), img = new Image();
        img.onload = () => { try { resolve(fromDrawable(img, img.naturalWidth, img.naturalHeight, () => URL.revokeObjectURL(url))); } catch (e) { URL.revokeObjectURL(url); reject(unreadable()); } };
        img.onerror = () => { URL.revokeObjectURL(url); reject(unreadable()); };
        img.src = url;
      });
      if (typeof createImageBitmap === 'function') {
        // 'from-image' turns phone photos the right way up
        return createImageBitmap(source, { imageOrientation: 'from-image' }).then(
          bmp => fromDrawable(bmp, bmp.width, bmp.height, () => { if (bmp.close) bmp.close(); }),
          () => viaImg());
      }
      return viaImg();
    }
    return Promise.resolve().then(() => {
      const w = source.naturalWidth || source.videoWidth || source.width, h = source.naturalHeight || source.videoHeight || source.height;
      try { return fromDrawable(source, w, h); } catch (e) { throw e && e.code ? e : unreadable(); }
    });
  }

  Trace.createClient = createClient;
  Trace.imageDataFrom = imageDataFrom;
  return Trace;
});
