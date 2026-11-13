/*
 * Shared plumbing of the adversarial suite: a tiny test harness, the engine through its PUBLIC entry point only
 * (require of js/engine/engine.js, as js/engine/API.md section 1 says), a view of result.ir written from API.md
 * section 10, and the bridge to lib/pyread.py. No helper of tests/engine/ is used.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..', '..');
// ADV_ENGINE_DIR: another copy of js/engine (used once to show that 07-defects fails on the engine as it was before the fixes)
const Engine = require(path.join(process.env.ADV_ENGINE_DIR || path.join(REPO, 'js', 'engine'), 'engine.js'));
const D = require('./decoders.js');

/* ---------- harness ---------- */
function suite(name) {
  const s = { name, passed: 0, failed: 0, skipped: 0, failures: [], notes: [], cases: 0 };
  s.test = (title, fn) => {
    s.cases++;
    try { fn(); s.passed++; if (process.env.ADV_VERBOSE) console.log('  ok   ' + title); }
    catch (e) { s.failed++; s.failures.push({ title, message: String(e && e.message || e) }); console.log('  FAIL ' + title + '\n       ' + String(e && e.message || e).split('\n').join('\n       ')); }
  };
  s.skip = (title, why) => { s.skipped++; console.log('  skip ' + title + ': ' + why); };
  s.note = m => { s.notes.push(m); console.log('  note ' + m); };
  s.done = () => {
    console.log(name + ': ' + s.passed + ' passed, ' + s.failed + ' failed, ' + s.skipped + ' skipped');
    if (require.main && require.main.filename && path.basename(require.main.filename) !== 'run.js') process.exitCode = s.failed ? 1 : 0;
    return s;
  };
  console.log('\n== ' + name);
  return s;
}
function check(cond, message) { if (!cond) throw new Error(typeof message === 'function' ? message() : message); }
function equal(a, b, what) { if (a !== b) throw new Error(what + ': got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); }

/* ---------- scratch folder ---------- */
function tmpDir(tag) {
  const base = process.env.ADV_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'adv-' + tag + '-'));
}
function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

/* ---------- python ---------- */
let pyCache;
function python() {
  if (pyCache !== undefined) return pyCache;
  const p = process.env.EMB_PYTHON || path.join(REPO, 'venv', 'bin', 'python');
  if (!fs.existsSync(p)) return (pyCache = null);
  try { execFileSync(p, ['-B', '-c', 'import pyembroidery'], { stdio: 'pipe', timeout: 30000 }); } catch (e) { return (pyCache = null); }
  return (pyCache = p);
}
// files: { 'name.pes': Uint8Array } -> report.files of lib/pyread.py, or null when there is no python
function pyRead(files, opts) {
  const py = python(); if (!py) return null;
  const dir = tmpDir('py');
  try {
    for (const k of Object.keys(files)) fs.writeFileSync(path.join(dir, k), files[k]);
    const out = path.join(dir, 'report.json'), args = ['-B', path.join(__dirname, 'pyread.py'), dir, out];
    if (opts && opts.points) args.push('--points');
    execFileSync(py, args, { stdio: 'pipe', timeout: (opts && opts.timeout) || 300000, maxBuffer: 1 << 26 });
    return JSON.parse(fs.readFileSync(out, 'utf8')).files;
  } finally { rm(dir); }
}
// pyread record -> { blocks: [[run]], cmds } in the same shape as decoders.runsOf
function pyRuns(rec) {
  const blocks = [[]]; let run = null;
  for (let i = 0; i < rec.cmds.length; i++) {
    const c = rec.cmds[i];
    if (c === 'S') { if (!run) { run = []; blocks[blocks.length - 1].push(run); } run.push(rec.xy[2 * i], rec.xy[2 * i + 1]); }
    else if (c === 'C' || c === 'P') { run = null; blocks.push([]); }
    else if (c === 'E') break;
    else run = null;
  }
  return { blocks };
}

/* ---------- result.ir, read as API.md section 10 words it ---------- */
const OP = { STITCH: 0, JUMP: 1, TRIM: 2, COLOR_CHANGE: 3, END: 4 };
// -> { blocks: [[run]] (0.1 mm, origin hoop centre), ops: count per op, bounds, order: 'JSSTC..' }
function irRuns(ir) {
  const c = ir.commands, blocks = [[]], counts = [0, 0, 0, 0, 0]; let run = null, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < c.length; i += 3) {
    const op = c[i], x = c[i + 1], y = c[i + 2]; counts[op]++;
    if (op === OP.STITCH) { if (!run) { run = []; blocks[blocks.length - 1].push(run); } run.push(x, y); if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    else if (op === OP.COLOR_CHANGE) { run = null; blocks.push([]); }
    else run = null;
  }
  return { blocks, counts, bounds: minX === Infinity ? null : { minX, minY, maxX, maxY } };
}
// design millimetres of an IR point (API.md section 10)
const irMm = (ir, x, y) => [(x + Math.round(ir.hoop.w / 2)) / 10, (y + Math.round(ir.hoop.h / 2)) / 10];

/*
 * Compare two run models that may differ by one constant offset (the file is centred on the design).
 * -> { same: bool, why, dx, dy }
 */
function sameRuns(a, b, opts) {
  opts = opts || {};
  if (a.blocks.length !== b.blocks.length) return { same: false, why: 'colour blocks ' + a.blocks.length + ' vs ' + b.blocks.length };
  let dx = null, dy = null;
  for (let k = 0; k < a.blocks.length; k++) {
    const ra = a.blocks[k], rb = b.blocks[k];
    if (ra.length !== rb.length) return { same: false, why: 'block ' + k + ': ' + ra.length + ' vs ' + rb.length + ' thread runs' };
    for (let r = 0; r < ra.length; r++) {
      const p = ra[r], q = rb[r];
      if (p.length !== q.length) return { same: false, why: 'block ' + k + ' run ' + r + ': ' + p.length / 2 + ' vs ' + q.length / 2 + ' stitches' };
      for (let i = 0; i < p.length; i += 2) {
        if (dx === null) { dx = q[i] - p[i]; dy = q[i + 1] - p[i + 1]; if (opts.noOffset && (dx || dy)) return { same: false, why: 'offset ' + dx + ',' + dy + ' where none is allowed' }; }
        if (q[i] - p[i] !== dx || q[i + 1] - p[i + 1] !== dy) return { same: false, why: 'block ' + k + ' run ' + r + ' stitch ' + i / 2 + ': (' + p[i] + ',' + p[i + 1] + ') vs (' + q[i] + ',' + q[i + 1] + '), offset so far ' + dx + ',' + dy };
      }
    }
  }
  return { same: true, dx: dx || 0, dy: dy || 0 };
}
function runBounds(model) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
  for (const b of model.blocks) for (const r of b) for (let i = 0; i < r.length; i += 2) { n++; if (r[i] < minX) minX = r[i]; if (r[i] > maxX) maxX = r[i]; if (r[i + 1] < minY) minY = r[i + 1]; if (r[i + 1] > maxY) maxY = r[i + 1]; }
  return n ? { minX, minY, maxX, maxY, n } : null;
}

// every NaN / Infinity / undefined number in a plain object tree -> list of paths
function nonFinite(v, at, out, seen) {
  out = out || []; at = at || 'result'; seen = seen || new Set();
  if (typeof v === 'number') { if (!Number.isFinite(v)) out.push(at + ' = ' + v); return out; }
  if (!v || typeof v !== 'object' || seen.has(v)) return out;
  seen.add(v);
  if (ArrayBuffer.isView(v)) { for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) { out.push(at + '[' + i + '] = ' + v[i]); break; } return out; }
  if (Array.isArray(v)) { for (let i = 0; i < v.length && out.length < 20; i++) nonFinite(v[i], at + '[' + i + ']', out, seen); return out; }
  for (const k of Object.keys(v)) { if (out.length >= 20) break; nonFinite(v[k], at + '.' + k, out, seen); }
  return out;
}

module.exports = { REPO, Engine, D, OP, suite, check, equal, tmpDir, rm, python, pyRead, pyRuns, irRuns, irMm, sameRuns, runBounds, nonFinite };
