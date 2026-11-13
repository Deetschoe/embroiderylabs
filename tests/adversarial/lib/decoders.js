/*
 * Independent PES / PEC / DST decoders for the adversarial suite.
 *
 * Written from blueprint/pes-spec.md (sections 5, 6, 7, 8) and NOT from js/engine/embwriter.js: nothing in
 * this file imports the engine. Every structural rule of the spec is asserted while decoding, so a file that
 * decodes without `problems` is a file the spec calls well formed.
 *
 * Decoded model (all formats):
 *   { ops: [[kind, x, y]], kind one of 'S' stitch, 'J' jump, 'T' trim-jump, 'C' colour change, 'E' end,
 *     x, y absolute in 0.1 mm, +y DOWN, origin = where the needle is when the file starts,
 *     problems: [string], ...format specific fields }
 */
'use strict';

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const s16 = (b, o) => { const v = u16(b, o); return v & 0x8000 ? v - 0x10000 : v; };
const u24 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const f32 = (b, o) => new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, true);
const ascii = (b, o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]); return s; };

const THUMB_FRAME = (() => {
  const rows = [];
  rows.push([0, 0, 0, 0, 0, 0]);
  rows.push([0xf0, 0xff, 0xff, 0xff, 0xff, 0x0f]);
  rows.push([0x08, 0, 0, 0, 0, 0x10]);
  rows.push([0x04, 0, 0, 0, 0, 0x20]);
  for (let r = 4; r <= 33; r++) rows.push([0x02, 0, 0, 0, 0, 0x40]);
  rows.push([0x04, 0, 0, 0, 0, 0x20]);
  rows.push([0x08, 0, 0, 0, 0, 0x10]);
  rows.push([0xf0, 0xff, 0xff, 0xff, 0xff, 0x0f]);
  rows.push([0, 0, 0, 0, 0, 0]);
  return [].concat(...rows);
})();

/*
 * PEC block starting at byte P of buf (spec section 5). `end` = first byte after the thumbnails if the caller
 * knows it (PES v1 / PEC: buf.length), else undefined.
 */
function decodePecBlock(buf, P, end) {
  const out = { ops: [], problems: [], palette: [], label: '', width: 0, height: 0, streamBytes: 0, thumbs: 0, thumbPixels: [], afterThumbs: 0 };
  const bad = m => { if (out.problems.length < 40) out.problems.push(m); };
  if (buf.length < P + 532) { bad('file too short for a PEC block'); return out; }
  // 5.1 header
  if (ascii(buf, P, 3) !== 'LA:') bad('PEC label does not start with LA:');
  out.label = ascii(buf, P + 3, 16);
  if (buf[P + 19] !== 0x0d) bad('PEC label is not closed by 0x0D at +19');
  for (let i = 3; i < 19; i++) if (buf[P + i] < 0x20 || buf[P + i] > 0x7e) { bad('PEC label holds a non-printable byte 0x' + buf[P + i].toString(16)); break; }
  for (let i = 20; i < 32; i++) if (buf[P + i] !== 0x20) { bad('PEC +20..+31 is not spaces'); break; }
  if (buf[P + 32] !== 0xff || buf[P + 33] !== 0x00) bad('PEC +32/+33 is not FF 00');
  if (buf[P + 34] !== 6 || buf[P + 35] !== 38) bad('PEC thumbnail size is not 6 x 38');
  for (let i = 36; i < 48; i++) if (buf[P + i] !== 0x20) { bad('PEC +36..+47 is not spaces'); break; }
  const n = buf[P + 48] + 1;
  out.colors = n;
  for (let i = 0; i < n; i++) out.palette.push(buf[P + 49 + i]);
  for (const c of out.palette) if (c < 1 || c > 64) { bad('PEC palette index ' + c + ' outside 1..64'); break; }
  for (let i = 49 + n; i < 512; i++) if (buf[P + i] !== 0x20) { bad('PEC header padding is not 0x20 at +' + i); break; }
  // 5.2 stitch block header
  if (buf[P + 512] !== 0 || buf[P + 513] !== 0) bad('PEC +512 is not 00 00');
  const L = u24(buf, P + 514);
  out.streamBytes = L;
  if (buf[P + 517] !== 0x31 || buf[P + 518] !== 0xff || buf[P + 519] !== 0xf0) bad('PEC +517 is not 31 FF F0');
  out.width = u16(buf, P + 520); out.height = u16(buf, P + 522);
  if (u16(buf, P + 524) !== 0x1e0 || u16(buf, P + 526) !== 0x1b0) bad('PEC +524 is not E0 01 B0 01');
  // 5.3 / 5.4 stream
  const stop = P + 512 + L;
  if (stop > buf.length) { bad('PEC stream length ' + L + ' runs past the end of the file'); return out; }
  let i = P + 528, x = 0, y = 0, ended = false, changes = 0, first = true;
  const read = () => {
    const b = buf[i];
    if (b & 0x80) { let v = ((b & 0x0f) << 8) | buf[i + 1]; if (v & 0x800) v -= 0x1000; i += 2; return { v, long: true, flag: b & 0x70 }; }
    i += 1; return { v: b > 63 ? b - 128 : b, long: false, flag: 0 };
  };
  while (i < stop) {
    const b = buf[i];
    if (b === 0xff) { out.ops.push(['E', x, y]); ended = true; i++; break; }
    if (b === 0xfe && buf[i + 1] === 0xb0) {
      const third = buf[i + 2];
      if (third !== (changes % 2 === 0 ? 2 : 1)) bad('colour change #' + (changes + 1) + ' has third byte ' + third + ' (expected ' + (changes % 2 === 0 ? 2 : 1) + ')');
      out.ops.push(['C', x, y]); changes++; i += 3; first = false; continue;
    }
    const at = i, dx = read(), dy = read();
    if (i > stop) { bad('stitch record at ' + at + ' runs past the declared stream length'); break; }
    const flag = dx.flag | dy.flag;
    if (dx.flag !== dy.flag && (dx.long && dy.long)) bad('dx and dy disagree on their flag at ' + at);
    if (flag & 0x40) bad('unknown flag bit 0x40 at ' + at);
    x += dx.v; y += dy.v;
    if (flag & 0x20) { if (first) bad('the first move of the stream is a trim-jump (flag 0x20), expected a plain jump (0x10)'); out.ops.push(['T', x, y]); }
    else if (flag & 0x10) { if (!first) bad('plain jump (flag 0x10) after the first entry at ' + at + ' (expected 0x20)'); out.ops.push(['J', x, y]); }
    else out.ops.push(['S', x, y]);
    first = false;
  }
  if (!ended) bad('PEC stream has no FF end byte inside its declared length');
  if (i !== stop) bad('PEC stream ends at ' + i + ' but its length field says ' + stop);
  if (changes !== n - 1) bad('PEC has ' + changes + ' colour changes for ' + n + ' palette entries');
  // 5.5 thumbnails
  const tEnd = end === undefined ? stop + 228 * (n + 1) : end;
  const tBytes = tEnd - stop;
  out.thumbs = tBytes / 228; out.afterThumbs = stop + 228 * (n + 1);
  if (tBytes !== 228 * (n + 1)) bad('thumbnail area is ' + tBytes + ' bytes, expected 228 x (colours + 1) = ' + 228 * (n + 1));
  for (let t = 0; t < n + 1 && stop + (t + 1) * 228 <= buf.length; t++) {
    let px = 0, frameOk = true;
    for (let k = 0; k < 228; k++) {
      const v = buf[stop + t * 228 + k];
      if ((v & THUMB_FRAME[k]) !== THUMB_FRAME[k]) frameOk = false;
      let extra = v & ~THUMB_FRAME[k]; while (extra) { px += extra & 1; extra >>= 1; }
    }
    if (!frameOk) bad('thumbnail ' + t + ' lost part of its frame');
    out.thumbPixels.push(px);
  }
  return out;
}

function decodePec(buf) {
  if (ascii(buf, 0, 8) !== '#PEC0001') { return { ops: [], problems: ['not a #PEC0001 file'] }; }
  return decodePecBlock(buf, 8, buf.length);
}

// CEmbOne / CSewSeg part, starting at the u16 7 that precedes "CEmbOne" (spec 6, offsets 0x16 ...).
function decodeSewSeg(buf, o, bad) {
  const seg = { sections: [], log: [], width: 0, height: 0, tx: 0, ty: 0, end: o };
  if (u16(buf, o) !== 7 || ascii(buf, o + 2, 7) !== 'CEmbOne') { bad('CEmbOne header missing at ' + o); return seg; }
  o += 9;
  for (let i = 0; i < 16; i++) if (buf[o + i] !== 0) { bad('CEmbOne: 16 zero bytes expected'); break; }
  o += 16;
  const m = [f32(buf, o), f32(buf, o + 4), f32(buf, o + 8), f32(buf, o + 12)];
  if (m[0] !== 1 || m[1] !== 0 || m[2] !== 0 || m[3] !== 1) bad('CEmbOne transform is not the identity');
  seg.tx = f32(buf, o + 16); seg.ty = f32(buf, o + 20); o += 24;
  if (u16(buf, o) !== 1 || u16(buf, o + 2) !== 0 || u16(buf, o + 4) !== 0) bad('CEmbOne: 1, 0, 0 expected');
  o += 6;
  seg.width = u16(buf, o); seg.height = u16(buf, o + 2); o += 4;
  for (let i = 0; i < 8; i++) if (buf[o + i] !== 0) { bad('CEmbOne: 8 zero bytes expected'); break; }
  o += 8;
  const count = u16(buf, o); o += 2;
  if (u16(buf, o) !== 0xffff || u16(buf, o + 2) !== 0) bad('FFFF 0000 expected before CSewSeg');
  o += 4;
  if (u16(buf, o) !== 7 || ascii(buf, o + 2, 7) !== 'CSewSeg') { bad('CSewSeg header missing'); return seg; }
  o += 9;
  for (let s = 0; s < count; s++) {
    if (s) { if (u16(buf, o) !== 0x8003) { bad('section ' + s + ' is not preceded by 03 80'); break; } o += 2; }
    const flag = u16(buf, o), code = u16(buf, o + 2), n = u16(buf, o + 4); o += 6;
    if (flag !== 0 && flag !== 1) bad('section ' + s + ' has flag ' + flag);
    if (flag === 1 && n !== 2) bad('jump section ' + s + ' has ' + n + ' points, expected 2');
    const pts = [];
    for (let k = 0; k < n; k++) { pts.push([s16(buf, o), s16(buf, o + 2)]); o += 4; }
    seg.sections.push({ flag, code, pts });
  }
  const logN = u16(buf, o); o += 2;
  for (let k = 0; k < logN; k++) { seg.log.push([u16(buf, o), u16(buf, o + 2)]); o += 4; }
  if (u32(buf, o) !== 0) bad('00 00 00 00 expected after the colour log');
  o += 4;
  seg.end = o;
  // the colour log must list every section where the colour code changes
  let prev = -1; const want = [];
  seg.sections.forEach((sec, k) => { if (sec.code !== prev) { want.push([k, sec.code]); prev = sec.code; } });
  if (JSON.stringify(want) !== JSON.stringify(seg.log)) bad('colour log does not match the sections');
  return seg;
}

function decodePes(buf) {
  const sig = ascii(buf, 0, 8), problems = [], bad = m => { if (problems.length < 40) problems.push(m); };
  if (sig !== '#PES0001' && sig !== '#PES0060') return { ops: [], problems: ['not a PES v1 / v6 file: ' + JSON.stringify(sig)] };
  const pecAt = u32(buf, 8);
  let seg, v6 = null;
  if (sig === '#PES0001') {
    if (u16(buf, 12) !== 1 || u16(buf, 14) !== 1 || u16(buf, 16) !== 1) bad('PES v1 header: 1, 1, 1 expected at 0x0C');
    if (u16(buf, 18) !== 0xffff || u16(buf, 20) !== 0) bad('PES v1 header: FFFF 0000 expected at 0x12');
    seg = decodeSewSeg(buf, 0x16, bad);
  } else {
    let o = 12;
    if (u16(buf, o) !== 1) bad('PES v6: u16 1 expected at 0x0C'); o += 2;
    if (ascii(buf, o, 2) !== '02') bad('PES v6: "02" expected'); o += 2;
    const strings = [];
    for (let k = 0; k < 5; k++) { const n = buf[o]; strings.push(ascii(buf, o + 1, n)); o += 1 + n; }
    const want = [0, 0, 0x64, 0x64, 0, 0xc8, 0xc8, 0x64, 0x64, 0x64, 0x07, 0x13, 1, 1, 0, 100, 1, 0];
    for (let k = 0; k < 18; k++) { if (u16(buf, o) !== want[k]) { bad('PES v6 header constant ' + k + ' differs'); break; } o += 2; }
    o = 12 + 4 + strings.reduce((a, s) => a + 1 + s.length, 0) + 36;
    if (buf[o] !== 0) bad('PES v6: u8 0 expected'); o += 1;
    const fl = [1, 0, 0, 1, 0, 0];
    for (let k = 0; k < 6; k++) { if (f32(buf, o) !== fl[k]) { bad('PES v6 float ' + k + ' differs'); break; } o += 4; }
    o = 12 + 4 + strings.reduce((a, s) => a + 1 + s.length, 0) + 36 + 1 + 24 + 6;
    const n = u16(buf, o); o += 2;
    const threads = [];
    for (let k = 0; k < n; k++) {
      const cat = buf[o]; o += 1 + cat;
      threads.push((buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2]); o += 3;
      if (buf[o] !== 0 || u32(buf, o + 1) !== 0x0a) bad('PES v6 thread ' + k + ': 00, 0A000000 expected'); o += 5;
      for (let q = 0; q < 3; q++) { const len = buf[o]; o += 1 + len; }
    }
    if (u16(buf, o) !== 1) bad('PES v6: u16 1 expected before the objects'); o += 2;
    if (u16(buf, o) !== 0xffff || u16(buf, o + 2) !== 0) bad('PES v6: FFFF 0000 expected'); o += 4;
    seg = decodeSewSeg(buf, o, bad);
    o = seg.end;
    if (u32(buf, o) !== 0 || u32(buf, o + 4) !== 0) bad('PES v6: 8 zero bytes expected after the colour log'); o += 8;
    for (let k = 0; k < seg.log.length; k++) { if (u32(buf, o) !== k || u32(buf, o + 4) !== 0) { bad('PES v6 order table entry ' + k + ' differs'); break; } o += 8; }
    seg.end = o;
    v6 = { name: strings[0], threads };
  }
  if (seg.end !== pecAt) bad('PEC offset field says ' + pecAt + ' but the PES section ends at ' + seg.end);
  const pec = decodePecBlock(buf, pecAt, sig === '#PES0001' ? buf.length : undefined);
  for (const p of pec.problems) bad(p);
  if (v6) { // spec 7 item 8: addendum after the thumbnails
    let o = pec.afterThumbs; const n = pec.colors;
    if (buf[o] !== n - 1) bad('PES v6 addendum does not start with N-1');
    for (let k = 0; k < n; k++) if (buf[o + 1 + k] !== pec.palette[k]) { bad('PES v6 addendum palette differs from the PEC palette'); break; }
    if (n + 1 <= 128) { for (let k = n + 1; k < 128; k++) if (buf[o + k] !== 0x20) { bad('PES v6 addendum padding is not 0x20'); break; } o += 128; } else o += n + 1;
    o += 0x90 * n;
    const rgb = [];
    for (let k = 0; k < n; k++) { rgb.push((buf[o + 2] << 16) | (buf[o + 1] << 8) | buf[o]); o += 3; }
    v6.addendumRgb = rgb;
    if (u16(buf, o) !== 0) bad('PES v6 addendum does not end with 00 00'); o += 2;
    if (o !== buf.length) bad('PES v6 file has ' + (buf.length - o) + ' unexplained trailing bytes');
  }
  return Object.assign(pec, { problems, version: sig === '#PES0001' ? 1 : 6, pecAt, seg, v6 });
}

// spec section 8
function decodeDst(buf) {
  const out = { ops: [], problems: [], header: {}, records: 0 };
  const bad = m => { if (out.problems.length < 40) out.problems.push(m); };
  if (buf.length < 515) { bad('file too short for a DST'); return out; }
  const head = ascii(buf, 0, 512), eof = head.indexOf('\x1a');
  if (eof < 0) bad('DST header has no 0x1A terminator');
  for (const f of head.slice(0, eof < 0 ? 512 : eof).split('\r')) { if (f.length >= 3 && f[2] === ':') out.header[f.slice(0, 2)] = f.slice(3); }
  for (const k of ['LA', 'ST', 'CO', '+X', '-X', '+Y', '-Y', 'AX', 'AY', 'MX', 'MY', 'PD']) if (!(k in out.header)) bad('DST header field ' + k + ' missing');
  if (out.header.LA !== undefined && out.header.LA.length !== 16) bad('DST label field is ' + out.header.LA.length + ' characters, expected 16');
  for (let i = (eof < 0 ? 512 : eof + 1); i < 512; i++) if (buf[i] !== 0x20) { bad('DST header padding is not 0x20'); break; }
  if ((buf.length - 512) % 3) bad('DST body is not a multiple of 3 bytes');
  let x = 0, y = 0, ended = false, small = [];
  const dec = (b0, b1, b2) => {
    let dx = 0, dy = 0;
    if (b2 & 0x04) dx += 81; if (b2 & 0x08) dx -= 81; if (b1 & 0x04) dx += 27; if (b1 & 0x08) dx -= 27;
    if (b0 & 0x04) dx += 9; if (b0 & 0x08) dx -= 9; if (b1 & 0x01) dx += 3; if (b1 & 0x02) dx -= 3; if (b0 & 0x01) dx += 1; if (b0 & 0x02) dx -= 1;
    if (b2 & 0x20) dy += 81; if (b2 & 0x10) dy -= 81; if (b1 & 0x20) dy += 27; if (b1 & 0x10) dy -= 27;
    if (b0 & 0x20) dy += 9; if (b0 & 0x10) dy -= 9; if (b1 & 0x80) dy += 3; if (b1 & 0x40) dy -= 3; if (b0 & 0x80) dy += 1; if (b0 & 0x40) dy -= 1;
    return [dx, -dy]; // the file stores y up
  };
  for (let i = 512; i + 2 < buf.length; i += 3) {
    const b0 = buf[i], b1 = buf[i + 1], b2 = buf[i + 2];
    out.records++;
    if (ended) { bad('record after the END record'); break; }
    if ((b2 & 0x03) !== 0x03) bad('record at ' + i + ' does not have bits 0 and 1 of byte 3 set');
    if ((b2 & 0xf3) === 0xf3) { out.ops.push(['E', x, y]); ended = true; continue; }
    if ((b2 & 0xc3) === 0xc3) { if (b0 || b1) bad('colour change record carries a move'); out.ops.push(['C', x, y]); small = []; continue; }
    const d = dec(b0, b1, b2); x += d[0]; y += d[1];
    if (b2 & 0x80) {
      out.ops.push(['J', x, y]);
      // the trim signature of spec 8.2: three jumps a, -2a, a with a = (+-2, +-2): the needle wiggles and
      // comes back to where it was, which is what makes a machine cut the thread
      small.push(d);
      const k = small.length;
      if (k >= 3 && Math.abs(small[k - 3][0]) === 2 && Math.abs(small[k - 3][1]) === 2 && small[k - 1][0] === small[k - 3][0] && small[k - 1][1] === small[k - 3][1] &&
          small[k - 2][0] === -2 * small[k - 3][0] && small[k - 2][1] === -2 * small[k - 3][1]) { out.ops.splice(out.ops.length - 3, 3, ['T', x, y]); small = []; }
    } else { out.ops.push(['S', x, y]); small = []; }
  }
  if (!ended) bad('DST has no END record (00 00 F3)');
  out.header.records = out.records;
  return out;
}

/*
 * Needle-down view shared by every reader: colour blocks -> runs of thread -> points.
 * A run is a maximal series of stitches with no jump / trim / colour change inside.
 * `moveIsStitch` (DST): the record that lands a run is a stitch record, so it is the run's first point.
 * Returns { blocks: [[run, ...]], jumpsInsideRun, ended, tail }.
 */
function runsOf(ops) {
  const blocks = [[]]; let run = null, ended = false, tail = 0;
  for (const [k, x, y] of ops) {
    if (ended) { tail++; continue; }
    if (k === 'S') { if (!run) { run = []; blocks[blocks.length - 1].push(run); } run.push(x, y); }
    else if (k === 'J' || k === 'T') run = null;
    else if (k === 'C') { run = null; blocks.push([]); }
    else if (k === 'E') ended = true;
  }
  return { blocks, ended, tail };
}

module.exports = { decodePec, decodePes, decodePecBlock, decodeDst, runsOf, THUMB_FRAME, u16, s16, u32, f32, ascii };
