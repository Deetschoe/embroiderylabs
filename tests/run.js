#!/usr/bin/env node
/*
 * Tests for the embroidery engine (js/engine). Plain node, no packages to install.
 *
 *   node tests/run.js                  everything a machine with only node can run (geometry, digitizer, writer,
 *                                      facade), then the pyembroidery comparison if venv/bin/python has
 *                                      pyembroidery (skipped with a message if not)
 *   node tests/run.js --browser        the same plus headless Chrome over http://127.0.0.1:8106
 *   node tests/run.js --all            everything (same as --browser)
 *
 *   --no-oracle          never start python
 *   --only=a,b           only these suites: geometry, digitizer, writer, facade, oracle, browser
 *   --fuzz=N             random patterns for the oracle (default 300)
 *   --port=N             port for the browser suite (default 8106)
 *   --verbose            list every test
 *   --update-golden      rewrite tests/engine/golden/ from pyembroidery (needs the venv python), then exit
 *
 * Exit code 0 when nothing failed. Skips are listed and never counted as passes.
 */
'use strict';
const path = require('path');
const H = require('./engine/harness.js');

const SUITES = [
  { key: 'geometry', file: 'geometry.test.js', needs: 'node' },
  { key: 'digitizer', file: 'digitizer.test.js', needs: 'node' },
  { key: 'writer', file: 'writer.test.js', needs: 'node' },
  { key: 'facade', file: 'facade.test.js', needs: 'node' },
  { key: 'oracle', file: 'oracle.test.js', needs: 'python + pyembroidery' },
  { key: 'browser', file: 'browser.test.js', needs: 'Google Chrome' },
];

function parseArgs(argv) {
  const o = { only: null, oracle: true, browser: false, verbose: false, updateGolden: false };
  for (const a of argv) {
    if (a === '--all' || a === '--browser') o.browser = true;
    else if (a === '--no-oracle') o.oracle = false;
    else if (a === '--verbose' || a === '-v') o.verbose = true;
    else if (a === '--update-golden') o.updateGolden = true;
    else if (a.startsWith('--only=')) o.only = a.slice(7).split(',').filter(Boolean);
    else if (/^--fuzz=\d+$/.test(a)) o.fuzz = Number(a.slice(7));
    else if (/^--port=\d+$/.test(a)) o.port = Number(a.slice(7));
    else if (a === '--help' || a === '-h') o.help = true;
    else { console.error('unknown option ' + a + ' (see the top of tests/run.js)'); process.exit(2); }
  }
  if (o.only) for (const k of o.only) if (!SUITES.some(s => s.key === k)) { console.error('unknown suite "' + k + '". Suites: ' + SUITES.map(s => s.key).join(', ')); process.exit(2); }
  return o;
}

function updateGolden() {
  const P = require('./engine/pyoracle.js'), G = require('./engine/golden.js');
  const found = P.findPython();
  if (found.skip) { console.error('cannot update the golden files: ' + found.skip); return 1; }
  const cases = G.goldenCases(), out = G.update(P.run(found.python, cases), cases);
  const errors = Object.values(out.files).filter(f => f.error).length;
  console.log('golden files rewritten in ' + G.DIR + '\n  ' + Object.keys(out.files).length + ' reference files for ' + out.cases + ' cases, ' + errors + ' write errors\n  ' + out.source);
  return errors ? 1 : 0;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, '') + '*/'); return 0; }
  if (o.updateGolden) return updateGolden();

  const chosen = SUITES.filter(s => o.only ? o.only.includes(s.key) : s.key === 'oracle' ? o.oracle : s.key === 'browser' ? o.browser : true);
  const report = H.createReport(), t0 = Date.now();
  console.log('Embroidery engine tests (node ' + process.version + '): ' + chosen.map(s => s.key).join(', '));
  for (const s of chosen) await H.runSuite(require(path.join(__dirname, 'engine', s.file)), report, { verbose: o.verbose, fuzz: o.fuzz, port: o.port });

  console.log('\n' + '='.repeat(78));
  const pad = (v, n) => String(v).padStart(n);
  report.suites.forEach((s, i) => console.log('  ' + chosen[i].key.padEnd(10) + pad(s.pass, 4) + ' passed' + pad(s.fail, 4) + ' failed' + pad(s.skip, 3) + ' skipped' + pad(s.ms, 7) + ' ms   needs ' + chosen[i].needs));
  if (report.notes.length) { console.log('\nNumbers'); for (const n of report.notes) console.log('  ' + n.label + ': ' + n.value); }
  if (report.skips.length) { console.log('\nSkipped (not verified in this run)'); for (const s of report.skips) console.log('  ' + s.name + ': ' + s.why); }
  const notRun = SUITES.filter(s => !chosen.includes(s));
  if (notRun.length) console.log('\nNot run: ' + notRun.map(s => s.key + ' (' + (s.key === 'browser' ? '--browser' : s.key === 'oracle' ? 'remove --no-oracle' : 'left out by --only') + ')').join(', '));
  if (report.failures.length) { console.log('\nFailures'); for (const f of report.failures) console.log('  [' + f.suite + '] ' + f.name + '\n      ' + String(f.message).split('\n')[0]); }
  console.log('\n' + (report.fail ? 'FAILED' : 'OK') + ': ' + report.pass + ' passed, ' + report.fail + ' failed, ' + report.skip + ' skipped in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  return report.fail ? 1 : 0;
}

main().then(code => { process.exitCode = code; }, e => { console.error(e && e.stack || e); process.exitCode = 1; });
