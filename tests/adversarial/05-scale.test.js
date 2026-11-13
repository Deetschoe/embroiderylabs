#!/usr/bin/env node
/*
 * ATTACK 5: scale, and the worker path in a real browser.
 *
 * Part 1 (node): the largest common hoop filled as densely as the API allows, and other large designs, each
 * in a process of its own (time and peak memory are that case's alone). Every file is decoded by
 * lib/decoders.js and read by stock pyembroidery.
 *
 * Part 2 (headless Chrome): browser/worker-stress.html drives Engine.createClient with bursts, superseded
 * slow requests, exports during a restart, a design that cannot be cloned, terminate and a missing worker
 * script. The page is served by a server started here on 127.0.0.1:8107 (ADV_PORT; never 8000) and closed
 * again before the suite ends. Files made in the browser are compared with node's by SHA-256.
 *
 *   ADV_NO_BROWSER=1   skip part 2        (the 1000 mm hoop, 4.9 and 9.8 million stitches, is always run now:
 *                                         the engine refuses it at LIMITS.maxStitches, so it costs a fraction of a second)
 *   ADV_ONLY_BROWSER=1 skip part 1        ADV_CHROME_LOG=<file>   keep Chrome's own log
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const C = require('./lib/common.js');
const SD = require('./browser/stress-designs.js');
const { Engine, check, equal } = C;

const PORT = Number(process.env.ADV_PORT || 8107);
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHILD = path.join(__dirname, 'lib', 'scale-child.js');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

function runChild(name, dir, raw) {
  const r = spawnSync(process.execPath, [CHILD, name, dir].concat(raw ? ['raw'] : []), { encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 26 });
  if (r.error || r.status !== 0) return { case: name, crashed: (r.error && r.error.message) || ('exit ' + r.status + ' signal ' + r.signal + ': ' + String(r.stderr).slice(-400)) };
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { return { case: name, crashed: 'no report: ' + r.stdout.slice(-200) }; }
}

/* ---------- part 2: own static server + headless Chrome ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
function browserRun(profileDir, timeoutMs) {
  return new Promise(resolve => {
    if (PORT === 8000) return resolve({ skipped: 'port 8000 belongs to the owner; refusing to use it' });
    if (!fs.existsSync(CHROME)) return resolve({ skipped: 'Google Chrome not found at ' + CHROME });
    let chrome = null, timer = null, finished = false; const requests = [];
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      if (req.method === 'POST' && url === '/__report') {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => { res.writeHead(204); res.end(); let rep; try { rep = JSON.parse(body); } catch (e) { rep = { fatal: 'unreadable report' }; } finish({ report: rep, requests }); });
        return;
      }
      if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
      const file = path.normalize(path.join(C.REPO, url));
      requests.push(url);
      // read-only, and only the engine and this folder's page
      const allowed = (file.startsWith(path.join(C.REPO, 'js', 'engine') + path.sep) || file.startsWith(path.join(__dirname, 'browser') + path.sep)) && TYPES[path.extname(file)];
      if (!allowed || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-store' }); fs.createReadStream(file).pipe(res);
    });
    function finish(out) {
      if (finished) return; finished = true; clearTimeout(timer);
      if (chrome) { try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) { try { chrome.kill('SIGKILL'); } catch (e2) { /* gone */ } } }
      server.close(() => resolve(out)); if (server.closeAllConnections) server.closeAllConnections();
    }
    server.on('error', e => { finished = true; resolve({ skipped: 'could not listen on 127.0.0.1:' + PORT + ' (' + e.code + ')' }); });
    server.listen(PORT, '127.0.0.1', () => {
      chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--user-data-dir=' + profileDir].concat(process.env.ADV_CHROME_LOG ? ['--enable-logging=stderr', '--v=0'] : []).concat(['http://127.0.0.1:' + PORT + '/tests/adversarial/browser/worker-stress.html']), { stdio: process.env.ADV_CHROME_LOG ? ['ignore', 'ignore', fs.openSync(process.env.ADV_CHROME_LOG, 'a')] : 'ignore', detached: true });
      chrome.on('error', e => finish({ skipped: 'Chrome did not start: ' + e.message }));
      timer = setTimeout(() => finish({ timedOut: true, requests }), timeoutMs);
    });
  });
}

async function main() {
  const dir = C.tmpDir('scale');
  const names = process.env.ADV_ONLY_BROWSER ? [] : ['dense200x300', 'default200x300', 'denseEllipse', 'grid300', 'tooLarge', 'hoop1000', 'hoop1000twice', 'tiny'];
  const runs = {}, rawRuns = {};
  for (const n of names) runs[n] = runChild(n, dir, false);
  for (const n of names.filter(x => x === 'dense200x300' || x === 'hoop1000')) rawRuns[n] = runChild(n, dir, true);
  const files = {};
  for (const f of fs.readdirSync(dir)) if (/\.(pes|pec|dst)$/.test(f)) files[f] = fs.readFileSync(path.join(dir, f));
  const py = C.pyRead(files, { timeout: 600000 });
  const browser = process.env.ADV_NO_BROWSER ? { skipped: 'ADV_NO_BROWSER is set' } : await browserRun(path.join(dir, "chrome-profile"), 150000);
  C.rm(dir);

  const t = C.suite('attack 5: scale (hundreds of thousands of stitches) and the worker in a real browser');
  if (!py) t.skip('pyembroidery read-back of the large files', 'no python with pyembroidery');

  for (const n of names) {
    const r = runs[n];
    t.test(n + ': generated without a crash, in reasonable time and memory', () => {
      check(!r.crashed, 'the process died: ' + r.crashed); check(!r.generateError, 'generate threw: ' + r.generateError);
      equal(r.validate, 0, 'Engine.validate violations');
      check(r.ms < (n === 'hoop1000' ? 60000 : 10000), 'generate took ' + Math.round(r.ms) + ' ms');
      check(r.maxRssMb < (n === 'hoop1000' ? 6000 : 1500), 'peak memory ' + r.maxRssMb + ' MB');
    });
    if (r.crashed || r.generateError) continue;
    if (n === 'tooLarge') {
      t.test(n + ': a fill over the 400,000-stitch limit is refused cleanly and at once', () => {
        check(r.codes.includes('TOO_LARGE:warning'), 'no TOO_LARGE warning: ' + r.codes); equal(r.canExport, false, 'canExport'); equal(r.stitches, 0, 'stitches');
        check(r.ms < 2000, 'took ' + Math.round(r.ms) + ' ms');
      });
      continue;
    }
    if (n === 'hoop1000' || n === 'hoop1000twice') {
      // F4: 4.9 (9.8) million stitches used to be generated (2.7 GB in node, out of memory in a browser tab)
      t.test(n + ': a design over the total stitch limit is refused with TOO_MANY_STITCHES, in well under a second, without a memory spike', () => {
        equal(JSON.stringify(r.codes.filter(c => /:error$/.test(c))), '["TOO_MANY_STITCHES:error"]', 'blocking warnings'); equal(r.canExport, false, 'canExport'); equal(r.stitches, 0, 'stitches'); equal(r.irStitches, 0, 'stitches in the IR');
        equal(r.limit.limit, Engine.LIMITS.maxStitches, 'limit in the warning'); check(r.limit.stitches > r.limit.limit && r.limit.stitches < r.limit.limit * 1.7, 'count reached: ' + r.limit.stitches);
        check(r.ms < 1000, 'took ' + Math.round(r.ms) + ' ms');
        const base = runs.tiny;
        check(!base.crashed && r.maxRssMb < base.maxRssMb + 250, 'peak memory ' + r.maxRssMb + ' MB; a one-square design in the same kind of process peaks at ' + base.maxRssMb + ' MB');
      });
      continue;
    }
    if (n === 'tiny') continue;
    t.test(n + ': exportable, stitch counts agree', () => {
      equal(r.canExport, true, 'canExport'); equal(r.irStitches, r.stitches, 'stitches in the IR vs totals');
      if (n.startsWith('dense') || n === 'grid300') check(r.stitches > 200000, 'only ' + r.stitches + ' stitches');
    });
    for (const fmt of SD.formats) {
      const f = r.files[fmt] || {};
      t.test(n + ' ' + fmt + ': written, well formed by the spec, every stitch there', () => {
        check(!f.error, 'export failed: ' + f.error);
        equal(JSON.stringify(f.problems), '[]', 'decoder problems'); equal(f.decodedStitches, r.stitches, 'stitches my decoder finds');
        check(f.ms < (n === 'hoop1000' ? 60000 : 5000), 'export took ' + Math.round(f.ms) + ' ms');
        // a thread run longer than 65,535 stitches cannot be one PES section (defect D1)
        if (fmt.startsWith('pes') && r.longestRun > 65535) check(f.sections > r.threads, 'a run of ' + r.longestRun + ' stitches in ' + f.sections + ' sections');
      });
      const key = n + '__' + fmt + '.' + (fmt === 'pes6' ? 'pes' : fmt);
      if (py && n !== 'hoop1000') t.test(key + ': pyembroidery reads every stitch', () => {
        const p = py[key]; check(p && !p.error, 'pyembroidery could not read it: ' + (p && p.error)); check(!p.nan, 'NaN');
        equal(p.cmds.split('S').length - 1, r.stitches, 'stitches pyembroidery finds');
        equal(p.cmds[p.cmds.length - 1], 'E', 'last command'); equal(p.cmds.split('C').length - 1 + p.cmds.split('P').length - 1, r.threads - 1, 'colour changes');
      });
    }
  }
  for (const n of Object.keys(runs)) { const r = runs[n], w = rawRuns[n]; if (!r.crashed) t.note(n + ': ' + r.stitches + ' stitches, generate ' + Math.round(r.ms) + ' ms' + (r.files.pes ? ', PES ' + (r.files.pes.bytes / 1048576).toFixed(2) + ' MB in ' + Math.round(r.files.pes.ms) + ' ms' : '') + (w && !w.crashed ? ', engine peak memory ' + w.maxRssMb + ' MB' : '')); }

  /* ---------- browser ---------- */
  if (browser.skipped) { t.skip('worker path in headless Chrome', browser.skipped); return t.done(); }
  const rep = browser.report || { tests: [] };
  t.test('browser: the page finished and reported', () => {
    check(!browser.timedOut, 'no report from the page in time; it asked for ' + JSON.stringify(browser.requests));
    check(!rep.fatal, rep.fatal); check(rep.tests.length >= 18, 'only ' + rep.tests.length + ' page tests ran');
    check(browser.requests.includes('/js/engine/worker.js'), 'the worker script was never asked for');
  });
  for (const p of rep.tests) t.test('browser: ' + p.name, () => check(p.ok, p.error));
  t.test('browser: nothing on the console, no page errors', () => {
    const errs = (rep.errors || []).slice(0, rep.expectedErrorsFrom < 0 ? undefined : rep.expectedErrorsFrom);
    equal(JSON.stringify(errs), '[]', 'errors before the missing-worker test');
  });
  const ident = (rep.tests.find(p => /same in the worker/.test(p.name)) || {}).info;
  if (ident) for (const k of Object.keys(SD.identity)) {
    t.test('browser vs node: ' + k + ' gives the same stitches and the same files', () => {
      const r = Engine.generate(SD.identity[k]), b = ident[k]; check(b, 'the page did not report it');
      equal(b.ir, sha(Buffer.from(r.ir.commands.buffer, r.ir.commands.byteOffset, r.ir.commands.byteLength)), 'SHA-256 of ir.commands'); equal(b.canExport, r.canExport, 'canExport');
      for (const fmt of SD.formats) {
        if (!r.canExport) { check(b.files[fmt] && b.files[fmt].refused, fmt + ': the browser made a file of a design node refuses'); continue; }
        const f = Engine.export(r, { format: fmt });
        equal(b.files[fmt] && b.files[fmt].sha, sha(Buffer.from(f.bytes)), fmt + ' SHA-256'); equal(b.files[fmt].filename, f.filename, fmt + ' filename');
      }
    });
  }
  for (const p of rep.tests) if (p.ok && p.info && Object.keys(p.info).length && !/same in the worker/.test(p.name)) t.note('browser: ' + p.name + ' -> ' + JSON.stringify(p.info) + ' (' + p.ms + ' ms)');
  if (rep.expectedErrorsFrom >= 0 && rep.errors.length > rep.expectedErrorsFrom) t.note('browser: logged by the missing-worker test (expected): ' + JSON.stringify(rep.errors.slice(rep.expectedErrorsFrom)).slice(0, 300));
  if (rep.modeChanges && rep.modeChanges.length !== 1) t.note('browser: the long-lived client changed mode: ' + JSON.stringify(rep.modeChanges));
  t.note('browser: ' + (rep.ua || '').replace(/^.*(HeadlessChrome\/[\d.]+).*$/, '$1') + ', engine ' + rep.engine + ', served on 127.0.0.1:' + PORT + ' (closed again)');
  return t.done();
}
module.exports = main();
