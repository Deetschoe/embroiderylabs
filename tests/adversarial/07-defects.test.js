#!/usr/bin/env node
/*
 * One minimal reproducing test per defect found by the adversarial suite. Each of these FAILED on the engine
 * as it was handed over and passes after the fix (see NOTES.md for how the old engine was run).
 *
 * D1  js/engine/embwriter.js  PES: a thread run of more than 65,535 stitches wrapped the 16-bit point count
 *                             of its CSewSeg section, so the PES part of the file said e.g. 4,465 points and
 *                             everything after it was read as garbage sections. (The PEC part, which the
 *                             machine sews from, was right; the PES part is what Brother's PC software reads.)
 * D2  js/engine/digitize.js   a fill with a legal stitch length over about 4.3 mm made stitches of up to 1.6
 *                             times that length (10.98 mm for the legal maximum of 7 mm) and warned
 *                             STITCH_TOO_LONG about a setting the API allows.
 */
'use strict';
const C = require('./lib/common.js');
const K = require('./lib/corpus.js');
const { Engine, D, OP, check, equal } = C;

const t = C.suite('regression tests for the defects found (D1, D2)');

/* ---------- D1 ---------- */
// the smallest realistic case: a dense fill in the common 130 x 180 mm (5 x 7 inch) hoop, one run of about 70,000 stitches
const d1 = { name: 'D1', hoop: { width: 130, height: 180 }, objects: [{ type: 'rect', x: 15, y: 20, width: 100, height: 140, color: '#224488', fill: { spacing: 0.2, stitchLength: 1 } }] };
const r1 = Engine.generate(d1);
function longestRun(ir) { let longest = 0, run = 0; const c = ir.commands; for (let i = 0; i < c.length; i += 3) { if (c[i] === OP.STITCH) { run++; if (run > longest) longest = run; } else run = 0; } return longest; }
function checkPes(res, fmt, label) {
  const f = Engine.export(res, { format: fmt }), d = D.decodePes(Buffer.from(f.bytes)), n = res.totals.stitches;
  equal(JSON.stringify(d.problems.slice(0, 3)), '[]', label + ': problems my decoder finds in the file');
  const secs = d.seg.sections.filter(s => s.flag === 0);
  for (const s of d.seg.sections) check(s.pts.length >= 1 && s.pts.length <= 65535, label + ': a section with ' + s.pts.length + ' points');
  // every stitch of the PEC stream is in the PES sections, in order (a continued section repeats the point it starts from)
  const mine = D.runsOf(d.ops), fb = C.runBounds(mine), want = [], got = [];
  for (const blk of mine.blocks) for (const r of blk) for (const v of r) want.push(v);
  for (const s of secs) for (const p of s.pts) { const x = p[0] + fb.minX, y = p[1] + fb.maxY, l = got.length; if (l && got[l - 2] === x && got[l - 1] === y) continue; got.push(x, y); }
  const squash = a => { const o = []; for (let i = 0; i < a.length; i += 2) if (!o.length || o[o.length - 2] !== a[i] || o[o.length - 1] !== a[i + 1]) o.push(a[i], a[i + 1]); return o; };
  const W = squash(want); equal(got.length, W.length, label + ': points in the PES sections vs the PEC stream');
  for (let i = 0; i < W.length; i++) if (W[i] !== got[i]) throw new Error(label + ': PES section point ' + (i >> 1) + ' differs from the PEC stream');
  equal(d.ops.filter(o => o[0] === 'S').length, n, label + ': stitches in the PEC stream');
  return { sections: secs.length, bytes: f.bytes.length };
}
t.test('D1 setup: the design has one thread run of more than 65,535 stitches', () => { check(r1.canExport, 'not exportable'); check(longestRun(r1.ir) > 65535, 'longest run is ' + longestRun(r1.ir)); });
for (const fmt of ['pes', 'pes6']) t.test('D1: ' + fmt + ' of a ' + longestRun(r1.ir) + '-stitch run has a readable PES section', () => { const o = checkPes(r1, fmt, fmt); check(o.sections >= 2, 'the run is in ' + o.sections + ' section'); });
// the boundary, on stitch data written by hand (API.md section 6: export needs only ir, warnings, canExport, name, totals)
function zigzag(n) {
  const cmds = [OP.JUMP, -400, -400]; let x = -400, y = -400;
  for (let i = 0; i < n; i++) { x = -400 + (i % 800 < 400 ? i % 400 : 400 - (i % 400)) * 2; y = -400 + ((i / 400) | 0) * 2 + (i % 2); cmds.push(OP.STITCH, x, y); }
  cmds.push(OP.TRIM, x, y, OP.END, x, y);
  return { ok: true, canExport: true, name: 'Run' + n, warnings: [], totals: { stitches: n }, ir: { units: '0.1mm', origin: 'hoop-centre', hoop: { w: 1000, h: 1000 }, threads: [{ color: '#000000' }], commands: Int32Array.from(cmds), bounds: { minX: -400, minY: -400, maxX: 400, maxY: 400 } } };
}
for (const [n, sections] of [[65535, 1], [65536, 2], [131069, 2], [131070, 3], [200000, 4]]) {
  for (const fmt of ['pes', 'pes6']) t.test('D1: a run of exactly ' + n + ' stitches -> ' + fmt + ' in ' + sections + ' section' + (sections > 1 ? 's' : ''), () => {
    let o; try { o = checkPes(zigzag(n), fmt, fmt + ' ' + n); } catch (e) { if (e && e.code) throw new Error('export refused: ' + e.code + ' ' + e.message); throw e; }
    equal(o.sections, sections, 'stitch sections');
  });
}
const py = C.pyRead({ 'd1.pes': Engine.export(r1, { format: 'pes' }).bytes, 'd1v6.pes': Engine.export(r1, { format: 'pes6' }).bytes });
if (!py) t.skip('D1: pyembroidery read-back', 'no python with pyembroidery');
else for (const k of ['d1.pes', 'd1v6.pes']) t.test('D1: pyembroidery still reads every stitch of ' + k, () => { check(py[k] && !py[k].error, 'unreadable: ' + (py[k] && py[k].error)); equal(py[k].cmds.split('S').length - 1, r1.totals.stitches, 'stitches'); });

/* ---------- D2 ---------- */
function sewn(ir) { // lengths of the sewn stitches (mm), from result.ir as API.md section 10 words it
  const c = ir.commands, out = []; let px = 0, py2 = 0, inRun = false;
  for (let i = 0; i < c.length; i += 3) { if (c[i] === OP.STITCH) { if (inRun) out.push(Math.hypot(c[i + 1] - px, c[i + 2] - py2) / 10); inRun = true; } else inRun = false; px = c[i + 1]; py2 = c[i + 2]; }
  return out;
}
const LIMIT = Engine.LIMITS.longStitchAbove; // 7 mm
for (const [shape, L, angle] of [['rect', 7, 30], ['U', 7, 30], ['comb', 7, 30], ['comb', 7, 0], ['circle', 7, 90], ['comb', 6, 45], ['U', 5, 17], ['donut', 4.5, 120]]) {
  const design = K.fillDesign(shape, 'default'); design.objects[0].fill = { stitchLength: L, angle };
  const r = Engine.generate(design), len = sewn(r.ir), longest = Math.max.apply(null, len);
  t.test('D2: ' + shape + ' filled with stitchLength ' + L + ' (angle ' + angle + '): no stitch over ' + LIMIT + ' mm, no warning about it', () => {
    check(r.canExport && r.totals.stitches > 20, 'nothing sewn');
    check(longest <= LIMIT + 0.05, 'longest sewn stitch is ' + longest.toFixed(2) + ' mm (' + len.filter(v => v > LIMIT + 0.05).length + ' stitches over the limit)');
    check(r.totals.longestStitchMm <= LIMIT + 0.05, 'totals.longestStitchMm is ' + r.totals.longestStitchMm);
    check(!r.warnings.some(w => w.code === 'STITCH_TOO_LONG'), 'STITCH_TOO_LONG for a stitch length the API allows');
    // the long stitch length is still used: a good share of the stitches is as long as asked (the engine sews 6.85 mm for anything above, see fillShape)
    const want = Math.min(L, LIMIT - 0.15), near = len.filter(v => Math.abs(v - want) <= 0.3).length;
    if (shape === 'rect' || shape === 'circle') check(near > 0.15 * len.length, 'only ' + near + ' of ' + len.length + ' stitches are about ' + want + ' mm long');
  });
}
// every fill angle at the legal maximum and just under it: snapping to the 0.1 mm grid must not push a stitch over the limit
t.test('D2: stitchLength 7, 6.95, 6.9 and 6.86 at every fill angle (720 fills): no stitch over ' + LIMIT + ' mm, no STITCH_TOO_LONG', () => {
  const bad = []; let worst = 0, n = 0;
  for (const L of [7, 6.95, 6.9, 6.86]) for (let a = 0; a < 180; a++) {
    const r = Engine.generate({ name: 'x', hoop: { width: 100, height: 100 }, objects: [{ type: 'polygon', points: [[20, 15], [80, 22], [85, 70], [50, 50], [18, 82]], color: '#000000', fill: { stitchLength: L, angle: a } }] });
    const longest = Math.max.apply(null, sewn(r.ir)); n++; if (longest > worst) worst = longest;
    if (longest > LIMIT + 0.05 || r.warnings.some(w => w.code === 'STITCH_TOO_LONG')) bad.push('L ' + L + ' angle ' + a + ': ' + longest.toFixed(2) + ' mm');
  }
  check(!bad.length, bad.length + ' of ' + n + ' fills, e.g. ' + bad.slice(0, 4).join('; '));
});
// running and bean lines at the legal maximum, in every direction
t.test('D2 (same question for lines): stitchLength 7 in 360 directions, running and bean: no stitch over ' + LIMIT + ' mm', () => {
  const bad = [];
  for (const type of ['running', 'bean']) for (let a = 0; a < 360; a++) {
    const r = Engine.generate({ name: 'x', hoop: { width: 100, height: 100 }, objects: [{ type: 'line', x1: 50.03, y1: 49.98, x2: 50 + 40 * Math.cos(a * Math.PI / 180), y2: 50 + 40 * Math.sin(a * Math.PI / 180), color: '#000000', line: { type, stitchLength: 7 } }] });
    const longest = Math.max.apply(null, sewn(r.ir));
    if (!(longest <= LIMIT + 0.05) || r.warnings.some(w => w.code === 'STITCH_TOO_LONG')) bad.push(type + ' ' + a + ' deg: ' + longest.toFixed(2) + ' mm');
  }
  check(!bad.length, bad.length + ' lines, e.g. ' + bad.slice(0, 4).join('; '));
});
module.exports = t.done();
