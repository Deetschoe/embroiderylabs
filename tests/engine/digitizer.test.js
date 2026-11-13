/*
 * Digitizer property tests: every shape in the corpus, several stitch angles, lines of every type,
 * seeded random polygons, and hostile input. Node only.
 */
'use strict';
const assert = require('assert');
const path = require('path');
const C = require('./corpus.js');
const Engine = require(path.join(__dirname, '..', '..', 'js', 'engine', 'engine.js'));

const MAX_STITCH_MM = 12.1;   // hard limit of the DST format
const SOFT_MAX_MM = 7.0;      // nothing the digitizer plans on purpose is longer than this
const codes = r => r.warnings.map(w => w.code);

// checks that hold for every result, whatever the input
function assertSound(r, label) {
  const problems = Engine.validate(r);
  assert.deepStrictEqual(problems, [], label + ': IR invariants broken: ' + problems.slice(0, 3).join('; '));
  const c = r.ir.commands;
  assert.ok(c instanceof Int32Array, label + ': commands must be an Int32Array');
  for (let i = 0; i < c.length; i++) assert.ok(Number.isInteger(c[i]), label + ': non-integer in IR');
  const L = C.lengths(C.segments(r.ir));
  assert.ok(L.max <= MAX_STITCH_MM + 0.05, label + ': stitch of ' + L.max.toFixed(2) + ' mm');
  assert.strictEqual(L.zero, 0, label + ': zero-length stitch');
  const n = C.counts(r.ir);
  assert.strictEqual(r.totals.stitches, n.STITCH, label + ': totals.stitches');
  assert.strictEqual(r.totals.trims, n.TRIM, label + ': totals.trims');
  assert.strictEqual(r.totals.colorChanges, n.COLOR_CHANGE, label + ': totals.colorChanges');
  assert.strictEqual(r.threads.length, r.ir.threads.length, label + ': thread list');
  assert.strictEqual(r.threads.reduce((a, t) => a + t.stitches, 0), n.STITCH, label + ': per-thread stitch counts');
  assert.strictEqual(r.objects.reduce((a, o) => a + o.stitches, 0), n.STITCH, label + ': per-object stitch counts');
  for (const k of ['threadLengthM', 'timeMin', 'longestStitchMm']) assert.ok(Number.isFinite(r.totals[k]) && r.totals[k] >= 0, label + ': totals.' + k);
  assert.strictEqual(r.canExport, !r.warnings.some(w => w.severity === 'error'), label + ': canExport');
  for (const w of r.warnings) { assert.ok(typeof w.code === 'string' && typeof w.message === 'string' && w.message.length > 0, label + ': warning shape'); assert.ok(['error', 'warning', 'info'].includes(w.severity), label + ': severity'); }
  if (n.STITCH) { assert.ok(r.bounds && [r.bounds.minX, r.bounds.minY, r.bounds.maxX, r.bounds.maxY, r.bounds.width, r.bounds.height].every(Number.isFinite), label + ': bounds'); }
  else assert.strictEqual(r.bounds, null, label + ': bounds of an empty design');
  return { L, n };
}

module.exports = {
  name: 'digitizer: shapes -> stitches',
  run(t) {
    // ---------------------------------------------------------------- fills over the corpus
    const angles = [0, 45, 90, 30];
    let minCov = 100, minCovAt = '', fillRuns = 0, maxFillStitch = 0;
    for (const [name, shape] of Object.entries(C.FILL_SHAPES)) {
      t.test('fill ' + name + ': valid, inside the outline, covered, locked (angles ' + angles.join('/') + ')', () => {
        for (const angle of angles) {
          const label = name + '@' + angle;
          const r = Engine.generate(C.fillDesign(shape, { angle }));
          const { L, n } = assertSound(r, label);
          assert.ok(n.STITCH > 20, label + ': produced only ' + n.STITCH + ' stitches');
          assert.ok(L.max <= SOFT_MAX_MM, label + ': fill stitch of ' + L.max.toFixed(2) + ' mm');
          assert.ok(L.min >= 0.2, label + ': stitch of ' + L.min.toFixed(2) + ' mm');
          const segs = C.segments(r.ir);
          const out = C.outside(segs, shape.rings, shape.rule);
          assert.strictEqual(out.count, 0, label + ': ' + out.count + ' stitches leave the shape (worst ' + out.worstMm + ' mm)');
          const cov = C.coverage(segs, shape.rings, shape.rule, 0.4, angle);
          if (cov.samples > 50) { assert.ok(cov.pct >= 98, label + ': row coverage ' + cov.pct.toFixed(2) + '%'); if (cov.pct < minCov) { minCov = cov.pct; minCovAt = label; } }
          assert.deepStrictEqual(C.lockProblems(r.ir), [], label + ': lock stitches');
          assert.deepStrictEqual(codes(r).filter(c => c !== 'THIN_FILL'), [], label + ': unexpected warnings');
          assert.strictEqual(r.canExport, true, label);
          if (L.max > maxFillStitch) maxFillStitch = L.max;
          fillRuns++;
        }
      });
    }
    t.test('fills: one thread run per island (no trims inside a connected shape)', () => {
      for (const [name, shape] of Object.entries(C.FILL_SHAPES)) {
        if (name.startsWith('sliver')) continue;
        const islands = name === 'twoIslands' ? 2 : 1;
        for (const angle of [0, 45, 90]) assert.strictEqual(Engine.generate(C.fillDesign(shape, { angle })).totals.trims, islands, name + '@' + angle);
      }
    });
    t.test('fills: travel never lies on top of finished rows (underpath only)', () => {
      for (const [name, shape] of Object.entries(C.FILL_SHAPES)) for (const angle of [0, 45, 90, 30]) {
        const st = Engine.Digitizer.fillShape(shape.rings.map(r => r.map(p => ({ x: p[0], y: p[1] }))), { angleDeg: angle, rule: shape.rule || 'nonzero' }).stats;
        assert.ok(st.travelOverSewnMm <= 2.0, name + '@' + angle + ': ' + st.travelOverSewnMm.toFixed(1) + ' mm of travel over sewn fill');
      }
    });
    t.test('fill: holes stay empty (donut, both fill rules)', () => {
      for (const key of ['donut', 'donutEvenOdd']) {
        const r = Engine.generate(C.fillDesign(C.FILL_SHAPES[key]));
        let inHole = 0;
        for (const run of C.runs(r.ir)) for (const p of run.pts) if (Math.hypot(p[0] - 50, p[1] - 50) < 12 - 0.7) inHole++;
        assert.strictEqual(inHole, 0, key + ': ' + inHole + ' needle points in the hole');
      }
    });
    t.test('fill: nonzero and evenodd differ on a pentagram (centre filled vs empty)', () => {
      const near = r => C.runs(r.ir).reduce((a, run) => a + run.pts.filter(p => Math.hypot(p[0] - 50, p[1] - 50) < 5).length, 0);
      assert.ok(near(Engine.generate(C.fillDesign(C.FILL_SHAPES.pentagram))) > 20);
      assert.strictEqual(near(Engine.generate(C.fillDesign(C.FILL_SHAPES.pentagramEvenOdd))), 0);
    });
    t.test('fill: angle turns the rows', () => {
      const share = angle => { // share of stitch length lying along the x axis
        const segs = C.segments(Engine.generate(C.fillDesign(C.FILL_SHAPES.rect80, { angle, underlay: false })).ir);
        let h = 0, all = 0; for (const s of segs) { all += s.len; if (Math.abs(s.a[1] - s.b[1]) < 0.06) h += s.len; } return h / all;
      };
      assert.ok(share(0) > 0.9, 'angle 0 rows are horizontal'); assert.ok(share(90) < 0.1, 'angle 90 rows are vertical');
    });
    t.test('fill: row spacing and stitch length are honoured', () => {
      const count = fill => Engine.generate(C.fillDesign(C.FILL_SHAPES.rect80, Object.assign({ underlay: false }, fill))).totals.stitches;
      const base = count({}), wide = count({ spacing: 0.8 }), long = count({ stitchLength: 6 });
      assert.ok(Math.abs(wide / base - 0.5) < 0.06, 'double spacing ~ half the stitches (' + (wide / base).toFixed(3) + ')');
      assert.ok(long / base < 0.62, 'double stitch length ~ half the stitches (' + (long / base).toFixed(3) + ')');
      const L = C.lengths(C.segments(Engine.generate(C.fillDesign(C.FILL_SHAPES.rect80, { stitchLength: 2 })).ir));
      assert.ok(L.max <= 3.65, 'longest ' + L.max); // the underlay runs at 3.5 mm, snapped to the 0.1 mm grid
    });
    t.test('fill: underlay adds stitches below the top rows and can be switched off', () => {
      const on = Engine.generate(C.fillDesign(C.FILL_SHAPES.rect80, { underlay: true })).totals.stitches;
      const off = Engine.generate(C.fillDesign(C.FILL_SHAPES.rect80, { underlay: false })).totals.stitches;
      assert.ok(on > off * 1.08 && on < off * 1.4, on + ' vs ' + off);
    });
    t.test('fill: pull compensation widens the rows by the amount asked for', () => {
      const w = pc => Engine.generate(C.fillDesign(C.FILL_SHAPES.rect80, { pullComp: pc, underlay: false })).bounds.width;
      assert.ok(Math.abs(w(0) - 80) < 0.11, 'no compensation: ' + w(0)); assert.ok(Math.abs(w(0.5) - 81) < 0.11, '0.5 mm each side: ' + w(0.5));
    });
    t.test('fill: 100 x 100 mm area inside the time budget', () => {
      const d = C.fillDesign(C.HUGE_RECT, { pullComp: 0 });
      Engine.generate(d); // warm up
      let best = Infinity, r;
      for (let i = 0; i < 5; i++) { const t0 = process.hrtime.bigint(); r = Engine.generate(d); best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6); }
      assertSound(r, 'rect99');
      t.note('99 x 99 mm fill', r.totals.stitches + ' stitches in ' + best.toFixed(1) + ' ms (budget 500 ms)');
      assert.ok(best < 500, 'took ' + best.toFixed(0) + ' ms');
      const big = { hoop: { width: 200, height: 200 }, objects: [{ type: 'ellipse', cx: 100, cy: 100, rx: 95, ry: 95, color: '#333333' }] };
      const t0 = process.hrtime.bigint(); const rb = Engine.generate(big); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assertSound(rb, 'circle190');
      t.note('190 mm circle fill', rb.totals.stitches + ' stitches in ' + ms.toFixed(1) + ' ms (budget 2000 ms)');
      assert.ok(ms < 2000, 'took ' + ms.toFixed(0) + ' ms');
    });
    t.test('fill: a path with 20,000 points (imported artwork) is digitized quickly', () => {
      const ring = Array.from({ length: 20000 }, (_, i) => { const a = 2 * Math.PI * i / 20000, r = 35 + 4 * Math.sin(a * 40); return [50 + r * Math.cos(a), 50 + r * Math.sin(a)]; });
      const t0 = process.hrtime.bigint(); const r = Engine.generate(C.fillDesign({ rings: [ring] })); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assertSound(r, 'gear'); assert.strictEqual(C.outside(C.segments(r.ir), [ring]).count, 0);
      t.note('20,000-point outline fill', r.totals.stitches + ' stitches in ' + ms.toFixed(1) + ' ms (budget 3000 ms)');
      assert.ok(ms < 3000, 'took ' + ms.toFixed(0) + ' ms');
    });

    // ---------------------------------------------------------------- seeded random polygons
    t.test('fill: 120 seeded random polygons (simple and self-crossing), random settings', () => {
      let sewn = 0;
      for (let seed = 1; seed <= 120; seed++) {
        const rnd = C.rng(seed * 7919), pts = C.randomPolygon(seed);
        const rule = seed % 2 ? 'nonzero' : 'evenodd';
        const fill = { angle: Math.floor(rnd() * 180), spacing: 0.3 + rnd() * 0.5, stitchLength: 2 + rnd() * 3, underlay: rnd() < 0.7, pullComp: rnd() * 0.4 };
        const r = Engine.generate({ hoop: C.HOOP, objects: [{ type: 'polygon', points: pts, fillRule: rule, color: '#447799', fill }] });
        const label = 'seed ' + seed;
        assertSound(r, label);
        if (!r.totals.stitches) continue;
        sewn++;
        const out = C.outside(C.segments(r.ir), [pts], rule, 0.4 + fill.pullComp);
        assert.strictEqual(out.count, 0, label + ': ' + out.count + ' stitches leave the shape (worst ' + out.worstMm + ' mm)');
        assert.deepStrictEqual(C.lockProblems(r.ir), [], label + ': lock stitches');
      }
      assert.ok(sewn >= 110, 'only ' + sewn + ' of 120 produced stitches');
    });

    // ---------------------------------------------------------------- lines
    for (const type of ['running', 'bean', 'satin']) {
      t.test('line ' + type + ': every open path is valid, on the path and locked', () => {
        for (const [name, pts] of Object.entries(C.LINE_PATHS)) {
          const width = 3, label = type + ' ' + name;
          const r = Engine.generate(C.lineDesign(pts, { type, width }));
          const { L, n } = assertSound(r, label);
          assert.ok(n.STITCH >= 5, label + ': ' + n.STITCH + ' stitches');
          assert.strictEqual(n.TRIM, 1, label + ': one continuous run');
          assert.ok(L.max <= (type === 'satin' ? SOFT_MAX_MM : 2.65), label + ': longest ' + L.max.toFixed(2));
          const reach = type === 'satin' ? width / 2 + 0.2 + 0.25 : 0.15;
          let far = 0; for (const run of C.runs(r.ir)) for (const p of run.pts) far = Math.max(far, C.distToPath(p, pts, false));
          assert.ok(far <= reach + (name === 'scribble' || name === 'spiral' || name === 'wave' ? 0.25 : 0), label + ': needle point ' + far.toFixed(2) + ' mm from the path');
          assert.deepStrictEqual(C.lockProblems(r.ir), [], label + ': lock stitches');
        }
      });
    }
    t.test('line running: stitch length is honoured and corners get a needle point', () => {
      const pts = C.LINE_PATHS.elbow;
      for (const len of [1.5, 2.5, 4]) {
        const r = Engine.generate(C.lineDesign(pts, { type: 'running', stitchLength: len }));
        const L = C.lengths(C.segments(r.ir)); assert.ok(L.max <= len + 0.11, 'len ' + len + ': longest ' + L.max);
        const corner = C.runs(r.ir)[0].pts.some(p => Math.hypot(p[0] - 10, p[1] - 20) < 0.08); assert.ok(corner, 'corner (10,20) missing at len ' + len);
      }
    });
    t.test('line bean: three passes over every stitch', () => {
      const run = Engine.generate(C.lineDesign(C.LINE_PATHS.straight, { type: 'running' })).totals.stitches;
      const bean = Engine.generate(C.lineDesign(C.LINE_PATHS.straight, { type: 'bean' })).totals.stitches;
      assert.ok(bean > run * 2.5 && bean < run * 3.2, run + ' -> ' + bean);
    });
    t.test('line satin: column has the asked width, density and underlay', () => {
      const pts = [[10, 50], [90, 50]];
      const r = Engine.generate(C.lineDesign(pts, { type: 'satin', width: 4, spacing: 0.4 }));
      assert.ok(Math.abs(r.bounds.height - 4.4) < 0.11, 'width 4 + 2 x 0.2 pull compensation, got ' + r.bounds.height);
      const top = C.segments(r.ir).filter(s => Math.abs(s.a[1] - s.b[1]) > 4.0).length; // full-width stitches
      assert.ok(Math.abs(top - 2 * 80 / 0.4) < 12, 'about 400 full-width stitches for 80 mm at 0.4 mm, got ' + top);
      const noUnder = Engine.generate(C.lineDesign(pts, { type: 'satin', width: 4, underlay: false })).totals.stitches;
      assert.ok(r.totals.stitches > noUnder + 30, 'underlay adds stitches: ' + r.totals.stitches + ' vs ' + noUnder);
      const dense = Engine.generate(C.lineDesign(pts, { type: 'satin', width: 4, spacing: 0.8, underlay: false })).totals.stitches;
      assert.ok(Math.abs(dense / noUnder - 0.5) < 0.05, 'double spacing ~ half the stitches');
    });
    t.test('line satin: wide columns are split, very wide ones clamped, narrow ones become a triple run', () => {
      const pts = [[10, 50], [90, 50]];
      const wide = Engine.generate(C.lineDesign(pts, { type: 'satin', width: 10 }));
      assert.ok(codes(wide).includes('SATIN_TOO_WIDE')); assert.ok(C.lengths(C.segments(wide.ir)).max <= SOFT_MAX_MM + 0.05, 'split stitches');
      const huge = Engine.generate(C.lineDesign(pts, { type: 'satin', width: 30 }));
      assert.ok(codes(huge).includes('SATIN_TOO_WIDE')); assert.ok(huge.bounds.height <= 12.6, 'clamped to 12 mm, got ' + huge.bounds.height);
      const narrow = Engine.generate(C.lineDesign(pts, { type: 'satin', width: 0.6 }));
      assert.ok(codes(narrow).includes('SATIN_TOO_NARROW')); assert.ok(narrow.bounds.height <= 0.11, 'sewn on the centre line');
      assert.deepStrictEqual(codes(Engine.generate(C.lineDesign(pts, { type: 'satin', width: 3 }))), []);
    });
    t.test('line: closed outlines close (rect, ellipse, polygon) for every type', () => {
      for (const type of ['running', 'bean', 'satin']) for (const obj of [
        { type: 'rect', x: 20, y: 20, width: 40, height: 30 }, { type: 'ellipse', cx: 50, cy: 50, rx: 25, ry: 15 }, { type: 'polygon', points: C.star(50, 50, 30, 12) },
      ]) {
        const r = Engine.generate({ hoop: C.HOOP, objects: [Object.assign({ color: '#101010', paint: 'line', line: { type, width: 2.5 } }, obj)] });
        const label = type + ' ' + obj.type; assertSound(r, label);
        assert.strictEqual(r.totals.trims, 1, label);
        const run = C.runs(r.ir)[0].pts, a = run[0], b = run[run.length - 1];
        assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < (type === 'satin' ? 4.5 : 0.7), label + ': start and end are ' + Math.hypot(a[0] - b[0], a[1] - b[1]).toFixed(2) + ' mm apart');
      }
    });

    // ---------------------------------------------------------------- paint modes, objects, colours
    t.test("paint 'both': fill first, then the outline on top, in the line colour", () => {
      const r = Engine.generate({ hoop: C.HOOP, objects: [{ type: 'rect', x: 20, y: 20, width: 40, height: 30, color: '#ff0000', paint: 'both', line: { type: 'satin', width: 2, color: '#0000ff' } }] });
      assertSound(r, 'both');
      assert.deepStrictEqual(r.threads.map(x => x.color), ['#ff0000', '#0000ff']);
      const rs = C.runs(r.ir); assert.strictEqual(rs.length, 2);
      const edge = p => C.distToRings(p, [C.rect(20, 20, 40, 30)]);
      assert.ok(rs[1].pts.every(p => edge(p) <= 1.5), 'second run hugs the outline');
      assert.ok(rs[0].pts.some(p => edge(p) > 8), 'first run covers the middle');
      const same = Engine.generate({ hoop: C.HOOP, objects: [{ type: 'ellipse', cx: 50, cy: 50, rx: 20, ry: 14, color: '#00aa00', paint: 'both', line: { type: 'running' } }] });
      assertSound(same, 'both same colour'); assert.strictEqual(same.threads.length, 1);
      const pts = C.runs(same.ir).reduce((a, x) => a.concat(x.pts), []), tail = pts.slice(-40);
      assert.ok(tail.every(p => C.distToRings(p, [C.ellipse(50, 50, 20, 14, 256)]) < 0.3), 'the outline is sewn last');
    });
    t.test("compound path 'O': outline follows the outer ring and the hole", () => {
      const O = { type: 'path', rings: [C.ellipse(50, 50, 30, 30), C.ellipse(50, 50, 12, 12).reverse()], color: '#222222', paint: 'both', line: { type: 'satin', width: 2 } };
      const r = Engine.generate({ hoop: C.HOOP, objects: [O] });
      assertSound(r, 'O');
      const near = rad => C.runs(r.ir).some(run => run.pts.length > 50 && run.pts.every(p => Math.abs(Math.hypot(p[0] - 50, p[1] - 50) - rad) < 1.6));
      assert.ok(near(30) && near(12), 'one satin run per ring');
      const rings = Engine.generate({ hoop: C.HOOP, objects: [Object.assign({}, O, { rings: [{ points: C.ellipse(50, 50, 30, 30), closed: true }, { points: C.LINE_PATHS.straight, closed: false }], paint: 'line', line: { type: 'running' } })] });
      assertSound(rings, 'mixed rings'); assert.strictEqual(rings.totals.trims, 2);
    });
    t.test('objects sew in list order; same colour does not add a colour change; ids are reported', () => {
      const objs = [
        { id: 'a', type: 'rect', x: 10, y: 10, width: 20, height: 20, color: '#FF0000' },
        { id: 'b', type: 'rect', x: 60, y: 10, width: 20, height: 20, color: 'f00' },
        { id: 'c', type: 'rect', x: 10, y: 60, width: 20, height: 20, color: '#0000ff' },
        { id: 'd', type: 'rect', x: 60, y: 60, width: 20, height: 20, color: '#ff0000' },
      ];
      const r = Engine.generate({ hoop: C.HOOP, objects: objs });
      assertSound(r, 'order');
      assert.deepStrictEqual(r.threads.map(x => x.color), ['#ff0000', '#0000ff', '#ff0000']);
      assert.strictEqual(r.totals.colorChanges, 2); assert.strictEqual(r.totals.colors, 3); assert.strictEqual(r.totals.trims, 4);
      assert.deepStrictEqual(r.objects.map(o => o.id), ['a', 'b', 'c', 'd']); assert.ok(r.objects.every(o => o.stitches > 100 && !o.skipped));
      const cx = C.runs(r.ir).map(run => run.pts.reduce((a, p) => a + p[0], 0) / run.pts.length > 50);
      assert.deepStrictEqual(cx, [false, true, false, true], 'runs follow the object order');
    });
    t.test('rect and ellipse rotation; negative sizes; circle alias', () => {
      const r = Engine.generate({ hoop: C.HOOP, objects: [{ type: 'rect', x: 30, y: 45, width: 40, height: 10, rotation: 90, fill: { pullComp: 0 } }] });
      assert.ok(Math.abs(r.bounds.width - 10) < 0.3 && Math.abs(r.bounds.height - 40) < 0.5, JSON.stringify(r.bounds));
      const e = Engine.generate({ hoop: C.HOOP, objects: [{ type: 'ellipse', cx: 50, cy: 50, rx: 30, ry: 10, rotation: 90, fill: { pullComp: 0 } }] });
      assert.ok(Math.abs(e.bounds.width - 20) < 0.5 && Math.abs(e.bounds.height - 60) < 0.5, JSON.stringify(e.bounds));
      const neg = Engine.generate({ hoop: C.HOOP, objects: [{ type: 'rect', x: 60, y: 60, width: -30, height: -20, fill: { pullComp: 0 } }] });
      assert.ok(Math.abs(neg.bounds.minX - 30) < 0.11 && Math.abs(neg.bounds.minY - 40) < 0.3, JSON.stringify(neg.bounds));
      const circle = Engine.generate({ hoop: C.HOOP, objects: [{ type: 'circle', cx: 50, cy: 50, r: 10 }] }); assertSound(circle, 'circle'); assert.ok(circle.totals.stitches > 100);
    });
    t.test('points as {x, y} objects and as [x, y] pairs give the same stitches', () => {
      const pts = C.FILL_SHAPES.U60.rings[0];
      const a = Engine.generate({ hoop: C.HOOP, objects: [{ type: 'polygon', points: pts }] });
      const b = Engine.generate({ hoop: C.HOOP, objects: [{ type: 'polygon', points: pts.map(p => ({ x: p[0], y: p[1] })) }] });
      assert.deepStrictEqual(Array.from(a.ir.commands), Array.from(b.ir.commands));
    });
    t.test('hoop size sets the origin: the same shape lands on the same millimetres', () => {
      for (const hoop of [{ width: 100, height: 100 }, { width: 130, height: 180 }, { width: 200, height: 200 }]) {
        const r = Engine.generate({ hoop, objects: [{ type: 'rect', x: 20, y: 30, width: 40, height: 20, fill: { pullComp: 0 } }] });
        assert.ok(Math.abs(r.bounds.minX - 20) < 0.11 && Math.abs(r.bounds.maxX - 60) < 0.11 && Math.abs(r.bounds.minY - 30) < 0.3 && Math.abs(r.bounds.maxY - 50) < 0.3, JSON.stringify(r.bounds));
        assert.deepStrictEqual(r.hoop, hoop); assert.deepStrictEqual(r.ir.hoop, { w: hoop.width * 10, h: hoop.height * 10 });
      }
    });

    // ---------------------------------------------------------------- determinism and totals
    t.test('deterministic: the same design gives the same stitches and the same report', () => {
      const d = { name: 'x', hoop: C.HOOP, objects: [
        { type: 'path', rings: C.FILL_SHAPES.eight.rings, color: '#aa0000', paint: 'both', fill: { angle: 33 }, line: { type: 'satin', width: 2.2, color: '#000000' } },
        { type: 'polyline', points: C.LINE_PATHS.scribble, color: '#0000aa', line: { type: 'bean' } } ] };
      const a = Engine.generate(d), b = Engine.generate(JSON.parse(JSON.stringify(d)));
      assert.deepStrictEqual(Array.from(a.ir.commands), Array.from(b.ir.commands));
      const strip = r => { const o = Object.assign({}, r); delete o.timeMs; delete o.ir; return JSON.stringify(o); };
      assert.strictEqual(strip(a), strip(b));
      assert.strictEqual(JSON.stringify(d), JSON.stringify(JSON.parse(JSON.stringify(d))), 'input is not modified');
    });
    t.test('generate does not modify its input', () => {
      const d = { hoop: C.HOOP, objects: [{ type: 'polygon', points: C.FILL_SHAPES.star.rings[0], paint: 'both', fill: { angle: 20 }, line: { type: 'satin' } }] };
      const before = JSON.stringify(d); Engine.generate(d); assert.strictEqual(JSON.stringify(d), before);
    });
    t.test('totals: thread length and run time follow the documented formulas', () => {
      const r = Engine.generate({ hoop: C.HOOP, objects: [
        { type: 'rect', x: 10, y: 10, width: 30, height: 30, color: '#ff0000' }, { type: 'rect', x: 55, y: 55, width: 30, height: 30, color: '#0000ff' } ] });
      const sewn = C.lengths(C.segments(r.ir)).sumMm;
      const wantM = (sewn * 1.1 + r.totals.trims * 50) / 1000;
      assert.ok(Math.abs(r.totals.threadLengthM - wantM) < 0.011, r.totals.threadLengthM + ' vs ' + wantM.toFixed(3));
      const wantMin = r.totals.stitches / 600 + (r.totals.trims * 6 + r.totals.colorChanges * 45) / 60;
      assert.ok(Math.abs(r.totals.timeMin - wantMin) < 0.051, r.totals.timeMin + ' vs ' + wantMin.toFixed(2));
      assert.ok(Math.abs(r.totals.longestStitchMm - C.lengths(C.segments(r.ir)).max) < 0.011);
      assert.strictEqual(r.totals.jumps, 2);
    });
    t.test('bounds are in design millimetres and match the stitches', () => {
      const r = Engine.generate(C.fillDesign(C.FILL_SHAPES.ellipse40x25));
      const pts = C.runs(r.ir).reduce((a, x) => a.concat(x.pts), []);
      const b = { minX: Math.min(...pts.map(p => p[0])), maxX: Math.max(...pts.map(p => p[0])), minY: Math.min(...pts.map(p => p[1])), maxY: Math.max(...pts.map(p => p[1])) };
      for (const k of Object.keys(b)) assert.ok(Math.abs(b[k] - r.bounds[k]) < 1e-6, k);
      assert.ok(Math.abs(r.bounds.width - (b.maxX - b.minX)) < 1e-6 && Math.abs(r.bounds.height - (b.maxY - b.minY)) < 1e-6);
      assert.ok(r.bounds.minX > 29 && r.bounds.maxX < 71 && r.bounds.minY > 37 && r.bounds.maxY < 63);
    });

    // ---------------------------------------------------------------- warnings
    t.test('warning OUTSIDE_HOOP / EXCEEDS_HOOP: errors that block export and name the objects', () => {
      const out = Engine.generate({ hoop: C.HOOP, objects: [{ type: 'rect', x: 60, y: 10, width: 20, height: 20 }, { type: 'rect', x: 85, y: 40, width: 30, height: 20 }] });
      assertSound(out, 'outside'); const w = out.warnings.find(x => x.code === 'OUTSIDE_HOOP');
      assert.ok(w && w.severity === 'error'); assert.deepStrictEqual(w.objectIndexes, [1]); assert.strictEqual(out.canExport, false);
      assert.throws(() => Engine.export(out, { format: 'pes' }), e => e.code === 'OUTSIDE_HOOP');
      const big = Engine.generate({ hoop: C.HOOP, objects: [{ type: 'rect', x: -20, y: 10, width: 140, height: 20 }] });
      assertSound(big, 'exceeds'); assert.ok(codes(big).includes('EXCEEDS_HOOP')); assert.strictEqual(big.canExport, false);
      const edge = Engine.generate({ hoop: C.HOOP, objects: [{ type: 'rect', x: 0, y: 0, width: 100, height: 100, fill: { pullComp: 0 } }] });
      assert.strictEqual(edge.canExport, true, 'a design exactly as large as the hoop is allowed: ' + codes(edge));
    });
    t.test('warning EMPTY_DESIGN: no objects, hidden objects, nothing sewable', () => {
      for (const d of [{ hoop: C.HOOP, objects: [] }, {}, { objects: [{ type: 'rect', x: 1, y: 1, width: 20, height: 20, visible: false }] }]) {
        const r = Engine.generate(d); assertSound(r, 'empty');
        assert.deepStrictEqual(codes(r), ['EMPTY_DESIGN']); assert.strictEqual(r.canExport, false); assert.strictEqual(r.totals.stitches, 0);
        assert.deepStrictEqual(Array.from(r.ir.commands), [C.OP.END, 0, 0]);
        assert.throws(() => Engine.export(r), e => e.code === 'EMPTY_DESIGN');
      }
    });
    t.test('warning TINY_OBJECT: too small to sew, skipped, others still sew', () => {
      const r = Engine.generate({ hoop: C.HOOP, objects: [
        { id: 't1', type: 'rect', x: 20, y: 20, width: 0.5, height: 0.5 }, { id: 't2', type: 'line', x1: 5, y1: 5, x2: 5.2, y2: 5 },
        { id: 't3', type: 'ellipse', cx: 40, cy: 40, rx: 0.3, ry: 0.3 }, { id: 'ok', type: 'rect', x: 50, y: 50, width: 20, height: 20 } ] });
      assertSound(r, 'tiny');
      assert.deepStrictEqual(r.warnings.filter(w => w.code === 'TINY_OBJECT').map(w => w.objectId), ['t1', 't2', 't3']);
      assert.deepStrictEqual(r.objects.map(o => o.skipped), [true, true, true, false]); assert.strictEqual(r.canExport, true);
    });
    t.test('warning TOO_DENSE: tight spacing and stacked fills, not ordinary fill + satin border', () => {
      const R = o => Object.assign({ type: 'rect', x: 20, y: 20, width: 30, height: 30, color: '#00aa00' }, o);
      const gen = objects => codes(Engine.generate({ hoop: C.HOOP, objects }));
      assert.ok(gen([R({ fill: { spacing: 0.25 } })]).includes('TOO_DENSE'), 'spacing 0.25');
      assert.ok(gen([R({ paint: 'line', line: { type: 'satin', spacing: 0.25 } })]).includes('TOO_DENSE'), 'satin spacing 0.25');
      assert.ok(gen([R(), R(), R()]).includes('TOO_DENSE'), 'three stacked fills');
      assert.ok(!gen([R()]).includes('TOO_DENSE'), 'one fill');
      assert.ok(!gen([R(), R()]).includes('TOO_DENSE'), 'two stacked fills');
      assert.ok(!gen([R({ paint: 'both', line: { type: 'satin', width: 3 } })]).includes('TOO_DENSE'), 'fill + satin border');
      const w = Engine.generate({ hoop: C.HOOP, objects: [R(), R(), R()] }).warnings.find(x => x.code === 'TOO_DENSE');
      assert.ok(w.at && w.at.x >= 19 && w.at.x <= 51 && w.at.y >= 19 && w.at.y <= 51, 'location is reported in design mm');
    });
    t.test('warning STITCH_TOO_LONG and PARAM_CLAMPED: out-of-range settings are pulled back', () => {
      const long = Engine.generate(C.fillDesign(C.FILL_SHAPES.rect80, { stitchLength: 20 }));
      assertSound(long, 'long'); assert.ok(codes(long).includes('STITCH_TOO_LONG')); assert.ok(C.lengths(C.segments(long.ir)).max <= 9.5);
      const longLine = Engine.generate(C.lineDesign(C.LINE_PATHS.straight, { type: 'running', stitchLength: 50 }));
      assertSound(longLine, 'long line'); assert.ok(codes(longLine).includes('STITCH_TOO_LONG')); assert.ok(C.lengths(C.segments(longLine.ir)).max <= 7.05);
      const clamp = Engine.generate(C.fillDesign(C.FILL_SHAPES.rect10, { spacing: 0.01, pullComp: 9, stitchLength: 0.1, angle: 'north' }));
      assertSound(clamp, 'clamped'); assert.strictEqual(clamp.warnings.filter(w => w.code === 'PARAM_CLAMPED').length, 4);
      assert.ok(clamp.totals.stitches < 5000, 'spacing was clamped (' + clamp.totals.stitches + ' stitches)');
      const badType = Engine.generate(C.lineDesign(C.LINE_PATHS.straight, { type: 'chain' })); assertSound(badType, 'bad type'); assert.ok(codes(badType).includes('PARAM_CLAMPED'));
    });
    t.test('warning OPEN_PATH_NOT_FILLED: an open path asked to fill is sewn as a line', () => {
      const r = Engine.generate({ hoop: C.HOOP, objects: [{ type: 'polyline', points: C.LINE_PATHS.elbow, paint: 'fill' }] });
      assertSound(r, 'open fill'); assert.ok(codes(r).includes('OPEN_PATH_NOT_FILLED')); assert.ok(r.totals.stitches > 20);
      const closed = Engine.generate({ hoop: C.HOOP, objects: [{ type: 'polyline', points: C.FILL_SHAPES.L60.rings[0], closed: true, paint: 'fill' }] });
      assert.deepStrictEqual(codes(closed), []); assert.ok(closed.totals.stitches > 1000);
    });
    t.test('warning TOO_LARGE: an absurdly big fill is refused instead of freezing the page', () => {
      const t0 = Date.now(); const r = Engine.generate({ hoop: { width: 1000, height: 1000 }, objects: [{ type: 'rect', x: 0, y: 0, width: 1000, height: 1000, fill: { spacing: 0.2, stitchLength: 1 } }] });
      assertSound(r, 'too large'); assert.ok(codes(r).includes('TOO_LARGE')); assert.ok(Date.now() - t0 < 1500);
    });

    // ---------------------------------------------------------------- hostile input
    t.test('bad input: NaN, Infinity, strings, nulls and unknown types never throw and never reach the IR', () => {
      const bad = [NaN, Infinity, -Infinity, undefined, null, '12', {}, [], 1e9, -1e9];
      let n = 0;
      for (const v of bad) {
        const objects = [
          { type: 'rect', x: v, y: 10, width: 20, height: 20 }, { type: 'rect', x: 10, y: 10, width: v, height: 20 },
          { type: 'ellipse', cx: 50, cy: v, rx: 10, ry: 10 }, { type: 'ellipse', cx: 50, cy: 50, rx: v, ry: 10 },
          { type: 'line', x1: 10, y1: 10, x2: v, y2: 40 },
          { type: 'polygon', points: [[10, 10], [v, 20], [40, 10], [40, 40], [10, 40]] }, { type: 'polygon', points: v },
          { type: 'polyline', points: [[10, 10], [20, v], [30, 30], { x: v, y: 3 }, [50, 20]] },
          { type: 'path', rings: v }, { type: 'path', rings: [v, [[60, 60], [80, 60], [80, 80], [60, 80]], [[v, v]]] },
          { type: 'rect', x: 10, y: 10, width: 20, height: 20, rotation: v, color: v, paint: v, fill: v, line: v },
          { type: 'rect', x: 10, y: 10, width: 20, height: 20, paint: 'both', fill: { spacing: v, stitchLength: v, angle: v, underlay: v, pullComp: v }, line: { type: v, width: v, stitchLength: v, spacing: v, color: v } },
          { type: v }, v,
        ];
        for (const o of objects) {
          let r; assert.doesNotThrow(() => { r = Engine.generate({ hoop: C.HOOP, objects: [o, { type: 'rect', x: 60, y: 60, width: 10, height: 10 }] }); }, 'threw for ' + JSON.stringify(o));
          assertSound(r, 'bad ' + String(v)); assert.ok(r.objects[1].stitches > 50, 'the good object still sews'); n++;
          assert.ok(!r.warnings.some(w => w.code === 'INTERNAL_ERROR'), 'INTERNAL_ERROR for ' + JSON.stringify(o) + ': ' + JSON.stringify(r.warnings));
        }
        for (const hoop of [v, { width: v, height: 100 }, { width: 100, height: v }]) { const r = Engine.generate({ hoop, objects: [{ type: 'rect', x: 10, y: 10, width: 20, height: 20 }] }); assertSound(r, 'hoop'); }
        for (const d of [v, { objects: v }, { hoop: C.HOOP, objects: [v, v] }]) { let r; assert.doesNotThrow(() => { r = Engine.generate(d); }); assertSound(r, 'design'); }
      }
      t.note('hostile-input designs', n + ' generated without a throw or an INTERNAL_ERROR');
    });
    t.test('bad input: the warnings say what happened', () => {
      const r = Engine.generate({ hoop: C.HOOP, objects: [
        { id: 1, type: 'rect', x: NaN, y: 10, width: 20, height: 20 },
        { id: 2, type: 'polygon', points: [[10, 10], [NaN, 20], [40, 10], [40, 40], [10, 40]] },
        { id: 3, type: 'blob' }, null,
        { id: 5, type: 'rect', x: 10, y: 60, width: 20, height: 20, color: 'tomato' },
      ] });
      assertSound(r, 'warnings');
      const by = id => r.warnings.filter(w => w.objectId === id).map(w => w.code);
      assert.deepStrictEqual(by(1), ['NON_FINITE_INPUT']); assert.strictEqual(r.objects[0].skipped, true);
      assert.deepStrictEqual(by(2), ['NON_FINITE_INPUT']); assert.ok(r.objects[1].stitches > 100, 'the polygon is repaired by dropping the bad point');
      assert.deepStrictEqual(by(3), ['INVALID_OBJECT']);
      assert.strictEqual(r.warnings.filter(w => w.objectIndex === 3)[0].code, 'INVALID_OBJECT');
      assert.deepStrictEqual(by(5), ['INVALID_COLOR']); assert.strictEqual(r.threads[r.threads.length - 1].color, '#000000');
      assert.strictEqual(r.canExport, true);
      const hoop = Engine.generate({ hoop: { width: -5, height: 0 }, objects: [{ type: 'rect', x: 10, y: 10, width: 20, height: 20 }] });
      assert.ok(codes(hoop).includes('INVALID_HOOP')); assert.deepStrictEqual(hoop.hoop, { width: 100, height: 100 });
    });
    t.test('degenerate shapes: collinear, repeated, two-point and empty outlines', () => {
      const cases = [
        { type: 'polygon', points: [[10, 10], [50, 10], [90, 10]] }, { type: 'polygon', points: [[10, 10], [10, 10], [10, 10], [10, 10]] },
        { type: 'polygon', points: [[10, 10], [50, 50]] }, { type: 'polygon', points: [] }, { type: 'polyline', points: [[10, 10]] }, { type: 'path', rings: [] }, { type: 'path', rings: [[]] },
        { type: 'rect', x: 10, y: 10, width: 0, height: 30 }, { type: 'ellipse', cx: 20, cy: 20, rx: 0, ry: 0 }, { type: 'line', x1: 5, y1: 5, x2: 5, y2: 5 },
        { type: 'polygon', points: [[10, 10], [50, 10], [50, 10.0001], [10, 10.0001]] },
        { type: 'polygon', points: Array.from({ length: 500 }, (_, i) => [30 + (i % 2) * 1e-3, 30 + (i % 3) * 1e-3]) },
      ];
      for (const o of cases) for (const paint of ['fill', 'line', 'both']) for (const type of ['running', 'satin']) {
        const r = Engine.generate({ hoop: C.HOOP, objects: [Object.assign({ paint, line: { type } }, o)] });
        assertSound(r, 'degenerate ' + JSON.stringify(o).slice(0, 60) + ' ' + paint);
        assert.ok(!codes(r).includes('INTERNAL_ERROR'), JSON.stringify(o).slice(0, 80) + ': ' + JSON.stringify(r.warnings));
      }
    });
    t.test('progress callback: called once per object, a throwing callback is ignored', () => {
      const seen = [];
      const d = { hoop: C.HOOP, objects: [{ type: 'rect', x: 10, y: 10, width: 10, height: 10 }, { type: 'rect', x: 30, y: 10, width: 10, height: 10 }, { type: 'rect', x: 50, y: 10, width: 10, height: 10 }] };
      Engine.generate(d, { onProgress: (done, total) => seen.push(done + '/' + total) });
      assert.deepStrictEqual(seen, ['1/3', '2/3', '3/3']);
      assert.doesNotThrow(() => Engine.generate(d, { onProgress: () => { throw new Error('boom'); } }));
    });

    return Promise.resolve().then(() => {
      t.note('fill corpus', Object.keys(C.FILL_SHAPES).length + ' shapes x ' + angles.length + ' angles = ' + fillRuns + ' fills; lowest row coverage ' + minCov.toFixed(2) + '% (' + minCovAt + '); longest fill stitch ' + maxFillStitch.toFixed(2) + ' mm');
    });
  },
};
