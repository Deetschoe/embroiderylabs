/*
 * Golden files: a snapshot of what pyembroidery writes for a fixed list of cases, so a machine with only
 * node can still check the JS writers byte for byte.
 *   golden/golden.json            sha256 + length of every reference file
 *   golden/testsew.{pes,dst,pec}, golden/testsew-v6.pes   the reference bytes of one small design
 * Regenerate with `node tests/run.js --update-golden` (needs the venv python). The files are produced by
 * pyembroidery, never by the JS writers.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const K = require('./cases.js');

const DIR = path.join(__dirname, 'golden');
const JSON_PATH = path.join(DIR, 'golden.json');
const SAMPLE = { id: 'design_testsew', files: { pes: 'testsew.pes', pes6: 'testsew-v6.pes', pec: 'testsew.pec', dst: 'testsew.dst' } };
const FUZZ = 24;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// -> [{ id, name?, threads, stitches, formats }] : edge cases, the first fuzz patterns, every digitized design
function goldenCases() {
  const cases = K.edgeCases();
  for (let s = 1; s <= FUZZ; s++) cases.push(K.fuzzCase(s));
  for (const d of K.designCases()) cases.push({ id: d.id, name: d.pattern.name, threads: d.pattern.threads, stitches: d.pattern.stitches });
  for (const c of cases) c.formats = K.FORMATS;
  return cases;
}
// The JS writers on a raw case, exactly as the oracle is asked to write it (no name clean-up).
function writeJs(c, fmt) { return Buffer.from(K.WRITE[fmt](c)); }

function load() { return fs.existsSync(JSON_PATH) ? JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')) : null; }

// oracle = result of pyoracle.run(): { report, py }
function update(oracle, cases) {
  fs.mkdirSync(DIR, { recursive: true });
  const files = {};
  for (const c of cases) for (const fmt of c.formats) {
    const key = c.id + '.' + fmt, e = oracle.report.files[key];
    if (e.writeError) files[key] = { error: e.writeError };
    else { const b = oracle.py.get(key); files[key] = { bytes: b.length, sha256: sha(b) }; }
  }
  const out = { source: 'pyembroidery ' + oracle.report.pyembroidery + ' (python ' + oracle.report.python + '), palette walked in first-occurrence order, via tests/engine/oracle.py',
    cases: cases.length, fuzz: FUZZ, files };
  fs.writeFileSync(JSON_PATH, JSON.stringify(out, null, 1) + '\n');
  for (const fmt of Object.keys(SAMPLE.files)) fs.writeFileSync(path.join(DIR, SAMPLE.files[fmt]), oracle.py.get(SAMPLE.id + '.' + fmt));
  return out;
}

module.exports = { DIR, JSON_PATH, SAMPLE, goldenCases, writeJs, load, update, sha };
