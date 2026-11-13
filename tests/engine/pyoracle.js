/*
 * Runs tests/engine/oracle.py (pyembroidery) for a list of writer cases. Used by oracle.test.js and by
 * `node tests/run.js --update-golden`. Everything is written to a fresh temp folder that is removed afterwards.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const DEFAULT_PYTHON = path.join(REPO, 'venv', 'bin', 'python');

// -> { python } or { skip: 'why' }
function findPython() {
  const python = process.env.EMB_PYTHON || DEFAULT_PYTHON;
  if (!fs.existsSync(python)) return { skip: 'no python at ' + python + ' (set EMB_PYTHON to a python that has pyembroidery)' };
  try { execFileSync(python, ['-B', '-c', 'import pyembroidery'], { stdio: 'pipe', timeout: 30000 }); }
  catch (e) { return { skip: python + ' cannot import pyembroidery' }; }
  return { python };
}

// cases: [{ id, name?, threads, stitches, formats }]; jsFiles: Map 'id.fmt' -> bytes (optional, read back by pyembroidery)
// -> { report, py: Map 'id.fmt' -> Buffer, ms }
function run(python, cases, jsFiles) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'emblabs-oracle-'));
  try {
    fs.mkdirSync(path.join(work, 'js'));
    fs.writeFileSync(path.join(work, 'cases.json'), JSON.stringify({ cases }));
    if (jsFiles) jsFiles.forEach((bytes, key) => fs.writeFileSync(path.join(work, 'js', key), bytes));
    const t0 = Date.now();
    execFileSync(python, ['-B', path.join(__dirname, 'oracle.py'), path.join(work, 'cases.json'), work], { stdio: 'pipe', timeout: 300000, maxBuffer: 1 << 26 });
    const ms = Date.now() - t0;
    const report = JSON.parse(fs.readFileSync(path.join(work, 'report.json'), 'utf8'));
    const py = new Map();
    for (const key of Object.keys(report.files)) { const p = path.join(work, 'py', key); if (fs.existsSync(p)) py.set(key, fs.readFileSync(p)); }
    return { report, py, ms };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { findPython, run, DEFAULT_PYTHON };
