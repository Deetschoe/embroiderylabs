#!/usr/bin/env node
/*
 * Runs the whole adversarial suite. Plain node; python with pyembroidery and Google Chrome are used when
 * present and their parts are listed as skipped when not.
 *
 *   node tests/adversarial/run.js            everything (about a minute; Chrome on 127.0.0.1:8107)
 *   ADV_NO_BROWSER=1   without Chrome        ADV_GEOM_ALL=1   every shape x every fill setting
 *   ADV_PORT=N         another port          ADV_VERBOSE=1    list every test
 */
'use strict';
const FILES = ['01-readers', '02-geometry', '03-hostile', '04-sequencing', '05-scale', '06-dst', '07-defects', '08-guards'];
(async () => {
  const rows = [];
  for (const f of FILES) { const t0 = Date.now(); let s; try { s = await require('./' + f + '.test.js'); } catch (e) { console.log('  FAIL ' + f + ' could not run: ' + (e && e.stack || e)); s = { name: f, passed: 0, failed: 1, skipped: 0 }; } if (!s || typeof s.failed !== 'number') { console.log('  FAIL ' + f + ' gave no summary'); s = { name: f, passed: 0, failed: 1, skipped: 0 }; } rows.push({ f, s, ms: Date.now() - t0 }); }
  console.log('\n== adversarial suite');
  let failed = 0, passed = 0, skipped = 0;
  for (const r of rows) { failed += r.s.failed; passed += r.s.passed; skipped += r.s.skipped; console.log('  ' + (r.s.failed ? 'FAIL' : 'ok  ') + ' ' + r.f.padEnd(14) + String(r.s.passed).padStart(5) + ' passed ' + String(r.s.failed).padStart(3) + ' failed ' + String(r.s.skipped).padStart(2) + ' skipped  ' + (r.ms / 1000).toFixed(1) + ' s'); }
  console.log('  total: ' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
  process.exitCode = failed ? 1 : 0;
})();
