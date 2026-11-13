#!/usr/bin/env node
/*
 * ATTACK 4: sequencing. What the machine does between the stitches.
 *
 *   - one colour block per run of same-coloured objects, in the order the objects were drawn; colour changes =
 *     blocks - 1 in the result, in the IR, in every file and in pyembroidery's reading of every file
 *   - the needle does not move between the last stitch of a colour and the colour change, and no stitch of a
 *     colour lies in an area that belongs to another colour
 *   - every move between two thread runs is a trim (PES / PEC: trim-flagged move; DST: the trim signature
 *     before the jumps); the first stitch of the file is reached by a move from the origin
 *   - END is last, once
 *   - the file is centred on its own bounding box
 *   - which way is up: an asymmetric design read back by both readers
 */
'use strict';
const C = require('./lib/common.js');
const K = require('./lib/corpus.js');
const { Engine, D, check, equal } = C;

const t = C.suite('attack 4: sequencing (colour blocks, trims, moves, END, centring, which way is up)');

const hex = c => { let s = String(c).trim().toLowerCase(); if (s[0] === '#') s = s.slice(1); if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]; return '#' + s; };
const closedShape = o => { const ty = o.type; return ty === 'rect' || ty === 'ellipse' || ty === 'circle' || ty === 'polygon' || (ty === 'polyline' && o.closed === true) || ty === 'path'; };
// the colour blocks API.md section 4 / 5 promises for a design in which nothing is skipped
function expectedThreads(design) {
  const seq = [];
  for (const o of design.objects) {
    if (o.visible === false) continue;
    const paint = o.paint || (closedShape(o) ? 'fill' : 'line'), fillC = hex(o.color || '#000000'), lineC = hex((o.line && o.line.color) || o.color || '#000000');
    if (paint === 'fill' || paint === 'both') seq.push(fillC);
    if (paint === 'line' || paint === 'both') seq.push(lineC);
  }
  return seq.filter((c, i) => i === 0 || c !== seq[i - 1]);
}

const R = (x, y, color, extra) => Object.assign({ type: 'rect', x, y, width: 14, height: 14, color }, extra || {});
const own = {
  // the same red written three ways back to back, blue, red again, blue written two more ways
  sameColourSpelling: { name: 'Spelling', hoop: { width: 100, height: 100 }, objects: [R(5, 5, '#F00'), R(30, 5, 'ff0000'), R(55, 5, '#FF0000'), R(80, 5, '#00f'), R(5, 40, '#ff0000'), R(30, 40, '#0000FF'), R(55, 40, '00F')] },
  // an invisible object between two of the same colour must not split the block
  invisibleBetween: { name: 'Invisible', hoop: { width: 100, height: 100 }, objects: [R(5, 5, '#123456'), R(40, 40, '#ff0000', { visible: false }), R(70, 70, '#123456')] },
  bothSameColour: { name: 'BothSame', hoop: { width: 100, height: 100 }, objects: [R(20, 20, '#224488', { width: 50, height: 40, paint: 'both', line: { type: 'satin', width: 2 } })] },
  bothOtherColour: { name: 'BothOther', hoop: { width: 100, height: 100 }, objects: [R(20, 20, '#224488', { width: 50, height: 40, paint: 'both', line: { type: 'satin', width: 2, color: '#ffffff' } }), R(75, 75, '#ffffff')] },
  // the first stitch lies exactly on the centre of the design: the opening move of the file is (0, 0)
  startsAtCentre: { name: 'Centre', hoop: { width: 100, height: 100 }, objects: [{ type: 'polyline', points: [[50, 50], [70, 50], [70, 60], [30, 60], [30, 40], [70, 40]], color: '#000000' }] },
  // twelve colours, alternating far corners: every colour change is followed by a long move
  zigzagColours: { name: 'Zigzag', hoop: { width: 200, height: 200 }, objects: Array.from({ length: 12 }, (_, i) => R(i % 2 ? 180 : 4, 4 + i * 15, '#' + ('00000' + ((i * 0x1f3d5b + 0x0a0b0c) & 0xffffff).toString(16)).slice(-6), { height: 10 })) },
};
const cases = [];
for (const k of Object.keys(K.designs)) cases.push({ key: k, design: K.designs[k] });
for (const k of Object.keys(own)) cases.push({ key: k, design: own[k], disjoint: k !== 'bothSameColour' && k !== 'bothOtherColour' && k !== 'startsAtCentre' });

const FORMATS = [['pes', 'pes'], ['pes6', 'pes'], ['pec', 'pec'], ['dst', 'dst']];
const files = {};
for (const c of cases) {
  c.result = Engine.generate(c.design); c.out = {};
  if (!c.result.canExport) continue;
  for (const [fmt, ext] of FORMATS) { c.out[fmt] = Engine.export(c.result, { format: fmt }); files[c.key + '__' + fmt + '.' + ext] = c.out[fmt].bytes; }
}
const py = C.pyRead(files, { points: true });
if (!py) t.skip('pyembroidery read-back', 'no python with pyembroidery');

// which block may put stitches where (design mm): rect objects only, used for the designs marked disjoint
function regionsOf(design, threads) {
  const seq = []; // [colour, rect] in sewing order
  for (const o of design.objects) if (o.visible !== false) seq.push([hex(o.color), o]);
  const blocks = []; let prev = null;
  for (const [c, o] of seq) { if (c !== prev) { blocks.push([]); prev = c; } blocks[blocks.length - 1].push(o); }
  return blocks.length === threads.length ? blocks : null;
}
const inRects = (rects, x, y, m) => rects.some(o => x >= o.x - m && x <= o.x + o.width + m && y >= o.y - m && y <= o.y + o.height + m);

let fileCount = 0;
const upNotes = [], noOpeningMove = [];
for (const c of cases) {
  const r = c.result;
  t.test(c.key + ': colour blocks follow the drawing order', () => {
    check(r.canExport, 'not exportable: ' + JSON.stringify(r.warnings.map(w => w.code)));
    check(r.objects.every(o => !o.skipped || c.design.objects[o.index].visible === false), 'an object was skipped: ' + JSON.stringify(r.objects.filter(o => o.skipped)));
    equal(JSON.stringify(r.threads.map(x => x.color)), JSON.stringify(expectedThreads(c.design)), 'thread order');
    equal(r.totals.colorChanges, r.threads.length - 1, 'totals.colorChanges'); equal(r.totals.colors, r.threads.length, 'totals.colors');
    equal(JSON.stringify(r.ir.threads.map(x => x.color)), JSON.stringify(r.threads.map(x => x.color)), 'ir.threads');
  });
  if (!r.canExport) continue;
  const ir = C.irRuns(r.ir), cmd = r.ir.commands, N = r.threads.length;
  t.test(c.key + ': the IR is run after run (JUMP, STITCH at the same point, STITCHes, TRIM), END once', () => {
    let s = ''; for (let i = 0; i < cmd.length; i += 3) s += 'SJTCE'[cmd[i]];
    check(/^JS{2,}T(C?JS{2,}T)*E$/.test(s), 'op order is ' + s.replace(/S{3,}/g, m => 'S*' + m.length + ' ').slice(0, 300));
    for (let i = 0; i < cmd.length; i += 3) {
      if (cmd[i] === C.OP.JUMP) check(cmd[i + 3] === C.OP.STITCH && cmd[i + 4] === cmd[i + 1] && cmd[i + 5] === cmd[i + 2], 'the stitch after the JUMP at ' + i / 3 + ' is somewhere else');
      if (cmd[i] === C.OP.TRIM || cmd[i] === C.OP.COLOR_CHANGE) check(cmd[i + 1] === cmd[i - 2] && cmd[i + 2] === cmd[i - 1], 'the needle moves at the ' + (cmd[i] === C.OP.TRIM ? 'TRIM' : 'COLOR_CHANGE') + ' at ' + i / 3);
    }
    equal(ir.counts[C.OP.COLOR_CHANGE], N - 1, 'COLOR_CHANGE commands'); equal(ir.counts[C.OP.END], 1, 'END commands');
    equal(ir.counts[C.OP.TRIM], r.totals.trims, 'totals.trims'); equal(ir.counts[C.OP.JUMP], r.totals.jumps, 'totals.jumps'); equal(ir.counts[C.OP.STITCH], r.totals.stitches, 'totals.stitches');
    ir.blocks.forEach((b, k) => equal(b.reduce((n, run) => n + run.length / 2, 0), r.threads[k].stitches, 'threads[' + k + '].stitches'));
    equal(r.objects.reduce((n, o) => n + o.stitches, 0), r.totals.stitches, 'sum of objects[].stitches');
  });
  const regions = c.disjoint ? regionsOf(c.design, r.threads) : null;
  if (regions) t.test(c.key + ': every stitch of a colour lies in an object of that colour', () => {
    ir.blocks.forEach((b, k) => { for (const run of b) for (let i = 0; i < run.length; i += 2) { const p = C.irMm(r.ir, run[i], run[i + 1]); if (!inRects(regions[k], p[0], p[1], 0.4)) throw new Error('block ' + k + ' (' + r.threads[k].color + ') has a stitch at (' + p + '), outside its own objects'); } });
  });

  const b = ir.bounds, cx = Math.round((b.minX + b.maxX) / 2), cy = Math.round((b.minY + b.maxY) / 2);
  const hw = Math.round(r.ir.hoop.w / 2), hh = Math.round(r.ir.hoop.h / 2);
  const fileMm = (x, y) => [(x + cx + hw) / 10, (y + cy + hh) / 10];       // file units (centred, y down) -> design mm
  for (const [fmt, ext] of FORMATS) {
    const name = c.key + '__' + fmt + '.' + ext, buf = Buffer.from(c.out[fmt].bytes); fileCount++;
    const d = fmt === 'dst' ? D.decodeDst(buf) : fmt === 'pec' ? D.decodePec(buf) : D.decodePes(buf);
    const ops = d.ops, s = ops.map(o => o[0]).join('');
    t.test(name + ': moves, trims, colour changes and END are in order', () => {
      equal(d.problems.length, 0, 'decoder problems ' + JSON.stringify(d.problems.slice(0, 3)));
      const short = s.replace(/S{3,}/g, m => 'S*' + m.length + ' ').slice(0, 300);
      if (fmt === 'dst') {
        // jumps from the origin, stitches; between runs: trim, (colour change), jumps; a trim before END
        check(/^J*S+(TC?J*S+)*T?E$/.test(s), 'record order is ' + short);
      } else {
        // one plain jump from the origin (none when the first stitch IS the origin); between runs trim-flagged
        // moves only, after the colour change if there is one (none when the new colour starts where the old ended)
        check(/^J?S+((T+|CT*)S+)*E$/.test(s), 'record order is ' + short);
      }
      equal(s.split('C').length - 1, N - 1, 'colour changes in the file');
      equal(s.indexOf('E'), s.length - 1, 'position of END');
      // nothing moves between the last stitch of a colour and its colour change
      let last = null, firstS = -1;
      ops.forEach((o, i) => {
        if (o[0] === 'S') { if (firstS < 0) firstS = i; last = o; }
        if (o[0] === 'C') { const before = fmt === 'dst' ? ops[i - 1] : last; check(o[1] === last[1] && o[2] === last[2] && before[1] === last[1] && before[2] === last[2], 'the needle is at (' + o[1] + ',' + o[2] + ') at colour change, the last stitch was at (' + last[1] + ',' + last[2] + ')'); }
      });
      // the first stitch is reached by a move that starts at the origin (0, 0 = centre of the design). PES / PEC:
      // a jump record, then a stitch on the spot; no jump only when the first stitch is the origin itself.
      // DST: jump records while the way is longer than one record, the last leg is the stitch record.
      check(ops.slice(0, firstS).every(o => o[0] === 'J'), 'something other than a move comes before the first stitch');
      if (fmt !== 'dst') {
        if (firstS === 0) { check(ops[0][1] === 0 && ops[0][2] === 0, 'the file opens with a stitch that moves the needle (' + ops[0][1] + ',' + ops[0][2] + ') instead of a jump'); noOpeningMove.push(name); }
        else check(ops[firstS][1] === ops[firstS - 1][1] && ops[firstS][2] === ops[firstS - 1][2], 'the first stitch is not where the opening move ends');
        // and so is the first stitch after every later move
        ops.forEach((o, i) => { if (o[0] === 'T' && ops[i + 1][0] === 'S') check(ops[i + 1][1] === o[1] && ops[i + 1][2] === o[2], 'the stitch after the move at record ' + i + ' is somewhere else'); });
      } else {
        // DST: every record is at most 12.1 mm per axis, moves included
        let px = 0, py2 = 0; for (const o of ops) { check(Math.abs(o[1] - px) <= 121 && Math.abs(o[2] - py2) <= 121, 'a DST record moves (' + (o[1] - px) + ',' + (o[2] - py2) + ')'); px = o[1]; py2 = o[2]; }
      }
    });
    t.test(name + ': centred, colours stay in their own areas', () => {
      const mine = D.runsOf(ops), fb = C.runBounds(mine);
      check(Math.abs(fb.minX + fb.maxX) <= 1 && Math.abs(fb.minY + fb.maxY) <= 1, 'not centred on its bounding box: ' + JSON.stringify(fb));
      equal(mine.blocks.length, N, 'colour blocks in the file');
      if (regions) mine.blocks.forEach((blk, k) => { for (const run of blk) for (let i = 0; i < run.length; i += 2) { const p = fileMm(run[i], run[i + 1]); if (!inRects(regions[k], p[0], p[1], 0.4)) throw new Error('colour block ' + k + ' sews at (' + p + ') mm, which is not one of its objects'); } });
    });
    if (py) t.test(name + ': pyembroidery sees the same sequence', () => {
      const p = py[name];
      check(p && !p.error, 'pyembroidery could not read it: ' + (p && p.error));
      equal(p.cmds.split('C').length - 1 + (p.cmds.split('P').length - 1), N - 1, 'colour changes read by pyembroidery');
      equal(p.cmds.indexOf('E'), p.cmds.length - 1, 'END position read by pyembroidery');
      const pr = C.pyRuns(p);
      equal(pr.blocks.length, N, 'colour blocks read by pyembroidery');
      if (regions) pr.blocks.forEach((blk, k) => { for (const run of blk) for (let i = 0; i < run.length; i += 2) { const q = fileMm(run[i], run[i + 1]); if (!inRects(regions[k], q[0], q[1], 0.4)) throw new Error('pyembroidery: colour block ' + k + ' sews at (' + q + ') mm, not one of its objects'); } });
      // a run never continues across a gap: consecutive stitches of one run are at most 12.1 mm apart
      for (const blk of pr.blocks) for (const run of blk) for (let i = 2; i < run.length; i += 2) check(Math.hypot(run[i] - run[i - 2], run[i + 1] - run[i - 1]) <= 121.01, 'pyembroidery reads a stitch of ' + (Math.hypot(run[i] - run[i - 2], run[i + 1] - run[i - 1]) / 10).toFixed(1) + ' mm');
    });
  }
}

/*
 * Which way is up. The design 'asym' is an L (tall bar on the left, foot at the bottom, red) and a dot in the top
 * right (blue), drawn in canvas coordinates (y down). The spec (section 2): PES and PEC store y down, DST stores
 * y up. So in a PES / PEC the dot must have SMALLER y than the foot; in the raw DST records LARGER y. Both readers
 * give y down (they negate DST), so read back the dot is above the foot in all of them.
 */
{
  const c = cases.find(x => x.key === 'asym');
  const shapeOf = model => {
    const L = model.blocks[0], dot = model.blocks[1], box = runs => C.runBounds({ blocks: [runs] });
    const lb = box(L), db = box(dot);
    // the foot: stitches of the L right of its bar (bar is 10 mm wide)
    const foot = { minY: Infinity, maxY: -Infinity }; for (const run of L) for (let i = 0; i < run.length; i += 2) if (run[i] > lb.minX + 150) { if (run[i + 1] < foot.minY) foot.minY = run[i + 1]; if (run[i + 1] > foot.maxY) foot.maxY = run[i + 1]; }
    return { lb, db, foot };
  };
  for (const [fmt, ext] of FORMATS) {
    const name = 'asym__' + fmt + '.' + ext, buf = Buffer.from(c.out[fmt].bytes);
    const d = fmt === 'dst' ? D.decodeDst(buf) : fmt === 'pec' ? D.decodePec(buf) : D.decodePes(buf);
    const readers = [['own decoder', D.runsOf(d.ops)]]; if (py && py[name] && !py[name].error) readers.push(['pyembroidery', C.pyRuns(py[name])]);
    for (const [who, model] of readers) t.test(name + ' (' + who + '): up is up and left is left', () => {
      const s = shapeOf(model);
      check(s.foot.minY > (s.lb.minY + s.lb.maxY) / 2, 'the foot of the L is not in its lower half (y down): foot y ' + s.foot.minY + '..' + s.foot.maxY + ', L y ' + s.lb.minY + '..' + s.lb.maxY);
      check(s.foot.maxY === s.lb.maxY, 'the foot is not the lowest part of the L');
      check(s.db.maxY < s.foot.minY, 'the dot (y ' + s.db.minY + '..' + s.db.maxY + ') is not above the foot (y ' + s.foot.minY + '..' + s.foot.maxY + ')');
      check(s.db.minX > s.lb.minX + 100, 'the dot is not right of the bar: dot x from ' + s.db.minX + ', bar from ' + s.lb.minX);
      check(s.db.minY - s.lb.minY >= 0 && s.db.minY - s.lb.minY < 100, 'the dot is not near the top of the L');
      // sizes as drawn: L is 50 x 60 mm, dot 8 mm
      check(Math.abs(s.lb.maxX - s.lb.minX - 500) <= 8 && Math.abs(s.lb.maxY - s.lb.minY - 600) <= 8, 'L is ' + (s.lb.maxX - s.lb.minX) / 10 + ' x ' + (s.lb.maxY - s.lb.minY) / 10 + ' mm, drawn 50 x 60');
      check(Math.abs(s.db.maxX - s.db.minX - 80) <= 8, 'dot is ' + (s.db.maxX - s.db.minX) / 10 + ' mm wide, drawn 8');
    });
    if (fmt === 'dst') t.test(name + ': the raw records store y up (dot has the larger y)', () => {
      // straight from the bytes, y bits as the spec lists them, no negation
      let y = 0, block = 0; const ys = [[], []];
      for (let i = 512; i + 2 < buf.length; i += 3) {
        const b0 = buf[i], b1 = buf[i + 1], b2 = buf[i + 2];
        if ((b2 & 0xf3) === 0xf3) break;
        if ((b2 & 0xc3) === 0xc3) { block++; continue; }
        if (b2 & 0x20) y += 81; if (b2 & 0x10) y -= 81; if (b1 & 0x20) y += 27; if (b1 & 0x10) y -= 27; if (b0 & 0x20) y += 9; if (b0 & 0x10) y -= 9; if (b1 & 0x80) y += 3; if (b1 & 0x40) y -= 3; if (b0 & 0x80) y += 1; if (b0 & 0x40) y -= 1;
        if (!(b2 & 0x80) && block < 2) ys[block].push(y);
      }
      const mean = a => a.reduce((p, q) => p + q, 0) / a.length;
      check(mean(ys[1]) > mean(ys[0]), 'raw DST: dot mean y ' + mean(ys[1]).toFixed(0) + ', L mean y ' + mean(ys[0]).toFixed(0));
    });
  }
  upNotes.push('asym (L with its foot at the bottom, dot top right): in PES / PEC the top of the drawing has the smaller y (y down, spec section 2); DST stores y up and both readers turn it back. So the top of the canvas is the top of the design on the machine screen, which on a flat-bed Brother is the edge of the hoop away from the operator. Not sewn on a machine.');
}
for (const n of upNotes) t.note(n);
if (noOpeningMove.length) t.note('no opening jump record in ' + noOpeningMove.join(', ') + ': the first stitch is exactly the centre of the design, so the stream starts with a stitch of (0, 0). pyembroidery writes the same. How a machine takes that is not known here (spec section 12).');
t.note(cases.length + ' designs, ' + fileCount + ' files');
module.exports = t.done();
