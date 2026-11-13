/*
 * worker.js - runs the picture tracer off the main thread. Started by Trace.createClient() (client.js).
 *
 * Messages in  (page -> worker):
 *   { type: 'trace', id, image: { width, height, data }, options }
 * Messages out (worker -> page):
 *   { type: 'ready',    version }                      once, after trace.js loaded
 *   { type: 'progress', id, fraction }                 0..1, at most every 50 ms
 *   { type: 'result',   id, result }                   answer to 'trace' (the object Trace.trace returns)
 *   { type: 'error',    id, error: { code, message } } when it failed
 * Every answer carries the id of the request it belongs to. Requests are handled one at a time, in order.
 * There is no cancel message: a trace is one uninterrupted run here, so the page cancels by ending this
 * worker and starting a fresh one (client.js does that).
 */
/* global importScripts, Trace */
'use strict';
importScripts('trace.js');

self.onmessage = function (ev) {
  var m = ev.data;
  if (!m || typeof m !== 'object') return;
  var id = m.id;
  try {
    if (m.type === 'trace') {
      var last = 0;
      var result = Trace.trace(m.image, m.options, {
        onProgress: function (fraction) {
          var t = Date.now();
          if (fraction >= 1 || t - last >= 50) { last = t; self.postMessage({ type: 'progress', id: id, fraction: fraction }); }
        },
      });
      self.postMessage({ type: 'result', id: id, result: result });
    } else {
      self.postMessage({ type: 'error', id: id, error: { code: 'UNKNOWN_MESSAGE', message: 'Unknown request type.' } });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: id, error: { code: (e && e.code) || 'TRACE_ERROR', message: (e && e.message) || String(e) } });
  }
};

self.postMessage({ type: 'ready', version: Trace.version });
