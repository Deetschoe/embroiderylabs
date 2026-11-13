/*
 * Writer test cases shared by writer.test.js (node only) and oracle.test.js (pyembroidery):
 *   - hand-written edge patterns and seeded random patterns, in the writer's own pattern model
 *     { name, threads: [0xRRGGBB], stitches: [[x, y, cmd]] } (0.1 mm units, y down), and
 *   - whole designs digitized by the engine, with the facts a file must preserve.
 */
'use strict';
const path = require('path');
const C = require('./corpus.js');
const D = require('./designs.js');
const Engine = require(path.join(__dirname, '..', '..', 'js', 'engine', 'engine.js'));
const W = Engine.Writer;
const { STITCH, JUMP, TRIM, STOP, END, COLOR_CHANGE } = W;

const FORMATS = ['pes', 'pes6', 'pec', 'dst'];
const WRITE = { pes: W.writePes, pes6: W.writePesV6, pec: W.writePec, dst: W.writeDst };

function edgeCases() {
  const cases = [];
  cases.push({ id: 'edge_single_stitch', name: 'x', threads: [0x000000], stitches: [[0, 0, STITCH]] });
  cases.push({ id: 'edge_two_stitches', name: 'x', threads: [0xff0000], stitches: [[0, 0, STITCH], [10, 0, STITCH], [10, 0, END]] });
  cases.push({ id: 'edge_offcentre', name: 'offcentre', threads: [0x00ff00], stitches: [[1000, 2000, STITCH], [1050, 2000, STITCH], [1050, 2040, STITCH], [1050, 2040, END]] });
  cases.push({ id: 'edge_negative', name: 'neg', threads: [0x0000ff], stitches: [[-500, -700, STITCH], [-450, -700, STITCH], [-450, -640, STITCH]] });
  cases.push({ id: 'edge_pec_boundaries', name: 'bound', threads: [0x123456],
    stitches: [[0, 0, STITCH], [62, 62, STITCH], [125, 125, STITCH], [61, 62, STITCH], [-2, -1, STITCH], [-66, -65, STITCH], [-66, 2000, STITCH], [1981, 2000, STITCH], [-66, -47, STITCH]] });
  cases.push({ id: 'edge_long_stitch', name: 'long', threads: [0x654321], stitches: [[0, 0, STITCH], [5000, 100, STITCH], [5000, -4200, STITCH], [0, 0, STITCH]] });
  cases.push({ id: 'edge_same_colour_twice', name: 'dup', threads: [0xef4444, 0xef4444, 0xef4444],
    stitches: [[0, 0, STITCH], [20, 0, STITCH], [20, 0, COLOR_CHANGE], [20, 20, STITCH], [40, 20, STITCH], [40, 20, COLOR_CHANGE], [40, 40, STITCH], [60, 40, STITCH]] });
  cases.push({ id: 'edge_near_colours', name: 'near', threads: [0x000000, 0x010101, 0x020202, 0x000001],
    stitches: [[0, 0, STITCH], [20, 0, STITCH], [20, 0, COLOR_CHANGE], [20, 20, STITCH], [40, 20, STITCH], [40, 20, COLOR_CHANGE], [40, 40, STITCH], [60, 40, STITCH], [60, 40, COLOR_CHANGE], [60, 60, STITCH], [80, 60, STITCH]] });
  cases.push({ id: 'edge_half_units', name: 'half', threads: [0xabcdef],
    stitches: [[0.5, 0.5, STITCH], [1.5, 2.5, STITCH], [2.5, -0.5, STITCH], [-1.5, -2.5, STITCH], [10.5, 11.5, STITCH]] });
  cases.push({ id: 'edge_stop', name: 'stop', threads: [0x3b82f6],
    stitches: [[0, 0, STITCH], [30, 0, STITCH], [30, 0, STOP], [30, 30, STITCH], [60, 30, STITCH]] });
  cases.push({ id: 'edge_trim_travel', name: 'trim', threads: [0x22c55e],
    stitches: [[0, 0, STITCH], [30, 0, STITCH], [30, 0, TRIM], [400, 300, STITCH], [430, 300, STITCH], [430, 300, TRIM], [430, 300, END]] });
  cases.push({ id: 'edge_no_name', threads: [0x8b5cf6], stitches: [[0, 0, STITCH], [25, 5, STITCH], [50, 0, STITCH]] });
  cases.push({ id: 'edge_64_colours', name: 'rainbow', threads: Array.from({ length: 70 }, (_, i) => (i * 0x031721 + 0x0a0b0c) & 0xffffff),
    stitches: (() => { const s = []; for (let i = 0; i < 70; i++) { if (i) s.push([i * 30 - 30 + 20, 0, COLOR_CHANGE]); s.push([i * 30, 0, STITCH], [i * 30 + 20, 0, STITCH]); } return s; })() });
  return cases;
}

// Seeded random pattern. Step sizes straddle the PEC short/long boundary (-64..63), the DST 121 limit and
// the 2047 limit; modes add STOPs, doubled trims, explicit jumps and half-unit coordinates.
function fuzzCase(seed) {
  const r = C.rng(seed);
  const int = (a, b) => a + Math.floor(r() * (b - a + 1));
  const pick = arr => arr[int(0, arr.length - 1)];
  const mode = seed % 6;
  const blocks = int(1, mode === 5 ? 12 : 5);
  const palettePool = [0x3b82f6, 0xef4444, 0x000000, 0x22c55e, 0xffffff, 0xf59e0b, 0x8b5cf6, 0xec4899, 0x14b8a6, 0x6b7280];
  const randomColor = () => (r() < 0.6 ? pick(palettePool) : int(0, 0xffffff));
  const threads = [], stitches = [];
  let x = int(-300, 300), y = int(-300, 300);
  const step = () => {
    const k = r();
    if (k < 0.55) return int(-30, 30);
    if (k < 0.75) return pick([-65, -64, -63, -62, 61, 62, 63, 64, 0, 0]);
    if (k < 0.9) return int(-130, 130);
    if (k < 0.97) return pick([-122, -121, -120, 120, 121, 122, 242, 243, -242, -243]);
    return mode === 3 ? int(-5000, 5000) : int(-700, 700);
  };
  const frac = () => (mode === 4 ? pick([0, 0.5, 0.25, -0.5, 0.75, 0.5]) : 0);
  for (let b = 0; b < blocks; b++) {
    threads.push(randomColor());
    if (b > 0) {
      if (r() < 0.5) stitches.push([x, y, TRIM]);
      if (mode === 2 && r() < 0.3) { threads.push(threads[threads.length - 1]); stitches.push([x, y, STOP]); }
      stitches.push([x, y, COLOR_CHANGE]);
      if (r() < 0.6) { x += step() * 3; y += step() * 3; stitches.push([x + frac(), y + frac(), JUMP]); }
    } else if (r() < 0.3) {
      stitches.push([x + frac(), y + frac(), JUMP]); // pattern that starts with an explicit jump
    }
    const n = int(1, mode === 1 ? 4 : 60);
    for (let i = 0; i < n; i++) {
      x += step(); y += step();
      stitches.push([x + frac(), y + frac(), STITCH]);
      if (r() < 0.04) {
        stitches.push([x, y, TRIM]);
        if (r() < 0.8) { x += step() * 2; y += step() * 2; stitches.push([x + frac(), y + frac(), JUMP]); }
        if (r() < 0.2) stitches.push([x, y, TRIM]); // doubled trim
      }
    }
  }
  if (r() < 0.8) stitches.push([x, y, END]);
  const names = ['Embroidery Labs', 'A', 'logo', 'Untitled', undefined, 'exactly8', 'nine_long'];
  const c = { id: 'fuzz' + String(seed).padStart(4, '0'), threads, stitches };
  const name = pick(names); if (name !== undefined) c.name = name;
  return c;
}

// Whole designs: every corpus fill (one angle each), every line path in every line type, the shared designs
// and a few random polygons. -> [{ id, design, result, pattern }]
function designCases() {
  const list = [], add = (id, design, name) => {
    const result = Engine.generate(design);
    if (!result.canExport) throw new Error('corpus design ' + id + ' cannot be exported: ' + result.warnings.map(w => w.code).join(','));
    list.push({ id, design, result, pattern: W.fromIR(result.ir, { name: name || id.slice(0, 16) }) });
  };
  const angles = [0, 45, 90, 30, 135, 60];
  Object.keys(C.FILL_SHAPES).forEach((k, i) => add('fill_' + k, C.fillDesign(C.FILL_SHAPES[k], { angle: angles[i % angles.length] })));
  for (const type of ['running', 'bean', 'satin']) for (const k of Object.keys(C.LINE_PATHS)) add('line_' + type + '_' + k, C.lineDesign(C.LINE_PATHS[k], { type, width: 3 }));
  for (const k of D.compare) add('design_' + k, D.designs[k], D.designs[k].name);
  for (let seed = 1; seed <= 12; seed++) {
    const d = { hoop: C.HOOP, objects: [{ type: 'polygon', points: C.randomPolygon(seed), fillRule: seed % 2 ? 'nonzero' : 'evenodd', color: '#447799', paint: 'both', fill: { angle: seed * 17 }, line: { type: seed % 3 ? 'satin' : 'bean', width: 2, color: '#222222' } }] };
    if (Engine.generate(d).canExport) add('random_' + seed, d);
  }
  return list;
}

// What any file written from this IR must contain, in the file's own (centred) coordinates.
function irFacts(ir, pattern) {
  const c = ir.commands, cx = pattern.center.x, cy = pattern.center.y, points = [];
  let trims = 0, changes = 0, inColourTrims = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, stitches = 0;
  for (let i = 0; i < c.length; i += 3) {
    if (c[i] === C.OP.STITCH) {
      stitches++;
      const x = c[i + 1] - cx, y = c[i + 2] - cy, l = points.length;
      if (!l || points[l - 2] !== x || points[l - 1] !== y) points.push(x, y);
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    } else if (c[i] === C.OP.TRIM) { trims++; if (c[i + 3] === C.OP.JUMP) inColourTrims++; }
    else if (c[i] === C.OP.COLOR_CHANGE) changes++;
  }
  return { stitches, points, trims, inColourTrims, changes, bounds: [minX, minY, maxX, maxY], threads: ir.threads.map(t => parseInt(t.color.slice(1), 16)) };
}

const collapse = list => list.filter((v, i) => i === 0 || v !== list[i - 1]);

module.exports = { FORMATS, WRITE, edgeCases, fuzzCase, designCases, irFacts, collapse, Engine, W };
