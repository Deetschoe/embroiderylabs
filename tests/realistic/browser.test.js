/*
 * The renderer in a real browser: headless Chrome, page opened from file://, driven over a pipe (no port).
 * Checks that pictures are deterministic, not blank, inside the frame and that the console stays clean.
 * Returns a reason string if the browser checks cannot run at all (then nothing is queued).
 */
'use strict';
var cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
var CANDIDATES = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);

function launch(chrome) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'realistic-test-'));
  var child = cp.spawn(chrome, ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--user-data-dir=' + dir, '--window-size=1200,900', '--force-device-scale-factor=1'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  var out = child.stdio[3], inp = child.stdio[4], buf = Buffer.alloc(0), nextId = 1, waiting = {}, listeners = [], dead = null;
  child.on('error', function (e) { dead = e; Object.keys(waiting).forEach(function (k) { waiting[k].reject(e); }); });
  inp.on('data', function (d) {
    buf = Buffer.concat([buf, d]); var i, msg, w;
    while ((i = buf.indexOf(0)) >= 0) {
      msg = JSON.parse(buf.slice(0, i).toString('utf8')); buf = buf.slice(i + 1);
      if (msg.id && waiting[msg.id]) { w = waiting[msg.id]; delete waiting[msg.id]; if (msg.error) w.reject(new Error(msg.error.message)); else w.resolve(msg.result); }
      else listeners.forEach(function (f) { f(msg); });
    }
  });
  function send(method, params, sessionId) {
    return new Promise(function (resolve, reject) {
      if (dead) return reject(dead);
      var id = nextId++, m = { id: id, method: method, params: params || {} }; if (sessionId) m.sessionId = sessionId;
      waiting[id] = { resolve: resolve, reject: reject }; out.write(JSON.stringify(m) + '\0');
    });
  }
  return {
    open: async function (url) {
      var t = await send('Target.createTarget', { url: 'about:blank' }), a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true }), sid = a.sessionId;
      var errors = [], loaded, onLoad = new Promise(function (r) { loaded = r; });
      listeners.push(function (m) {
        if (m.sessionId !== sid) return;
        if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text));
        else if (m.method === 'Runtime.consoleAPICalled' && /^(error|warning|assert)$/.test(m.params.type)) errors.push('console.' + m.params.type + ': ' + m.params.args.map(function (x) { return x.value !== undefined ? String(x.value) : (x.description || x.type); }).join(' '));
        else if (m.method === 'Log.entryAdded' && /^(error|warning)$/.test(m.params.entry.level)) errors.push('log.' + m.params.entry.level + ': ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
        else if (m.method === 'Page.loadEventFired') loaded();
      });
      await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid); await send('Log.enable', {}, sid);
      await send('Page.navigate', { url: url }, sid); await onLoad;
      return {
        errors: errors,
        eval: async function (expr) {
          var r = await send('Runtime.evaluate', { expression: '(async function () { ' + expr + ' })()', awaitPromise: true, returnByValue: true }, sid);
          if (r.exceptionDetails) throw new Error('in the page: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
          return r.result.value;
        }
      };
    },
    close: async function () {
      try { await Promise.race([send('Browser.close'), new Promise(function (r) { setTimeout(r, 2000); })]); } catch (e) { /* already gone */ }
      await new Promise(function (r) { setTimeout(r, 200); }); try { child.kill(); } catch (e) { /* already gone */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* leave it */ }
    }
  };
}

module.exports = function (t) {
  var chrome = CANDIDATES.filter(function (c) { try { return fs.existsSync(c); } catch (e) { return false; } })[0];
  if (!chrome) return 'no Chrome found; set CHROME=/path/to/chrome';
  var browser = null, page = null;
  function insideFrame(s) { var r = s.designRect; return r && r.x >= 0 && r.y >= 0 && r.x + r.width <= s.width + 0.5 && r.y + r.height <= s.height + 0.5; }

  t.test('browser: the page loads from file:// with a clean console', async function () {
    browser = launch(chrome); page = await browser.open('file://' + path.join(__dirname, 'browser', 'page.html'));
    var v = await page.eval('return { realistic: typeof Realistic, core: typeof RealisticCore, engine: typeof Engine, version: Realistic.version, fabrics: Realistic.FABRICS.length };');
    t.equal(v.realistic, 'object'); t.equal(v.core, 'object'); t.equal(v.engine, 'object'); t.equal(v.fabrics, 4); t.equal(page.errors.length, 0, 'console: ' + page.errors.join(' | '));
  });
  t.test('browser: every fabric and every scene draws a picture that is not blank and sits inside the frame', async function () {
    var cases = [];
    ['jersey', 'fleece', 'twill', 'denim'].forEach(function (f) { cases.push({ fabric: f, fabricColor: '#d8d2c4' }); });
    cases.push({ hoop: true }, { scene: 'garment', garment: 'tshirt', placement: 'left-chest' }, { scene: 'garment', garment: 'tshirt', placement: 'center-chest', framing: 'chest' },
      { scene: 'garment', garment: 'hoodie', fabric: 'fleece', placement: 'left-chest' }, { scene: 'garment', garment: 'hoodie', fabric: 'fleece', placement: 'center-chest', framing: 'chest', fabricColor: '#39424e' }, { showJumps: true, fabric: 'twill' });
    for (var i = 0; i < cases.length; i++) {
      var o = cases[i], name = JSON.stringify(o), r = await page.eval('return T.render("badge", 640, 720, ' + JSON.stringify(o) + ');'), s = r.stats, m = r.m;
      t.ok(s.ok, name + ': ok ' + JSON.stringify(s.error || '')); t.equal(s.warnings.length, 0, name + ': warnings ' + JSON.stringify(s.warnings));
      t.ok(s.segments > 5000 && s.width === 640 && s.height === 720, name + ': stats'); t.ok(s.firstFrameMs > 0 && s.firstFrameMs <= s.totalMs + 0.5, name + ': first frame comes first');
      t.ok(insideFrame(s), name + ': design inside the frame ' + JSON.stringify(s.designRect));
      t.ok(m.opaque > 0.999, name + ': opaque'); t.ok(m.hi - m.lo > 60 && m.colours > 150, name + ': not blank (' + m.colours + ' colours, range ' + m.lo + '-' + m.hi + ')');
      t.ok(m.satInside > m.satOutside + 12, name + ': the colourful badge is where the stats say it is (' + m.satInside.toFixed(1) + ' inside, ' + m.satOutside.toFixed(1) + ' outside)');
    }
  });
  t.test('browser: deterministic, with workers, without workers and in one go', async function () {
    var r = await page.eval('var o = { fabric: "twill", seed: 4 }, a = await T.render("testsew", 700, 520, o), b = await T.render("testsew", 700, 520, o);' +
      'var c = await T.render("testsew", 700, 520, { fabric: "twill", seed: 4, workers: false }), d = await T.render("testsew", 700, 520, { fabric: "twill", seed: 4, sync: true });' +
      'var e = await T.render("testsew", 700, 520, { fabric: "twill", seed: 5 }), g = await T.render("badge", 500, 600, { scene: "garment", garment: "hoodie" }), h = await T.render("badge", 500, 600, { scene: "garment", garment: "hoodie" });' +
      'return { a: a.m.hash, b: b.m.hash, c: c.m.hash, d: d.m.hash, e: e.m.hash, g: g.m.hash, h: h.m.hash, wa: a.stats.workers, wc: c.stats.workers, wd: d.stats.workers, quick: a.stats.quickFrame };');
    t.equal(r.a, r.b, 'the same call twice gives the same pixels'); t.equal(r.a, r.c, 'workers and the main thread give the same pixels'); t.equal(r.a, r.d, 'so does sync');
    t.notEqual(r.a, r.e, 'another seed is another picture'); t.equal(r.g, r.h, 'garment scene twice gives the same pixels');
    t.ok(r.wa >= 1, 'workers were used from file:// (' + r.wa + ')'); t.equal(r.wc, 0); t.equal(r.wd, 0);
  });
  t.test('browser: a big design draws progressively, reports progress and can be cancelled or replaced', async function () {
    var r = await page.eval('var d = T.design("heavy"), cv = T.canvas(900, 700), prog = [], firstAt = 0, t0 = performance.now();' +
      'var s = await Realistic.render(cv, d, { onProgress: function (f) { prog.push(f); }, onFirstFrame: function (i) { firstAt = i.firstFrameMs; } });' +
      'var m = T.measure(cv, s.designRect);' +
      'var p1 = Realistic.render(cv, d, { fabric: "denim" }), p2 = Realistic.render(cv, d, { fabric: "fleece" }); var s1 = await p1, s2 = await p2;' +
      'var p3 = Realistic.render(cv, d, {}); p3.cancel(); var s3 = await p3; cv.remove();' +
      'return { s: s, m: m, n: prog.length, last: prog[prog.length - 1], rising: prog.every(function (v, i) { return i === 0 || v >= prog[i - 1]; }), firstAt: firstAt, s1: s1, s2ok: s2.ok, s2c: s2.cancelled, s3: s3 };');
    t.ok(r.s.ok && r.s.stitches > 20000, 'drawn: ' + r.s.stitches + ' stitches'); t.ok(r.s.tiles > 1 && r.n >= 1 && r.last === 1 && r.rising, 'progress rises to 1 over ' + r.s.tiles + ' tiles');
    t.ok(r.firstAt > 0 && r.firstAt <= r.s.totalMs, 'first frame after ' + r.firstAt.toFixed(0) + ' ms, done after ' + r.s.totalMs.toFixed(0) + ' ms'); t.ok(r.s.totalMs < 10000, 'not slow');
    t.ok(r.m.colours > 100 && r.m.opaque > 0.999, 'not blank');
    t.equal(r.s1.cancelled, true, 'a new render on the same canvas cancels the old one'); t.equal(r.s1.ok, false); t.ok(r.s2ok && !r.s2c, 'and the new one finishes');
    t.equal(r.s3.cancelled, true, 'cancel()');
  });
  t.test('browser: bad input never throws out of render and never leaves the console dirty', async function () {
    var r = await page.eval('var bad = [undefined, null, 0, "x", [], {}, { stitches: null }, { stitches: [0, NaN, 0, 0, Infinity, 5] }, { stitches: [0, 0, 0, 0, 50, 0], threads: "red" }, { ir: { commands: {} } }, { stitches: [0, 0, 0, 0, 50, 0, 0, 50, 50], threads: [{ color: "#c00" }] }];' +
      'var opts = [undefined, null, "x", { fabric: 7, scene: "moon", pixelsPerMm: -1, lightAngle: "north", seed: {}, origin: [NaN], threadWidth: 99, onProgress: 5, onFirstFrame: "no" }, { scene: "garment", garment: 3, placement: null, framing: 9 }, { onProgress: function () { throw new Error("caller bug"); }, hoop: true }];' +
      'var out = [], cv = T.canvas(200, 160), i, j, s;' +
      'for (i = 0; i < bad.length; i++) for (j = 0; j < opts.length; j++) { try { s = await Realistic.render(cv, bad[i], opts[j]); out.push(typeof s.ok === "boolean" && Array.isArray(s.warnings) ? (s.ok ? "ok" : s.error.code) : "odd"); } catch (e) { out.push("THREW " + e.message); } }' +
      'var zero = T.canvas(0, 0), z = await Realistic.render(zero, bad[10], {}), n = await Realistic.render(document.body, bad[10], {}), nn = await Realistic.render(null, bad[10], {});' +
      'var ex; try { await Realistic.exportImage(null, { width: -5, height: "tall", scale: 99 }); ex = "resolved"; } catch (e) { ex = e.code || "no code"; }' +
      'var m = T.measure(cv); cv.remove(); zero.remove(); return { out: out, zero: z.error && z.error.code, body: n.error && n.error.code, nul: nn.error && nn.error.code, ex: ex, opaque: m.opaque };');
    t.equal(r.out.filter(function (x) { return x !== 'ok'; }).join(','), '', 'every bad design and option set still draws cloth and resolves ok');
    t.equal(r.out.length, 66); t.equal(r.zero, 'EMPTY_CANVAS'); t.equal(r.body, 'NO_CANVAS'); t.equal(r.nul, 'NO_CANVAS'); t.ok(r.opaque > 0.999, 'the canvas shows cloth');
    t.equal(r.ex, 'resolved', 'exporting nothing gives a picture of bare cloth');
  });
  t.test('browser: exportImage gives a PNG at the size asked for, transparent when asked', async function () {
    var r = await page.eval('var st = null, a = await T.blobInfo(await Realistic.exportImage(T.design("testsew"), { width: 300, height: 240, scale: 2, onStats: function (s) { st = s; } }));' +
      'var b = await T.blobInfo(await Realistic.exportImage(T.design("testsew"), { width: 300, height: 240, scale: 3, transparent: true }));' +
      'var c = await T.blobInfo(await Realistic.exportImage(T.design("badge"), { scene: "garment", garment: "tshirt", width: 300, height: 360, transparent: true }));' +
      'var big = null; var d = await T.blobInfo(await Realistic.exportImage(T.design("testsew"), { width: 4000, height: 4000, scale: 4, onStats: function (s) { big = s; } }));' +
      'return { a: a, b: b, c: c, d: { width: d.width, height: d.height }, st: st, bigWarn: big.warnings, bigScale: big.scale };');
    t.deepEqual(r.a.sig, [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature'); t.equal(r.a.type, 'image/png'); t.equal(r.a.width, 600); t.equal(r.a.height, 480); t.ok(r.a.solid > 0.999, 'opaque by default');
    t.ok(r.st && r.st.ok && r.st.scale === 2 && r.st.bytes === r.a.size && insideFrame(r.st), 'onStats');
    t.equal(r.b.width, 900); t.equal(r.b.height, 720); t.ok(r.b.clear > 0.5 && r.b.solid > 0.05, 'transparent: thread only (' + (r.b.clear * 100).toFixed(0) + '% clear, ' + (r.b.solid * 100).toFixed(0) + '% solid)');
    t.equal(r.c.width, 600); t.ok(r.c.clear > 0.1 && r.c.solid > 0.3, 'transparent garment: the garment without the backdrop (' + (r.c.clear * 100).toFixed(0) + '% clear)');
    t.ok(r.d.width * r.d.height <= 36e6 && r.d.width < 16000, 'too large an export is scaled down: ' + r.d.width + 'x' + r.d.height); t.equal(r.bigWarn[0] && r.bigWarn[0].code, 'EXPORT_SCALED_DOWN');
  });
  t.test('browser: several canvases drawn at the same time all finish, each with its own picture', async function () {
    var r = await page.eval('var d = T.design("heavy"), fabrics = ["jersey", "fleece", "twill", "denim", "jersey", "twill"], alone = [], i;' +
      'for (i = 0; i < fabrics.length; i++) alone.push((await T.render(d, 520, 420 + i * 16, { fabric: fabrics[i], seed: i })).m.hash);' +
      'var together = await Promise.race([Promise.all(fabrics.map(function (f, i) { return T.render(d, 520, 420 + i * 16, { fabric: f, seed: i }); })), new Promise(function (res) { setTimeout(function () { res(null); }, 20000); })]);' +
      'return { alone: alone, together: together && together.map(function (x) { return x.m.hash; }), workers: together && together.map(function (x) { return x.stats.workers; }), ok: together && together.every(function (x) { return x.stats.ok; }) };');
    t.ok(r.together, 'all six finished (none was left waiting for tiles)');
    if (r.together) { t.ok(r.ok, 'all ok'); t.deepEqual(r.together, r.alone, 'the same pixels as when drawn one after another'); t.ok(r.workers.every(function (w) { return w >= 1; }), 'all used workers: ' + r.workers.join(',')); }
  });
  t.test('browser: a worker that dies in the middle does not lose the picture', async function () {
    var r = await page.eval('Realistic.dispose(); var W = window.Worker, made = [];' +
      'window.Worker = function (url) { var w = new W(url), n = 0, self = this; made.push(this); this.terminate = function () { w.terminate(); };' +
      '  this.postMessage = function (m) { if (m.t === "tile" && ++n === 3 && made[0] === self) { setTimeout(function () { if (self.onerror) self.onerror({ preventDefault: function () {} }); }, 0); return; } w.postMessage(m); };' +
      '  w.onmessage = function (ev) { if (self.onmessage) self.onmessage(ev); }; };' +
      'var a = await Promise.race([T.render("heavy", 800, 600, { fabric: "denim" }), new Promise(function (res) { setTimeout(function () { res(null); }, 20000); })]);' +
      'window.Worker = W; Realistic.dispose(); var b = await T.render("heavy", 800, 600, { fabric: "denim" });' +
      'return { a: a && a.m.hash, b: b.m.hash, ok: a && a.stats.ok, made: made.length, wb: b.stats.workers };');
    t.ok(r.a !== null, 'the render finished'); t.ok(r.ok, 'ok'); t.ok(r.made >= 2, r.made + ' workers were in use'); t.equal(r.a, r.b, 'the same pixels as an undisturbed render'); t.ok(r.wb >= 1, 'workers are back after dispose()');
  });
  t.test('browser: the main thread takes over when workers cannot be used', async function () {
    var r = await page.eval('Realistic.dispose(); var W = window.Worker; window.Worker = function () { throw new Error("no workers here"); };' +
      'var a = await T.render("heavy", 800, 600, { fabric: "twill", quickFrame: false }); window.Worker = W; Realistic.dispose(); var b = await T.render("heavy", 800, 600, { fabric: "twill", quickFrame: false });' +
      'return { a: a.m.hash, b: b.m.hash, wa: a.stats.workers, wb: b.stats.workers, ok: a.stats.ok };');
    t.ok(r.ok, 'drawn'); t.equal(r.wa, 0, 'no workers used'); t.ok(r.wb >= 1, 'workers come back after dispose()'); t.equal(r.a, r.b, 'the same pixels either way');
  });
  /* ----- regressions found by the independent verification pass ----- */
  t.test('browser: an export never goes over the pixel limit, however large the view asked for', async function () {
    var r = await page.eval('var st = null, lim = Realistic.limits, a = await T.blobInfo(await Realistic.exportImage(T.design("testsew"), { width: 1e9, height: 1e9, scale: 1, transparent: true, onStats: function (s) { st = s; } }));' +
      'var st2 = null, b = await T.blobInfo(await Realistic.exportImage(T.design("testsew"), { width: 30000, height: 3000, scale: 2, transparent: true, onStats: function (s) { st2 = s; } }));' +
      'return { a: { width: a.width, height: a.height, solid: a.solid }, b: { width: b.width, height: b.height, solid: b.solid }, warn: st.warnings.map(function (w) { return w.code; }), ok: st.ok && st2.ok, inside: [st.designRect, st2.designRect], lim: lim };');
    t.ok(r.ok, 'drawn'); t.ok(r.a.width * r.a.height <= 36e6 && r.a.width <= 8192, 'a 1e9 x 1e9 view comes out as ' + r.a.width + ' x ' + r.a.height + ' (it was 8192 x 8192, 67 million pixels)');
    t.ok(r.b.width * r.b.height <= 36e6 && r.b.width <= 8192 && Math.abs(r.b.width / r.b.height - 10) < 0.1, 'a long view keeps its shape: ' + r.b.width + ' x ' + r.b.height);
    t.ok(r.warn.indexOf('EXPORT_SCALED_DOWN') >= 0, 'and says so'); t.ok(r.a.solid > 0.001 && r.b.solid > 0.001, 'the design is still in the picture');
  });
  t.test('browser: a canvas that lost its picture (context lost and restored) is drawn again by itself', async function () {
    var r = await page.eval('var cv = T.canvas(700, 500), calls = 0; var s = await Realistic.render(cv, T.design("badge"), { fabric: "twill", scene: "garment", framing: "chest", onProgress: function () { calls++; } });' +
      'function snap(c) { var k = T.canvas(c.width, c.height); k.getContext("2d").drawImage(c, 0, 0); var h = T.measure(k).hash; k.remove(); return h; }' +
      'var before = snap(cv), at = calls; cv.getContext("2d").clearRect(0, 0, 700, 500); var blank = snap(cv);' +
      'cv.dispatchEvent(new Event("contextrestored")); var after = blank, t0 = performance.now();' +
      'while (after !== before && performance.now() - t0 < 15000) { await new Promise(function (res) { setTimeout(res, 100); }); after = snap(cv); }' +
      'var cv2 = T.canvas(300, 200); await Realistic.render(cv2, T.design("testsew"), {}); await Realistic.render(cv2, T.design("badge"), { fabric: "denim" }); var want = snap(cv2);' +
      'cv2.getContext("2d").clearRect(0, 0, 300, 200); cv2.dispatchEvent(new Event("contextrestored")); await new Promise(function (res) { setTimeout(res, 1500); }); var got = snap(cv2);' +
      'cv.remove(); cv2.remove(); return { ok: s.ok, before: before, blank: blank, after: after, quiet: calls === at, want: want, got: got };');
    t.ok(r.ok, 'drawn'); t.notEqual(r.before, r.blank, 'the picture was really gone'); t.equal(r.after, r.before, 'the same picture is back without render being called');
    t.ok(r.quiet, 'the redraw does not call the first render\'s onProgress again'); t.equal(r.got, r.want, 'it is the LAST picture drawn on that canvas that comes back');
  });
  t.test('browser: nothing heavy is drawn in one go on the page\'s own thread', async function () {
    var r = await page.eval('Realistic.dispose(); var a = await T.render("testsew", 1000, 1000, { fabric: "jersey" });' +
      'var b = await T.render("heavy", 900, 700, { fabric: "twill", workers: false }); var c = await T.render("heavy", 900, 700, { fabric: "twill" });' +
      'var d = await T.render("testsew", 900, 700, { pixelsPerMm: 30, workers: false }); var e = await T.render("testsew", 2000, 2400, { scene: "garment" });' +
      'var few = { stitches: [0, 0, 0, 0, 300, 0, 0, 300, 300, 0, 0, 300], threads: ["#222222"] }, f = await T.render(few, 1000, 1000, {}), g = await T.render(few, 300, 200, {});' +
      'return { a: a.stats, b: b.stats, hb: b.m.hash, hc: c.m.hash, wc: c.stats.workers, d: d.stats, e: e.stats, f: f.stats, g: g.stats };');
    t.ok(r.f.ok && r.f.workers >= 1 && r.f.quickFrame, 'three stitches on a 1000 x 1000 canvas: the cloth alone is too much to draw in one go (it was, and held the page for 120 to 140 ms)');
    t.ok(r.g.ok && r.g.workers === 0 && !r.g.quickFrame, 'a 300 x 200 picture is still drawn at once');
    t.ok(r.a.ok && r.a.workers >= 1 && r.a.quickFrame, 'a small design on a 1000 x 1000 canvas is not drawn synchronously any more (that took 120 to 140 ms): workers ' + r.a.workers);
    t.ok(r.b.supersample >= 2, 'the heavy design is supersampled here (' + r.b.supersample + 'x)'); t.equal(r.b.workers, 0);
    t.equal(r.b.tiles, Math.ceil(900 / 128) * Math.ceil(700 / 128), 'supersampled tiles are 128 px, so that one tile never holds the page (256 px tiles took up to 177 ms each)');
    t.equal(r.hb, r.hc, 'and the page and the workers still draw the same pixels'); t.ok(r.wc >= 1, 'workers used');
    t.equal(r.d.supersample, 1); t.equal(r.d.tiles, Math.ceil(900 / 256) * Math.ceil(700 / 256), 'tiles stay 256 px where nothing is supersampled');
    t.ok(r.e.ok && r.e.quickFrame, 'a 2000 x 2400 garment still gets its quick frame');
  });
  t.test('browser: the console stayed clean throughout', async function () {
    var errors = page ? page.errors.slice() : ['the page never opened'];
    if (browser) await browser.close();
    t.equal(errors.length, 0, errors.join(' | '));
  });
  return null;
};
