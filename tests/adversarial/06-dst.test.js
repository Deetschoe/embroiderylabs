#!/usr/bin/env node
/*
 * ATTACK 6: the DST export of the same designs.
 *
 *   - the DST holds exactly the stitches of the PES of the same result (own decoders, and pyembroidery reading
 *     both files): same runs, same points, same colour blocks
 *   - header: ST / CO / extents / AX / AY describe the records
 *   - the 12.1 mm limit: no record moves more than 121 units on an axis; stitches of exactly 12.1 mm survive
 *     unchanged; a long move is cut into jump records that add up exactly; stitch data that holds a longer
 *     stitch is refused instead of being clipped
 *   - every gap between two thread runs carries the trim signature, and pyembroidery reads a TRIM there
 */
'use strict';
const C = require('./lib/common.js');
const K = require('./lib/corpus.js');
const { Engine, D, check, equal } = C;
const OP = C.OP;

const t = C.suite('attack 6: DST export (same stitches as the PES, 12.1 mm limit)');

const cases = [];
for (const k of Object.keys(K.designs)) cases.push({ key: k, design: K.designs[k] });
for (const [s, f] of [['U', 'long'], ['comb', 'long'], ['star5', 'loose'], ['donut', 'a45'], ['spiral', 'short'], ['twoHoles', 'bigPull'], ['islands', 'default'], ['E', 'a90']]) cases.push({ key: 'fill_' + s + '_' + f, design: K.fillDesign(s, f) });
// satin columns at the widest the API allows, in every direction: the swing is over 12.1 mm before it is split
cases.push({ key: 'satin12', design: { name: 'Satin 12', hoop: { width: 130, height: 180 }, objects: [0, 30, 45, 60, 90, 135].map((a, i) => ({ type: 'line', x1: 65 - 40 * Math.cos(a * Math.PI / 180), y1: 20 + i * 28 - 8 * Math.sin(a * Math.PI / 180), x2: 65 + 40 * Math.cos(a * Math.PI / 180), y2: 20 + i * 28 + 8 * Math.sin(a * Math.PI / 180), color: i % 2 ? '#aa0000' : '#0000aa', line: { type: 'satin', width: 12 } })) } });
// running stitches at the longest length the API allows
cases.push({ key: 'run7', design: { name: 'Run 7', hoop: { width: 200, height: 200 }, objects: [{ type: 'polyline', points: [[5, 5], [195, 20], [5, 40], [195, 195], [100, 100]], color: '#000000', line: { type: 'running', stitchLength: 7 } }, { type: 'line', x1: 5, y1: 190, x2: 190, y2: 150, color: '#000000', line: { type: 'bean', stitchLength: 7 } }] } });

const files = {};
for (const c of cases) {
  c.result = Engine.generate(c.design);
  if (!c.result.canExport) continue;
  c.dst = Engine.export(c.result, { format: 'dst' }); c.pes = Engine.export(c.result, { format: 'pes' });
  files[c.key + '.dst'] = c.dst.bytes; files[c.key + '.pes'] = c.pes.bytes;
}
const py = C.pyRead(files, { points: true });
if (!py) t.skip('pyembroidery read-back', 'no python with pyembroidery');

let records = 0, longestRecord = 0, longestStitch = 0, gaps = 0;
for (const c of cases) {
  const r = c.result;
  t.test(c.key + ': exports', () => check(r.canExport, 'not exportable: ' + JSON.stringify(r.warnings.map(w => w.code))));
  if (!r.canExport) continue;
  const buf = Buffer.from(c.dst.bytes), d = D.decodeDst(buf), mine = D.runsOf(d.ops), pes = D.runsOf(D.decodePes(Buffer.from(c.pes.bytes)).ops), N = r.threads.length;
  t.test(c.key + '.dst: the same stitches as the PES of the same design', () => {
    equal(d.problems.length, 0, 'decoder problems ' + JSON.stringify(d.problems.slice(0, 3)));
    const cmp = C.sameRuns(pes, mine, { noOffset: true });
    check(cmp.same, 'DST differs from PES: ' + cmp.why);
    const ir = C.sameRuns(C.irRuns(r.ir), mine);
    check(ir.same, 'DST differs from the result: ' + ir.why);
    equal(C.runBounds(mine).n, r.totals.stitches, 'needle penetrations');
    equal(c.dst.filename.slice(-4), '.dst', 'file name extension');
  });
  t.test(c.key + '.dst: header counts and the 12.1 mm limit per record', () => {
    const h = d.header, n = { S: 0, J: 0, T: 0, C: 0, E: 0 };
    let x = 0, y = 0, gapHasTrim = true, sawStitch = false, trimSince = false, moved = false;
    for (const o of d.ops) {
      n[o[0]]++;
      const dx = Math.abs(o[1] - x), dy = Math.abs(o[2] - y);
      if (Math.max(dx, dy) > longestRecord) longestRecord = Math.max(dx, dy);
      check(dx <= 121 && dy <= 121, 'a record moves (' + (o[1] - x) + ', ' + (o[2] - y) + ') units');
      if (o[0] === 'S') {
        const len = Math.hypot(o[1] - x, o[2] - y) / 10;
        if (sawStitch && !moved) { if (len > longestStitch) longestStitch = len; check(len <= 12.1 + 1e-9, 'a sewn stitch of ' + len.toFixed(2) + ' mm'); }
        if (sawStitch && moved) { gaps++; if (!trimSince) gapHasTrim = false; }
        sawStitch = true; moved = false; trimSince = false;
      } else if (o[0] === 'T') trimSince = true;
      else if (o[0] === 'J' || o[0] === 'C') moved = true;
      x = o[1]; y = o[2];
    }
    records += d.records;
    check(gapHasTrim, 'a move between two thread runs without the trim signature before it');
    equal(Number(h.CO), N - 1, 'CO'); equal(n.C, N - 1, 'colour change records'); equal(n.E, 1, 'END records');
    // ST counts the entries of the stitch list: every stitch, jump, colour change, trim (once) and END
    equal(Number(h.ST), n.S + n.J + n.T + n.C + n.E, 'ST');
    equal(d.records, n.S + n.J + 3 * n.T + n.C + n.E, 'records in the file');
    const fb = C.runBounds(mine);
    equal(Number(h['+X']) + Number(h['-X']), fb.maxX - fb.minX, '+X plus -X'); equal(Number(h['+Y']) + Number(h['-Y']), fb.maxY - fb.minY, '+Y plus -Y');
  });
  if (py) t.test(c.key + '.dst: pyembroidery reads the same stitches from the DST and from the PES', () => {
    const a = py[c.key + '.dst'], b = py[c.key + '.pes'];
    check(a && !a.error, 'pyembroidery cannot read the DST: ' + (a && a.error)); check(b && !b.error, 'pyembroidery cannot read the PES: ' + (b && b.error));
    const ra = C.pyRuns(a), rb = C.pyRuns(b), cmp = C.sameRuns(rb, ra, { noOffset: true });
    check(cmp.same, 'pyembroidery: DST differs from PES: ' + cmp.why);
    equal(a.cmds.split('C').length - 1, N - 1, 'colour changes in the DST');
    equal(a.cmds[a.cmds.length - 1], 'E', 'last command');
    // a TRIM wherever the thread run ends inside a colour
    const runsInDst = ra.blocks.reduce((s, blk) => s + blk.length, 0), trims = a.cmds.split('T').length - 1;
    check(trims >= runsInDst - N, 'pyembroidery reads ' + trims + ' trims for ' + (runsInDst - N) + ' moves inside colour blocks');
  });
}
t.note(cases.length + ' designs, ' + records + ' DST records; longest record ' + (longestRecord / 10).toFixed(1) + ' mm on an axis, longest sewn stitch ' + longestStitch.toFixed(2) + ' mm');

/* ---------- the limit itself, on stitch data written by hand (API.md section 6: export needs only ir, warnings, canExport, name, totals) ---------- */
function handMade(points, extra) {
  // points: [[x, y]] one thread run, 0.1 mm, origin hoop centre; extra: further runs
  const cmds = [], runs = [points].concat(extra || []); let n = 0;
  for (const run of runs) { cmds.push(OP.JUMP, run[0][0], run[0][1]); for (const p of run) { cmds.push(OP.STITCH, p[0], p[1]); n++; } const l = run[run.length - 1]; cmds.push(OP.TRIM, l[0], l[1]); }
  const last = runs[runs.length - 1][runs[runs.length - 1].length - 1]; cmds.push(OP.END, last[0], last[1]);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const run of runs) for (const p of run) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  return { ok: true, canExport: true, name: 'Hand', warnings: [], totals: { stitches: n }, ir: { units: '0.1mm', origin: 'hoop-centre', hoop: { w: 3000, h: 3000 }, threads: [{ color: '#000000' }], commands: Int32Array.from(cmds), bounds: { minX, minY, maxX, maxY } } };
}
const tryExport = (res, format) => { try { return { file: Engine.export(res, { format }) }; } catch (e) { return { error: e }; } };

// stitches at and just under the limit, in every direction
const steps = [[121, 0], [-121, 0], [0, 121], [0, -121], [85, 86], [-86, 85], [120, 15], [15, -120], [121, 1], [1, 1], [40, 41], [-41, -40], [13, 14], [-14, 4], [5, -1], [100, 68]];
{
  const pts = [[0, 0]]; for (const s of steps) { const l = pts[pts.length - 1]; pts.push([l[0] + s[0], l[1] + s[1]]); }
  const legal = steps.filter(s => Math.hypot(s[0], s[1]) <= 121);
  const ptsLegal = [[0, 0]]; for (const s of legal) { const l = ptsLegal[ptsLegal.length - 1]; ptsLegal.push([l[0] + s[0], l[1] + s[1]]); }
  const res = handMade(ptsLegal), out = tryExport(res, 'dst');
  t.test('hand-made run with stitches of exactly 12.1 mm and every size class below: DST keeps every point', () => {
    check(!out.error, 'export refused legal stitch data: ' + (out.error && (out.error.code + ' ' + out.error.message)));
    const d = D.decodeDst(Buffer.from(out.file.bytes)), mine = D.runsOf(d.ops);
    equal(d.problems.length, 0, 'decoder problems ' + JSON.stringify(d.problems));
    const cmp = C.sameRuns(C.irRuns(res.ir), mine); check(cmp.same, cmp.why);
    equal(d.ops.filter(o => o[0] === 'S').length, ptsLegal.length, 'stitch records');
  });
  if (py) t.test('hand-made 12.1 mm run: pyembroidery reads the same points from DST and PES', () => {
    const f = C.pyRead({ 'h.dst': out.file.bytes, 'h.pes': Engine.export(res, { format: 'pes' }).bytes }, { points: true });
    check(!f['h.dst'].error && !f['h.pes'].error, 'unreadable');
    const cmp = C.sameRuns(C.pyRuns(f['h.pes']), C.pyRuns(f['h.dst']), { noOffset: true }); check(cmp.same, cmp.why);
    equal(C.pyRuns(f['h.dst']).blocks[0][0].length / 2, ptsLegal.length, 'stitches read');
  });
  // a stitch over the limit is not something generate ever produces; the writer must refuse it, not clip it
  for (const [name, bad] of [['12.2 mm along x', [122, 0]], ['17.1 mm diagonal (121, 121)', [121, 121]], ['30 mm', [300, 0]], ['205 mm', [2050, 0]]]) {
    const res2 = handMade([[0, 0], bad, [bad[0] + 10, bad[1] + 10]]);
    for (const fmt of ['dst', 'pes', 'pec', 'pes6']) t.test('stitch data with a stitch of ' + name + ' -> ' + fmt + ': refused, or written with every point intact', () => {
      const o = tryExport(res2, fmt);
      if (o.error) { equal(o.error.code, 'INVALID_IR', 'error code'); check(typeof o.error.message === 'string' && o.error.message.length > 5, 'no message'); return; }
      const buf = Buffer.from(o.file.bytes), d = fmt === 'dst' ? D.decodeDst(buf) : fmt === 'pec' ? D.decodePec(buf) : D.decodePes(buf);
      const pts2 = d.ops.filter(q => q[0] === 'S'), want = res2.ir.commands;
      // every original point must still be a needle point, in order (extra points in between are fine)
      let k = 0, off = null;
      for (let i = 0; i < want.length; i += 3) if (want[i] === OP.STITCH) { if (off === null) off = [pts2[0][1] - want[i + 1], pts2[0][2] - want[i + 2]]; while (k < pts2.length && !(pts2[k][1] - off[0] === want[i + 1] && pts2[k][2] - off[1] === want[i + 2])) k++; check(k < pts2.length, 'the point (' + want[i + 1] + ',' + want[i + 2] + ') is missing from the file: the stitch was clipped'); }
    });
  }
}
// moves between runs: every length class of a DST jump (121 per record) and of a PEC move (2047 per record)
for (const far of [[121, 0], [122, 0], [242, -243], [363, 364], [1000, -1000], [2047, 0], [2048, 5], [-2900, 2900], [2950, -2950]]) {
  const a = [[0, 0], [20, 0], [20, 20], [0, 20]], b = a.map(p => [p[0] + far[0], p[1] + far[1]]);
  const res = handMade(a, [b]);
  for (const fmt of ['dst', 'pes']) t.test('two runs ' + (Math.hypot(far[0], far[1]) / 10).toFixed(1) + ' mm apart (' + far + ') -> ' + fmt + ': the move adds up exactly', () => {
    const o = tryExport(res, fmt);
    check(!o.error, 'export refused: ' + (o.error && (o.error.code + ' ' + o.error.message)));
    const buf = Buffer.from(o.file.bytes), d = fmt === 'dst' ? D.decodeDst(buf) : D.decodePes(buf), mine = D.runsOf(d.ops);
    equal(d.problems.length, 0, 'decoder problems ' + JSON.stringify(d.problems.slice(0, 3)));
    const cmp = C.sameRuns(C.irRuns(res.ir), mine); check(cmp.same, cmp.why);
    let x = 0, y = 0; for (const q of d.ops) { check(Math.abs(q[1] - x) <= (fmt === 'dst' ? 121 : 2047) && Math.abs(q[2] - y) <= (fmt === 'dst' ? 121 : 2047), 'a record moves (' + (q[1] - x) + ',' + (q[2] - y) + ')'); x = q[1]; y = q[2]; }
    check(d.ops.some(q => q[0] === 'T'), 'no trim between the two runs');
  });
}
module.exports = t.done();
