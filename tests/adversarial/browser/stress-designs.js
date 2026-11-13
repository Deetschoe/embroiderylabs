/*
 * Designs used by the browser worker test. Loaded by the page (window.StressDesigns) and by node
 * (require), so that both sides generate exactly the same thing and can compare file hashes.
 */
(function (root) {
  'use strict';
  var dense = { spacing: 0.2, stitchLength: 1 };
  function colour(i) { return '#' + ('00000' + ((i * 0x2f4b6d + 0x111111) & 0xffffff).toString(16)).slice(-6); }
  function grid(n, size, gap, fill, colours) {
    var o = [];
    for (var j = 0; j < n; j++) for (var i = 0; i < n; i++) o.push({ type: 'rect', x: gap + i * (size + gap), y: gap + j * (size + gap), width: size, height: size, color: colours ? colour(i + j * n) : '#224488', fill: fill });
    return o;
  }
  var S = {};
  // small designs whose results and files must be the same in the worker, on the main thread and in node
  S.identity = {
    twoColours: { name: 'Two colours', hoop: { width: 100, height: 100 }, objects: [
      { type: 'rect', x: 10, y: 10, width: 30, height: 20, color: '#cc0000' },
      { type: 'ellipse', cx: 70, cy: 60, rx: 15, ry: 22, color: '#0044cc', fill: { angle: 30 } },
      { type: 'path', points: [[12, 80], [30, 70], [50, 85], [70, 90]], color: '#cc0000', paint: 'line', line: { type: 'satin', width: 3 } } ] },
    outline: { name: 'Outline', hoop: { width: 100, height: 100 }, objects: [
      { type: 'polygon', points: [[20, 20], [80, 25], [70, 80], [50, 50], [25, 75]], color: '#117733', paint: 'both', line: { type: 'running', color: '#000000' } } ] },
    // what an editor may really send: wrong types, missing fields, numbers that are not numbers
    hostile: { name: 'Bad <b>input</b> ä中', hoop: { width: 100, height: 100 }, objects: [
      { type: 'rect', x: NaN, y: 10, width: 30, height: 20, color: '#cc0000' },
      { type: 'rect', x: 10, y: 10, width: -5, height: 20, color: 'red' },
      { type: 'nothing' }, null, 7, 'text',
      { type: 'ellipse', cx: 50, cy: 50, rx: 20, ry: 10, color: '#00F', id: 'kept' },
      { type: 'rect', x: 500, y: 500, width: 30, height: 20, color: '#cc0000' } ] },
    empty: { name: 'Empty', hoop: { width: 100, height: 100 }, objects: [] },
    sixteen: { name: 'Sixteen colours', hoop: { width: 130, height: 180 }, objects: grid(4, 25, 5, undefined, true) },
    dense200x300: { name: 'Dense 200x300', hoop: { width: 200, height: 300 }, objects: [{ type: 'rect', x: 2, y: 2, width: 196, height: 296, color: '#224488', fill: dense }] },
  };
  S.formats = ['pes', 'pes6', 'pec', 'dst'];
  // i = 0, 1, 2, ...: every one differs from all the others in its stitches
  S.light = function (i) { return { name: 'light-' + i, hoop: { width: 100, height: 100 }, objects: [{ type: 'rect', x: 10, y: 10, width: 10 + (i % 70), height: 12 + ((i / 70) | 0), color: '#cc0000' }] }; };
  // about 30 ms of work
  S.medium = function (i) { return { name: 'medium-' + i, hoop: { width: 200, height: 200 }, objects: [{ type: 'ellipse', cx: 100, cy: 100, rx: 50 + (i % 40), ry: 80, color: '#0044cc', fill: { angle: i % 180 } }, { type: 'rect', x: 5, y: 5, width: 60, height: 40 + (i % 9), color: '#cc0000', paint: 'both' }] }; };
  // slow on purpose and inside the stitch limit (LIMITS.maxStitches): three fills with 600 thin spikes each, about
  // 290,000 stitches and seconds of work
  S.slow = function () {
    var o = [];
    for (var k = 0; k < 3; k++) {
      var pts = [];
      for (var i = 0; i < 1200; i++) { var a = -Math.PI / 2 + Math.PI * i / 600, q = i % 2 ? 40 : 140 - 10 * k; pts.push([+(150 + q * Math.cos(a)).toFixed(4), +(150 + q * Math.sin(a)).toFixed(4)]); }
      o.push({ type: 'polygon', points: pts, color: k % 2 ? '#123456' : '#654321', fill: { angle: k * 40, spacing: 0.8 } });
    }
    return { name: 'slow', hoop: { width: 300, height: 300 }, objects: o };
  };
  // over the stitch limit: 16 dense fills covering a 1000 mm hoop, about 4.9 million stitches per layer (refused)
  S.heavy = function (layers) {
    var o = [];
    for (var k = 0; k < (layers || 1); k++) o = o.concat(grid(4, 245, 4, { spacing: 0.2, stitchLength: 1, angle: k * 45 }, false));
    return { name: 'heavy', hoop: { width: 1000, height: 1000 }, objects: o };
  };
  S.many = function (n) { var o = []; for (var i = 0; i < n; i++) o.push({ type: 'rect', x: 5 + (i % 10) * 19, y: 5 + ((i / 10) | 0) * 19, width: 16, height: 16, color: colour(i % 5) }); return { name: 'many', hoop: { width: 200, height: 200 }, objects: o }; };
  if (typeof module !== 'undefined' && module.exports) module.exports = S; else root.StressDesigns = S;
})(typeof window !== 'undefined' ? window : this);
