/* ==========================================================================
   EMBROIDERY LABS - js/editor/stitchfile.js
   Reads machine files (.pes, .pec, .dst) so they can be opened in the editor.
   Creates Editor.StitchFile. No DOM; also loads in node (module.exports).

   A machine file holds needle points, not shapes. What comes out is one open
   stroke per run of thread, with line type 'raw': the engine sews exactly
   through those points. It can be moved, recoloured, re-ordered, erased, put
   on a mockup and exported again; it cannot be turned back into fills.

   read(bytes, name) -> { ok: true, format, blocks: [{ color, runs: [[[x, y], ...]] }],
                          stitches, colors, bounds: { x0, y0, x1, y1 } (mm), notes: [text] }
                     or { ok: false, error: text }
   toObjects(parsed, hoop) -> { objects: [...model objects...], hoop: { w, h }, runs, dropped }
   ========================================================================== */
(function (root) {
  'use strict';
  var MAX_RUNS = 1800, MAX_RUN_POINTS = 15000, MAX_STITCHES = 500000;
  /* thread colours for files that carry none (DST): easy to tell apart, in the order threads are usually loaded */
  var DST_COLORS = ['#1f3a5f', '#c0392b', '#2e8b57', '#e0a526', '#7d3c98', '#d35400', '#16808a', '#8e5b3a', '#cf5a8a', '#4a4d52', '#6aa5d8', '#9aa63c'];

  function ascii(b, o, n) { var s = ''; for (var i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]); return s; }
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u24(b, o) { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function hex(n) { return '#' + ('00000' + (n >>> 0).toString(16)).slice(-6); }

  /* ops: [kind, x, y] with kind S stitch, J jump / trim, C colour change, E end; units 0.1 mm, y down */
  function pecOps(buf, P, notes) {
    var out = { ops: [], palette: [] };
    if (buf.length < P + 532) throw new Error('The file is too short to hold any stitches.');
    var n = buf[P + 48] + 1, i;
    for (i = 0; i < n && P + 49 + i < buf.length; i++) out.palette.push(buf[P + 49 + i]);
    var L = u24(buf, P + 514), stop = Math.min(buf.length, P + 512 + L);
    if (P + 512 + L > buf.length) notes.push('The file ends early; what could be read is shown.');
    var x = 0, y = 0;
    i = P + 532 - 4;                                    /* the stream starts 528 bytes into the block */
    function read() {
      var b = buf[i];
      if (b & 0x80) { var v = ((b & 0x0f) << 8) | buf[i + 1]; if (v & 0x800) v -= 0x1000; i += 2; return { v: v, flag: b & 0x70 }; }
      i += 1; return { v: b > 63 ? b - 128 : b, flag: 0 };
    }
    while (i < stop) {
      var b0 = buf[i];
      if (b0 === 0xff) { out.ops.push(['E', x, y]); break; }
      if (b0 === 0xfe && buf[i + 1] === 0xb0) { out.ops.push(['C', x, y]); i += 3; continue; }
      var dx = read(), dy = read();
      if (i > stop) break;
      x += dx.v; y += dy.v;
      out.ops.push([(dx.flag | dy.flag) & 0x30 ? 'J' : 'S', x, y]);
      if (out.ops.length > MAX_STITCHES * 2) throw new Error('The file has too many stitches to open.');
    }
    return out;
  }
  function dstOps(buf) {
    var ops = [], x = 0, y = 0, i;
    if (buf.length < 515) throw new Error('The file is too short to hold any stitches.');
    for (i = 512; i + 2 < buf.length; i += 3) {
      var b0 = buf[i], b1 = buf[i + 1], b2 = buf[i + 2];
      if ((b2 & 0xf3) === 0xf3) { ops.push(['E', x, y]); break; }
      if ((b2 & 0xc3) === 0xc3) { ops.push(['C', x, y]); continue; }
      var dx = 0, dy = 0;
      if (b2 & 0x04) dx += 81; if (b2 & 0x08) dx -= 81; if (b1 & 0x04) dx += 27; if (b1 & 0x08) dx -= 27;
      if (b0 & 0x04) dx += 9; if (b0 & 0x08) dx -= 9; if (b1 & 0x01) dx += 3; if (b1 & 0x02) dx -= 3; if (b0 & 0x01) dx += 1; if (b0 & 0x02) dx -= 1;
      if (b2 & 0x20) dy += 81; if (b2 & 0x10) dy -= 81; if (b1 & 0x20) dy += 27; if (b1 & 0x10) dy -= 27;
      if (b0 & 0x20) dy += 9; if (b0 & 0x10) dy -= 9; if (b1 & 0x80) dy += 3; if (b1 & 0x40) dy -= 3; if (b0 & 0x80) dy += 1; if (b0 & 0x40) dy -= 1;
      x += dx; y -= dy;                                 /* the file stores y up */
      ops.push([b2 & 0x80 ? 'J' : 'S', x, y]);
      if (ops.length > MAX_STITCHES * 2) throw new Error('The file has too many stitches to open.');
    }
    return ops;
  }
  /* colour blocks -> runs of thread: a run is a series of needle points with no jump, trim or colour change inside */
  function blocksOf(ops) {
    var blocks = [[]], run = null, k;
    for (k = 0; k < ops.length; k++) {
      var op = ops[k];
      if (op[0] === 'S') { if (!run) { run = []; blocks[blocks.length - 1].push(run); } run.push([op[1] / 10, op[2] / 10]); }
      else if (op[0] === 'J') run = null;
      else if (op[0] === 'C') { run = null; blocks.push([]); }
      else break;
    }
    return blocks;
  }

  function read(bytes, name) {
    try {
      var buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), notes = [], sig = ascii(buf, 0, 4), ext = String(name || '').toLowerCase().replace(/^.*\./, '');
      var format, ops, palette = null;
      if (sig === '#PES') {
        format = 'pes';
        var at = u32(buf, 8);
        if (!at || at + 532 > buf.length) throw new Error('This PES file has no stitch block.');
        var r = pecOps(buf, at, notes); ops = r.ops; palette = r.palette;
      } else if (sig === '#PEC') {
        format = 'pec'; var rc = pecOps(buf, 8, notes); ops = rc.ops; palette = rc.palette;
      } else if (ext === 'dst' || (buf.length > 512 && ascii(buf, 0, 3) === 'LA:')) {
        format = 'dst'; ops = dstOps(buf);
        notes.push('A DST file stores no thread colours, so the colours here are placeholders. Change them to your threads.');
      } else throw new Error('This is not a PES, PEC or DST file.');

      var raw = blocksOf(ops), table = root.Engine && root.Engine.Writer && root.Engine.Writer.PEC_RGB, blocks = [], stitches = 0;
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      raw.forEach(function (runs, bi) {
        var keep = runs.filter(function (run) { return run.length >= 2; });
        if (!keep.length) return;
        var color;
        if (palette) { var idx = palette[bi], rgb = table && idx >= 1 && idx < table.length ? table[idx] : null; color = rgb == null ? DST_COLORS[bi % DST_COLORS.length] : hex(rgb); }
        else color = DST_COLORS[blocks.length % DST_COLORS.length];
        keep.forEach(function (run) { stitches += run.length; run.forEach(function (p) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }); });
        blocks.push({ color: color, runs: keep });
      });
      if (!blocks.length || !isFinite(x0) || (x1 - x0 < 0.5 && y1 - y0 < 0.5)) throw new Error('No stitches were found in this file.');
      if (stitches > MAX_STITCHES) throw new Error('The file has more than ' + MAX_STITCHES + ' stitches, which is too many to open.');
      if (palette) notes.push('Colours are the Brother thread colours named in the file.');
      return { ok: true, format: format, blocks: blocks, stitches: stitches, colors: blocks.length, bounds: { x0: x0, y0: y0, x1: x1, y1: y1 }, notes: notes };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'The file could not be read.' };
    }
  }

  /* Model objects for a parsed file, centred in the smallest of `hoops` ([[w, h], ...]) that holds it. */
  function toObjects(parsed, hoops, preferred) {
    var b = parsed.bounds, w = b.x1 - b.x0, h = b.y1 - b.y0, margin = 4, hoop = null, i;
    var list = (preferred ? [[preferred.w, preferred.h]] : []).concat(hoops || []);
    for (i = 0; i < list.length; i++) if (w + margin <= list[i][0] && h + margin <= list[i][1]) { hoop = { w: list[i][0], h: list[i][1] }; break; }
    if (!hoop) hoop = { w: Math.min(1000, Math.ceil((w + 10) / 10) * 10), h: Math.min(1000, Math.ceil((h + 10) / 10) * 10) };
    var dx = hoop.w / 2 - (b.x0 + b.x1) / 2, dy = hoop.h / 2 - (b.y0 + b.y1) / 2, objects = [], runs = 0, dropped = 0, n = 0;
    parsed.blocks.forEach(function (block, bi) {
      block.runs.forEach(function (run) {
        for (var s = 0; s < run.length; s += MAX_RUN_POINTS - 1) {          /* a very long run is cut into pieces that share an end point */
          var part = run.slice(s, s + MAX_RUN_POINTS);
          if (part.length < 2) continue;
          if (objects.length >= MAX_RUNS) { dropped++; continue; }
          runs++;
          objects.push({ id: 's' + (++n), name: 'Stitches ' + (bi + 1) + (block.runs.length > 1 ? '.' + runs : ''), type: 'pen', closed: false,
            pts: part.map(function (p) { return [Math.round((p[0] + dx) * 100) / 100, Math.round((p[1] + dy) * 100) / 100]; }),
            color: block.color, paint: 'line', lineType: 'raw', lineWidth: 2, spacing: 0.4, stitchLen: 2.5, angle: 0, pattern: 'smooth' });
        }
      });
    });
    return { objects: objects, hoop: hoop, runs: runs, dropped: dropped, width: w, height: h };
  }

  var api = { read: read, toObjects: toObjects, EXTENSIONS: ['pes', 'pec', 'dst'] };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root.window === root || typeof window !== 'undefined') { (root.Editor = root.Editor || {}).StitchFile = api; }
})(typeof window !== 'undefined' ? window : globalThis);
