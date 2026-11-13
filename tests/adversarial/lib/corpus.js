/*
 * Designs of the adversarial suite: plain data in millimetres, written without the engine and without
 * tests/engine/designs.js. Each entry: { design, single? } where `single` marks a design whose first object
 * is the only thing sewn in its colour (the geometry tests measure that object alone).
 */
'use strict';

const ring = (cx, cy, rx, ry, n, rot) => Array.from({ length: n }, (_, i) => { const a = 2 * Math.PI * i / n + (rot || 0); return [+(cx + rx * Math.cos(a)).toFixed(3), +(cy + ry * Math.sin(a)).toFixed(3)]; });
const star = (cx, cy, R, r, n) => Array.from({ length: 2 * n }, (_, i) => { const a = -Math.PI / 2 + Math.PI * i / n, q = i % 2 ? r : R; return [+(cx + q * Math.cos(a)).toFixed(3), +(cy + q * Math.sin(a)).toFixed(3)]; });
const box = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

// one filled object per design: what the geometry attack measures
const shapes = {
  rect:        { type: 'rect', x: 20, y: 30, width: 50, height: 30 },
  rectRot:     { type: 'rect', x: 25, y: 35, width: 50, height: 24, rotation: 33 },
  rectThin:    { type: 'rect', x: 20, y: 40, width: 60, height: 2.2 },
  rectNeg:     { type: 'rect', x: 80, y: 70, width: -55, height: -35 },
  circle:      { type: 'circle', cx: 50, cy: 50, r: 22 },
  circleSmall: { type: 'circle', cx: 50, cy: 50, r: 3 },
  ellipseRot:  { type: 'ellipse', cx: 50, cy: 50, rx: 36, ry: 11, rotation: 28 },
  triangle:    { type: 'polygon', points: [[15, 80], [50, 12], [85, 80]] },
  sliver:      { type: 'polygon', points: [[10, 50], [90, 46], [90, 54]] },
  star5:       { type: 'polygon', points: star(50, 50, 38, 14, 5) },
  star9thin:   { type: 'polygon', points: star(50, 50, 40, 9, 9) },
  U:           { type: 'polygon', points: [[15, 15], [32, 15], [32, 62], [68, 62], [68, 15], [85, 15], [85, 85], [15, 85]] },
  C:           { type: 'polygon', points: [[80, 15], [20, 15], [20, 85], [80, 85], [80, 68], [38, 68], [38, 32], [80, 32]] },
  E:           { type: 'polygon', points: [[15, 10], [80, 10], [80, 24], [30, 24], [30, 42], [70, 42], [70, 56], [30, 56], [30, 76], [80, 76], [80, 90], [15, 90]] },
  comb:        { type: 'polygon', points: [[10, 20], [90, 20], [90, 80], [78, 80], [78, 34], [66, 34], [66, 80], [54, 80], [54, 34], [42, 34], [42, 80], [30, 80], [30, 34], [18, 34], [18, 80], [10, 80]] },
  spiral:      { type: 'polygon', points: [[10, 10], [90, 10], [90, 90], [10, 90], [10, 30], [70, 30], [70, 70], [30, 70], [30, 50], [50, 50], [50, 58], [38, 58], [38, 62], [62, 62], [62, 38], [18, 38], [18, 82], [82, 82], [82, 18], [10, 18]] },
  donut:       { type: 'path', rings: [ring(50, 50, 34, 34, 90), ring(50, 50, 16, 16, 60).reverse()] },
  donutEO:     { type: 'path', fillRule: 'evenodd', rings: [ring(50, 50, 34, 26, 90), ring(50, 50, 20, 12, 60)] },
  twoHoles:    { type: 'path', fillRule: 'evenodd', rings: [box(10, 25, 80, 50), box(20, 35, 22, 30), box(58, 35, 22, 30)] },
  frame:       { type: 'path', fillRule: 'evenodd', rings: [box(10, 10, 80, 80), box(18, 18, 64, 64)] },
  islands:     { type: 'path', rings: [box(10, 10, 25, 25), box(60, 12, 28, 20), ring(50, 70, 14, 14, 50)] },
  nested:      { type: 'path', fillRule: 'evenodd', rings: [ring(50, 50, 40, 40, 100), ring(50, 50, 28, 28, 80), ring(50, 50, 16, 16, 60), ring(50, 50, 6, 6, 30)] },
  bowtie:      { type: 'polygon', points: [[15, 20], [85, 80], [85, 20], [15, 80]] },
  pentagram:   { type: 'polygon', points: [0, 2, 4, 1, 3].map(i => ring(50, 50, 40, 40, 5, -Math.PI / 2)[i]) },
  pentagramEO: { type: 'polygon', fillRule: 'evenodd', points: [0, 2, 4, 1, 3].map(i => ring(50, 50, 40, 40, 5, -Math.PI / 2)[i]) },
  blob:        { type: 'polygon', points: Array.from({ length: 140 }, (_, i) => { const a = 2 * Math.PI * i / 140, r = 28 + 9 * Math.sin(3 * a) + 5 * Math.cos(7 * a); return [+(50 + r * Math.cos(a)).toFixed(3), +(50 + r * Math.sin(a)).toFixed(3)]; }) },
  closedLine:  { type: 'polyline', closed: true, points: [[20, 20], [80, 25], [70, 80], [45, 55], [25, 75]] },
};

const fills = {
  default: {},
  a45: { angle: 45 },
  a90: { angle: 90 },
  a17: { angle: 17 },
  aNeg: { angle: -63 },
  noUnder: { underlay: false },
  loose: { spacing: 1.2, stitchLength: 4.5 },
  long: { stitchLength: 7, angle: 30 },
  short: { stitchLength: 1, spacing: 0.3 },
  noPull: { pullComp: 0 },
  bigPull: { pullComp: 1, angle: 70 },
};

function fillDesign(shapeKey, fillKey) {
  return { name: shapeKey + ' ' + fillKey, hoop: { width: 100, height: 100 }, objects: [Object.assign({ id: shapeKey, color: '#1d4ed8', paint: 'fill', fill: Object.assign({}, fills[fillKey]) }, JSON.parse(JSON.stringify(shapes[shapeKey])))] };
}

// whole designs: what the reader, sequencing and DST attacks export
const designs = {
  // which way is up: an L (tall bar on the LEFT, foot at the BOTTOM) plus a dot in the TOP RIGHT
  asym: { name: 'Asym', hoop: { width: 100, height: 100 }, objects: [
    { id: 'L', type: 'polygon', points: [[20, 10], [30, 10], [30, 60], [70, 60], [70, 70], [20, 70]], color: '#cc3344' },
    { id: 'dot', type: 'circle', cx: 62, cy: 18, r: 4, color: '#2244ff' } ] },
  oneRect: { name: 'One', hoop: { width: 100, height: 100 }, objects: [{ type: 'rect', x: 30, y: 30, width: 30, height: 20, color: '#008800' }] },
  oneLine: { name: 'Line', hoop: { width: 100, height: 100 }, objects: [{ type: 'line', x1: 10, y1: 10, x2: 90, y2: 70, color: '#000000' }] },
  tinyLine: { name: 'Tiny', hoop: { width: 100, height: 100 }, objects: [{ type: 'line', x1: 50, y1: 50, x2: 51, y2: 50, color: '#000000' }] },
  mixed: { name: 'Mixed', hoop: { width: 130, height: 180 }, objects: [
    Object.assign({ id: 'd', color: '#aa2233', paint: 'both', fill: { angle: 30 }, line: { type: 'satin', width: 2.5, color: '#101010' } }, { type: 'path', rings: [ring(60, 60, 34, 34, 90), ring(60, 60, 12, 12, 50).reverse()] }),
    { id: 's', type: 'polygon', points: star(60, 60, 9, 4, 5), color: '#ffcc00' },
    { id: 'w', type: 'polyline', points: Array.from({ length: 50 }, (_, i) => [15 + 2 * i, 120 + 6 * Math.sin(i / 4)]), color: '#2244ff', line: { type: 'bean' } },
    { id: 'r', type: 'rect', x: 20, y: 140, width: 90, height: 25, color: '#2244ff', paint: 'both', line: { type: 'running', color: '#ffffff' } },
    { id: 'l', type: 'line', x1: 20, y1: 172, x2: 110, y2: 172, color: '#101010', line: { type: 'satin', width: 4 } } ] },
  // same colour used again with another between, and the same colour back to back (no colour change wanted)
  repeats: { name: 'Repeats', hoop: { width: 100, height: 100 }, objects: [
    { type: 'rect', x: 5, y: 5, width: 20, height: 20, color: '#ff0000' }, { type: 'rect', x: 70, y: 70, width: 20, height: 20, color: '#ff0000' },
    { type: 'rect', x: 40, y: 40, width: 15, height: 15, color: '#00ff00' }, { type: 'rect', x: 5, y: 70, width: 20, height: 20, color: '#ff0000' },
    { type: 'circle', cx: 80, cy: 15, r: 8, color: '#0000ff' } ] },
  // objects as far apart as the largest hoop allows: one move longer than a PEC record can hold (204.7 mm)
  farApart: { name: 'Far', hoop: { width: 300, height: 300 }, objects: [
    { type: 'rect', x: 2, y: 2, width: 10, height: 10, color: '#000000' }, { type: 'rect', x: 288, y: 288, width: 10, height: 10, color: '#000000' },
    { type: 'rect', x: 288, y: 2, width: 10, height: 10, color: '#ff0000' }, { type: 'rect', x: 2, y: 288, width: 10, height: 10, color: '#ff0000' } ] },
  wideOnly: { name: 'Wide', hoop: { width: 300, height: 200 }, objects: [{ type: 'line', x1: 3, y1: 100, x2: 297, y2: 100, color: '#123456', line: { type: 'bean' } }] },
  // a run that starts exactly where the previous one ended
  touching: { name: 'Touch', hoop: { width: 100, height: 100 }, objects: [
    { type: 'line', x1: 10, y1: 50, x2: 50, y2: 50, color: '#000000' }, { type: 'line', x1: 50, y1: 50, x2: 90, y2: 20, color: '#000000' },
    { type: 'line', x1: 90, y1: 20, x2: 90, y2: 80, color: '#ff00ff' } ] },
  satins: { name: 'Satins', hoop: { width: 100, height: 100 }, objects: [
    { type: 'line', x1: 10, y1: 15, x2: 90, y2: 15, color: '#000000', line: { type: 'satin', width: 1 } },
    { type: 'line', x1: 10, y1: 30, x2: 90, y2: 30, color: '#000000', line: { type: 'satin', width: 3 } },
    { type: 'line', x1: 10, y1: 50, x2: 90, y2: 50, color: '#444444', line: { type: 'satin', width: 8 } },
    { type: 'line', x1: 10, y1: 75, x2: 90, y2: 75, color: '#888888', line: { type: 'satin', width: 12 } } ] },
  manyColors: { name: 'Rainbow', hoop: { width: 200, height: 200 }, objects: Array.from({ length: 40 }, (_, i) => (
    { type: 'rect', x: 5 + (i % 8) * 24, y: 5 + Math.floor(i / 8) * 38, width: 18, height: 30, color: '#' + ('00000' + ((i * 0x3a5f71 + 0x102030) & 0xffffff).toString(16)).slice(-6) })) },
};
// one design per shape with every stitch kind of a closed outline
for (const k of ['U', 'donut', 'star5', 'blob']) {
  designs['both_' + k] = { name: 'both ' + k, hoop: { width: 100, height: 100 }, objects: [Object.assign({ color: '#1d4ed8', paint: 'both', line: { type: k === 'U' ? 'satin' : k === 'donut' ? 'running' : k === 'star5' ? 'bean' : 'satin', width: 2.4, color: '#e11d48' } }, JSON.parse(JSON.stringify(shapes[k])))] };
}

module.exports = { shapes, fills, fillDesign, designs, ring, star, box };
