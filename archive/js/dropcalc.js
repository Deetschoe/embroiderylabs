/* ==========================================================================
   EMBROIDERY LABS - js/dropcalc.js (dropcalc.html only)
   Part 1 is the model: pure functions, no DOM, also loadable in node
   (tests/dropcalc.test.js). Part 2 is the page and only runs in a browser.

   THE MODEL. Every figure is an estimate for one drop, in cash terms.

   Per product i
     defects_i  = round(made_i x defect%)          cannot be sold; their cost is
     sellable_i = made_i - defects_i               already in production, so it is
     sold_i     = round(sellable_i x sellThrough_i%)          never charged twice
     ws_i       = min(wholesale pieces_i, sold_i)  retail_i = sold_i - ws_i

   One retail piece (q = pieces per order, so a per-order amount counts 1/q)
     paid       = price x (1 - discount%)
     revenue    = paid x (1 - return%) + shipping charged / q
                  (a return refunds the piece, not the shipping)
     processing = (paid + tax + shipping charged / q) x processing% + fixed fee / q
                  (charged at checkout and not handed back on a refund)
     platform   = (paid x (1 - return%) + shipping charged / q) x platform%
     fulfilment = (postage + shipping materials) / q
     returns    = return% x cost to handle one return
     contribution = revenue - processing - platform - fulfilment - returns
   One wholesale piece: contribution = wholesale price (no fees, freight on buyer).
   Tax collected = paid x tax% x (1 - return%). It is passed on, so it is shown
   but is never part of revenue or profit.

   Whole drop
     revenue      = sum of retail and wholesale revenue
     COGS         = sum made_i x (blank_i + decoration_i + labels + packaging)
                    every piece made, sold or not: the money is spent either way
     gross profit = revenue - COGS
     selling      = fulfilment + processing + platform + returns handling
     one-time     = design + samples + setup + photography + marketing + overhead
     net profit   = gross profit - selling - one-time
     margin       = net profit / revenue          (n/a when revenue is 0)

   Break-even. K = COGS + one-time is spent before the first sale. Selling n
   pieces at the planned mix earns profit(n) = n x c - K, where c is the average
   contribution per piece sold. Break-even is the smallest whole n >= 0 with
   profit(n) >= 0 to the cent. If K > 0 and c <= 0 it never breaks even.
   ========================================================================== */
(function () {
  'use strict';

  /* ======================================================================
     PART 1 - MODEL
     ====================================================================== */
  var LIMITS = { money: 1e6, units: 1e6, pct: 100, perOrder: 100, products: 20, scenarios: 8, name: 60 };

  /* field -> kind. Kinds: money (>= 0), pct (0..100), units (whole, >= 0), perOrder (1..100). */
  var FIELDS = {
    labels: 'money', packaging: 'money', defectPct: 'pct',
    discountPct: 'pct', itemsPerOrder: 'perOrder', shipCharged: 'money', shipCost: 'money', shipMaterials: 'money',
    payPct: 'pct', payFixed: 'money', platformPct: 'pct', returnPct: 'pct', returnCost: 'money', taxPct: 'pct',
    design: 'money', samples: 'money', setup: 'money', photo: 'money',
    ads: 'money', seeding: 'money', otherMarketing: 'money',
    workspace: 'money', software: 'money', otherFixed: 'money'
  };
  var PRODUCT_FIELDS = { made: 'units', sellPct: 'pct', price: 'money', blank: 'money', decor: 'money', wsUnits: 'units', wsPrice: 'money' };
  var OVERHEAD_KEYS = ['design', 'samples', 'setup', 'workspace', 'software', 'otherFixed'];
  var MARKETING_KEYS = ['photo', 'ads', 'seeding', 'otherMarketing'];

  /* Labels shared by the CSV export, the print sheet and the comparison table. */
  var INPUT_GROUPS = [
    ['Making it', [
      ['labels', 'Labels and tags, per piece'], ['packaging', 'Packaging, per piece'], ['defectPct', 'Defect rate']]],
    ['Selling it', [
      ['discountPct', 'Average discount'], ['itemsPerOrder', 'Pieces per order'], ['shipCharged', 'Shipping you charge, per order'],
      ['shipCost', 'Postage you pay, per order'], ['shipMaterials', 'Shipping materials, per order'],
      ['payPct', 'Payment processing'], ['payFixed', 'Payment fee, per order'], ['platformPct', 'Platform fee'],
      ['returnPct', 'Return rate'], ['returnCost', 'Cost to handle one return'], ['taxPct', 'Sales tax collected']]],
    ['One-time costs', [
      ['design', 'Design'], ['samples', 'Samples'], ['setup', 'Setup and digitizing'], ['photo', 'Photography and content'],
      ['ads', 'Ads'], ['seeding', 'Seeding and influencers'], ['otherMarketing', 'Other marketing'],
      ['workspace', 'Workspace'], ['software', 'Software'], ['otherFixed', 'Other']]]
  ];

  var NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

  /* Anything -> number. Empty and missing are zero. Unreadable is NaN. */
  function parseNumber(v) {
    if (typeof v === 'number') return v;
    if (v == null) return 0;
    if (typeof v === 'string') {
      var s = v.trim();
      if (s === '') return 0;
      return NUM_RE.test(s) ? Number(s) : NaN;
    }
    return NaN;
  }
  function isEmpty(v) { return v == null || (typeof v === 'string' && v.trim() === ''); }

  /* Clamp one value to its kind. issue: null | 'nan' | 'negative' | 'min' | 'max' | 'fraction'. */
  function check(v, kind) {
    var min = kind === 'perOrder' ? 1 : 0;
    var max = LIMITS[kind] || LIMITS.money;
    if (kind === 'perOrder' && isEmpty(v)) return { value: 1, issue: null };
    var n = parseNumber(v), issue = null;
    if (!isFinite(n)) return { value: min, issue: 'nan' };
    if (n < min) return { value: min, issue: min === 0 ? 'negative' : 'min' };
    if (n > max) { n = max; issue = 'max'; }
    if (kind === 'units' && n !== Math.floor(n)) { n = Math.floor(n); issue = issue || 'fraction'; }
    return { value: n === 0 ? 0 : n, issue: issue };
  }

  function cleanText(v, max) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || LIMITS.name);
  }

  function blankProduct() { return { name: '', made: 0, sellPct: 0, price: 0, blank: 0, decor: 0, wsUnits: 0, wsPrice: 0 }; }
  function newProduct() { var p = blankProduct(); p.sellPct = 75; return p; }

  function sanitizeProduct(raw) {
    var p = { name: cleanText(raw.name) };
    for (var k in PRODUCT_FIELDS) p[k] = check(raw[k], PRODUCT_FIELDS[k]).value;
    return p;
  }

  /* Any value at all -> a complete, finite set of inputs. Idempotent. */
  function sanitizeInputs(raw) {
    var r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var out = { name: cleanText(r.name, 80), products: [] };
    var list = Array.isArray(r.products) ? r.products : [];
    for (var i = 0; i < list.length && out.products.length < LIMITS.products; i++) {
      if (list[i] && typeof list[i] === 'object' && !Array.isArray(list[i])) out.products.push(sanitizeProduct(list[i]));
    }
    if (!out.products.length) out.products.push(blankProduct());
    for (var k in FIELDS) out[k] = check(r[k], FIELDS[k]).value;
    return out;
  }

  /* A new, empty calculator. */
  function defaultInputs() {
    var x = sanitizeInputs({});
    x.products = [newProduct()];
    x.payPct = 2.9; x.payFixed = 0.3; x.itemsPerOrder = 1;
    return x;
  }

  /* The page written before this one stored { inputs: { dropName, costAds, ... }, products: [...] }. */
  function isLegacyDraft(raw) {
    return !!raw && typeof raw === 'object' && !raw.v && Array.isArray(raw.products) &&
      !!raw.inputs && typeof raw.inputs === 'object' && !Array.isArray(raw.inputs.products);
  }
  function migrateLegacy(raw) {
    var o = raw.inputs, n = parseNumber;
    var fin = function (v) { var x = n(v); return isFinite(x) ? x : 0; };
    return {
      name: o.dropName,
      products: raw.products.map(function (p) {
        p = p && typeof p === 'object' ? p : {};
        var made = fin(p.unitsProduced), sold = fin(p.unitsSold);
        return {
          name: p.name, made: made, sellPct: made > 0 ? Math.min(100, Math.max(0, sold / made * 100)) : 0,
          price: p.retailPrice,
          blank: fin(p.unitCost) + fin(o.costBlank),      /* the old page had two places for this */
          decor: o.costDecoration, wsUnits: p.wholesaleUnits, wsPrice: p.wholesalePrice
        };
      }),
      labels: o.costLabels, packaging: o.costPackaging, defectPct: o.defectRate,
      itemsPerOrder: 1, shipCost: o.costShipping, shipMaterials: o.costPackMaterials,
      payPct: o.feePlatformPct, payFixed: o.feePlatformFixed, platformPct: o.feeMarketplace,
      returnPct: o.returnRate, returnCost: o.costRestock,
      samples: o.costSamples, setup: o.costSetup, photo: o.costContent,
      ads: o.costAds, seeding: o.costInfluencer, otherMarketing: o.costOtherMarketing,
      workspace: o.costRent, software: o.costSoftware, otherFixed: o.costOtherOverhead
    };
  }

  /* Whatever was in storage -> { inputs, helpers } or null. Never throws. */
  function sanitizeDraft(raw) {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      if (isLegacyDraft(raw)) return { inputs: sanitizeInputs(migrateLegacy(raw)), helpers: sanitizeHelpers(null), legacy: true };
      if (!raw.inputs || typeof raw.inputs !== 'object' || Array.isArray(raw.inputs)) return null;
      return { inputs: sanitizeInputs(raw.inputs), helpers: sanitizeHelpers(raw.helpers), legacy: false };
    } catch (e) { return null; }
  }
  function sanitizeHelpers(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var t = isEmpty(r.targetPct) ? { value: 30, issue: null } : check(r.targetPct, 'pct');
    return { targetPct: t.value, sellN: isEmpty(r.sellN) ? null : check(r.sellN, 'units').value };
  }

  /* Whatever was in storage -> { list, dropped }. Entries that cannot be reopened are dropped. */
  function sanitizeScenarios(raw) {
    var list = [], dropped = 0, seen = {};
    if (!Array.isArray(raw)) return { list: list, dropped: raw == null ? 0 : 1 };
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i];
      if (!s || typeof s !== 'object' || Array.isArray(s) || !s.inputs || typeof s.inputs !== 'object' || Array.isArray(s.inputs)) { dropped++; continue; }
      if (list.length >= LIMITS.scenarios) { dropped++; continue; }
      var name = cleanText(s.name) || 'Scenario ' + (list.length + 1);
      var id = typeof s.id === 'string' && /^[a-z0-9-]{1,40}$/i.test(s.id) && !seen[s.id] ? s.id : 's' + i + '-' + list.length;
      seen[id] = true;
      var at = Number(s.savedAt);
      list.push({ id: id, name: name, savedAt: isFinite(at) && at > 0 ? at : 0, inputs: sanitizeInputs(s.inputs) });
    }
    return { list: list, dropped: dropped };
  }

  /* The economics of one retail piece at a given price. */
  function retailUnit(price, x) {
    var q = x.itemsPerOrder, ret = x.returnPct / 100;
    var paid = price * (1 - x.discountPct / 100);
    var ship = x.shipCharged / q;
    var taxed = paid * x.taxPct / 100;
    var u = {
      gross: price,
      discount: price - paid,
      refunds: paid * ret,
      shipIncome: ship,
      tax: taxed * (1 - ret),
      processing: (paid + taxed + ship) * x.payPct / 100 + x.payFixed / q,
      platform: (paid * (1 - ret) + ship) * x.platformPct / 100,
      postage: x.shipCost / q,
      materials: x.shipMaterials / q,
      returnHandling: ret * x.returnCost
    };
    u.revenue = paid * (1 - ret) + ship;
    u.contribution = u.revenue - u.processing - u.platform - u.postage - u.materials - u.returnHandling;
    return u;
  }

  function sumKeys(x, keys) { var t = 0; for (var i = 0; i < keys.length; i++) t += x[keys[i]]; return t; }
  function cents(v) { return Math.round(v * 100); }
  /* Money as shown: whole cents, a half cent rounding away from zero. Sums of
     binary fractions land a hair under the half (774.375 arrives as 774.37499...),
     so the nudge keeps the page in step with a hand calculation. */
  function roundCents(v) {
    if (!isFinite(v)) return 0;
    var n = Math.round(Math.abs(v) * 100 + 1e-6) / 100;
    return n === 0 ? 0 : v < 0 ? -n : n;
  }
  /* The name offered when saving: the drop name, numbered if a scenario already has it. */
  function scenarioName(dropName, taken) {
    var used = {}, list = Array.isArray(taken) ? taken : [];
    for (var i = 0; i < list.length; i++) used[cleanText(String(list[i])).toLowerCase()] = true;
    var base = cleanText(dropName);
    if (base && !used[base.toLowerCase()]) return base;
    var stem = base ? base.slice(0, LIMITS.name - 4) : 'Scenario';
    for (var n = base ? 2 : 1; n < 1000; n++) {
      var name = stem + ' ' + n;
      if (!used[name.toLowerCase()]) return name;
    }
    return stem;
  }

  /* Smallest whole n >= 0 with n x contribution - fixedTotal >= 0 to the cent; null = never. */
  function breakEvenUnits(contribution, fixedTotal) {
    var ok = function (n) { return cents(n * contribution - fixedTotal) >= 0; };
    if (ok(0)) return 0;
    if (!(contribution > 0)) return null;
    var n = Math.max(1, Math.ceil((fixedTotal - 0.005) / contribution));
    if (!isFinite(n)) return null;
    var guard = 0;
    while (n > 0 && ok(n - 1) && guard++ < 64) n--;
    while (!ok(n) && guard++ < 128) n++;
    return ok(n) ? n : null;
  }

  function compute(raw) {
    var x = sanitizeInputs(raw);
    var q = x.itemsPerOrder;
    var r = {
      inputs: x, rows: [],
      made: 0, defects: 0, sellable: 0, sold: 0, retailUnits: 0, wsUnits: 0,
      grossSales: 0, discounts: 0, refunds: 0, wholesaleRevenue: 0, shippingIncome: 0, taxCollected: 0,
      blankCost: 0, decorCost: 0, labelsCost: 0, packagingCost: 0,
      postage: 0, materials: 0, processingFees: 0, platformFees: 0, returnHandling: 0,
      unsoldValue: 0, defectValue: 0
    };
    var contribution = 0;
    for (var i = 0; i < x.products.length; i++) {
      var p = x.products[i];
      var defects = Math.min(p.made, Math.round(p.made * x.defectPct / 100));
      var sellable = p.made - defects;
      var sold = Math.min(sellable, Math.round(sellable * p.sellPct / 100));
      var ws = Math.min(p.wsUnits, sold);
      var retail = sold - ws;
      var u = retailUnit(p.price, x);
      var unitCost = p.blank + p.decor + x.labels + x.packaging;
      var row = {
        name: p.name, made: p.made, defects: defects, sellable: sellable, sold: sold, ws: ws, retail: retail,
        wsClamped: p.wsUnits > sold, unit: u, unitCost: unitCost,
        production: p.made * unitCost,
        revenue: retail * u.revenue + ws * p.wsPrice,
        contribution: retail * u.contribution + ws * p.wsPrice
      };
      r.rows.push(row);
      r.made += p.made; r.defects += defects; r.sellable += sellable; r.sold += sold; r.retailUnits += retail; r.wsUnits += ws;
      r.grossSales += retail * u.gross; r.discounts += retail * u.discount; r.refunds += retail * u.refunds;
      r.wholesaleRevenue += ws * p.wsPrice; r.shippingIncome += retail * u.shipIncome; r.taxCollected += retail * u.tax;
      r.blankCost += p.made * p.blank; r.decorCost += p.made * p.decor;
      r.labelsCost += p.made * x.labels; r.packagingCost += p.made * x.packaging;
      r.postage += retail * u.postage; r.materials += retail * u.materials;
      r.processingFees += retail * u.processing; r.platformFees += retail * u.platform; r.returnHandling += retail * u.returnHandling;
      r.unsoldValue += (sellable - sold) * unitCost; r.defectValue += defects * unitCost;
      contribution += row.contribution;
    }
    r.unsold = r.sellable - r.sold;
    r.orders = r.retailUnits / q;
    r.returnedUnits = r.retailUnits * x.returnPct / 100;
    r.retailRevenue = r.grossSales - r.discounts - r.refunds;
    r.revenue = r.retailRevenue + r.wholesaleRevenue + r.shippingIncome;
    r.production = r.blankCost + r.decorCost + r.labelsCost + r.packagingCost;      /* COGS */
    r.grossProfit = r.revenue - r.production;
    r.fulfilment = r.postage + r.materials;
    r.fees = r.processingFees + r.platformFees;
    r.selling = r.fulfilment + r.fees + r.returnHandling;
    r.overhead = sumKeys(x, OVERHEAD_KEYS);
    r.marketing = sumKeys(x, MARKETING_KEYS);
    r.fixed = r.overhead + r.marketing;
    r.totalCosts = r.production + r.selling + r.fixed;
    r.net = r.revenue - r.totalCosts;
    r.margin = r.revenue > 0 ? r.net / r.revenue : null;
    r.grossMargin = r.revenue > 0 ? r.grossProfit / r.revenue : null;
    r.profitPerSold = r.sold > 0 ? r.net / r.sold : null;
    r.revenuePerSold = r.sold > 0 ? r.revenue / r.sold : null;
    r.costPerMade = r.made > 0 ? r.production / r.made : null;
    r.sellThrough = r.sellable > 0 ? r.sold / r.sellable : null;
    r.returnOnCosts = r.totalCosts > 0 ? r.net / r.totalCosts : null;

    /* Break-even at the planned mix. With nothing planned to sell, the mix is the stock. */
    var cbar = 0, rbar = 0, basis = 'none';
    if (r.sold > 0) {
      basis = 'plan'; cbar = contribution / r.sold; rbar = r.revenue / r.sold;
    } else {
      var w = 0, key = r.sellable > 0 ? 'sellable' : 'made';
      for (var j = 0; j < r.rows.length; j++) {
        var row2 = r.rows[j];
        w += row2[key]; cbar += row2[key] * row2.unit.contribution; rbar += row2[key] * row2.unit.revenue;
      }
      if (w > 0) { basis = 'stock'; cbar /= w; rbar /= w; } else { cbar = 0; rbar = 0; }
    }
    var fixedTotal = r.production + r.fixed;
    var units = breakEvenUnits(cbar, fixedTotal);
    var status;
    if (units === null) status = r.made === 0 ? 'no-units' : r.sellable === 0 ? 'no-stock' : 'never';
    else if (units > r.sellable) status = 'beyond-stock';
    else if (units > r.sold) status = 'above-plan';
    else status = 'ok';
    r.breakEven = { units: units, status: status, contribution: cbar, revenuePerUnit: rbar, fixedTotal: fixedTotal, basis: basis };
    return r;
  }

  /* Net profit if n pieces sell at the planned mix. profitAtResult(r, r.sold) equals r.net. */
  function profitAtResult(result, n) { return n * result.breakEven.contribution - result.breakEven.fixedTotal; }
  function profitAt(raw, n) { return profitAtResult(compute(raw), n); }

  /* "What if I sell N": profit, revenue and margin at N pieces sold. */
  function whatIf(raw, n) {
    var r = compute(raw);
    var k = check(n, 'units').value;
    var net = profitAtResult(r, k), revenue = k * r.breakEven.revenuePerUnit;
    return { units: k, net: net, revenue: revenue, margin: revenue > 0 ? net / revenue : null,
      sellable: r.sellable, exceedsStock: k > r.sellable, hasStock: r.made > 0 };
  }

  /* "What price do I need for X% margin". Net and revenue are both straight lines
     in a common multiplier m on every retail price, so the answer is exact:
     net(m) = B + A m, revenue(m) = D + C m, margin = t  =>  m = (tD - B) / (A - tC). */
  function priceForMargin(raw, targetPct) {
    var x = sanitizeInputs(raw);
    var tc = check(targetPct, 'pct');
    if (tc.issue || isEmpty(targetPct) || tc.value >= 100) return { status: 'invalid' };
    var t = tc.value / 100;
    var base = compute(x);
    if (base.retailUnits <= 0) return { status: 'no-retail' };
    var anyPrice = false, i;
    for (i = 0; i < x.products.length; i++) if (x.products[i].price > 0 && base.rows[i].retail > 0) anyPrice = true;
    var basePrices = x.products.map(function (p) { return anyPrice ? p.price : 1; });
    var withPrices = function (prices) {
      var c = sanitizeInputs(x);
      for (var k = 0; k < c.products.length; k++) c.products[k].price = prices[k];
      return compute(c);
    };
    var r0 = withPrices(basePrices.map(function () { return 0; })), r1 = withPrices(basePrices);
    var A = r1.net - r0.net, B = r0.net, C = r1.revenue - r0.revenue, D = r0.revenue;
    var ceiling = C > 0 ? A / C : null;                 /* the margin no price can beat */
    var denom = A - t * C;
    if (!(denom > 1e-9)) return { status: 'unreachable', ceiling: ceiling };
    var m = Math.max(0, (t * D - B) / denom);
    var prices = basePrices.map(function (b) { return Math.ceil(b * m * 100 - 1e-7) / 100; });
    for (i = 0; i < prices.length; i++) if (!(prices[i] <= LIMITS.money)) return { status: 'unreachable', ceiling: ceiling };
    var fin = withPrices(prices);
    return {
      status: base.margin !== null && base.margin >= t ? 'already' : 'ok',
      multiplier: m, exactPrices: basePrices.map(function (b) { return b * m; }), uniform: !anyPrice,
      prices: x.products.map(function (p, k) { return { name: p.name, current: p.price, price: prices[k], retail: base.rows[k].retail }; }),
      margin: fin.margin, net: fin.net, currentMargin: base.margin, ceiling: ceiling
    };
  }

  /* ---------- CSV ---------------------------------------------------------- */
  /* Every cell is quoted. Text that a spreadsheet would run as a formula gets a
     leading apostrophe. Numbers are written by this file, never by the visitor. */
  function csvCell(v) {
    var s;
    if (typeof v === 'number') s = isFinite(v) ? String(v) : '';
    else {
      s = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    }
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function csvRow(cells) { return cells.map(csvCell).join(','); }
  function r2(v) { return roundCents(v); }
  function r4(v) { return v == null ? '' : Math.round(v * 10000) / 100; }
  function unitOf(kind) { return kind === 'money' ? 'USD' : kind === 'pct' ? '%' : kind === 'units' ? 'pieces' : 'pieces'; }
  function productLabel(name, index) { return name || 'Product ' + (index + 1); }

  function buildCsv(raw, when) {
    var r = compute(raw), x = r.inputs, be = r.breakEven, rows = [];
    rows.push(['EmbroideryLabs Drop Calc', 'Estimate only']);
    rows.push(['Drop', x.name || 'Untitled drop']);
    if (when) rows.push(['Exported', when]);
    rows.push([]);
    rows.push(['PRODUCTS']);
    rows.push(['Product', 'Pieces made', 'Sell-through %', 'Defective', 'Sellable', 'Sold', 'Sold retail', 'Sold wholesale',
      'Retail price', 'Wholesale price', 'Blank', 'Decoration', 'Cost per piece made', 'Production cost', 'Revenue']);
    x.products.forEach(function (p, i) {
      var w = r.rows[i];
      rows.push([productLabel(p.name, i), p.made, p.sellPct, w.defects, w.sellable, w.sold, w.retail, w.ws,
        r2(p.price), r2(p.wsPrice), r2(p.blank), r2(p.decor), r2(w.unitCost), r2(w.production), r2(w.revenue)]);
    });
    rows.push([]);
    rows.push(['INPUTS']);
    rows.push(['Group', 'Input', 'Value', 'Unit']);
    INPUT_GROUPS.forEach(function (g) {
      g[1].forEach(function (f) { rows.push([g[0], f[1], x[f[0]], unitOf(FIELDS[f[0]])]); });
    });
    rows.push([]);
    rows.push(['RESULTS (ESTIMATES)']);
    rows.push(['Line', 'Amount', 'Unit']);
    [
      ['Pieces made', r.made, 'pieces'], ['Defective pieces', r.defects, 'pieces'], ['Sellable pieces', r.sellable, 'pieces'],
      ['Pieces sold', r.sold, 'pieces'], ['Expected returns', r2(r.returnedUnits), 'pieces'],
      ['Sales at full price', r2(r.grossSales), 'USD'], ['Discounts', r2(-r.discounts), 'USD'], ['Refunds for returns', r2(-r.refunds), 'USD'],
      ['Wholesale', r2(r.wholesaleRevenue), 'USD'], ['Shipping paid by customers', r2(r.shippingIncome), 'USD'],
      ['Revenue', r2(r.revenue), 'USD'],
      ['Production cost (COGS, every piece made)', r2(-r.production), 'USD'],
      ['Gross profit', r2(r.grossProfit), 'USD'], ['Gross margin', r4(r.grossMargin), '%'],
      ['Postage and shipping materials', r2(-r.fulfilment), 'USD'], ['Payment processing fees', r2(-r.processingFees), 'USD'],
      ['Platform fees', r2(-r.platformFees), 'USD'], ['Handling returns', r2(-r.returnHandling), 'USD'],
      ['Setup and overhead', r2(-r.overhead), 'USD'], ['Marketing', r2(-r.marketing), 'USD'],
      ['Total costs', r2(-r.totalCosts), 'USD'],
      ['Net profit', r2(r.net), 'USD'], ['Net margin', r4(r.margin), '%'],
      ['Profit per piece sold', r.profitPerSold == null ? '' : r2(r.profitPerSold), 'USD'],
      ['Break-even', be.units == null ? 'Never breaks even' : be.units,
        be.status === 'beyond-stock' ? 'pieces sold (out of reach: ' + r.sellable + ' sellable)'
          : be.status === 'above-plan' ? 'pieces sold (plan is ' + r.sold + ')' : 'pieces sold'],
      ['Contribution per piece sold', r2(be.contribution), 'USD'],
      ['Sales tax collected (passed on, not in revenue or profit)', r2(r.taxCollected), 'USD'],
      ['Unsold stock at cost', r2(r.unsoldValue), 'USD']
    ].forEach(function (line) { rows.push(line); });
    return rows.map(csvRow).join('\r\n') + '\r\n';
  }

  function safeFilename(name) {
    var s = cleanText(String(name == null ? '' : name), 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    return (s || 'drop') + '-drop-calc';
  }

  /* ---------- examples ------------------------------------------------------ */
  /* Round, made-up numbers. tests/dropcalc.test.js checks that every one of them
     ends in profit and breaks even inside its own plan. */
  var EXAMPLES = {
    tshirt: {
      name: 'Summer tee drop',
      products: [{ name: 'Essential tee', made: 100, sellPct: 80, price: 38, blank: 5.5, decor: 3, wsUnits: 10, wsPrice: 19 }],
      labels: 0.75, packaging: 1.5, defectPct: 2,
      discountPct: 5, itemsPerOrder: 1, shipCharged: 5, shipCost: 5.5, shipMaterials: 1.25,
      payPct: 2.9, payFixed: 0.3, platformPct: 0, returnPct: 5, returnCost: 3, taxPct: 0,
      design: 0, samples: 50, setup: 75, photo: 100, ads: 200, seeding: 50, otherMarketing: 0, workspace: 0, software: 0, otherFixed: 0
    },
    hoodie: {
      name: 'Winter hoodie drop',
      products: [{ name: 'Heavyweight hoodie', made: 50, sellPct: 80, price: 78, blank: 16, decor: 6, wsUnits: 5, wsPrice: 39 }],
      labels: 1, packaging: 2, defectPct: 2,
      discountPct: 5, itemsPerOrder: 1, shipCharged: 7, shipCost: 7.5, shipMaterials: 2,
      payPct: 2.9, payFixed: 0.3, platformPct: 0, returnPct: 5, returnCost: 5, taxPct: 0,
      design: 0, samples: 80, setup: 100, photo: 150, ads: 250, seeding: 100, otherMarketing: 0, workspace: 0, software: 0, otherFixed: 0
    },
    collection: {
      name: 'Full collection drop',
      products: [
        { name: 'Logo tee', made: 100, sellPct: 80, price: 36, blank: 5.5, decor: 3, wsUnits: 15, wsPrice: 18 },
        { name: 'Graphic tee', made: 75, sellPct: 75, price: 40, blank: 5.5, decor: 4.5, wsUnits: 10, wsPrice: 20 },
        { name: 'Hoodie', made: 50, sellPct: 80, price: 78, blank: 16, decor: 6, wsUnits: 5, wsPrice: 39 },
        { name: 'Cap', made: 60, sellPct: 75, price: 32, blank: 4, decor: 3, wsUnits: 8, wsPrice: 16 },
        { name: 'Tote bag', made: 80, sellPct: 75, price: 22, blank: 2.5, decor: 1.5, wsUnits: 10, wsPrice: 11 }
      ],
      labels: 0.75, packaging: 1.5, defectPct: 2,
      discountPct: 5, itemsPerOrder: 1.5, shipCharged: 6, shipCost: 6.5, shipMaterials: 1.5,
      payPct: 2.9, payFixed: 0.3, platformPct: 0, returnPct: 5, returnCost: 4, taxPct: 0,
      design: 0, samples: 200, setup: 250, photo: 300, ads: 800, seeding: 250, otherMarketing: 100, workspace: 150, software: 50, otherFixed: 0
    }
  };
  function example(key) { return Object.prototype.hasOwnProperty.call(EXAMPLES, key) ? sanitizeInputs(EXAMPLES[key]) : null; }

  var Model = {
    LIMITS: LIMITS, FIELDS: FIELDS, PRODUCT_FIELDS: PRODUCT_FIELDS, INPUT_GROUPS: INPUT_GROUPS, EXAMPLES: EXAMPLES,
    parseNumber: parseNumber, check: check, cleanText: cleanText, blankProduct: blankProduct, newProduct: newProduct,
    sanitizeInputs: sanitizeInputs, defaultInputs: defaultInputs, sanitizeDraft: sanitizeDraft, sanitizeHelpers: sanitizeHelpers,
    sanitizeScenarios: sanitizeScenarios, retailUnit: retailUnit, breakEvenUnits: breakEvenUnits, compute: compute,
    profitAt: profitAt, profitAtResult: profitAtResult, whatIf: whatIf, priceForMargin: priceForMargin,
    roundCents: roundCents, scenarioName: scenarioName,
    csvCell: csvCell, buildCsv: buildCsv, safeFilename: safeFilename, example: example, productLabel: productLabel
  };
  if (typeof module === 'object' && module && module.exports) module.exports = Model;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  window.DropCalc = Model;

  /* ======================================================================
     PART 2 - PAGE (browser only)
     ====================================================================== */
  var DRAFT_KEY = 'dropcalc_draft', SCN_KEY = 'dropcalc_scenarios';
  var EL = window.EL || {};

  var store = {
    get: function (key) {
      if (EL.store) return EL.store.get(key, null);
      try { var raw = localStorage.getItem(key); return raw == null ? null : JSON.parse(raw); } catch (e) { return null; }
    },
    set: function (key, value) {
      if (EL.store) return EL.store.set(key, value);
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    remove: function (key) { if (EL.store) EL.store.remove(key); else { try { localStorage.removeItem(key); } catch (e) {} } }
  };
  function toast(msg, opts) { if (EL.toast) return EL.toast(msg, opts); return null; }

  /* ---------- formatting ---------------------------------------------------- */
  var fmtMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var fmtInt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  var fmtOne = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
  var fmtPct = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
  function money(n) { return fmtMoney.format(Model.roundCents(n)); }
  /* For the narrow strip on phones: six figures and up drop the cents so the number is not cut off. */
  var fmtMoney0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  function moneyShort(n) { n = Model.roundCents(n); return Math.abs(n) >= 100000 ? fmtMoney0.format(n) : fmtMoney.format(n); }
  function signedMoney(n) { n = Model.roundCents(n); return (n > 0 ? '+' : '') + fmtMoney.format(n); }
  function int(n) { return fmtInt.format(isFinite(n) ? n : 0); }
  function pct(ratio) { if (ratio == null || !isFinite(ratio)) return 'n/a'; if (Math.abs(ratio) < 0.0005) ratio = 0; return fmtPct.format(ratio); }
  function pieces(n) { return int(n) + (n === 1 ? ' piece' : ' pieces'); }
  function fieldText(value, kind) {
    if (!value) return '';
    if (kind === 'money') { var s = value.toFixed(2); return Number(s) === value ? s : String(value); }
    return String(value);
  }

  /* ---------- small DOM helpers (textContent only, never innerHTML) -------- */
  function $(id) { return document.getElementById(id); }
  function make(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function setText(id, text) { var e = typeof id === 'string' ? $(id) : id; if (e && e.textContent !== text) e.textContent = text; }
  function setState(el, state) { if (!el) return; if (state) el.setAttribute('data-state', state); else el.removeAttribute('data-state'); }

  var ISSUE_TEXT = {
    nan: function () { return 'Not a number. Counted as 0.'; },
    negative: function () { return 'Cannot be negative. Counted as 0.'; },
    min: function () { return 'Must be at least 1. Counted as 1.'; },
    fraction: function (c) { return 'Whole pieces only. Counted as ' + int(c.value) + '.'; },
    max: function (c, kind) {
      return kind === 'pct' ? 'Cannot be more than 100%. Counted as 100.' : 'Too large. Counted as ' + int(c.value) + '.';
    }
  };

  function init() {
    var form = $('dc-form');
    if (!form) return;
    var productsHost = $('dc-products'), tpl = $('dc-product-tpl');
    var uid = 0;
    var state = { inputs: null, helpers: Model.sanitizeHelpers(null), scenarios: [], example: false, result: null };
    var saveTimer = null, liveTimer = null, storageWarned = false;

    /* ---------- load -------------------------------------------------------- */
    var draft = Model.sanitizeDraft(store.get(DRAFT_KEY));
    if (draft) {
      state.inputs = draft.inputs; state.helpers = draft.helpers;
    } else {
      state.inputs = Model.example('tshirt'); state.example = true;
    }
    var scn = Model.sanitizeScenarios(store.get(SCN_KEY));
    state.scenarios = scn.list;

    /* ---------- form <-> state ---------------------------------------------- */
    function numberFields() { return form.querySelectorAll('input[data-field]'); }

    function buildProduct(p, index) {
      var node = tpl.content.firstElementChild.cloneNode(true);
      var id = 'p' + (++uid);
      node.id = id;
      var title = node.querySelector('[data-p="title"]');
      title.id = id + '-title';
      node.setAttribute('aria-labelledby', title.id);
      var inputs = node.querySelectorAll('[data-pfield]');
      for (var i = 0; i < inputs.length; i++) {
        var inp = inputs[i], f = inp.getAttribute('data-pfield');
        inp.id = id + '-' + f;
        var label = node.querySelector('[data-for="' + f + '"]');
        if (label) label.setAttribute('for', inp.id);
        inp.value = f === 'name' ? p.name : fieldText(p[f], PRODUCT_FIELDS[f]);
      }
      return node;
    }
    function renumberProducts() {
      var cards = productsHost.querySelectorAll('.prod');
      for (var i = 0; i < cards.length; i++) {
        var name = Model.cleanText(cards[i].querySelector('[data-pfield="name"]').value);
        setText(cards[i].querySelector('[data-p="title"]'), 'Product ' + (i + 1) + (name ? ': ' + name : ''));
        var rm = cards[i].querySelector('[data-p="remove"]');
        rm.hidden = cards.length < 2;
        rm.setAttribute('aria-label', 'Remove product ' + (i + 1) + (name ? ', ' + name : ''));
      }
      var full = cards.length >= LIMITS.products;
      $('dc-add').disabled = full;
      $('dc-add-hint').hidden = !full;
    }
    function fillForm(inputs) {
      $('dc-name').value = inputs.name;
      var fields = numberFields();
      for (var i = 0; i < fields.length; i++) {
        var f = fields[i].getAttribute('data-field');
        fields[i].value = fieldText(inputs[f], FIELDS[f]);
      }
      clear(productsHost);
      for (var k = 0; k < inputs.products.length; k++) productsHost.appendChild(buildProduct(inputs.products[k], k));
      renumberProducts();
    }
    function fillHelpers() {
      $('h-target').value = fieldText(state.helpers.targetPct, 'pct');
      $('h-sell').value = state.helpers.sellN == null ? '' : String(state.helpers.sellN);
    }
    function rawValue(input) {
      return input.validity && input.validity.badInput ? 'not a number' : input.value;
    }
    function readForm() {
      var raw = { name: $('dc-name').value, products: [] };
      var fields = numberFields();
      for (var i = 0; i < fields.length; i++) raw[fields[i].getAttribute('data-field')] = rawValue(fields[i]);
      var cards = productsHost.querySelectorAll('.prod');
      for (var k = 0; k < cards.length; k++) {
        var p = {}, inputs = cards[k].querySelectorAll('[data-pfield]');
        for (var j = 0; j < inputs.length; j++) {
          var f = inputs[j].getAttribute('data-pfield');
          p[f] = f === 'name' ? inputs[j].value : rawValue(inputs[j]);
        }
        raw.products.push(p);
      }
      return raw;
    }

    /* ---------- validation messages ---------------------------------------- */
    function showIssue(input, message) {
      var host = input.closest('.lrow, .field');
      if (!host) return;
      var box = input.closest('.input-unit') || input;
      var err = host.querySelector('.field__error');
      if (!message) {
        if (err) err.hidden = true;
        if (box.hasAttribute('aria-invalid')) { box.removeAttribute('aria-invalid'); input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
        return;
      }
      if (!err) {
        err = make('small', 'field__error');
        err.id = input.id + '-err';
        host.appendChild(err);
      }
      err.hidden = false;
      setText(err, message);
      box.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', err.id);
    }
    function validateInput(input, kind) {
      var c = Model.check(rawValue(input), kind);
      showIssue(input, c.issue ? ISSUE_TEXT[c.issue](c, kind) : '');
      return c;
    }
    function validateAll(result) {
      var fields = numberFields(), i;
      for (i = 0; i < fields.length; i++) validateInput(fields[i], FIELDS[fields[i].getAttribute('data-field')]);
      var cards = productsHost.querySelectorAll('.prod');
      for (var k = 0; k < cards.length; k++) {
        var inputs = cards[k].querySelectorAll('input[data-pfield]');
        for (i = 0; i < inputs.length; i++) {
          var f = inputs[i].getAttribute('data-pfield');
          if (f === 'name') continue;
          var c = validateInput(inputs[i], PRODUCT_FIELDS[f]);
          var row = result.rows[k];
          if (f === 'wsUnits' && !c.issue && row && row.wsClamped) {
            showIssue(inputs[i], 'More than the ' + int(row.sold) + ' you expect to sell. Counted as ' + int(row.ws) + '.');
          }
        }
      }
    }

    /* ---------- results ------------------------------------------------------ */
    function breakEvenText(r) {
      var be = r.breakEven, K = money(be.fixedTotal);
      switch (be.status) {
        case 'no-units': return 'Add how many pieces you are making. ' + K + ' of costs has nothing to pay it back yet.';
        case 'no-stock': return 'Never breaks even: no sellable pieces are left after defects, so the ' + K + ' spent cannot come back.';
        case 'never':
          return be.contribution < -0.005
            ? 'Never breaks even: each piece sold loses ' + money(-be.contribution) + ' after fees and shipping, so selling more cannot cover the ' + K + ' spent up front.'
            : 'Never breaks even: a sale leaves nothing after fees and shipping, so the ' + K + ' spent up front cannot come back.';
        case 'beyond-stock':
          return 'Not reachable with this stock: you would need to sell ' + pieces(be.units) + ' and only ' + int(r.sellable) + (r.sellable === 1 ? ' is' : ' are') + ' sellable.';
        case 'above-plan':
          return 'Break-even is ' + pieces(be.units) + ' sold. You plan to sell ' + int(r.sold) + ', so as planned this drop loses money.';
        default:
          if (be.units === 0) return 'Nothing to pay back: there are no costs before the first sale.';
          return 'Sell ' + pieces(be.units) + ' and the drop has paid for itself. You plan to sell ' + int(r.sold) + '.';
      }
    }
    function breakEvenShort(r) {
      var be = r.breakEven;
      if (be.units === null) return be.status === 'no-units' ? 'n/a' : 'Never';
      return int(be.units);
    }
    function specRow(dl, term, value, cls) {
      var row = make('div', cls || '');
      row.appendChild(make('dt', '', term));
      row.appendChild(make('dd', 'num', value));
      dl.appendChild(row);
    }

    function renderResults(r) {
      var be = r.breakEven, loss = cents(r.net) < 0;
      var netEl = $('r-net-wrap');
      setState(netEl, loss ? 'bad' : '');
      setText('r-net-label', loss ? 'Net loss, whole drop' : 'Net profit, whole drop');
      setText('r-net', money(r.net));

      setText('r-margin', pct(r.margin));
      var pos = r.margin == null ? 0 : Math.max(0, Math.min(1, r.margin)) * 100;
      $('r-gauge').style.setProperty('--pos', pos.toFixed(1) + '%');
      setText('r-margin-note', r.margin == null ? 'No revenue yet.' : r.margin < 0 ? 'Below zero: costs are more than revenue.' : 'Gross margin ' + pct(r.grossMargin) + ' before selling and one-time costs.');

      var beOk = be.status === 'ok';
      var bar = $('r-bebar');
      setState(bar, beOk ? 'ok' : 'bad');
      var val = be.units === null ? 100 : r.sellable > 0 ? Math.min(100, be.units / r.sellable * 100) : (be.units === 0 ? 0 : 100);
      if (be.status === 'no-units') val = 0;
      bar.style.setProperty('--val', val.toFixed(1) + '%');
      var beNum = $('r-be');
      clear(beNum);
      if (be.units === null) beNum.appendChild(document.createTextNode(be.status === 'no-units' ? 'n/a' : 'Never'));
      else {
        beNum.appendChild(document.createTextNode(int(be.units) + ' of ' + int(r.sellable)));
        beNum.appendChild(make('span', 'unit', 'pcs'));
      }
      setText('r-be-text', breakEvenText(r));
      setState($('r-be-text'), beOk ? '' : 'bad');
      setText('r-be-word', beOk ? 'Within plan' : be.units === null ? (be.status === 'no-units' ? 'No pieces' : 'Never') : be.status === 'beyond-stock' ? 'Out of reach' : 'Above plan');
      $('r-be-word').className = 'tag ' + (beOk ? 'tag--ok' : be.status === 'no-units' ? '' : 'tag--bad');

      /* cost bar: shares of revenue when there is profit, shares of cost when there is not */
      var parts = [
        ['p1', 'Production', r.production], ['p2', 'Shipping and returns', r.fulfilment + r.returnHandling],
        ['p3', 'Fees', r.fees], ['p4', 'Setup and overhead', r.overhead], ['p5', 'Marketing', r.marketing]
      ];
      var profit = loss ? 0 : Math.max(0, r.net);
      var whole = r.totalCosts + profit;
      var costbar = $('r-costbar'), keys = $('r-keys');
      clear(costbar); clear(keys);
      var aria = [];
      (loss ? parts : parts.concat([['p6', 'You keep', profit]])).forEach(function (part) {
        var share = whole > 0 ? part[2] / whole * 100 : 0;
        if (share > 0) {
          var seg = make('i', part[0]);
          seg.style.width = share.toFixed(2) + '%';
          costbar.appendChild(seg);
        }
        var row = make('div');
        var name = make('span');
        name.appendChild(make('i', 'key ' + part[0]));
        name.appendChild(document.createTextNode(part[1]));
        row.appendChild(name);
        row.appendChild(make('span', 'num', money(part[2])));
        keys.appendChild(row);
        aria.push(part[1] + ' ' + money(part[2]));
      });
      costbar.setAttribute('aria-label', 'Cost breakdown. ' + aria.join(', ') + '.');
      setText('r-bar-label', r.revenue <= 0 && r.totalCosts <= 0 ? 'Where the money goes' :
        loss ? 'Where the ' + money(r.totalCosts) + ' of costs goes' : 'Where the ' + money(r.revenue) + ' of revenue goes');

      setText('r-ppu', r.profitPerSold == null ? 'n/a' : money(r.profitPerSold));
      setText('r-cpu', r.costPerMade == null ? 'n/a' : money(r.costPerMade));

      /* receipt */
      setText('r-rc-count', int(r.sold) + ' of ' + int(r.made) + ' pcs sold');
      var dl = $('r-spec');
      clear(dl);
      specRow(dl, 'Sales at full price', money(r.grossSales));
      if (r.discounts > 0.004) specRow(dl, 'Discounts', money(-r.discounts));
      if (r.refunds > 0.004) specRow(dl, 'Refunds for returns', money(-r.refunds));
      if (r.wholesaleRevenue > 0.004) specRow(dl, 'Wholesale', money(r.wholesaleRevenue));
      if (r.shippingIncome > 0.004) specRow(dl, 'Shipping paid by customers', money(r.shippingIncome));
      specRow(dl, 'Revenue', money(r.revenue), 'dc-sub');
      specRow(dl, 'Production, ' + int(r.made) + ' pcs made', money(-r.production));
      specRow(dl, 'Gross profit', money(r.grossProfit), 'dc-sub');
      specRow(dl, 'Postage and packing', money(-r.fulfilment));
      specRow(dl, 'Payment and platform fees', money(-r.fees));
      if (r.returnHandling > 0.004) specRow(dl, 'Handling returns', money(-r.returnHandling));
      specRow(dl, 'Setup and overhead', money(-r.overhead));
      specRow(dl, 'Marketing', money(-r.marketing));
      var total = $('r-total-wrap');
      setState(total, loss ? 'bad' : '');
      setText('r-total-label', loss ? 'You lose' : 'You keep');
      setText('r-total', money(Math.abs(r.net)));
      var after = $('r-after');
      clear(after);
      specRow(after, 'Unsold stock, at cost', money(r.unsoldValue));
      if (r.defects > 0) specRow(after, 'Defective, ' + int(r.defects) + ' pcs, at cost', money(r.defectValue));
      if (r.taxCollected > 0.004) specRow(after, 'Sales tax collected, passed on', money(r.taxCollected));

      /* phone strip */
      setText('st-net', moneyShort(r.net)); setState($('st-net').parentNode, loss ? 'bad' : '');
      setText('st-margin', pct(r.margin)); setState($('st-margin').parentNode, loss ? 'bad' : '');
      setText('st-be', breakEvenShort(r)); setState($('st-be').parentNode, beOk ? '' : 'bad');

      /* ledger totals and product notes */
      setText('t-unit', r.costPerMade == null ? 'n/a' : money(r.costPerMade));
      setText('t-fixed', money(r.fixed));
      var cards = productsHost.querySelectorAll('.prod');
      for (var i = 0; i < cards.length; i++) {
        var w = r.rows[i]; if (!w) continue;
        var note = w.made === 0 ? 'Add how many pieces you are making.' :
          'Sells ' + int(w.sold) + ' of ' + int(w.sellable) + ' sellable' + (w.defects ? ' (' + int(w.defects) + ' defective)' : '') +
          '. Costs ' + money(w.unitCost) + ' a piece to make, with labels and packaging.';
        setText(cards[i].querySelector('[data-p="note"]'), note);
      }
    }

    function renderHelpers(r) {
      var t = validateInput($('h-target'), 'pct');
      var out = $('h-target-out'), list = $('h-target-list');
      clear(list); list.hidden = true;
      var raw = rawValue($('h-target'));
      if (raw.trim() === '') setText(out, 'Enter the margin you want to keep.');
      else if (t.issue) setText(out, 'Enter a margin between 0 and 99.');
      else {
        var res = Model.priceForMargin(state.inputs, t.value);
        if (res.status === 'invalid') setText(out, 'Enter a margin below 100. No price keeps all of the revenue.');
        else if (res.status === 'no-retail') setText(out, 'No pieces are planned for retail sale, so price cannot change the margin.');
        else if (res.status === 'unreachable') {
          setText(out, 'Not reachable at any price' + (res.ceiling != null && res.ceiling > 0 ? ': fees and returns leave at most ' + pct(res.ceiling) + ' of each extra dollar.' : '.'));
        } else {
          var shown = res.prices.filter(function (p) { return p.retail > 0; });
          var lead = res.status === 'already' ? 'You are already there at ' + pct(res.currentMargin) + '. ' : '';
          if (shown.length === 1) {
            setText(out, lead + 'Charge ' + money(shown[0].price) + ' a piece to keep ' + pct(res.margin) + '. You charge ' + money(shown[0].current) + ' now.');
          } else {
            setText(out, lead + (res.uniform ? 'Charge this for every piece to keep ' : 'Move every retail price by the same share to keep ') + pct(res.margin) + ':');
            shown.forEach(function (p, i) {
              var row = make('div');
              row.appendChild(make('dt', '', Model.productLabel(p.name, res.prices.indexOf(p))));
              row.appendChild(make('dd', 'num', money(p.price) + ' (now ' + money(p.current) + ')'));
              list.appendChild(row);
            });
            list.hidden = false;
          }
        }
      }

      var sellInput = $('h-sell');
      var s = validateInput(sellInput, 'units');
      var out2 = $('h-sell-out');
      if (rawValue(sellInput).trim() === '') setText(out2, 'Enter a number of pieces to see what you would keep.');
      else if (s.issue === 'nan' || s.issue === 'negative') setText(out2, 'Enter a whole number of pieces.');
      else {
        var w = Model.whatIf(state.inputs, s.value);
        if (!w.hasStock) setText(out2, 'Add how many pieces you are making first.');
        else {
          var txt = 'Sell ' + pieces(w.units) + ' and you ' + (cents(w.net) < 0 ? 'lose ' + money(-w.net) : 'keep ' + money(w.net)) +
            (w.margin == null ? '.' : ', a margin of ' + pct(w.margin) + '.');
          if (w.exceedsStock) txt += ' That is more than the ' + int(w.sellable) + ' sellable pieces you are making.';
          setText(out2, txt);
        }
      }
    }

    /* ---------- print sheet (built from the same numbers) ------------------- */
    function inputText(key, x) {
      var kind = FIELDS[key], v = x[key];
      if (kind === 'money') return money(v);
      if (kind === 'pct') return fmtOne.format(v) + '%';
      return fmtOne.format(v);
    }
    function renderPrint(r) {
      var x = r.inputs;
      setText('pr-name', x.name || 'Untitled drop');
      var host = $('pr-inputs');
      clear(host);
      INPUT_GROUPS.forEach(function (g) {
        var box = make('div', 'stack');
        box.appendChild(make('span', 'label', g[0]));
        var dl = make('dl', 'spec');
        g[1].forEach(function (f) { specRow(dl, f[1], inputText(f[0], x)); });
        box.appendChild(dl);
        host.appendChild(box);
      });
      var body = $('pr-products');
      clear(body);
      x.products.forEach(function (p, i) {
        var w = r.rows[i], tr = make('tr');
        tr.appendChild(make('td', '', Model.productLabel(p.name, i)));
        [int(p.made), fmtOne.format(p.sellPct) + '%', int(w.sold), money(p.price), money(p.blank), money(p.decor),
          w.ws ? int(w.ws) + ' at ' + money(p.wsPrice) : 'None', money(w.revenue)].forEach(function (t) { tr.appendChild(make('td', 'n', t)); });
        body.appendChild(tr);
      });
    }

    /* ---------- scenarios ---------------------------------------------------- */
    var METRICS = [
      ['Pieces made', function (r) { return r.made; }, 'int'],
      ['Pieces sold', function (r) { return r.sold; }, 'int'],
      ['Revenue', function (r) { return r.revenue; }, 'money', 'high'],
      ['Production', function (r) { return r.production; }, 'money'],
      ['Shipping and returns', function (r) { return r.fulfilment + r.returnHandling; }, 'money'],
      ['Fees', function (r) { return r.fees; }, 'money'],
      ['Setup and overhead', function (r) { return r.overhead; }, 'money'],
      ['Marketing', function (r) { return r.marketing; }, 'money'],
      ['Net profit', function (r) { return r.net; }, 'money', 'high'],
      ['Margin', function (r) { return r.margin; }, 'pct', 'high'],
      /* a break-even the stock cannot reach is shown, but is never the best value in the row */
      ['Break-even, pieces sold', function (r) { return r.breakEven.units; }, 'be', 'low', function (r) { return r.breakEven.status === 'beyond-stock' ? null : r.breakEven.units; }],
      ['Profit per piece sold', function (r) { return r.profitPerSold; }, 'money', 'high']
    ];
    function metricText(v, kind) {
      if (kind === 'be') return v == null ? 'Never' : int(v);
      if (v == null) return 'n/a';
      return kind === 'money' ? money(v) : kind === 'pct' ? pct(v) : int(v);
    }
    function sameMetric(a, b, kind) {
      if (a == null || b == null) return a == null && b == null;
      return kind === 'money' ? cents(a) === cents(b) : kind === 'pct' ? Math.round(a * 1000) === Math.round(b * 1000) : a === b;
    }
    function deltaText(v, base, kind) {
      if (v == null || base == null) return 'now ' + metricText(base, kind);
      var d = v - base;
      if (kind === 'money') return signedMoney(d);
      if (kind === 'pct') return (d > 0 ? '+' : '') + fmtOne.format(d * 100) + ' pts';
      return (d > 0 ? '+' : '') + int(d);
    }
    function renderScenarios(current) {
      var has = state.scenarios.length > 0;
      $('dc-scn-empty').hidden = has;
      $('dc-scn-wrap').hidden = !has;
      setText('dc-scn-count', state.scenarios.length + ' of ' + LIMITS.scenarios);
      if (!has) return;
      var cols = [{ name: 'Now', result: current, now: true }].concat(state.scenarios.map(function (s) {
        return { name: s.name, result: Model.compute(s.inputs), id: s.id };
      }));
      var head = $('dc-scn-head'), body = $('dc-scn-body'), foot = $('dc-scn-foot');
      clear(head); clear(body); clear(foot);
      head.appendChild(make('th', '', 'Line'));
      cols.forEach(function (c) { var th = make('th', 'n', c.name); th.scope = 'col'; head.appendChild(th); });
      METRICS.forEach(function (m) {
        var tr = make('tr'), values = cols.map(function (c) { return m[1](c.result); });
        var th = make('th', '', m[0]); th.scope = 'row';
        tr.appendChild(th);
        var best = null, ranked = m[4] ? cols.map(function (c) { return m[4](c.result); }) : values;
        if (m[3]) {
          var usable = ranked.filter(function (v) { return v != null; });
          var allSame = values.every(function (v) { return sameMetric(v, values[0], m[2]); });
          if (usable.length && !allSame) best = m[3] === 'high' ? Math.max.apply(null, usable) : Math.min.apply(null, usable);
        }
        var differs = false;
        values.forEach(function (v, i) {
          var td = make('td', 'n');
          td.appendChild(make('span', '', metricText(v, m[2])));
          if (i > 0) {
            if (sameMetric(v, values[0], m[2])) td.setAttribute('data-same', 'true');
            else { differs = true; td.appendChild(make('small', 'dc-delta', deltaText(v, values[0], m[2]))); }
          }
          if (best != null && ranked[i] != null && sameMetric(ranked[i], best, m[2])) {
            td.classList.add('best');
            td.appendChild(make('span', 'visually-hidden', ' (best)'));
          }
          tr.appendChild(td);
        });
        if (differs) tr.setAttribute('data-differs', 'true');
        body.appendChild(tr);
      });
      foot.appendChild(make('td', '', ''));
      cols.forEach(function (c) {
        var td = make('td', 'n');
        if (c.now) td.appendChild(make('span', 'muted', 'What you see above'));
        else {
          var open = make('button', 'btn', 'Open'); open.type = 'button';
          open.setAttribute('data-scn-open', c.id); open.setAttribute('aria-label', 'Open scenario ' + c.name);
          var del = make('button', 'btn btn--danger', 'Delete'); del.type = 'button';
          del.setAttribute('data-scn-delete', c.id); del.setAttribute('aria-label', 'Delete scenario ' + c.name);
          var box = make('span', 'dc-scn-actions');
          box.appendChild(open); box.appendChild(del);
          td.appendChild(box);
        }
        foot.appendChild(td);
      });
      fitScenarios();
    }
    /* the sideways hint only when there is something off to the side */
    function fitScenarios() {
      var wrap = document.querySelector('#dc-scn-wrap .table-wrap'), hint = $('dc-scn-swipe');
      if (wrap && hint) hint.hidden = wrap.scrollWidth <= wrap.clientWidth + 1;
    }
    function saveScenarios() {
      var ok = store.set(SCN_KEY, state.scenarios);
      if (!ok) toast('Not saved: storage is full or blocked on this device.', { kind: 'bad' });
      return ok;
    }

    /* ---------- autosave ----------------------------------------------------- */
    function saveNow() {
      clearTimeout(saveTimer); saveTimer = null;
      var ok = store.set(DRAFT_KEY, { v: 2, savedAt: Date.now(), inputs: state.inputs, helpers: state.helpers });
      setText('dc-savestate', ok ? 'Saved on this device' : 'Not saved: storage is full');
      setState($('dc-savestate'), ok ? '' : 'bad');
      if (!ok && !storageWarned) { storageWarned = true; toast('Not saved: storage is full or blocked on this device.', { kind: 'bad' }); }
    }
    function scheduleSave() {
      setText('dc-savestate', 'Saving');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNow, 350);
    }

    /* ---------- the one update path ------------------------------------------ */
    function update(opts) {
      opts = opts || {};
      if (!opts.fromState) state.inputs = Model.sanitizeInputs(readForm());
      var th = Model.check(rawValue($('h-target')), 'pct'), sn = rawValue($('h-sell'));
      state.helpers = { targetPct: th.value, sellN: sn.trim() === '' ? null : Model.check(sn, 'units').value };
      var r = state.result = Model.compute(state.inputs);
      validateAll(r);
      renderResults(r);
      renderHelpers(r);
      renderPrint(r);
      renderScenarios(r);
      $('dc-example-note').hidden = !state.example;
      if (opts.save) scheduleSave();
      clearTimeout(liveTimer);
      liveTimer = setTimeout(function () {
        setText('dc-live', (cents(r.net) < 0 ? 'Net loss ' : 'Net profit ') + money(r.net) + '. Margin ' + pct(r.margin) + '. ' + breakEvenText(r));
      }, 900);
    }
    function replaceInputs(inputs, isExample) {
      state.inputs = Model.sanitizeInputs(inputs);
      state.example = !!isExample;
      fillForm(state.inputs);
      update({ fromState: true, save: true });
    }
    function replaceWithUndo(inputs, message, isExample) {
      var before = state.inputs, wasExample = state.example;
      replaceInputs(inputs, isExample);
      toast(message, { kind: 'ok', timeout: 8000, action: { label: 'Undo', onClick: function () { replaceInputs(before, wasExample); } } });
    }

    /* ---------- events ------------------------------------------------------- */
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    form.addEventListener('input', function (e) {
      var t = e.target;
      if (t && t.id !== 'h-target' && t.id !== 'h-sell') state.example = false;
      if (t && t.getAttribute && t.getAttribute('data-pfield') === 'name') renumberProducts();
      update({ save: true });
    });
    form.addEventListener('change', function () { update({ save: true }); });
    form.addEventListener('click', function (e) {
      var t = e.target instanceof Element ? e.target : null; if (!t) return;
      var btn;
      if ((btn = t.closest('[data-example]'))) {
        var key = btn.getAttribute('data-example'), ex = Model.example(key);
        if (ex) replaceWithUndo(ex, 'Loaded the example "' + ex.name + '".', true);
        return;
      }
      if (t.closest('#dc-add')) {
        if (productsHost.querySelectorAll('.prod').length >= LIMITS.products) return;
        var node = buildProduct(Model.newProduct(), 0);
        productsHost.appendChild(node);
        state.example = false;
        renumberProducts();
        update({ save: true });
        node.querySelector('[data-pfield="name"]').focus();
        return;
      }
      if ((btn = t.closest('[data-p="remove"]'))) {
        var card = btn.closest('.prod');
        if (!card || productsHost.querySelectorAll('.prod').length < 2) return;
        var before = state.inputs, wasExample = state.example;
        var label = Model.cleanText(card.querySelector('[data-pfield="name"]').value) || 'product';
        card.remove();
        state.example = false;
        renumberProducts();
        update({ save: true });
        $('dc-add').focus();
        toast('Removed "' + label + '".', { timeout: 8000, action: { label: 'Undo', onClick: function () { replaceInputs(before, wasExample); } } });
      }
    });

    /* BASE-CANDIDATE: js/site.js closes a dialog on any click outside it, so the
       second click of a double click on the button that opened it shuts it again
       before it can be read. This page ignores an outside click for the first
       half second a dialog is up. */
    var dialogAt = 0;
    function dialogUp() { dialogAt = Date.now(); }
    window.addEventListener('click', function (e) {
      var t = e.target instanceof Element ? e.target : null;
      if (t && t.matches('dialog.dialog') && Date.now() - dialogAt < 500) e.stopPropagation();
    }, true);

    $('dc-reset').addEventListener('click', function () {
      var go = function (yes) {
        if (!yes) return;
        state.helpers = Model.sanitizeHelpers(null);
        fillHelpers();
        state.inputs = Model.defaultInputs(); state.example = false;
        fillForm(state.inputs);
        update({ fromState: true });
        saveNow();          /* so a reload shows the empty page, not the example again */
        $('dc-name').focus();
      };
      if (EL.confirm) {
        dialogUp();
        EL.confirm('Every number on this page is cleared. Saved scenarios stay.', { title: 'Start over?', confirmLabel: 'Start over', cancelLabel: 'Keep my numbers', danger: true }).then(go);
      } else go(true);
    });

    $('dc-csv').addEventListener('click', function () {
      var csv = '﻿' + Model.buildCsv(state.inputs, new Date().toISOString().slice(0, 10));
      var file = Model.safeFilename(state.inputs.name) + '.csv';
      if (EL.download) { EL.download(file, csv, 'text/csv;charset=utf-8'); toast('Saved ' + file, { kind: 'ok', label: 'Export' }); }
    });
    $('dc-print').addEventListener('click', function () {
      setText('pr-date', new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }));
      window.print();
    });

    /* save-scenario dialog */
    var dlg = $('dc-save-dialog'), dlgName = $('dc-save-name'), dlgErr = $('dc-save-err');
    $('dc-save').addEventListener('click', function () {
      dlgName.value = Model.scenarioName(state.inputs.name, state.scenarios.map(function (s) { return s.name; }));
      dlgErr.hidden = true; dlgName.removeAttribute('aria-invalid');
      dialogUp();
      if (EL.dialog) EL.dialog.open(dlg); else if (dlg.showModal) dlg.showModal();
      dlgName.focus(); dlgName.select();
    });
    $('dc-save-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = Model.cleanText(dlgName.value);
      var fail = function (msg) { setText(dlgErr, msg); dlgErr.hidden = false; dlgName.setAttribute('aria-invalid', 'true'); dlgName.focus(); };
      if (!name) return fail('Give the scenario a name.');
      var existing = -1;
      for (var i = 0; i < state.scenarios.length; i++) if (state.scenarios[i].name.toLowerCase() === name.toLowerCase()) existing = i;
      if (existing < 0 && state.scenarios.length >= LIMITS.scenarios) return fail('You have ' + LIMITS.scenarios + ' scenarios, which is the limit. Delete one first, or reuse a name to replace it.');
      var entry = { id: 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36), name: name, savedAt: Date.now(), inputs: Model.sanitizeInputs(state.inputs) };
      var previous = state.scenarios.slice();
      if (existing >= 0) { entry.id = state.scenarios[existing].id; state.scenarios[existing] = entry; } else state.scenarios.push(entry);
      if (!saveScenarios()) { state.scenarios = previous; return fail('Not saved: storage is full or blocked on this device.'); }
      if (EL.dialog) EL.dialog.close(dlg); else dlg.close();
      renderScenarios(state.result);
      toast((existing >= 0 ? 'Replaced scenario "' : 'Saved scenario "') + name + '".', { kind: 'ok' });
    });
    $('dc-scn').addEventListener('click', function (e) {
      var t = e.target instanceof Element ? e.target : null; if (!t) return;
      var btn, id, i;
      var find = function (sid) { for (var k = 0; k < state.scenarios.length; k++) if (state.scenarios[k].id === sid) return k; return -1; };
      if ((btn = t.closest('[data-scn-open]'))) {
        i = find(btn.getAttribute('data-scn-open'));
        if (i >= 0) replaceWithUndo(state.scenarios[i].inputs, 'Opened scenario "' + state.scenarios[i].name + '".', false);
        return;
      }
      if ((btn = t.closest('[data-scn-delete]'))) {
        id = btn.getAttribute('data-scn-delete'); i = find(id);
        if (i < 0) return;
        var name = state.scenarios[i].name;
        var go = function (yes) {
          if (!yes) return;
          var k = find(id); if (k < 0) return;
          state.scenarios.splice(k, 1);
          saveScenarios();
          renderScenarios(state.result);
          $('dc-save').focus();
        };
        dialogUp();
        if (EL.confirm) EL.confirm('"' + name + '" is removed from this device. This cannot be undone.', { title: 'Delete this scenario?', confirmLabel: 'Delete', cancelLabel: 'Keep', danger: true }).then(go);
        else go(true);
      }
    });

    /* ---------- results plate --------------------------------------------------
       It stays in view beside the ledger. In a short window it can be taller than
       the space it has: then it follows the page down until its last line is on
       screen and holds there, and comes back when you scroll up, so nothing is
       cut off and nothing needs a scrollbar of its own. */
    var cluster = document.querySelector('.cluster__main'), clusterTop = null, lastY = window.pageYOffset || 0;
    function placeCluster() {
      if (!cluster) return;
      var y = window.pageYOffset || 0;
      if (getComputedStyle(cluster).position !== 'sticky') { cluster.style.removeProperty('--cluster-top'); clusterTop = null; lastY = y; return; }
      var root = getComputedStyle(document.documentElement);
      var gap = parseFloat(root.getPropertyValue('--s-4')) || 16;
      var max = (parseFloat(root.getPropertyValue('--head-h')) || 48) + gap;
      var min = Math.min(max, window.innerHeight - cluster.offsetHeight - gap);
      var next = Math.round(Math.max(min, Math.min(max, (clusterTop == null ? max : clusterTop) - (y - lastY))));
      lastY = y;
      if (next !== clusterTop) { clusterTop = next; cluster.style.setProperty('--cluster-top', next + 'px'); }
    }
    window.addEventListener('scroll', placeCluster, { passive: true });
    window.addEventListener('resize', function () { placeCluster(); fitScenarios(); });
    if (window.ResizeObserver && cluster) new ResizeObserver(placeCluster).observe(cluster);

    window.addEventListener('pagehide', function () { if (saveTimer) saveNow(); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden' && saveTimer) saveNow(); });

    /* ---------- first paint -------------------------------------------------- */
    fillHelpers();
    fillForm(state.inputs);
    update({ fromState: true });
    placeCluster();
    setText('pr-date', new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }));
    setText('dc-savestate', draft ? 'Saved on this device' : 'Example numbers, not saved yet');
    if (draft && draft.legacy) { saveNow(); toast('Your draft from the old calculator was carried over. Check the numbers.', { timeout: 8000 }); }
    if (scn.dropped > 0) toast('Older saved scenarios could not be reopened and were left out.', { timeout: 8000 });
  }

  function boot() {
    try { init(); }
    catch (err) {
      /* A broken page must still say so instead of showing stale numbers. */
      if (window.console && console.error) console.error(err);
      var live = document.getElementById('dc-live');
      if (live) live.textContent = 'The calculator could not start. Reload the page.';
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
