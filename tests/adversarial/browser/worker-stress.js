/*
 * Runs in the page. Drives Engine.createClient the way an editor does (and worse), then POSTs a report to
 * the test server that served this page. Nothing here decides pass or fail alone: the node test checks
 * the report, and compares the SHA-256 of every file made here with the same file made in node.
 */
(function () {
  'use strict';
  var SD = window.StressDesigns, Engine = window.Engine;
  var current = '', report = { tests: [], modeChanges: [], errors: window.__errors, expectedErrorsFrom: -1, ua: navigator.userAgent, engine: Engine && Engine.version };
  var log = document.getElementById('log'), statusEl = document.getElementById('status');

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function now() { return performance.now(); }
  function must(cond, msg) { if (!cond) throw new Error(msg); }
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function sha(bytes) { return crypto.subtle.digest('SHA-256', bytes).then(hex); }
  function sameBytes(a, b) { if (!a || !b || a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
  function stable(r) { return JSON.stringify({ ok: r.ok, canExport: r.canExport, name: r.name, hoop: r.hoop, threads: r.threads, objects: r.objects, totals: r.totals, bounds: r.bounds, warnings: r.warnings, version: r.version }, function (k, v) { return typeof v === 'number' && !isFinite(v) ? 'non-finite:' + v : v; }); }
  // null when the two results are the same; otherwise what differs
  function differs(a, b) {
    if (!a || !b) return 'one of them is ' + (a ? b : a);
    if (!(a.ir && a.ir.commands instanceof Int32Array)) return 'ir.commands is not an Int32Array';
    if (!sameBytes(a.ir.commands, b.ir.commands)) return 'stitches differ (' + a.ir.commands.length / 3 + ' vs ' + b.ir.commands.length / 3 + ' commands)';
    if (JSON.stringify(a.ir.hoop) !== JSON.stringify(b.ir.hoop)) return 'ir.hoop differs';
    var x = stable(a), y = stable(b); if (x !== y) { var i = 0; while (x[i] === y[i]) i++; return 'result differs near "' + x.slice(Math.max(0, i - 40), i + 40) + '" vs "' + y.slice(Math.max(0, i - 40), i + 40) + '"'; }
    return null;
  }
  function settle(p) { return p.then(function (v) { return { ok: true, value: v }; }, function (e) { return { ok: false, code: e && e.code, message: String(e && e.message || e) }; }); }
  function watchdog() { var last = now(), max = 0, id = setInterval(function () { var t = now(); if (t - last > max) max = t - last; last = t; }, 5); return function () { clearInterval(id); var t = now(); if (t - last > max) max = t - last; return Math.round(max); }; }

  function T(name, ms, fn) {
    var rec = { name: name, ok: false }, t0 = now(), timer;
    current = name; statusEl.textContent = 'running: ' + name;
    return Promise.race([Promise.resolve().then(fn), new Promise(function (_, rej) { timer = setTimeout(function () { rej(new Error('TIMEOUT: not finished after ' + ms + ' ms')); }, ms); })])
      .then(function (info) { rec.ok = true; rec.info = info; }, function (e) { rec.error = String(e && e.message || e); })
      .then(function () {
        clearTimeout(timer); rec.ms = Math.round(now() - t0); report.tests.push(rec);
        var li = document.createElement('li'); li.className = rec.ok ? 'ok' : 'bad'; li.textContent = (rec.ok ? 'ok ' : 'FAIL ') + name + (rec.ok ? '' : ': ' + rec.error) + ' (' + rec.ms + ' ms)'; log.appendChild(li);
      });
  }

  var client, lightSync = function (i) { return Engine.generate(SD.light(i)); };

  var steps = [
    ['the worker starts', 8000, function () {
      var modes = []; client = Engine.createClient({ onModeChange: function (m) { modes.push(m); report.modeChanges.push({ mode: m, atMs: Math.round(now()), during: current }); } });
      var first = client.mode;
      return client.ready.then(function (m) { must(m === 'worker', 'ready resolved "' + m + '", not "worker"'); must(client.mode === 'worker', 'client.mode is "' + client.mode + '"'); return { modeBeforeReady: first, modes: modes }; });
    }],

    ['results and files are the same in the worker and on the main thread', 60000, function () {
      var out = {}, keys = Object.keys(SD.identity), chain = Promise.resolve();
      keys.forEach(function (k) {
        chain = chain.then(function () { return client.generate(SD.identity[k]); }).then(function (r) {
          var s = Engine.generate(SD.identity[k]), d = differs(r, s);
          must(!d, k + ': worker result is not the main-thread result: ' + d);
          var o = out[k] = { stitches: r.totals.stitches, canExport: r.canExport, codes: r.warnings.map(function (w) { return w.code; }), files: {} };
          must(Engine.validate(r).length === 0, k + ': Engine.validate finds fault with a worker result');
          var pv = Engine.preview(r); must(pv && Array.isArray(pv.runs), k + ': Engine.preview of a worker result');
          return sha(new Uint8Array(r.ir.commands.buffer, r.ir.commands.byteOffset, r.ir.commands.byteLength)).then(function (h) { o.ir = h; }).then(function () {
            var c2 = Promise.resolve();
            SD.formats.forEach(function (fmt) {
              c2 = c2.then(function () { return settle(client.export(r, { format: fmt })); }).then(function (w) {
                var m; try { m = { ok: true, value: Engine.export(s, { format: fmt }) }; } catch (e) { m = { ok: false, code: e && e.code }; }
                must(w.ok === m.ok, k + ' ' + fmt + ': the worker ' + (w.ok ? 'made a file' : 'refused (' + w.code + ')') + ', the main thread ' + (m.ok ? 'made a file' : 'refused (' + m.code + ')'));
                if (!w.ok) { must(w.code === m.code, k + ' ' + fmt + ': error code ' + w.code + ' in the worker, ' + m.code + ' on the main thread'); o.files[fmt] = { refused: w.code }; return; }
                var f = w.value, g = m.value;
                must(f.bytes instanceof Uint8Array, k + ' ' + fmt + ': bytes is not a Uint8Array');
                must(sameBytes(f.bytes, g.bytes), k + ' ' + fmt + ': bytes differ between worker and main thread');
                must(f.filename === g.filename && f.mime === g.mime && f.format === g.format && f.label === g.label && f.stitches === g.stitches, k + ' ' + fmt + ': file fields differ');
                // a worker result must also be good for the synchronous export
                must(sameBytes(Engine.export(r, { format: fmt }).bytes, g.bytes), k + ' ' + fmt + ': Engine.export of a worker result differs');
                var blob = new Blob([f.bytes], { type: f.mime }); must(blob.size === f.bytes.length, k + ' ' + fmt + ': Blob size');
                return sha(f.bytes).then(function (h) { o.files[fmt] = { bytes: f.bytes.length, sha: h, filename: f.filename }; });
              });
            });
            return c2;
          });
        });
      });
      return chain.then(function () { return out; });
    }],

    ['50 requests in one tick: each answer is null or its own design, the last one is answered', 30000, function () {
      var N = 50, order = [], ps = [];
      for (var i = 0; i < N; i++) (function (i) { ps.push(client.generate(SD.light(i)).then(function (r) { order.push(i); return r; })); })(i);
      return Promise.all(ps).then(function (rs) {
        var nulls = 0;
        rs.forEach(function (r, i) { if (r === null) { nulls++; return; } var d = differs(r, lightSync(i)); must(!d, 'request ' + i + ' got a result that is not its own: ' + d + ' (name ' + r.name + ')'); });
        must(rs[N - 1] !== null, 'the newest request resolved null');
        must(order[order.length - 1] === N - 1 || rs.filter(function (r) { return r; }).length === 1, 'the newest request did not resolve last: order ' + order.slice(-5));
        return { nulls: nulls, answered: N - nulls };
      });
    }],

    ['dragging a slider: 120 requests 4 ms apart', 60000, function () {
      var N = 120, ps = [], stop = watchdog(), i = 0;
      return new Promise(function (res) {
        var id = setInterval(function () { (function (i) { ps.push(client.generate(SD.medium(i))); })(i); if (++i === N) { clearInterval(id); res(); } }, 4);
      }).then(function () { return Promise.all(ps); }).then(function (rs) {
        var gap = stop(), nulls = 0;
        rs.forEach(function (r, i) { if (r === null) { nulls++; return; } var d = differs(r, Engine.generate(SD.medium(i))); must(!d, 'request ' + i + ' got a result that is not its own: ' + d); });
        must(rs[N - 1] !== null, 'the newest request resolved null');
        must(client.mode === 'worker', 'mode is ' + client.mode);
        return { nulls: nulls, answered: N - nulls, longestMainThreadGapMs: gap };
      });
    }],

    ['the main thread stays free while a 298,000-stitch design is generated and exported', 60000, function () {
      var stop = watchdog(), t0 = now(), tg;
      return client.generate(SD.identity.dense200x300).then(function (r) { tg = now() - t0; must(r && r.totals.stitches > 250000, 'no result'); return client.export(r, { format: 'pes' }); }).then(function (f) {
        var gap = stop(); must(f.bytes.length > 1500000, 'file of ' + f.bytes.length + ' bytes');
        return { generateMs: Math.round(tg), totalMs: Math.round(now() - t0), longestMainThreadGapMs: gap, heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
      });
    }],

    ['4.9 million stitches through the worker: refused at once with TOO_MANY_STITCHES, as the synchronous call does, main thread free', 120000, function () {
      var stop = watchdog(), t0 = now();
      return client.generate(SD.heavy(1)).then(function (r) {
        var tg = now() - t0, gap = stop(); must(r, 'no result');
        var e = r.warnings.filter(function (w) { return w.severity === 'error'; });
        must(e.length === 1 && e[0].code === 'TOO_MANY_STITCHES', 'blocking warnings: ' + JSON.stringify(e));
        must(e[0].limit === Engine.LIMITS.maxStitches && e[0].stitches > e[0].limit && e[0].stitches < 4000000, 'count reached ' + e[0].stitches + ', limit ' + e[0].limit);
        must(r.canExport === false && r.ok === false && r.totals.stitches === 0 && r.ir.commands.length === 3, 'a refused design carries stitches: ' + r.totals.stitches);
        must(tg < 1000, 'refused only after ' + Math.round(tg) + ' ms');
        var d = differs(r, Engine.generate(SD.heavy(1))); must(!d, 'differs from the synchronous result: ' + d);
        return settle(client.export(r, { format: 'pes' })).then(function (w) {
          must(!w.ok, 'the worker made a file of a refused design'); must(w.code === 'TOO_MANY_STITCHES', 'export code ' + w.code);
          return { countReached: e[0].stitches, limit: e[0].limit, refusedAfterMs: Math.round(tg), longestMainThreadGapMs: gap, heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
        });
      });
    }],

    ['a design over the limit, superseded again and again (the case that ran the tab out of memory), never takes the worker down', 120000, function () {
      var modes = [], c = Engine.createClient({ cancelAfterMs: 150, onModeChange: function (m) { modes.push(m); } }), chain = Promise.resolve(), refused = 0, dropped = 0, t0 = now();
      for (var k = 0; k < 8; k++) (function (k) {
        chain = chain.then(function () {
          var ph = c.generate(SD.heavy(4));
          return sleep(5 * k).then(function () { return Promise.all([ph, c.generate(SD.light(60 + k))]); }).then(function (a) {
            if (a[0] === null) dropped++; else { must(a[0].canExport === false && a[0].warnings.some(function (w) { return w.code === 'TOO_MANY_STITCHES'; }), 'round ' + k + ': 19.7 million stitches were not refused'); refused++; }
            must(a[1] && !differs(a[1], lightSync(60 + k)), 'round ' + k + ': the new request did not get its own result');
          });
        });
      })(k);
      return chain.then(function () {
        var mode = c.mode; c.terminate();
        must(mode === 'worker' && modes.join() === 'worker', 'the client left the worker: ' + modes.join());
        return { refused: refused, droppedUnstarted: dropped, totalMs: Math.round(now() - t0), heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
      });
    }],

    ['progress is reported in order', 30000, function () {
      var calls = [], d = SD.many(100);
      return client.generate(d, { onProgress: function (a, b) { calls.push([a, b]); } }).then(function (r) {
        must(r, 'no result');
        calls.forEach(function (c, i) { must(typeof c[0] === 'number' && typeof c[1] === 'number' && c[0] >= 0 && c[0] <= c[1], 'progress call ' + JSON.stringify(c)); must(c[1] === 100, 'total is ' + c[1] + ', the design has 100 objects'); if (i > 0) must(c[0] >= calls[i - 1][0], 'progress went backwards: ' + calls[i - 1][0] + ' then ' + c[0]); });
        return { calls: calls.length, last: calls[calls.length - 1] || null };
      });
    }],

    ['a design that cannot be copied to a worker (a function and a DOM node in it) is still generated', 20000, function () {
      var d = SD.light(3); d.objects[0].onChange = function () {}; d.objects[0].el = document.body; d.note = Symbol('x');
      var s = Engine.generate(d);
      return settle(client.generate(d)).then(function (w) {
        must(w.ok, 'client.generate rejected: ' + w.message + ' (the synchronous call returns a result with ' + s.totals.stitches + ' stitches)');
        var dd = differs(w.value, s); must(!dd, 'differs from the synchronous result: ' + dd);
        return client.generate(SD.light(4));
      }).then(function (r) { must(r && !differs(r, lightSync(4)), 'the client does not work after it'); return { mode: client.mode }; });
    }],

    ['bad export requests are refused with the same code as the synchronous call', 20000, function () {
      var r = lightSync(1), out = {}, empty = Engine.generate(SD.identity.empty);
      var cases = { emptyObject: [{}, { format: 'pes' }], unknownFormat: [r, { format: 'exe' }], notExportable: [empty, { format: 'pes' }], nullResult: [null, { format: 'pes' }], brokenIr: [{ ir: { commands: new Int32Array([0, 0]), hoop: { w: 1000, h: 1000 } }, warnings: [], canExport: true, name: 'x', totals: { stitches: 1 } }, { format: 'dst' }] };
      var chain = Promise.resolve();
      Object.keys(cases).forEach(function (k) {
        chain = chain.then(function () { return settle(client.export(cases[k][0], cases[k][1])); }).then(function (w) {
          var code = 'no error'; try { Engine.export(cases[k][0], cases[k][1]); } catch (e) { code = e && e.code; }
          must(!w.ok, k + ': the worker made a file'); must(w.code === code, k + ': code ' + w.code + ' in the worker, ' + code + ' synchronously'); must(typeof w.code === 'string', k + ': no error code (' + w.message + ')'); out[k] = w.code;
        });
      });
      return chain.then(function () { return client.export(r, { format: 'pes' }); }).then(function (f) { must(sameBytes(f.bytes, Engine.export(r, { format: 'pes' }).bytes), 'export after the refusals'); return out; });
    }],

    ['an export asked for while a generate runs is answered', 60000, function () {
      var r0 = lightSync(7), t0 = now();
      var pg = client.generate(SD.identity.dense200x300), pe = client.export(r0, { format: 'dst' });
      return Promise.all([pg, pe]).then(function (a) { must(a[0] && a[0].totals.stitches > 250000, 'generate gave ' + a[0]); must(sameBytes(a[1].bytes, Engine.export(r0, { format: 'dst' }).bytes), 'export bytes'); return { ms: Math.round(now() - t0) }; });
    }],

    // The slow design is SD.slow(): seconds of work in the worker, inside the stitch limit. (Before the limit existed
    // the 4.9-million-stitch design was used here, and 20 million stitches superseded again and again ran the
    // browser out of memory; that case is the test above now.)
    ['a slow request that is superseded resolves null and the new one is answered soon (default 800 ms)', 60000, function () {
      var t0 = now(), tl, stop = watchdog();
      var ph = client.generate(SD.slow());
      return sleep(20).then(function () {
        var pl = client.generate(SD.light(11)).then(function (r) { tl = now() - t0; return r; });
        return Promise.all([ph, pl]);
      }).then(function (a) {
        var gap = stop();
        must(a[1] && !differs(a[1], lightSync(11)), 'the new request did not get its own result');
        must(a[0] === null, 'the superseded slow request resolved with ' + (a[0] && a[0].totals.stitches) + ' stitches after the new one waited ' + Math.round(tl) + ' ms (mode ' + client.mode + ')');
        must(tl < 3000, 'the new request waited ' + Math.round(tl) + ' ms');
        return client.ready.then(function () { must(client.mode === 'worker', 'mode after the restart is ' + client.mode); return client.generate(SD.light(12)); }).then(function (r) { must(r && !differs(r, lightSync(12)), 'next request after the restart'); return { newRequestAnsweredAfterMs: Math.round(tl), longestMainThreadGapMs: gap, mode: client.mode }; });
      });
    }],

    ['an export queued behind a slow request survives the restart of the worker', 60000, function () {
      var c = Engine.createClient({ cancelAfterMs: 150 }), r0 = lightSync(21), t0 = now(), te;
      var ph = c.generate(SD.slow()), pe, pl;
      return sleep(20).then(function () { pe = c.export(r0, { format: 'pes' }).then(function (f) { te = now() - t0; return f; }); return sleep(20); }).then(function () {
        pl = c.generate(SD.light(22));
        return Promise.all([ph, settle(pe), pl]);
      }).then(function (a) {
        var mode = c.mode; c.terminate();
        must(a[1].ok, 'the export was rejected: ' + a[1].code + ' ' + a[1].message);
        must(sameBytes(a[1].value.bytes, Engine.export(r0, { format: 'pes' }).bytes), 'export bytes');
        must(a[2] && !differs(a[2], lightSync(22)), 'the new request did not get its own result');
        must(a[0] === null, 'the slow request was not dropped (mode ' + mode + ')');
        return { exportAnsweredAfterMs: Math.round(te), mode: mode };
      });
    }],

    ['five slow requests in a row, each superseded (cancelAfterMs 150)', 120000, function () {
      var modes = [], c = Engine.createClient({ cancelAfterMs: 150, onModeChange: function (m) { modes.push(m + '@' + Math.round(now())); } }), chain = Promise.resolve(), rounds = [];
      for (var k = 0; k < 5; k++) (function (k) {
        chain = chain.then(function () {
          var t0 = now(), rec = { modeAtStart: c.mode }, ph = c.generate(SD.slow()).then(function (r) { rec.heavyAfterMs = Math.round(now() - t0); return r; });
          rounds.push(rec);
          return sleep(10 + 25 * k).then(function () { return Promise.all([ph, c.generate(SD.light(30 + k))]); }).then(function (a) {
            rec.ms = Math.round(now() - t0); rec.modeAtEnd = c.mode; rec.heavy = a[0] === null ? 'null' : a[0].totals.stitches + ' stitches'; rec.lightRight = !!(a[1] && !differs(a[1], lightSync(30 + k)));
          });
        });
      })(k);
      return chain.then(function () {
        var mode = c.mode; c.terminate();
        var info = { rounds: rounds.map(function (r) { return r.ms; }), modes: modes, heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
        rounds.forEach(function (r, k) { must(r.lightRight, 'round ' + k + ': the new request did not get its own result; ' + JSON.stringify(rounds)); });
        rounds.forEach(function (r, k) { must(r.heavy === 'null', 'round ' + k + ': the superseded slow request was not dropped; ' + JSON.stringify(rounds) + ' ' + modes); });
        must(mode === 'worker', 'mode is ' + mode + '; ' + JSON.stringify(rounds) + ' ' + modes);
        return info;
      });
    }],

    ['two clients at once keep their answers apart', 30000, function () {
      var other = Engine.createClient(), ps = [];
      for (var i = 0; i < 10; i++) { ps.push(client.generate(SD.light(40 + i))); ps.push(other.generate(SD.medium(40 + i))); }
      return Promise.all(ps).then(function (rs) {
        rs.forEach(function (r, j) { if (r === null) return; var i = j >> 1, want = j & 1 ? Engine.generate(SD.medium(40 + i)) : lightSync(40 + i); var d = differs(r, want); must(!d, 'answer ' + j + ' is not its own: ' + d); });
        must(rs[18] && rs[19], 'a newest request resolved null'); other.terminate(); return {};
      });
    }],

    ['terminate: a pending call settles, later calls reject with CLIENT_CLOSED', 20000, function () {
      var c = Engine.createClient(), r0 = lightSync(50);
      return c.ready.then(function () {
        var pending = settle(c.generate(SD.identity.dense200x300)), pendingExport = settle(c.export(r0, { format: 'pes' }));
        c.terminate();
        return Promise.all([pending, pendingExport, settle(c.generate(SD.light(51))), settle(c.export(r0, { format: 'pes' }))]);
      }).then(function (a) {
        must(c.mode === 'closed', 'mode is ' + c.mode);
        must(!a[2].ok && a[2].code === 'CLIENT_CLOSED', 'generate after terminate: ' + JSON.stringify(a[2].ok ? 'resolved' : a[2].code));
        must(!a[3].ok && a[3].code === 'CLIENT_CLOSED', 'export after terminate: ' + JSON.stringify(a[3].ok ? 'resolved' : a[3].code));
        return { pendingGenerate: a[0].ok ? (a[0].value === null ? 'resolved null' : 'resolved with a result') : 'rejected ' + a[0].code, pendingExport: a[1].ok ? 'resolved with a file' : 'rejected ' + a[1].code };
      });
    }],

    ['forceMainThread gives the same results', 30000, function () {
      var c = Engine.createClient({ forceMainThread: true }), ps = [];
      for (var i = 0; i < 20; i++) ps.push(c.generate(SD.light(60 + i)));
      return Promise.all(ps).then(function (rs) {
        must(c.mode === 'main', 'mode is ' + c.mode);
        rs.forEach(function (r, i) { if (r === null) return; var d = differs(r, lightSync(60 + i)); must(!d, 'request ' + i + ': ' + d); });
        must(rs[19] !== null, 'the newest request resolved null');
        return c.export(rs[19], { format: 'pes' });
      }).then(function (f) { must(sameBytes(f.bytes, Engine.export(lightSync(79), { format: 'pes' }).bytes), 'export bytes'); c.terminate(); return {}; });
    }],

    // LAST: the browser itself logs the failed load, so errors from here on are expected
    ['a worker script that does not exist: the call made straight away is not lost', 20000, function () {
      report.expectedErrorsFrom = window.__errors.length;
      var modes = [], c = Engine.createClient({ workerUrl: '/tests/adversarial/browser/no-such-worker.js', onModeChange: function (m) { modes.push(m); } });
      var p = c.generate(SD.light(90)), pe = c.export(lightSync(91), { format: 'dst' });
      return Promise.all([p, pe, c.ready]).then(function (a) {
        must(a[0] && !differs(a[0], lightSync(90)), 'the call was lost or wrong'); must(sameBytes(a[1].bytes, Engine.export(lightSync(91), { format: 'dst' }).bytes), 'export bytes');
        must(a[2] === 'main' && c.mode === 'main', 'mode is ' + c.mode + ', ready gave ' + a[2]); c.terminate(); return { modes: modes };
      });
    }],
  ];

  var chain = Promise.resolve();
  if (!Engine || !SD) { report.fatal = 'window.Engine or the designs did not load'; }
  else steps.forEach(function (s) { chain = chain.then(function () { return T(s[0], s[1], s[2]); }); });
  chain.then(function () { return sleep(300); }).then(function () {
    try { if (client) client.terminate(); } catch (e) { report.errors.push('terminate threw: ' + e.message); }
    statusEl.textContent = 'done: ' + report.tests.filter(function (t) { return t.ok; }).length + ' of ' + report.tests.length + ' passed';
    return fetch('/__report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
  }).catch(function (e) { statusEl.textContent = 'could not send the report: ' + e.message; });
})();
