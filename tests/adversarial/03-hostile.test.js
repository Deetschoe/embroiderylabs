#!/usr/bin/env node
/*
 * ATTACK 3: hostile input through the public API.
 *
 * Every case of lib/hostile-cases.js and a few hundred seeded random designs go through Engine.generate and
 * Engine.export in a CHILD process (lib/child.js) with a watchdog: a case that runs longer than the limit is
 * reported as a hang, the child is killed and the rest continues in a new child. For every case the child checks
 * what js/engine/API.md promises (lib/invariants.js); here every exported file is additionally read by stock
 * pyembroidery, which must agree on stitch count, colour changes and size.
 *
 *   ADV_FUZZ=<n>   number of random designs (default 300)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const C = require('./lib/common.js');
const HC = require('./lib/hostile-cases.js');

const LIMIT_MS = 30000;          // one case may not take longer than this (a hang)
const SLOW_MS = 8000;            // reported, not failed
const FUZZ = Number(process.env.ADV_FUZZ || 300);
const t = C.suite('attack 3: hostile input (' + Object.keys(HC.cases).length + ' cases + ' + FUZZ + ' random designs)');

function runChild(outDir, mode, from, to, records) {
  return new Promise(resolve => {
    const ch = spawn(process.execPath, ['--max-old-space-size=4096', path.join(__dirname, 'lib', 'child.js'), outDir, mode, String(from), String(to)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', err = '', current = null, startedAt = 0, done = 0, killed = false;
    const watchdog = setInterval(() => { if (current && Date.now() - startedAt > LIMIT_MS) { killed = true; ch.kill('SIGKILL'); } }, 250);
    ch.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let o; try { o = JSON.parse(line); } catch (e) { continue; }
        if (o.start !== undefined) { current = o.start; startedAt = Date.now(); }
        else if (o.done !== undefined) { records.push(o); current = null; done++; }
      }
    });
    ch.stderr.on('data', d => { if (err.length < 4000) err += d; });
    ch.on('close', code => { clearInterval(watchdog); resolve({ done, hung: killed ? current : null, crashed: !killed && current !== null ? current : null, code, err }); });
  });
}
async function runAll(outDir, mode, from, to, records) {
  let at = from;
  while (at < to) {
    const r = await runChild(outDir, mode, at, to, records);
    at += r.done;
    if (r.hung !== null) { records.push({ done: r.hung, violations: ['HANG: no result after ' + LIMIT_MS / 1000 + ' s; the child process had to be killed'], hang: true }); at++; }
    else if (r.crashed !== null) { records.push({ done: r.crashed, violations: ['CRASH of the whole process (exit ' + r.code + '): ' + r.err.split('\n').slice(0, 4).join(' | ')] }); at++; }
    else if (at < to && !r.done) { records.push({ done: mode + ' ' + at, violations: ['the child stopped without running the case: ' + r.err.slice(0, 300)] }); at++; }
  }
}

module.exports = (async () => {
  const outDir = C.tmpDir('hostile'), records = [];
  try {
    await runAll(outDir, '--cases', 0, Object.keys(HC.cases).length, records);
    await runAll(outDir, '--fuzz', 1, FUZZ + 1, records);

    let py = null;
    if (C.python()) {
      const out = path.join(outDir, 'report.json');
      execFileSync(C.python(), ['-B', path.join(__dirname, 'lib', 'pyread.py'), outDir, out], { stdio: 'pipe', timeout: 900000, maxBuffer: 1 << 26 });
      py = JSON.parse(fs.readFileSync(out, 'utf8')).files;
    } else t.skip('pyembroidery read-back of the exported files', 'no python with pyembroidery');

    let files = 0, exported = 0, refused = 0, slow = [];
    const codes = {}, sameColour = { files: 0, cases: new Set() };
    for (const rec of records) {
      t.test(rec.done, () => {
        const v = rec.violations.slice();
        if (rec.ms > SLOW_MS) slow.push(rec.done + ' ' + (rec.ms / 1000).toFixed(1) + ' s');
        for (const c of rec.codes || []) codes[c] = (codes[c] || 0) + 1;
        if (rec.canExport) exported++; else if (rec.canExport === false) refused++;
        for (const name of rec.files || []) {
          files++;
          if (!py) continue;
          const p = py[name], fmt = name.split('__')[1];
          if (!p || p.error) { v.push(fmt + ': pyembroidery cannot read the file: ' + (p && p.error)); continue; }
          if (p.nan) v.push(fmt + ': NaN in the pyembroidery read-back');
          // pyembroidery's PES v1 / PEC readers report a colour change between two blocks that carry the SAME
          // palette byte as a STOP ('P'). The file still holds one FE B0 per change (lib/decoders.js counts
          // them in the child); it means the machine shows the same colour twice in a row. Counted and noted.
          const s = p.cmds.split('S').length - 1, stops = p.cmds.split('P').length - 1, cc = p.cmds.split('C').length - 1 + stops;
          if (stops) { sameColour.files++; sameColour.cases.add(rec.done); }
          if (s !== rec.stitches) v.push(fmt + ': pyembroidery reads ' + s + ' stitches, the result has ' + rec.stitches);
          if (cc !== rec.threads - 1) v.push(fmt + ': pyembroidery reads ' + cc + ' colour changes for ' + rec.threads + ' threads');
          if (p.cmds[p.cmds.length - 1] !== 'E') v.push(fmt + ': pyembroidery does not see END last');
          if (!p.bounds || p.bounds[2] - p.bounds[0] !== rec.size[0] || p.bounds[3] - p.bounds[1] !== rec.size[1]) v.push(fmt + ': pyembroidery size ' + JSON.stringify(p.bounds) + ' vs ' + JSON.stringify(rec.size));
          if (p.bounds && (Math.abs(p.bounds[0] + p.bounds[2]) > 1 || Math.abs(p.bounds[1] + p.bounds[3]) > 1)) v.push(fmt + ': not centred: ' + JSON.stringify(p.bounds));
        }
        if (v.length) throw new Error(v.join('\n'));
      });
    }
    t.note(records.length + ' cases; ' + exported + ' exportable, ' + refused + ' refused with an error; ' + files + ' files' + (py ? ' read by pyembroidery' : ''));
    t.note('warning codes seen: ' + Object.keys(codes).sort().map(k => k + ' x' + codes[k]).join(', '));
    if (sameColour.files) t.note('OPEN finding F3: ' + sameColour.files + ' PES v1 / PEC files give two consecutive colour blocks the same Brother colour (no warning from the engine): ' + Array.from(sameColour.cases).slice(0, 6).join('; '));
    if (slow.length) t.note('slow cases (over ' + SLOW_MS / 1000 + ' s): ' + slow.join('; '));
  } finally { C.rm(outDir); }
  return t.done();
})();
