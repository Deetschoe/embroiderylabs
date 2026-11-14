/*
 * The 'Auto (line art)' fill style (js/engine/lineart.js, fill.style = 'lineart'):
 *   - the same input always gives the same stitches (twice, from the cache, after a fresh require, in a page context)
 *   - lines are sewn by their width: running stitch, triple run, satin; a wide area gets an edge ring and tatami
 *   - coverage of the drawing and thread outside it, on synthetic hatching and on a real traced drawing
 *   - no stitch over 0.5 mm crosses bare fabric unless the thread is cut right after it
 *   - the stitch limit, the timing, the warnings, and the gated trim in assemble()
 *   - every existing design gives exactly the same bytes with lineart.js loaded as without it
 *
 * The real drawing is tests/engine/fixtures/lineart-eyes.json: the black line art of a traced SVG a user sent
 * (anime eyes), imported into a 130 x 180 mm hoop with the background left out.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ENGINE_DIR = path.join(__dirname, '..', '..', 'js', 'engine');
const Engine = require(path.join(ENGINE_DIR, 'engine.js'));
const LA = require(path.join(ENGINE_DIR, 'lineart.js'));
const Dz = Engine.Digitizer;
const D = require('./designs.js');
const K = require('./cases.js');
const C = require('./corpus.js');
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'lineart-eyes.json'), 'utf8'));

const OP = Engine.OP;
const toPts = rings => rings.map(r => r.map(p => ({ x: p[0], y: p[1] })));
const irHash = r => D.hash(new Uint8Array(r.ir.commands.buffer, r.ir.commands.byteOffset, r.ir.commands.byteLength));
const codes = r => r.warnings.map(w => w.code);
const fixtureDesign = extra => ({ name: 'Eyes', hoop: FIX.hoop, objects: [{ id: 'eyes', type: 'path', rings: FIX.rings, fillRule: FIX.fillRule, color: FIX.color, fill: Object.assign({ style: 'lineart' }, extra || {}) }] });
const one = (rings, extra, hoop) => ({ hoop: hoop || { width: 100, height: 100 }, objects: [{ type: 'path', rings, color: '#111111', fill: Object.assign({ style: 'lineart' }, extra || {}) }] });
// a polygon around a straight line from a to b, w mm wide
const bar = (a, b, w) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]), nx = -(b[1] - a[1]) / l * w / 2, ny = (b[0] - a[0]) / l * w / 2; return [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]]; };
const disc = (cx, cy, r, n) => Array.from({ length: n || 96 }, (_, i) => [cx + r * Math.cos(2 * Math.PI * i / (n || 96)), cy + r * Math.sin(2 * Math.PI * i / (n || 96))]);
const BUILD = { spacing: 0.4, stitchLen: 3, angleDeg: 0, pullComp: 0.2, underlay: true };

// The drawing on a 0.05 mm grid against the stitches drawn as 0.4 mm thread:
//   coverage   share of the drawing's area under thread
//   spill      share of the thread more than 0.3 mm outside the drawing (pull compensation alone stays under that)
//   crossings  stitches longer than 0.5 mm that pass more than 0.35 mm from the drawing (bare fabric; holes the
//              clean-up fills on purpose are under 0.3 mm2, so no deeper than that) and are not followed by a trim
function measure(rings, rule, result) {
  const res = 0.05, I = LA._internal;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (const p of r) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  x0 -= 2; y0 -= 2; x1 += 2; y1 += 2;
  const W = Math.ceil((x1 - x0) / res), H = Math.ceil((y1 - y0) / res), N = W * H, n1 = Math.max(W, H);
  const art = I.rasterize(rings, x0, y0, res, W, H, rule);
  const dOut = I.edt(new Float32Array(N), art, 1, W, H, { f: new Float64Array(n1), d: new Float64Array(n1), v: new Int32Array(n1), z: new Float64Array(n1 + 1) });
  const thread = new Uint8Array(N), R = 0.2 / res, rr = Math.ceil(R);
  const stamp = (cx, cy) => { const ix = Math.round(cx), iy = Math.round(cy); for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) { if (dx * dx + dy * dy > R * R) continue; const x = ix + dx, y = iy + dy; if (x >= 0 && y >= 0 && x < W && y < H) thread[y * W + x] = 1; } };
  const bare = (mx, my) => { const x = Math.floor((mx - x0) / res), y = Math.floor((my - y0) / res); return x < 0 || y < 0 || x >= W || y >= H || dOut[y * W + x] > (0.35 / res) ** 2; };
  const c = result.ir.commands, hw = Math.round(result.ir.hoop.w / 2), hh = Math.round(result.ir.hoop.h / 2);
  let px = 0, py = 0, sewing = false, crossings = 0;
  for (let i = 0; i < c.length; i += 3) {
    const mx = (c[i + 1] + hw) / 10, my = (c[i + 2] + hh) / 10;
    if (c[i] === OP.STITCH) {
      if (sewing) {
        const ax = (px - x0) / res, ay = (py - y0) / res, bx = (mx - x0) / res, by = (my - y0) / res, n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.7));
        for (let k = 0; k <= n; k++) stamp(ax + (bx - ax) * k / n, ay + (by - ay) * k / n);
        if (Math.hypot(mx - px, my - py) > 0.5 && c[i + 3] !== OP.TRIM) { for (let k = 1; k < 20; k++) if (bare(px + (mx - px) * k / 20, py + (my - py) * k / 20)) { crossings++; break; } }
      }
      sewing = true;
    } else sewing = false;
    px = mx; py = my;
  }
  let black = 0, cov = 0, th = 0, spill = 0;
  for (let i = 0; i < N; i++) { if (art[i]) { black++; if (thread[i]) cov++; } if (thread[i]) { th++; if (dOut[i] > (0.3 / res) ** 2) spill++; } }
  return { coverage: cov / black, spill: spill / th, crossings };
}

// the engine's script files loaded into a fresh context, as script tags would (withLineArt: lineart.js first)
function pageEngine(withLineArt) {
  const g = { console }; g.self = g; g.window = g;
  const ctx = vm.createContext(g);
  for (const f of (withLineArt ? ['lineart.js'] : []).concat(['embwriter.js', 'digitize.js', 'engine.js'])) vm.runInContext(fs.readFileSync(path.join(ENGINE_DIR, f), 'utf8'), ctx, { filename: f });
  return g.Engine;
}
const pageBytes = (E, design) => { const r = E.generate(design); return D.hash(new Uint8Array(r.ir.commands.buffer, r.ir.commands.byteOffset, r.ir.commands.byteLength)); };

module.exports = {
  name: 'lineart: the Auto (line art) fill style',
  async run(t) {
    const fixRings = toPts(FIX.rings);
    LA.clearCache();
    const t0 = Date.now(), eyes = Engine.generate(fixtureDesign()), eyesMs = Date.now() - t0;

    await t.test('the user drawing: under 25,000 stitches and 120 trims, nothing too dense, exportable, valid', () => {
      assert.deepStrictEqual(Engine.validate(eyes), []);
      assert.strictEqual(eyes.canExport, true, codes(eyes).join(','));
      assert.ok(eyes.totals.stitches > 5000 && eyes.totals.stitches < 25000, 'stitches ' + eyes.totals.stitches);
      assert.ok(eyes.totals.trims < 120, 'trims ' + eyes.totals.trims);
      assert.strictEqual(eyes.totals.colors, 1);
      assert.ok(!codes(eyes).includes('TOO_DENSE'), codes(eyes).join(','));
      assert.deepStrictEqual(codes(eyes), [], 'no warnings at all');
      const file = Engine.export(eyes, { format: 'pes' }); assert.ok(file.bytes.length > 1000);
      const m = measure(fixRings, FIX.fillRule, eyes);
      assert.ok(m.coverage >= 0.95, 'coverage ' + m.coverage.toFixed(4));
      assert.ok(m.spill < 0.01, 'spill ' + m.spill.toFixed(4));
      assert.strictEqual(m.crossings, 0, 'stitches across bare fabric');
      // the same drawing as an ordinary fill, for the record
      const flat = Engine.generate(fixtureDesign({ style: 'tatami' })), mf = measure(fixRings, FIX.fillRule, flat);
      t.note('line art, user drawing (82 x 144 mm, ' + FIX.rings.length + ' rings)', eyes.totals.stitches + ' stitches, ' + eyes.totals.trims + ' trims, coverage ' + m.coverage.toFixed(3) + ', thread off the drawing ' + (m.spill * 100).toFixed(2) + '%, 0 stitches across bare fabric, generate ' + eyesMs + ' ms (uncached)');
      t.note('same drawing as the normal fill', flat.totals.stitches + ' stitches, ' + flat.totals.trims + ' trims, coverage ' + mf.coverage.toFixed(3) + ', thread off the drawing ' + (mf.spill * 100).toFixed(2) + '%, ' + mf.crossings + ' stitches across bare fabric');
    });

    await t.test('time: the user drawing generates in under 6 s without the cache, and instantly from it', () => {
      assert.ok(eyesMs < 6000, eyesMs + ' ms');
      const t1 = Date.now(), again = Engine.generate(fixtureDesign()), cachedMs = Date.now() - t1;
      assert.strictEqual(irHash(again), irHash(eyes));
      assert.ok(cachedMs < eyesMs / 3 || cachedMs < 150, 'cached ' + cachedMs + ' ms vs ' + eyesMs + ' ms');
      // another object changing does not invalidate the line art
      const d = fixtureDesign(); d.objects.push({ type: 'rect', x: 2, y: 170, width: 6, height: 6, color: '#cc0000' });
      const t2 = Date.now(), withRect = Engine.generate(d), rectMs = Date.now() - t2;
      assert.ok(rectMs < eyesMs / 3 || rectMs < 150, 'with another object ' + rectMs + ' ms');
      assert.strictEqual(withRect.objects[0].stitches, eyes.objects[0].stitches);
      t.note('line art cache', 'regenerate ' + cachedMs + ' ms, with another object added ' + rectMs + ' ms (uncached ' + eyesMs + ' ms)');
    });

    await t.test('deterministic: twice, from the cache, after clearing it, after a fresh require, and as page scripts', () => {
      const h = irHash(eyes);
      LA.clearCache(); assert.strictEqual(irHash(Engine.generate(fixtureDesign())), h, 'after clearing the cache');
      for (const k of Object.keys(require.cache)) if (k.startsWith(ENGINE_DIR + path.sep)) delete require.cache[k];
      const E2 = require(path.join(ENGINE_DIR, 'engine.js'));
      assert.notStrictEqual(E2, Engine);
      assert.strictEqual(irHash(E2.generate(fixtureDesign())), h, 'fresh require');
      assert.strictEqual(pageBytes(pageEngine(true), fixtureDesign()), h, 'page scripts, lineart.js first');
      const s = D.designs.lineart, hs = irHash(Engine.generate(s));
      assert.strictEqual(pageBytes(pageEngine(true), s), hs);
      t.note('line art IR hashes (node)', 'user drawing ' + h + ', synthetic ' + hs);
    });

    await t.test('lines by width: 0.3 mm running stitch, 0.6 mm triple run, 1.4 mm satin, a 16 mm disc an edge ring and tatami', () => {
      const kinds = rings => { const o = LA.buildUncached(toPts(rings), 'nonzero', BUILD, Dz); assert.ok(!o.skipped, o.skipped); return o.stats; };
      const pick = s => ({ run: s.run, bean: s.bean, ring: s.ring, satin: s.satin, edge: s.edgeLoops > 0, core: s.coreRuns > 0 });
      assert.deepStrictEqual(pick(kinds([bar([20, 50], [60, 50], 0.3)])), { run: 1, bean: 0, ring: 0, satin: 0, edge: false, core: false });
      assert.deepStrictEqual(pick(kinds([bar([20, 50], [60, 50], 0.6)])), { run: 0, bean: 1, ring: 0, satin: 0, edge: false, core: false });
      assert.deepStrictEqual(pick(kinds([bar([20, 50], [60, 50], 1.4)])), { run: 0, bean: 0, ring: 0, satin: 1, edge: false, core: false });
      assert.deepStrictEqual(pick(kinds([disc(50, 50, 8)])), { run: 0, bean: 0, ring: 0, satin: 0, edge: true, core: true });
      // through the engine: valid, one thread each, the 1.4 mm satin is about as wide as the line (+ pull)
      for (const w of [0.3, 0.6, 1.4]) {
        const r = Engine.generate(one([bar([20, 50], [60, 50], w)]));
        assert.deepStrictEqual(Engine.validate(r), []); assert.strictEqual(r.totals.trims, 1, w + ' mm'); assert.deepStrictEqual(codes(r), [], w + ' mm');
        assert.ok(r.bounds.height < w + 0.5 && r.bounds.height > w - 0.4, w + ' mm line: stitches ' + r.bounds.height.toFixed(2) + ' mm tall');
      }
      const r = Engine.generate(one([disc(50, 50, 8)]));
      assert.deepStrictEqual(Engine.validate(r), []); assert.deepStrictEqual(codes(r), []);
      assert.ok(Math.abs(r.bounds.width - 16) < 0.6, 'disc ' + r.bounds.width);
      // thin raised to 5 mm: a 4 mm line is one satin as wide as the line, not a 2.4 mm satin patched with loops
      const o4 = LA.buildUncached(toPts([bar([20, 50], [60, 50], 4)]), 'nonzero', Object.assign({ thin: 5, debug: true }, BUILD), Dz);
      assert.deepStrictEqual(pick(o4.stats), { run: 0, bean: 0, ring: 0, satin: 1, edge: false, core: false });
      let y0 = Infinity, y1 = -Infinity;
      for (const p of o4.parts) p.points.forEach((q, i) => { if (p.src[i] === 'satin' && q.x > 25 && q.x < 55) { y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); } });
      assert.ok(y1 - y0 > 3.7 && y1 - y0 < 4.5, '4 mm line with thin 5: satin ' + (y1 - y0).toFixed(2) + ' mm wide');
    });

    await t.test('synthetic hatching, lines and shapes: coverage 0.95 or more, under 1% of the thread off the drawing, nothing across bare fabric', () => {
      const s = D.designs.lineart, r = Engine.generate(s), m = measure(toPts(s.objects[0].rings), 'nonzero', r);
      assert.deepStrictEqual(Engine.validate(r), []); assert.deepStrictEqual(codes(r), []);
      assert.ok(m.coverage >= 0.95, 'coverage ' + m.coverage.toFixed(4));
      assert.ok(m.spill < 0.01, 'spill ' + m.spill.toFixed(4));
      assert.strictEqual(m.crossings, 0);
      t.note('line art, synthetic design', r.totals.stitches + ' stitches, ' + r.totals.trims + ' trims, coverage ' + m.coverage.toFixed(3) + ', thread off the drawing ' + (m.spill * 100).toFixed(2) + '%');
    });

    await t.test('separate black areas each get their own thread: a trim even when they are only 1 mm apart', () => {
      const rings = [disc(30, 50, 5), disc(41, 50, 5), bar([20, 58], [50, 58], 0.5), bar([20, 59.2], [50, 59.2], 0.5)]; // 1 mm and 0.7 mm of fabric between
      const art = Engine.generate(one(rings));
      assert.strictEqual(art.totals.trims, 4, 'one thread per black area');
      assert.strictEqual(measure(toPts(rings), 'nonzero', art).crossings, 0);
    });

    await t.test('assemble: trimBefore cuts the thread even for a short hop; parts without it are joined as before', () => {
      const a = { color: '#000000', objectIndex: 0, points: [{ x: 10, y: 10 }, { x: 13, y: 10 }] }, b = { color: '#000000', objectIndex: 0, points: [{ x: 14, y: 10 }, { x: 17, y: 10 }] };
      const trims = parts => { let n = 0; const c = Dz.assemble(parts, { hoopW: 100, hoopH: 100 }).ir.commands; for (let i = 0; i < c.length; i += 3) if (c[i] === OP.TRIM) n++; return n; };
      assert.strictEqual(trims([a, b]), 1, '1 mm apart: one thread');
      assert.strictEqual(trims([a, Object.assign({ trimBefore: true }, b)]), 2, 'trimBefore: two threads');
      assert.strictEqual(trims([Object.assign({ trimBefore: true }, a), b]), 1, 'on the first part there is nothing to cut');
      assert.deepStrictEqual(Engine.validate({ ir: Dz.assemble([a, Object.assign({ trimBefore: true }, b)], {}).ir }), []);
    });

    await t.test('every validation: the IR of all line-art results is well formed', () => {
      const designs = [fixtureDesign(), D.designs.lineart, one([bar([10, 10], [90, 90], 0.8), disc(70, 30, 6), bar([10, 90], [40, 60], 2.5)]),
        one([disc(50, 50, 20), disc(50, 50, 12)], { detail: 'bold' }), one([disc(50, 50, 20), disc(50, 50, 12)], { detail: 'fine' })];
      designs[3].objects[0].fillRule = designs[4].objects[0].fillRule = 'evenodd';
      for (const d of designs) { const r = Engine.generate(d); assert.deepStrictEqual(Engine.validate(r), []); assert.strictEqual(r.canExport, true); }
    });

    await t.test('fill settings reach the tatami core: angle, pattern, spacing; crosshatch sews two passes', () => {
      const base = Engine.generate(one([disc(50, 50, 10)])), turned = Engine.generate(one([disc(50, 50, 10)], { angle: 45 }));
      const brick = Engine.generate(one([disc(50, 50, 10)], { pattern: 'brick' })), loose = Engine.generate(one([disc(50, 50, 10)], { spacing: 0.8 }));
      const cross = Engine.generate(one([disc(50, 50, 10)], { pattern: 'crosshatch' }));
      assert.notStrictEqual(irHash(turned), irHash(base)); assert.notStrictEqual(irHash(brick), irHash(base));
      assert.ok(loose.totals.stitches < base.totals.stitches * 0.75, loose.totals.stitches + ' vs ' + base.totals.stitches);
      for (const r of [base, turned, brick, loose, cross]) { assert.deepStrictEqual(Engine.validate(r), []); assert.deepStrictEqual(codes(r), []); }
    });

    await t.test('detail: fine keeps more of a gappy drawing than bold; an unknown detail is reported and normal is used', () => {
      // 0.25 mm gaps between bars: normal and fine keep them, bold (closes gaps up to 0.4 mm) fills them in
      const bars = Array.from({ length: 8 }, (_, i) => bar([20 + i * 1.0, 30], [20 + i * 1.0, 60], 0.75));
      const st = detail => LA.buildUncached(toPts(bars), 'nonzero', Object.assign({ detail }, BUILD), Dz).stats;
      const fine = st('fine'), bold = st('bold');
      assert.ok(fine.edgeLoops === 0 && fine.ring + fine.bean === 8, 'fine: 8 lines ' + JSON.stringify(fine));
      assert.ok(bold.edgeLoops >= 1 && bold.coreRuns >= 1, 'bold: one wide block ' + JSON.stringify(bold));
      const r = Engine.generate(one(bars, { lineart: { detail: 'extreme' } })), w = r.warnings.find(x => x.code === 'PARAM_CLAMPED');
      assert.ok(w && w.param === 'Line art detail' && w.value === 'normal' && w.severity === 'info', JSON.stringify(r.warnings));
      assert.strictEqual(irHash(r), irHash(Engine.generate(one(bars, { lineart: { detail: 'normal' } }))));
    });

    await t.test('fallbacks: an unknown style, or lineart.js not loaded, sews the normal fill and says so', () => {
      const plain = { hoop: { width: 100, height: 100 }, objects: [{ type: 'path', rings: [disc(50, 50, 10), bar([20, 80], [80, 80], 0.6)], color: '#123456', fill: { angle: 30 } }] };
      const styled = style => { const d = JSON.parse(JSON.stringify(plain)); d.objects[0].fill.style = style; return d; };
      const h = irHash(Engine.generate(plain));
      assert.strictEqual(irHash(Engine.generate(styled('tatami'))), h, "'tatami' is the normal fill");
      assert.deepStrictEqual(codes(Engine.generate(styled('tatami'))), []);
      const odd = Engine.generate(styled('sparkly')), w = odd.warnings.find(x => x.code === 'PARAM_CLAMPED');
      assert.strictEqual(irHash(odd), h); assert.ok(w && w.param === 'Fill style' && w.value === 'tatami', JSON.stringify(odd.warnings));
      const E = pageEngine(false), r = E.generate(styled('lineart')), w2 = r.warnings.find(x => x.code === 'PARAM_CLAMPED');
      assert.strictEqual(pageBytes(E, plain), h);
      assert.strictEqual(irHash(r), h, 'without lineart.js the normal fill is sewn');
      assert.ok(w2 && /not loaded/.test(w2.message), JSON.stringify(r.warnings));
      assert.deepStrictEqual(Object.keys(Engine.FILL_STYLES), ['tatami', 'lineart']);
      assert.strictEqual(Engine.FILL_STYLES.lineart.label, 'Auto (line art)');
    });

    await t.test('the stitch limit: a line-art object that cannot fit is refused like any other', () => {
      const n = eyes.totals.stitches;
      const at = Engine.generate(fixtureDesign(), { maxStitches: n });
      assert.strictEqual(at.canExport, true); assert.strictEqual(irHash(at), irHash(eyes));
      for (const limit of [n - 1, 5000, 50]) {
        const r = Engine.generate(fixtureDesign(), { maxStitches: limit }), w = r.warnings.find(x => x.code === 'TOO_MANY_STITCHES');
        assert.ok(w, limit + ': ' + codes(r)); assert.strictEqual(w.limit, limit); assert.ok(w.stitches > limit, limit + ': count reached ' + w.stitches);
        assert.deepStrictEqual([r.canExport, r.totals.stitches, r.ir.commands.length, r.objects[0].skipped], [false, 0, 3, true], 'limit ' + limit);
        assert.deepStrictEqual(Engine.validate(r), []);
      }
      // a lower bound is all the build reports when it is over: never more stitches than there really are
      const asDigitize = Object.assign({ detail: 'normal', cross: false }, BUILD); // the options digitize passes: served from the cache
      const out = LA.build(fixRings, FIX.fillRule, asDigitize, Dz);
      assert.ok(out.lowerBound > 0 && out.lowerBound <= n, out.lowerBound + ' <= ' + n);
      const over = LA.build(fixRings, FIX.fillRule, Object.assign({ maxStitches: 100 }, asDigitize), Dz);
      assert.strictEqual(over.skipped, 'OVER_LIMIT'); assert.strictEqual(over.parts.length, 0);
    });

    await t.test('a very large drawing is traced on a coarser grid and says so (LINEART_REDUCED, info)', () => {
      const ring = [disc(200, 200, 180, 360), disc(200, 200, 178.8, 360).reverse()]; // a 1.2 mm ring 360 mm across
      const r = Engine.generate(one(ring, {}, { width: 400, height: 400 })), w = r.warnings.find(x => x.code === 'LINEART_REDUCED');
      assert.ok(w, codes(r).join(',')); assert.strictEqual(w.severity, 'info'); assert.ok(w.resolutionMm > 0.1 && w.resolutionMm < 0.2, w.resolutionMm);
      assert.strictEqual(r.canExport, true); assert.deepStrictEqual(Engine.validate(r), []);
      assert.ok(r.totals.trims <= 2, 'one ring, one thread: ' + r.totals.trims);
    });

    await t.test('awkward input: specks, open rings, self-crossing, duplicate points, paint both; never a throw', () => {
      const star = Array.from({ length: 5 }, (_, i) => { const a = -Math.PI / 2 + i * 4 * Math.PI / 5; return [50 + 30 * Math.cos(a), 50 + 30 * Math.sin(a)]; }); // self-crossing: a pentagram
      const cases = [
        [one([[[50, 50], [50.1, 50], [50.1, 50.1]]]), r => codes(r).includes('TINY_OBJECT') && codes(r).includes('EMPTY_DESIGN')],
        [one([]), r => codes(r).includes('EMPTY_DESIGN')],
        [one([star]), r => r.canExport],
        [Object.assign(one([star]), {}), r => r.canExport],
        [one([[[10, 10], [10, 10], [40, 10], [40, 10], [40, 12], [10, 12], [10, 10]]]), r => r.canExport],
        [one([[[10, 10], [60, 10], [60, 10.0001]]]), r => true],
        [{ hoop: { width: 100, height: 100 }, objects: [{ type: 'path', rings: [disc(50, 50, 10), { points: [[10, 90], [90, 90]], closed: false }], color: '#111111', paint: 'fill', fill: { style: 'lineart' } }] }, r => codes(r).includes('OPEN_PATH_NOT_FILLED') && r.canExport],
        [{ hoop: { width: 100, height: 100 }, objects: [{ type: 'ellipse', cx: 50, cy: 50, rx: 20, ry: 6, color: '#111111', paint: 'both', fill: { style: 'lineart' }, line: { type: 'satin', width: 2, color: '#cc0000' } }] }, r => r.canExport && r.totals.colors === 2],
        [{ hoop: { width: 100, height: 100 }, objects: [{ type: 'rect', x: 20, y: 20, width: 60, height: 1, color: '#111111', fill: { style: 'LineArt', lineart: 'nope' } }] }, r => r.canExport],
        [{ hoop: { width: 100, height: 100 }, objects: [{ type: 'polygon', points: star, fillRule: 'evenodd', color: '#111111', fill: { style: 'lineart', lineart: { thin: 99, satinMin: -1, beanMin: 'x', res: 0.001 } } }] }, r => r.canExport && codes(r).filter(c => c === 'PARAM_CLAMPED').length === 4],
      ];
      cases[3][0].objects[0].fillRule = 'evenodd';
      for (const [d, ok] of cases) {
        const r = Engine.generate(d);
        assert.ok(!codes(r).includes('INTERNAL_ERROR'), JSON.stringify(r.warnings));
        assert.deepStrictEqual(Engine.validate(r), []);
        assert.ok(ok(r), JSON.stringify(d).slice(0, 120) + ' -> ' + codes(r).join(','));
      }
    });

    await t.test('nothing else changes: every existing design gives the same bytes with lineart.js loaded as without it', () => {
      const without = pageEngine(false), withLA = pageEngine(true);
      const list = D.compare.map(k => D.designs[k]);
      for (const c of K.designCases()) list.push(c.design);
      for (const k of Object.keys(C.FILL_SHAPES)) list.push(C.fillDesign(C.FILL_SHAPES[k], { angle: 30 }));
      let n = 0;
      for (const d of list) {
        const h = irHash(Engine.generate(d));
        assert.strictEqual(pageBytes(without, d), h, 'without lineart.js: ' + (d.name || n));
        assert.strictEqual(pageBytes(withLA, d), h, 'with lineart.js first: ' + (d.name || n));
        n++;
      }
      t.note('line art golden guard', n + ' designs byte-identical with and without lineart.js loaded');
    });
  },
};
