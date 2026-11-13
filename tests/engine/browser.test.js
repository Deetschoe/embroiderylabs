/*
 * The engine in a real browser: headless Chrome loads tests/engine/browser/worker-page.html from a local
 * static server (http, so a Web Worker can start) and once more from file:// (where it cannot).
 * Proves: the worker path and the main-thread path give the same bytes as node; the fallbacks work; the page
 * logs no errors. Needs Google Chrome; skipped with a message when it is not installed.
 *
 *   node tests/run.js --browser            (port 8106; --port=N or EMB_TEST_PORT to change, CHROME_PATH for the binary)
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..');
const Engine = require(path.join(REPO, 'js', 'engine', 'engine.js'));
const D = require('./designs.js');

const CHROME_CANDIDATES = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Static files from the repo root (GET only, nothing outside the root), plus POST /__result for the page's findings.
function startServer(port) {
  const requests = [], waiting = new Map(), results = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if (url.pathname === '/__result') {
      if (req.method === 'OPTIONS') { res.writeHead(204, Object.assign({ 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' }, cors)); res.end(); return; }
      if (req.method !== 'POST') { res.writeHead(405, cors); res.end(); return; }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        let data = null;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { data = { case: 'unreadable', failures: ['result was not JSON'] }; }
        res.writeHead(204, cors); res.end();
        const k = String(data.case);
        if (waiting.has(k)) { waiting.get(k)(data); waiting.delete(k); } else results.set(k, data);
      });
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405, cors); res.end(); return; }
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400, cors); res.end(); return; }
    const file = path.join(REPO, path.normalize('/' + rel));
    requests.push(rel);
    if (file !== REPO && !file.startsWith(REPO + path.sep)) { res.writeHead(403, cors); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, cors)); res.end('not found'); return; }
      res.writeHead(200, Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }, cors)); res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', e => reject(new Error('cannot listen on 127.0.0.1:' + port + ' (' + e.code + '). Another test run or server is using it; pass --port=N.')));
    server.listen(port, '127.0.0.1', () => resolve({
      server, requests,
      result: (k, ms) => new Promise((res, rej) => {
        if (results.has(k)) { res(results.get(k)); results.delete(k); return; }
        const timer = setTimeout(() => { waiting.delete(k); rej(new Error('the page did not report within ' + ms + ' ms')); }, ms);
        waiting.set(k, data => { clearTimeout(timer); res(data); });
      }),
      close: () => new Promise(res => { server.closeAllConnections && server.closeAllConnections(); server.close(() => res()); }),
    }));
  });
}

// Opens one URL in headless Chrome, waits for the page's report, closes Chrome. -> { data, console: [lines] }
async function openInChrome(chrome, url, wait) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'emblabs-chrome-'));
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--metrics-recording-only', '--user-data-dir=' + profile, '--enable-logging=stderr', '--v=0', url], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', c => { stderr += c; });
  const exited = new Promise(res => child.once('exit', res));
  try {
    const data = await Promise.race([wait(), exited.then(() => { throw new Error('Chrome exited before the page reported. stderr: ' + stderr.slice(-600)); })]);
    await new Promise(r => setTimeout(r, 150)); // let the last console lines reach stderr
    return { data, console: stderr.split('\n').filter(l => /:CONSOLE\(/.test(l)) };
  } finally {
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise(r => setTimeout(r, 3000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { /* Chrome may still be letting go of it */ }
  }
}

module.exports = {
  name: 'browser: Web Worker and fallback in headless Chrome',
  async run(t) {
    const chrome = CHROME_CANDIDATES.find(p => p && fs.existsSync(p));
    if (!chrome) { t.skip('worker and fallback in headless Chrome', 'Google Chrome not found; set CHROME_PATH'); return; }
    const port = Number(t.opts.port || process.env.EMB_TEST_PORT || 8106);
    const base = 'http://127.0.0.1:' + port, pageUrl = base + '/tests/engine/browser/worker-page.html';
    const srv = await startServer(port);

    // what node says the bytes are
    const want = {}, results = {};
    for (const k of D.compare) {
      const r = results[k] = Engine.generate(D.designs[k]);
      want[k + '.ir'] = D.hash(new Uint8Array(r.ir.commands.buffer));
      for (const f of D.formats) { const file = Engine.export(r, { format: f, name: D.exportNames[k] }); want[k + '.' + f] = D.hash(file.bytes); want[k + '.' + f + '.filename'] = file.filename; }
    }
    const checkHashes = (data, label, names) => {
      let n = 0;
      for (const k of names) for (const suffix of ['ir'].concat(D.formats, D.formats.map(f => f + '.filename'))) {
        assert.strictEqual(data.hashes[label + ':' + k + '.' + suffix], want[k + '.' + suffix], label + ' ' + k + '.' + suffix + ' differs from node');
        if (D.formats.includes(suffix)) n++;
      }
      return n;
    };
    const quiet = (r, what) => {
      assert.deepStrictEqual(r.data.failures, [], what + ': the page found differences');
      assert.deepStrictEqual(r.data.errors, [], what + ': errors on the page');
      const bad = r.console.filter(l => /:(ERROR|WARNING):CONSOLE\(/.test(l));
      assert.deepStrictEqual(bad, [], what + ': console errors or warnings');
      assert.strictEqual(r.data.done, true);
    };

    try {
      await t.test('http: worker path and main-thread path give the same bytes as node, with zero console errors', async () => {
        const r = await openInChrome(chrome, pageUrl + '?case=main', () => srv.result('main', 90000)), c = r.data.checks;
        quiet(r, 'main page');
        assert.strictEqual(r.data.protocol, 'http:'); assert.strictEqual(c.workerMode, 'worker'); assert.strictEqual(c.mainMode, 'main'); assert.deepStrictEqual(c.modes, ['worker']);
        assert.strictEqual(c.files, D.compare.length * D.formats.length * 2); assert.strictEqual(c.identical, c.files, 'worker and main-thread files identical to the direct call');
        const n = checkHashes(r.data, 'worker', D.compare) + checkHashes(r.data, 'main', D.compare);
        assert.strictEqual(n, c.files);
        // the worker really was a separate script fetched over http, and it loaded the engine itself
        for (const f of ['worker.js', 'embwriter.js', 'digitize.js', 'engine.js']) assert.ok(srv.requests.filter(p => p === '/js/engine/' + f).length >= (f === 'worker.js' ? 1 : 2), f + ' requested by the page and by the worker');
        assert.strictEqual(c.stale[1], null, 'the generate in the middle was dropped'); assert.strictEqual(c.stale[2], 'Test sew'); assert.ok(c.stale[0] === 'Patch' || c.stale[0] === null);
        assert.deepStrictEqual(c.progressLast, [12, 12]); assert.ok(c.progressCalls >= 1);
        assert.deepStrictEqual([c.unknownFormat, c.emptyDesign, c.invalidResult], ['UNKNOWN_FORMAT', 'EMPTY_DESIGN', 'INVALID_RESULT']);
        // a slow design inside the stitch limit: same stitches as node on both paths, the page keeps running during the worker job
        const slowNode = Engine.generate(D.designs.slow), slowHash = D.hash(new Uint8Array(slowNode.ir.commands.buffer));
        assert.strictEqual(c.slowStitches, slowNode.totals.stitches); assert.ok(c.slowStitches > Engine.LIMITS.largeDesign && c.slowStitches < Engine.LIMITS.maxStitches);
        assert.strictEqual(r.data.hashes['worker:slow.ir'], slowHash); assert.strictEqual(r.data.hashes['main:slow.ir'], slowHash); assert.strictEqual(c.slowSameFacts, true);
        assert.ok(c.slowCodes.includes('LARGE_DESIGN') && !c.slowCodes.includes('TOO_MANY_STITCHES'), 'warnings of the slow design: ' + c.slowCodes);
        assert.ok(c.ticksDuringWorkerJob >= 5, 'the page kept running during a ' + r.data.timings.slowWorkerMs + ' ms worker job: ' + c.ticksDuringWorkerJob + ' timer ticks');
        assert.ok(c.ticksDuringMainJob <= 2, 'the same job on the main thread blocks the page (' + c.ticksDuringMainJob + ' ticks)');
        assert.strictEqual(c.cancelled, true); assert.strictEqual(c.newestAfterCancel, true); assert.strictEqual(c.modeAfterCancel, 'worker');
        assert.ok(r.data.timings.newestAfterCancelMs < r.data.timings.slowWorkerMs, 'newest answer after ' + r.data.timings.newestAfterCancelMs + ' ms, the cancelled job alone takes ' + r.data.timings.slowWorkerMs + ' ms');
        // the stitch limit: the 1.9-million-stitch design is refused identically by the worker and on the main thread
        const refusedNode = Engine.generate(D.designs.heavy).warnings.find(x => x.code === 'TOO_MANY_STITCHES');
        assert.strictEqual(c.refusedSame, true, 'worker, main-thread client and direct call give the same refusal');
        for (const [name, x] of [['worker', c.refusedWorker], ['main', c.refusedMain]]) {
          const label = name + ' ' + JSON.stringify(x);
          assert.deepStrictEqual(x.codes, ['TOO_MANY_STITCHES'], label); assert.strictEqual(x.limit, Engine.LIMITS.maxStitches, label);
          // the count reached is an estimate made from unrounded numbers: it may differ by a stitch or two between JavaScript engines
          assert.ok(Math.abs(x.stitches - refusedNode.stitches) <= 50, label + ' vs node ' + refusedNode.stitches);
          assert.ok(x.stitches > x.limit && x.stitches < x.limit * 1.2, label + ': count reached ' + x.stitches);
          assert.strictEqual(x.message, refusedNode.message, label);
          assert.deepStrictEqual([x.ok, x.canExport, x.totalStitches, x.irLength, x.skipped, x.exportCode], [false, false, 0, 3, true, 'TOO_MANY_STITCHES'], label);
          assert.ok(x.ms < 1000, label + ': refused after ' + x.ms + ' ms');
          assert.ok(x.heapMb < 300, label + ': the page heap grew by ' + x.heapMb + ' MB');
        }
        for (const label of ['worker', 'main']) {
          const x = c.limitOption[label];
          assert.deepStrictEqual([x.atStitches, x.atCanExport, x.atSame], [c.fullCount, true, true], label + ': maxStitches equal to the count');
          assert.deepStrictEqual([x.underCodes, x.underLimit, x.underExport], [['TOO_MANY_STITCHES'], c.fullCount - 1, 'TOO_MANY_STITCHES'], label + ': maxStitches one under the count');
          assert.ok(x.underStitches >= c.fullCount, label + ': count reached ' + x.underStitches);
        }
        t.note('stitch limit in Chrome', '1.9 million stitch design refused by the worker in ' + c.refusedWorker.ms + ' ms (' + c.refusedWorker.ticks + ' page timer ticks, page heap ' + c.refusedWorker.heapMb + ' MB), on the main thread in ' + c.refusedMain.ms + ' ms (page heap +' + c.refusedMain.heapMb + ' MB); count reached ' + c.refusedWorker.stitches);
        assert.strictEqual(c.silentMode, 'main'); assert.strictEqual(c.silentSame, true);
        assert.deepStrictEqual(c.closed, ['closed', 'closed', 'CLIENT_CLOSED']);
        const tm = r.data.timings, ua = /Chrome\/[\d.]+/.exec(r.data.userAgent);
        t.note('browser', (ua ? ua[0] : 'Chrome') + ' headless, http://127.0.0.1:' + port);
        t.note('worker vs main thread', n + ' files identical to node (' + D.compare.length + ' designs x ' + D.formats.length + ' formats x 2 paths), console errors: 0');
        t.note('worker round trip (generate + 4 exports)', D.compare.map(k => k + ' ' + tm['worker ' + k] + ' ms').join(', '));
        t.note('slow design (' + c.slowStitches + ' stitches)', 'worker ' + tm.slowWorkerMs + ' ms with ' + c.ticksDuringWorkerJob + ' page timer ticks; main thread ' + tm.slowMainMs + ' ms with ' + c.ticksDuringMainJob +'; superseded job cancelled, newest answer after ' + tm.newestAfterCancelMs + ' ms');
      });

      await t.test('http: a worker script that is missing, throws or crashes falls back to the main thread without losing a call', async () => {
        const r = await openInChrome(chrome, pageUrl + '?case=badworker', () => srv.result('badworker', 60000)), c = r.data.checks;
        assert.deepStrictEqual(r.data.failures, []); assert.strictEqual(r.data.done, true);
        for (const k of ['missing', 'throwing', 'crashing']) {
          assert.strictEqual(c[k].mode, 'main', k); assert.strictEqual(c[k].identical, D.formats.length, k); assert.strictEqual(c[k].earlyExport, true, k);
          assert.strictEqual(checkHashes(r.data, k, ['badge']), D.formats.length);
        }
        assert.deepStrictEqual(c.missing.modes, ['main']); assert.deepStrictEqual(c.throwing.modes, ['main']); assert.deepStrictEqual(c.crashing.modes, ['worker', 'main']);
        assert.deepStrictEqual(r.data.errors, [], 'the broken workers raise no error on the page itself');
        t.note('broken workers', 'missing, throwing and crashing worker scripts: all three finished on the main thread with identical bytes');
      });

      await t.test('file://: no worker can start, the main thread gives the same bytes', async () => {
        const url = pathToFileURL(path.join(__dirname, 'browser', 'worker-page.html')).href + '?case=file&report=' + encodeURIComponent(base + '/__result');
        const r = await openInChrome(chrome, url, () => srv.result('file', 60000)), c = r.data.checks;
        assert.deepStrictEqual(r.data.failures, []); assert.deepStrictEqual(r.data.errors, []); assert.strictEqual(r.data.done, true);
        assert.strictEqual(r.data.protocol, 'file:'); assert.strictEqual(c.mode, 'main');
        assert.strictEqual(c.identical, 2 * D.formats.length); assert.strictEqual(checkHashes(r.data, 'file', ['patch', 'testsew']), 2 * D.formats.length);
        t.note('file://', 'client mode "' + c.mode + '" (' + (c.modeAtOnce === 'main' ? 'worker refused at construction' : 'worker failed to load') + '), 8 files identical to node');
      });
    } finally {
      await srv.close();
    }
    await t.test('the test server is stopped', () => new Promise((resolve, reject) => {
      const probe = http.get(base + '/', res => { res.resume(); reject(new Error('something still answers on ' + base)); });
      probe.on('error', () => resolve());
    }));
  },
};
