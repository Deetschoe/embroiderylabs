/*
 * Minimal test harness for the engine suites (plain node, no packages).
 * A suite file exports { name, run(t) }. t.test(name, fn) records pass / fail; t.skip(name, why) records a skip;
 * t.note(label, value) adds a line to the final report (timings, counts).
 */
'use strict';

function createReport() {
  return { pass: 0, fail: 0, skip: 0, failures: [], skips: [], notes: [], suites: [] };
}

async function runSuite(suite, report, opts) {
  const verbose = opts && opts.verbose;
  const s = { name: suite.name, pass: 0, fail: 0, skip: 0, ms: 0 };
  const t0 = Date.now();
  const pending = [];
  const t = {
    opts: opts || {},
    test(name, fn) {
      const p = (async () => {
        try { await fn(); s.pass++; report.pass++; if (verbose) console.log('  ok    ' + name); }
        catch (e) {
          s.fail++; report.fail++;
          const msg = e && e.message ? e.message : String(e);
          report.failures.push({ suite: suite.name, name, message: msg, stack: e && e.stack });
          console.log('  FAIL  ' + name + '\n        ' + msg.split('\n').join('\n        '));
        }
      })();
      pending.push(p);
      return p;
    },
    skip(name, why) { s.skip++; report.skip++; report.skips.push({ suite: suite.name, name, why }); console.log('  skip  ' + name + ' (' + why + ')'); },
    note(label, value) { report.notes.push({ suite: suite.name, label, value }); },
  };
  console.log('\n' + suite.name);
  try { await suite.run(t); await Promise.all(pending); }
  catch (e) {
    s.fail++; report.fail++;
    report.failures.push({ suite: suite.name, name: '(suite crashed)', message: e && e.message, stack: e && e.stack });
    console.log('  FAIL  suite crashed: ' + (e && e.stack || e));
  }
  s.ms = Date.now() - t0;
  report.suites.push(s);
  console.log('  ' + s.pass + ' passed, ' + s.fail + ' failed, ' + s.skip + ' skipped, ' + s.ms + ' ms');
  return s;
}

module.exports = { createReport, runSuite };
