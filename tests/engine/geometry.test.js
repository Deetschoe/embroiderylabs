/*
 * Geometry building blocks of the digitizer (scanlines, rows, regions, run / bean / satin generators,
 * IR assembly, the IR validator), each checked against an independent ruler from corpus.js or against
 * numbers worked out by hand. Also checks the rulers themselves: a measuring tool that cannot fail is no test.
 */
'use strict';
const assert = require('assert');
const path = require('path');
const C = require('./corpus.js');
const Dg = require(path.join(__dirname, '..', '..', 'js', 'engine', 'digitize.js'));

const P = pts => pts.map(p => ({ x: p[0], y: p[1] }));
const rings = shape => shape.rings.map(P);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ': ' + a + ' is not within ' + tol + ' of ' + b);
const polyArea = r => { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };

module.exports = {
  name: 'geometry: scanlines, rows, regions, line generators, IR',
  run(t) {
    const shapes = Object.keys(C.FILL_SHAPES);

    t.test('EdgeIndex.inside agrees with an independent point-in-polygon test (both fill rules)', () => {
      let checked = 0;
      for (const k of shapes) for (const rule of ['nonzero', 'evenodd']) {
        const s = C.FILL_SHAPES[k], idx = new Dg.EdgeIndex(rings(s)), r = C.rng(k.length * 31 + rule.length);
        for (let i = 0; i < 1500; i++) {
          const x = 5 + r() * 90, y = 5 + r() * 90;
          if (C.distToRings([x, y], s.rings) < 1e-6) continue;
          assert.strictEqual(idx.inside(x, y, rule), C.inside([x, y], s.rings, rule), k + ' ' + rule + ' at ' + x + ',' + y);
          checked++;
        }
      }
      t.note('point-in-shape checks', checked + ' random points over ' + shapes.length + ' shapes x 2 fill rules');
    });

    t.test('EdgeIndex.spans: sorted, disjoint, inside between the ends, outside in the gaps', () => {
      for (const k of shapes) for (const rule of ['nonzero', 'evenodd']) {
        const s = C.FILL_SHAPES[k], idx = new Dg.EdgeIndex(rings(s)), r = C.rng(k.length * 17 + rule.length);
        for (let i = 0; i < 200; i++) {
          const y = idx.minY - 2 + r() * (idx.maxY - idx.minY + 4), sp = idx.spans(y, rule);
          if (y < idx.minY || y > idx.maxY) { assert.strictEqual(sp.length, 0, k + ': spans outside the shape'); continue; }
          let last = -Infinity;
          for (const [a, b] of sp) {
            assert.ok(b >= a && a >= last, k + ': spans out of order at y=' + y);
            if (b - a > 1e-3) assert.ok(C.inside([(a + b) / 2, y], s.rings, rule), k + ' ' + rule + ': middle of a span is outside at y=' + y);
            if (last > -Infinity && a - last > 1e-3) assert.ok(!C.inside([(a + last) / 2, y], s.rings, rule), k + ' ' + rule + ': middle of a gap is inside at y=' + y);
            last = b;
          }
          if (sp.length) { assert.ok(!C.inside([sp[0][0] - 0.01, y], s.rings, rule) || C.distToRings([sp[0][0] - 0.01, y], s.rings) < 0.02, k + ': left of the first span'); }
        }
      }
    });

    t.test('scanline area equals the true area (rectangle, triangle, ring, self-crossing star)', () => {
      const area = (s, rule) => { const idx = new Dg.EdgeIndex(rings(s)), dy = 0.01; let a = 0; for (let y = idx.minY + dy / 2; y < idx.maxY; y += dy) for (const sp of idx.spans(y, rule)) a += (sp[1] - sp[0]) * dy; return a; };
      near(area(C.FILL_SHAPES.rect80, 'nonzero'), 6400, 1, 'rect80');
      near(area(C.FILL_SHAPES.triangle, 'nonzero'), polyArea(C.FILL_SHAPES.triangle.rings[0]), 1, 'triangle');
      const donut = polyArea(C.FILL_SHAPES.donut.rings[0]) - polyArea(C.FILL_SHAPES.donut.rings[1]);
      near(area(C.FILL_SHAPES.donut, 'nonzero'), donut, 1, 'donut (opposite winding)');
      near(area(C.FILL_SHAPES.donutEvenOdd, 'evenodd'), donut, 1, 'donut (even-odd)');
      near(area(C.FILL_SHAPES.donutEvenOdd, 'nonzero'), polyArea(C.FILL_SHAPES.donut.rings[0]), 1, 'same-winding rings under nonzero fill the hole');
      const full = area(C.FILL_SHAPES.pentagram, 'nonzero'), holed = area(C.FILL_SHAPES.pentagramEvenOdd, 'evenodd');
      assert.ok(full > holed + 100, 'the pentagram centre is filled under nonzero and empty under even-odd');
      // pentagon in the middle of a pentagram of circumradius R has circumradius R * 0.381966
      const rIn = 30 * 0.381966, pentagon = 2.5 * rIn * rIn * Math.sin(2 * Math.PI / 5);
      near(full - holed, pentagon, 1.5, 'pentagram centre area');
    });

    t.test('EdgeIndex.near agrees with an independent distance-to-outline', () => {
      for (const k of ['star', 'donut', 'comb', 'sliverTri']) {
        const s = C.FILL_SHAPES[k], idx = new Dg.EdgeIndex(rings(s)), r = C.rng(99);
        for (let i = 0; i < 1500; i++) {
          const x = 5 + r() * 90, y = 5 + r() * 90, d = 0.2 + r() * 3, real = C.distToRings([x, y], s.rings);
          if (Math.abs(real - d) < 1e-6) continue;
          assert.strictEqual(idx.near(x, y, d), real < d, k + ' at ' + x + ',' + y + ' d=' + d);
        }
      }
    });

    t.test('buildRows: evenly spaced rows centred in the shape, covered area, pull compensation, inset', () => {
      const idx = new Dg.EdgeIndex(rings(C.FILL_SHAPES.rect80));
      const b = Dg.buildRows(idx, 0.4, {});
      assert.strictEqual(b.rows.length, 200); assert.strictEqual(b.hitRows, 200);
      near(b.covered, 6400, 1e-6, 'covered area');
      for (let i = 1; i < b.rows.length; i++) near(b.rows[i].y - b.rows[i - 1].y, 0.4, 1e-9, 'row pitch');
      near(b.rows[0].y - 10, 90 - b.rows[199].y, 1e-6, 'equal margins');
      assert.ok(b.rows[0].y - 10 > 0 && b.rows[0].y - 10 <= 0.2 + 1e-6, 'first row within half a spacing of the edge');
      for (const row of b.rows) { assert.strictEqual(row.spans.length, 1); near(row.spans[0].x1, 10, 1e-9, 'x1'); near(row.spans[0].x2, 90, 1e-9, 'x2'); }
      const comp = Dg.buildRows(idx, 0.4, { comp: 0.25 });
      for (const row of comp.rows) { near(row.spans[0].x1, 9.75, 1e-9, 'compensated x1'); near(row.spans[0].x2, 90.25, 1e-9, 'compensated x2'); }
      near(comp.covered, 6400, 1e-6, 'covered area ignores compensation');
      const inset = Dg.buildRows(idx, 2.5, { inset: 0.6 });
      for (const row of inset.rows) { assert.ok(row.y >= 10.6 - 1e-6 && row.y <= 89.4 + 1e-6, 'inset rows stay inside'); near(row.spans[0].x1, 10.6, 1e-9, 'inset x1'); near(row.spans[0].x2, 89.4, 1e-9, 'inset x2'); }
      // links are symmetric and only join overlapping spans of neighbouring rows
      const comb = Dg.buildRows(new Dg.EdgeIndex(rings(C.FILL_SHAPES.comb)), 0.4, {});
      let links = 0;
      for (const row of comb.rows) for (const s of row.spans) {
        for (const u of s.up) { assert.strictEqual(u.k, s.k - 1); assert.ok(u.down.includes(s)); assert.ok(Math.min(u.x2, s.x2) > Math.max(u.x1, s.x1)); links++; }
        for (const d of s.down) assert.ok(d.up.includes(s));
      }
      assert.ok(links > 300);
      // nothing to do: degenerate height, spans below the minimum
      assert.strictEqual(Dg.buildRows(new Dg.EdgeIndex([P([[0, 5], [10, 5], [20, 5]])]), 0.4, {}).rows.length, 0);
      const thin = Dg.buildRows(new Dg.EdgeIndex([P(C.rect(0, 0, 0.2, 10))]), 0.4, {});
      assert.strictEqual(thin.rows.reduce((a, r) => a + r.spans.length, 0), 0, 'spans narrower than 0.3 mm are dropped');
      assert.ok(thin.covered > 1.9, 'but their area is still measured');
    });

    t.test('buildRegions: every span belongs to one region; regions are unbroken stacks of rows', () => {
      const expect = { rect80: 1, triangle: 1, U60: 3, comb: 4, combDown: 4, donut: 4, frame: 4, twoIslands: 2, eight: 7, ellipse40x25: 1 };
      for (const k of shapes) {
        const b = Dg.buildRows(new Dg.EdgeIndex(rings(C.FILL_SHAPES[k])), 0.4, { rule: C.FILL_SHAPES[k].rule });
        const regs = Dg.buildRegions(b.rows);
        let spans = 0; for (const row of b.rows) for (const s of row.spans) { spans++; assert.ok(s.region && regs[s.region.id] === s.region, k + ': span without a region'); }
        assert.strictEqual(regs.reduce((a, r) => a + r.spans.length, 0), spans, k + ': spans counted once');
        for (const r of regs) for (let i = 1; i < r.spans.length; i++) {
          assert.strictEqual(r.spans[i].k, r.spans[i - 1].k + 1, k + ': a region skips a row');
          assert.ok(Math.min(r.spans[i].x2, r.spans[i - 1].x2) > Math.max(r.spans[i].x1, r.spans[i - 1].x1), k + ': neighbouring rows of a region do not overlap');
        }
        if (expect[k]) assert.strictEqual(regs.length, expect[k], k + ': region count');
      }
    });

    t.test('simplify: keeps the ends, stays within the tolerance, survives 200,000 points', () => {
      const r = C.rng(5), pts = [];
      for (let i = 0; i <= 2000; i++) pts.push({ x: i * 0.05, y: 10 * Math.sin(i / 150) + (r() - 0.5) * 0.04 });
      for (const tol of [0.05, 0.2, 1]) {
        const out = Dg.simplify(pts, tol);
        assert.strictEqual(out[0], pts[0]); assert.strictEqual(out[out.length - 1], pts[pts.length - 1]);
        assert.ok(out.length < pts.length / 4, 'tol ' + tol + ' kept ' + out.length);
        const line = out.map(p => [p.x, p.y]);
        for (const p of pts) assert.ok(C.distToPath([p.x, p.y], line) <= tol + 1e-9, 'a dropped point is further than the tolerance');
      }
      assert.strictEqual(Dg.simplify(P([[0, 0], [1, 0], [2, 0], [3, 0]]), 0.01).length, 2);
      assert.deepStrictEqual(Dg.simplify(P([[0, 0], [1, 1]]), 1), P([[0, 0], [1, 1]]));
      assert.deepStrictEqual(Dg.simplify([], 1), []);
      const big = []; for (let i = 0; i < 200000; i++) big.push({ x: i * 0.001, y: Math.sin(i / 50) });
      const t0 = Date.now(), out = Dg.simplify(big, 0.05);
      assert.ok(out.length > 100 && out.length < 20000); assert.ok(Date.now() - t0 < 3000, 'took ' + (Date.now() - t0) + ' ms');
    });

    t.test('runStitch: stitches lie on the path, never longer than asked, corners and ends are kept', () => {
      for (const k of Object.keys(C.LINE_PATHS)) for (const len of [1, 2.5, 4]) {
        const src = C.LINE_PATHS[k], out = Dg.runStitch(P(src), len);
        assert.ok(out.length >= 2, k);
        near(dist(out[0], { x: src[0][0], y: src[0][1] }), 0, 1e-9, k + ' start');
        near(dist(out[out.length - 1], { x: src[src.length - 1][0], y: src[src.length - 1][1] }), 0, 1e-9, k + ' end');
        for (let i = 0; i < out.length; i++) {
          assert.ok(C.distToPath([out[i].x, out[i].y], src) < 1e-6, k + ': a stitch point is off the path');
          if (i) assert.ok(dist(out[i], out[i - 1]) <= len + 1e-6, k + ': stitch ' + dist(out[i], out[i - 1]) + ' longer than ' + len);
        }
      }
      const elbow = Dg.runStitch(P(C.LINE_PATHS.elbow), 2.5);
      assert.ok(elbow.some(p => dist(p, { x: 10, y: 20 }) < 1e-9), 'the corner of the elbow is a needle point');
      const even = Dg.runStitch(P([[0, 0], [10, 0]]), 3);
      assert.strictEqual(even.length, 5); for (let i = 1; i < even.length; i++) near(dist(even[i], even[i - 1]), 2.5, 1e-9, 'even division');
      const closed = Dg.runStitch(P(C.rect(0, 0, 10, 6)), 2, { closed: true });
      near(dist(closed[0], closed[closed.length - 1]), 0, 1e-9, 'closed path returns to its start');
      for (const c of C.rect(0, 0, 10, 6)) assert.ok(closed.some(p => dist(p, { x: c[0], y: c[1] }) < 1e-9), 'corner kept');
      assert.strictEqual(Dg.runStitch(P([[5, 5]]), 2).length, 1);
      assert.strictEqual(Dg.runStitch([], 2).length, 0);
      assert.strictEqual(Dg.runStitch([{ x: NaN, y: 1 }, { x: 0, y: 0 }, { x: 3, y: 0 }], 2).length, 3, 'bad points are skipped');
    });

    t.test('bean: each stitch is sewn forward, back, forward', () => {
      const p = P([[0, 0], [2, 0], [4, 0], [4, 2]]), b = Dg.bean(p, 3);
      assert.deepStrictEqual(b, [p[0], p[1], p[0], p[1], p[2], p[1], p[2], p[3], p[2], p[3]]);
      assert.strictEqual(Dg.bean(p, 1), p);
      assert.deepStrictEqual(Dg.bean([p[0]], 3), [p[0]]);
    });

    t.test('satinLine: zigzag across the centre line at the asked width and density', () => {
      const centre = P([[10, 50], [90, 50]]);
      const s = Dg.satinLine(centre, 4, { spacing: 0.4, underlay: false });
      assert.strictEqual(s.kind, 'satin'); near(s.width, 4.4, 1e-9, 'width includes pull compensation');
      for (let i = 0; i < s.points.length; i++) {
        near(Math.abs(s.points[i].y - 50), 2.2, 1e-9, 'needle point on a rail');
        if (i) { assert.ok((s.points[i].y - 50) * (s.points[i - 1].y - 50) < 0, 'consecutive points are on opposite rails'); near(s.points[i].x - s.points[i - 1].x, 0.2, 1e-9, 'advance of half a spacing per stitch'); }
      }
      near(s.points[0].x, 10, 1e-9, 'starts at the path start'); assert.ok(s.points[s.points.length - 1].x > 89.7, 'ends at the path end');
      // underlay comes first and stays inside the column
      const u = Dg.satinLine(centre, 4, { spacing: 0.4, underlay: true });
      assert.ok(u.underlayPts > 10 && u.points.length > s.points.length);
      for (let i = 0; i < u.underlayPts - 1; i++) assert.ok(Math.abs(u.points[i].y - 50) < 2.2 - 0.3, 'underlay inside the column');
      // wide columns are split so no stitch is longer than 7 mm
      const wide = Dg.satinLine(centre, 11, { spacing: 0.4 });
      for (let i = 1; i < wide.points.length; i++) assert.ok(dist(wide.points[i], wide.points[i - 1]) <= 7 + 1e-6, 'split stitch ' + dist(wide.points[i], wide.points[i - 1]));
      // corners: every needle point stays within half the width (+ a little) of the centre line
      const bend = C.LINE_PATHS.elbow, sb = Dg.satinLine(P(bend), 3, { underlay: false });
      for (const p of sb.points) assert.ok(C.distToPath([p.x, p.y], bend) <= 1.7 + 1e-6, 'a satin point is ' + C.distToPath([p.x, p.y], bend) + ' mm from the centre line');
      // closed column: seam overlaps, start and end are near each other
      const ring = Dg.satinLine(P(C.rect(20, 20, 40, 30)), 3, { closed: true, underlay: false });
      assert.ok(dist(ring.points[0], ring.points[ring.points.length - 1]) < 5, 'closed column ends where it started');
      // too narrow for satin: sewn as a triple run
      assert.strictEqual(Dg.satinLine(centre, 0.6, {}).kind, 'bean');
      assert.strictEqual(Dg.satinLine(P([[1, 1]]), 3, {}).kind, 'empty');
    });

    t.test('fillShape: reports rows, regions and travel; refuses what cannot be filled', () => {
      const f = Dg.fillShape(rings(C.FILL_SHAPES.U60), { spacing: 0.4, stitchLen: 3, angleDeg: 0 });
      assert.ok(f.points.length > 1000 && !f.skipped);
      near(f.stats.coveredMm2, polyArea(C.FILL_SHAPES.U60.rings[0]), 20, 'covered area');
      assert.strictEqual(f.stats.regions, 3); assert.strictEqual(f.stats.components, 1); assert.strictEqual(f.stats.breaks, 0);
      assert.strictEqual(Dg.fillShape([], {}).skipped, 'NO_VALID_RING');
      assert.strictEqual(Dg.fillShape([P([[0, 0], [1, 1]])], {}).skipped, 'NO_VALID_RING');
      assert.strictEqual(Dg.fillShape([P(C.rect(0, 0, 0.5, 0.5))], {}).skipped, 'TOO_SMALL');
      const two = Dg.fillShape(rings(C.FILL_SHAPES.twoIslands), {});
      assert.strictEqual(two.stats.components, 2);
      assert.strictEqual(two.points.filter(p => p.break).length, 1, 'one break marker between the two islands');
      assert.strictEqual(two.stats.breaks, 0, 'no travel had to be abandoned inside an island');
    });

    t.test('assemble: grid, locks, trims between distant parts, colour changes, long-stitch safety net', () => {
      const a = Dg.assemble([
        { color: '#FF0000', points: P([[10, 10], [13, 10], [16, 10]]), objectIndex: 0 },
        { color: 'f00', points: P([[16.5, 10], [19, 10]]), objectIndex: 1 },          // 0.5 mm away: sewn on without a trim
        { color: '#ff0000', points: P([[60, 60], [63, 60]]), objectIndex: 2 },         // far away: trim + jump
        { color: '#00f', points: P([[20, 20], [50, 20]]), objectIndex: 3 },            // 30 mm in one stitch: split
        { color: '#00f', points: [{ x: 5, y: 5 }, { x: 8, y: 5 }, { break: true }, { x: 30, y: 5 }, { x: 33, y: 5 }], objectIndex: 4 },
      ], { hoopW: 100, hoopH: 100 });
      assert.deepStrictEqual(Dg.validateIR(a.ir), []);
      assert.deepStrictEqual(a.ir.threads, [{ color: '#ff0000' }, { color: '#0000ff' }]);
      const n = C.counts(a.ir);
      assert.deepStrictEqual([n.JUMP, n.TRIM, n.COLOR_CHANGE, n.END], [5, 5, 1, 1]);
      assert.deepStrictEqual(C.lockProblems(a.ir), []);
      assert.strictEqual(a.splits, 1);
      assert.ok(C.lengths(C.segments(a.ir)).max <= 12.1 + 1e-9);
      assert.strictEqual(a.ir.commands[1], -400, 'first point x = (10 - 50) mm in 0.1 mm units'); assert.strictEqual(a.ir.commands[2], -400);
      assert.strictEqual(a.perObject.length, 5); assert.ok(a.perObject.every(o => o.stitches >= 2));
      assert.strictEqual(a.perThread.reduce((s, p) => s + p.stitches, 0), n.STITCH);
      assert.deepStrictEqual(a.ir.bounds, { minX: -450, minY: -450, maxX: 130, maxY: 100 });
      // nothing sewable
      const e = Dg.assemble([{ color: '#000', points: P([[1, 1]]) }, { color: '#000', points: [{ x: NaN, y: 2 }, { x: 3, y: 3 }] }], {});
      assert.deepStrictEqual(Array.from(e.ir.commands), [Dg.OP.END, 0, 0]); assert.deepStrictEqual(e.ir.threads, []); assert.deepStrictEqual(Dg.validateIR(e.ir), []);
      // the grid does not depend on the hoop: same points, other hoop -> same stitches shifted by the centre
      const pts = P([[35.35, 12.05], [36.65, 14.75], [40.15, 17.25]]);
      const h1 = Dg.assemble([{ color: '#000', points: pts }], { hoopW: 100, hoopH: 100 }).ir.commands, h2 = Dg.assemble([{ color: '#000', points: pts }], { hoopW: 260, hoopH: 160 }).ir.commands;
      for (let i = 0; i < h1.length; i += 3) { assert.strictEqual(h1[i + 1] - h2[i + 1], 800); assert.strictEqual(h1[i + 2] - h2[i + 2], 300); }
    });

    t.test('normColor: canonical #rrggbb or null', () => {
      assert.strictEqual(Dg.normColor('#ABC'), '#aabbcc'); assert.strictEqual(Dg.normColor(' #A1B2C3 '), '#a1b2c3'); assert.strictEqual(Dg.normColor('a1b2c3'), '#a1b2c3');
      for (const bad of ['red', 'rgb(1,2,3)', '#12', '#1234567', '', null, undefined, 12, {}, '#gggggg']) assert.strictEqual(Dg.normColor(bad), null, String(bad));
    });

    t.test('validateIR accepts good stitch data and names every kind of damage', () => {
      const OP = Dg.OP;
      const good = () => [OP.JUMP, 0, 0, OP.STITCH, 0, 0, OP.STITCH, 20, 0, OP.TRIM, 20, 0, OP.COLOR_CHANGE, 20, 0, OP.JUMP, 50, 50, OP.STITCH, 50, 50, OP.STITCH, 60, 55, OP.TRIM, 60, 55, OP.END, 60, 55];
      const ir = (cmds, threads) => ({ threads: threads || [{ color: '#000000' }, { color: '#ffffff' }], commands: cmds });
      assert.deepStrictEqual(Dg.validateIR(ir(good())), []);
      assert.deepStrictEqual(Dg.validateIR(ir(Int32Array.from(good()))), []);
      const broken = [
        ['not an IR', () => null, 'not an IR object'],
        ['no threads', () => ({ commands: good() }), 'not an IR object'],
        ['truncated', c => c.slice(0, c.length - 1), 'multiple of 3'],
        ['no END', c => c.slice(0, c.length - 3), 'missing END'],
        ['command after END', c => c.concat([OP.STITCH, 61, 55]), 'after END'],
        ['fractional coordinate', c => { c[7] = 20.5; return c; }, 'non-integer'],
        ['NaN coordinate', c => { c[7] = NaN; return c; }, 'non-integer'],
        ['stitch without jump', c => c.slice(3), 'without JUMP'],
        ['first stitch away from the jump', c => { c[4] = 3; return c; }, 'not at the JUMP target'],
        ['13 mm stitch', c => { c[7] = 130; c[10] = 130; c[13] = 130; return c; }, 'stitch 13mm'],
        ['zero-length stitch', c => { c.splice(9, 0, OP.STITCH, 20, 0); return c; }, 'zero-length'],
        ['jump without trim', c => { c.splice(9, 0, OP.JUMP, 30, 0); return c; }, 'JUMP without TRIM'],
        ['double jump', c => { c.splice(3, 0, OP.JUMP, 0, 0); return c; }, 'double JUMP'],
        ['double trim', c => { c.splice(12, 0, OP.TRIM, 20, 0); return c; }, 'TRIM without stitches'],
        ['trim that moves', c => { c[10] = 21; return c; }, 'TRIM moves'],
        ['colour change without trim', c => { c.splice(9, 3); return c; }, 'COLOR_CHANGE without TRIM'],
        ['END without trim', c => { c.splice(24, 3); return c; }, 'END without TRIM'],
        ['unknown op', c => { c[6] = 9; return c; }, 'unknown op 9'],
        ['thread count', (c, mk) => mk(c, [{ color: '#000000' }]), 'threads 1 != colour blocks 2'],
        ['thread colour', (c, mk) => mk(c, [{ color: '#000000' }, { color: 'red' }]), 'not canonical'],
      ];
      for (const [label, damage, want] of broken) {
        const r = damage(good(), ir), errs = Dg.validateIR(Array.isArray(r) ? ir(r) : r);
        assert.ok(errs.some(e => e.includes(want)), label + ': expected "' + want + '" in ' + JSON.stringify(errs));
      }
      assert.deepStrictEqual(Dg.validateIR(ir(good().map((v, i) => (i === 7 || i === 10 || i === 13 ? 125 : v))), { maxStitch: 130 }), [], 'maxStitch is configurable');
    });

    t.test('the rulers work: outside(), coverage() and lockProblems() fail on deliberately bad stitches', () => {
      const shape = C.FILL_SHAPES.U60, r = Dg.digitize(C.fillDesign(shape, { underlay: false })), segs = C.segments(r.ir);
      assert.strictEqual(C.outside(segs, shape.rings, 'nonzero').count, 0);
      // one stitch across the notch of the U
      const bad = segs.concat([{ a: [27, 30], b: [73, 30], len: 46 }]), o = C.outside(bad, shape.rings, 'nonzero');
      assert.strictEqual(o.count, 1); assert.ok(o.worstMm > 25 && o.worstMm < 31, 'worst ' + o.worstMm);
      // drop every stitch of the left arm: coverage must fall
      const full = C.coverage(segs, shape.rings, 'nonzero', 0.4, 0), holed = C.coverage(segs.filter(s => !(s.a[0] < 36 && s.a[1] < 64)), shape.rings, 'nonzero', 0.4, 0);
      assert.ok(full.pct > 98 && full.samples > 5000, 'full ' + full.pct);
      assert.ok(holed.pct < 82 && holed.pct > 70, 'with one arm missing coverage reads ' + holed.pct.toFixed(1) + '%');
      // rows twice as far apart: about half the samples have a row close enough
      const sparse = C.coverage(C.segments(Dg.digitize(C.fillDesign(C.FILL_SHAPES.rect80, { spacing: 2, underlay: false })).ir), C.FILL_SHAPES.rect80.rings, 'nonzero', 0.4, 0);
      assert.ok(sparse.pct < 60 && sparse.pct > 15, 'sparse fill measured against 0.4 mm rows reads ' + sparse.pct.toFixed(1) + '%');
      // locks
      assert.deepStrictEqual(C.lockProblems(r.ir), []);
      const OP = Dg.OP, none = { hoop: { w: 1000, h: 1000 }, commands: Int32Array.from([OP.JUMP, 0, 0, OP.STITCH, 0, 0, OP.STITCH, 30, 0, OP.STITCH, 60, 0, OP.STITCH, 90, 0, OP.STITCH, 120, 0, OP.STITCH, 150, 0, OP.TRIM, 150, 0, OP.END, 150, 0]) };
      assert.strictEqual(C.lockProblems(none).length, 2);
      // inside(): a point in the hole of a ring
      assert.strictEqual(C.inside([50, 50], C.FILL_SHAPES.donut.rings, 'nonzero'), false); assert.strictEqual(C.inside([50, 25], C.FILL_SHAPES.donut.rings, 'nonzero'), true);
    });
  },
};
