/*
 * Runs hostile cases in a separate process so that a hang or a crash of the engine cannot take the test
 * runner with it.
 *
 *   node child.js <outDir> --cases <from> <to>      cases of lib/hostile-cases.js by position
 *   node child.js <outDir> --fuzz <from> <to>       seeded random designs
 *
 * One JSON line on stdout before each case ({"start": key}) and one after it ({"done": key, ...}); both are
 * written synchronously, so the parent always knows which case was running when it had to kill the child.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Engine = require(path.join(__dirname, '..', '..', '..', 'js', 'engine', 'engine.js'));
const I = require('./invariants.js');
const HC = require('./hostile-cases.js');

const say = o => fs.writeSync(1, JSON.stringify(o) + '\n');

// a fingerprint that tells NaN from null and undefined from missing (JSON cannot)
function fingerprint(v) {
  let h = 2166136261 >>> 0, n = 0;
  const mix = s => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } };
  const seen = new Set();
  (function walk(x) {
    if (++n > 3e6) return;
    const t = typeof x;
    if (x === null) return mix('N');
    if (t === 'number') return mix('n' + (Object.is(x, -0) ? '-0' : String(x)));
    if (t !== 'object') return mix(t[0] + String(x));
    if (seen.has(x)) return mix('@'); seen.add(x);
    if (Array.isArray(x)) { mix('[' + x.length); for (let i = 0; i < x.length; i++) { if (!(i in x)) mix('_'); else walk(x[i]); } return mix(']'); }
    mix('{'); for (const k of Object.keys(x)) { mix(k + ':'); walk(x[k]); } mix('}');
  })(v);
  return h + ':' + n;
}

function runCase(key, build, outDir, tag) {
  say({ start: key });
  const rec = { done: key, tag, violations: [] }, add = m => { if (rec.violations.length < 30) rec.violations.push(m); };
  let design;
  try { design = build(); } catch (e) { rec.violations.push('TEST BUG: the case builder threw ' + e.message); say(rec); return; }
  const before = fingerprint(design), t0 = Date.now();
  let r = null;
  try { r = Engine.generate(design); } catch (e) { add('generate THREW: ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join(' | ')); }
  rec.ms = Date.now() - t0;
  if (fingerprint(design) !== before) add('generate modified the design it was given');
  if (r) {
    for (const m of I.checkResult(design, r, Engine)) add(m);
    rec.stitches = r.totals && r.totals.stitches; rec.threads = r.threads && r.threads.length; rec.canExport = r.canExport;
    rec.codes = Array.isArray(r.warnings) ? Array.from(new Set(r.warnings.map(w => w && w.code))) : [];
    rec.longest = r.totals && r.totals.longestStitchMm;
    const b = I.readIr(r.ir).bounds; rec.size = b ? [b.maxX - b.minX, b.maxY - b.minY] : null;
    // the same design must give the same stitches
    if (rec.ms < 4000) {
      let r2 = null; try { r2 = Engine.generate(build()); } catch (e) { add('second generate threw ' + e.message); }
      if (r2 && r2.ir && r.ir && r.ir.commands && r2.ir.commands) {
        const a = r.ir.commands, c = r2.ir.commands; let same = a.length === c.length;
        for (let i = 0; same && i < a.length; i++) if (a[i] !== c[i]) same = false;
        if (!same) add('the same design gave different stitches the second time');
        if (JSON.stringify(r.warnings) !== JSON.stringify(r2.warnings)) add('the same design gave different warnings the second time');
      }
    }
    let ex; try { ex = I.checkExports(r, Engine, design && typeof design === 'object' ? design.name : undefined); } catch (e) { add('TEST BUG or export crash: ' + (e.stack || e).toString().split('\n').slice(0, 3).join(' | ')); }
    if (ex) {
      for (const m of ex.violations) add(m);
      rec.files = [];
      for (const [fmt, ext] of I.FORMATS) if (ex.files[fmt]) { const name = tag + '__' + fmt + '.' + ext; fs.writeFileSync(path.join(outDir, name), ex.files[fmt]); rec.files.push(name); }
    }
  }
  rec.total = Date.now() - t0;
  say(rec);
}

const [outDir, mode, from, to] = process.argv.slice(2);
if (mode === '--cases') { const keys = Object.keys(HC.cases); for (let i = +from; i < Math.min(+to, keys.length); i++) runCase(keys[i], HC.cases[keys[i]], outDir, 'c' + i); }
else if (mode === '--fuzz') { for (let s = +from; s < +to; s++) runCase('fuzz seed ' + s, () => HC.fuzz(s), outDir, 'f' + s); }
else { console.error('usage: child.js <outDir> --cases|--fuzz <from> <to>'); process.exit(2); }
