/*
 * Whole designs shared by the node suites and the browser page (classic script: window.EngineTestDesigns;
 * node: require). Plain data only, built without the engine. Units: millimetres, hoop top-left origin.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EngineTestDesigns = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const ring = (cx, cy, rx, ry, n) => Array.from({ length: n }, (_, i) => [+(cx + rx * Math.cos(2 * Math.PI * i / n)).toFixed(4), +(cy + ry * Math.sin(2 * Math.PI * i / n)).toFixed(4)]);
  const star = (cx, cy, R, r, n) => Array.from({ length: n * 2 }, (_, i) => { const a = -Math.PI / 2 + Math.PI * i / n, q = i % 2 ? r : R; return [+(cx + q * Math.cos(a)).toFixed(4), +(cy + q * Math.sin(a)).toFixed(4)]; });
  const wave = Array.from({ length: 61 }, (_, i) => [20 + i, +(88 + 4 * Math.sin(i / 5)).toFixed(4)]);

  const designs = {
    // one colour, one object: the smallest real file
    patch: { name: 'Patch', hoop: { width: 100, height: 100 }, objects: [
      { id: 'p', type: 'rect', x: 30, y: 35, width: 40, height: 30, color: '#1d4ed8' } ] },

    // fill + satin border in another colour, a hole, a bean line, a running line: every stitch type
    badge: { name: 'Badge', hoop: { width: 100, height: 100 }, objects: [
      { id: 'disc', type: 'path', rings: [ring(50, 45, 32, 32, 96), ring(50, 45, 10, 10, 48).reverse()], color: '#cc3344', paint: 'both',
        fill: { angle: 45, spacing: 0.4, stitchLength: 3 }, line: { type: 'satin', width: 2.5, color: '#111111' } },
      { id: 'star', type: 'polygon', points: star(50, 45, 8, 3.5, 5), color: '#f5c518', fill: { angle: 0 } },
      { id: 'wave', type: 'polyline', points: wave, color: '#224488', line: { type: 'bean', stitchLength: 2.5 } },
      { id: 'rule', type: 'line', x1: 20, y1: 95, x2: 80, y2: 95, color: '#224488', line: { type: 'running' } } ] },

    // text-like blocks: many small objects, repeated colours, trims between them
    blocks: { name: 'Blocks', hoop: { width: 130, height: 180 }, objects: (function () {
      const out = [], cols = ['#000000', '#ef4444', '#000000', '#22c55e', '#3b82f6', '#3b82f6'];
      for (let i = 0; i < 12; i++) out.push({ id: 'b' + i, type: i % 3 === 2 ? 'ellipse' : 'rect', x: 12 + (i % 4) * 28, y: 15 + Math.floor(i / 4) * 50, width: 20, height: 32,
        cx: 22 + (i % 4) * 28, cy: 31 + Math.floor(i / 4) * 50, rx: 10, ry: 16, rotation: i * 7, color: cols[i % cols.length], paint: i % 4 === 1 ? 'both' : 'fill',
        fill: { angle: i * 15, underlay: i % 2 === 0 }, line: { type: i % 2 ? 'satin' : 'bean', width: 2 } });
      return out;
    })() },

    // concave and compound shapes with travel inside the shape
    letters: { name: 'U and O', hoop: { width: 100, height: 100 }, objects: [
      { id: 'U', type: 'polygon', points: [[10, 20], [22, 20], [22, 62], [38, 62], [38, 20], [50, 20], [50, 75], [10, 75]], color: '#0f766e', fill: { angle: 20 } },
      { id: 'O', type: 'path', fillRule: 'evenodd', rings: [ring(74, 47, 18, 28, 80), ring(74, 47, 8, 17, 60)], color: '#7c3aed', paint: 'both', line: { type: 'running', stitchLength: 2 } },
      { id: 'frame', type: 'path', rings: [{ points: rect(5, 10, 90, 75), closed: true }], color: '#111111', paint: 'line', line: { type: 'satin', width: 1.8, spacing: 0.45 } } ] },

    // a large fill: the heaviest file a 100 mm hoop holds at default settings
    full: { name: 'Full hoop', hoop: { width: 100, height: 100 }, objects: [
      { id: 'bg', type: 'rect', x: 1, y: 1, width: 98, height: 98, color: '#fde68a', fill: { angle: 90 } },
      { id: 'dot', type: 'circle', cx: 50, cy: 50, r: 22, color: '#b91c1c', paint: 'both', line: { type: 'satin', width: 3, color: '#ffffff' } } ] },
  };

  // the file to try on a real machine first: small, two colours, a fill, a satin border and one trim inside a colour
  designs.testsew = { name: 'Test sew', hoop: { width: 100, height: 100 }, objects: [
    { id: 'sq', type: 'rect', x: 35, y: 35, width: 30, height: 30, color: '#1d4ed8', paint: 'both', fill: { angle: 45 }, line: { type: 'satin', width: 2.5, color: '#ef4444' } },
    { id: 'dot', type: 'circle', cx: 50, cy: 25, r: 4, color: '#ef4444' } ] };

  // something slow enough to still be running when it is superseded (used by the responsiveness and cancel tests):
  // two fills with 600 thin spikes each, about 200,000 stitches, so inside the engine's limit (LIMITS.maxStitches)
  designs.slow = { name: 'Slow', hoop: { width: 300, height: 300 }, objects: Array.from({ length: 2 }, (_, i) => (
    { id: 's' + i, type: 'polygon', points: star(150, 150, 140 - 10 * i, 40, 600), color: i % 2 ? '#123456' : '#654321', fill: { angle: i * 40, spacing: 0.8 } })) };

  // more than a machine takes (about 1.9 million stitches): the engine refuses it with TOO_MANY_STITCHES
  designs.heavy ={ name: 'Heavy', hoop: { width: 300, height: 300 }, objects: Array.from({ length: 30 }, (_, i) => (
    { id: 'h' + i, type: 'ellipse', cx: 150, cy: 150, rx: 140 - i, ry: 140 - i, color: i % 2 ? '#123456' : '#654321', fill: { angle: i * 6, spacing: 0.3 } })) };

  // names used for the exported files (label handling: accents, emoji, long, path-like)
  const exportNames = { patch: 'Patch', badge: 'Café Badge №1', blocks: 'A very long design name that keeps going', letters: '../U&O', full: '', testsew: 'Test sew' };

  // 32-bit FNV-1a, hex. Enough to tell two byte arrays apart across node and the browser.
  function hash(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
    return ('0000000' + (h >>> 0).toString(16)).slice(-8) + ':' + bytes.length;
  }
  return { designs, exportNames, formats: ['pes', 'dst', 'pec', 'pes6'], compare: ['patch', 'badge', 'blocks', 'letters', 'full', 'testsew'], hash };
});
