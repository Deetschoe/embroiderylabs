/*
 * worker.js - runs the Embroidery Labs engine off the main thread. Started by Engine.createClient().
 *
 * Messages in  (page -> worker):
 *   { type: 'generate', id, design, progress?: boolean, maxStitches?: number }
 *   { type: 'export',   id, result, options: { format, name } }
 * Messages out (worker -> page):
 *   { type: 'ready',    version }                      once, after the scripts loaded
 *   { type: 'progress', id, done, total }              objects digitized so far (only when asked for)
 *   { type: 'result',   id, result }                   answer to 'generate'
 *   { type: 'exported', id, file: { bytes, filename, mime, format, label } }
 *   { type: 'error',    id, error: { code, message } } answer to either, when it failed
 * Every answer carries the id of the request it belongs to. Requests are handled one at a time, in order.
 */
/* global importScripts, Engine */
'use strict';
importScripts('lineart.js', 'embwriter.js', 'digitize.js', 'engine.js');

self.onmessage = function (ev) {
  var m = ev.data;
  if (!m || typeof m !== 'object') return;
  var id = m.id;
  try {
    if (m.type === 'generate') {
      var last = 0;
      var options = { maxStitches: m.maxStitches };
      if (m.progress) options.onProgress = function (done, total) {
        var t = Date.now();
        if (done === total || t - last >= 50) { last = t; self.postMessage({ type: 'progress', id: id, done: done, total: total }); }
      };
      var result = Engine.generate(m.design, options);
      self.postMessage({ type: 'result', id: id, result: result }, [result.ir.commands.buffer]);
    } else if (m.type === 'export') {
      var file = Engine.export(m.result, m.options);
      self.postMessage({ type: 'exported', id: id, file: file }, [file.bytes.buffer]);
    } else {
      self.postMessage({ type: 'error', id: id, error: { code: 'UNKNOWN_MESSAGE', message: 'Unknown request type.' } });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: id, error: { code: (e && e.code) || 'ENGINE_ERROR', message: (e && e.message) || String(e), warnings: e && e.warnings } });
  }
};

self.postMessage({ type: 'ready', version: Engine.version });
