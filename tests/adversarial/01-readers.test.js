#!/usr/bin/env node
/*
 * ATTACK 1: two independent readers against the writer.
 *
 * Every design is generated and exported through the public API (Engine.generate / Engine.export), then each
 * file is read back twice: by lib/decoders.js (written from the format spec, asserts every structural rule)
 * and by stock pyembroidery (lib/pyread.py). Both must give exactly the stitches of result.ir, run for run,
 * and the header fields must describe those stitches.
 */
'use strict';
const C = require('./lib/common.js');
const K = require('./lib/corpus.js');
const P = require('./lib/palette.js');
const { Engine, D, check, equal } = C;
const swappedY = [];

const t = C.suite('attack 1: independent readers (own PEC/PES/DST decoder + pyembroidery)');
const FORMATS = [['pes', 'pes'], ['pes6', 'pes'], ['pec', 'pec'], ['dst', 'dst']];

const cases = [];
for (const k of Object.keys(K.designs)) cases.push({ key: k, design: K.designs[k] });
for (const s of Object.keys(K.shapes)) cases.push({ key: 'fill_' + s, design: K.fillDesign(s, 'default') });
for (const [s, f] of [['U', 'a45'], ['donut', 'a90'], ['star9thin', 'a17'], ['blob', 'aNeg'], ['spiral', 'loose'], ['rect', 'long'], ['circle', 'short'], ['E', 'bigPull'], ['comb', 'noUnder']]) cases.push({ key: 'fill_' + s + '_' + f, design: K.fillDesign(s, f) });

const files = {};
for (const c of cases) {
  c.result = Engine.generate(c.design);
  c.out = {};
  if (!c.result.canExport) continue;
  for (const [fmt, ext] of FORMATS) { const f = Engine.export(c.result, { format: fmt }); c.out[fmt] = f; files[c.key + '__' + fmt + '.' + ext] = f.bytes; }
}
const py = C.pyRead(files, { points: true });
if (!py) t.skip('pyembroidery read-back', 'no python with pyembroidery (venv/bin/python or EMB_PYTHON)');

let fileCount = 0;
for (const c of cases) {
  t.test(c.key + ': generates something exportable', () => {
    check(c.result.canExport, 'canExport is false: ' + JSON.stringify(c.result.warnings.map(w => w.code)));
    equal(Engine.validate(c.result).length, 0, 'Engine.validate violations');
    equal(C.nonFinite(c.result).length, 0, 'non-finite numbers in the result');
  });
  if (!c.result.canExport) continue;
  const ir = C.irRuns(c.result.ir), b = ir.bounds, N = c.result.threads.length;
  const cx = Math.round((b.minX + b.maxX) / 2), cy = Math.round((b.minY + b.maxY) / 2);
  for (const [fmt, ext] of FORMATS) {
    const name = c.key + '__' + fmt + '.' + ext, buf = Buffer.from(c.out[fmt].bytes);
    fileCount++;
    const d = fmt === 'dst' ? D.decodeDst(buf) : fmt === 'pec' ? D.decodePec(buf) : D.decodePes(buf);
    const mine = D.runsOf(d.ops);
    t.test(name + ': well formed by the spec', () => {
      equal(d.problems.length, 0, 'decoder problems ' + JSON.stringify(d.problems.slice(0, 4)));
      check(mine.ended, 'no END'); equal(mine.tail, 0, 'commands after END');
    });
    t.test(name + ': my decoder gives exactly the IR stitches, centred', () => {
      const cmp = C.sameRuns(ir, mine);
      check(cmp.same, 'differs from the IR: ' + cmp.why);
      equal(cmp.dx, -cx, 'x offset'); equal(cmp.dy, -cy, 'y offset');
      const fb = C.runBounds(mine);
      check(Math.abs(fb.minX + fb.maxX) <= 1 && Math.abs(fb.minY + fb.maxY) <= 1, 'file is not centred on its own bounding box: ' + JSON.stringify(fb));
      equal(c.out[fmt].stitches, c.result.totals.stitches, 'file.stitches');
      equal(fb.n, c.result.totals.stitches, 'needle penetrations in the file');
    });
    if (fmt !== 'dst') {
      t.test(name + ': PEC header fields describe the stitches', () => {
        equal(d.width, b.maxX - b.minX, 'PEC width'); equal(d.height, b.maxY - b.minY, 'PEC height');
        equal(d.palette.length, N, 'palette entries'); equal(d.ops.filter(o => o[0] === 'C').length, N - 1, 'colour changes');
        equal(d.thumbs, N + 1, 'thumbnails');
        check(d.thumbPixels.every(p => p > 0), 'an empty thumbnail: ' + JSON.stringify(d.thumbPixels));
        equal(d.ops[0][0], 'J', 'first stream entry'); equal(d.ops[1][0], 'S', 'second stream entry');
        check(d.ops[1][1] === d.ops[0][1] && d.ops[1][2] === d.ops[0][2], 'the first stitch is not where the first move ended');
        equal(d.label.trim().length > 0, true, 'label not empty');
        // the palette bytes are the ones the spec's matching rule gives (computed by lib/palette.js)
        equal(JSON.stringify(d.palette), JSON.stringify(P.uniquePalette(c.result.threads.map(th => th.color))), 'PEC palette bytes');
        // one palette entry per distinct colour, the same entry for the same colour
        const seen = new Map(), used = new Map();
        c.result.threads.forEach((th, i) => {
          if (seen.has(th.color)) equal(d.palette[i], seen.get(th.color), 'palette entry of repeated colour ' + th.color);
          else { if (seen.size < 64) check(!used.has(d.palette[i]), 'colours ' + th.color + ' and ' + used.get(d.palette[i]) + ' share palette entry ' + d.palette[i]); seen.set(th.color, d.palette[i]); used.set(d.palette[i], th.color); }
        });
      });
    }
    if (fmt === 'pes' || fmt === 'pes6') {
      t.test(name + ': PES section agrees with the PEC stream', () => {
        equal(d.seg.width, b.maxX - b.minX, 'PES width'); equal(d.seg.height, b.maxY - b.minY, 'PES height');
        // sections with flag 0 are thread runs in bounds-relative coordinates (x - minX, y - maxY)
        const fb = C.runBounds(mine), flat = [], want = [];
        for (const s of d.seg.sections) if (s.flag === 0) for (const p of s.pts) flat.push(p[0] + fb.minX, p[1] + fb.maxY);
        for (const blk of mine.blocks) for (const r of blk) for (const v of r) want.push(v);
        // a run may be cut into several sections, and a section repeats the point it starts from; so compare as point sets in order without immediate repeats
        const squash = a => { const o = []; for (let i = 0; i < a.length; i += 2) if (!o.length || o[o.length - 2] !== a[i] || o[o.length - 1] !== a[i + 1]) o.push(a[i], a[i + 1]); return o; };
        const A = squash(flat), B = squash(want);
        equal(A.length, B.length, 'points in the PES sections vs the PEC stream');
        for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) throw new Error('PES section point ' + (i >> 1) + ' is (' + A[i - (i & 1)] + ',' + A[i - (i & 1) + 1] + '), PEC has (' + B[i - (i & 1)] + ',' + B[i - (i & 1) + 1] + ')');
        // v1: the section code is the PLAIN nearest Brother colour (spec 6.1), which is not always the PEC
        // palette byte (the PEC palette never uses an entry twice). Consecutive blocks with the same code
        // share one log entry, so walk the sections instead of the log.
        const stitchSecs = d.seg.sections.filter(s => s.flag === 0);
        for (const s of d.seg.sections) check(s.pts.length > 0 && s.pts.length <= 65535, 'a PES section with ' + s.pts.length + ' points');
        if (fmt === 'pes') {
          const want = c.result.threads.map(th => P.plain(th.color));
          // a thread run is one section, or several when it has more than 65535 stitches (each continuing on the last point of the one before)
          const perRun = [].concat(...mine.blocks.map((runs, k) => runs.map(r => ({ k, n: r.length / 2 }))));
          let pts = 0, run = 0;
          for (const s of stitchSecs) {
            check(run < perRun.length, 'more PES stitch sections than thread runs');
            equal(s.code, want[perRun[run].k], 'section colour code in block ' + perRun[run].k);
            pts += s.pts.length - (pts ? 1 : 0);
            if (pts >= perRun[run].n) { pts = 0; run++; }
          }
          equal(run, perRun.length, 'thread runs covered by the PES stitch sections');
        }
        if (fmt === 'pes6') {
          for (const s of stitchSecs) check(s.code < d.v6.threads.length, 'PES v6 section colour code ' + s.code + ' is not an index of the thread list');
          equal(JSON.stringify(d.v6.threads.map(v => '#' + ('00000' + v.toString(16)).slice(-6))), JSON.stringify(c.result.threads.map(x => x.color)), 'PES v6 thread list');
          equal(JSON.stringify(d.v6.addendumRgb), JSON.stringify(d.v6.threads), 'PES v6 addendum RGB');
        }
      });
    }
    if (fmt === 'dst') {
      t.test(name + ': DST header fields describe the stitches', () => {
        const h = d.header, fb = C.runBounds(mine), last = d.ops[d.ops.length - 1];
        equal(Number(h['+X']), fb.maxX, '+X'); equal(Number(h['-X']), -fb.minX, '-X');
        // FINDING F1: the writer puts |maxY| of the y-DOWN bounds into +Y and |minY| into -Y (as pyembroidery
        // does), although the records store y up. A centred design makes the two differ by at most one unit.
        const upY = -fb.minY, downY = fb.maxY;
        check(Number(h['+Y']) + Number(h['-Y']) === upY + downY, '+Y and -Y do not add up to the height: ' + h['+Y'] + ' + ' + h['-Y'] + ' vs ' + (upY + downY));
        check(Math.abs(Number(h['+Y']) - upY) <= 1, '+Y is ' + h['+Y'] + ', the stitches reach ' + upY + ' above the origin');
        if (Number(h['+Y']) !== upY) swappedY.push(name);
        equal(Number(h.CO), N - 1, 'CO'); equal(Number(h.AX.replace(/\s/g, '')), last[1], 'AX'); equal(Number(h.AY.replace(/\s/g, '')), -last[2], 'AY (file y is up)');
        equal(buf.length, 512 + 3 * d.records, 'file length');
      });
    }
    if (py) {
      t.test(name + ': pyembroidery reads the same stitches', () => {
        const p = py[name];
        check(p && !p.error, 'pyembroidery could not read it: ' + (p && p.error));
        check(!p.nan, 'NaN in the pyembroidery read-back');
        const cmp = C.sameRuns(mine, C.pyRuns(p), { noOffset: true });
        check(cmp.same, 'pyembroidery differs from my decoder: ' + cmp.why);
        equal(p.cmds[p.cmds.length - 1], 'E', 'last pyembroidery command');
        equal(p.cmds.split('C').length - 1, N - 1, 'pyembroidery colour changes');
        if (fmt !== 'dst') equal(p.threads.length, N, 'pyembroidery threads');
        if (fmt === 'pes6') equal(JSON.stringify(p.threads), JSON.stringify(c.result.threads.map(x => x.color)), 'pyembroidery thread colours');
      });
    }
  }
}
if (swappedY.length) t.note('OPEN finding F1: DST +Y / -Y are swapped (0.1 mm off) in ' + swappedY.length + ' files, e.g. ' + swappedY.slice(0, 3).join(', '));
t.note(cases.length + ' designs, ' + fileCount + ' files, each read by ' + (py ? 'two readers' : 'one reader (no python)'));
module.exports = t.done();
