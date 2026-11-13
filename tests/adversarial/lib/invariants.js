/*
 * What js/engine/API.md promises for EVERY result and every exported file, written as checks from the text of
 * that document (sections 5, 6 and 10), not from the engine source. Each function returns a list of
 * violations; an empty list means the promise held.
 */
'use strict';
const D = require('./decoders.js');

const SEVERITY = {
  EMPTY_DESIGN: 'error', OUTSIDE_HOOP: 'error', EXCEEDS_HOOP: 'error', NON_FINITE_INPUT: 'warning', INVALID_OBJECT: 'warning', INVALID_HOOP: 'warning',
  INVALID_COLOR: 'info', TINY_OBJECT: 'warning', THIN_FILL: 'info', OPEN_PATH_NOT_FILLED: 'warning', SATIN_TOO_WIDE: 'warning', SATIN_TOO_NARROW: 'info',
  STITCH_TOO_LONG: 'warning', TOO_DENSE: 'warning', TOO_LARGE: 'warning', PARAM_CLAMPED: 'info', INTERNAL_ERROR: 'warning',
  /* added with the stitch-limit and Brother palette guards (see 08-guards.test.js and the table in js/engine/API.md) */
  TOO_MANY_STITCHES: 'error', LARGE_DESIGN: 'warning', COLORS_MERGED: 'warning', COLOR_SUBSTITUTED: 'info',
};
const EXPORT_ERRORS = ['UNKNOWN_FORMAT', 'INVALID_RESULT', 'EMPTY_DESIGN', 'OUTSIDE_HOOP', 'EXCEEDS_HOOP', 'NOT_EXPORTABLE', 'INVALID_IR', 'TOO_MANY_COLORS'];
const OP = { STITCH: 0, JUMP: 1, TRIM: 2, COLOR_CHANGE: 3, END: 4 };
const FORMATS = [['pes', 'pes'], ['pes6', 'pes'], ['pec', 'pec'], ['dst', 'dst']];

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

// result.ir by the rules of API.md section 10 -> { bad: [], runs: [[x, y, ...]] per colour block, counts, bounds, longest }
function readIr(ir) {
  const bad = [], add = m => { if (bad.length < 12) bad.push(m); };
  const out = { bad, blocks: [[]], counts: [0, 0, 0, 0, 0], bounds: null, longest: 0, zero: 0, over: 0, lockless: 0, runs: 0 };
  if (!ir || typeof ir !== 'object') { add('result.ir is missing'); return out; }
  const c = ir.commands;
  if (!(c instanceof Int32Array)) { add('ir.commands is not an Int32Array'); return out; }
  if (c.length % 3) add('ir.commands length ' + c.length + ' is not a multiple of 3');
  if (ir.units !== '0.1mm' || ir.origin !== 'hoop-centre') add('ir.units / ir.origin differ from the documented values');
  if (!ir.hoop || !Number.isFinite(ir.hoop.w) || !Number.isFinite(ir.hoop.h)) add('ir.hoop is not { w, h }');
  let state = 'idle', run = null, jx = 0, jy = 0, afterTrim = false, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, ended = false;
  const closeRun = () => {
    if (!run) return;
    out.runs++;
    const n = run.length / 2;
    if (n < 2) add('a thread run of ' + n + ' stitch');
    // lock stitches: the run goes out and comes straight back to its first point, and does the same at its last point
    const lockOk = (a, b, c2) => run[2 * a] === run[2 * c2] && run[2 * a + 1] === run[2 * c2 + 1] && Math.hypot(run[2 * a] - run[2 * b], run[2 * a + 1] - run[2 * b + 1]) <= 10;
    if (n < 5 || !lockOk(0, 1, 2) || !lockOk(n - 1, n - 2, n - 3)) out.lockless++;
    run = null;
  };
  for (let i = 0; i + 2 < c.length; i += 3) {
    const op = c[i], x = c[i + 1], y = c[i + 2];
    if (ended) { add('command after END at ' + i / 3); break; }
    if (op < 0 || op > 4) { add('unknown op ' + op + ' at ' + i / 3); continue; }
    out.counts[op]++;
    if (op === OP.JUMP) { if (state !== 'idle') add('JUMP inside a thread run at ' + i / 3); closeRun(); state = 'jumped'; jx = x; jy = y; afterTrim = false; }
    else if (op === OP.STITCH) {
      if (state === 'idle') add('STITCH without a JUMP before it at ' + i / 3);
      if (state === 'jumped') { if (x !== jx || y !== jy) add('first STITCH of a run is not at the JUMP point at ' + i / 3); run = [x, y]; out.blocks[out.blocks.length - 1].push(run); state = 'sewing'; }
      else if (run) {
        const l = Math.hypot(x - run[run.length - 2], y - run[run.length - 1]);
        if (l === 0) out.zero++; if (l > 121) out.over++; if (l > out.longest) out.longest = l;
        run.push(x, y);
      }
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      afterTrim = false;
    }
    else if (op === OP.TRIM) { if (state !== 'sewing') add('TRIM that does not end a thread run at ' + i / 3); closeRun(); state = 'idle'; afterTrim = true; }
    else if (op === OP.COLOR_CHANGE) { if (!afterTrim) add('COLOR_CHANGE that does not follow a TRIM at ' + i / 3); out.blocks.push([]); afterTrim = false; }
    else if (op === OP.END) { if (state !== 'idle') add('END inside a thread run'); ended = true; }
  }
  if (!ended) add('no END');
  if (out.counts[OP.END] !== 1) add('END appears ' + out.counts[OP.END] + ' times');
  if (minX !== Infinity) out.bounds = { minX, minY, maxX, maxY };
  return out;
}

// -> violations of API.md section 5 for generate(design)
function checkResult(design, r, Engine) {
  const v = [], add = m => { if (v.length < 25) v.push(m); };
  if (!r || typeof r !== 'object') return ['generate returned ' + (r === null ? 'null' : typeof r)];
  // `id` is documented as "any, echoed back" (API.md section 4), so a NaN id coming back is the caller's own value
  for (const m of nonFinite(r)) if (!/\.(id|objectId) = /.test(m)) add('not finite: ' + m);
  if (typeof r.ok !== 'boolean' || r.ok !== r.canExport) add('ok / canExport: ' + r.ok + ' / ' + r.canExport);
  if (typeof r.name !== 'string') add('name is ' + typeof r.name);
  if (!r.hoop || !(r.hoop.width >= 10 && r.hoop.width <= 1000 && r.hoop.height >= 10 && r.hoop.height <= 1000)) add('hoop ' + JSON.stringify(r.hoop));
  if (r.version !== '1.0.0') add('version ' + r.version);
  if (!(r.timeMs >= 0)) add('timeMs ' + r.timeMs);
  if (!Array.isArray(r.warnings)) { add('warnings is not an array'); return v; }
  for (const w of r.warnings) {
    if (!w || !(w.code in SEVERITY)) { add('undocumented warning code ' + (w && w.code)); continue; }
    if (w.severity !== SEVERITY[w.code]) add(w.code + ' has severity ' + w.severity + ', documented ' + SEVERITY[w.code]);
    if (typeof w.message !== 'string' || !w.message.trim() || /NaN|\[object|Infinity mm|null mm|undefined mm/.test(w.message)) add(w.code + ' has an unusable message: ' + JSON.stringify(w.message));
  }
  const hasError = r.warnings.some(w => w.severity === 'error');
  if (r.canExport !== !hasError) add('canExport ' + r.canExport + ' with' + (hasError ? '' : 'out') + ' an error warning');
  const ir = readIr(r.ir);
  for (const m of ir.bad) add('ir: ' + m);
  const T = r.totals || {}, n = ir.counts;
  if (!Array.isArray(r.threads)) add('threads is not an array');
  else {
    if (r.threads.length !== (r.ir && r.ir.threads ? r.ir.threads.length : -1)) add('threads ' + r.threads.length + ' vs ir.threads');
    if (n[0] && ir.blocks.length !== r.threads.length) add('colour blocks in the ir ' + ir.blocks.length + ' vs threads ' + r.threads.length);
    let sum = 0;
    r.threads.forEach((t, i) => {
      if (!/^#[0-9a-f]{6}$/.test(t.color)) add('thread ' + i + ' colour ' + t.color);
      if (!(t.stitches > 0)) add('thread ' + i + ' has ' + t.stitches + ' stitches'); sum += t.stitches;
      const own = (ir.blocks[i] || []).reduce((a, run) => a + run.length / 2, 0);
      if (own !== t.stitches) add('thread ' + i + ' reports ' + t.stitches + ' stitches, the ir has ' + own);
      if (i && t.color === r.threads[i - 1].color) add('threads ' + (i - 1) + ' and ' + i + ' are the same colour ' + t.color + ' (a colour change to the same thread)');
    });
    if (sum !== T.stitches) add('sum of thread stitches ' + sum + ' vs totals.stitches ' + T.stitches);
    if (T.colors !== r.threads.length) add('totals.colors ' + T.colors);
    if (T.colorChanges !== Math.max(0, r.threads.length - 1)) add('totals.colorChanges ' + T.colorChanges + ' for ' + r.threads.length + ' threads');
  }
  if (T.stitches !== n[0]) add('totals.stitches ' + T.stitches + ' vs ' + n[0] + ' STITCH commands');
  if (T.jumps !== n[1]) add('totals.jumps ' + T.jumps + ' vs ' + n[1] + ' JUMP commands');
  if (T.trims !== n[2]) add('totals.trims ' + T.trims + ' vs ' + n[2] + ' TRIM commands');
  if (n[3] !== Math.max(0, (r.threads || []).length - 1)) add(n[3] + ' COLOR_CHANGE commands for ' + (r.threads || []).length + ' threads');
  if (Math.abs((T.longestStitchMm || 0) - ir.longest / 10) > 0.051) add('totals.longestStitchMm ' + T.longestStitchMm + ' vs ' + (ir.longest / 10).toFixed(2) + ' measured');
  if (ir.over) add(ir.over + ' sewn stitches longer than 12.1 mm (longest ' + (ir.longest / 10).toFixed(2) + ' mm)');
  if (ir.zero) add(ir.zero + ' zero-length stitches');
  if (ir.lockless) add(ir.lockless + ' of ' + ir.runs + ' thread runs do not start and end with lock stitches');
  if (Array.isArray(design && design.objects)) {
    if (!Array.isArray(r.objects) || r.objects.length !== design.objects.length) add('objects has ' + (r.objects && r.objects.length) + ' entries for ' + design.objects.length + ' design objects');
    else { let s = 0; r.objects.forEach((o, i) => { if (o.index !== i) add('objects[' + i + '].index = ' + o.index); if (typeof o.skipped !== 'boolean') add('objects[' + i + '].skipped is not boolean'); if (o.skipped && o.stitches) add('objects[' + i + '] is skipped but has stitches'); s += o.stitches; }); if (s !== T.stitches) add('sum of objects[].stitches ' + s + ' vs totals.stitches ' + T.stitches); }
  }
  if (!n[0]) {
    if (r.bounds !== null) add('bounds is not null for a design without stitches');
    if (!r.warnings.some(w => w.code === 'EMPTY_DESIGN')) add('no stitches and no EMPTY_DESIGN');
  } else if (!r.bounds) add('bounds is null although there are stitches');
  else {
    const hw = Math.round(r.ir.hoop.w / 2), hh = Math.round(r.ir.hoop.h / 2), b = ir.bounds, mm = { minX: (b.minX + hw) / 10, minY: (b.minY + hh) / 10, maxX: (b.maxX + hw) / 10, maxY: (b.maxY + hh) / 10 };
    for (const k of Object.keys(mm)) if (Math.abs(mm[k] - r.bounds[k]) > 0.051) add('bounds.' + k + ' = ' + r.bounds[k] + ', the stitches say ' + mm[k]);
    const outside = mm.minX < -0.001 || mm.minY < -0.001 || mm.maxX > r.hoop.width + 0.001 || mm.maxY > r.hoop.height + 0.001;
    if (outside && r.canExport) add('stitches outside the hoop but canExport is true: ' + JSON.stringify(mm) + ' in ' + JSON.stringify(r.hoop));
    if (!outside && r.warnings.some(w => w.code === 'OUTSIDE_HOOP' || w.code === 'EXCEEDS_HOOP')) add('hoop error although every stitch is inside the hoop: ' + JSON.stringify(mm));
  }
  if (Engine) { let val; try { val = Engine.validate(r); } catch (e) { val = ['validate threw ' + e.message]; } if (!Array.isArray(val) || val.length) add('Engine.validate: ' + JSON.stringify(val).slice(0, 200)); }
  return v;
}

// exports in every format; -> { violations, files: { 'pes': bytes, ... } }
function checkExports(r, Engine, name) {
  const v = [], add = m => { if (v.length < 25) v.push(m); }, files = {};
  const ir = readIr(r && r.ir);
  for (const [fmt, ext] of FORMATS) {
    let f = null, err = null;
    try { f = Engine.export(r, name === undefined ? { format: fmt } : { format: fmt, name }); } catch (e) { err = e; }
    if (!r || !r.canExport) {
      if (!err) add(fmt + ': export of a result that cannot be exported did not throw');
      else if (EXPORT_ERRORS.indexOf(err.code) < 0 || typeof err.message !== 'string' || !err.message) add(fmt + ': export threw an undocumented error: ' + err.code + ' ' + (err.stack || err.message).split('\n').slice(0, 2).join(' | '));
      continue;
    }
    if (err) { if (err.code !== 'TOO_MANY_COLORS' || r.threads.length <= 255) add(fmt + ': export threw ' + err.code + ' ' + (err.stack || err.message).split('\n').slice(0, 2).join(' | ')); continue; }
    if (!(f.bytes instanceof Uint8Array)) { add(fmt + ': bytes is not a Uint8Array'); continue; }
    if (!new RegExp('^[A-Za-z0-9 _-]{1,60}\\.' + ext + '$').test(f.filename)) add(fmt + ': filename ' + JSON.stringify(f.filename));
    if (typeof f.label !== 'string' || !/^[\x20-\x7e]+$/.test(f.label) || !f.label.trim()) add(fmt + ': label ' + JSON.stringify(f.label));
    if (f.mime !== 'application/octet-stream' || f.format !== fmt) add(fmt + ': mime / format fields');
    if (f.stitches !== ir.counts[0]) add(fmt + ': file.stitches ' + f.stitches + ' vs ' + ir.counts[0]);
    const buf = Buffer.from(f.bytes), d = fmt === 'dst' ? D.decodeDst(buf) : fmt === 'pec' ? D.decodePec(buf) : D.decodePes(buf);
    for (const p of d.problems.slice(0, 3)) add(fmt + ': ' + p);
    const mine = D.runsOf(d.ops);
    // run by run, stitch by stitch, one constant offset
    let dx = null, dy = null, why = null;
    if (mine.blocks.length !== ir.blocks.length) why = 'colour blocks ' + mine.blocks.length + ' vs ' + ir.blocks.length;
    for (let k = 0; !why && k < ir.blocks.length; k++) {
      if (ir.blocks[k].length !== mine.blocks[k].length) { why = 'block ' + k + ': thread runs ' + mine.blocks[k].length + ' vs ' + ir.blocks[k].length; break; }
      for (let q = 0; !why && q < ir.blocks[k].length; q++) {
        const a = ir.blocks[k][q], b = mine.blocks[k][q];
        if (a.length !== b.length) { why = 'block ' + k + ' run ' + q + ': ' + b.length / 2 + ' vs ' + a.length / 2 + ' stitches'; break; }
        for (let i = 0; i < a.length; i += 2) { if (dx === null) { dx = b[i] - a[i]; dy = b[i + 1] - a[i + 1]; } if (b[i] - a[i] !== dx || b[i + 1] - a[i + 1] !== dy) { why = 'block ' + k + ' run ' + q + ' stitch ' + i / 2 + ' is displaced'; break; } }
      }
    }
    if (why) add(fmt + ': file differs from the ir: ' + why);
    files[fmt] = f.bytes;
  }
  return { violations: v, files };
}

module.exports = { SEVERITY, EXPORT_ERRORS, OP, FORMATS, nonFinite, readIr, checkResult, checkExports };
