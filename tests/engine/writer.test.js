/*
 * Writer tests that need only node.
 *   - golden: the JS writers against a stored snapshot of pyembroidery's output (tests/engine/golden/);
 *   - independent decoders: small PEC and DST readers written here from the format layouts, with no code
 *     shared with the writer, read every digitized design back and compare it with the stitch data;
 *   - the IR adapter (fromIR), labels, error codes, determinism.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const K = require('./cases.js');
const G = require('./golden.js');
const D = require('./designs.js');
const W = K.W, Engine = K.Engine;

const ascii = (b, at, n) => { let s = ''; for (let i = at; i < at + n; i++) s += String.fromCharCode(b[i]); return s; };
const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const points = ops => { const out = []; for (const o of ops) if (o.op === 'stitch') { const l = out.length; if (!l || out[l - 2] !== o.x || out[l - 1] !== o.y) out.push(o.x, o.y); } return out; };
const boundsOf = pts => { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (let i = 0; i < pts.length; i += 2) { a = Math.min(a, pts[i]); c = Math.max(c, pts[i]); b = Math.min(b, pts[i + 1]); d = Math.max(d, pts[i + 1]); } return [a, b, c, d]; };

// ---- PEC section reader. `at` = offset of 'LA:'. Layout: 512-byte header, stitch block, thumbnails.
function decodePec(b, at) {
  assert.strictEqual(ascii(b, at, 3), 'LA:', 'PEC section starts with LA:');
  assert.strictEqual(b[at + 19], 0x0d, 'label is closed by a carriage return');
  const colours = b[at + 48] + 1;
  const palette = Array.from(b.slice(at + 49, at + 49 + colours));
  for (let i = at + 49 + colours; i < at + 512; i++) if (b[i] !== 0x20) throw new Error('PEC header padding is not blank at ' + i);
  const block = at + 512;
  const blockLen = b[block + 2] | (b[block + 3] << 8) | (b[block + 4] << 16);
  assert.deepStrictEqual([b[block], b[block + 1], b[block + 5], b[block + 6], b[block + 7]], [0, 0, 0x31, 0xff, 0xf0], 'stitch block signature');
  const out = { label: ascii(b, at + 3, 16), colours, palette, width: u16(b, block + 8), height: u16(b, block + 10), ops: [], end: block + blockLen };
  let i = block + 16, x = 0, y = 0, ended = false;
  const coord = st => {
    const a = b[i++];
    if (!(a & 0x80)) return a > 63 ? a - 128 : a;          // 7-bit signed
    if (a & 0x20) st.trim = true;
    if (a & 0x10) st.jump = true;
    let v = ((a & 0x0f) << 8) | b[i++];                    // 12-bit signed
    if (v & 0x800) v -= 0x1000;
    return v;
  };
  while (i < out.end) {
    if (b[i] === 0xff) { i++; ended = true; break; }
    if (b[i] === 0xfe && b[i + 1] === 0xb0) { out.ops.push({ op: 'color', x, y, arg: b[i + 2] }); i += 3; continue; }
    const st = { trim: false, jump: false };
    const dx = coord(st), dy = coord(st);
    x += dx; y += dy;
    out.ops.push({ op: st.jump ? 'jump' : st.trim ? 'trim' : 'stitch', x, y });
  }
  assert.ok(ended, 'stitch block has no end marker');
  assert.strictEqual(i, out.end, 'the end marker is the last byte of the stitch block');
  out.thumbnails = (b.length - out.end) / 228;
  return out;
}

// ---- DST reader: 512-byte text header, 3-byte records (Tajima bit table), y up in the file.
function decodeDst(b) {
  const head = ascii(b, 0, 512), field = k => { const m = head.match(new RegExp(k.replace('+', '\\+') + ':([^\\r]*)\\r')); return m ? m[1] : null; };
  const out = { label: field('LA'), st: +field('ST'), co: +field('CO'), px: +field('+X'), nx: +field('-X'), py: +field('+Y'), ny: +field('-Y'), ops: [], ended: false };
  const bit = (v, n) => (v >> n) & 1;
  let x = 0, y = 0;
  for (let i = 512; i + 2 < b.length; i += 3) {
    const b0 = b[i], b1 = b[i + 1], b2 = b[i + 2];
    if (b2 === 0xf3) { out.ended = true; out.endAt = i; break; }
    const dx = bit(b0, 0) - bit(b0, 1) + 9 * (bit(b0, 2) - bit(b0, 3)) + 3 * (bit(b1, 0) - bit(b1, 1)) + 27 * (bit(b1, 2) - bit(b1, 3)) + 81 * (bit(b2, 2) - bit(b2, 3));
    const dy = bit(b0, 7) - bit(b0, 6) + 9 * (bit(b0, 5) - bit(b0, 4)) + 3 * (bit(b1, 7) - bit(b1, 6)) + 27 * (bit(b1, 5) - bit(b1, 4)) + 81 * (bit(b2, 5) - bit(b2, 4));
    x += dx; y -= dy;
    if ((b2 & 0xc3) === 0xc3) out.ops.push({ op: 'color', x, y });
    else out.ops.push({ op: (b2 & 0x80) ? 'jump' : 'stitch', x, y, dx, dy: -dy });
  }
  return out;
}
// A trim in DST is three jump records that go nowhere: (2,2) (-4,-4) (2,2).
function dstTrims(ops) {
  let n = 0;
  for (let i = 0; i + 2 < ops.length; i++) {
    const a = ops[i], b = ops[i + 1], c = ops[i + 2];
    if (a.op === 'jump' && b.op === 'jump' && c.op === 'jump' && a.dx === 2 && a.dy === 2 && b.dx === -4 && b.dy === -4 && c.dx === 2 && c.dy === 2) { n++; i += 2; }
  }
  return n;
}
// runs of consecutive trim-flagged moves in a PEC stream
function pecTrims(ops) { let n = 0; for (let i = 0; i < ops.length; i++) if (ops[i].op === 'trim' && (i === 0 || ops[i - 1].op !== 'trim')) n++; return n; }

module.exports = {
  name: 'writer: stitches -> PES / PEC / DST bytes',
  run(t) {
    const designs = K.designCases();
    const enc = (d, fmt) => W.encode(d.pattern, fmt);

    // ------------------------------------------------------------ golden snapshot of pyembroidery
    const golden = G.load();
    t.test('golden snapshot: every stored reference file matches the JS writer', () => {
      assert.ok(golden, 'tests/engine/golden/golden.json is missing (create it with: node tests/run.js --update-golden)');
      const cases = G.goldenCases();
      let n = 0;
      const bad = [];
      for (const c of cases) for (const fmt of c.formats) {
        const key = c.id + '.' + fmt, g = golden.files[key];
        if (!g) { bad.push(key + ': not in the snapshot (run --update-golden)'); continue; }
        let bytes = null, err = null;
        try { bytes = G.writeJs(c, fmt); } catch (e) { err = e.message; }
        if (g.error || err) { if (!(g.error && err)) bad.push(key + ': ' + (err ? 'JS refused (' + err + ')' : 'the reference writer refused but JS wrote a file')); n++; continue; }
        if (bytes.length !== g.bytes || G.sha(bytes) !== g.sha256) bad.push(key + ': ' + bytes.length + ' bytes, snapshot has ' + g.bytes);
        n++;
      }
      assert.deepStrictEqual(bad.slice(0, 8), [], bad.length + ' of ' + n + ' files differ from the snapshot');
      assert.strictEqual(Object.keys(golden.files).length, n, 'the snapshot holds files that no case produces any more');
      t.note('golden snapshot', n + ' files identical to the stored pyembroidery output (' + cases.length + ' cases x 4 formats; ' + golden.source + ')');
    });
    t.test('golden sample files: Engine.export of the test-sew design gives the stored reference bytes', () => {
      const result = Engine.generate(D.designs.testsew);
      for (const fmt of Object.keys(G.SAMPLE.files)) {
        const p = path.join(G.DIR, G.SAMPLE.files[fmt]);
        assert.ok(fs.existsSync(p), p + ' is missing');
        const file = Engine.export(result, { format: fmt });
        assert.ok(Buffer.from(file.bytes).equals(fs.readFileSync(p)), G.SAMPLE.files[fmt] + ' differs from Engine.export output');
      }
    });

    // ------------------------------------------------------------ containers
    t.test('PES v1 / v6 / PEC containers: magic, PEC offset, label, colour table, sizes, thumbnails', () => {
      for (const d of designs) {
        const f = K.irFacts(d.result.ir, d.pattern), n = f.threads.length;
        const pes = enc(d, 'pes'), pes6 = enc(d, 'pes6'), pec = enc(d, 'pec');
        assert.strictEqual(ascii(pes, 0, 8), '#PES0001', d.id);
        assert.strictEqual(ascii(pes6, 0, 8), '#PES0060', d.id);
        assert.strictEqual(ascii(pec, 0, 8), '#PEC0001', d.id);
        const sections = [[pes, u32(pes, 8), 0], [pes6, u32(pes6, 8), 128 + 0x90 * n + 3 * n + 2], [pec, 8, 0]];
        const bodies = sections.map(([b, at, tail]) => {
          assert.ok(at > 0 && at + 512 < b.length, d.id + ': PEC offset inside the file');
          const p = decodePec(b.slice(0, b.length - tail), at);
          assert.strictEqual(p.label, d.pattern.name.slice(0, 8).padEnd(16, ' '), d.id + ': label');
          assert.strictEqual(p.colours, n, d.id + ': colour count');
          assert.strictEqual(p.thumbnails, n + 1, d.id + ': one thumbnail per colour plus one');
          assert.strictEqual(p.width, f.bounds[2] - f.bounds[0], d.id + ': width');
          assert.strictEqual(p.height, f.bounds[3] - f.bounds[1], d.id + ': height');
          for (let i = 0; i < n; i++) {
            assert.ok(p.palette[i] >= 1 && p.palette[i] <= 64, d.id + ': palette index in 1..64');
            for (let j = 0; j < i; j++) assert.strictEqual(p.palette[i] === p.palette[j], f.threads[i] === f.threads[j], d.id + ': colours ' + j + ' and ' + i + ' share a palette thread only when they are the same colour');
          }
          return Buffer.from(b.slice(at, at + 512 + (p.end - at - 512) + 228 * (n + 1)));
        });
        assert.ok(bodies[0].equals(bodies[1]) && bodies[0].equals(bodies[2]), d.id + ': the PEC section is the same in .pes (v1), .pes (v6) and .pec');
        // PES v6 stores the label and the exact thread colours
        assert.strictEqual(ascii(pes6, 17, pes6[16]), d.pattern.name, d.id + ': v6 label');
        const tableAt = 17 + pes6[16] + 4 + 36 + 1 + 24 + 6;
        assert.strictEqual(u16(pes6, tableAt), n, d.id + ': v6 thread count');
        for (let i = 0; i < n; i++) { const o = tableAt + 2 + i * 12; assert.strictEqual((pes6[o + 1] << 16) | (pes6[o + 2] << 8) | pes6[o + 3], f.threads[i], d.id + ': v6 thread ' + i + ' colour'); }
      }
    });

    for (const fmt of ['pes', 'pes6', 'pec']) {
      t.test('independent PEC reader, ' + fmt + ': every design reads back to the same needle points, colour changes and trims', () => {
        for (const d of designs) {
          const b = enc(d, fmt), f = K.irFacts(d.result.ir, d.pattern), n = f.threads.length;
          const tail = fmt === 'pes6' ? 128 + 0x90 * n + 3 * n + 2 : 0;
          const p = decodePec(b.slice(0, b.length - tail), fmt === 'pec' ? 8 : u32(b, 8));
          const pts = points(p.ops);
          assert.strictEqual(pts.length, f.points.length, d.id + ': needle point count');
          for (let i = 0; i < pts.length; i++) if (pts[i] !== f.points[i]) assert.fail(d.id + ': needle point ' + (i >> 1) + ' differs');
          assert.strictEqual(p.ops.filter(o => o.op === 'color').length, f.changes, d.id + ': colour changes');
          assert.strictEqual(p.ops[0].op, 'jump', d.id + ': the file opens with a jump to the first stitch');
          assert.strictEqual(p.ops.filter(o => o.op === 'jump').length, 1, d.id + ': only the opening move is a plain jump');
          assert.strictEqual(pecTrims(p.ops), f.trims - 1, d.id + ': every move between runs carries the trim flag');
          assert.deepStrictEqual(boundsOf(pts), f.bounds, d.id + ': bounds');
          const colourArgs = p.ops.filter(o => o.op === 'color').map(o => o.arg);
          assert.deepStrictEqual(colourArgs, colourArgs.map((_, i) => (i % 2 ? 1 : 2)), d.id + ': colour change records alternate 2, 1');
        }
      });
    }

    t.test('independent DST reader: header fields, needle points, colour changes, trims, end record', () => {
      for (const d of designs) {
        const b = enc(d, 'dst'), f = K.irFacts(d.result.ir, d.pattern);
        assert.strictEqual((b.length - 512) % 3, 0, d.id + ': whole records');
        assert.strictEqual(b[b.indexOf(0x1a)], 0x1a); assert.ok(b.indexOf(0x1a) < 512, d.id + ': header terminator');
        const q = decodeDst(b);
        assert.ok(q.ended && q.endAt === b.length - 3, d.id + ': ends with the END record');
        assert.deepStrictEqual([b[b.length - 3], b[b.length - 2], b[b.length - 1]], [0, 0, 0xf3], d.id + ': END record bytes');
        assert.strictEqual(q.label, d.pattern.name.slice(0, 16).trim().padEnd(16, ' '), d.id + ': label');
        const pts = points(q.ops);
        assert.strictEqual(pts.length, f.points.length, d.id + ': needle point count');
        for (let i = 0; i < pts.length; i++) if (pts[i] !== f.points[i]) assert.fail(d.id + ': needle point ' + (i >> 1) + ' differs');
        const changes = q.ops.filter(o => o.op === 'color').length, trims = dstTrims(q.ops);
        assert.strictEqual(changes, f.changes, d.id + ': colour changes');
        assert.strictEqual(q.co, f.changes, d.id + ': CO field');
        assert.strictEqual(trims, f.trims, d.id + ': trims');
        assert.strictEqual(q.ops.length + 1, q.st + 2 * trims, d.id + ': ST field counts commands (a trim is one command, three records)');
        assert.strictEqual(q.px + q.nx, f.bounds[2] - f.bounds[0], d.id + ': +X / -X span the width');
        assert.strictEqual(q.py + q.ny, f.bounds[3] - f.bounds[1], d.id + ': +Y / -Y span the height');
        for (const o of q.ops) if (o.op !== 'color' && (Math.abs(o.dx) > 121 || Math.abs(o.dy) > 121)) assert.fail(d.id + ': a record moves more than 12.1 mm');
      }
    });

    t.test('raw patterns: long moves are split, STOP and repeated colours survive, 70 colours fit', () => {
      const byId = {}; for (const c of K.edgeCases()) byId[c.id] = c;
      // DST: a 500 mm stitch becomes jumps of at most 12.1 mm that still land on the point
      let q = decodeDst(W.writeDst(byId.edge_long_stitch));
      assert.deepStrictEqual(points(q.ops), [0, 0, 5000, 100, 5000, -4200, 0, 0]);
      assert.ok(q.ops.filter(o => o.op === 'jump').length > 100);
      // PEC: the same pattern, split into moves of at most 204.7 mm; the corners are still reached in order
      let p = decodePec(W.writePec(byId.edge_long_stitch), 8);
      const corners = [[0, 0], [5000, 100], [5000, -4200], [0, 0]], seen = points(p.ops);
      let ci = 0, px = 0, py = 0;
      for (const o of p.ops) { assert.ok(Math.abs(o.x - px) <= 2047 && Math.abs(o.y - py) <= 2047, 'a PEC move is longer than 204.7 mm'); px = o.x; py = o.y; }
      for (let i = 0; i < seen.length; i += 2) if (ci < corners.length && seen[i] === corners[ci][0] && seen[i + 1] === corners[ci][1]) ci++;
      assert.strictEqual(ci, corners.length, 'corners of the long-stitch pattern');
      // 7-bit / 12-bit boundary values decode to the same points
      p = decodePec(W.writePec(byId.edge_pec_boundaries), 8);
      assert.deepStrictEqual(points(p.ops), byId.edge_pec_boundaries.stitches.reduce((a, s) => a.concat([s[0], s[1]]), []));
      q = decodeDst(W.writeDst(byId.edge_pec_boundaries));
      assert.deepStrictEqual(points(q.ops), byId.edge_pec_boundaries.stitches.reduce((a, s) => a.concat([s[0], s[1]]), []));
      // the same colour three times is still three colour blocks
      p = decodePec(W.writePec(byId.edge_same_colour_twice), 8);
      assert.strictEqual(p.colours, 3); assert.strictEqual(new Set(p.palette).size, 1);
      // a STOP is written as a colour change to the same thread in PEC, and as a stop record in DST
      p = decodePec(W.writePec(byId.edge_stop), 8);
      assert.strictEqual(p.colours, 2); assert.strictEqual(p.palette[0], p.palette[1]);
      assert.strictEqual(decodeDst(W.writeDst(byId.edge_stop)).ops.filter(o => o.op === 'color').length, 1);
      // four nearly identical colours still get four different palette threads
      p = decodePec(W.writePec(byId.edge_near_colours), 8);
      assert.strictEqual(new Set(p.palette).size, 4);
      // 70 colour blocks
      p = decodePec(W.writePec(byId.edge_64_colours), 8);
      assert.strictEqual(p.colours, 70); assert.strictEqual(p.ops.filter(o => o.op === 'color').length, 69);
      // no name -> 'Untitled'
      assert.strictEqual(decodePec(W.writePec(byId.edge_no_name), 8).label, 'Untitled'.padEnd(16, ' '));
      assert.strictEqual(decodeDst(W.writeDst(byId.edge_no_name)).label, 'Untitled'.padEnd(16, ' '));
    });

    // ------------------------------------------------------------ IR adapter
    const OP = Engine.OP;
    const ir = (cmds, threads) => ({ units: 0.1, hoop: { w: 1000, h: 1000 }, threads: threads || [{ color: '#ff0000' }, { color: '#00f' }], commands: Int32Array.from(cmds) });
    const two = [OP.JUMP, 10, 10, OP.STITCH, 10, 10, OP.STITCH, 30, 10, OP.TRIM, 30, 10, OP.COLOR_CHANGE, 30, 10,
      OP.JUMP, 50, 50, OP.STITCH, 50, 50, OP.STITCH, 70, 51, OP.TRIM, 70, 51, OP.END, 70, 51];
    t.test('fromIR: drops jumps, centres on the integer middle of the stitches, keeps trims and colour order, appends END', () => {
      const p = W.fromIR(ir(two), { name: 'Two' });
      assert.deepStrictEqual(p.center, { x: 40, y: 31 });
      assert.deepStrictEqual(p.stitches, [[-30, -21, W.STITCH], [-10, -21, W.STITCH], [-10, -21, W.TRIM], [-10, -21, W.COLOR_CHANGE], [10, 19, W.STITCH], [30, 20, W.STITCH], [30, 20, W.TRIM], [30, 20, W.END]]);
      assert.deepStrictEqual(p.threads, [0xff0000, 0x0000ff]);
      assert.strictEqual(p.name, 'Two');
      const raw = W.fromIR(ir(two), { center: false });
      assert.deepStrictEqual(raw.center, { x: 0, y: 0 });
      assert.deepStrictEqual(raw.stitches[0], [10, 10, W.STITCH]);
      assert.strictEqual(raw.name, 'Untitled');
      // anything after END is ignored, and a missing END is added
      const cut = W.fromIR(ir(two.slice(0, 12).concat([OP.END, 30, 10, OP.STITCH, 999, 999])), { center: false });
      assert.strictEqual(cut.stitches.filter(s => s[2] === W.STITCH).length, 2);
      assert.strictEqual(W.fromIR(ir(two.slice(0, 9))).stitches.pop()[2], W.END);
    });
    t.test('fromIR: every digitized design keeps its stitch count, colour blocks and one END', () => {
      for (const d of designs) {
        const f = K.irFacts(d.result.ir, d.pattern), s = d.pattern.stitches;
        assert.strictEqual(s.filter(v => v[2] === W.STITCH).length, d.result.totals.stitches, d.id + ': stitches');
        assert.strictEqual(s.filter(v => v[2] === W.COLOR_CHANGE).length, d.result.threads.length - 1, d.id + ': colour changes');
        assert.strictEqual(s.filter(v => v[2] === W.TRIM).length, f.trims, d.id + ': trims');
        assert.strictEqual(s.filter(v => v[2] === W.JUMP).length, 0, d.id + ': no jumps');
        assert.strictEqual(s.filter(v => v[2] === W.END).length, 1, d.id + ': one END');
        assert.strictEqual(s[s.length - 1][2], W.END, d.id + ': END last');
        assert.ok(Math.abs(f.bounds[0] + f.bounds[2]) <= 1 && Math.abs(f.bounds[1] + f.bounds[3]) <= 1, d.id + ': centred to within 0.1 mm');
        assert.deepStrictEqual(d.pattern.threads, f.threads, d.id + ': thread colours');
      }
    });
    t.test('fromIR and encode refuse bad input with a code', () => {
      const code = fn => { try { fn(); } catch (e) { return e.code || ('no code: ' + e.message); } return 'did not throw'; };
      assert.strictEqual(code(() => W.fromIR(null)), 'INVALID_IR');
      assert.strictEqual(code(() => W.fromIR({})), 'INVALID_IR');
      assert.strictEqual(code(() => W.fromIR(ir([]))), 'EMPTY_DESIGN');
      assert.strictEqual(code(() => W.fromIR(ir([OP.JUMP, 5, 5, OP.TRIM, 5, 5, OP.END, 5, 5]))), 'EMPTY_DESIGN');
      assert.strictEqual(code(() => W.fromIR({ threads: [{ color: '#000000' }], commands: Float64Array.from([OP.STITCH, NaN, 0, OP.STITCH, 5, 5]) })), 'INVALID_IR');
      assert.strictEqual(code(() => W.fromIR({ threads: [{ color: '#000000' }], commands: [OP.STITCH, Infinity, 0] })), 'INVALID_IR');
      assert.strictEqual(code(() => W.fromIR(ir(two, [{ color: '#000000' }]))), 'INVALID_IR');
      assert.strictEqual(code(() => W.fromIR(ir(two, Array.from({ length: 256 }, () => ({ color: '#123456' }))))), 'TOO_MANY_COLORS');
      const p = W.fromIR(ir(two));
      assert.strictEqual(code(() => W.encode(p, 'exe')), 'UNKNOWN_FORMAT');
      assert.strictEqual(code(() => W.encode(p, 'jef')), 'UNKNOWN_FORMAT');
      assert.ok(Buffer.from(W.encode(p)).equals(Buffer.from(W.encode(p, 'PES'))), 'default format is pes, ids are case-insensitive');
    });

    // ------------------------------------------------------------ labels
    t.test('sanitizeName: printable ASCII, accents folded, never empty, length cut', () => {
      const table = [
        ['Patch', 0, 'Patch'], ['Café Badge №1', 0, 'Cafe Badge No1'], ['', 0, 'Untitled'], [null, 0, 'Untitled'], [undefined, 0, 'Untitled'],
        ['   ', 0, 'Untitled'], ['\u{1F9F5}\u{1F9F5}', 0, 'Untitled'], ['  a\tb\n c  ', 0, 'a b c'], [12345, 0, '12345'], ['naïve Ünïcödé', 0, 'naive Unicode'],
        ['A very long design name', 8, 'A very l'], ['abcdefg hijk', 8, 'abcdefg'], ['日本語', 8, 'Untitled'], ['x\u0000y\u001fz', 0, 'xyz'], ['../U&O', 0, '../U&O'],
        ['<script>alert(1)</script>', 16, '<script>alert(1)'],
      ];
      for (const [input, max, want] of table) assert.strictEqual(W.sanitizeName(input, max), want, JSON.stringify(input));
    });
    t.test('labels in the files: 8 characters in PES / PEC, 16 in DST, exactly as sanitized', () => {
      const p = W.fromIR(ir(two), { name: 'Café Badge №1 with a long tail' });
      assert.strictEqual(p.name, 'Cafe Badge No1 with a long tail');
      assert.strictEqual(decodePec(W.encode(p, 'pec'), 8).label, 'Cafe Bad        ');
      assert.strictEqual(decodePec(W.encode(p, 'pes'), u32(W.encode(p, 'pes'), 8)).label, 'Cafe Bad        ');
      assert.strictEqual(decodeDst(W.encode(p, 'dst')).label, 'Cafe Badge No1 w');
      const v6 = W.encode(p, 'pes6');
      assert.strictEqual(ascii(v6, 17, v6[16]), 'Cafe Badge No1 with a long tail');
      for (const fmt of K.FORMATS) { const b = W.encode(W.fromIR(ir(two), { name: '\u{1F9F5}' }), fmt); assert.ok(ascii(b, 0, b.length).includes('Untitled'), fmt + ': an unusable name becomes Untitled'); }
    });
    t.test('Writer.FORMATS: four formats with extension, mime type and label', () => {
      assert.deepStrictEqual(Object.keys(W.FORMATS).sort(), ['dst', 'pec', 'pes', 'pes6']);
      assert.deepStrictEqual(Object.keys(W.FORMATS).map(k => W.FORMATS[k].ext).sort(), ['dst', 'pec', 'pes', 'pes']);
      for (const k of Object.keys(W.FORMATS)) { assert.strictEqual(W.FORMATS[k].id, k); assert.strictEqual(W.FORMATS[k].mime, 'application/octet-stream'); assert.ok(W.FORMATS[k].label.length > 3); }
    });

    // ------------------------------------------------------------ behaviour
    t.test('writing is deterministic and does not modify the pattern or the stitch data', () => {
      for (const d of designs.filter((_, i) => i % 6 === 0)) {
        const before = JSON.stringify(d.pattern), cmds = Buffer.from(d.result.ir.commands.buffer).toString('base64');
        for (const fmt of K.FORMATS) {
          const a = Buffer.from(enc(d, fmt)), b = Buffer.from(enc(d, fmt));
          assert.ok(a.equals(b), d.id + '.' + fmt + ': two writes differ');
          assert.ok(a instanceof Uint8Array && a.length > 512, d.id + '.' + fmt + ': bytes');
          const again = Buffer.from(W.encode(W.fromIR(d.result.ir, { name: d.pattern.name }), fmt));
          assert.ok(a.equals(again), d.id + '.' + fmt + ': a second fromIR gives other bytes');
        }
        assert.strictEqual(JSON.stringify(d.pattern), before, d.id + ': pattern modified');
        assert.strictEqual(Buffer.from(d.result.ir.commands.buffer).toString('base64'), cmds, d.id + ': IR modified');
      }
      for (const c of K.edgeCases()) { const before = JSON.stringify(c); for (const fmt of K.FORMATS) K.WRITE[fmt](c); assert.strictEqual(JSON.stringify(c), before, c.id + ': raw pattern modified'); }
    });
    t.test('the file does not depend on the hoop: the same shapes in a bigger hoop give the same bytes', () => {
      for (const k of ['patch', 'badge', 'testsew']) {
        const small = D.designs[k], big = Object.assign({}, small, { hoop: { width: 200, height: 260 } });
        const a = Engine.generate(small), b = Engine.generate(big);
        assert.strictEqual(a.totals.stitches, b.totals.stitches, k);
        for (const fmt of K.FORMATS) assert.ok(Buffer.from(Engine.export(a, { format: fmt }).bytes).equals(Buffer.from(Engine.export(b, { format: fmt }).bytes)), k + '.' + fmt);
      }
    });
    t.test('writer speed: the largest design the engine lets through, and stitch data four times that size, are written in under 5 s per format', () => {
      // six of the "heavy" fills: just inside LIMITS.maxStitches (all thirty are refused, see limits in the adversarial suite)
      const r = Engine.generate(Object.assign({}, D.designs.heavy, { objects: D.designs.heavy.objects.slice(0, 6) }));
      assert.strictEqual(r.canExport, true); assert.ok(r.totals.stitches > 400000 && r.totals.stitches <= Engine.LIMITS.maxStitches, r.totals.stitches + ' stitches');
      // the writers themselves have no limit: 2 million stitches of zigzag, made here without the digitizer
      const big = new Int32Array(2000001 * 3);
      for (let i = 0; i < 2000000; i++) { big[i * 3] = Engine.OP.STITCH; big[i * 3 + 1] = (i % 2 ? 30 : -30) + (i % 1000) - 500; big[i * 3 + 2] = Math.floor(i / 1000) * 4 - 4000; }
      big[2000000 * 3] = Engine.OP.END; big[2000000 * 3 + 1] = big[1999999 * 3 + 1]; big[2000000 * 3 + 2] = big[1999999 * 3 + 2];
      for (const [label, ir, count] of [['largest allowed', r.ir, r.totals.stitches], ['writer alone', { threads: [{ color: '#123456' }], commands: big }, 2000000]]) {
        const p = W.fromIR(ir, { name: 'Heavy' });
        const times = [];
        for (const fmt of ['pes', 'dst']) {
          const t0 = process.hrtime.bigint(); const b = W.encode(p, fmt); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
          assert.ok(ms < 5000, fmt + ' took ' + ms.toFixed(0) + ' ms');
          times.push(fmt + ' ' + (b.length / 1048576).toFixed(1) + ' MB in ' + ms.toFixed(0) + ' ms');
        }
        t.note('writing ' + count + ' stitches (' + label + ')', times.join(', '));
      }
      const full = Engine.generate(D.designs.full), t0 = process.hrtime.bigint();
      const file = Engine.export(full, { format: 'pes' });
      t.note('export of a full 100 mm hoop (' + full.totals.stitches + ' stitches) to PES', (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1) + ' ms, ' + file.bytes.length + ' bytes');
    });
  },
};
