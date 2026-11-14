/*
 * The public face (js/engine/engine.js, worker.js) as API.md describes it: the synchronous calls, the three
 * ways of loading (script tags, importScripts, require), the worker message protocol, and the async client
 * in main-thread mode and in worker mode.
 *
 * node has no Web Worker, so worker mode runs here against a stand-in: the page scripts are loaded into one
 * vm context, and each `new Worker()` runs the real worker.js in a second vm context with messages copied by
 * structuredClone and delivered asynchronously, as a browser does. The real thing (Chrome, over http) is
 * tests/engine/browser.test.js.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ENGINE_DIR = path.join(__dirname, '..', '..', 'js', 'engine');
const Engine = require(path.join(ENGINE_DIR, 'engine.js'));
const D = require('./designs.js');

const SRC = {};
for (const f of ['lineart.js', 'embwriter.js', 'digitize.js', 'engine.js', 'worker.js']) SRC[f] = fs.readFileSync(path.join(ENGINE_DIR, f), 'utf8');
const load = (ctx, f) => vm.runInContext(SRC[f], ctx, { filename: f });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sameBytes = (a, b) => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
// a result as plain data, without the one field that differs from run to run
const strip = r => { const o = JSON.parse(JSON.stringify(r)); delete o.timeMs; o.ir.commands = Array.from(r.ir.commands); return o; };
const sameResult = (a, b, what) => assert.deepStrictEqual(strip(a), strip(b), what);
async function rejects(promise, code, what) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, (what || code) + ': expected a rejection');
  assert.strictEqual(err.code, code, what);
  assert.ok(typeof err.message === 'string' && err.message.length > 5, 'a message a visitor can read');
  return err;
}
function throws(fn, code) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, code + ': expected a throw'); assert.strictEqual(err.code, code); assert.ok(err.message.length > 5);
  return err;
}

// ---- a page: the three scripts in one global, like three <script> tags
function page(globals) {
  const g = Object.assign({ console, setTimeout, clearTimeout, performance }, globals);
  g.self = g; g.window = g;
  const ctx = vm.createContext(g);
  load(ctx, 'embwriter.js'); load(ctx, 'digitize.js'); load(ctx, 'engine.js');
  return g.Engine;
}
// ---- a worker global scope running the real worker.js; post(msg, transfer) receives what it sends
function workerScope(post) {
  const g = { console, setTimeout, clearTimeout, performance };
  g.self = g;
  const ctx = vm.createContext(g);
  g.importScripts = (...names) => names.forEach(n => load(ctx, n));
  g.postMessage = post;
  return { g, start: () => load(ctx, 'worker.js') };
}
// ---- a stand-in for the Worker constructor
function fakeWorker(behaviour, log) {
  return function Worker(url) {
    log.created.push(url);
    if (behaviour.throwOnConstruct) throw new Error('SecurityError: cannot start a worker here');
    const w = this; let dead = false;
    w.onmessage = null; w.onerror = null; w.onmessageerror = null;
    const scope = workerScope((msg, transfer) => {
      const copy = structuredClone(msg, transfer ? { transfer } : undefined);
      setTimeout(() => { if (!dead && w.onmessage) w.onmessage({ data: copy }); }, 0);
    });
    w.postMessage = msg => {
      const copy = structuredClone(msg);            // throws DataCloneError for functions, as a real worker does
      log.posted.push(copy.type);
      setTimeout(() => {
        if (dead) return;
        if (behaviour.crashOn === copy.type) { if (w.onerror) w.onerror({ preventDefault() {}, message: 'worker crashed' }); return; }
        scope.g.onmessage({ data: copy });
      }, behaviour.workMs || 0);
    };
    w.terminate = () => {
      if (dead) return;
      dead = true; log.terminated++;
      // a real worker that is being terminated can still deliver one more error from a request it already had
      if (behaviour.crashOn) { let prevented = false; if (typeof w.onerror === 'function') w.onerror({ preventDefault() { prevented = true; } }); if (!prevented) log.unhandled++; }
    };
    if (behaviour.silent) return;
    setTimeout(() => {
      if (dead) return;
      if (behaviour.failToLoad) { if (w.onerror) w.onerror({ preventDefault() {}, message: '404' }); return; }
      scope.start();
    }, 0);
  };
}
const newLog = () => ({ created: [], posted: [], terminated: 0, unhandled: 0 });

module.exports = {
  name: 'facade: Engine API, loading, worker protocol, async client',
  async run(t) {
    const ref = {};
    for (const k of D.compare) ref[k] = Engine.generate(D.designs[k]);

    t.test('the documented API is all there, and nothing else', () => {
      assert.deepStrictEqual(Object.keys(Engine).sort(), ['DEFAULTS', 'Digitizer', 'FILL_PATTERNS', 'FILL_STYLES', 'FORMATS', 'LIMITS', 'OP', 'Writer', 'createClient', 'export', 'exportFile', 'generate', 'preview', 'validate', 'version']);
      assert.strictEqual(Engine.version, '1.0.0'); assert.strictEqual(Engine.export, Engine.exportFile);
      assert.deepStrictEqual(Engine.OP, { STITCH: 0, JUMP: 1, TRIM: 2, COLOR_CHANGE: 3, END: 4 });
      assert.deepStrictEqual(Engine.FORMATS, [
        { id: 'pes', ext: 'pes', mime: 'application/octet-stream', label: 'Brother PES (v1)' },
        { id: 'dst', ext: 'dst', mime: 'application/octet-stream', label: 'Tajima DST' },
        { id: 'pec', ext: 'pec', mime: 'application/octet-stream', label: 'Brother PEC' },
        { id: 'pes6', ext: 'pes', mime: 'application/octet-stream', label: 'Brother PES (v6)' }]);
      assert.deepStrictEqual(Engine.DEFAULTS, { hoop: { width: 100, height: 100 }, color: '#000000',
        fill: { spacing: 0.4, stitchLength: 3.0, angle: 0, underlay: true, pullComp: 0.2 },
        line: { type: 'running', width: 3.0, stitchLength: 2.5, spacing: 0.4, underlay: true } });
      assert.deepStrictEqual(Engine.LIMITS, { coord: 2000, hoop: [10, 1000], fillSpacing: [0.2, 2.0], fillStitchLength: [1.0, 7.0], pullComp: [0, 1.0],
        lineStitchLength: [1.0, 7.0], satinSpacing: [0.2, 2.0], satinWidth: [1.0, 12.0], denseBelow: 0.3, satinWideAbove: 9.0, longStitchAbove: 7.0,
        minStitch: 0.3, maxStitch: 12.1, maxFillDensity: 8.0, maxDensity: 15.0, objectStitches: 400000, maxStitches: 500000, largeDesign: 100000 });
    });

    t.test('generate: the result has the documented shape and adds up', () => {
      for (const k of D.compare) {
        const r = ref[k], d = D.designs[k];
        assert.deepStrictEqual(Object.keys(r).sort(), ['bounds', 'canExport', 'hoop', 'ir', 'name', 'objects', 'ok', 'threads', 'timeMs', 'totals', 'version', 'warnings'], k);
        assert.strictEqual(r.ok, true, k + ': ' + JSON.stringify(r.warnings.filter(w => w.severity === 'error'))); assert.strictEqual(r.canExport, true);
        assert.strictEqual(r.name, d.name); assert.deepStrictEqual(r.hoop, d.hoop); assert.strictEqual(r.version, '1.0.0'); assert.ok(r.timeMs >= 0);
        assert.deepStrictEqual(Object.keys(r.totals).sort(), ['colorChanges', 'colors', 'jumps', 'longestStitchMm', 'stitches', 'threadLengthM', 'timeMin', 'trims']);
        assert.strictEqual(r.objects.length, d.objects.length);
        r.objects.forEach((o, i) => { assert.strictEqual(o.index, i); assert.strictEqual(o.id, d.objects[i].id); assert.ok(o.stitches > 0 && !o.skipped); });
        assert.strictEqual(r.threads.length, r.totals.colors); assert.strictEqual(r.totals.colorChanges, r.totals.colors - 1);
        assert.strictEqual(r.threads.reduce((s, th) => s + th.stitches, 0), r.totals.stitches);
        assert.strictEqual(r.objects.reduce((s, o) => s + o.stitches, 0) <= r.totals.stitches, true);
        for (const th of r.threads) assert.ok(/^#[0-9a-f]{6}$/.test(th.color) && th.lengthM > 0);
        assert.ok(r.totals.longestStitchMm <= 12.1 && r.totals.threadLengthM > 0 && r.totals.timeMin > 0);
        assert.ok(r.bounds.minX >= 0 && r.bounds.minY >= 0 && r.bounds.maxX <= d.hoop.width && r.bounds.maxY <= d.hoop.height, k + ' bounds inside the hoop');
        assert.ok(Math.abs(r.bounds.width - (r.bounds.maxX - r.bounds.minX)) < 1e-9);
        assert.deepStrictEqual(Engine.validate(r), []);
      }
      const before = JSON.stringify(D.designs.badge); Engine.generate(D.designs.badge);
      assert.strictEqual(JSON.stringify(D.designs.badge), before, 'generate does not modify the design');
    });

    t.test('generate never throws: junk in, warnings out', () => {
      for (const junk of [undefined, null, 5, 'x', [], {}, { objects: 'no' }, { objects: [null, 7, { type: 'blob' }, { type: 'rect' }] }, { hoop: { width: -1 }, objects: [] }]) {
        const r = Engine.generate(junk);
        assert.strictEqual(r.canExport, false); assert.strictEqual(r.totals.stitches, 0); assert.strictEqual(r.bounds, null);
        assert.ok(r.warnings.some(w => w.code === 'EMPTY_DESIGN' && w.severity === 'error'));
        for (const w of r.warnings) assert.ok(typeof w.message === 'string' && w.message.length > 5 && ['error', 'warning', 'info'].includes(w.severity), JSON.stringify(w));
        assert.deepStrictEqual(Engine.validate(r), []);
        throws(() => Engine.export(r), 'EMPTY_DESIGN');
      }
    });

    t.test('progress: one call per object, ending at total', () => {
      const seen = []; Engine.generate(D.designs.blocks, { onProgress: (done, total) => seen.push([done, total]) });
      assert.strictEqual(seen.length, 12); seen.forEach((p, i) => assert.deepStrictEqual(p, [i + 1, 12]));
      Engine.generate(D.designs.patch, { onProgress: () => { throw new Error('a broken callback'); } });
    });

    t.test('export: file name, label, format handling', () => {
      const stems = { patch: 'Patch', badge: 'Cafe Badge No1', blocks: 'A very long design name that keeps going', letters: 'U_O', full: 'Full hoop', testsew: 'Test sew' };
      for (const k of D.compare) for (const f of Engine.FORMATS) {
        const file = Engine.export(ref[k], { format: f.id, name: D.exportNames[k] });
        assert.deepStrictEqual(Object.keys(file).sort(), ['bytes', 'filename', 'format', 'label', 'mime', 'stitches']);
        assert.ok(file.bytes instanceof Uint8Array && file.bytes.length > 500);
        assert.strictEqual(file.filename, stems[k] + '.' + f.ext); assert.strictEqual(file.mime, f.mime); assert.strictEqual(file.format, f.id);
        assert.strictEqual(file.stitches, ref[k].totals.stitches);
        assert.ok(/^[\x20-\x7e]+$/.test(file.label) && file.label === file.label.trim(), 'label is printable ASCII');
      }
      const r = ref.patch, pes = Engine.export(r);
      assert.strictEqual(pes.format, 'pes'); assert.strictEqual(pes.filename, 'Patch.pes'); assert.strictEqual(pes.label, 'Patch');
      assert.strictEqual(Buffer.from(pes.bytes.subarray(0, 8)).toString('latin1'), '#PES0001');
      assert.ok(sameBytes(Engine.export(r, { format: 'PES' }).bytes, pes.bytes)); assert.ok(sameBytes(Engine.export(r, { format: null }).bytes, pes.bytes));
      assert.strictEqual(Buffer.from(Engine.export(r, { format: 'pes6' }).bytes.subarray(0, 8)).toString('latin1'), '#PES0060');
      assert.strictEqual(Buffer.from(Engine.export(r, { format: 'pec' }).bytes.subarray(0, 8)).toString('latin1'), '#PEC0001');
      assert.strictEqual(Buffer.from(Engine.export(r, { format: 'Dst' }).bytes.subarray(0, 3)).toString('latin1'), 'LA:');
      const name = (n, res) => Engine.export(res || r, { name: n });
      assert.strictEqual(name('My Logo v2').filename, 'My Logo v2.pes');
      assert.strictEqual(name('x'.repeat(100)).filename, 'x'.repeat(60) + '.pes');
      assert.strictEqual(name('...').filename, 'design.pes');
      assert.strictEqual(name('\u{1F9F5}\u{1F9F5}').label, 'Untitled');
      assert.strictEqual(name('   ').filename, 'Patch.pes', 'blank name falls back to result.name');
      assert.strictEqual(name(42).filename, 'Patch.pes', 'a name that is not a string falls back to result.name');
      assert.strictEqual(name(undefined, Object.assign({}, r, { name: '' })).filename, 'design.pes');
      assert.strictEqual(name('a/b\\c:d*e?"f<g>h|i').filename, 'a_b_c_d_e_f_g_h_i.pes');
      assert.strictEqual(name('Café Badge №1').label, 'Cafe Badge No1');
      // export needs only the five documented fields
      const slim = { ir: r.ir, warnings: r.warnings, canExport: r.canExport, name: r.name, totals: r.totals };
      assert.ok(sameBytes(Engine.export(slim).bytes, pes.bytes));
      // exporting twice gives the same bytes and leaves the result alone
      const snap = strip(r); Engine.export(r, { format: 'dst' }); assert.ok(sameBytes(Engine.export(r).bytes, pes.bytes)); assert.deepStrictEqual(strip(r), snap);
    });

    t.test('export: every failure is an Error with a code', () => {
      const r = ref.patch;
      const e = throws(() => Engine.export(r, { format: 'jef' }), 'UNKNOWN_FORMAT'); assert.ok(/pes, dst, pec, pes6/.test(e.message));
      throws(() => Engine.export(r, { format: {} }), 'UNKNOWN_FORMAT');
      for (const bad of [undefined, null, 3, 'r', {}, { ir: {} }]) throws(() => Engine.export(bad), 'INVALID_RESULT');
      const outside = Engine.generate({ hoop: { width: 100, height: 100 }, objects: [{ type: 'rect', x: 80, y: 40, width: 40, height: 20 }] });
      const eo = throws(() => Engine.export(outside), 'OUTSIDE_HOOP'); assert.strictEqual(eo.warnings.length, 1); assert.strictEqual(eo.warnings[0].code, 'OUTSIDE_HOOP');
      const big = Engine.generate({ hoop: { width: 50, height: 50 }, objects: [{ type: 'rect', x: -10, y: 10, width: 80, height: 20 }] });
      throws(() => Engine.export(big), 'EXCEEDS_HOOP');
      throws(() => Engine.export(Object.assign({}, r, { canExport: false })), 'NOT_EXPORTABLE');
      const cmds = Int32Array.from(r.ir.commands); cmds[4] += 7;
      const ei = throws(() => Engine.export(Object.assign({}, r, { ir: Object.assign({}, r.ir, { commands: cmds }) })), 'INVALID_IR');
      assert.ok(Array.isArray(ei.detail) && ei.detail.length >= 1);
      const many = Engine.generate({ hoop: { width: 300, height: 300 }, objects: Array.from({ length: 256 }, (_, i) => ({ type: 'line', x1: 10, y1: 10 + i, x2: 40, y2: 10 + i, color: i % 2 ? '#111111' : '#eeeeee' })) });
      assert.strictEqual(many.totals.colors, 256); throws(() => Engine.export(many), 'TOO_MANY_COLORS');
    });

    t.test('preview: one polyline per thread run, in design millimetres', () => {
      for (const k of D.compare) {
        const r = ref[k], p = Engine.preview(r);
        assert.strictEqual(p.runs.length, r.totals.trims, k + ' runs'); assert.strictEqual(p.jumps.length, r.totals.jumps - 1, k + ' jumps');
        let pts = 0, thread = 0;
        for (const run of p.runs) {
          assert.ok(run.points instanceof Float32Array && run.points.length >= 4 && run.points.length % 2 === 0);
          assert.ok(run.thread === thread || run.thread === thread + 1); thread = run.thread;
          assert.strictEqual(run.color, r.threads[run.thread].color);
          pts += run.points.length / 2;
          for (let i = 0; i < run.points.length; i += 2) assert.ok(run.points[i] >= r.bounds.minX - 1e-3 && run.points[i] <= r.bounds.maxX + 1e-3 && run.points[i + 1] >= r.bounds.minY - 1e-3 && run.points[i + 1] <= r.bounds.maxY + 1e-3);
        }
        assert.strictEqual(pts, r.totals.stitches); assert.strictEqual(thread, r.totals.colors - 1);
        for (const j of p.jumps) assert.ok([j.x1, j.y1, j.x2, j.y2].every(Number.isFinite) && j.thread >= 0 && j.thread < r.totals.colors);
      }
      assert.deepStrictEqual(Engine.preview(null), { runs: [], jumps: [] }); assert.deepStrictEqual(Engine.preview({}), { runs: [], jumps: [] });
      // a line from (10, 20) to (40, 20) comes back where it was drawn, also in a hoop with an odd size
      for (const hoop of [{ width: 100, height: 100 }, { width: 100.1, height: 60.3 }, { width: 77.7, height: 55.5 }]) {
        const r = Engine.generate({ hoop, objects: [{ type: 'line', x1: 10, y1: 20, x2: 40, y2: 20 }] }), pv = Engine.preview(r).runs[0].points;
        let lo = Infinity, hi = -Infinity; for (let i = 0; i < pv.length; i += 2) { lo = Math.min(lo, pv[i]); hi = Math.max(hi, pv[i]); assert.ok(Math.abs(pv[i + 1] - 20) < 1e-4); }
        assert.ok(Math.abs(lo - 10) < 1e-4 && Math.abs(hi - 40) < 1e-4, JSON.stringify(hoop) + ': ' + lo + ' .. ' + hi);
        assert.deepStrictEqual([r.bounds.minX, r.bounds.maxX, r.bounds.minY, r.bounds.maxY], [10, 40, 20, 20]);
      }
    });

    t.test('validate: accepts a result or its stitch data, reports damage', () => {
      const r = ref.badge;
      assert.deepStrictEqual(Engine.validate(r), []); assert.deepStrictEqual(Engine.validate(r.ir), []);
      assert.ok(Engine.validate(null).length === 1 && Engine.validate({}).length === 1);
      const cmds = Int32Array.from(r.ir.commands); cmds[cmds.length - 3] = Engine.OP.STITCH;
      assert.ok(Engine.validate(Object.assign({}, r.ir, { commands: cmds })).length >= 1);
    });

    t.test('the engine files contain no network, storage, dialog or HTML-injection calls', () => {
      for (const f of Object.keys(SRC)) for (const word of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource', 'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'innerHTML', 'insertAdjacentHTML', 'document.write', 'alert(', 'confirm(', 'prompt(', 'eval(', 'new Function'])
        assert.ok(!SRC[f].includes(word), f + ' contains ' + word);
    });

    // ------------------------------------------------------------------ loading
    t.test('loads from three script tags into one global; the wrong order says so', () => {
      const g = { console, setTimeout, clearTimeout, performance }; g.self = g; g.window = g;
      const ctx = vm.createContext(g), before = Object.keys(g);
      load(ctx, 'embwriter.js'); load(ctx, 'digitize.js'); load(ctx, 'engine.js');
      assert.deepStrictEqual(Object.keys(g).filter(k => !before.includes(k)), ['Engine'], 'exactly one new global');
      assert.deepStrictEqual(Object.keys(g.Engine).sort(), Object.keys(Engine).sort());
      const r = g.Engine.generate(D.designs.badge); sameResult(r, ref.badge, 'same stitches as node');
      for (const f of D.formats) assert.ok(sameBytes(g.Engine.export(r, { format: f }).bytes, Engine.export(ref.badge, { format: f }).bytes), f);
      const g2 = {}; g2.self = g2; const ctx2 = vm.createContext(g2);
      assert.throws(() => load(ctx2, 'engine.js'), /load embwriter\.js and digitize\.js first/);
      load(ctx2, 'digitize.js'); assert.throws(() => load(ctx2, 'engine.js'), /load embwriter\.js and digitize\.js first/);
      // no `self`: a plain global object (older embedders)
      const g3 = { performance }; const ctx3 = vm.createContext(g3);
      load(ctx3, 'embwriter.js'); load(ctx3, 'digitize.js'); load(ctx3, 'engine.js');
      assert.strictEqual(vm.runInContext('typeof Engine.generate', ctx3), 'function');
    });

    t.test('worker.js: ready, generate with progress, export, errors, every answer carries its id', () => {
      const out = [];
      const w = workerScope((msg, transfer) => out.push({ msg, transfer }));
      w.start();
      assert.strictEqual(out.length, 1); assert.deepStrictEqual(JSON.parse(JSON.stringify(out[0].msg)), { type: 'ready', version: '1.0.0' });
      const send = data => { out.length = 0; w.g.onmessage({ data }); return out.slice(); };
      let got = send({ type: 'generate', id: 41, design: D.designs.blocks, progress: true });
      const res = got[got.length - 1];
      assert.strictEqual(res.msg.type, 'result'); assert.strictEqual(res.msg.id, 41);
      assert.ok(got.length >= 2 && got.slice(0, -1).every(m => m.msg.type === 'progress' && m.msg.id === 41));
      assert.deepStrictEqual([got[got.length - 2].msg.done, got[got.length - 2].msg.total], [12, 12], 'the last progress message is always sent');
      assert.strictEqual(res.transfer.length, 1); assert.strictEqual(res.transfer[0], res.msg.result.ir.commands.buffer, 'stitches are transferred, not copied');
      sameResult(res.msg.result, ref.blocks, 'worker result');
      got = send({ type: 'generate', id: 42, design: D.designs.patch });
      assert.strictEqual(got.length, 1, 'no progress unless asked for'); assert.strictEqual(got[0].msg.id, 42);
      got = send({ type: 'export', id: 43, result: got[0].msg.result, options: { format: 'dst', name: 'Patch' } });
      assert.strictEqual(got.length, 1); assert.strictEqual(got[0].msg.type, 'exported'); assert.strictEqual(got[0].msg.id, 43);
      assert.strictEqual(got[0].transfer[0], got[0].msg.file.bytes.buffer);
      assert.ok(sameBytes(got[0].msg.file.bytes, Engine.export(ref.patch, { format: 'dst', name: 'Patch' }).bytes)); assert.strictEqual(got[0].msg.file.filename, 'Patch.dst');
      got = send({ type: 'export', id: 44, result: null, options: {} });
      assert.deepStrictEqual([got[0].msg.type, got[0].msg.id, got[0].msg.error.code], ['error', 44, 'INVALID_RESULT']);
      got = send({ type: 'export', id: 45, result: Engine.generate({ objects: [] }), options: {} });
      assert.strictEqual(got[0].msg.error.code, 'EMPTY_DESIGN'); assert.strictEqual(got[0].msg.error.warnings[0].code, 'EMPTY_DESIGN'); assert.ok(got[0].msg.error.message.length > 5);
      got = send({ type: 'export', id: 46, result: ref.patch, options: { format: 'xyz' } });
      assert.strictEqual(got[0].msg.error.code, 'UNKNOWN_FORMAT');
      got = send({ type: 'dance', id: 47 });
      assert.deepStrictEqual([got[0].msg.type, got[0].msg.id, got[0].msg.error.code], ['error', 47, 'UNKNOWN_MESSAGE']);
      assert.strictEqual(send(null).length, 0); assert.strictEqual(send('generate').length, 0);
      got = send({ type: 'generate', id: 48, design: null });
      assert.strictEqual(got[0].msg.type, 'result', 'a junk design is a result with warnings, not an error'); assert.strictEqual(got[0].msg.result.canExport, false);
    });

    // ------------------------------------------------------------------ async client, main thread
    await t.test('client on the main thread: same results and bytes, newest generate wins, exports are never dropped', async () => {
      const modes = [], c = Engine.createClient({ onModeChange: m => modes.push(m) });
      assert.strictEqual(c.mode, 'main', 'node has no Worker'); assert.strictEqual(await c.ready, 'main'); assert.deepStrictEqual(modes, ['main']);
      assert.deepStrictEqual(Object.keys(c).sort(), ['export', 'exportFile', 'generate', 'mode', 'ready', 'terminate']); assert.strictEqual(c.export, c.exportFile);
      const prog = [];
      const p1 = c.generate(D.designs.patch), p2 = c.generate(D.designs.full), pe = c.export(ref.letters, { format: 'pec', name: 'x' }),
        p3 = c.generate(D.designs.badge, { onProgress: (d, n) => prog.push([d, n]) });
      const [r1, r2, file, r3] = await Promise.all([p1, p2, pe, p3]);
      assert.strictEqual(r1, null); assert.strictEqual(r2, null); sameResult(r3, ref.badge, 'badge');
      assert.deepStrictEqual(prog, [[1, 4], [2, 4], [3, 4], [4, 4]]);
      assert.ok(sameBytes(file.bytes, Engine.export(ref.letters, { format: 'pec', name: 'x' }).bytes)); assert.strictEqual(file.filename, 'x.pec');
      for (const f of D.formats) assert.ok(sameBytes((await c.export(r3, { format: f })).bytes, Engine.export(ref.badge, { format: f }).bytes), f);
      await rejects(c.export(r3, { format: 'jef' }), 'UNKNOWN_FORMAT');
      const e = await rejects(c.export(await c.generate({ objects: [] })), 'EMPTY_DESIGN'); assert.strictEqual(e.warnings[0].code, 'EMPTY_DESIGN');
      await rejects(c.export(null), 'INVALID_RESULT');
      // generate does not block the caller: nothing has run when generate() returns
      let done = false; const p = c.generate(D.designs.patch).then(r => { done = true; return r; });
      assert.strictEqual(done, false); sameResult(await p, ref.patch, 'patch');
      // terminate: waiting work is answered, later calls are refused
      const pg = c.generate(D.designs.full), px = c.export(ref.patch);
      c.terminate(); assert.strictEqual(c.mode, 'closed'); c.terminate();
      assert.strictEqual(await pg, null); await rejects(px, 'CLIENT_CLOSED');
      await rejects(c.generate(D.designs.patch), 'CLIENT_CLOSED'); await rejects(c.export(ref.patch), 'CLIENT_CLOSED');
      assert.deepStrictEqual(modes, ['main']);
      const forced = page({ Worker: fakeWorker({}, newLog()) }).createClient({ forceMainThread: true });
      assert.strictEqual(forced.mode, 'main'); sameResult(await forced.generate(D.designs.patch), ref.patch, 'forceMainThread');
    });

    // ------------------------------------------------------------------ async client, worker
    await t.test('client in a worker: same results and bytes as the direct calls; calls made before ready are kept', async () => {
      const log = newLog(), modes = [];
      const E = page({ Worker: fakeWorker({}, log), document: { currentScript: { src: 'https://example.test/js/engine/engine.js?v=7' } } });
      const c = E.createClient({ onModeChange: m => modes.push(m) });
      assert.strictEqual(c.mode, 'starting'); assert.deepStrictEqual(log.created, ['https://example.test/js/engine/worker.js?v=7'], 'worker.js is looked for next to engine.js');
      const prog = [], pg = c.generate(D.designs.badge, { onProgress: (d, n) => prog.push([d, n]) }), pe = c.export(ref.patch, { format: 'dst' });
      assert.strictEqual(await c.ready, 'worker'); assert.strictEqual(c.mode, 'worker');
      const r = await pg; sameResult(r, ref.badge, 'badge through the worker');
      assert.ok(r.ir.commands instanceof Int32Array, 'stitches arrive as an Int32Array');
      assert.ok(prog.length >= 1 && prog[prog.length - 1][0] === 4 && prog[prog.length - 1][1] === 4, JSON.stringify(prog));
      assert.ok(sameBytes((await pe).bytes, Engine.export(ref.patch, { format: 'dst' }).bytes));
      for (const k of D.compare) {
        const res = await c.generate(D.designs[k]); sameResult(res, ref[k], k);
        for (const f of D.formats) {
          const a = await c.export(res, { format: f, name: D.exportNames[k] }), b = Engine.export(ref[k], { format: f, name: D.exportNames[k] });
          assert.ok(sameBytes(a.bytes, b.bytes), k + '.' + f); assert.deepStrictEqual([a.filename, a.mime, a.format, a.label, a.stitches], [b.filename, b.mime, b.format, b.label, b.stitches]);
        }
        assert.strictEqual(res.ir.commands.length, ref[k].ir.commands.length, 'a worker result can be exported again and again');
        assert.strictEqual(Engine.preview(res).runs.length, ref[k].totals.trims);
      }
      await rejects(c.export(r, { format: 'jef' }), 'UNKNOWN_FORMAT');
      const e = await rejects(c.export(await c.generate({ objects: [] })), 'EMPTY_DESIGN'); assert.strictEqual(e.warnings[0].code, 'EMPTY_DESIGN');
      await rejects(c.export(null), 'INVALID_RESULT');
      // a design that cannot be copied to a worker is done on the main thread; the client stays in worker mode
      const odd = Object.assign({}, D.designs.patch, { onChange() {} });
      sameResult(await c.generate(odd), ref.patch, 'design holding a function'); assert.strictEqual(c.mode, 'worker');
      assert.deepStrictEqual(modes, ['worker']); assert.strictEqual(log.created.length, 1);
      c.terminate(); assert.strictEqual(log.terminated, 1); assert.strictEqual(c.mode, 'closed');
      await rejects(c.generate(D.designs.patch), 'CLIENT_CLOSED');
    });

    await t.test('stitch limit: a design over it is refused the same way by the direct call, the main-thread client and the worker client', async () => {
      const n = ref.full.totals.stitches, over = Engine.generate(D.designs.full, { maxStitches: n - 1 }), e = over.warnings.filter(x => x.severity === 'error');
      assert.deepStrictEqual(e.map(x => [x.code, x.limit]), [['TOO_MANY_STITCHES', n - 1]]); assert.ok(e[0].stitches > n - 1 && e[0].stitches <= n, 'count reached ' + e[0].stitches);
      assert.deepStrictEqual([over.ok, over.canExport, over.totals.stitches, over.ir.commands.length, Engine.validate(over)], [false, false, 0, 3, []]);
      assert.ok(over.objects.length === D.designs.full.objects.length && over.objects.every(o => o.skipped === true && o.stitches === 0), 'every object is listed and marked skipped');
      assert.deepStrictEqual(Object.keys(over).sort(), Object.keys(ref.full).sort(), 'a refused result has the same fields as any other');
      throws(() => Engine.export(over), 'TOO_MANY_STITCHES');
      sameResult(Engine.generate(D.designs.full, { maxStitches: n }), ref.full, 'exactly at the limit');
      for (const junk of [0, -1, NaN, Infinity, '5', null, Engine.LIMITS.maxStitches, Engine.LIMITS.maxStitches + 1]) sameResult(Engine.generate(D.designs.full, { maxStitches: junk }), ref.full, 'maxStitches ' + junk + ' is ignored');
      const log = newLog(), w = page({ Worker: fakeWorker({}, log) }).createClient(), m = Engine.createClient({ forceMainThread: true });
      assert.strictEqual(await w.ready, 'worker'); assert.strictEqual(await m.ready, 'main');
      for (const [label, c] of [['worker', w], ['main', m]]) {
        sameResult(await c.generate(D.designs.full, { maxStitches: n }), ref.full, label + ': exactly at the limit');
        const r = await c.generate(D.designs.full, { maxStitches: n - 1 });
        sameResult(r, over, label + ': one over the limit'); await rejects(c.export(r, { format: 'pes' }), 'TOO_MANY_STITCHES', label);
        sameResult(await c.generate(D.designs.full), ref.full, label + ': no option, the engine limit applies');
      }
      assert.strictEqual(w.mode, 'worker'); assert.strictEqual(log.created.length, 1, 'the refusals did not restart the worker');
      w.terminate(); m.terminate();
    });

    await t.test('client in a worker: stale requests resolve null; a superseded slow job is cancelled by restarting the worker', async () => {
      // quick worker, never cancel: the running job finishes, the one in the middle is dropped
      let log = newLog(), c = page({ Worker: fakeWorker({ workMs: 15 }, log) }).createClient({ cancelAfterMs: -1 });
      await c.ready;
      let [a, b, d] = await Promise.all([c.generate(D.designs.patch), c.generate(D.designs.full), c.generate(D.designs.testsew)]);
      sameResult(a, ref.patch, 'the running job'); assert.strictEqual(b, null); sameResult(d, ref.testsew, 'the newest job');
      assert.deepStrictEqual(log.posted, ['generate', 'generate']); assert.strictEqual(log.created.length, 1);
      c.terminate();
      // slow worker: the superseded job is cancelled, the waiting export is sent again, the newest job is answered
      log = newLog(); const modes = [];
      c = page({ Worker: fakeWorker({ workMs: 120 }, log) }).createClient({ cancelAfterMs: 20, onModeChange: m => modes.push(m) });
      await c.ready;
      const t0 = Date.now(), pa = c.generate(D.designs.full), pe = c.export(ref.patch, { format: 'pes6' });
      await sleep(5);
      const pb = c.generate(D.designs.patch), pd = c.generate(D.designs.testsew);
      assert.strictEqual(await pa, null, 'cancelled'); const cancelledAfter = Date.now() - t0;
      assert.ok(cancelledAfter < 110, 'cancelled after ' + cancelledAfter + ' ms, before the slow job could have finished');
      assert.strictEqual(await pb, null, 'never started');
      sameResult(await pd, ref.testsew, 'newest');
      assert.ok(sameBytes((await pe).bytes, Engine.export(ref.patch, { format: 'pes6' }).bytes), 'the export survived the restart');
      assert.strictEqual(log.created.length, 2); assert.strictEqual(log.terminated, 1); assert.strictEqual(c.mode, 'worker'); assert.deepStrictEqual(modes, ['worker']);
      c.terminate();
      // terminate while a job is running
      log = newLog(); c = page({ Worker: fakeWorker({ workMs: 60 }, log) }).createClient();
      await c.ready; const pr = c.generate(D.designs.patch), px = c.export(ref.patch); c.terminate();
      assert.strictEqual(await pr, null); await rejects(px, 'CLIENT_CLOSED'); await sleep(80);
    });

    await t.test('fallback: no worker, worker that cannot load, crashes or never starts -> main thread, no call lost', async () => {
      const check = async (label, behaviour, options, expectModes, expectCreated) => {
        const log = newLog(), modes = [];
        const E = behaviour === null ? page({}) : page({ Worker: fakeWorker(behaviour, log) });
        const c = E.createClient(Object.assign({ onModeChange: m => modes.push(m) }, options));
        // work asked for straight away, before anything is known about the worker
        const p1 = c.generate(D.designs.patch), pe = c.export(ref.badge, { format: 'pes', name: 'Badge' }), p2 = c.generate(D.designs.letters);
        const [r1, file, r2] = await Promise.all([p1, pe, p2]);
        assert.ok(r1 === null || strip(r1).totals.stitches === ref.patch.totals.stitches, label);
        sameResult(r2, ref.letters, label + ': newest generate'); assert.ok(sameBytes(file.bytes, Engine.export(ref.badge, { format: 'pes', name: 'Badge' }).bytes), label + ': export');
        assert.strictEqual(await c.ready, expectModes[0]); assert.strictEqual(c.mode, 'main', label); assert.deepStrictEqual(modes, expectModes, label);
        assert.strictEqual(log.created.length, expectCreated, label + ': workers started');
        for (const f of D.formats) assert.ok(sameBytes((await c.export(r2, { format: f })).bytes, Engine.export(ref.letters, { format: f }).bytes), label + ' ' + f);
        sameResult(await c.generate(D.designs.testsew), ref.testsew, label + ': later generate');
        assert.strictEqual(log.created.length, expectCreated, label + ': no further worker is started');
        assert.strictEqual(log.unhandled, 0, label + ': a late error from the dropped worker would reach the page');
        c.terminate();
      };
      await check('no Worker in this browser', null, {}, ['main'], 0);
      await check('new Worker throws (file://, CSP)', { throwOnConstruct: true }, {}, ['main'], 1);
      await check('worker script fails to load', { failToLoad: true }, {}, ['main'], 1);
      await check('worker never reports ready', { silent: true }, { readyTimeoutMs: 30 }, ['main'], 1);
      await check('worker crashes on the first job', { crashOn: 'generate' }, {}, ['worker', 'main'], 1);
      await check('worker crashes on an export', { crashOn: 'export' }, {}, ['worker', 'main'], 1);
      // a silent worker with readyTimeoutMs: 0 is waited for (documented), and terminate answers what is waiting
      const log = newLog(), c = page({ Worker: fakeWorker({ silent: true }, log) }).createClient({ readyTimeoutMs: 0 });
      const p = c.generate(D.designs.patch); await sleep(40); assert.strictEqual(c.mode, 'starting'); c.terminate();
      assert.strictEqual(await p, null); assert.strictEqual(await c.ready, 'closed');
    });
  },
};
