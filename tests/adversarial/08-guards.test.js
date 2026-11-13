#!/usr/bin/env node
/*
 * ATTACK 8: the guards added after the first adversarial round.
 *
 *   F4  the total stitch limit (LIMITS.maxStitches): just under, exactly at, one over; many small objects that add
 *       up; one huge fill; a random search for a design that is refused although it fits, or let through although
 *       it does not; time and memory of a refusal
 *   F3  the notes about Brother palette entries (COLORS_MERGED, COLOR_SUBSTITUTED): every claim is checked against
 *       the bytes of the exported files and a palette table typed from the format notes, not from the engine
 *   F1  the DST header extents: which side +Y and -Y describe
 *
 * The worker and main-thread paths of the limit are tested in a real browser by 05-scale (page tests) and by
 * tests/engine/browser.test.js, and against a worker stand-in by tests/engine/facade.test.js.
 */
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('./lib/common.js');
const K = require('./lib/corpus.js');
const P = require('./lib/palette.js');
const T = require('../engine/designs.js');
const { Engine, D, check, equal } = C;
const LIMIT = Engine.LIMITS.maxStitches, LARGE = Engine.LIMITS.largeDesign;

const t = C.suite('attack 8: stitch limit, palette notes, DST header');

/* ---------- helpers ---------- */
const rnd = seed => () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let x = Math.imul(seed ^ seed >>> 15, 1 | seed); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; };
const codes = r => r.warnings.map(w => w.code + ':' + w.severity).join(',');
const irStitches = ir => { let n = 0; for (let i = 0; i < ir.commands.length; i += 3) if (ir.commands[i] === C.OP.STITCH) n++; return n; };
const sameIr = (a, b) => a.ir.commands.length === b.ir.commands.length && Buffer.from(a.ir.commands.buffer, a.ir.commands.byteOffset, a.ir.commands.byteLength).equals(Buffer.from(b.ir.commands.buffer, b.ir.commands.byteOffset, b.ir.commands.byteLength));
const facts = r => JSON.stringify([r.ok, r.canExport, r.name, r.hoop, r.threads, r.objects, r.totals, r.bounds, r.warnings]);
const timed = fn => { const t0 = process.hrtime.bigint(), r = fn(); return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; };
// running lines that add exactly n stitches to a design: a line of p segments of 2.5 mm sews p + 9 stitches
function pad(n, y0) {
  const out = []; let left = n, row = 0;
  while (left > 0) {
    let p = Math.min(100, left - 9);
    if (left - (p + 9) > 0 && left - (p + 9) < 10) p -= 10;
    if (p < 1) throw new Error('cannot add exactly ' + n + ' stitches');
    const y = y0 + (row % 450) * 0.6;
    out.push({ type: 'polyline', points: Array.from({ length: p + 1 }, (_, i) => [10 + i * 2.5, y]), color: '#000000', line: { type: 'running', stitchLength: 2.5 } });
    left -= p + 9; row++;
  }
  return out;
}
// what a refused result must look like
function refused(r, limit, objects, what) {
  // the one error, and the last entry; notes about objects looked at before the limit may come before it
  equal(r.warnings.filter(x => x.severity === 'error').map(x => x.code).join(), 'TOO_MANY_STITCHES', what + ': errors');
  const w = r.warnings[r.warnings.length - 1];
  equal(w.code, 'TOO_MANY_STITCHES', what + ': last warning');
  equal(w.limit, limit, what + ': limit in the warning');
  check(Number.isInteger(w.stitches) && w.stitches > limit, what + ': count reached ' + w.stitches + ' is not above the limit ' + limit);
  check(typeof w.message === 'string' && w.message.length > 20 && /stitches/.test(w.message), what + ': message ' + JSON.stringify(w.message));
  equal(r.ok, false, what + ': ok'); equal(r.canExport, false, what + ': canExport');
  equal(r.totals.stitches, 0, what + ': totals.stitches'); equal(r.ir.commands.length, 3, what + ': stitch data length'); equal(r.ir.commands[0], C.OP.END, what + ': stitch data holds END only');
  equal(Engine.validate(r).length, 0, what + ': the empty stitch data is well formed');
  equal(r.objects.length, objects, what + ': objects listed'); check(r.objects.every((o, i) => o.index === i && o.skipped === true && o.stitches === 0), what + ': an object is not marked skipped');
  let err = null; try { Engine.export(r, { format: 'pes' }); } catch (e) { err = e; }
  check(err && err.code === 'TOO_MANY_STITCHES', what + ': export gave ' + (err ? err.code : 'a file'));
  return w;
}

/* =====================================================================  F4: the stitch limit  */
t.test('LIMITS: maxStitches is 500,000 and largeDesign 100,000', () => { equal(LIMIT, 500000, 'maxStitches'); equal(LARGE, 100000, 'largeDesign'); });

const hoop300 = { width: 300, height: 300 };
const base = T.designs.heavy.objects.slice(0, 6), baseCount = Engine.generate({ hoop: hoop300, objects: base }).totals.stitches;
const edge = {};
for (const n of [LIMIT - 1, LIMIT, LIMIT + 1]) {
  const objects = base.concat(pad(n - baseCount, 10));
  edge[n] = Object.assign(timed(() => Engine.generate({ name: 'Edge', hoop: hoop300, objects })), { objects: objects.length });
}
for (const n of [LIMIT - 1, LIMIT]) t.test('a design of exactly ' + n + ' stitches is let through, complete', () => {
  const r = edge[n].r;
  equal(r.totals.stitches, n, 'totals.stitches'); equal(irStitches(r.ir), n, 'stitch commands in the stitch data');
  equal(r.objects.reduce((a, o) => a + o.stitches, 0), n, 'sum of the objects');
  equal(r.canExport, true, 'canExport'); check(!r.warnings.some(w => w.severity === 'error'), 'errors: ' + codes(r));
  check(r.warnings.some(w => w.code === 'LARGE_DESIGN'), 'LARGE_DESIGN missing: ' + codes(r));
  equal(Engine.validate(r).length, 0, 'validate');
  const f = Engine.export(r, { format: 'pes' }), d = D.decodePes(f.bytes);
  equal(d.problems.length, 0, 'problems in the PES: ' + d.problems.join('; ')); equal(d.ops.filter(o => o[0] === 'S').length, n, 'stitches in the PES');
});
t.test('a design of ' + (LIMIT + 1) + ' stitches is refused; the result has the same fields as any other', () => {
  const r = edge[LIMIT + 1].r, w = refused(r, LIMIT, edge[LIMIT + 1].objects, 'one over');
  check(w.stitches <= LIMIT + 1, 'count reached ' + w.stitches + ' is more than the design holds');
  equal(Object.keys(r).sort().join(), Object.keys(edge[LIMIT].r).sort().join(), 'result fields');
  equal(Object.keys(r.totals).sort().join(), Object.keys(edge[LIMIT].r.totals).sort().join(), 'totals fields');
  equal(facts(Engine.generate({ name: 'Edge', hoop: hoop300, objects: base.concat(pad(LIMIT + 1 - baseCount, 10)) })), facts(r), 'the same refusal twice');
});
t.test('options.maxStitches can lower the limit, never raise it; junk values are ignored', () => {
  const d = T.designs.badge, ref = Engine.generate(d), n = ref.totals.stitches;
  for (const v of [0, -3, 0.5, NaN, Infinity, '100', null, undefined, {}, LIMIT, LIMIT + 1, 1e9]) { const r = Engine.generate(d, { maxStitches: v }); check(sameIr(r, ref) && facts(r) === facts(ref), 'maxStitches ' + String(v) + ' changed the result'); }
  equal(facts(edge[LIMIT + 1].r), facts(Engine.generate({ name: 'Edge', hoop: hoop300, objects: base.concat(pad(LIMIT + 1 - baseCount, 10)) }, { maxStitches: 1e9 })), 'a higher option does not lift the limit');
  check(sameIr(Engine.generate(d, { maxStitches: n }), ref), 'maxStitches equal to the count');
  refused(Engine.generate(d, { maxStitches: n - 1 }), n - 1, d.objects.length, 'one under the count');
  refused(Engine.generate(d, { maxStitches: 1 }), 1, d.objects.length, 'maxStitches 1');
});

t.test('LARGE_DESIGN: absent at exactly ' + LARGE + ' stitches, present (warning, export allowed) one above', () => {
  const fill = [{ type: 'rect', x: 20, y: 20, width: 200, height: 150, color: '#224488', fill: { spacing: 0.4 } }];
  const n0 = Engine.generate({ hoop: hoop300, objects: fill }).totals.stitches;
  check(n0 > 20000 && n0 < LARGE - 20, 'base fill has ' + n0 + ' stitches');
  for (const n of [LARGE, LARGE + 1]) {
    const r = Engine.generate({ hoop: hoop300, objects: fill.concat(pad(n - n0, 10)) }), w = r.warnings.find(x => x.code === 'LARGE_DESIGN');
    equal(r.totals.stitches, n, 'stitches'); equal(r.canExport, true, 'canExport at ' + n);
    if (n === LARGE) check(!w, 'LARGE_DESIGN at exactly the threshold');
    else {
      check(w && w.severity === 'warning', 'LARGE_DESIGN missing or not a warning: ' + codes(r));
      equal(w.stitches, n, 'stitches in the warning'); equal(w.threshold, LARGE, 'threshold');
      check(typeof w.timeMin === 'number' && w.timeMin > 0 && typeof w.message === 'string' && w.message.length > 20, 'timeMin / message');
      equal(Engine.export(r, { format: 'dst' }).bytes.length > 512, true, 'export');
    }
  }
});

const small = n => ({ name: 'Small', hoop: { width: 1000, height: 1000 }, objects: Array.from({ length: n }, (_, i) => ({ type: 'rect', x: 5 + (i % 98) * 10, y: 5 + Math.floor(i / 98) * 10, width: 8, height: 8, color: i % 2 ? '#aa0000' : '#0000aa', fill: { spacing: 0.4 } })) });
t.test('many small objects that add up: 4,000 squares fit, 4,400 and 9,000 are refused in under a second', () => {
  const ok = Engine.generate(small(4000));
  check(ok.canExport && ok.totals.stitches > 400000 && ok.totals.stitches <= LIMIT, '4,000 squares: ' + ok.totals.stitches + ' stitches, ' + codes(ok));
  equal(ok.objects.reduce((a, o) => a + o.stitches, 0), ok.totals.stitches, 'sum of the objects'); equal(irStitches(ok.ir), ok.totals.stitches, 'stitch data');
  const per = ok.totals.stitches / 4000;
  for (const n of [4400, 9000]) {
    const x = timed(() => Engine.generate(small(n))), w = refused(x.r, LIMIT, n, n + ' squares');
    check(w.stitches <= Math.ceil(per * n) + 200, n + ' squares: count reached ' + w.stitches + ' is more than the design holds');
    check(x.ms < 1000, n + ' squares refused after ' + x.ms.toFixed(0) + ' ms');
    if (n === 9000) t.note('many small objects: 4,000 squares = ' + ok.totals.stitches + ' stitches let through; 9,000 squares (about ' + Math.round(per * n) + ') refused in ' + x.ms.toFixed(0) + ' ms at ' + w.stitches);
  }
});

t.test('one huge fill: a plain one is skipped as TOO_LARGE as before; a comb of 990 teeth is refused by the total limit, quickly', () => {
  const plain = Engine.generate({ hoop: { width: 1000, height: 1000 }, objects: [{ type: 'rect', x: 5, y: 5, width: 990, height: 990, color: '#224488', fill: { spacing: 0.2 } }] });
  check(plain.warnings.some(w => w.code === 'TOO_LARGE') && !plain.warnings.some(w => w.code === 'TOO_MANY_STITCHES'), 'plain huge fill: ' + codes(plain));
  equal(plain.objects[0].skipped, true, 'the huge object is skipped');
  const pts = [[0, 0]]; for (let i = 0; i < 990; i++) pts.push([i, 400], [i + 0.5, 400], [i + 0.5, 1], [i + 1, 1]); pts.push([990, 0]);   // 990 teeth, 0.5 mm wide, 400 mm long
  const comb = { hoop: { width: 1000, height: 1000 }, objects: [{ type: 'polygon', points: pts.map(p => [p[0] + 5, p[1] + 5]), color: '#123456', fill: { angle: 0, spacing: 0.2 } }] };
  const x = timed(() => Engine.generate(comb));
  refused(x.r, LIMIT, 1, 'comb');
  check(x.ms < 1000, 'comb answered after ' + x.ms.toFixed(0) + ' ms');
  const one = { hoop: hoop300, objects: [{ type: 'ellipse', cx: 150, cy: 150, rx: 120, ry: 100, color: '#224488', fill: { spacing: 0.4 } }] }, n = Engine.generate(one).totals.stitches;
  refused(Engine.generate(one, { maxStitches: n - 1 }), n - 1, 1, 'one fill, limit one under its count'); check(sameIr(Engine.generate(one, { maxStitches: n }), Engine.generate(one)), 'one fill, limit at its count');
  t.note('one huge fill: comb of 990 teeth (0.5 x 400 mm each) answered in ' + x.ms.toFixed(0) + ' ms with ' + codes(x.r));
});

// The search: a limit must refuse exactly the designs that hold more stitches than it, whatever their shape.
// For every design: N = its real count. limit N and above: the result is the unlimited one, byte for byte.
// limit below N: refused, and the count reached lies in (limit, N].
{
  const cases = [];
  for (const k of Object.keys(K.designs)) cases.push({ key: k, design: K.designs[k] });
  for (const s of Object.keys(K.shapes)) for (const f of Object.keys(K.fills)) cases.push({ key: 'fill_' + s + '_' + f, design: K.fillDesign(s, f) });
  for (const k of T.compare) cases.push({ key: 'engine_' + k, design: T.designs[k] });
  const r = rnd(20261113), pick = a => a[Math.floor(r() * a.length)], num = (a, b) => +(a + r() * (b - a)).toFixed(2);
  const color = () => '#' + ('00000' + Math.floor(r() * 0xffffff).toString(16)).slice(-6);
  for (let i = 0; i < 120; i++) {
    const objects = [], n = 1 + Math.floor(r() * 7);
    for (let k = 0; k < n; k++) {
      const cx = num(40, 160), cy = num(40, 160), kind = pick(['rect', 'ellipse', 'star', 'comb', 'ring', 'satin', 'bean', 'run', 'both']);
      const fill = { angle: num(-90, 180), spacing: num(0.25, 1.6), stitchLength: num(1.5, 6), underlay: r() < 0.5 };
      if (kind === 'rect') objects.push({ type: 'rect', x: cx - num(2, 35), y: cy - num(2, 35), width: num(0.5, 70), height: num(0.5, 70), rotation: num(0, 90), color: color(), fill });
      else if (kind === 'ellipse') objects.push({ type: 'ellipse', cx, cy, rx: num(1, 38), ry: num(1, 38), rotation: num(0, 180), color: color(), fill });
      else if (kind === 'star') objects.push({ type: 'polygon', points: K.star(cx, cy, num(8, 38), num(1, 8), 3 + Math.floor(r() * 40)), color: color(), fill });
      else if (kind === 'comb') { const teeth = 2 + Math.floor(r() * 30), w = num(0.3, 1.5), h = num(5, 35), pts = [[0, 0]]; for (let q = 0; q < teeth; q++) pts.push([q * 2 * w, h], [q * 2 * w + w, h], [q * 2 * w + w, 1], [q * 2 * w + 2 * w, 1]); pts.push([teeth * 2 * w, 0]); objects.push({ type: 'polygon', points: pts.map(p => [+(cx - 35 + p[0]).toFixed(3), +(cy - 20 + p[1]).toFixed(3)]), color: color(), fill }); }
      else if (kind === 'ring') objects.push({ type: 'path', fillRule: 'evenodd', rings: [K.ring(cx, cy, num(15, 38), num(15, 38), 40), K.ring(cx, cy, num(2, 12), num(2, 12), 24)], color: color(), fill });
      else if (kind === 'both') objects.push({ type: 'circle', cx, cy, r: num(3, 30), color: color(), paint: 'both', fill, line: { type: pick(['satin', 'bean', 'running']), width: num(1, 5), color: color() } });
      else objects.push({ type: 'polyline', points: Array.from({ length: 2 + Math.floor(r() * 12) }, () => [num(10, 190), num(10, 190)]), color: color(), line: { type: kind === 'satin' ? 'satin' : kind === 'bean' ? 'bean' : 'running', width: num(1, 8), stitchLength: num(1, 7) } });
    }
    cases.push({ key: 'random_' + i, design: { name: 'Random ' + i, hoop: { width: 200, height: 200 }, objects } });
  }
  let designs = 0, limits = 0, refusals = 0, worst = 1, smallest = Infinity, largest = 0; const bad = [];
  for (const c of cases) {
    const ref = Engine.generate(c.design), N = ref.totals.stitches;
    if (N < 2) continue;
    designs++; smallest = Math.min(smallest, N); largest = Math.max(largest, N);
    const tries = new Set([N - 1, N, N + 1, Math.floor(N / 2), Math.floor(N * 0.9), 1, 1 + Math.floor(r() * (N + 20)), 1 + Math.floor(r() * (N + 20))]);
    for (const L of tries) {
      if (L < 1 || L >= LIMIT) continue;
      limits++;
      const got = Engine.generate(c.design, { maxStitches: L }), w = got.warnings.find(x => x.code === 'TOO_MANY_STITCHES');
      if (N > L) {
        refusals++;
        if (!w) { bad.push(c.key + ': ' + N + ' stitches let through a limit of ' + L); continue; }
        if (!(w.stitches > L && w.stitches <= N) || w.limit !== L) bad.push(c.key + ': limit ' + L + ', real count ' + N + ', count reached ' + w.stitches + ', limit reported ' + w.limit);
        if (got.totals.stitches !== 0 || got.ir.commands.length !== 3 || got.canExport || got.warnings.filter(x => x.severity === 'error').length !== 1 || got.objects.length !== ref.objects.length || !got.objects.every(o => o.skipped === true && o.stitches === 0)) bad.push(c.key + ': refused result is not empty at limit ' + L + ' (' + codes(got) + ')');
        worst = Math.min(worst, (w.stitches - L) / (N - L));
      } else {
        if (w) { bad.push(c.key + ': ' + N + ' stitches REFUSED by a limit of ' + L + ' (count reached ' + w.stitches + ')'); continue; }
        if (!sameIr(got, ref) || facts(got) !== facts(ref)) bad.push(c.key + ': a limit of ' + L + ' changed a design of ' + N + ' stitches');
      }
    }
  }
  t.test('search over ' + designs + ' designs (corpus shapes x fill settings, engine test designs, 120 random): a limit refuses exactly the designs above it and changes nothing else', () => {
    check(designs > 400 && refusals > 1500, 'only ' + designs + ' designs, ' + refusals + ' refusals');
    check(!bad.length, bad.length + ' wrong answers, e.g.\n' + bad.slice(0, 8).join('\n'));
  });
  t.note('limit search: ' + designs + ' designs of ' + smallest + ' to ' + largest + ' stitches, ' + limits + ' limits tried, ' + refusals + ' refusals, ' + bad.length + ' wrong; count reached never above the real count');
}

// time and memory of a refusal, in a fresh process each (peak memory of the whole node process)
{
  const child = name => {
    const src = 'const E=require(' + JSON.stringify(path.join(process.env.ADV_ENGINE_DIR || path.join(C.REPO, 'js', 'engine'), 'engine.js')) + '),T=require(' + JSON.stringify(path.join(C.REPO, 'tests', 'engine', 'designs.js')) + ');' +
      'const d=T.designs[' + JSON.stringify(name) + '];const t=process.hrtime.bigint();const r=E.generate(d);const ms=Number(process.hrtime.bigint()-t)/1e6;' +
      'const u=process.resourceUsage().maxRSS;console.log(JSON.stringify({ms:ms,rssMb:Math.round((u>1e7&&process.platform==="darwin"?u/1024:u)/1024),stitches:r.totals.stitches,codes:r.warnings.map(w=>w.code),reached:(r.warnings[0]||{}).stitches}))';
    return JSON.parse(execFileSync(process.execPath, ['-e', src], { encoding: 'utf8', timeout: 120000 }));
  };
  let tiny, heavy, err = null;
  try { tiny = child('patch'); heavy = child('heavy'); } catch (e) { err = e; }
  t.test('a design of about 1.9 million stitches is refused in well under a second, without a memory spike (fresh process)', () => {
    check(!err, 'child process failed: ' + (err && err.message));
    equal(heavy.codes.join(), 'TOO_MANY_STITCHES', 'warnings'); equal(heavy.stitches, 0, 'stitches');
    check(heavy.ms < 1000, 'refused after ' + heavy.ms.toFixed(0) + ' ms');
    check(heavy.rssMb < tiny.rssMb + 250, 'peak memory ' + heavy.rssMb + ' MB, a one-rectangle design peaks at ' + tiny.rssMb + ' MB');
  });
  if (!err) t.note('refusal of the 1.9 million stitch design: ' + heavy.ms.toFixed(0) + ' ms, peak process memory ' + heavy.rssMb + ' MB (a one-rectangle design: ' + tiny.rssMb + ' MB), count reached ' + heavy.reached);
}

/* =====================================================================  F3: palette notes  */
const line = (i, c) => ({ type: 'line', x1: 10 + (i % 7), y1: 3 + i * 1.1, x2: 60 + (i % 5), y2: 3 + i * 1.1, color: c, line: { type: 'running' } });
const colourDesign = cols => ({ name: 'Colours', hoop: { width: 100, height: 130 }, objects: cols.map((c, i) => line(i, c)) });
const FORMATS = ['pes', 'pes6', 'pec', 'dst'], ALL3 = 'pes,pec,pes6';

// Checks every statement of the two notes against the exported bytes. Returns what it found.
function checkColourNotes(r, what) {
  check(r.canExport, what + ': not exportable: ' + codes(r));
  const cols = r.ir.threads.map(x => x.color), distinct = [...new Set(cols)], N = cols.length;
  const bytes = {}; for (const f of FORMATS) bytes[f] = Engine.export(r, { format: f }).bytes;
  const v1 = D.decodePes(bytes.pes), v6 = D.decodePes(bytes.pes6), pc = D.decodePec(bytes.pec), ds = D.decodeDst(bytes.dst);
  for (const [k, d] of [['pes', v1], ['pes6', v6], ['pec', pc], ['dst', ds]]) {
    check(!d.problems.length, what + ' ' + k + ': ' + d.problems.slice(0, 3).join('; '));
    // the stops: one colour change record between every two colour blocks, whatever the palette entries are
    equal(d.ops.filter(o => o[0] === 'C').length, N - 1, what + ' ' + k + ': colour change records');
  }
  equal(Number(ds.header.CO), N - 1, what + ': DST header CO');
  // what the machine reads: one palette byte per colour block, the same in pes, pes6 and pec, as the format notes predict
  const want = P.uniquePalette(cols);
  for (const [k, d] of [['pes', v1], ['pes6', v6], ['pec', pc]]) equal(d.palette.join(), want.join(), what + ' ' + k + ': PEC palette bytes');
  // PES v6 also stores the exact colours; the PES v1 design section stores the nearest palette entry
  equal(v6.v6.threads.map(x => '#' + ('00000' + x.toString(16)).slice(-6)).join(), cols.join(), what + ': PES v6 thread table');
  equal(v6.v6.addendumRgb.map(x => '#' + ('00000' + x.toString(16)).slice(-6)).join(), cols.join(), what + ': PES v6 colour addendum');
  equal([...new Set(v1.seg.sections.map(s => s.code))].sort((a, b) => a - b).join(), [...new Set(cols.map(P.plain))].sort((a, b) => a - b).join(), what + ': PES v1 section colour codes');
  const shown = {}; cols.forEach((c, i) => { if (shown[c] === undefined) shown[c] = v1.palette[i]; else equal(v1.palette[i], shown[c], what + ': one colour, two palette entries'); });
  // expected notes, from the bytes
  const group = fn => { const m = new Map(); for (const c of distinct) { const k = fn(c); if (!m.has(k)) m.set(k, []); m.get(k).push(c); } return [...m].filter(e => e[1].length > 1); };
  const expect = [], inPec = new Set();
  for (const [i, list] of group(c => shown[c])) { expect.push({ i, list: list.join(), formats: ALL3 }); list.forEach(c => inPec.add(c)); }
  for (const [i, list] of group(P.plain)) if (!expect.some(g => g.i === i && g.list === list.join())) expect.push({ i, list: list.join(), formats: 'pes' });
  const moved = distinct.filter(c => shown[c] !== P.plain(c) && !inPec.has(c));
  const key = g => g.formats.length + ':' + g.i + ':' + g.list;
  const merged = r.warnings.filter(w => w.code === 'COLORS_MERGED'), subst = r.warnings.filter(w => w.code === 'COLOR_SUBSTITUTED');
  check(merged.length <= 1 && subst.length <= 1, what + ': a note appears twice');
  const got = merged.length ? merged[0].groups.map(g => ({ i: g.paletteIndex, list: g.colors.join(), formats: g.formats.join() })) : [];
  equal(got.map(key).sort().join(' | '), expect.map(key).sort().join(' | '), what + ': COLORS_MERGED groups');
  if (merged.length) {
    const w = merged[0];
    equal(w.severity, 'warning', what + ': COLORS_MERGED severity');
    check(/still stops at every colour change/.test(w.message), what + ': the message does not say that the machine still stops: ' + w.message);
    check(w.message.indexOf(w.groups[0].paletteName) >= 0 && w.message.indexOf(w.groups[0].colors[0]) >= 0, what + ': message does not name the first group: ' + w.message);
    for (const g of w.groups) { equal(g.paletteName, P.nameOf(g.paletteIndex), what + ': palette name'); equal(g.paletteColor, P.hexOf(g.paletteIndex), what + ': palette colour'); }
  }
  equal(subst.length ? subst[0].colors.map(x => x.color).join() : '', moved.join(), what + ': COLOR_SUBSTITUTED colours');
  if (subst.length) {
    const w = subst[0];
    equal(w.severity, 'info', what + ': COLOR_SUBSTITUTED severity'); equal(w.formats.join(), ALL3, what + ': COLOR_SUBSTITUTED formats');
    for (const x of w.colors) {
      equal(x.paletteIndex, shown[x.color], what + ': entry the file gives ' + x.color); equal(x.nearestIndex, P.plain(x.color), what + ': nearest entry of ' + x.color);
      equal(x.paletteName, P.nameOf(x.paletteIndex), what + ': name'); equal(x.paletteColor, P.hexOf(x.paletteIndex), what + ': colour'); equal(x.nearestName, P.nameOf(x.nearestIndex), what + ': nearest name');
    }
    check(w.message.indexOf(w.colors[0].color) >= 0 && w.message.indexOf(w.colors[0].paletteName) >= 0, what + ': message does not name the first colour: ' + w.message);
  }
  return { bytes, N, merged: merged[0], subst: subst[0], expect, moved };
}

const near = Engine.generate(colourDesign(['#ff0000', '#fe0000', '#00ff00']));
const c65 = Array.from({ length: 65 }, (_, i) => '#' + ('00000' + ((i * 0x3a5f71 + 0x102030) & 0xffffff).toString(16)).slice(-6));
const many = Engine.generate(colourDesign(c65));
let nearFound, manyFound;
t.test('two near-identical colours: one group for the PES v1 design section, two different entries on the machine, both stops kept (pes, pes6, pec, dst)', () => {
  nearFound = checkColourNotes(near, 'near');
  const g = nearFound.merged.groups;
  equal(g.length, 1, 'groups'); equal(g[0].colors.join(), '#ff0000,#fe0000', 'colours'); equal(g[0].formats.join(), 'pes', 'formats'); equal(g[0].paletteName, 'Red', 'name');
  equal(nearFound.subst.colors.length, 1, 'substituted colours'); equal(nearFound.subst.colors[0].color, '#fe0000', 'substituted colour');
  equal(near.ok, true, 'ok'); equal(near.warnings.filter(w => w.severity === 'error').length, 0, 'errors');
});
t.test('65 colours: the Brother list has 64 entries, so two colours share one in pes, pes6 and pec; all 64 stops are kept', () => {
  manyFound = checkColourNotes(many, '65');
  equal(new Set(c65).size, 65, 'distinct colours in the test'); equal(manyFound.N, 65, 'threads');
  const all = manyFound.merged.groups.filter(g => g.formats.join() === ALL3);
  check(all.length >= 1, 'no group merged in the PEC block'); check(all.some(g => g.colors.includes(c65[64])), 'the 65th colour is not in a merged group');
  equal(new Set(D.decodePes(manyFound.bytes.pes).palette).size, 64, 'different palette bytes in the file');
});
{
  const files = {};
  if (nearFound) for (const f of FORMATS) files['near.' + (f === 'pes6' ? 'v6.pes' : f)] = nearFound.bytes[f];
  if (manyFound) for (const f of FORMATS) files['many.' + (f === 'pes6' ? 'v6.pes' : f)] = manyFound.bytes[f];
  const py = Object.keys(files).length ? C.pyRead(files) : null;
  if (!py) t.skip('pyembroidery reads the colour changes', 'no python with pyembroidery');
  else t.test('pyembroidery reads one colour change per colour block from all eight files, and the exact colours from PES v6', () => {
    for (const [tag, n, cols] of [['near', 3, ['#ff0000', '#fe0000', '#00ff00']], ['many', 65, c65]]) for (const ext of ['pes', 'v6.pes', 'pec', 'dst']) {
      const rec = py[tag + '.' + ext]; check(rec && !rec.error, tag + '.' + ext + ': ' + (rec && rec.error));
      equal(rec.cmds.split('C').length - 1, n - 1, tag + '.' + ext + ': colour changes read');
      if (ext === 'v6.pes') equal(rec.threads.join(), cols.join(), tag + ': PES v6 colours read');
      if (ext === 'pes' || ext === 'pec') equal(rec.threads.join(), P.uniquePalette(cols).map(P.hexOf).join(), tag + '.' + ext + ': palette colours read');
    }
  });
}
t.test('no note for ordinary designs, for a colour used again later, or for a design that cannot be exported', () => {
  for (const k of T.compare) { const r = Engine.generate(T.designs[k]); check(!r.warnings.some(w => w.code === 'COLORS_MERGED' || w.code === 'COLOR_SUBSTITUTED'), k + ': ' + codes(r)); }
  for (const k of Object.keys(K.designs)) { const r = Engine.generate(K.designs[k]); if (r.canExport) checkColourNotes(r, k); }
  const again = Engine.generate(colourDesign(['#1d4ed8', '#ef4444', '#1d4ed8', '#ef4444']));
  equal(again.ir.threads.length, 4, 'threads'); check(!again.warnings.some(w => w.code === 'COLORS_MERGED' || w.code === 'COLOR_SUBSTITUTED'), 'reused colour: ' + codes(again)); checkColourNotes(again, 'again');
  const one = Engine.generate(colourDesign(['#fe0000'])); check(!one.warnings.length, 'one colour: ' + codes(one));
  const over = Engine.generate(colourDesign(['#ff0000', '#fe0000']), { maxStitches: 5 }); equal(codes(over), 'TOO_MANY_STITCHES:error', 'refused design');
  const prog = []; Engine.generate(T.designs.badge, { maxStitches: 5, onProgress: (a, b) => prog.push(a + '/' + b) }); equal(prog[prog.length - 1], '4/4', 'progress of a refused design ends at the total');
});
{
  const r = rnd(8303), bad = []; let designs = 0, withMerged = 0, withPec = 0, withSubst = 0, most = 0;
  for (let i = 0; i < 140; i++) {
    const n = i < 100 ? 2 + Math.floor(r() * 30) : 50 + Math.floor(r() * 45), cols = [];
    for (let k = 0; k < n; k++) {
      const how = r(); let c;
      if (how < 0.2 && cols.length) c = cols[Math.floor(r() * cols.length)];
      else if (how < 0.6) { const e = P.RGB[1 + Math.floor(r() * 64)]; c = '#' + e.map(v => ('0' + Math.max(0, Math.min(255, v + Math.floor(r() * 9) - 4)).toString(16)).slice(-2)).join(''); }
      else c = '#' + ('00000' + Math.floor(r() * 0x1000000).toString(16)).slice(-6);
      if (cols.length && cols[cols.length - 1] === c) continue;
      cols.push(c);
    }
    if (cols.length < 2) continue;
    try {
      const f = checkColourNotes(Engine.generate(colourDesign(cols)), 'random ' + i);
      designs++; most = Math.max(most, f.N); if (f.merged) withMerged++; if (f.expect.some(g => g.formats === ALL3)) withPec++; if (f.subst) withSubst++;
    } catch (e) { bad.push(String(e.message)); }
  }
  t.test('140 random colour lists (2 to ' + most + ' colour blocks, many close to a Brother colour): every note agrees with the exported bytes, every stop is in every file', () => {
    check(!bad.length, bad.length + ' designs disagree, e.g.\n' + bad.slice(0, 5).join('\n'));
    check(designs >= 130 && withMerged > 20 && withPec > 5 && withSubst > 20, 'the search is too weak: ' + [designs, withMerged, withPec, withSubst]);
  });
  t.note('palette notes: ' + designs + ' random colour lists; ' + withMerged + ' with COLORS_MERGED (' + withPec + ' merged in the PEC block), ' + withSubst + ' with COLOR_SUBSTITUTED; ' + bad.length + ' disagreements with the files');
}

/* =====================================================================  F1: DST header extents  */
t.test('DST header: +Y is the extent below the start point and -Y the extent above it, the same bytes as pyembroidery writes (records store y up, so the two names are the other way round there)', () => {
  let seen = 0, odd = 0;
  for (let h = 12; h <= 13; h += 0.1) {
    const r = Engine.generate({ hoop: { width: 100, height: 100 }, objects: [{ type: 'rect', x: 10, y: 10, width: 31.3, height: +h.toFixed(1), color: '#000000' }, { type: 'line', x1: 20, y1: 60.05, x2: 70, y2: 60.05, color: '#000000' }] });
    const d = D.decodeDst(Engine.export(r, { format: 'dst' }).bytes), hd = d.header;
    equal(d.problems.length, 0, 'problems: ' + d.problems.join('; '));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;       // decoder positions: start point 0,0, y DOWN
    for (const o of d.ops) if (o[0] === 'S') { minX = Math.min(minX, o[1]); maxX = Math.max(maxX, o[1]); minY = Math.min(minY, o[2]); maxY = Math.max(maxY, o[2]); }
    equal(Number(hd['+X']), Math.abs(maxX), '+X'); equal(Number(hd['-X']), Math.abs(minX), '-X');
    equal(Number(hd['+Y']), Math.abs(maxY), '+Y (extent below the start point)'); equal(Number(hd['-Y']), Math.abs(minY), '-Y (extent above the start point)');
    check(Math.abs(Number(hd['+Y']) - Number(hd['-Y'])) <= 1 && Math.abs(Number(hd['+X']) - Number(hd['-X'])) <= 1, 'the design is not centred on the start point: ' + JSON.stringify(hd));
    seen++; if (hd['+Y'] !== hd['-Y']) odd++;
  }
  check(seen >= 10 && odd >= 2, 'no design with different +Y and -Y among ' + seen + ' (' + odd + '): the test would prove nothing');
  t.note('DST header: +Y / -Y differ in ' + odd + ' of ' + seen + ' designs, by 1 unit (0.1 mm) at most; convention kept as pyembroidery 1.5.0 writes it (byte identity is checked by the oracle suite)');
});

module.exports = t.done();
