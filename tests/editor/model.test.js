/*
 * Editor model: the stitch-style fields (fillStyle, lineDetail) and the engine input they make.
 * Pure node, no browser: js/editor/geom.js and js/editor/model.js are run in a vm with a bare `window`.
 *
 *   node tests/editor/model.test.js
 *
 * Proves:
 *   - a plain-fill object turns into exactly the engine input it gave before stitch styles existed: every
 *     design in designs/*.embroidr (or EMB_DESIGNS_DIR) goes through M.toEngine() byte-identical to the
 *     frozen legacy mapping below, and so does a document with one shape of every type;
 *   - line art adds fill.style and fill.lineart = { detail } and nothing else;
 *   - fillStyle and lineDetail survive save and load; an unknown value loads as the plain fill / normal;
 *   - setProp refuses an unknown style; the importer's style.fillStyle passes through M.addMany;
 *   - with no Engine.FILL_STYLES the editor still offers ['tatami', 'lineart'].
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..', '..');
const Engine = require(path.join(REPO, 'js', 'engine', 'engine.js'));

function loadEditor(engine) {
  const win = { Engine: engine, localStorage: { getItem() { return null; }, setItem() {} } };
  win.window = win;
  const ctx = vm.createContext(win);
  for (const f of ['geom.js', 'model.js']) vm.runInContext(fs.readFileSync(path.join(REPO, 'js', 'editor', f), 'utf8'), ctx, { filename: f });
  return win.Editor;
}

/* M.toEngine as it was before stitch styles (commit f72828b), kept verbatim as the reference. */
function legacyToEngine(doc, paintOf) {
  return {
    name: doc.name,
    hoop: { width: doc.hoop.w, height: doc.hoop.h },
    objects: doc.objects.map(function (o) {
      var e = {
        id: o.id, color: o.color, paint: paintOf(o),
        fill: { spacing: o.spacing, stitchLength: o.stitchLen, angle: o.angle, pattern: o.pattern || 'smooth' },
        line: { type: o.lineType, stitchLength: o.stitchLen, width: o.lineWidth, spacing: o.spacing }
      };
      switch (o.type) {
        case 'rect': e.type = 'rect'; e.x = o.x; e.y = o.y; e.width = o.w; e.height = o.h; break;
        case 'ellipse': e.type = 'ellipse'; e.cx = o.cx; e.cy = o.cy; e.rx = o.rx; e.ry = o.ry; break;
        case 'line': e.type = 'line'; e.x1 = o.x1; e.y1 = o.y1; e.x2 = o.x2; e.y2 = o.y2; break;
        case 'polygon': e.type = 'polygon'; e.points = o.pts; break;
        case 'path': e.type = 'path'; e.rings = o.rings; e.fillRule = o.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'; break;
        default: e.type = 'polyline'; e.points = o.pts; e.closed = !!o.closed;
      }
      return e;
    })
  };
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }
}

const ED = loadEditor(Engine), M = ED.Model;

const EVERY_TYPE = {
  name: 'every type', hoop: { w: 130, h: 180 },
  objects: [
    { id: 'a', name: 'R', type: 'rect', x: 10, y: 10, w: 30, h: 20, color: '#112233', paint: 'fill', lineType: 'running', lineWidth: 3, spacing: 0.4, stitchLen: 3, angle: 30, pattern: 'brick' },
    { id: 'b', name: 'E', type: 'ellipse', cx: 60, cy: 40, rx: 12, ry: 8, color: '#445566', paint: 'both', lineType: 'satin', lineWidth: 2.5, spacing: 0.5, stitchLen: 2.5, angle: 0 },
    { id: 'c', name: 'L', type: 'line', x1: 5, y1: 100, x2: 80, y2: 120, color: '#778899', paint: 'line', lineType: 'bean', lineWidth: 3, spacing: 0.4, stitchLen: 2, angle: 0 },
    { id: 'd', name: 'P', type: 'polygon', pts: [[90, 90], [120, 95], [100, 130]], color: '#aabbcc', paint: 'fill', lineType: 'running', lineWidth: 3, spacing: 0.4, stitchLen: 3, angle: 45 },
    { id: 'e', name: 'S', type: 'pen', pts: [[10, 150], [20, 155], [30, 150]], closed: false, color: '#ddeeff', paint: 'line', lineType: 'running', lineWidth: 3, spacing: 0.4, stitchLen: 3, angle: 0 },
    { id: 'f', name: 'O', type: 'path', rings: [[[50, 140], [80, 140], [80, 170], [50, 170]], [[60, 150], [60, 160], [70, 160], [70, 150]]], fillRule: 'evenodd', color: '#123456', paint: 'fill', lineType: 'running', lineWidth: 3, spacing: 0.4, stitchLen: 3, angle: 90 }
  ]
};

test('a plain-fill document gives exactly the old engine input', () => {
  M.load(EVERY_TYPE);
  assert.strictEqual(JSON.stringify(M.toEngine()), JSON.stringify(legacyToEngine(M.doc, M.paintOf)));
  M.doc.objects.forEach(o => { assert.strictEqual(o.fillStyle, 'tatami'); assert.strictEqual(o.lineDetail, 'normal'); });
});

const DIR = process.env.EMB_DESIGNS_DIR || path.join(REPO, 'designs');
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => /\.embroidr$/.test(f)).sort() : [];
if (!files.length) console.log('  skip designs/*.embroidr: none found in ' + DIR + ' (set EMB_DESIGNS_DIR)');
files.forEach(f => {
  test('design ' + f + ': engine input byte-identical to the old mapping', () => {
    const data = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const doc = data.doc || data;
    const dropped = M.load(doc);
    assert.strictEqual(dropped, 0, 'objects dropped on load');
    const now = JSON.stringify(M.toEngine()), before = JSON.stringify(legacyToEngine(M.doc, M.paintOf));
    assert.strictEqual(now, before);
    assert.ok(now.indexOf('"style"') < 0 && now.indexOf('lineart') < 0, 'no stitch-style keys in plain-fill input');
    const r = Engine.generate(M.toEngine());
    assert.ok(r && r.totals && r.totals.stitches > 0, 'the engine sews it');
  });
});

test('line art adds fill.style and fill.lineart and nothing else', () => {
  M.load(EVERY_TYPE);
  const id = M.doc.objects[0].id;
  assert.ok(M.setProp([id], 'fillStyle', 'lineart'));
  assert.ok(M.setProp([id], 'lineDetail', 'fine'));
  const e = M.toEngine().objects[0], old = legacyToEngine(M.doc, M.paintOf).objects[0];
  assert.strictEqual(JSON.stringify(e.fill.lineart), '{"detail":"fine"}');
  assert.strictEqual(e.fill.style, 'lineart');
  delete e.fill.style; delete e.fill.lineart;
  assert.strictEqual(JSON.stringify(e), JSON.stringify(old));
  assert.strictEqual(M.undoLabel(), 'Change line detail');
  /* the other objects are untouched */
  assert.strictEqual(JSON.stringify(M.toEngine().objects.slice(1)), JSON.stringify(legacyToEngine(M.doc, M.paintOf).objects.slice(1)));
});

test('fillStyle and lineDetail round-trip through save and load', () => {
  M.load(EVERY_TYPE);
  const id = M.doc.objects[5].id;
  M.setProp([id], 'fillStyle', 'lineart'); M.setProp([id], 'lineDetail', 'bold');
  M.setDefault('fillStyle', 'lineart');
  const saved = JSON.parse(JSON.stringify(M.serialize()));
  M.load(saved);
  const o = M.get(id);
  assert.strictEqual(o.fillStyle, 'lineart'); assert.strictEqual(o.lineDetail, 'bold');
  assert.strictEqual(M.defaults.fillStyle, 'lineart');
  assert.strictEqual(M.toEngine().objects[5].fill.lineart.detail, 'bold');
});

test('an unknown fillStyle or lineDetail loads as the plain fill / normal; setProp refuses it', () => {
  const doc = JSON.parse(JSON.stringify(EVERY_TYPE));
  doc.objects[0].fillStyle = 'zigzag<script>'; doc.objects[0].lineDetail = 42;
  doc.objects[1].fillStyle = 'lineart'; doc.objects[1].lineDetail = 'extreme';
  M.load(doc);
  assert.strictEqual(M.doc.objects[0].fillStyle, 'tatami'); assert.strictEqual(M.doc.objects[0].lineDetail, 'normal');
  assert.strictEqual(M.doc.objects[1].fillStyle, 'lineart'); assert.strictEqual(M.doc.objects[1].lineDetail, 'normal');
  assert.strictEqual(M.setProp([M.doc.objects[0].id], 'fillStyle', 'nope'), false);
  assert.strictEqual(M.setProp([M.doc.objects[0].id], 'lineDetail', 'nope'), false);
  assert.strictEqual(M.validProp('fillStyle', '__proto__'), null);
  /* names every object has (prototype keys) are not details either */
  ['__proto__', 'constructor', 'toString'].forEach(k => assert.strictEqual(M.validProp('lineDetail', k), null));
  doc.objects[1].lineDetail = 'constructor';
  M.load(doc);
  assert.strictEqual(M.doc.objects[1].lineDetail, 'normal');
});

test("the importer's style.fillStyle passes through M.addMany", () => {
  M.load({ name: 'x', hoop: { w: 100, h: 100 }, objects: [] });
  const made = M.addMany([
    { geom: { type: 'path', rings: [[[1, 1], [9, 1], [9, 9], [1, 9]]], fillRule: 'nonzero' }, style: { color: '#000000', paint: 'fill', fillStyle: 'lineart' } },
    { geom: { type: 'polygon', pts: [[20, 20], [30, 20], [25, 30]] }, style: { fillStyle: 'bogus', lineDetail: 'fine' } }
  ], 'Import SVG');
  assert.strictEqual(made.length, 2);
  assert.strictEqual(made[0].fillStyle, 'lineart');
  assert.strictEqual(made[1].fillStyle, 'tatami'); assert.strictEqual(made[1].lineDetail, 'fine');
});

test('without Engine.FILL_STYLES the editor still knows tatami and lineart', () => {
  const eng = Object.assign({}, Engine); delete eng.FILL_STYLES;
  const M2 = loadEditor(eng).Model;
  assert.strictEqual(Object.keys(M2.FILL_STYLES).join(), 'tatami,lineart');
  assert.strictEqual(M2.validProp('fillStyle', 'lineart'), 'lineart');
});

console.log((failed ? 'FAILED ' + failed + ', ' : '') + passed + ' passed');
process.exit(failed ? 1 : 0);
