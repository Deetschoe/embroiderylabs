/* The parts of the realistic renderer that need no browser: geometry, shading maths, seeding, options, bad input. */
'use strict';
var path = require('path');
var Core = require(path.join(__dirname, '../../js/realistic/core.js'));
var Realistic = require(path.join(__dirname, '../../js/realistic/realistic.js'));
var Engine = require(path.join(__dirname, '../../js/engine/engine.js'));
var Designs = require(path.join(__dirname, '../engine/designs.js')).designs;

module.exports = function (t) {
  var OP = Core.OP, testsew = Engine.generate(Designs.testsew), badge = Engine.generate(Designs.badge);
  function near(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }
  function simple(stitches, extra) { var d = { stitches: stitches, threads: [{ color: '#cc0000' }, { color: '#0000cc' }] }; for (var k in (extra || {})) d[k] = extra[k]; return d; }
  function hashBytes(a) { var h = 2166136261, i; for (i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 16777619); } return h >>> 0; }
  function renderAll(c, view, o, tile) {
    var job = Core.createJob(c, view, o, tile || 96), out = new Uint8ClampedArray(view.width * view.height * 4), tx, ty, r, y;
    for (ty = 0; ty < job.nby; ty++) for (tx = 0; tx < job.nbx; tx++) {
      r = Core.renderTile(job, tx, ty);
      for (y = 0; y < r.h; y++) out.set(r.data.subarray(y * r.w * 4, (y + 1) * r.w * 4), ((r.y + y) * view.width + r.x) * 4);
    }
    return out;
  }

  /* ----- geometry: stitch commands -> thread segments ----- */
  t.test('compile: a run of stitches becomes one segment per needle move, in millimetres', function () {
    var c = Core.compile(simple([OP.STITCH, 0, 0, OP.STITCH, 100, 0, OP.STITCH, 100, 50, OP.END, 0, 0]), { seed: 3 });
    t.equal(c.n, 2); t.equal(c.stitches, 3); t.equal(c.threads, 1);
    t.ok(near(c.ax[0], 0, 0.05) && near(c.bx[0], 10, 0.05) && near(c.by[1], 5, 0.05), 'tenths of a millimetre become millimetres (within the 0.04 mm wobble)');
    t.ok(near(c.bx[0], c.ax[1], 0) && near(c.by[0], c.ay[1], 0), 'consecutive stitches share a needle hole exactly');
    t.ok(c.bounds && near(c.bounds.width, 10, 0.1) && near(c.bounds.height, 5, 0.1), 'bounds');
  });
  t.test('compile: jumps, trims and colour changes lift the thread', function () {
    var c = Core.compile(simple([OP.STITCH, 0, 0, OP.STITCH, 30, 0, OP.JUMP, 200, 0, OP.STITCH, 200, 0, OP.STITCH, 230, 0, OP.TRIM, 0, 0, OP.STITCH, 400, 0, OP.STITCH, 430, 0,
      OP.COLOR_CHANGE, 0, 0, OP.STITCH, 0, 100, OP.STITCH, 30, 100, OP.END, 0, 0, OP.STITCH, 999, 999]));
    t.equal(c.n, 4, 'four sewn segments, none across the jump, the trim or the colour change, none after END');
    t.equal(c.threads, 2); t.equal(c.thread[0], 0); t.equal(c.thread[3], 1);
    t.equal(c.jumps.length / 5, 2, 'the two travels inside one colour are kept for showJumps');
    var i, longest = 0; for (i = 0; i < c.n; i++) longest = Math.max(longest, Math.hypot(c.bx[i] - c.ax[i], c.by[i] - c.ay[i]));
    t.ok(longest < 3.2, 'no segment is longer than a stitch');
  });
  t.test('compile: unit, offset and hoop of a plain design', function () {
    var c = Core.compile(simple([0, 0, 0, 0, 5, 0], { unit: 1, offset: [20, 30], hoop: { width: 100, height: 80 } }));
    t.equal(c.n, 1); t.ok(near(c.ax[0], 20, 0.05) && near(c.ay[0], 30, 0.05) && near(c.bx[0], 25, 0.05)); t.equal(c.hoop.width, 100);
  });
  t.test('compile: an engine result lands where the engine says its bounds are', function () {
    var c = Core.compile(testsew), b = testsew.bounds;
    t.ok(c.n > 1500, 'segments'); t.equal(c.threads, testsew.ir.threads.length);
    t.ok(near(c.bounds.minX, b.minX !== undefined ? b.minX : b.x, 0.2), 'left edge agrees with the engine within the wobble');
    t.equal(c.threadHex[0], testsew.ir.threads[0].color.toLowerCase());
    var stitchOps = 0, k; for (k = 0; k < testsew.ir.commands.length; k += 3) if (testsew.ir.commands[k] === OP.STITCH) stitchOps++;
    t.equal(c.stitches, stitchOps, 'every STITCH command is counted');
    t.ok(c.n < stitchOps && c.n > stitchOps * 0.9, 'nearly every stitch draws a segment');
  });
  t.test('loft map: thread layers are about one in a fill, more under a satin border, none on bare cloth', function () {
    var c = Core.compile(testsew), mid = Core.sampleGrid(c.loft, c.loft.layers, 50, 50), out = Core.sampleGrid(c.loft, c.loft.layers, 5, 5);
    t.ok(mid > 0.6 && mid < 3.5, 'middle of the fill: ' + mid.toFixed(2)); t.equal(out, 0);
    t.ok(Core.sampleGrid(c.loft, c.loft.shadow, 50, 50) > 0.5, 'shadow map is set under the design');
    t.equal(Core.sampleGrid(c.loft, c.loft.layers, -1e6, 1e6), 0, 'far outside the grid');
  });
  t.test('layout: swatch fits the design in the frame; garment puts it on the chest at true scale', function () {
    var W = 900, H = 700, l = Realistic.layout(testsew, {}, W, H), d = l.design;
    t.ok(d.x >= 0 && d.y >= 0 && d.x + d.width <= W && d.y + d.height <= H, 'design inside the frame');
    t.ok(near(d.x + d.width / 2, W / 2, 1.5) && near(d.y + d.height / 2, H / 2, 1.5), 'centred');
    t.ok(l.ppm <= 60 && l.ppm > 1, 'scale');
    var g = Realistic.layout(testsew, { scene: 'garment', garment: 'tshirt', placement: 'left-chest' }, 800, 900), gc = Realistic.layout(testsew, { scene: 'garment', garment: 'hoodie', placement: 'center-chest' }, 800, 900);
    t.equal(g.garment.kind, 'tshirt'); t.equal(gc.garment.kind, 'hoodie');
    t.ok(g.design.x + g.design.width / 2 > 400, 'left chest is on the right of the picture (the wearer\'s left)');
    t.ok(near(gc.design.x + gc.design.width / 2, 400, 1.5), 'centre chest is on the centre line');
    t.ok(near(g.design.width / g.ppm, Core.compile(testsew).bounds.width, 0.01), 'true scale: design pixels / scale = design millimetres');
    var z = Realistic.layout(testsew, { scene: 'garment', framing: 'chest' }, 800, 900);
    t.ok(z.ppm > g.ppm * 2, 'chest framing zooms in');
    var fixed = Realistic.layout(testsew, { pixelsPerMm: 7, origin: [12.5, -3] }, 400, 300);
    t.equal(fixed.ppm, 7); t.equal(fixed.ox, 12.5); t.equal(fixed.oy, -3);
    t.ok(Realistic.layout(null, null, 0, -5), 'nonsense gives an object, not an exception');
  });
  t.test('tiles: the same pixels whatever the tile size', function () {
    var c = Core.compile(testsew), view = { width: 220, height: 200, ppm: 4.4, ox: -110, oy: -60, falloff: 0.09 }, o = Core.normalizeOptions({ fabric: 'twill' });
    var a = renderAll(c, view, o, 64), b = renderAll(c, view, o, 256);
    t.equal(hashBytes(a), hashBytes(b), 'identical bytes with 64 px and 256 px tiles');
    var job = Core.createJob(c, view, o, 64), r = Core.renderTile(job, 99, 99);
    t.ok(r && r.w === 0 || r.h === 0 || r.data, 'a tile outside the picture is harmless');
    t.ok(Core.estimateCost(c, view, o) > 0, 'cost estimate');
  });
  t.test('pixels: thread where the stitches are, cloth elsewhere, nothing outside the frame', function () {
    var c = Core.compile(testsew), view = { width: 200, height: 200, ppm: 2, ox: 0, oy: 0 }, o = Core.normalizeOptions({ fabricColor: '#ffffff' }), px = renderAll(c, view, o);
    function at(mmx, mmy) { var q = (Math.round(mmy * 2) * 200 + Math.round(mmx * 2)) * 4; return [px[q], px[q + 1], px[q + 2], px[q + 3]]; }
    var fill = at(50, 50), cloth = at(8, 8), border = at(50, 35.2);
    t.ok(fill[2] > fill[0] + 40, 'blue fill in the middle: ' + fill); t.ok(border[0] > border[2] + 40, 'red satin on the edge: ' + border);
    t.ok(cloth[0] > 170 && cloth[1] > 170 && cloth[2] > 160, 'pale cloth in the corner: ' + cloth); t.equal(cloth[3], 255);
    var tr = renderAll(c, view, Core.normalizeOptions({ transparent: true }));
    t.equal(tr[(16 * 200 + 16) * 4 + 3], 0, 'transparent: no cloth'); t.ok(tr[(100 * 200 + 100) * 4 + 3] > 240, 'transparent: thread is opaque');
  });

  /* ----- shading maths ----- */
  t.test('light vectors: unit length, angle is where the light comes from, 0 = top, clockwise', function () {
    var L, a;
    for (a = 0; a < 360; a += 45) { L = Core.lightVectors(a, 48); t.ok(near(L.lx * L.lx + L.ly * L.ly + L.lz * L.lz, 1) && near(L.hx * L.hx + L.hy * L.hy + L.hz * L.hz, 1), 'unit at ' + a); t.ok(L.lz > 0); }
    L = Core.lightVectors(0, 48); t.ok(near(L.lx, 0) && L.ly < 0, 'from the top (screen y points down)');
    L = Core.lightVectors(90, 48); t.ok(L.lx > 0 && near(L.ly, 0), 'from the right');
    L = Core.lightVectors(315, 48); t.ok(L.lx < 0 && L.ly < 0, 'from the top left');
    t.ok(Core.lightVectors(0, 80).lz > Core.lightVectors(0, 20).lz, 'elevation');
  });
  t.test('sheen: thread across the light is bright, thread along it is dull; reversing a stitch changes nothing', function () {
    var L = Core.lightVectors(0, 40), across = Core.sheen(1, 0, L), along = Core.sheen(0, 1, L), diag = Core.sheen(Math.SQRT1_2, Math.SQRT1_2, L);
    t.ok(near(across.diffuse, 1) && near(across.specular, 1), 'across: full');
    t.ok(along.diffuse < across.diffuse && along.specular < 0.2, 'along: dull');
    t.ok(diag.specular < across.specular && diag.specular > along.specular, 'in between');
    var r = Core.sheen(-0.6, 0.8, L), f = Core.sheen(0.6, -0.8, L); t.ok(near(r.diffuse, f.diffuse) && near(r.specular, f.specular), 'symmetric');
    var a, s; for (a = 0; a < 360; a += 15) { s = Core.sheen(Math.cos(a * Math.PI / 180), Math.sin(a * Math.PI / 180), Core.lightVectors(a * 3, 48)); t.ok(s.diffuse >= 0 && s.diffuse <= 1 + 1e-9 && s.specular >= 0 && s.specular <= 1 + 1e-9, 'in range at ' + a); }
  });
  t.test('moving the light changes which side of a satin border is bright', function () {
    var c = Core.compile(testsew), view = { width: 200, height: 200, ppm: 2, ox: 0, oy: 0 };
    function lum(angle, x0, y0, x1, y1) { var px = renderAll(c, view, Core.normalizeOptions({ lightAngle: angle })), s = 0, n = 0, x, y, q; for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) { q = (y * 200 + x) * 4; s += px[q]; n++; } return s / n; }
    /* the top bar of the border has vertical stitches; the left bar has horizontal ones */
    function mean(a, b, x0, y0, x1, y1) { return (lum(a, x0, y0, x1, y1) + lum(b, x0, y0, x1, y1)) / 2; }
    var topAlong = mean(0, 180, 80, 68, 120, 72), topAcross = mean(90, 270, 80, 68, 120, 72), leftAcross = mean(0, 180, 68, 80, 72, 120), leftAlong = mean(90, 270, 68, 80, 72, 120);
    t.ok(topAcross > topAlong + 6, 'top bar is brighter lit from the sides: ' + topAcross.toFixed(1) + ' vs ' + topAlong.toFixed(1));
    t.ok(leftAcross > leftAlong + 6, 'left bar is brighter lit from above and below: ' + leftAcross.toFixed(1) + ' vs ' + leftAlong.toFixed(1));
    /* and it must not matter much which way round the column was sewn: the left bar is sewn upwards, the right bar downwards */
    var l0 = lum(0, 68, 80, 72, 120), r0 = lum(0, 128, 80, 132, 120);
    t.ok(Math.abs(l0 - r0) < 0.16 * Math.max(l0, r0), 'left and right bars look alike under a light from the top: ' + l0.toFixed(1) + ' vs ' + r0.toFixed(1));
  });
  t.test('colour: hex and rgb() in, nothing else; sRGB to linear is monotonic', function () {
    t.deepEqual(Core.parseColor('#abc'), [170, 187, 204]); t.deepEqual(Core.parseColor('1D4ED8'), [29, 78, 216]); t.deepEqual(Core.parseColor('rgb(1, 2, 3)'), [1, 2, 3]);
    t.equal(Core.parseColor('rgb(300,0,0)'), null); t.equal(Core.parseColor('red'), null); t.equal(Core.parseColor(7), null); t.equal(Core.parseColor(''), null);
    var a = Core.toLinear([0, 0, 0]), b = Core.toLinear([128, 128, 128]), c = Core.toLinear([255, 255, 255]);
    t.ok(near(a[0], 0) && near(c[0], 1, 1e-4) && b[0] > 0.2 && b[0] < 0.23, 'mid grey is about 0.216 linear');
  });
  t.test('fabrics: every fabric makes a seamless tile in the colour asked for', function () {
    Core.FABRICS.forEach(function (f) {
      var tile = Core.fabricTileBytes(f, '#3b5278', 10, 315, 48), d = tile.data, n = tile.width * tile.height, r = 0, g = 0, b = 0, i, lo = 255, hi = 0;
      t.ok(tile.width > 8 && tile.height > 8 && d.length === n * 4, f + ': size ' + tile.width + 'x' + tile.height);
      for (i = 0; i < n; i++) { r += d[i * 4]; g += d[i * 4 + 1]; b += d[i * 4 + 2]; lo = Math.min(lo, d[i * 4 + 2]); hi = Math.max(hi, d[i * 4 + 2]); }
      r /= n; g /= n; b /= n;
      t.ok(b > r + 15 && b > g, f + ': bluish on average (' + [r, g, b].map(Math.round) + ')'); t.ok(hi - lo > 12, f + ': has texture');
      /* seamless: the step across the wrap is no bigger than the steps inside the tile */
      var inside = 0, wrap = 0, y, w = tile.width;
      for (y = 0; y < tile.height; y++) { wrap += Math.abs(d[(y * w) * 4 + 1] - d[(y * w + w - 1) * 4 + 1]); inside += Math.abs(d[(y * w + (w >> 1)) * 4 + 1] - d[(y * w + (w >> 1) - 1) * 4 + 1]); }
      t.ok(wrap <= inside * 2.5 + tile.height * 2, f + ': no seam at the wrap (' + (wrap / tile.height).toFixed(1) + ' vs ' + (inside / tile.height).toFixed(1) + ')');
    });
    var pale = Core.fabricTileBytes('jersey', '#ffffff', 8).data, dark = Core.fabricTileBytes('jersey', '#101010', 8).data; t.ok(pale[1] > dark[1] + 120, 'any colour');
    var junk = Core.fabricTileBytes('velvet', 'nope', NaN); t.ok(junk.width > 0, 'junk in, a default tile out');
  });
  t.test('supersampling: more samples when a thread is thin on screen', function () {
    t.equal(Core.supersampleFor(2), 4); t.equal(Core.supersampleFor(40), 1); t.ok(Core.supersampleFor(8) >= Core.supersampleFor(12));
  });

  /* ----- seeding ----- */
  t.test('seeding: the same seed gives the same picture, another seed a slightly different one', function () {
    t.equal(Core.hash2(12, 34), Core.hash2(12, 34)); t.notEqual(Core.hash2(12, 34), Core.hash2(12, 35));
    var i, v, lo = 1, hi = 0, sum = 0; for (i = 0; i < 4000; i++) { v = Core.rnd(i, 7); lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v; }
    t.ok(lo >= 0 && hi < 1 && Math.abs(sum / 4000 - 0.5) < 0.03, 'rnd is in [0, 1) and even');
    var view = { width: 160, height: 160, ppm: 2, ox: -20, oy: -20, falloff: 0.09 };
    function pic(seed) { var o = Core.normalizeOptions({ seed: seed }); return renderAll(Core.compile(testsew, o), view, o); }
    var a = pic(5), b = pic(5), d = pic(6), diff = 0, big = 0, k;
    t.equal(hashBytes(a), hashBytes(b), 'seed 5 twice: identical bytes');
    for (k = 0; k < a.length; k++) if (a[k] !== d[k]) { diff++; if (Math.abs(a[k] - d[k]) > 90) big++; }
    t.ok(diff > 500, 'seed 6 differs'); t.ok(big < a.length * 0.02, 'but only slightly (' + big + ' large differences)');
    var c5 = Core.compile(testsew, { seed: 5 }), c6 = Core.compile(testsew, { seed: 6 }), m = 0; for (k = 0; k < c5.n; k++) m = Math.max(m, Math.abs(c5.ax[k] - c6.ax[k]));
    t.ok(m > 0 && m <= 0.081, 'needle points move by at most 0.04 mm each way: ' + m.toFixed(3));
  });

  /* ----- options ----- */
  t.test('options: defaults, clamping and warnings', function () {
    var d = Core.normalizeOptions(), k; for (k in Core.DEFAULTS) t.deepEqual(d[k], Core.DEFAULTS[k], 'default ' + k); t.equal(d.warnings.length, 0);
    var o = Core.normalizeOptions({ fabric: 'silk', scene: 5, garment: 'cape', placement: 'back', fabricColor: 'nope', lightAngle: -45, lightElevation: 500, pixelsPerMm: 1e9, threadWidth: -1, seed: 'x', margin: 9, origin: 'here', framing: 'moon' });
    t.equal(o.fabric, 'jersey'); t.equal(o.scene, 'swatch'); t.equal(o.garment, 'tshirt'); t.equal(o.placement, 'left-chest'); t.equal(o.fabricColor, '#e8e4dc'); t.equal(o.framing, 'garment');
    t.equal(o.lightAngle, 315); t.equal(o.lightElevation, 85); t.equal(o.pixelsPerMm, 400); t.equal(o.threadWidth, 0.15); t.equal(o.seed, 1); t.equal(o.margin, 0.45); t.equal(o.origin, null);
    var names = o.warnings.map(function (w) { return w.option; }).sort().join(',');
    t.equal(names, 'fabric,fabricColor,framing,garment,lightElevation,margin,origin,pixelsPerMm,placement,scene,seed,threadWidth');
    t.ok(o.warnings.every(function (w) { return w.code === 'BAD_OPTION'; }));
    var g = Core.normalizeOptions({ fabric: 'denim', fabricColor: '#ABC', lightAngle: 725, origin: { x: 3, y: 4 }, seed: 9.7, hoop: 1, showJumps: 'yes', transparent: 0 });
    t.equal(g.fabric, 'denim'); t.equal(g.fabricColor, '#aabbcc'); t.equal(g.lightAngle, 5); t.deepEqual(g.origin, [3, 4]); t.equal(g.seed, 9); t.equal(g.hoop, true); t.equal(g.showJumps, true); t.equal(g.transparent, false); t.equal(g.warnings.length, 0);
    ['nope', 5, null, undefined, [], function () {}].forEach(function (junk) { t.equal(Core.normalizeOptions(junk).fabric, 'jersey'); });
    t.deepEqual(Realistic.FABRICS, ['jersey', 'fleece', 'twill', 'denim']); t.deepEqual(Realistic.SCENES, ['swatch', 'garment']);
  });

  /* ----- bad input ----- */
  var BAD = [undefined, null, 0, 'stitches', [], {}, { stitches: null }, { stitches: 'abc' }, { stitches: [1, 2] }, { stitches: [0, NaN, 0, 0, Infinity, 5, 0, 1, 1] },
    { stitches: [0, 0, 0, 0, 10, 0], threads: 'red' }, { stitches: [0, 0, 0, 0, 10, 0], threads: [null, 5, { color: 'zz' }] }, { stitches: [99, 0, 0, -7, 5, 5, 0, 1e12, 0] },
    { stitches: new Int32Array(0), threads: [] }, { stitches: [0, 0, 0, 0, 10, 0], unit: -3, offset: 'x', hoop: { width: 'a' } }, { ir: {} }, { ir: { commands: {} } }, { ir: { commands: [0, 0, 0, 0, 5, 5], hoop: { w: 'x' } } },
    { stitches: { length: 9 } }, { get stitches() { throw new Error('boom'); } }];
  t.test('bad input: compile and layout never throw and say what was wrong', function () {
    BAD.forEach(function (bad, i) {
      var c; t.doesNotThrow(function () { c = Core.compile(bad, {}); }, 'compile #' + i);
      t.ok(c && c.n >= 0 && c.n <= 2 && Array.isArray(c.warnings), 'compile #' + i + ' returns a design'); if (c && !c.n) t.ok(c.warnings.length > 0, 'compile #' + i + ' explains itself');
      t.doesNotThrow(function () { Realistic.layout(bad, bad, 300, 200); }, 'layout #' + i);
      t.doesNotThrow(function () { var o = Core.normalizeOptions(bad), job = Core.createJob(c, { width: 40, height: 30, ppm: 3, ox: 0, oy: 0 }, o, 64); Core.renderTile(job, 0, 0); }, 'render tile #' + i);
    });
    var c = Core.compile({ stitches: [0, 0, 0, 0, 10, 0], threads: [{ color: 'zz' }] }); t.equal(c.warnings[0].code, 'BAD_THREAD_COLOR'); t.equal(c.threadHex[0], '#000000');
    t.equal(Core.compile(null).warnings[0].code, 'EMPTY_DESIGN'); t.equal(Core.compile({ stitches: [0, NaN, 0, 0, 1, 1, 0, 9, 9] }).warnings[0].code, 'BAD_STITCHES');
  });
  t.test('bad input: render and exportImage never throw; they resolve or reject with a code', function () {
    var jobs = [];
    BAD.concat([testsew, badge]).forEach(function (bad, i) {
      var p; t.doesNotThrow(function () { p = Realistic.render(bad, bad, bad); }, 'render(bad, bad, bad) #' + i);
      t.ok(p && typeof p.then === 'function' && typeof p.cancel === 'function', 'render #' + i + ' returns a cancellable promise'); t.doesNotThrow(function () { p.cancel(); p.cancel(); });
      jobs.push(p.then(function (s) { t.equal(s.ok, false, 'render #' + i + ' without a canvas is not ok'); t.equal(s.error.code, 'NO_CANVAS'); }));
      var fake = { width: 50, height: 50, getContext: function () { throw new Error('no'); } }, q; t.doesNotThrow(function () { q = Realistic.render(fake, bad, {}); }, 'render on a broken canvas #' + i);
      jobs.push(q.then(function (s) { t.equal(s.ok, false); t.ok(s.error && s.error.code, 'broken canvas #' + i + ': ' + (s.error && s.error.code)); }));
      var e; t.doesNotThrow(function () { e = Realistic.exportImage(bad, bad); }, 'exportImage #' + i);
      jobs.push(e.then(function () { t.ok(false, 'exportImage #' + i + ' cannot succeed without a canvas'); }, function (err) { t.ok(err instanceof Error && typeof err.code === 'string', 'exportImage #' + i + ' rejects with a code: ' + err.code); }));
    });
    t.doesNotThrow(function () { Realistic.dispose(); Realistic.dispose(); }, 'dispose');
    t.equal(Realistic.fabricCanvas('jersey', '#fff', 8), null, 'fabricCanvas without a canvas is null');
    return Promise.all(jobs);
  });
  /* ----- regressions found by the independent verification pass ----- */
  t.test('compile: the needle going down again in the very same place draws nothing', function () {
    var st = [], i; for (i = 0; i < 200; i++) st.push(OP.STITCH, 50, 50);
    var c = Core.compile(simple(st), { seed: 1 });
    t.equal(c.stitches, 200, 'every needle point is counted'); t.equal(c.n, 0, 'but no thread is drawn between a point and itself (there were fuzzy stubs)');
    c = Core.compile(simple([OP.STITCH, 0, 0, OP.STITCH, 0, 0, OP.STITCH, 100, 0, OP.STITCH, 100, 0, OP.STITCH, 100, 0, OP.STITCH, 0, 40]), { seed: 1 });
    t.equal(c.n, 2, 'repeats in the middle of a run do not break it'); t.ok(near(c.bx[0], c.ax[1], 0) && near(c.by[0], c.ay[1], 0), 'the run still shares its needle hole');
  });
  t.test('fabric: a new colour on a weave already built gives exactly what a fresh build gives; the draft is cheap and close', function () {
    var L = Core.lightVectors(315, 48), L2 = Core.lightVectors(40, 30), A = Core.toLinear([47, 71, 112]), B = Core.toLinear([200, 60, 40]);
    ['jersey', 'fleece', 'twill', 'denim'].forEach(function (kind) {
      Core.makeFabric(kind, A, 9, L);                                   /* builds and keeps the weave's shape */
      var warm = Core.makeFabric(kind, B, 9, L2), cold = Core.factory().makeFabric(kind, B, 9, L2);
      t.equal(hashBytes(new Uint8Array(warm.rgb.buffer)), hashBytes(new Uint8Array(cold.rgb.buffer)), kind + ': the kept shape changes no pixel');
      var d = Core.makeFabric(kind, B, 9, L2, true), full = warm, md = 0, mf = 0, i;
      t.ok(d !== full && d.w === full.w && d.h === full.h, kind + ': the draft is its own tile of the same size');
      for (i = 0; i < d.rgb.length; i++) { md += d.rgb[i]; mf += full.rgb[i]; }
      t.ok(Math.abs(md / mf - 1) < 0.03, kind + ': the draft has the same overall colour (' + (md / mf).toFixed(3) + ')');
    });
  });
  t.test('fabric: the knit of a nearly black cloth can still be seen, and pale cloth keeps its colour', function () {
    var L = Core.lightVectors(315, 48), dark = Core.makeFabric('jersey', Core.toLinear([27, 31, 42]), 26, L), v = [], i;
    for (i = 0; i < dark.w * dark.h; i++) v.push(dark.rgb[i * 3 + 1]);
    v.sort(function (a, b) { return a - b; });
    var lo = v[Math.floor(v.length * 0.05)], hi = v[Math.floor(v.length * 0.95)];
    t.ok(hi / lo > 2.2, 'lit yarn tops are clearly brighter than the grooves on dark cloth (' + (hi / lo).toFixed(2) + 'x; was about 1.9x and read as flat)');
    var c = Core.toLinear([232, 228, 220]), pale = Core.makeFabric('jersey', c, 26, L), m = 0; for (i = 0; i < pale.w * pale.h; i++) m += pale.rgb[i * 3 + 1];
    t.ok(Math.abs(m / (pale.w * pale.h) / c[1] - 0.98) < 0.02, 'pale cloth is not lightened by it');
  });
  t.test('thread: stitches lying side by side do not all catch the light alike', function () {
    var st = [], i, x, y; for (i = 0; i < 40; i++) st.push(OP.JUMP, 0, i * 20, OP.STITCH, 0, i * 20, OP.STITCH, 60, i * 20);
    var c = Core.compile({ stitches: st, threads: ['#3366aa'] }, { seed: 1 }), view = { width: 240, height: 820, ppm: 10, ox: 10, oy: 10 };
    var r = Core.renderTile(Core.createJob(c, view, { lightAngle: 0, fabricColor: '#202020' }, 1024), 0, 0), peak = [], m;
    for (i = 0; i < 40; i++) { m = 0; for (y = i * 20 + 7; y <= i * 20 + 13; y++) for (x = 60; x < 190; x++) m = Math.max(m, r.data[(y * r.w + x) * 4 + 1]); peak.push(m); }
    var lo = Math.min.apply(null, peak), hi = Math.max.apply(null, peak);
    t.equal(c.n, 40); t.ok((hi - lo) / hi > 0.27, 'the brightest highlight is well above the dullest (' + lo + ' to ' + hi + '; it was 153 to 188: every thread the same plastic tube)');
    t.ok(lo > 90, 'and no stitch goes dead');
  });
};
