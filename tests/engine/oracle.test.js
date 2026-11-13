/*
 * Writer oracle: the JS writers against pyembroidery (needs venv/bin/python with pyembroidery; skipped with a
 * message when it is missing).
 *   1. byte comparison: every digitized corpus design, the hand-written edge cases and seeded random
 *      patterns, in PES v1, PES v6, PEC and DST;
 *   2. round trip: files written by JS are read back by pyembroidery and compared with the IR they came from.
 */
'use strict';
const assert = require('assert');
const K = require('./cases.js');
const P = require('./pyoracle.js');

module.exports = {
  name: 'writer oracle: JS writers vs pyembroidery',
  run(t) {
    const found = P.findPython();
    if (found.skip) { t.skip('byte comparison and round trip against pyembroidery', found.skip); return; }
    const fuzzCount = t.opts.fuzz === undefined ? 300 : t.opts.fuzz;

    const designs = K.designCases();
    const cases = K.edgeCases();
    for (let s = 1; s <= fuzzCount; s++) cases.push(K.fuzzCase(s));
    for (const d of designs) cases.push({ id: d.id, name: d.pattern.name, threads: d.pattern.threads, stitches: d.pattern.stitches });
    for (const c of cases) c.formats = K.FORMATS;

    // JS output. Raw cases go through the format writers directly; designs through Writer.encode (the real path).
    const js = new Map(), jsErr = new Map();
    let jsMs = 0;
    const designIds = new Set(designs.map(d => d.id));
    for (const c of cases) for (const fmt of K.FORMATS) {
      const key = c.id + '.' + fmt, t0 = process.hrtime.bigint();
      try { js.set(key, Buffer.from(designIds.has(c.id) ? K.W.encode(c, fmt) : K.WRITE[fmt](c))); } catch (e) { jsErr.set(key, e.message); }
      jsMs += Number(process.hrtime.bigint() - t0) / 1e6;
    }
    const oracle = P.run(found.python, cases, js);
    const files = oracle.report.files;
    t.note('oracle', 'pyembroidery ' + oracle.report.pyembroidery + ', python ' + oracle.report.python + ': ' + Object.keys(files).length + ' files written and read in ' + oracle.ms + ' ms; JS wrote the same ' + js.size + ' files in ' + jsMs.toFixed(0) + ' ms');

    const groupOf = id => id.startsWith('fuzz') ? 'random patterns' : id.startsWith('edge') ? 'edge cases' : 'digitized designs';
    const tally = {};
    const problems = [];
    for (const c of cases) for (const fmt of K.FORMATS) {
      const key = c.id + '.' + fmt, g = groupOf(c.id) + ' / ' + fmt;
      tally[g] = tally[g] || { identical: 0, bothRefuse: 0, bad: 0 };
      const pyErr = files[key].writeError, jErr = jsErr.get(key);
      if (pyErr || jErr) { if (pyErr && jErr) tally[g].bothRefuse++; else { tally[g].bad++; problems.push(key + ': only ' + (jErr ? 'JS' : 'pyembroidery') + ' refused: ' + (jErr || pyErr)); } continue; }
      const a = js.get(key), b = oracle.py.get(key);
      if (a.equals(b)) { tally[g].identical++; continue; }
      tally[g].bad++;
      let first = -1; for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) { first = i; break; }
      problems.push(key + ': JS ' + a.length + ' bytes, pyembroidery ' + b.length + ' bytes, first difference at ' + first);
    }
    for (const group of ['digitized designs', 'edge cases', 'random patterns']) {
      t.test('byte for byte identical to pyembroidery: ' + group + ' (PES v1, PES v6, PEC, DST)', () => {
        const mine = problems.filter(p => groupOf(p.split('.')[0]) === group);
        assert.deepStrictEqual(mine.slice(0, 8), [], mine.length + ' files differ');
        let n = 0; for (const fmt of K.FORMATS) n += tally[group + ' / ' + fmt].identical;
        assert.ok(n > 0, 'nothing was compared');
      });
    }
    let identical = 0, refused = 0;
    for (const g of Object.keys(tally)) { identical += tally[g].identical; refused += tally[g].bothRefuse; }
    t.note('byte comparison', identical + ' files identical, ' + problems.length + ' different' + (refused ? ', ' + refused + ' refused by both writers' : '') +
      ' (' + designs.length + ' digitized designs, ' + K.edgeCases().length + ' edge cases, ' + fuzzCount + ' random patterns, 4 formats each)');

    // ---- round trip: what pyembroidery reads from the JS files vs the IR
    const pecColours = new Set(K.W.PEC_RGB.filter(v => v !== null));
    let checked = 0;
    for (const fmt of K.FORMATS) {
      t.test('round trip ' + fmt + ': pyembroidery reads the JS files back to the same stitches, colours, trims and bounds', () => {
        for (const d of designs) {
          const key = d.id + '.' + fmt, e = files[key];
          assert.ok(!e.readError, key + ': pyembroidery could not read the file: ' + e.readError);
          const r = e.read, f = K.irFacts(d.result.ir, d.pattern);
          assert.strictEqual(r.counts['0'], f.stitches, key + ': stitch count');
          assert.strictEqual(r.points.length, f.points.length, key + ': needle point count');
          for (let i = 0; i < f.points.length; i++) if (r.points[i] !== f.points[i]) assert.fail(key + ': needle point ' + (i >> 1) + ' is ' + r.points[i] + ', expected ' + f.points[i]);
          assert.strictEqual((r.counts['5'] || 0) + (r.counts['3'] || 0), f.changes, key + ': colour changes');
          // PES/PEC store a trim on the move that follows it, so the trim before END has no record of its own
          assert.strictEqual(r.counts['2'] || 0, fmt === 'dst' ? f.trims : f.trims - 1, key + ': trims');
          assert.strictEqual(r.counts['4'], 1, key + ': END');
          assert.deepStrictEqual(r.bounds, f.bounds, key + ': bounds');
          assert.strictEqual(r.bounds[2] - r.bounds[0], Math.round(d.result.bounds.width * 10), key + ': width matches the report');
          assert.strictEqual(r.bounds[3] - r.bounds[1], Math.round(d.result.bounds.height * 10), key + ': height matches the report');
          if (fmt === 'pes6') { assert.deepStrictEqual(r.threads, f.threads, key + ': exact thread colours in order'); assert.strictEqual(r.name, d.pattern.name, key + ': label'); }
          else if (fmt === 'dst') { assert.strictEqual(r.threads.length, 0, key + ': DST stores no colours'); assert.strictEqual(r.name, d.pattern.name.slice(0, 16).trim(), key + ': label'); }
          else {
            assert.strictEqual(r.threads.length, f.threads.length, key + ': colour count');
            for (let i = 0; i < r.threads.length; i++) {
              assert.ok(pecColours.has(r.threads[i]), key + ': colour ' + i + ' is not a Brother palette thread');
              for (let j = 0; j < i; j++) assert.strictEqual(r.threads[i] === r.threads[j], f.threads[i] === f.threads[j], key + ': colours ' + j + ' and ' + i + ' must ' + (f.threads[i] === f.threads[j] ? 'share a thread' : 'stay different'));
            }
          }
          checked++;
        }
      });
    }
    return Promise.resolve().then(() => t.note('round trip', checked + ' JS-written files read back by pyembroidery'));
  },
};
