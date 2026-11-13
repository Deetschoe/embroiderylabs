/*
 * embwriter.js - embroidery file writers for the Embroidery Labs engine.
 *
 * Part 1 (encoder + PES v1 / PES v6 / PEC / DST) is a port of pyembroidery 1.5.0 and is
 * byte-compared against it by tests/engine/oracle.test.js (run: node tests/run.js).
 * Part 2 (fromIR, sanitizeName, encode) adapts the digitizer IR to the writers.
 * No dependencies, no DOM: runs in a page, a Web Worker (importScripts) and node (require).
 *
 * Pattern model (all coordinates in 1/10 mm, +x right, +y DOWN):
 *   { name: 'ascii', threads: [0xRRGGBB, ...]  (one per colour block, in sewing order),
 *     stitches: [[x, y, CMD], ...] }           (absolute coordinates)
 *
 * NOTE: the writer command codes below are pyembroidery codes and DIFFER from the IR op codes
 * of digitize.js (IR COLOR_CHANGE is 3, writer COLOR_CHANGE is 5). fromIR() does the mapping.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Engine = root.Engine || {}; root.Engine.Writer = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STITCH = 0, JUMP = 1, TRIM = 2, STOP = 3, END = 4, COLOR_CHANGE = 5;

  // ---- PEC thread palette. Index 0 is "unknown" and is never chosen. ----
  const PEC_THREADS = [
    null,
    [14, 31, 124, 'Prussian Blue'], [10, 85, 163, 'Blue'], [0, 135, 119, 'Teal Green'],
    [75, 107, 175, 'Cornflower Blue'], [237, 23, 31, 'Red'], [209, 92, 0, 'Reddish Brown'],
    [145, 54, 151, 'Magenta'], [228, 154, 203, 'Light Lilac'], [145, 95, 172, 'Lilac'],
    [158, 214, 125, 'Mint Green'], [232, 169, 0, 'Deep Gold'], [254, 186, 53, 'Orange'],
    [255, 255, 0, 'Yellow'], [112, 188, 31, 'Lime Green'], [186, 152, 0, 'Brass'],
    [168, 168, 168, 'Silver'], [125, 111, 0, 'Russet Brown'], [255, 255, 179, 'Cream Brown'],
    [79, 85, 86, 'Pewter'], [0, 0, 0, 'Black'], [11, 61, 145, 'Ultramarine'],
    [119, 1, 118, 'Royal Purple'], [41, 49, 51, 'Dark Gray'], [42, 19, 1, 'Dark Brown'],
    [246, 74, 138, 'Deep Rose'], [178, 118, 36, 'Light Brown'], [252, 187, 197, 'Salmon Pink'],
    [254, 55, 15, 'Vermilion'], [240, 240, 240, 'White'], [106, 28, 138, 'Violet'],
    [168, 221, 196, 'Seacrest'], [37, 132, 187, 'Sky Blue'], [254, 179, 67, 'Pumpkin'],
    [255, 243, 107, 'Cream Yellow'], [208, 166, 96, 'Khaki'], [209, 84, 0, 'Clay Brown'],
    [102, 186, 73, 'Leaf Green'], [19, 74, 70, 'Peacock Blue'], [135, 135, 135, 'Gray'],
    [216, 204, 198, 'Warm Gray'], [67, 86, 7, 'Dark Olive'], [253, 217, 222, 'Flesh Pink'],
    [249, 147, 188, 'Pink'], [0, 56, 34, 'Deep Green'], [178, 175, 212, 'Lavender'],
    [104, 106, 176, 'Wisteria Violet'], [239, 227, 185, 'Beige'], [247, 56, 102, 'Carmine'],
    [181, 75, 100, 'Amber Red'], [19, 43, 26, 'Olive Green'], [199, 1, 86, 'Dark Fuchsia'],
    [254, 158, 50, 'Tangerine'], [168, 222, 235, 'Light Blue'], [0, 103, 62, 'Emerald Green'],
    [78, 41, 144, 'Purple'], [47, 126, 32, 'Moss Green'], [255, 204, 204, 'Flesh Pink'],
    [255, 217, 17, 'Harvest Gold'], [9, 91, 166, 'Electric Blue'], [240, 249, 112, 'Lemon Yellow'],
    [227, 243, 91, 'Fresh Green'], [255, 153, 0, 'Orange'], [255, 240, 141, 'Cream Yellow'],
    [255, 200, 200, 'Applique'],
  ];
  const PEC_RGB = PEC_THREADS.map(t => (t ? (t[0] << 16) | (t[1] << 8) | t[2] : null));

  // Python 3 round(): round half to EVEN. Math.round rounds half toward +Infinity.
  function pyRound(v) {
    const f = Math.floor(v), d = v - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  }

  function colorDistance(c1, c2) {
    const r1 = (c1 >> 16) & 255, g1 = (c1 >> 8) & 255, b1 = c1 & 255;
    const r2 = (c2 >> 16) & 255, g2 = (c2 >> 8) & 255, b2 = c2 & 255;
    const redMean = pyRound((r1 + r2) / 2);
    const r = r1 - r2, g = g1 - g2, b = b1 - b2;
    return (((512 + redMean) * r * r) >> 8) + 4 * g * g + (((767 - redMean) * b * b) >> 8);
  }
  // values: array of 0xRRGGBB or null. Ties go to the LAST candidate (pyembroidery uses <=).
  function nearestIndex(color, values) {
    let best = null, bestD = Infinity;
    for (let i = 0; i < values.length; i++) {
      if (values[i] === null || values[i] === undefined) continue;
      const d = colorDistance(color, values[i]);
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  }
  // Each distinct colour claims its nearest still-free PEC entry (first occurrence first),
  // then every thread is mapped to the entry that its colour claimed.
  function buildUniquePalette(threads) {
    const free = PEC_RGB.slice();
    const chart = new Array(PEC_RGB.length).fill(null);
    for (const c of new Set(threads)) {
      const i = nearestIndex(c, free);
      if (i === null) break;
      free[i] = null;
      chart[i] = c;
    }
    return threads.map(c => nearestIndex(c, chart));
  }

  // ---- byte sink ----
  class Bytes {
    constructor() { this.a = []; }
    get length() { return this.a.length; }
    u8(v) { this.a.push(v & 255); }
    u16(v) { this.a.push(v & 255, (v >> 8) & 255); }
    u16be(v) { this.a.push((v >> 8) & 255, v & 255); }
    u24(v) { this.a.push(v & 255, (v >> 8) & 255, (v >> 16) & 255); }
    u32(v) { this.a.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255); }
    f32(v) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); this.a.push(d.getUint8(0), d.getUint8(1), d.getUint8(2), d.getUint8(3)); }
    ascii(s) { for (let i = 0; i < s.length; i++) this.a.push(s.charCodeAt(i) & 255); }
    fill(v, n) { for (let i = 0; i < n; i++) this.a.push(v); }
    bytes(arr) { for (const v of arr) this.a.push(v & 255); }
    patch16(at, v) { this.a[at] = v & 255; this.a[at + 1] = (v >> 8) & 255; }
    patch24(at, v) { this.a[at] = v & 255; this.a[at + 1] = (v >> 8) & 255; this.a[at + 2] = (v >> 16) & 255; }
    patch32(at, v) { this.patch16(at, v & 0xffff); this.patch16(at + 2, (v >>> 16) & 0xffff); }
    out() { return Uint8Array.from(this.a); }
  }

  // ------------------------------------------------------------------ encoder (EmbEncoder.Transcoder)
  // Supports STITCH, JUMP, TRIM, COLOR_CHANGE, STOP, END. tie_on/tie_off = none, explicit_trim = false,
  // long_stitch_contingency = JUMP_NEEDLE: exactly the defaults pyembroidery uses for PES/PEC/DST.
  function normalize(pattern, opt) {
    const maxStitch = opt.maxStitch, maxJump = opt.maxJump, fullJump = opt.fullJump, round = opt.round;
    const src = pattern.stitches, srcThreads = pattern.threads || [];
    const out = [], threads = [];
    let nx = 0, ny = 0, trimmed = true, order = -1;
    const threadAt = i => {
      if (i >= srcThreads.length) throw new Error('pattern has ' + srcThreads.length + ' threads but needs at least ' + (i + 1));
      return srcThreads[i];
    };
    const add = (cmd, x, y) => out.push([x === undefined ? nx : x, y === undefined ? ny : y, cmd]);
    const gap = (x1, y1, max, cmd) => {
      const dx = x1 - nx, dy = y1 - ny;
      if (Math.abs(dx) > max || Math.abs(dy) > max) {
        const steps = Math.max(Math.ceil(Math.abs(dx / max)), Math.ceil(Math.abs(dy / max)));
        const sx = dx / steps, sy = dy / steps;
        let qx = nx, qy = ny;
        for (let q = 1; q < steps; q++) { qx += sx; qy += sy; out.push([qx, qy, cmd]); nx = qx; ny = qy; }
      }
    };
    const nextChange = () => {
      order += 1;
      threads.push(threadAt(order));
      if (order !== 0) add(COLOR_CHANGE);
      trimmed = true;
    };
    let last = -1;
    for (const s of src) {
      let x = s[0], y = s[1];
      if (round) { x = pyRound(x); y = pyRound(y); }
      const cmd = s[2] & 0xff;
      last = cmd;
      if (cmd === STITCH) {
        if (trimmed) {
          if (order === -1) nextChange();
          trimmed = false;
          gap(x, y, maxJump, JUMP);
          if (fullJump && (nx !== x || ny !== y)) { add(JUMP, x, y); nx = x; ny = y; }
          add(STITCH, x, y); nx = x; ny = y;
        } else {
          gap(x, y, maxStitch, JUMP); // long stitch contingency: jump, then needle down
          add(STITCH, x, y); nx = x; ny = y;
        }
      } else if (cmd === JUMP) {
        gap(x, y, maxJump, JUMP);
        add(JUMP, x, y); nx = x; ny = y;
      } else if (cmd === TRIM) {
        if (!trimmed) { add(TRIM); trimmed = true; }
      } else if (cmd === COLOR_CHANGE) {
        nextChange();
      } else if (cmd === STOP) {
        add(STOP); trimmed = true;
      } else if (cmd === END) {
        add(END); trimmed = true;
        break;
      }
    }
    if (last !== END) add(END);

    // writer preamble shared by PES and PEC: fix_color_count + interpolate_stop_as_duplicate_color
    let need = 0, init = true;
    for (const s of out) {
      if (s[2] === STITCH) { if (init) { need++; init = false; } } else if (s[2] === COLOR_CHANGE) init = true;
    }
    if (threads.length < need) throw new Error('missing threads');
    return { name: pattern.name, stitches: out, threads, meta: pattern.meta || {} };
  }

  function stopsToColorChanges(p) {
    let ti = 0;
    for (const s of p.stitches) {
      if (s[2] === COLOR_CHANGE) ti++;
      else if (s[2] === STOP) {
        if (ti >= p.threads.length) return;
        p.threads.splice(ti, 0, p.threads[ti]);
        s[2] = COLOR_CHANGE;
        ti++;
      }
    }
  }

  function bounds(st) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of st) {
      if (s[0] > x1) x1 = s[0]; if (s[0] < x0) x0 = s[0];
      if (s[1] > y1) y1 = s[1]; if (s[1] < y0) y0 = s[1];
    }
    return [x0, y0, x1, y1];
  }

  // ------------------------------------------------------------------ PEC
  const PEC_BLANK = (() => {
    const g = new Array(228).fill(0);
    const row = (r, a, b, c, d, e, f) => { g[r * 6] = a; g[r * 6 + 1] = b; g[r * 6 + 2] = c; g[r * 6 + 3] = d; g[r * 6 + 4] = e; g[r * 6 + 5] = f; };
    row(1, 0xf0, 0xff, 0xff, 0xff, 0xff, 0x0f);
    row(2, 0x08, 0, 0, 0, 0, 0x10);
    row(3, 0x04, 0, 0, 0, 0, 0x20);
    for (let r = 4; r <= 33; r++) row(r, 0x02, 0, 0, 0, 0, 0x40);
    row(34, 0x04, 0, 0, 0, 0, 0x20);
    row(35, 0x08, 0, 0, 0, 0, 0x10);
    row(36, 0xf0, 0xff, 0xff, 0xff, 0xff, 0x0f);
    return g;
  })();

  function drawScaled(ext, points, g, buffer) {
    let w = ext[2] - ext[0], h = ext[3] - ext[1];
    if (w === 0) w = 1;
    if (h === 0) h = 1;
    const scale = Math.min((48 - buffer) / w, (38 - buffer) / h);
    const tx = -((ext[2] + ext[0]) / 2) * scale + 24;
    const ty = -((ext[3] + ext[1]) / 2) * scale + 19;
    for (const p of points) {
      const px = Math.floor(p[0] * scale + tx), py = Math.floor(p[1] * scale + ty);
      const idx = py * 6 + Math.trunc(px / 8);
      if (idx >= 0 && idx < 228) g[idx] |= 1 << (((px % 8) + 8) % 8);
    }
  }

  function pecValue(b, v, long, flag) {
    if (!long && v > -64 && v < 63) b.u8(v & 0x7f);
    else b.u16be((v & 0x0fff) | 0x8000 | (flag << 8));
  }

  // p must already be normalized. Returns {indexList, rgbList} (needed by the PES v6 addendum).
  function writePecBody(b, p) {
    const ext = bounds(p.stitches);
    const name = (p.name === undefined || p.name === null) ? 'Untitled' : p.name;
    b.ascii('LA:' + name.slice(0, 8).padEnd(16, ' ') + '\r');
    b.fill(0x20, 12); b.u8(0xff); b.u8(0x00); b.u8(6); b.u8(38);
    const palette = buildUniquePalette(p.threads);
    const n = palette.length;
    let indexList;
    if (n !== 0) {
      if (n - 1 >= 255) throw new Error('too many colour changes for PEC');
      b.fill(0x20, 12);
      indexList = [n - 1].concat(palette);
      b.bytes(indexList);
    } else {
      indexList = [];
      b.bytes([0x20, 0x20, 0x20, 0x20, 0x64, 0x20, 0x00, 0x20, 0x00, 0x20, 0x20, 0x20, 0xff]);
    }
    b.fill(0x20, 463 - n);

    // stitch block
    const start = b.length;
    b.u8(0); b.u8(0); b.u24(0);
    b.bytes([0x31, 0xff, 0xf0]);
    b.u16(pyRound(ext[2] - ext[0]));
    b.u16(pyRound(ext[3] - ext[1]));
    b.u16(0x1e0); b.u16(0x1b0);
    let colorTwo = true, jumping = true, init = true, xx = 0, yy = 0;
    for (const s of p.stitches) {
      const cmd = s[2] & 0xff;
      const dx = pyRound(s[0] - xx), dy = pyRound(s[1] - yy);
      xx += dx; yy += dy;
      if (cmd === STITCH) {
        if (jumping) {
          if (dx !== 0 && dy !== 0) { b.u8(0); b.u8(0); }
          jumping = false;
        }
        pecValue(b, dx, false, 0); pecValue(b, dy, false, 0);
      } else if (cmd === JUMP) {
        jumping = true;
        const flag = init ? 0x10 : 0x20;
        pecValue(b, dx, true, flag); pecValue(b, dy, true, flag);
      } else if (cmd === COLOR_CHANGE) {
        if (jumping) { b.u8(0); b.u8(0); jumping = false; }
        b.u8(0xfe); b.u8(0xb0); b.u8(colorTwo ? 2 : 1);
        colorTwo = !colorTwo;
      } else if (cmd === END) {
        b.u8(0xff);
        break;
      }
      init = false;
    }
    b.patch24(start + 2, b.length - start);

    // graphics: one overall image, then one per colour block
    const g = PEC_BLANK.slice();
    drawScaled(ext, p.stitches.filter(s => (s[2] & 0xff) === STITCH), g, 4);
    b.bytes(g);
    let blockStart = 0;
    const emit = (from, to) => {
      const gg = PEC_BLANK.slice();
      drawScaled(ext, p.stitches.slice(from, to).filter(s => s[2] === STITCH), gg, 5);
      b.bytes(gg);
    };
    for (let i = 0; i < p.stitches.length; i++) {
      if ((p.stitches[i][2] & 0xff) === COLOR_CHANGE) { emit(blockStart, i + 1); blockStart = i + 1; }
    }
    if (blockStart !== p.stitches.length) emit(blockStart, p.stitches.length);
    return { indexList, rgbList: p.threads.slice() };
  }

  const PES_SETTINGS = { maxStitch: 2047, maxJump: 2047, fullJump: true, round: true };
  const DST_SETTINGS = { maxStitch: 121, maxJump: 121, fullJump: false, round: true };

  function prepare(pattern, settings) {
    const p = normalize(pattern, settings);
    stopsToColorChanges(p);
    return p;
  }

  function writePec(pattern) {
    const p = prepare(pattern, PES_SETTINGS);
    const b = new Bytes();
    b.ascii('#PEC0001');
    writePecBody(b, p);
    return b.out();
  }

  // ------------------------------------------------------------------ PES
  function commandBlocks(st) {
    const blocks = [];
    let lastPos = 0, lastCmd = -1;
    for (let pos = 0; pos < st.length; pos++) {
      const cmd = st[pos][2] & 0xff;
      if (cmd === lastCmd || lastCmd === -1) { lastCmd = cmd; continue; }
      lastCmd = cmd;
      blocks.push(st.slice(lastPos, pos));
      lastPos = pos;
    }
    blocks.push(st.slice(lastPos));
    return blocks;
  }

  const PES_SECTION_MAX = 0xffff;

  function writePesBlocks(b, p, chart, ext) {
    const cx = (ext[2] + ext[0]) / 2, cy = (ext[3] + ext[1]) / 2;
    const left = ext[0] - cx, top = ext[1] - cy, right = ext[2] - cx, bottom = ext[3] - cy;
    const width = right - left, height = bottom - top;
    b.u16(7); b.ascii('CEmbOne');
    b.fill(0, 16);
    b.f32(1); b.f32(0); b.f32(0); b.f32(1);
    b.f32(350 + 1300 / 2 - width / 2);
    b.f32(100 + height + 1800 / 2 - height / 2);
    b.u16(1); b.u16(0); b.u16(0);
    b.u16(Math.trunc(width)); b.u16(Math.trunc(height));
    b.fill(0, 8);
    const sectionsAt = b.length;
    b.u16(0);
    b.u16(0xffff); b.u16(0);
    b.u16(7); b.ascii('CSewSeg');

    const ax = left + cx, ay = bottom + cy;
    let colorIndex = 0;
    let colorCode = nearestIndex(p.threads[colorIndex++], chart);
    let sx = 0, sy = 0, section = 0, prevCode = -1, first = true;
    const colorlog = [];
    for (const block of commandBlocks(p.stitches)) {
      const cmd = block[0][2] & 0xff;
      let pts, flag;
      if (cmd === JUMP) {
        const lastPos = block[block.length - 1];
        pts = [[sx - ax, sy - ay], [lastPos[0] - ax, lastPos[1] - ay]];
        flag = 1;
      } else if (cmd === COLOR_CHANGE) {
        colorCode = nearestIndex(p.threads[colorIndex++], chart);
        continue;
      } else if (cmd === STITCH) {
        pts = [];
        for (const s of block) { sx = s[0]; sy = s[1]; pts.push([sx - ax, sy - ay]); }
        flag = 0;
      } else continue;
      // The point count of a section is a u16. A run of more than 65535 stitches without a trim (a large
      // dense fill, a long satin) is cut into several sections, each starting on the last point of the one
      // before. pyembroidery writes the count modulo 65536 there, which leaves the PES section unreadable.
      for (let from = 0; from < pts.length;) {
        const to = Math.min(pts.length, from + PES_SECTION_MAX);
        if (!first) b.u16(0x8003);
        first = false;
        if (prevCode !== colorCode) { colorlog.push([section, colorCode]); prevCode = colorCode; }
        b.u16(flag); b.u16(colorCode); b.u16(to - from);
        for (let k = from; k < to; k++) { b.u16(Math.trunc(pts[k][0])); b.u16(Math.trunc(pts[k][1])); }
        section++;
        if (to >= pts.length) break;
        from = to - 1;
      }
    }
    b.u16(colorlog.length);
    for (const l of colorlog) { b.u16(l[0]); b.u16(l[1]); }
    b.patch16(sectionsAt, section);
    b.u16(0); b.u16(0);
    return colorlog;
  }

  function writePes(pattern) { // "#PES0001", not truncated: pyembroidery's default
    const p = prepare(pattern, PES_SETTINGS);
    const b = new Bytes();
    const ext = bounds(p.stitches);
    b.ascii('#PES0001');
    b.u32(0);
    b.u16(1); b.u16(1); b.u16(1);
    b.u16(0xffff); b.u16(0);
    writePesBlocks(b, p, PEC_RGB, ext);
    b.patch32(8, b.length);
    writePecBody(b, p);
    return b.out();
  }

  function pesString8(b, s) {
    if (s === null || s === undefined) { b.u8(0); return; }
    s = s.slice(0, 255);
    b.u8(s.length); b.ascii(s);
  }

  function writePesV6(pattern) { // "#PES0060"
    const p = prepare(pattern, PES_SETTINGS);
    const b = new Bytes();
    const ext = bounds(p.stitches);
    const m = p.meta || {};
    b.ascii('#PES0060');
    b.u32(0);
    b.u16(1); b.ascii('02');
    pesString8(b, p.name); pesString8(b, m.category); pesString8(b, m.author); pesString8(b, m.keywords); pesString8(b, m.comments);
    for (const v of [0, 0, 0x64, 0x64, 0, 0xc8, 0xc8, 0x64, 0x64, 0x64, 0x07, 0x13, 1, 1, 0, 100, 1, 0]) b.u16(v);
    b.u8(0);
    for (const v of [1, 0, 0, 1, 0, 0]) b.f32(v);
    b.u16(0); b.u16(0); b.u16(0);
    b.u16(p.threads.length);
    for (const c of p.threads) {
      b.u8(0);                                   // catalog number (none)
      b.u8((c >> 16) & 255); b.u8((c >> 8) & 255); b.u8(c & 255);
      b.u8(0); b.u32(0xa);
      b.u8(0); b.u8(0); b.u8(0);                 // description, brand, chart (none)
    }
    b.u16(1);
    b.u16(0xffff); b.u16(0);
    const log = writePesBlocks(b, p, p.threads, ext);
    b.u32(0); b.u32(0);
    for (let i = 0; i < log.length; i++) { b.u32(i); b.u32(0); }
    b.patch32(8, b.length);
    const info = writePecBody(b, p);
    b.bytes(info.indexList);
    b.fill(0x20, 128 - info.indexList.length);
    b.fill(0, 0x90 * info.rgbList.length);
    for (const c of info.rgbList) b.u24(c);
    b.u16(0);
    return b.out();
  }

  // ------------------------------------------------------------------ DST
  function dstRecord(x, y, cmd) {
    y = -y;
    let b0 = 0, b1 = 0, b2 = 0;
    if (cmd === JUMP) b2 += 0x80;
    if (cmd === STITCH || cmd === JUMP) {
      b2 += 3;
      if (x > 40) { b2 += 4; x -= 81; }
      if (x < -40) { b2 += 8; x += 81; }
      if (x > 13) { b1 += 4; x -= 27; }
      if (x < -13) { b1 += 8; x += 27; }
      if (x > 4) { b0 += 4; x -= 9; }
      if (x < -4) { b0 += 8; x += 9; }
      if (x > 1) { b1 += 1; x -= 3; }
      if (x < -1) { b1 += 2; x += 3; }
      if (x > 0) { b0 += 1; x -= 1; }
      if (x < 0) { b0 += 2; x += 1; }
      if (x !== 0) throw new Error('DST dx out of range');
      if (y > 40) { b2 += 0x20; y -= 81; }
      if (y < -40) { b2 += 0x10; y += 81; }
      if (y > 13) { b1 += 0x20; y -= 27; }
      if (y < -13) { b1 += 0x10; y += 27; }
      if (y > 4) { b0 += 0x20; y -= 9; }
      if (y < -4) { b0 += 0x10; y += 9; }
      if (y > 1) { b1 += 0x80; y -= 3; }
      if (y < -1) { b1 += 0x40; y += 3; }
      if (y > 0) { b0 += 0x80; y -= 1; }
      if (y < 0) { b0 += 0x40; y += 1; }
      if (y !== 0) throw new Error('DST dy out of range');
    } else if (cmd === COLOR_CHANGE || cmd === STOP) b2 = 0xc3;
    else if (cmd === END) b2 = 0xf3;
    return [b0, b1, b2];
  }

  function writeDst(pattern) {
    const p = normalize(pattern, DST_SETTINGS); // NB: DST keeps STOP as STOP (no thread duplication)
    const b = new Bytes();
    const ext = bounds(p.stitches);
    const d = (v, w) => String(Math.trunc(v)).padStart(w, ' ');
    const name = (p.name === undefined || p.name === null) ? 'Untitled' : p.name;
    b.ascii('LA:' + name.padEnd(16, ' ') + '\r');
    b.ascii('ST:' + d(p.stitches.length, 7) + '\r');
    b.ascii('CO:' + d(p.stitches.filter(s => (s[2] & 0xff) === COLOR_CHANGE).length, 3) + '\r');
    b.ascii('+X:' + d(Math.abs(ext[2]), 5) + '\r');
    b.ascii('-X:' + d(Math.abs(ext[0]), 5) + '\r');
    b.ascii('+Y:' + d(Math.abs(ext[3]), 5) + '\r');
    b.ascii('-Y:' + d(Math.abs(ext[1]), 5) + '\r');
    const lastS = p.stitches[p.stitches.length - 1];
    const ax = Math.trunc(lastS[0]), ay = -Math.trunc(lastS[1]);
    b.ascii('AX:' + (ax >= 0 ? '+' : '-') + d(Math.abs(ax), 5) + '\r');
    b.ascii('AY:' + (ay >= 0 ? '+' : '-') + d(Math.abs(ay), 5) + '\r');
    b.ascii('MX:+' + d(0, 5) + '\r');
    b.ascii('MY:+' + d(0, 5) + '\r');
    b.ascii('PD:******\r');
    b.u8(0x1a);
    b.fill(0x20, 512 - b.length);
    let xx = 0, yy = 0;
    for (const s of p.stitches) {
      const cmd = s[2] & 0xff;
      const dx = pyRound(s[0] - xx), dy = pyRound(s[1] - yy);
      xx += dx; yy += dy;
      if (cmd === TRIM) {
        b.bytes(dstRecord(2, 2, JUMP)); b.bytes(dstRecord(-4, -4, JUMP)); b.bytes(dstRecord(2, 2, JUMP));
      } else b.bytes(dstRecord(dx, dy, cmd));
    }
    return b.out();
  }

  // ================================================================== part 2: IR adapter
  const IR_OP = { STITCH: 0, JUMP: 1, TRIM: 2, COLOR_CHANGE: 3, END: 4 };

  const FORMATS = {
    pes: { id: 'pes', ext: 'pes', mime: 'application/octet-stream', label: 'Brother PES (v1)' },
    pes6: { id: 'pes6', ext: 'pes', mime: 'application/octet-stream', label: 'Brother PES (v6)' },
    pec: { id: 'pec', ext: 'pec', mime: 'application/octet-stream', label: 'Brother PEC' },
    dst: { id: 'dst', ext: 'dst', mime: 'application/octet-stream', label: 'Tajima DST' },
  };

  // Label stored inside the file: printable ASCII only, single spaces, never empty.
  function sanitizeName(name, maxLen) {
    let s = (name === undefined || name === null) ? '' : String(name);
    if (s.normalize) s = s.normalize('NFKD');          // 'é' -> 'e' + combining mark (dropped below)
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 9 || c === 10 || c === 13) out += ' ';
      else if (c >= 0x20 && c <= 0x7e) out += s[i];
    }
    out = out.replace(/\s+/g, ' ').trim();
    if (!out) out = 'Untitled';
    if (maxLen && out.length > maxLen) out = out.slice(0, maxLen).trim() || 'Untitled';
    return out;
  }

  function hexToInt(c) {
    if (typeof c === 'number' && isFinite(c)) return c & 0xffffff;
    let s = String(c && c.color !== undefined ? c.color : c || '').trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return /^#[0-9a-f]{6}$/.test(s) ? parseInt(s.slice(1), 16) : 0;
  }

  // IR (see digitize.js / API.md) -> writer pattern.
  //  - centred on the integer centre of the stitch bounding box (opt.center === false keeps hoop coordinates)
  //  - IR JUMPs are dropped: after TRIM / COLOR_CHANGE the encoder generates the travel itself
  //  - TRIM then COLOR_CHANGE are emitted at the old position, before any travel to the new colour
  function fromIR(ir, opt) {
    opt = opt || {};
    if (!ir || !ir.commands || typeof ir.commands.length !== 'number') throw makeError('INVALID_IR', 'Nothing to export: the stitch data is missing.');
    const c = ir.commands, n = c.length - (c.length % 3);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, count = 0;
    for (let i = 0; i < n; i += 3) {
      if (c[i] !== IR_OP.STITCH) continue;
      const x = c[i + 1], y = c[i + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw makeError('INVALID_IR', 'Nothing to export: the stitch data contains a bad coordinate.');
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      count++;
    }
    if (!count) throw makeError('EMPTY_DESIGN', 'Nothing to export: the design has no stitches.');
    const center = opt.center !== false;
    const cx = center ? Math.round((x0 + x1) / 2) : 0, cy = center ? Math.round((y0 + y1) / 2) : 0;
    const stitches = [];
    let lx = 0, ly = 0, sewn = false;
    for (let i = 0; i < n; i += 3) {
      const op = c[i];
      if (op === IR_OP.STITCH) { lx = Math.round(c[i + 1] - cx); ly = Math.round(c[i + 2] - cy); stitches.push([lx, ly, STITCH]); sewn = true; }
      else if (op === IR_OP.TRIM) { if (sewn) stitches.push([lx, ly, TRIM]); }
      else if (op === IR_OP.COLOR_CHANGE) { if (sewn) stitches.push([lx, ly, COLOR_CHANGE]); }
      else if (op === IR_OP.END) break;
      // IR_OP.JUMP: dropped on purpose
    }
    stitches.push([lx, ly, END]);
    const threads = (ir.threads || []).map(hexToInt);
    const blocks = stitches.reduce((a, s) => a + (s[2] === COLOR_CHANGE ? 1 : 0), 1);
    if (threads.length < blocks) throw makeError('INVALID_IR', 'Nothing to export: the thread list does not match the colour changes.');
    if (threads.length > 255) throw makeError('TOO_MANY_COLORS', 'This design has more than 255 colour changes, which the file format cannot store.');
    return { name: sanitizeName(opt.name), threads, stitches, center: { x: cx, y: cy } };
  }

  function makeError(code, message) { const e = new Error(message); e.code = code; return e; }

  // pattern -> bytes in one of FORMATS. The DST label is cut to its 16-character field.
  function encode(pattern, format) {
    const f = String(format || 'pes').toLowerCase();
    if (f === 'pes') return writePes(pattern);
    if (f === 'pes6') return writePesV6(pattern);
    if (f === 'pec') return writePec(pattern);
    if (f === 'dst') return writeDst(Object.assign({}, pattern, { name: sanitizeName(pattern.name, 16) }));
    throw makeError('UNKNOWN_FORMAT', 'Unknown export format: ' + format);
  }

  return {
    STITCH, JUMP, TRIM, STOP, END, COLOR_CHANGE,
    PEC_THREADS, PEC_RGB, pyRound, colorDistance, nearestIndex, buildUniquePalette,
    normalize, bounds, writePes, writePesV6, writePec, writeDst,
    FORMATS, sanitizeName, fromIR, encode,
  };
});
