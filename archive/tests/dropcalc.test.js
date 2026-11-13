/* Drop Calc model tests. Run: node tests/dropcalc.test.js
   No packages. Exits 1 on the first failed group. */
'use strict';
var assert = require('assert');
var path = require('path');
var M = require(path.join(__dirname, '..', 'js', 'dropcalc.js'));

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.message ? e.message.split('\n').join('\n     ') : e)); }
}
function near(actual, expected, tol, label) {
  tol = tol == null ? 1e-6 : tol;
  assert.ok(Math.abs(actual - expected) <= tol, (label || 'value') + ': expected ' + expected + ', got ' + actual);
}
function cents(v) { return Math.round(v * 100); }
function rng(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
/* Smallest n in 0..limit with profit(n) >= 0 to the cent, by trying every n. */
function bruteBreakEven(result, limit) {
  for (var n = 0; n <= limit; n++) if (cents(M.profitAtResult(result, n)) >= 0) return n;
  return null;
}
function assertAllFinite(value, where) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { assert.ok(isFinite(value), where + ' is ' + value); return; }
  if (Array.isArray(value)) { value.forEach(function (v, i) { assertAllFinite(v, where + '[' + i + ']'); }); return; }
  if (typeof value === 'object') { Object.keys(value).forEach(function (k) { assertAllFinite(value[k], where + '.' + k); }); return; }
  assert.fail(where + ' has type ' + typeof value);
}
function parseCsv(text) {
  var rows = [], row = [], cell = '', i = 0, inQ = false, sawQuote = false;
  while (i < text.length) {
    var ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } inQ = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; sawQuote = true; i++; continue; }
    if (ch === ',') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 2; continue; }
    assert.fail('unquoted character ' + JSON.stringify(ch) + ' at ' + i);
  }
  assert.ok(sawQuote);
  assert.strictEqual(cell, ''); assert.strictEqual(row.length, 0);
  return rows;
}

/* ---------- hand-computed cases ------------------------------------------- */
test('simple drop: 100 pieces at $48, $21.15 a piece, $420 setup, 2.9% processing', function () {
  var r = M.compute({
    products: [{ name: 'Tee', made: 100, sellPct: 100, price: 48, blank: 8.25, decor: 9.4 }],
    labels: 1.5, packaging: 2, setup: 420, payPct: 2.9
  });
  near(r.revenue, 4800); near(r.production, 2115); near(r.processingFees, 139.2);
  near(r.grossProfit, 2685); near(r.grossMargin, 2685 / 4800);
  near(r.net, 2125.8); near(r.margin, 2125.8 / 4800); near(r.profitPerSold, 21.258);
  near(r.costPerMade, 21.15);
  /* K = 2115 + 420 = 2535, c = 48 x 0.971 = 46.608, 2535 / 46.608 = 54.39 */
  assert.strictEqual(r.breakEven.units, 55);
  assert.strictEqual(r.breakEven.status, 'ok');
  assert.ok(M.profitAtResult(r, 54) < 0 && M.profitAtResult(r, 55) >= 0);
});

test('every lever at once, worked by hand', function () {
  var r = M.compute({
    products: [{ name: 'Crew', made: 200, sellPct: 80, price: 60, blank: 10, decor: 5, wsUnits: 20, wsPrice: 25 }],
    labels: 1, packaging: 1.5, defectPct: 5,
    discountPct: 10, itemsPerOrder: 2, shipCharged: 8, shipCost: 9, shipMaterials: 1,
    payPct: 3, payFixed: 0.3, platformPct: 5, returnPct: 10, returnCost: 4, taxPct: 8,
    design: 200, samples: 100, setup: 50, photo: 150, ads: 300
  });
  assert.strictEqual(r.defects, 10); assert.strictEqual(r.sellable, 190);
  assert.strictEqual(r.sold, 152); assert.strictEqual(r.wsUnits, 20); assert.strictEqual(r.retailUnits, 132);
  near(r.orders, 66);
  near(r.grossSales, 7920); near(r.discounts, 792); near(r.refunds, 712.8);
  near(r.shippingIncome, 528); near(r.wholesaleRevenue, 500);
  near(r.revenue, 7443.2);
  near(r.production, 3500); near(r.grossProfit, 3943.2);
  near(r.processingFees, 266.5872); near(r.platformFees, 347.16);
  near(r.postage, 594); near(r.materials, 66); near(r.returnHandling, 52.8);
  near(r.selling, 1326.5472);
  near(r.fixed, 800); near(r.overhead, 350); near(r.marketing, 450);
  near(r.net, 1816.6528); near(r.margin, 1816.6528 / 7443.2);
  near(r.taxCollected, 513.216);
  near(r.defectValue, 175); near(r.unsoldValue, 665);
  near(r.rows[0].unit.contribution, 42.5504);
  near(r.breakEven.contribution, 6116.6528 / 152); near(r.breakEven.fixedTotal, 4300);
  assert.strictEqual(r.breakEven.units, 107);
  near(M.profitAtResult(r, r.sold), r.net);
});

test('two products: totals are the sum of the rows', function () {
  var r = M.compute({
    products: [
      { made: 10, sellPct: 100, price: 20, blank: 5 },
      { made: 20, sellPct: 50, price: 50, blank: 10, decor: 2 }
    ], setup: 100
  });
  near(r.revenue, 10 * 20 + 10 * 50); near(r.production, 50 + 240);
  near(r.net, 700 - 290 - 100); assert.strictEqual(r.sold, 20); assert.strictEqual(r.unsold, 10);
  /* c = 700 / 20 = 35, K = 390, 390 / 35 = 11.14 */
  assert.strictEqual(r.breakEven.units, 12);
});

/* ---------- the two audited examples -------------------------------------- */
var OLD_TEE = {
  products: [{ name: 'Essential Tee', made: 100, sellPct: 75, price: 38, blank: 8.5 }],
  labels: 0.75, packaging: 1.5, samples: 50, setup: 75, shipCost: 5.5, shipMaterials: 1.25,
  payPct: 2.9, payFixed: 0.3, ads: 300, seeding: 100, photo: 150
};
var OLD_HOODIE = {
  products: [{ name: 'Heavyweight Hoodie', made: 50, sellPct: 76, price: 75, blank: 22 }],
  labels: 1, packaging: 2, samples: 80, setup: 100, shipCost: 7.5, shipMaterials: 2,
  payPct: 2.9, payFixed: 0.3, ads: 500, seeding: 200, photo: 250
};
test('audited T-shirt example: break-even is 59, not 38', function () {
  var r = M.compute(OLD_TEE);
  assert.strictEqual(r.sold, 75);
  near(r.breakEven.fixedTotal, 1750); near(r.breakEven.contribution, 29.848);
  assert.strictEqual(r.breakEven.units, 59);
  near(M.profitAt(OLD_TEE, 38), -615.776, 1e-6);          /* the old page called 38 break-even */
  assert.ok(M.profitAt(OLD_TEE, 58) < 0 && M.profitAt(OLD_TEE, 59) >= 0);
  near(r.net, 75 * 29.848 - 1750);
  assert.strictEqual(bruteBreakEven(r, 1000), 59);
});
test('audited Hoodie example: break-even is 38, not 33', function () {
  var r = M.compute(OLD_HOODIE);
  assert.strictEqual(r.sold, 38);
  near(r.breakEven.fixedTotal, 2380); near(r.breakEven.contribution, 63.025);
  assert.strictEqual(r.breakEven.units, 38);
  near(M.profitAt(OLD_HOODIE, 33), -300.175, 1e-6);
  assert.strictEqual(bruteBreakEven(r, 1000), 38);
});
test('a loss never reports a met break-even', function () {
  var x = JSON.parse(JSON.stringify(OLD_TEE)); x.products[0].sellPct = 40;
  var r = M.compute(x);
  assert.ok(r.net < 0); assert.strictEqual(r.breakEven.units, 59); assert.strictEqual(r.breakEven.status, 'above-plan');
  var rng1 = rng(7);
  for (var i = 0; i < 2000; i++) {
    var rr = M.compute(randomInputs(rng1));
    if (rr.breakEven.status === 'ok') assert.ok(cents(rr.net) >= 0, 'status ok with net ' + rr.net);
    if (cents(rr.net) < 0) assert.notStrictEqual(rr.breakEven.status, 'ok');
  }
});

/* ---------- shipped examples ---------------------------------------------- */
test('every shipped example ends in profit and breaks even inside its plan', function () {
  Object.keys(M.EXAMPLES).forEach(function (key) {
    var x = M.example(key), r = M.compute(x);
    assert.ok(r.net > 0, key + ' net ' + r.net);
    assert.ok(r.margin > 0.05 && r.margin < 0.6, key + ' margin ' + r.margin);
    assert.strictEqual(r.breakEven.status, 'ok', key + ' status');
    assert.ok(r.breakEven.units <= r.sold, key);
    assert.strictEqual(bruteBreakEven(r, 5000), r.breakEven.units, key);
    assert.deepStrictEqual(M.sanitizeInputs(x), x, key + ' is already clean');
    console.log('     ' + key + ': net ' + r.net.toFixed(2) + ', margin ' + (r.margin * 100).toFixed(1) + '%, break-even ' + r.breakEven.units + ' of ' + r.sold + ' sold');
  });
  assert.strictEqual(M.example('nope'), null);
  assert.strictEqual(M.example('constructor'), null);
});

/* ---------- audited defects ----------------------------------------------- */
test('defects are not charged twice', function () {
  var base = { products: [{ made: 100, sellPct: 100, price: 30, blank: 10 }] };
  var a = M.compute(base);
  var b = M.compute({ products: base.products, defectPct: 10 });
  near(a.production, 1000); near(b.production, 1000);                 /* cost is the pieces made, once */
  assert.strictEqual(b.defects, 10); assert.strictEqual(b.sold, 90);
  near(a.net - b.net, 10 * 30);                                       /* the only loss is the lost sales */
  near(b.totalCosts, 1000);
});
test('returns reduce revenue', function () {
  var base = { products: [{ made: 100, sellPct: 100, price: 40, blank: 10 }], returnPct: 10, returnCost: 2 };
  var r = M.compute(base);
  near(r.grossSales, 4000); near(r.refunds, 400); near(r.revenue, 3600);
  near(r.returnHandling, 20); near(r.returnedUnits, 10);
  near(r.net, 3600 - 1000 - 20);
});
test('blank and decoration exist once per product and are counted once', function () {
  var r = M.compute({ products: [{ made: 100, sellPct: 100, price: 30, blank: 8, decor: 4 }], costBlank: 8, costDecoration: 4, blank: 8, decor: 4 });
  near(r.production, 1200); near(r.blankCost, 800); near(r.decorCost, 400);
});
test('sales tax is passed on: never revenue, never profit', function () {
  var base = { products: [{ made: 50, sellPct: 100, price: 40, blank: 10 }], shipCharged: 5, shipCost: 5 };
  var a = M.compute(base);
  var b = M.compute(Object.assign({ taxPct: 10 }, base));
  near(b.revenue, a.revenue); near(b.net, a.net); near(b.taxCollected, 200); near(a.taxCollected, 0);
  var c = M.compute(Object.assign({ taxPct: 10, payPct: 3 }, base));
  var d = M.compute(Object.assign({ payPct: 3 }, base));
  near(d.net - c.net, 50 * 4 * 0.03);                                 /* only the processing fee on the tax */
  near(c.revenue, d.revenue);
});
test('shipping charged versus shipping cost, per order', function () {
  var r = M.compute({ products: [{ made: 60, sellPct: 100, price: 20, blank: 5 }], itemsPerOrder: 3, shipCharged: 6, shipCost: 9, shipMaterials: 1.5, payFixed: 0.3 });
  near(r.orders, 20); near(r.shippingIncome, 120); near(r.postage, 180); near(r.materials, 30); near(r.processingFees, 6);
  near(r.net, 1200 + 120 - 300 - 180 - 30 - 6);
});
test('discounts and platform fees', function () {
  var r = M.compute({ products: [{ made: 10, sellPct: 100, price: 100, blank: 20 }], discountPct: 20, platformPct: 10 });
  near(r.discounts, 200); near(r.revenue, 800); near(r.platformFees, 80); near(r.net, 800 - 200 - 80);
});
test('wholesale pieces cannot exceed pieces sold', function () {
  var r = M.compute({ products: [{ made: 10, sellPct: 50, price: 30, blank: 5, wsUnits: 99, wsPrice: 12 }] });
  assert.strictEqual(r.sold, 5); assert.strictEqual(r.wsUnits, 5); assert.strictEqual(r.retailUnits, 0);
  assert.strictEqual(r.rows[0].wsClamped, true); near(r.revenue, 60);
});

/* ---------- break-even ------------------------------------------------------ */
test('never breaks even when a sale leaves nothing or less', function () {
  var zero = M.compute({ products: [{ made: 50, sellPct: 100, price: 10, blank: 4 }], shipCost: 10 });
  near(zero.breakEven.contribution, 0);
  assert.strictEqual(zero.breakEven.units, null); assert.strictEqual(zero.breakEven.status, 'never');
  var neg = M.compute({ products: [{ made: 50, sellPct: 100, price: 10, blank: 4 }], shipCost: 14, setup: 100 });
  assert.ok(neg.breakEven.contribution < 0);
  assert.strictEqual(neg.breakEven.units, null); assert.strictEqual(neg.breakEven.status, 'never');
  assert.strictEqual(bruteBreakEven(neg, 20000), null);
  var free = M.compute({ products: [{ made: 50, sellPct: 100, price: 0, blank: 4 }] });
  assert.strictEqual(free.breakEven.status, 'never');
});
test('break-even statuses: nothing to pay back, beyond stock, no pieces, all defective', function () {
  var none = M.compute({ products: [{ made: 10, sellPct: 100, price: 10 }] });
  assert.strictEqual(none.breakEven.units, 0); assert.strictEqual(none.breakEven.status, 'ok');
  var beyond = M.compute({ products: [{ made: 10, sellPct: 100, price: 10, blank: 1 }], setup: 500 });
  assert.strictEqual(beyond.breakEven.units, 51); assert.strictEqual(beyond.breakEven.status, 'beyond-stock');
  assert.ok(beyond.net < 0);
  var empty = M.compute({ setup: 100 });
  assert.strictEqual(empty.breakEven.units, null); assert.strictEqual(empty.breakEven.status, 'no-units');
  var blank = M.compute({});
  assert.strictEqual(blank.breakEven.units, 0); near(blank.net, 0); assert.strictEqual(blank.margin, null);
  var allBad = M.compute({ products: [{ made: 10, sellPct: 100, price: 10, blank: 1 }], defectPct: 100 });
  /* one sale would cover the $10 spent, but there is nothing sellable to sell */
  assert.strictEqual(allBad.sellable, 0); assert.strictEqual(allBad.breakEven.units, 1); assert.strictEqual(allBad.breakEven.status, 'beyond-stock');
  assert.ok(allBad.net < 0);
  var allBadLoss = M.compute({ products: [{ made: 10, sellPct: 100, price: 10, blank: 1 }], defectPct: 100, shipCost: 20 });
  assert.strictEqual(allBadLoss.breakEven.units, null); assert.strictEqual(allBadLoss.breakEven.status, 'no-stock');
  var unplanned = M.compute({ products: [{ made: 100, sellPct: 0, price: 20, blank: 5 }] });
  assert.strictEqual(unplanned.sold, 0); assert.strictEqual(unplanned.breakEven.units, 25); assert.strictEqual(unplanned.breakEven.status, 'above-plan');
});
test('breakEvenUnits is exact at the boundary', function () {
  assert.strictEqual(M.breakEvenUnits(10, 100), 10);
  assert.strictEqual(M.breakEvenUnits(10, 100.01), 11);
  assert.strictEqual(M.breakEvenUnits(10, 100.004), 10);        /* under half a cent short still rounds to zero */
  assert.strictEqual(M.breakEvenUnits(0.1, 0.3), 3);            /* 0.1 x 3 is 0.30000000000000004 */
  assert.strictEqual(M.breakEvenUnits(5, 0), 0);
  assert.strictEqual(M.breakEvenUnits(0, 1), null);
  assert.strictEqual(M.breakEvenUnits(-3, 1), null);
  assert.strictEqual(M.breakEvenUnits(-3, 0), 0);
});

function randomInputs(r) {
  var pick = function (max, dp) { var f = Math.pow(10, dp == null ? 2 : dp); return Math.round(r() * max * f) / f; };
  var maybe = function (p, max, dp) { return r() < p ? pick(max, dp) : 0; };
  var n = 1 + Math.floor(r() * 4), products = [];
  for (var i = 0; i < n; i++) {
    products.push({
      name: 'P' + i, made: Math.floor(r() * 400), sellPct: pick(100, 0), price: pick(120),
      blank: pick(25), decor: maybe(0.7, 12), wsUnits: r() < 0.3 ? Math.floor(r() * 80) : 0, wsPrice: pick(40)
    });
  }
  return {
    name: 'Random', products: products,
    labels: maybe(0.6, 2), packaging: maybe(0.6, 3), defectPct: maybe(0.5, 15, 1),
    discountPct: maybe(0.5, 40, 1), itemsPerOrder: r() < 0.5 ? 1 : 1 + pick(3, 1), shipCharged: maybe(0.5, 12),
    shipCost: maybe(0.8, 15), shipMaterials: maybe(0.6, 3),
    payPct: maybe(0.9, 6, 1), payFixed: maybe(0.8, 0.5), platformPct: maybe(0.4, 20, 1),
    returnPct: maybe(0.5, 30, 1), returnCost: maybe(0.5, 8), taxPct: maybe(0.3, 12, 1),
    design: maybe(0.3, 500), samples: maybe(0.5, 300), setup: maybe(0.5, 300), photo: maybe(0.4, 500),
    ads: maybe(0.5, 2000), seeding: maybe(0.3, 500), otherMarketing: maybe(0.2, 300),
    workspace: maybe(0.2, 300), software: maybe(0.2, 100), otherFixed: maybe(0.2, 300)
  };
}

test('break-even agrees with brute force over 4,000 random drops', function () {
  var r = rng(20261112), counts = { ok: 0, 'above-plan': 0, 'beyond-stock': 0, never: 0, 'no-units': 0, 'no-stock': 0 };
  for (var i = 0; i < 4000; i++) {
    var x = randomInputs(r), res = M.compute(x), be = res.breakEven;
    counts[be.status]++;
    assertAllFinite(res, 'result');
    if (res.sold > 0) near(M.profitAtResult(res, res.sold), res.net, 1e-6, 'profit at planned sales');
    near(res.net, res.grossProfit - res.selling - res.fixed, 1e-6, 'net identity');
    near(res.revenue - res.totalCosts, res.net, 1e-6, 'revenue minus costs');
    assert.ok(res.sold <= res.sellable && res.sellable <= res.made && res.wsUnits <= res.sold);
    if (be.units === null) {
      assert.ok(!(be.contribution > 0), 'null with positive contribution ' + JSON.stringify(x));
      assert.strictEqual(bruteBreakEven(res, 3000), null);
    } else {
      assert.ok(Number.isInteger(be.units) && be.units >= 0);
      assert.ok(cents(M.profitAtResult(res, be.units)) >= 0, 'profit at break-even is negative');
      if (be.units > 0) assert.ok(cents(M.profitAtResult(res, be.units - 1)) < 0, 'one fewer already breaks even');
      if (be.units <= 20000) assert.strictEqual(bruteBreakEven(res, be.units + 5), be.units, JSON.stringify(x));
    }
  }
  console.log('     statuses seen: ' + JSON.stringify(counts));
  assert.ok(counts.ok > 100 && counts['above-plan'] > 100 && counts['beyond-stock'] > 100 && counts.never > 10);
});

/* ---------- reverse helpers ------------------------------------------------ */
test('what if I sell N matches the full model', function () {
  var x = { products: [{ made: 100, sellPct: 75, price: 38, blank: 8.5 }], labels: 0.75, packaging: 1.5, shipCost: 5.5, payPct: 2.9, payFixed: 0.3, setup: 400, returnPct: 5 };
  [0, 1, 37, 60, 100].forEach(function (n) {
    var y = JSON.parse(JSON.stringify(x)); y.products[0].sellPct = n;
    var full = M.compute(y), w = M.whatIf(x, n);
    near(w.net, full.net, 1e-6, 'net at ' + n); near(w.revenue, full.revenue, 1e-6, 'revenue at ' + n);
    assert.strictEqual(w.exceedsStock, false);
  });
  var over = M.whatIf(x, 150);
  assert.strictEqual(over.exceedsStock, true); assert.strictEqual(over.units, 150);
  assert.strictEqual(M.whatIf(x, 'abc').units, 0);
  assert.strictEqual(M.whatIf(x, -5).units, 0);
  assert.strictEqual(M.whatIf({}, 5).hasStock, false);
});
test('price for a target margin: plugging the price back in gives the margin', function () {
  var x = { products: [{ made: 100, sellPct: 75, price: 38, blank: 8.5 }], labels: 0.75, packaging: 1.5, shipCost: 5.5, shipMaterials: 1.25, payPct: 2.9, payFixed: 0.3, samples: 50, setup: 75, ads: 550 };
  [0, 10, 25, 40, 60].forEach(function (t) {
    var res = M.priceForMargin(x, t);
    assert.ok(res.status === 'ok' || res.status === 'already', 'status at ' + t + ': ' + res.status);
    var y = JSON.parse(JSON.stringify(x)); y.products[0].price = res.prices[0].price;
    var at = M.compute(y);
    assert.ok(at.margin >= t / 100 - 1e-9, 'margin ' + at.margin + ' below ' + t);
    near(at.margin, res.margin, 1e-12);
    y.products[0].price = Math.round((res.prices[0].price - 0.01) * 100) / 100;
    assert.ok(M.compute(y).margin < t / 100, 'a cent less should miss ' + t + '%');
  });
  /* by hand: no fees, 100 made and sold, cost 10 each, fixed 0: 50% margin needs $20 */
  var simple = M.priceForMargin({ products: [{ made: 100, sellPct: 100, price: 5, blank: 10 }] }, 50);
  near(simple.prices[0].price, 20); near(simple.margin, 0.5);
  assert.strictEqual(M.priceForMargin({ products: [{ made: 100, sellPct: 100, price: 30, blank: 10 }] }, 50).status, 'already');
});
test('price for a target margin: unreachable, no retail, invalid, no price yet', function () {
  var heavy = { products: [{ made: 10, sellPct: 100, price: 20, blank: 5 }], platformPct: 40, payPct: 5 };
  var u = M.priceForMargin(heavy, 60);
  assert.strictEqual(u.status, 'unreachable'); near(u.ceiling, 0.55);
  assert.strictEqual(M.priceForMargin(heavy, 50).status, 'ok');
  assert.strictEqual(M.priceForMargin({ products: [{ made: 10, sellPct: 100, price: 20, wsUnits: 10, wsPrice: 9 }] }, 30).status, 'no-retail');
  assert.strictEqual(M.priceForMargin({}, 30).status, 'no-retail');
  ['', null, 'abc', -5, 100, 250, NaN].forEach(function (t) { assert.strictEqual(M.priceForMargin(heavy, t).status, 'invalid', String(t)); });
  var unpriced = M.priceForMargin({ products: [{ made: 10, sellPct: 100, price: 0, blank: 5 }, { made: 10, sellPct: 100, price: 0, blank: 5 }] }, 50);
  assert.strictEqual(unpriced.status, 'ok'); assert.strictEqual(unpriced.uniform, true);
  near(unpriced.prices[0].price, 10); near(unpriced.prices[1].price, 10);
});
test('price for a target margin over random drops', function () {
  var r = rng(99), okCount = 0;
  for (var i = 0; i < 1500; i++) {
    var x = randomInputs(r), t = Math.floor(r() * 70), res = M.priceForMargin(x, t);
    assertAllFinite(res, 'priceForMargin');
    if (res.status !== 'ok' && res.status !== 'already') continue;
    okCount++;
    var y = M.sanitizeInputs(x);
    res.prices.forEach(function (p, k) { y.products[k].price = p.price; });
    var at = M.compute(y);
    assert.ok(at.margin !== null && at.margin >= t / 100 - 1e-9, 'target ' + t + ' got ' + at.margin + ' ' + JSON.stringify(x));
  }
  assert.ok(okCount > 500, 'only ' + okCount + ' solvable');
});

/* ---------- hostile input --------------------------------------------------- */
test('hostile input never produces NaN or throws', function () {
  var circular = {}; circular.self = circular; circular.products = [circular];
  var nasty = [
    undefined, null, 0, 1, '', 'abc', true, [], [1, 2], function () {}, NaN, Infinity, circular,
    { products: 'abc' }, { products: null }, { products: {} }, { products: [null, undefined, 5, 'x', [], {}] },
    { products: [{ made: 'abc', sellPct: 1e9, price: -5, blank: NaN, decor: Infinity, wsUnits: -Infinity, wsPrice: {} }] },
    { products: [{ made: '1e400', price: '--5', blank: '1,000', decor: '$4', sellPct: '50%' }] },
    { products: [{ made: 12.7, sellPct: 33.333, price: 19.999 }], itemsPerOrder: 0, payPct: -1, defectPct: 1000 },
    { itemsPerOrder: -3 }, { itemsPerOrder: 'abc' }, { itemsPerOrder: 1e9 }, { itemsPerOrder: 0.0001 },
    { name: { toString: function () { throw new Error('no'); } }, labels: [], packaging: {}, setup: '  12  ', ads: '\t' },
    JSON.parse('{"__proto__": {"labels": 5}, "products": [{"__proto__": {"made": 5}}]}'),
    { products: new Array(500).fill({ made: 1e308, price: 1e308, sellPct: 100, blank: 1e308 }) }
  ];
  nasty.forEach(function (x, i) {
    var clean = M.sanitizeInputs(x);
    assertAllFinite(clean, 'sanitize#' + i);
    assert.ok(clean.products.length >= 1 && clean.products.length <= M.LIMITS.products);
    assert.ok(clean.itemsPerOrder >= 1 && clean.itemsPerOrder <= 100);
    assert.deepStrictEqual(M.sanitizeInputs(clean), clean, 'idempotent #' + i);
    var r = M.compute(x);
    assertAllFinite(r, 'compute#' + i);
    assertAllFinite(M.whatIf(x, 'x'), 'whatIf#' + i);
    assertAllFinite(M.priceForMargin(x, 30), 'priceForMargin#' + i);
    assert.ok(typeof M.buildCsv(x, 'today') === 'string');
  });
});
test('number parsing and range checks', function () {
  assert.strictEqual(M.parseNumber(''), 0); assert.strictEqual(M.parseNumber('   '), 0); assert.strictEqual(M.parseNumber(null), 0);
  assert.strictEqual(M.parseNumber(' 12.50 '), 12.5); assert.strictEqual(M.parseNumber('.5'), 0.5);
  assert.ok(isNaN(M.parseNumber('abc'))); assert.ok(isNaN(M.parseNumber('1,000'))); assert.ok(isNaN(M.parseNumber('0x10'))); assert.ok(isNaN(M.parseNumber({})));
  assert.deepStrictEqual(M.check('', 'money'), { value: 0, issue: null });
  assert.deepStrictEqual(M.check('-4', 'money'), { value: 0, issue: 'negative' });
  assert.deepStrictEqual(M.check('abc', 'pct'), { value: 0, issue: 'nan' });
  assert.deepStrictEqual(M.check(140, 'pct'), { value: 100, issue: 'max' });
  assert.deepStrictEqual(M.check('12.7', 'units'), { value: 12, issue: 'fraction' });
  assert.deepStrictEqual(M.check('', 'perOrder'), { value: 1, issue: null });
  assert.deepStrictEqual(M.check(0, 'perOrder'), { value: 1, issue: 'min' });
  assert.deepStrictEqual(M.check(-0, 'money'), { value: 0, issue: null });
  assert.ok(Object.is(M.check(-0, 'money').value, 0));
  assert.deepStrictEqual(M.check(Infinity, 'money'), { value: 0, issue: 'nan' });
  assert.deepStrictEqual(M.check(1e12, 'money'), { value: 1e6, issue: 'max' });
});

/* ---------- storage --------------------------------------------------------- */
test('corrupt or foreign drafts are refused without throwing', function () {
  [undefined, null, 5, 'x', [], [1], {}, { inputs: null }, { inputs: 'x' }, { inputs: [] }, { v: 2 }, { products: [] }].forEach(function (raw) {
    assert.strictEqual(M.sanitizeDraft(raw), null, JSON.stringify(raw));
  });
  var ok = M.sanitizeDraft({ v: 2, inputs: { name: '<img src=x onerror=1>', products: [{ made: '7' }], setup: 'NaN' }, helpers: { targetPct: 'zz', sellN: -4 } });
  assert.strictEqual(ok.legacy, false); assert.strictEqual(ok.inputs.products[0].made, 7); assert.strictEqual(ok.inputs.setup, 0);
  assert.strictEqual(ok.inputs.name, '<img src=x onerror=1>');      /* kept as text; the page only ever uses textContent */
  assert.deepStrictEqual(ok.helpers, { targetPct: 0, sellN: 0 });
  assert.deepStrictEqual(M.sanitizeHelpers(null), { targetPct: 30, sellN: null });
});
test('a draft from the old page is carried over, without the doubled blank cost', function () {
  var legacy = {
    inputs: { dropName: 'Summer Tee Drop', skuCount: '1', costBlank: '', costDecoration: '', costPackaging: '1.50', costLabels: '0.75',
      costSamples: '50', costSetup: '75', costShipping: '5.50', costPackMaterials: '1.25', feePlatformPct: '2.9', feePlatformFixed: '0.30',
      feeMarketplace: '', costAds: '300', costInfluencer: '100', costContent: '150', costOtherMarketing: '', costRent: '', costSoftware: '',
      costOtherOverhead: '', returnRate: '5', defectRate: '2', costRestock: '3' },
    products: [{ name: 'Essential Tee', unitsProduced: 100, unitsSold: 75, unitCost: 8.5, retailPrice: 38, wholesalePrice: 19, wholesaleUnits: 10, expanded: true }]
  };
  var d = M.sanitizeDraft(legacy);
  assert.strictEqual(d.legacy, true);
  var x = d.inputs, p = x.products[0];
  assert.strictEqual(x.name, 'Summer Tee Drop');
  assert.deepStrictEqual([p.made, p.sellPct, p.price, p.blank, p.decor, p.wsUnits, p.wsPrice], [100, 75, 38, 8.5, 0, 10, 19]);
  assert.deepStrictEqual([x.labels, x.packaging, x.shipCost, x.shipMaterials, x.payPct, x.payFixed, x.returnPct, x.defectPct, x.returnCost],
    [0.75, 1.5, 5.5, 1.25, 2.9, 0.3, 5, 2, 3]);
  assert.deepStrictEqual([x.samples, x.setup, x.ads, x.seeding, x.photo], [50, 75, 300, 100, 150]);
  assert.strictEqual(x.itemsPerOrder, 1);
  assertAllFinite(M.compute(x), 'legacy result');
  var broken = M.sanitizeDraft({ inputs: { dropName: 5, costAds: 'abc' }, products: [null, 'x', { unitsProduced: 'q', unitsSold: 5 }] });
  assert.strictEqual(broken.legacy, true); assertAllFinite(broken.inputs, 'broken legacy');
});
test('saved scenarios: malformed lists and entries are dropped, not thrown on', function () {
  [undefined, null].forEach(function (raw) { assert.deepStrictEqual(M.sanitizeScenarios(raw), { list: [], dropped: 0 }); });
  [5, 'x', {}, { length: 3 }, true].forEach(function (raw) {
    var s = M.sanitizeScenarios(raw); assert.deepStrictEqual(s.list, []); assert.strictEqual(s.dropped, 1);
  });
  var mixed = M.sanitizeScenarios([
    null, 'x', 7, [], {},
    { name: 'Old results only', data: { netProfit: 5 }, timestamp: 1 },          /* shape the old page wrote */
    { name: '  Good   one ', savedAt: 123, id: 'abc', inputs: { products: [{ made: 5, price: 'zz' }] } },
    { name: '', inputs: {} },
    { id: 'abc', name: 'Duplicate id', inputs: { setup: 5 } },
    { id: '<b>', name: 42, inputs: { setup: 5 }, savedAt: 'never' }
  ]);
  assert.strictEqual(mixed.dropped, 6); assert.strictEqual(mixed.list.length, 4);
  assert.strictEqual(mixed.list[0].name, 'Good one'); assert.strictEqual(mixed.list[0].id, 'abc'); assert.strictEqual(mixed.list[0].savedAt, 123);
  assert.strictEqual(mixed.list[0].inputs.products[0].price, 0);
  assert.strictEqual(mixed.list[1].name, 'Scenario 2');
  var ids = mixed.list.map(function (s) { return s.id; });
  assert.strictEqual(new Set(ids).size, ids.length, 'ids are unique');
  ids.forEach(function (id) { assert.ok(/^[a-z0-9-]+$/i.test(id), id); });
  assert.strictEqual(mixed.list[3].savedAt, 0);
  mixed.list.forEach(function (s) { assertAllFinite(M.compute(s.inputs), 'scenario'); });
  var many = [];
  for (var i = 0; i < 30; i++) many.push({ name: 'S' + i, inputs: {} });
  assert.strictEqual(M.sanitizeScenarios(many).list.length, M.LIMITS.scenarios);
});

/* ---------- CSV ------------------------------------------------------------- */
test('CSV: every cell quoted, quotes doubled, formulas disarmed, CRLF rows', function () {
  assert.strictEqual(M.csvCell('a,b'), '"a,b"');
  assert.strictEqual(M.csvCell('say "hi"'), '"say ""hi"""');
  assert.strictEqual(M.csvCell('=SUM(A1)'), '"\'=SUM(A1)"');
  assert.strictEqual(M.csvCell('+1'), '"\'+1"'); assert.strictEqual(M.csvCell('-1'), '"\'-1"'); assert.strictEqual(M.csvCell('@x'), '"\'@x"');
  assert.strictEqual(M.csvCell('\tx'), '"\'\tx"');
  assert.strictEqual(M.csvCell(-12.5), '"-12.5"');                   /* a number this file wrote stays a number */
  assert.strictEqual(M.csvCell(NaN), '""'); assert.strictEqual(M.csvCell(null), '""'); assert.strictEqual(M.csvCell(undefined), '""');
  var x = {
    name: '=HYPERLINK("http://x","click"), "Drop"',
    products: [{ name: 'Tee, "heavy"\nline two', made: 100, sellPct: 75, price: 38, blank: 8.5 }, { name: '@cmd', made: 5, sellPct: 100, price: 9 }],
    setup: 75, returnPct: 5, taxPct: 8
  };
  var csv = M.buildCsv(x, '2026-11-12');
  assert.ok(csv.slice(-2) === '\r\n');
  assert.ok(!/[^\r]\n/.test(csv), 'bare line feed');
  var rows = parseCsv(csv);
  var flat = rows.map(function (r) { return r.join('|'); });
  assert.strictEqual(rows[1][1], '\'=HYPERLINK("http://x","click"), "Drop"');
  var teeRow = rows.filter(function (r) { return r[0] === 'Tee, "heavy" line two'; })[0];
  assert.ok(teeRow, 'product row with commas and quotes survives a round trip');
  assert.strictEqual(teeRow[1], '100'); assert.strictEqual(teeRow[8], '38');
  assert.ok(rows.some(function (r) { return r[0] === "'@cmd"; }));
  var res = M.compute(x);
  var line = function (label) { return rows.filter(function (r) { return r[0] === label; })[0]; };
  assert.strictEqual(Number(line('Net profit')[1]), Math.round(res.net * 100) / 100);
  assert.strictEqual(Number(line('Revenue')[1]), Math.round(res.revenue * 100) / 100);
  assert.strictEqual(Number(line('Break-even')[1]), res.breakEven.units);
  assert.strictEqual(rows.filter(function (r) { return r[1] === 'Setup and digitizing'; })[0][2], '75');
  assert.ok(flat.indexOf('PRODUCTS') > 0 && flat.indexOf('INPUTS') > 0 && flat.indexOf('RESULTS (ESTIMATES)') > 0);
  var never = parseCsv(M.buildCsv({ products: [{ made: 5, sellPct: 100, price: 1, blank: 5 }], shipCost: 5 }));
  assert.strictEqual(never.filter(function (r) { return r[0] === 'Break-even'; })[0][1], 'Never breaks even');
  /* every input the model reads is in the export */
  Object.keys(M.FIELDS).forEach(function (k) {
    assert.ok(M.INPUT_GROUPS.some(function (g) { return g[1].some(function (f) { return f[0] === k; }); }), k + ' missing from INPUT_GROUPS');
  });
});
test('file names are safe', function () {
  assert.strictEqual(M.safeFilename('Summer Tee Drop'), 'summer-tee-drop-drop-calc');
  assert.strictEqual(M.safeFilename('../../etc/passwd'), 'etc-passwd-drop-calc');
  assert.strictEqual(M.safeFilename(''), 'drop-drop-calc');
  assert.strictEqual(M.safeFilename(null), 'drop-drop-calc');
  assert.strictEqual(M.safeFilename('a/b\\c:d*e?"f<g>h|i'), 'a-b-c-d-e-f-g-h-i-drop-calc');
  assert.ok(M.safeFilename(new Array(500).join('x')).length <= 60);
});
test('money rounds half a cent away from zero, the way a hand calculation does', function () {
  assert.strictEqual(M.roundCents(774.375), 774.38);     /* binary 774.37499..., was shown as 774.37 */
  assert.strictEqual(M.roundCents(1.005), 1.01);
  assert.strictEqual(M.roundCents(2.675), 2.68);
  assert.strictEqual(M.roundCents(0.125), 0.13);
  assert.strictEqual(M.roundCents(-774.375), -774.38);
  assert.strictEqual(M.roundCents(-0.005), -0.01);
  assert.strictEqual(M.roundCents(1.004), 1);
  assert.strictEqual(M.roundCents(1.0049999), 1);
  assert.strictEqual(M.roundCents(12.34), 12.34);
  assert.strictEqual(M.roundCents(0), 0);
  assert.ok(Object.is(M.roundCents(-0.001), 0), "a loss under half a cent is 0, not -0");
  assert.ok(Object.is(M.roundCents(-0), 0));
  assert.strictEqual(M.roundCents(NaN), 0);
  assert.strictEqual(M.roundCents(Infinity), 0);
  assert.strictEqual(M.roundCents(123456789.125), 123456789.13);
  /* whole cents are never moved */
  for (var c = -5000; c <= 5000; c++) assert.strictEqual(Math.round(M.roundCents(c / 100) * 100), c, c + " cents");
});
test('the export rounds half cents the same way as the page', function () {
  /* 31 pieces at 24.98 with a 12.5% discount: discounts are 96.7975, revenue 677.5825 */
  var x = { name: "Half cents", products: [{ made: 31, sellPct: 100, price: 24.98 }], discountPct: 12.5 };
  var res = M.compute(x);
  near(res.revenue, 677.5825, 1e-9, "revenue");
  var rows = parseCsv(M.buildCsv(x, "2026-11-12"));
  var amount = function (label) { return rows.filter(function (r) { return r[0] === label; })[0][1]; };
  assert.strictEqual(amount("Revenue"), String(M.roundCents(res.revenue)));
  assert.strictEqual(amount("Revenue"), "677.58");
  assert.strictEqual(amount("Discounts"), "-96.8");
  assert.strictEqual(amount("Net profit"), String(M.roundCents(res.net)));
});
test('the export says when break-even is past the plan or past the stock', function () {
  var unit = function (x) { return parseCsv(M.buildCsv(x)).filter(function (r) { return r[0] === "Break-even"; })[0]; };
  /* 30 made, 2 defective, 17 sold: needs 37 sales and only 28 can be sold */
  var loss = { products: [{ made: 30, sellPct: 60, price: 30, blank: 9, decor: 3.5 }], defectPct: 7, design: 384, ads: 100 };
  var a = M.compute(loss);
  assert.strictEqual(a.breakEven.status, "beyond-stock");
  assert.deepStrictEqual(unit(loss), ["Break-even", String(a.breakEven.units), "pieces sold (out of reach: " + a.sellable + " sellable)"]);
  /* same costs, more stock: reachable, but more than the plan */
  var stretch = { products: [{ made: 100, sellPct: 20, price: 30, blank: 9, decor: 3.5 }], design: 384, ads: 100 };
  var b = M.compute(stretch);
  assert.strictEqual(b.breakEven.status, "above-plan");
  assert.deepStrictEqual(unit(stretch), ["Break-even", String(b.breakEven.units), "pieces sold (plan is " + b.sold + ")"]);
  assert.strictEqual(unit(M.example("tshirt"))[2], "pieces sold");
});
test('a saved scenario is offered a name that is not taken', function () {
  assert.strictEqual(M.scenarioName("Summer tee drop", []), "Summer tee drop");
  assert.strictEqual(M.scenarioName("Summer tee drop", ["Summer tee drop"]), "Summer tee drop 2");
  assert.strictEqual(M.scenarioName("Summer tee drop", ["summer TEE drop", "Summer tee drop 2"]), "Summer tee drop 3");
  assert.strictEqual(M.scenarioName("  Summer   tee drop ", ["Other"]), "Summer tee drop");
  assert.strictEqual(M.scenarioName("", []), "Scenario 1");
  assert.strictEqual(M.scenarioName(null, ["Scenario 1", "scenario 2"]), "Scenario 3");
  assert.strictEqual(M.scenarioName("A", null), "A");
  assert.strictEqual(M.scenarioName("A", [null, 7, "A"]), "A 2");
  /* a name at the length limit still gets a number and still fits */
  var long = new Array(M.LIMITS.name + 1).join("x");
  var next = M.scenarioName(long, [long]);
  assert.ok(next.length <= M.LIMITS.name, "fits the limit: " + next.length);
  assert.ok(/ 2$/.test(next) && next !== long);
  /* eight saves in a row give eight different names */
  var taken = [];
  for (var i = 0; i < 8; i++) taken.push(M.scenarioName("Drop", taken));
  assert.strictEqual(taken.filter(function (n, k) { return taken.indexOf(n) === k; }).length, 8);
  assert.deepStrictEqual(taken.slice(0, 3), ["Drop", "Drop 2", "Drop 3"]);
});
test('loading in node does not touch the DOM', function () {
  assert.strictEqual(typeof window, 'undefined'); assert.strictEqual(typeof document, 'undefined');
  assert.strictEqual(typeof M.compute, 'function');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
