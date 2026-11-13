/*
 * Runs inside worker-page.html (headless Chrome, started by tests/engine/browser.test.js).
 * ?case=main       over http: a real Web Worker next to a main-thread client; every design, every format.
 * ?case=badworker  over http: worker scripts that are missing, throw, or crash.
 * ?case=file       from file://: a worker cannot be constructed at all.
 * The findings are POSTed as JSON to ?report=<url> (default /__result); node does the judging.
 */
(async function () {
  'use strict';
  const q = new URLSearchParams(location.search);
  const which = q.get('case') || 'main', report = q.get('report') || '/__result';
  const T = window.EngineTestDesigns, Engine = window.Engine;
  const out = { case: which, protocol: location.protocol, userAgent: navigator.userAgent, checks: {}, hashes: {}, timings: {}, failures: [], errors: window.__errors };
  const pre = document.getElementById('log');
  const log = text => { pre.textContent += text + '\n'; };
  const fail = text => { out.failures.push(text); log('FAIL ' + text); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const same = (a, b) => { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
  const irBytes = r => new Uint8Array(r.ir.commands.buffer, r.ir.commands.byteOffset, r.ir.commands.byteLength);
  const facts = r => JSON.stringify([r.ok, r.canExport, r.name, r.hoop, r.threads, r.objects, r.totals, r.bounds, r.warnings, r.ir.threads, r.ir.hoop, r.ir.bounds]);
  const code = async p => { try { await p; return 'resolved'; } catch (e) { return e && e.code; } };

  // one design through a client and directly; records hashes; returns the number of identical files
  async function compare(name, client, label) {
    const d = T.designs[name], direct = Engine.generate(d), r = await client.generate(d);
    if (!r) { fail(label + ' ' + name + ': generate resolved null'); return 0; }
    if (!same(irBytes(r), irBytes(direct))) fail(label + ' ' + name + ': stitches differ from the direct call');
    if (facts(r) !== facts(direct)) fail(label + ' ' + name + ': result fields differ from the direct call');
    out.hashes[label + ':' + name + '.ir'] = T.hash(irBytes(r));
    let n = 0;
    for (const f of T.formats) {
      const a = await client.export(r, { format: f, name: T.exportNames[name] }), b = Engine.export(direct, { format: f, name: T.exportNames[name] });
      if (!same(a.bytes, b.bytes)) fail(label + ' ' + name + '.' + f + ': bytes differ from the direct call'); else n++;
      if (a.filename !== b.filename || a.label !== b.label || a.mime !== b.mime || a.format !== b.format) fail(label + ' ' + name + '.' + f + ': file fields differ');
      if (new Blob([a.bytes], { type: a.mime }).size !== a.bytes.length) fail(label + ' ' + name + '.' + f + ': Blob size');
      out.hashes[label + ':' + name + '.' + f] = T.hash(a.bytes);
      out.hashes[label + ':' + name + '.' + f + '.filename'] = a.filename;
    }
    return n;
  }

  async function caseMain() {
    const modes = [];
    const w = Engine.createClient({ onModeChange: m => modes.push(m) });      // default worker URL: next to engine.js
    const m = Engine.createClient({ forceMainThread: true });
    out.checks.workerMode = await w.ready; out.checks.mainMode = await m.ready;
    let identical = 0, files = 0;
    for (const name of T.compare) {
      const t0 = performance.now(); identical += await compare(name, w, 'worker'); out.timings['worker ' + name] = Math.round(performance.now() - t0);
      const t1 = performance.now(); identical += await compare(name, m, 'main'); out.timings['main ' + name] = Math.round(performance.now() - t1);
      files += 2 * T.formats.length;
      // a result made on the main thread, exported by the worker, and the other way round
      const rm = await m.generate(T.designs[name]), rw = await w.generate(T.designs[name]);
      if (!same((await w.export(rm, { format: 'pes' })).bytes, (await m.export(rw, { format: 'pes' })).bytes)) fail(name + ': crossed export differs');
      log('ok   ' + name);
    }
    out.checks.files = files; out.checks.identical = identical;

    // newest generate wins
    const [a, b, c] = await Promise.all([w.generate(T.designs.patch), w.generate(T.designs.full), w.generate(T.designs.testsew)]);
    out.checks.stale = [a ? a.name : null, b ? b.name : null, c ? c.name : null];

    // progress through the worker
    const prog = []; await w.generate(T.designs.blocks, { onProgress: (done, total) => prog.push([done, total]) });
    out.checks.progressLast = prog[prog.length - 1]; out.checks.progressCalls = prog.length;

    // errors keep their code across the worker boundary
    out.checks.unknownFormat = await code(w.export(a || c, { format: 'jef' }));
    out.checks.emptyDesign = await code(w.export(await w.generate({ objects: [] })));
    out.checks.invalidResult = await code(w.export(null));

    // the page stays responsive while the worker digitizes something slow; the same job on the main thread blocks it
    let ticks = 0; const timer = setInterval(() => { ticks++; }, 10);
    let t0 = performance.now(); const slowW = await w.generate(T.designs.slow);
    out.timings.slowWorkerMs = Math.round(performance.now() - t0); out.checks.ticksDuringWorkerJob = ticks; out.checks.slowStitches = slowW.totals.stitches;
    out.hashes['worker:slow.ir'] = T.hash(irBytes(slowW));
    ticks = 0; t0 = performance.now(); const slowM = await m.generate(T.designs.slow);
    out.timings.slowMainMs = Math.round(performance.now() - t0); out.checks.ticksDuringMainJob = ticks;
    out.hashes['main:slow.ir'] = T.hash(irBytes(slowM)); out.checks.slowSameFacts = facts(slowW) === facts(slowM);
    out.checks.slowCodes = slowW.warnings.map(x => x.code);

    // the stitch limit: a design over it is refused the same way by the worker and on the main thread, quickly, and
    // cannot be exported; the page keeps running while the worker refuses it
    const heap = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);
    const refusal = async (client, design, opts) => {
      ticks = 0; const h0 = heap(), t = performance.now(); const r = await client.generate(design, opts); const ms = Math.round(performance.now() - t);
      const e = r.warnings.filter(x => x.severity === 'error');
      return { ms, ticks, heapMb: Math.round((heap() - h0) / 1048576), codes: e.map(x => x.code), stitches: e[0] && e[0].stitches, limit: e[0] && e[0].limit, message: e[0] && e[0].message,
        ok: r.ok, canExport: r.canExport, totalStitches: r.totals.stitches, irLength: r.ir.commands.length, skipped: r.objects.every(o => o.skipped === true && o.stitches === 0),
        exportCode: await code(client.export(r, { format: 'pes' })), facts: facts(r) };
    };
    const rw = await refusal(w, T.designs.heavy), rm = await refusal(m, T.designs.heavy);
    out.checks.refusedSame = rw.facts === rm.facts && rw.facts === facts(Engine.generate(T.designs.heavy)); delete rw.facts; delete rm.facts;
    out.checks.refusedWorker = rw; out.checks.refusedMain = rm;
    // options.maxStitches reaches the engine on both paths: exactly at the count is allowed, one under is refused
    const fullCount = Engine.generate(T.designs.full).totals.stitches, lim = {};
    for (const [label, client] of [['worker', w], ['main', m]]) {
      const at = await client.generate(T.designs.full, { maxStitches: fullCount }), under = await refusal(client, T.designs.full, { maxStitches: fullCount - 1 });
      lim[label] = { atStitches: at.totals.stitches, atCanExport: at.canExport, atSame: same(irBytes(at), irBytes(Engine.generate(T.designs.full))), underCodes: under.codes, underStitches: under.stitches, underLimit: under.limit, underExport: under.exportCode };
    }
    out.checks.fullCount = fullCount; out.checks.limitOption = lim;
    clearInterval(timer);

    // a slow job that has been superseded is cancelled: the newest answer arrives long before the slow one could
    const fast = Engine.createClient({ cancelAfterMs: 0 }); await fast.ready;
    t0 = performance.now(); const slow = fast.generate(T.designs.slow); await sleep(40);
    const newest = fast.generate(T.designs.patch);
    out.checks.cancelled = (await slow) === null;
    const got = await newest; out.timings.newestAfterCancelMs = Math.round(performance.now() - t0);
    out.checks.newestAfterCancel = !!got && same(irBytes(got), irBytes(Engine.generate(T.designs.patch)));
    out.checks.modeAfterCancel = fast.mode; fast.terminate();

    // a worker that loads but never answers: given up after readyTimeoutMs, the work is done on the main thread
    const silent = Engine.createClient({ workerUrl: 'silent-worker.js', readyTimeoutMs: 300 });
    const sr = await silent.generate(T.designs.badge);
    out.checks.silentMode = silent.mode; out.checks.silentSame = !!sr && same(irBytes(sr), irBytes(Engine.generate(T.designs.badge))); silent.terminate();

    w.terminate(); m.terminate();
    out.checks.closed = [w.mode, m.mode, await code(w.generate(T.designs.patch))];
    out.checks.modes = modes;
  }

  async function caseBadWorker() {
    for (const [key, url] of [['missing', 'does-not-exist.js'], ['throwing', 'throwing-worker.js'], ['crashing', 'crashing-worker.js']]) {
      const modes = [], c = Engine.createClient({ workerUrl: url, onModeChange: m => modes.push(m) });
      const pending = c.export(Engine.generate(T.designs.patch), { format: 'dst' });   // asked for before the worker is known to be broken
      const n = await compare('badge', c, key);
      const file = await pending;
      out.checks[key] = { mode: c.mode, modes, identical: n, earlyExport: same(file.bytes, Engine.export(Engine.generate(T.designs.patch), { format: 'dst' }).bytes) };
      c.terminate();
      log('ok   ' + key);
    }
  }

  async function caseFile() {
    const c = Engine.createClient();
    out.checks.modeAtOnce = c.mode; out.checks.mode = await c.ready;
    let n = 0; for (const name of ['patch', 'testsew']) n += await compare(name, c, 'file');
    out.checks.identical = n; c.terminate();
  }

  try {
    if (!Engine || !T) throw new Error('scripts did not load');
    if (which === 'main') await caseMain(); else if (which === 'badworker') await caseBadWorker(); else if (which === 'file') await caseFile(); else throw new Error('unknown case ' + which);
  } catch (e) { fail('page script threw: ' + (e && e.stack ? e.stack : e)); }
  await sleep(50);                                   // let late error events arrive
  out.done = true;
  log(out.failures.length ? 'FAILED' : 'PASSED');
  try { await fetch(report, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(out) }); }
  catch (e) { log('could not report: ' + e.message); }
})();
