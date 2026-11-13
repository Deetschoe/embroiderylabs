/*
 * Embroidery Labs: realistic stitch renderer, PAGE API (canvas, scenes, workers, export).
 *
 *   <script src="js/realistic/core.js"></script>
 *   <script src="js/realistic/realistic.js"></script>
 *   Realistic.render(canvas, engineResult, { fabric: 'jersey', scene: 'garment' }).then(stats => ...)
 *
 * See API.md next to this file. Classic script (window.Realistic); in node require() gives the same object
 * (only the parts that need no canvas work there). Nothing here throws on bad input and nothing is fetched:
 * the worker is built from core.js's own source text, so the module also works from file://.
 */
(function (root, factory) {
  var isNode = typeof module === 'object' && module.exports, core = null;
  try { core = isNode ? require('./core.js') : root.RealisticCore; } catch (e) { core = null; }
  var api = factory(core, root);
  if (isNode) module.exports = api; else root.Realistic = api;
})(typeof self !== 'undefined' ? self : this, function (Core, root) {
  'use strict';

  var VERSION = '1.0.0';
  var MAX_SIDE = 8192, MAX_PIXELS = 36e6, TILE = 256;
  var SYNC_COST = 0.45e6;         /* below this the whole picture is drawn at once, on the page's own thread (about 40 ms at most) */
  var QUICK_COST = 1.4e6;         /* what the quick first frame may cost */
  var now = (typeof performance !== 'undefined' && performance.now) ? function () { return performance.now(); } : function () { return Date.now(); };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* ================= garments: outlines in millimetres =================
     x to the right, y down, origin at the centre of the neck on the shoulder line. Each outline is the
     RIGHT half from top centre to bottom centre; the left half is its mirror image. */
  var GARMENT = {
    tshirt: {
      box: { x0: -388, y0: -6, x1: 388, y1: 748 },
      half: [['M', 0, 18], ['Q', 55, 16, 92, 0], ['L', 238, 44], ['Q', 302, 104, 380, 198], ['L', 300, 292], ['Q', 276, 250, 262, 222],
        ['Q', 252, 420, 256, 560], ['Q', 258, 660, 262, 728], ['Q', 130, 742, 0, 740]],
      place: { 'left-chest': { x: 108, y: 215 }, 'center-chest': { x: 0, top: 172 } }
    },
    hoodie: {
      box: { x0: -390, y0: -230, x1: 390, y1: 684 },
      half: [['M', 0, -222], ['C', 88, -224, 168, -150, 158, -62], ['C', 154, -24, 134, 2, 112, 12], ['L', 262, 62],
        ['C', 310, 150, 352, 380, 372, 590], ['L', 380, 662], ['L', 318, 670], ['L', 316, 598], ['C', 305, 440, 290, 330, 272, 262],
        ['Q', 266, 440, 270, 606], ['L', 263, 668], ['Q', 130, 676, 0, 675]],
      place: { 'left-chest': { x: 108, y: 240 }, 'center-chest': { x: 0, top: 186 } }
    }
  };
  /* trace a list of commands; sx = 1 or -1 mirrors it. first=false continues the current path. */
  function trace(ctx, cmds, sx, first) {
    for (var i = 0; i < cmds.length; i++) {
      var c = cmds[i];
      if (c[0] === 'M') { if (first === false && i === 0) ctx.lineTo(c[1] * sx, c[2]); else ctx.moveTo(c[1] * sx, c[2]); }
      else if (c[0] === 'L') ctx.lineTo(c[1] * sx, c[2]);
      else if (c[0] === 'Q') ctx.quadraticCurveTo(c[1] * sx, c[2], c[3] * sx, c[4]);
      else if (c[0] === 'C') ctx.bezierCurveTo(c[1] * sx, c[2], c[3] * sx, c[4], c[5] * sx, c[6]);
    }
  }
  /* the same commands walked backwards (end to start) */
  function reversed(cmds) {
    var out = [], i, c, p, end = function (k) { var q = cmds[k]; return [q[q.length - 2], q[q.length - 1]]; };
    p = end(cmds.length - 1); out.push(['M', p[0], p[1]]);
    for (i = cmds.length - 1; i > 0; i--) {
      c = cmds[i]; p = end(i - 1);
      if (c[0] === 'L') out.push(['L', p[0], p[1]]);
      else if (c[0] === 'Q') out.push(['Q', c[1], c[2], p[0], p[1]]);
      else if (c[0] === 'C') out.push(['C', c[3], c[4], c[1], c[2], p[0], p[1]]);
    }
    return out;
  }
  /* a closed outline from a right half */
  function outline(ctx, half) { ctx.beginPath(); trace(ctx, half, 1); trace(ctx, reversed(half), -1, false); ctx.closePath(); }
  function both(ctx, cmds) { trace(ctx, cmds, 1); trace(ctx, cmds, -1); }

  /* ================= layout: where things go, as plain numbers ================= */
  /*
   * c: compiled design (Core.compile), o: normalised options, W, H: canvas pixels.
   * -> { ppm, ox, oy, garment: null | { kind, gx, gy }, design: { x, y, width, height } | null (canvas px), fit }
   *    canvas px = design mm * ppm + (ox, oy); garment mm * ppm + (gx, gy).
   */
  function layout(c, o, W, H) {
    var b = c && c.bounds, bw = b ? b.width : 0, bh = b ? b.height : 0, bcx = b ? (b.minX + b.maxX) / 2 : 0, bcy = b ? (b.minY + b.maxY) / 2 : 0;
    var m = o.margin, ppm, ox, oy, g = null, fit, hoopBox = null;
    if (!b && c && c.hoop) { bcx = c.hoop.width / 2; bcy = c.hoop.height / 2; }
    if (o.scene === 'garment') {
      var G = GARMENT[o.garment] || GARMENT.tshirt, pl = G.place[o.placement] || G.place['left-chest'];
      var px = pl.x, py = pl.y !== undefined ? Math.max(pl.y, pl.y - 70 + bh / 2) : pl.top + bh / 2;
      if (o.framing === 'chest') { var side = Math.max(230, Math.max(bw, bh) * 1.7); fit = { x0: px - side / 2, y0: py - side / 2, x1: px + side / 2, y1: py + side / 2 }; m = 0; }
      else fit = G.box;
      ppm = o.pixelsPerMm || Math.min(W * (1 - 2 * m) / (fit.x1 - fit.x0), H * (1 - 2 * m) / (fit.y1 - fit.y0));
      ppm = clamp(ppm, 0.2, 400);
      if (o.pixelsPerMm && o.origin) { ox = o.origin[0]; oy = o.origin[1]; }
      else if (o.pixelsPerMm) { ox = W / 2 - bcx * ppm; oy = H / 2 - bcy * ppm; }
      else { ox = W / 2 - ((fit.x0 + fit.x1) / 2 - px + bcx) * ppm; oy = H / 2 - ((fit.y0 + fit.y1) / 2 - py + bcy) * ppm; }
      g = { kind: GARMENT[o.garment] ? o.garment : 'tshirt', gx: ox + (bcx - px) * ppm, gy: oy + (bcy - py) * ppm, x: px, y: py };
    } else {
      if (o.hoop && c && c.hoop) { hoopBox = hoopGeometry(c.hoop); fit = { x0: -hoopBox.out, y0: -hoopBox.out - hoopBox.screw, x1: c.hoop.width + hoopBox.out, y1: c.hoop.height + hoopBox.out }; }
      else if (b) fit = { x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY };
      else fit = { x0: bcx - 40, y0: bcy - 40, x1: bcx + 40, y1: bcy + 40 };
      ppm = o.pixelsPerMm || Math.min(60, Math.min(W * (1 - 2 * m) / Math.max(1, fit.x1 - fit.x0), H * (1 - 2 * m) / Math.max(1, fit.y1 - fit.y0)));
      ppm = clamp(ppm, 0.2, 400);
      if (o.pixelsPerMm && o.origin) { ox = o.origin[0]; oy = o.origin[1]; }
      else { ox = W / 2 - (fit.x0 + fit.x1) / 2 * ppm; oy = H / 2 - (fit.y0 + fit.y1) / 2 * ppm; }
    }
    /* whole pixels keep the cloth pattern and the stitches exactly repeatable */
    if (!(o.pixelsPerMm && o.origin)) { ox = Math.round(ox); oy = Math.round(oy); }
    return {
      ppm: ppm, ox: ox, oy: oy, garment: g, fit: fit,
      design: b ? { x: b.minX * ppm + ox, y: b.minY * ppm + oy, width: bw * ppm, height: bh * ppm } : null
    };
  }
  function hoopGeometry(hoop) { return { gap: 7, ring: 9, out: 16, screw: 12, radius: Math.min(hoop.width, hoop.height) * 0.3 }; }

  /* ================= canvas helpers ================= */
  function makeCanvas(w, h) {
    var cv;
    if (typeof document !== 'undefined' && document.createElement) { cv = document.createElement('canvas'); cv.width = w; cv.height = h; return cv; }
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    return null;
  }
  function rgba(rgb, a) { return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')'; }
  function mixRgb(a, b, t) { return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]; }
  function lightDir(o) { var a = o.lightAngle * Math.PI / 180; return { x: Math.sin(a), y: -Math.cos(a) }; }   /* towards the light, on screen */

  /* Draw something blurred without ctx.filter (Safari has none): draw it far off to the left and let only its
     shadow land on the canvas. T = { k, x, y }: millimetres -> pixels. */
  function soft(ctx, T, blurMm, color, draw) {
    var OFF = 30000;
    ctx.save();
    ctx.setTransform(T.k, 0, 0, T.k, T.x - OFF, T.y);
    ctx.shadowColor = color; ctx.shadowBlur = Math.max(0.01, blurMm * T.k * 2); ctx.shadowOffsetX = OFF; ctx.shadowOffsetY = 0;
    ctx.fillStyle = '#000'; ctx.strokeStyle = '#000'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    draw(ctx);
    ctx.restore();
  }
  function strokePath(ctx, cmds, width, mirror) {
    ctx.beginPath(); trace(ctx, cmds, 1); if (mirror) trace(ctx, cmds, -1); ctx.lineWidth = width; ctx.stroke();
  }

  /* ================= garment parts ================= */
  var TEE = {
    frontNeck: [['M', 92, 0], ['C', 92, 52, 55, 92, 0, 92]],
    ribOuter: [['M', 113, 6.5], ['C', 113, 64, 68, 115, 0, 115]],
    backRib: [['M', 0, 36], ['Q', 52, 34, 86, 19]],
    armhole: [['M', 238, 44], ['C', 226, 110, 236, 180, 262, 222]],
    sleeveHem: [['M', 367, 183], ['L', 287, 277]],
    hem: [['M', 261, 708], ['Q', 130, 722, 0, 720]]
  };
  var HOOD = {
    opening: [['M', 0, -176], ['C', 50, -172, 80, -100, 70, -36], ['C', 62, 12, 30, 52, 0, 74]],
    openingHem: [['M', 0, -198], ['C', 66, -194, 104, -104, 92, -30], ['C', 84, 18, 56, 52, 40, 70]],
    neckSeam: [['M', 112, 12], ['C', 102, 56, 62, 88, 0, 98]],
    armhole: [['M', 262, 62], ['C', 244, 130, 250, 210, 272, 262]],
    cuff: [['M', 372, 590], ['L', 316, 598]],
    hem: [['M', 270, 606], ['Q', 130, 612, 0, 611]],
    pocket: [['M', 0, 428], ['L', 116, 428], ['Q', 136, 430, 140, 446], ['C', 150, 500, 174, 540, 184, 560], ['L', 184, 606]],
    pocketOpen: [['M', 140, 446], ['C', 150, 500, 174, 540, 184, 560]],
    cordR: [['M', 38, 88], ['C', 44, 116, 34, 138, 41, 164]],
    cordL: [['M', -38, 88], ['C', -45, 112, -33, 130, -38, 152]]
  };

  /* soft light and dark across the garment: drawn small, used enlarged (so it is soft) */
  function drawShade(ctx, T, kind, dark, o) {
    var G = GARMENT[kind], L = lightDir(o), k = dark ? 'rgba(0,0,0,' : 'rgba(255,255,255,';
    function s(blur, alpha, fn) { soft(ctx, T, blur, k + alpha + ')', fn); }
    function line(cmds, w, mirror) { return function (c) { strokePath(c, cmds, w, mirror !== false); }; }
    var seed = o.seed | 0, i, body = kind === 'tshirt' ? { y0: 130, y1: 720, w: 240 } : { y0: 120, y1: 600, w: 250 };
    /* small uneven creases, different for every seed: cloth is never perfectly flat */
    function creases(n, alpha, salt) {
      for (i = 0; i < n; i++) {
        var x = (Core.rnd(i, seed + salt) - 0.5) * 2 * body.w, y = body.y0 + Core.rnd(i, seed + salt + 1) * (body.y1 - body.y0), a = (Core.rnd(i, seed + salt + 2) - 0.5) * 1.3 + (x > 0 ? 0.5 : -0.5);
        var len = 50 + 90 * Core.rnd(i, seed + salt + 3), dx = Math.sin(a) * len, dy = Math.cos(a) * len, bend = (Core.rnd(i, seed + salt + 4) - 0.5) * 40;
        s(9 + 10 * Core.rnd(i, seed + salt + 5), alpha * (0.5 + Core.rnd(i, seed + salt + 6)), line([['M', x, y], ['Q', x + dx / 2 + bend, y + dy / 2, x + dx, y + dy]], 5 + 6 * Core.rnd(i, seed + salt + 7), false));
      }
    }
    if (dark) {
      /* the cloth rolls away at the edges */
      s(16, 0.40, function (c) { outline(c, G.half); c.lineWidth = 14; c.stroke(); });
      s(5, 0.26, function (c) { outline(c, G.half); c.lineWidth = 3; c.stroke(); });
      if (kind === 'tshirt') {
        s(7, 0.36, line(TEE.armhole, 5));
        s(16, 0.34, line([['M', 258, 232], ['C', 215, 262, 175, 300, 150, 352]], 10));
        s(18, 0.26, line([['M', 252, 300], ['C', 226, 350, 200, 380, 184, 430]], 9));
        s(20, 0.26, line([['M', 252, 360], ['C', 226, 420, 210, 480, 204, 570]], 10));
        s(22, 0.22, line([['M', 110, 450], ['C', 100, 530, 112, 630, 104, 735]], 12));
        s(22, 0.18, line([['M', -20, 480], ['C', -34, 570, -18, 650, -30, 738]], 10, false));
        s(20, 0.16, line([['M', 170, 560], ['C', 178, 620, 168, 680, 176, 735]], 9));
        s(12, 0.30, line([['M', 300, 285], ['Q', 278, 252, 264, 226]], 8));
        s(9, 0.24, line([['M', 286, 120], ['Q', 320, 160, 340, 226]], 6));
        s(9, 0.18, line([['M', 262, 96], ['Q', 290, 150, 304, 250]], 5));
        s(14, 0.16, line([['M', 60, 130], ['C', 110, 150, 160, 150, 215, 120]], 8));
        s(4, 0.46, line(TEE.ribOuter, 2.5));
      } else {
        s(8, 0.36, line(HOOD.armhole, 6));
        s(18, 0.34, line([['M', 268, 276], ['C', 225, 310, 190, 350, 168, 400]], 11));
        s(18, 0.26, line([['M', 266, 340], ['C', 240, 390, 226, 430, 220, 500]], 9));
        s(16, 0.30, line([['M', 300, 330], ['C', 318, 420, 334, 500, 344, 590]], 10));
        s(12, 0.30, line([['M', 318, 220], ['C', 300, 250, 300, 290, 322, 318]], 8));
        s(11, 0.26, line([['M', 345, 430], ['C', 330, 452, 334, 480, 352, 500]], 7));
        s(11, 0.22, line([['M', 300, 150], ['C', 286, 180, 290, 206, 310, 228]], 6));
        s(11, 0.24, line([['M', 366, 520], ['C', 352, 540, 352, 560, 366, 580]], 6));
        s(22, 0.20, line([['M', 215, 440], ['C', 222, 500, 214, 560, 222, 606]], 11));
        s(18, 0.16, line([['M', 60, 250], ['C', 64, 310, 54, 360, 62, 420]], 9));
        s(9, 0.40, line(HOOD.neckSeam, 7));
        s(8, 0.40, line(HOOD.pocketOpen, 7));
        s(6, 0.26, function (c) { c.beginPath(); both(c, HOOD.pocket); c.lineWidth = 3; c.stroke(); });
        s(8, 0.34, line(HOOD.hem, 4)); s(6, 0.34, line(HOOD.cuff, 4));
        s(20, 0.30, line([['M', 128, -130], ['C', 146, -90, 142, -44, 122, -6]], 14));
        s(16, 0.22, line([['M', 40, -205], ['C', 84, -190, 112, -150, 122, -110]], 8));
        s(5, 0.34, function (c) { strokePath(c, HOOD.cordR, 5, false); strokePath(c, HOOD.cordL, 5, false); });
      }
      creases(9, 0.13, 100);
      /* the side away from the light is a little darker overall */
      s(90, 0.20, function (c) { c.beginPath(); c.arc(-L.x * 330, 360 - L.y * 330, 210, 0, 6.2832); c.fill(); });
    } else {
      s(80, 0.12, function (c) { c.beginPath(); c.arc(L.x * 200, 300 + L.y * 220, 170, 0, 6.2832); c.fill(); });
      if (kind === 'tshirt') {
        s(14, 0.16, line([['M', 240, 262], ['C', 200, 292, 165, 330, 142, 380]], 8));
        s(16, 0.12, line([['M', 238, 380], ['C', 214, 430, 196, 490, 190, 570]], 8));
        s(18, 0.12, line([['M', 132, 450], ['C', 124, 530, 134, 630, 128, 730]], 9));
        s(18, 0.10, line([['M', -50, 480], ['C', -62, 560, -48, 640, -58, 732]], 9, false));
        s(9, 0.13, line([['M', 300, 110], ['Q', 340, 150, 362, 200]], 7));
      } else {
        s(14, 0.15, line([['M', 250, 300], ['C', 212, 330, 180, 366, 160, 412]], 9));
        s(13, 0.15, line([['M', 318, 320], ['C', 336, 410, 350, 500, 360, 588]], 8));
        s(18, 0.10, line([['M', 238, 440], ['C', 246, 500, 238, 560, 244, 604]], 9));
        s(18, 0.13, line([['M', 100, -150], ['C', 124, -108, 122, -56, 104, -14]], 12));
        s(8, 0.12, function (c) { c.beginPath(); c.moveTo(-120, 438); c.lineTo(120, 438); c.lineWidth = 6; c.stroke(); });
      }
      creases(8, 0.07, 200);
    }
  }

  /* crisp details at full size: seams, ribs, hems, the hood, the cords */
  function ribLines(ctx, ppm, x0, x1, y0, y1, pitch, alpha) {
    if (ppm < 2.2) { ctx.fillStyle = 'rgba(0,0,0,' + (alpha * 0.45) + ')'; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); return; }
    ctx.beginPath();
    for (var x = Math.ceil(x0 / pitch) * pitch; x <= x1; x += pitch) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    ctx.lineWidth = pitch * 0.42; ctx.strokeStyle = 'rgba(0,0,0,' + alpha + ')'; ctx.stroke();
  }
  function topstitch(ctx, cmds, ppm, mirror, alpha) {
    ctx.save();
    ctx.lineCap = 'butt'; ctx.strokeStyle = 'rgba(0,0,0,' + (alpha || 0.3) + ')';
    if (ppm >= 3) ctx.setLineDash([2.4, 0.7]);
    strokePath(ctx, cmds, Math.max(0.42, 0.9 / ppm), mirror);
    ctx.restore();
  }
  function seam(ctx, cmds, ppm, mirror) {
    ctx.strokeStyle = 'rgba(0,0,0,0.36)'; strokePath(ctx, cmds, Math.max(0.55, 1 / ppm), mirror);
  }
  function drawDetails(ctx, T, kind, o, fabRgb) {
    var ppm = T.k, G = GARMENT[kind], i;
    ctx.save();
    ctx.setTransform(T.k, 0, 0, T.k, T.x, T.y);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (kind === 'tshirt') {
      /* inside of the back, seen through the neck opening */
      ctx.save();
      ctx.beginPath(); trace(ctx, TEE.frontNeck, 1); trace(ctx, reversed(TEE.frontNeck), -1, false); ctx.lineTo(-92, 0); ctx.quadraticCurveTo(-55, 16, 0, 18); ctx.quadraticCurveTo(55, 16, 92, 0); ctx.closePath();
      ctx.clip();
      var gr = ctx.createLinearGradient(0, 10, 0, 95); gr.addColorStop(0, 'rgba(0,0,0,0.30)'); gr.addColorStop(1, 'rgba(0,0,0,0.52)');
      ctx.fillStyle = gr; ctx.fillRect(-100, -5, 200, 105);
      /* back neck band and a label */
      ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.beginPath(); ctx.moveTo(-92, 0); ctx.quadraticCurveTo(-55, 16, 0, 18); ctx.quadraticCurveTo(55, 16, 92, 0); ctx.lineTo(86, 19); ctx.quadraticCurveTo(52, 34, 0, 36); ctx.quadraticCurveTo(-52, 34, -86, 19); ctx.closePath(); ctx.fill();
      seam(ctx, TEE.backRib, ppm, true);
      ctx.fillStyle = 'rgba(246,244,238,0.92)'; ctx.fillRect(-13, 36.5, 26, 15);
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-13, 36.5, 26, 1.2);
      ctx.restore();
      /* the front collar band: ribbed, slightly raised */
      ctx.save();
      ctx.beginPath(); trace(ctx, TEE.ribOuter, 1); trace(ctx, reversed(TEE.ribOuter), -1, false); ctx.lineTo(-92, 0); trace(ctx, TEE.frontNeck, -1, false); trace(ctx, reversed(TEE.frontNeck), 1, false); ctx.closePath();
      ctx.clip('evenodd');
      ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(-120, -5, 240, 125);
      if (ppm >= 2.2) {
        ctx.beginPath();
        for (i = -88; i <= 88; i++) { var a = i / 88 * 1.62, ca = Math.sin(a), sa = Math.cos(a); ctx.moveTo(ca * 80, -8 + sa * 92); ctx.lineTo(ca * 124, -8 + sa * 132); }
        ctx.lineWidth = 0.75; ctx.strokeStyle = 'rgba(0,0,0,0.16)'; ctx.stroke();
      }
      ctx.restore();
      seam(ctx, TEE.ribOuter, ppm, true);
      ctx.strokeStyle = 'rgba(0,0,0,0.30)'; strokePath(ctx, TEE.frontNeck, Math.max(0.5, 1 / ppm), true);
      topstitch(ctx, [['M', 116, 9], ['C', 116, 66, 70, 118.5, 0, 118.5]], ppm, true, 0.22);
      seam(ctx, TEE.armhole, ppm, true);
      topstitch(ctx, TEE.sleeveHem, ppm, true); topstitch(ctx, [['M', 364.5, 180], ['L', 284.5, 274]], ppm, true);
      topstitch(ctx, TEE.hem, ppm, true); topstitch(ctx, [['M', 261, 704.5], ['Q', 130, 718.5, 0, 716.5]], ppm, true);
    } else {
      /* ribbed cuffs and waistband */
      ctx.save(); ctx.beginPath(); ctx.moveTo(270, 606); ctx.lineTo(263, 668); ctx.quadraticCurveTo(130, 676, 0, 675); ctx.quadraticCurveTo(-130, 676, -263, 668); ctx.lineTo(-270, 606); ctx.quadraticCurveTo(-130, 612, 0, 611); ctx.quadraticCurveTo(130, 612, 270, 606); ctx.closePath(); ctx.clip();
      ribLines(ctx, ppm, -275, 275, 600, 680, 3.1, 0.2); ctx.restore();
      for (i = -1; i <= 1; i += 2) {
        ctx.save(); ctx.beginPath(); ctx.moveTo(372 * i, 590); ctx.lineTo(380 * i, 662); ctx.lineTo(318 * i, 670); ctx.lineTo(316 * i, 598); ctx.closePath(); ctx.clip();
        ctx.transform(1, 0, 0.06 * i, 1, -36 * i, 0); ribLines(ctx, ppm, i > 0 ? 300 : -400, i > 0 ? 400 : -300, 585, 675, 3.1, 0.2); ctx.restore();
      }
      seam(ctx, HOOD.hem, ppm, true); seam(ctx, HOOD.cuff, ppm, true);
      seam(ctx, HOOD.armhole, ppm, true);
      topstitch(ctx, [['M', 258.5, 63], ['C', 240.5, 131, 246.5, 211, 268.5, 263]], ppm, true, 0.2);
      /* pocket */
      ctx.strokeStyle = 'rgba(0,0,0,0.34)'; ctx.beginPath(); both(ctx, HOOD.pocket); ctx.lineWidth = Math.max(0.55, 1 / ppm); ctx.stroke();
      topstitch(ctx, [['M', 0, 432], ['L', 115, 432], ['Q', 132, 434, 136, 448]], ppm, true, 0.22);
      topstitch(ctx, [['M', 144, 445], ['C', 154, 499, 178, 539, 188, 559]], ppm, true, 0.22);
      /* inside of the hood */
      ctx.save();
      ctx.beginPath(); trace(ctx, HOOD.opening, 1); trace(ctx, reversed(HOOD.opening), -1, false); ctx.closePath();
      /* what shows through the opening is the lining of the back of the hood, lying in the hood's own shade: darker
         than the outside, deepest under the rim and down in the neck, but cloth, not a black hole */
      var hg = ctx.createLinearGradient(0, -176, 0, 74); hg.addColorStop(0, 'rgba(0,0,0,0.20)'); hg.addColorStop(0.55, 'rgba(0,0,0,0.26)'); hg.addColorStop(1, 'rgba(0,0,0,0.46)');
      ctx.fillStyle = hg; ctx.fill();
      ctx.save(); ctx.clip();
      ctx.strokeStyle = 'rgba(0,0,0,0.10)'; ctx.lineWidth = 30; ctx.stroke(); ctx.lineWidth = 16; ctx.stroke(); ctx.strokeStyle = 'rgba(0,0,0,0.14)'; ctx.lineWidth = 6; ctx.stroke();
      /* the seam down the middle of the hood, seen from inside */
      ctx.strokeStyle = 'rgba(0,0,0,0.16)'; ctx.lineWidth = Math.max(0.5, 1 / ppm); ctx.beginPath(); ctx.moveTo(0, -176); ctx.quadraticCurveTo(3, -60, 0, 74); ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = 'rgba(0,0,0,0.34)'; ctx.lineWidth = Math.max(0.6, 1 / ppm); ctx.stroke();
      ctx.restore();
      topstitch(ctx, HOOD.openingHem, ppm, true, 0.24);
      seam(ctx, HOOD.neckSeam, ppm, true);
      ctx.strokeStyle = 'rgba(0,0,0,0.20)'; strokePath(ctx, [['M', 0, -222], ['C', 3, -210, 2, -190, 0, -176]], Math.max(0.5, 1 / ppm), false);
      /* eyelets and cords */
      var cord = mixRgb(fabRgb, [255, 255, 255], 0.16), cordDark = mixRgb(fabRgb, [0, 0, 0], 0.42), metal = [176, 178, 182];
      for (i = -1; i <= 1; i += 2) {
        ctx.beginPath(); ctx.arc(38 * i, 86, 3.4, 0, 6.2832); ctx.fillStyle = rgba(metal, 1); ctx.fill();
        ctx.beginPath(); ctx.arc(38 * i, 86, 1.7, 0, 6.2832); ctx.fillStyle = 'rgba(20,20,22,0.9)'; ctx.fill();
        var cc = i > 0 ? HOOD.cordR : HOOD.cordL, endp = cc[1];
        ctx.strokeStyle = rgba(cordDark, 1); strokePath(ctx, cc, 4.6, false);
        ctx.strokeStyle = rgba(cord, 1); strokePath(ctx, cc, 2.8, false);
        ctx.lineCap = 'butt'; ctx.strokeStyle = rgba(metal, 1); ctx.beginPath(); ctx.moveTo(endp[5], endp[6] - 1); ctx.lineTo(endp[5] + 1.6 * i, endp[6] + 12); ctx.lineWidth = 4.4; ctx.stroke(); ctx.lineCap = 'round';
      }
    }
    ctx.restore();
  }

  /* an embroidery hoop lying on the swatch */
  function drawHoop(ctx, c, lay, o) {
    if (!c.hoop) return;
    var hg = hoopGeometry(c.hoop), k = lay.ppm, w = c.hoop.width, h = c.hoop.height, L = lightDir(o);
    function rr(inset, r) {
      var x0 = -inset, y0 = -inset, x1 = w + inset, y1 = h + inset; r = Math.max(1, r);
      ctx.moveTo(x0 + r, y0); ctx.lineTo(x1 - r, y0); ctx.arcTo(x1, y0, x1, y0 + r, r); ctx.lineTo(x1, y1 - r); ctx.arcTo(x1, y1, x1 - r, y1, r);
      ctx.lineTo(x0 + r, y1); ctx.arcTo(x0, y1, x0, y1 - r, r); ctx.lineTo(x0, y0 + r); ctx.arcTo(x0, y0, x0 + r, y0, r); ctx.closePath();
    }
    function ringPath(a, b) { ctx.beginPath(); rr(b, hg.radius + b); rr(a, hg.radius + a); }
    ctx.save();
    ctx.setTransform(k, 0, 0, k, lay.ox, lay.oy);
    var mid = (hg.gap + hg.out) / 2, sy = -hg.out - hg.screw * 0.62 + 1.6, gx = L.x * w * 0.8, gy = L.y * h * 0.8;
    function lit(a, b2, c2) {   /* a on the light's side, c2 on the far side */
      var g = ctx.createLinearGradient(w / 2 + gx, h / 2 + gy, w / 2 - gx, h / 2 - gy);
      g.addColorStop(0, a); g.addColorStop(0.5, b2); g.addColorStop(1, c2); return g;
    }
    function band(inset, width, style) { ctx.beginPath(); rr(inset, hg.radius + inset); ctx.lineWidth = width; ctx.strokeStyle = style; ctx.stroke(); }
    /* the hoop's shadow on the cloth: a soft wide one and a tight dark one where plastic meets cloth */
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.30)'; ctx.shadowBlur = 5 * k; ctx.shadowOffsetX = -L.x * 2.6 * k; ctx.shadowOffsetY = -L.y * 2.6 * k;
    ctx.fillStyle = '#d9d6cf'; ringPath(hg.gap, hg.out); ctx.fill('evenodd');
    ctx.fillRect(w / 2 - 15, -hg.out - hg.screw + 1, 30, hg.screw + 2);
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 1.1 * k; ctx.shadowOffsetX = -L.x * 0.5 * k; ctx.shadowOffsetY = -L.y * 0.5 * k;
    ringPath(hg.gap, hg.out); ctx.fill('evenodd'); ctx.restore();
    /* the lug that holds the screw: moulded plastic with a rounded top */
    var sg = ctx.createLinearGradient(0, -hg.out - hg.screw, 0, -hg.out + 2);
    sg.addColorStop(0, '#d8d5cd'); sg.addColorStop(0.14, '#f6f4ef'); sg.addColorStop(0.7, '#e2dfd8'); sg.addColorStop(1, '#c4c0b7');
    ctx.fillStyle = sg; ctx.fillRect(w / 2 - 15, -hg.out - hg.screw + 1, 30, hg.screw + 2);
    ctx.fillStyle = 'rgba(0,0,0,0.30)'; ctx.fillRect(w / 2 - 0.6, -hg.out - hg.screw + 1, 1.2, hg.screw + 1);       /* the slot the screw closes */
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(w / 2 - 15, -hg.out - hg.screw + 1, 0.5, hg.screw + 1);
    ctx.fillStyle = 'rgba(0,0,0,0.16)'; ctx.fillRect(w / 2 + 14.5, -hg.out - hg.screw + 1, 0.5, hg.screw + 1);
    /* the screw: a steel rod with a knurled brass thumb nut */
    var mg = ctx.createLinearGradient(0, sy - 1.7, 0, sy + 1.7);
    mg.addColorStop(0, '#8d9197'); mg.addColorStop(0.3, '#f4f5f7'); mg.addColorStop(0.55, '#b3b7bd'); mg.addColorStop(1, '#6f7379');
    ctx.fillStyle = mg; ctx.fillRect(w / 2 - 19, sy - 1.7, 38, 3.4);
    ctx.strokeStyle = 'rgba(0,0,0,0.20)'; ctx.lineWidth = 0.25; ctx.beginPath();
    for (var ti = -18.4; ti < -15.2; ti += 0.8) { ctx.moveTo(w / 2 + ti, sy - 1.7); ctx.lineTo(w / 2 + ti + 0.4, sy + 1.7); }
    ctx.stroke();
    var ng = ctx.createLinearGradient(0, sy - 5, 0, sy + 5);
    ng.addColorStop(0, '#7b6a3f'); ng.addColorStop(0.22, '#f1e2ae'); ng.addColorStop(0.5, '#c9b06a'); ng.addColorStop(0.8, '#9c8448'); ng.addColorStop(1, '#5f5230');
    ctx.fillStyle = ng; ctx.beginPath(); ctx.moveTo(w / 2 + 17.5, sy - 4.4); ctx.arcTo(w / 2 + 25.5, sy - 4.4, w / 2 + 25.5, sy, 1.2); ctx.arcTo(w / 2 + 25.5, sy + 4.4, w / 2 + 17.5, sy + 4.4, 1.2);
    ctx.lineTo(w / 2 + 17.5, sy + 4.4); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(40,30,10,0.28)'; ctx.lineWidth = 0.3; ctx.beginPath();
    for (ti = 18.3; ti < 25.2; ti += 0.9) { ctx.moveTo(w / 2 + ti, sy - 4.2); ctx.lineTo(w / 2 + ti, sy + 4.2); }
    ctx.stroke();
    /* two rings of moulded plastic. Each has a flat top and two rounded shoulders: the shoulder that faces the
       light is bright, the one that faces away is in shade, and on the far side of the hoop it is the other way
       round. That is what makes it a solid thing and not a white outline. */
    ctx.fillStyle = lit('#f3f1ec', '#ebe8e1', '#dcd8cf'); ringPath(hg.gap, hg.out); ctx.fill('evenodd');
    var rings = [[hg.gap, mid - 0.25], [mid + 0.25, hg.out]], ri, a0, a1, bw;
    for (ri = 0; ri < 2; ri++) {
      a0 = rings[ri][0]; a1 = rings[ri][1]; bw = Math.min(1.5, (a1 - a0) * 0.34);
      band(a1 - bw / 2, bw, lit('#ffffff', '#e4e1d9', '#a39e92'));          /* outer shoulder */
      band(a1 - bw * 0.25, bw * 0.5, lit('rgba(255,255,255,0.5)', 'rgba(120,115,105,0.10)', 'rgba(60,55,45,0.32)'));
      band(a0 + bw / 2, bw, lit('#aca79b', '#dedbd3', '#fdfcfa'));          /* inner shoulder */
      band(a0 + bw * 0.25, bw * 0.5, lit('rgba(60,55,45,0.30)', 'rgba(120,115,105,0.08)', 'rgba(255,255,255,0.5)'));
      band(a0 + bw + 0.35, 0.3, lit('rgba(255,255,255,0.0)', 'rgba(255,255,255,0.25)', 'rgba(255,255,255,0.55)'));   /* a glint along the edge of the flat top */
    }
    band(mid, 0.5, 'rgba(30,26,20,0.62)');                                  /* the gap between the rings, where the cloth is gripped */
    band(hg.gap, Math.max(0.3, 0.7 / k), 'rgba(0,0,0,0.28)'); band(hg.out, Math.max(0.3, 0.7 / k), 'rgba(0,0,0,0.20)');
    ctx.restore();
  }

  /* ================= compositing a scene from the stitched cloth layer ================= */
  function buildShade(st) {
    var W = st.W, H = st.H, s = Math.min(1, 560 / Math.max(W, H)), w = Math.max(2, Math.round(W * s)), h = Math.max(2, Math.round(H * s));
    var T = { k: st.lay.ppm * w / W, x: st.lay.garment.gx * w / W, y: st.lay.garment.gy * h / H }, kind = st.lay.garment.kind;
    var d = makeCanvas(w, h), l = makeCanvas(w, h), dc = d.getContext('2d'), lc = l.getContext('2d');
    dc.fillStyle = '#fff'; dc.fillRect(0, 0, w, h); drawShade(dc, T, kind, true, st.o);
    lc.fillStyle = '#000'; lc.fillRect(0, 0, w, h); drawShade(lc, T, kind, false, st.o);
    st.shadeDark = d; st.shadeLight = l;
  }
  function composite(st) {
    var ctx = st.ctx, W = st.W, H = st.H, o = st.o, lay = st.lay;
    if (st.direct) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    if (o.scene !== 'garment') {
      ctx.drawImage(st.layer, 0, 0);
      if (o.hoop) drawHoop(ctx, st.c, lay, o);
      ctx.restore(); return;
    }
    var g = lay.garment, G = GARMENT[g.kind], T = { k: lay.ppm, x: g.gx, y: g.gy }, L = lightDir(o), fab = Core.parseColor(o.fabricColor) || [232, 228, 220];
    /* the table and the garment's shadow on it do not change while the tiles arrive: drawn once per render (the
       large soft shadow is the slowest thing in the scene) */
    if (!st.under) {
      st.under = makeCanvas(W, H);
      var ux = st.under.getContext('2d');
      if (!o.transparent) {
        var bd = Core.parseColor(o.backdrop) || [241, 239, 234];
        ux.fillStyle = rgba(bd, 1); ux.fillRect(0, 0, W, H);
        var rg = ux.createRadialGradient(W / 2 + L.x * W * 0.2, H / 2 + L.y * H * 0.2, 0, W / 2, H / 2, Math.max(W, H) * 0.8);
        rg.addColorStop(0, 'rgba(255,255,255,0.35)'); rg.addColorStop(0.6, 'rgba(255,255,255,0)'); rg.addColorStop(1, 'rgba(0,0,0,0.10)');
        ux.fillStyle = rg; ux.fillRect(0, 0, W, H);
      }
      ux.shadowColor = 'rgba(0,0,0,0.34)'; ux.shadowBlur = Math.min(120, 9 * T.k); ux.shadowOffsetX = -L.x * 5 * T.k; ux.shadowOffsetY = -L.y * 5 * T.k + 2 * T.k;
      ux.setTransform(T.k, 0, 0, T.k, T.x, T.y); outline(ux, G.half); ux.fillStyle = rgba(fab, 1); ux.fill();
    }
    ctx.drawImage(st.under, 0, 0);
    /* the cloth, cut to the garment */
    ctx.save();
    ctx.setTransform(T.k, 0, 0, T.k, T.x, T.y); outline(ctx, G.half); ctx.clip();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(st.layer, 0, 0);
    if (st.shadeDark) {
      ctx.imageSmoothingEnabled = true; if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
      ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(st.shadeDark, 0, 0, W, H);
      ctx.globalCompositeOperation = 'screen'; ctx.drawImage(st.shadeLight, 0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }
    drawDetails(ctx, T, g.kind, o, fab);
    ctx.restore();
    /* a fine dark edge so the garment does not look cut out */
    ctx.save(); ctx.setTransform(T.k, 0, 0, T.k, T.x, T.y); outline(ctx, G.half); ctx.lineWidth = Math.max(0.4, 0.8 / T.k); ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.stroke(); ctx.restore();
    ctx.restore();
  }

  /* ================= workers ================= */
  var pool = { list: [], broken: false, url: null };
  function workerMain(Core) {
    var jobs = {};
    self.onmessage = function (ev) {
      var m = ev.data;
      try {
        if (m.t === 'job') { jobs[m.id] = Core.createJob(m.c, m.view, m.o, m.tile); if (m.ss) jobs[m.id].ss = m.ss; }
        else if (m.t === 'tile') {
          var job = jobs[m.id]; if (!job) { self.postMessage({ t: 'gone', id: m.id, tx: m.tx, ty: m.ty }); return; }
          var r = Core.renderTile(job, m.tx, m.ty);
          self.postMessage({ t: 'tile', id: m.id, tx: m.tx, ty: m.ty, x: r.x, y: r.y, w: r.w, h: r.h, data: r.data.buffer }, [r.data.buffer]);
        } else if (m.t === 'drop') delete jobs[m.id];
      } catch (e) { self.postMessage({ t: 'error', id: m.id, tx: m.tx, ty: m.ty, message: String(e && e.message || e) }); }
    };
  }
  function workerCount(want) {
    var hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
    return clamp(Math.min(want, hc - 1), 1, 4);
  }
  function makeWorker() {
    var wk = { w: new Worker(pool.url), dead: false, subs: {} };
    wk.w.onmessage = function (ev) { var m = ev.data, f = m && wk.subs[m.id]; if (f) f(m); };
    wk.w.onerror = function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); killWorker(wk); };
    return wk;
  }
  function getWorkers(n) {
    if (pool.broken || typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL || !Core || !Core.factory) return [];
    try {
      if (!pool.url) {
        var src = 'var RealisticCore=(' + Core.factory.toString() + ')();(' + workerMain.toString() + ')(RealisticCore);';
        pool.url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      }
      while (pool.list.length < n) pool.list.push(makeWorker());
    } catch (e) { pool.broken = true; return []; }
    return pool.list.filter(function (x) { return !x.dead; }).slice(0, n);
  }
  function dispose() {
    var old = pool.list, i; pool.list = [];
    for (i = 0; i < old.length; i++) killWorker(old[i]);          /* renders still running finish on the page's own thread */
    if (pool.url) { try { URL.revokeObjectURL(pool.url); } catch (e2) { /* nothing to do */ } pool.url = null; }
    pool.broken = false;
  }

  /* ================= render ================= */
  var nextId = 1, active = (typeof WeakMap !== 'undefined') ? new WeakMap() : null, compiled = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  function compileCached(design, o) {
    var key = o.seed + '|' + o.threadWidth, hit, c;
    if (compiled && design && typeof design === 'object') { hit = compiled.get(design); if (hit && hit.key === key && hit.cmds === commandsOf(design)) return hit.c; }
    c = Core.compile(design, o);
    if (compiled && design && typeof design === 'object') { try { compiled.set(design, { key: key, c: c, cmds: commandsOf(design) }); } catch (e) { /* frozen or exotic object: no cache */ } }
    return c;
  }
  function commandsOf(d) { try { return (d.ir && d.ir.commands) || d.stitches || d.commands || null; } catch (e) { return null; } }
  function plainCompiled(c) {
    return { n: c.n, ax: c.ax, ay: c.ay, bx: c.bx, by: c.by, thread: c.thread, squeeze: c.squeeze, jumps: c.jumps, colors: c.colors, loft: c.loft, bounds: c.bounds, hoop: c.hoop };
  }
  function failed(code, message, t0, warnings) {
    return { ok: false, error: { code: code, message: message }, warnings: warnings || [], firstFrameMs: 0, totalMs: now() - t0, cancelled: false };
  }
  function resolved(v) { var p = Promise.resolve(v); p.cancel = function () {}; return p; }

  /* A browser can throw a canvas's picture away (the graphics process restarts, a laptop changes GPU). The canvas
     comes back blank with a 'contextrestored' event; whatever was last drawn on it is then drawn again. */
  var lastDraw = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  function remember(canvas, design, options) {
    if (!lastDraw || typeof canvas.addEventListener !== 'function') return;
    var seen = lastDraw.get(canvas), o = {}, k;
    for (k in (options || {})) if (k !== 'onProgress' && k !== 'onFirstFrame') o[k] = options[k];
    lastDraw.set(canvas, { design: design, options: o });
    if (!seen) canvas.addEventListener('contextrestored', function () { var l = lastDraw.get(canvas); if (l) render(canvas, l.design, l.options); });
  }

  /*
   * Realistic.render(canvas, design, options) -> Promise<stats> with .cancel(). Never throws, never rejects.
   */
  function render(canvas, design, options) {
    var t0 = now(), st = null;
    try {
      if (!Core) return resolved(failed('CORE_MISSING', 'js/realistic/core.js must be loaded before realistic.js.', t0));
      var ctx = null;
      try { ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null; } catch (e0) { ctx = null; }
      if (!ctx) return resolved(failed('NO_CANVAS', 'render needs a canvas element (or OffscreenCanvas) with a 2D context.', t0));
      var W = canvas.width | 0, H = canvas.height | 0;
      if (W < 1 || H < 1) return resolved(failed('EMPTY_CANVAS', 'The canvas has no size.', t0));
      var o = Core.normalizeOptions(options), warnings = o.warnings.slice();
      var c = compileCached(design, o), tCompiled = now();
      warnings = warnings.concat(c.warnings);
      var lay = layout(c, o, W, H);
      if (o.scene === 'garment' && c.bounds && o.placement === 'left-chest' && c.bounds.width > 130)
        warnings.push({ code: 'LARGE_FOR_PLACEMENT', message: 'This design is ' + Math.round(c.bounds.width) + ' mm wide; a left-chest design is usually under 110 mm.' });
      var prev = active && active.get(canvas); if (prev) prev.cancel(true);
      var garmentScene = o.scene === 'garment', direct = !garmentScene && !o.hoop;
      var coreOpts = o;
      if (garmentScene && o.transparent) { coreOpts = {}; for (var k in o) coreOpts[k] = o[k]; coreOpts.transparent = false; }
      st = {
        progressive: !(options && options.progressive === false), lastComp: 0, compMs: 0,
        id: nextId++, canvas: canvas, ctx: ctx, W: W, H: H, o: o, c: c, lay: lay, direct: direct, layer: null, lctx: null,
        view: { width: W, height: H, ppm: lay.ppm, ox: lay.ox, oy: lay.oy, falloff: garmentScene ? 0 : 0.09 },
        coreOpts: coreOpts, cancelled: false, done: false, first: 0, dirty: false, raf: 0, workers: [], queue: [], pending: 0, total: 0, finished: 0,
        job: null, resolve: null, quick: false, usedWorkers: 0, onProgress: options && typeof options.onProgress === 'function' ? options.onProgress : null,
        onFirstFrame: options && typeof options.onFirstFrame === 'function' ? options.onFirstFrame : null
      };
      if (direct) { st.layer = canvas; st.lctx = ctx; }
      else { st.layer = makeCanvas(W, H); st.lctx = st.layer && st.layer.getContext('2d'); if (!st.lctx) return resolved(failed('NO_CANVAS', 'A second canvas could not be created.', t0, warnings)); }
      if (garmentScene) buildShade(st);
      st.lctx.setTransform(1, 0, 0, 1, 0, 0); st.lctx.globalCompositeOperation = 'source-over'; st.lctx.globalAlpha = 1;

      var promise = new Promise(function (res) { st.resolve = res; });
      st.finish = function () {
        if (st.done) return; st.done = true;
        if (st.raf) { cancelFrame(st.raf); st.raf = 0; }
        if (!st.cancelled) { try { composite(st); } catch (e) { warnings.push({ code: 'SCENE_FAILED', message: String(e && e.message || e) }); } if (!st.first) st.first = now(); }
        st.under = null;
        releaseWorkers(st);
        if (active && active.get(canvas) === handle) active.delete(canvas);
        st.resolve({
          ok: !st.cancelled, cancelled: st.cancelled, firstFrameMs: (st.first || now()) - t0, totalMs: now() - t0, compileMs: tCompiled - t0,
          stitches: c.stitches, segments: c.n, threads: c.threads, width: W, height: H, pixelsPerMm: lay.ppm, origin: [lay.ox, lay.oy],
          designRect: lay.design, garment: lay.garment ? { kind: lay.garment.kind, x: lay.garment.gx, y: lay.garment.gy } : null,
          supersample: Core.supersampleFor(lay.ppm), tiles: st.total, workers: st.usedWorkers, quickFrame: st.quick, warnings: warnings
        });
      };
      var handle = { cancel: function (silent) { if (st.done) return; st.cancelled = true; st.finish(); } };
      promise.cancel = function () { handle.cancel(); };
      if (active) active.set(canvas, handle);
      remember(canvas, design, options);

      var cost = Core.estimateCost(c, st.view, o), wantSync = (options && options.sync === true) || cost <= SYNC_COST;
      /* where thin thread is supersampled a 256 px tile can take well over 100 ms; on the page's own thread that
         is a visible hitch. The size depends only on the zoom, so workers and the page draw the very same tiles. */
      var tile = Core.supersampleFor(lay.ppm) >= 2 ? TILE / 2 : TILE;
      st.job = null;
      st.nbx = Math.max(1, Math.ceil(W / tile)); st.nby = Math.max(1, Math.ceil(H / tile)); st.tile = tile; st.total = st.nbx * st.nby;

      if (wantSync) {
        st.job = Core.createJob(c, st.view, coreOpts, tile);
        for (var ty = 0; ty < st.nby; ty++) for (var tx = 0; tx < st.nbx; tx++) putTile(st, Core.renderTile(st.job, tx, ty));
        st.finish();
        return promise;
      }
      /* a quick, coarse picture now; the real one arrives tile by tile */
      if (!(options && options.quickFrame === false)) {
        try { quickFrame(st, cost); composite(st); st.first = now(); st.quick = true; if (st.onFirstFrame) st.onFirstFrame({ firstFrameMs: st.first - t0 }); }
        catch (e1) { warnings.push({ code: 'QUICK_FRAME_FAILED', message: String(e1 && e1.message || e1) }); }
      }
      /* tiles: stitched ones first, from the middle of the design outwards */
      var cx = lay.design ? lay.design.x + lay.design.width / 2 : W / 2, cy = lay.design ? lay.design.y + lay.design.height / 2 : H / 2, q = [], dr = lay.design;
      for (var y = 0; y < st.nby; y++) for (var x = 0; x < st.nbx; x++) {
        var mx = x * tile + tile / 2, my = y * tile + tile / 2, hit = dr && x * tile < dr.x + dr.width + 8 && (x + 1) * tile > dr.x - 8 && y * tile < dr.y + dr.height + 8 && (y + 1) * tile > dr.y - 8;
        q.push({ tx: x, ty: y, d: (mx - cx) * (mx - cx) + (my - cy) * (my - cy) + (hit ? 0 : 1e12) });
      }
      q.sort(function (a, b) { return a.d - b.d; });
      st.queue = q;
      var ws = (options && options.workers === false) ? [] : getWorkers(workerCount(Math.ceil(st.total / 2)));
      if (ws.length) startWorkers(st, ws); else mainLoop(st);
      return promise;
    } catch (e) {
      if (st && st.resolve && !st.done) { st.cancelled = true; try { st.finish(); } catch (e3) { /* give up quietly */ } }
      return resolved(failed('RENDER_FAILED', String(e && e.message || e), t0));
    }
  }

  var requestFrame = (typeof requestAnimationFrame === 'function') ? function (f) { return requestAnimationFrame(f); } : function (f) { return setTimeout(f, 16); };
  var cancelFrame = (typeof cancelAnimationFrame === 'function') ? function (h) { cancelAnimationFrame(h); } : function (h) { clearTimeout(h); };

  function putTile(st, r) {
    if (!r || !r.w || !r.h) return;
    var data = r.data instanceof Uint8ClampedArray ? r.data : new Uint8ClampedArray(r.data), img;
    try { img = new ImageData(data, r.w, r.h); }
    catch (e) { img = st.lctx.createImageData(r.w, r.h); img.data.set(data); }
    st.lctx.putImageData(img, r.x, r.y);
  }
  function tileDone(st) {
    st.finished++;
    if (st.onProgress) { try { st.onProgress(st.finished / st.total); } catch (e) { /* the caller's problem */ } }
    if (st.finished >= st.total) { st.finish(); return; }
    /* dressing the scene costs more the larger the canvas: never spend more than about a fifth of the time on it,
       and not at all when nobody is watching (an export) */
    if (!st.direct && !st.raf && st.progressive && now() - st.lastComp >= Math.max(50, 5 * st.compMs)) st.raf = requestFrame(function () {
      st.raf = 0; if (st.done) return;
      var t = now(); try { composite(st); if (!st.first) st.first = now(); } catch (e) { /* the final composite reports it */ }
      st.lastComp = now(); st.compMs = st.lastComp - t;
    });
    if (!st.first && st.direct) st.first = now();
  }
  function quickFrame(st, cost) {
    /* never more than about 300,000 pixels: the quick frame is there to be quick, also on a very large canvas */
    var qs = clamp(Math.min(Math.sqrt(QUICK_COST / cost), Math.sqrt(300000 / (st.W * st.H))), 0.12, 0.5), w = Math.max(1, Math.round(st.W * qs)), h = Math.max(1, Math.round(st.H * qs));
    var view = { width: w, height: h, ppm: st.view.ppm * w / st.W, ox: st.view.ox * w / st.W, oy: st.view.oy * h / st.H, falloff: st.view.falloff, draft: true };
    var job = Core.createJob(st.c, view, st.coreOpts, 1024), cv = makeCanvas(w, h), cx = cv.getContext('2d'), tx, ty, r;
    job.ss = 1;
    for (ty = 0; ty < job.nby; ty++) for (tx = 0; tx < job.nbx; tx++) { r = Core.renderTile(job, tx, ty); if (r.w && r.h) cx.putImageData(new ImageData(r.data, r.w, r.h), r.x, r.y); }
    st.lctx.save(); st.lctx.imageSmoothingEnabled = true; if (st.lctx.imageSmoothingQuality) st.lctx.imageSmoothingQuality = 'high';
    st.lctx.globalCompositeOperation = 'copy'; st.lctx.drawImage(cv, 0, 0, st.W, st.H); st.lctx.restore();
  }
  function mainLoop(st) {
    if (!st.job) st.job = Core.createJob(st.c, st.view, st.coreOpts, st.tile);
    var step = function () {
      if (st.done) return;
      var t = now();
      try {
        while (st.queue.length && now() - t < 14) { var q = st.queue.shift(); putTile(st, Core.renderTile(st.job, q.tx, q.ty)); tileDone(st); if (st.done) return; }
      } catch (e) { st.cancelled = true; st.finish(); return; }
      if (st.queue.length) setTimeout(step, 0); else if (!st.pending && st.finished < st.total) { st.finished = st.total; st.finish(); }
    };
    setTimeout(step, 0);
  }
  /* Several renders (on different canvases) may use the same workers at once: every worker hands each answer to
     the render that asked, by job id. A render gives each worker one tile at a time. */
  function startWorkers(st, ws) {
    var payload = { t: 'job', id: st.id, c: plainCompiled(st.c), view: st.view, o: st.coreOpts, tile: st.tile };
    st.usedWorkers = ws.length;
    st.workers = ws.map(function (wk) { return { wk: wk, busy: null }; });
    var bad = [];
    st.workers.forEach(function (slot) {
      var wk = slot.wk;
      wk.subs[st.id] = function (m) {          /* m is null when the worker itself died */
        if (st.done) return;
        var q = slot.busy; slot.busy = null; if (q) st.pending--;
        if (m && m.t === 'tile') {
          try { putTile(st, m); } catch (e) { st.queue.push({ tx: m.tx, ty: m.ty }); killWorker(wk); return; }
          tileDone(st); if (!st.done) feed(st, slot);
          return;
        }
        if (q) st.queue.push(q);
        if (m) { killWorker(wk); return; }     /* it answered 'error' or 'gone': stop trusting it; this comes back here with null */
        st.workers = st.workers.filter(function (x) { return x !== slot; });
        if (!st.workers.length) { st.usedWorkers = 0; mainLoop(st); }
        else st.workers.forEach(function (x) { if (!x.busy) feed(st, x); });
      };
      try { wk.w.postMessage(payload); } catch (e) { bad.push(wk); }
    });
    bad.forEach(killWorker);                 /* every worker has the job before any tile is asked for */
    st.workers.slice().forEach(function (slot) { feed(st, slot); });
  }
  function feed(st, slot) {
    if (st.done || slot.wk.dead || slot.busy) return;
    var q = st.queue.shift(); if (!q) return;
    slot.busy = q; st.pending++;
    try { slot.wk.w.postMessage({ t: 'tile', id: st.id, tx: q.tx, ty: q.ty }); } catch (e) { killWorker(slot.wk); }
  }
  /* a worker failed: stop using workers for good (until dispose) and let every render that used it carry on
     with its other workers or on the page's own thread */
  function killWorker(wk) {
    if (wk.dead) return;
    wk.dead = true; pool.broken = true;
    try { wk.w.terminate(); } catch (e) { /* already gone */ }
    var subs = wk.subs, k; wk.subs = {};
    for (k in subs) { try { subs[k](null); } catch (e2) { /* that render's problem */ } }
  }
  function releaseWorkers(st) {
    st.workers.forEach(function (slot) {
      delete slot.wk.subs[st.id]; slot.busy = null;
      if (!slot.wk.dead) { try { slot.wk.w.postMessage({ t: 'drop', id: st.id }); } catch (e) { /* gone */ } }
    });
    st.workers = [];
  }

  /* ================= export ================= */
  /*
   * Realistic.exportImage(design, options) -> Promise<Blob> (image/png). options are render's plus
   * width, height (pixels of the view, default 1200 x 1200), scale (1 to 4, default 2) and transparent.
   * Rejects with an Error carrying .code when no picture can be made.
   */
  function exportImage(design, options) {
    return new Promise(function (resolve, reject) {
      function fail(code, message) { var e = new Error(message); e.code = code; reject(e); }
      try {
        var o = {}, k; options = (options && typeof options === 'object') ? options : {};
        for (k in options) o[k] = options[k];
        var w = Number(o.width), h = Number(o.height), scale = Number(o.scale), warnings = [];
        if (!(w >= 1)) w = 1200; if (!(h >= 1)) h = o.scene === 'garment' ? 1400 : 1200;
        if (!(scale > 0)) scale = 2; scale = clamp(scale, 1, 4);
        w = Math.round(w); h = Math.round(h);
        var asked = scale;
        while (scale > 1 && (w * scale > MAX_SIDE || h * scale > MAX_SIDE || w * scale * h * scale > MAX_PIXELS)) scale = Math.max(1, scale - 0.25);
        if (w * scale > MAX_SIDE || h * scale > MAX_SIDE || w * scale * h * scale > MAX_PIXELS) {
          /* the view itself is too large even at 1x: make it smaller, keeping its shape */
          var f = Math.min(MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)), 1), vw = w, vh = h;
          w = Math.max(1, Math.floor(w * f)); h = Math.max(1, Math.floor(h * f)); scale = 1;
          if (o.pixelsPerMm !== undefined && o.pixelsPerMm !== null && isFinite(Number(o.pixelsPerMm))) o.pixelsPerMm = Number(o.pixelsPerMm) * w / vw;
          if (o.origin) o.origin = [Number(o.origin.x !== undefined ? o.origin.x : o.origin[0]) * w / vw, Number(o.origin.y !== undefined ? o.origin.y : o.origin[1]) * h / vh];
          warnings.push({ code: 'EXPORT_SCALED_DOWN', message: 'The view is too large to export; ' + w + ' x ' + h + ' pixels is used.' });
        }
        if (scale !== asked && !warnings.some(function (x) { return x.code === 'EXPORT_SCALED_DOWN'; })) warnings.push({ code: 'EXPORT_SCALED_DOWN', message: 'The picture would be too large at ' + asked + 'x; ' + scale + 'x is used.' });
        var cv = makeCanvas(Math.round(w * scale), Math.round(h * scale));
        if (!cv) return fail('NO_CANVAS', 'This browser cannot create a canvas.');
        if (o.pixelsPerMm !== undefined && o.pixelsPerMm !== null && isFinite(Number(o.pixelsPerMm))) o.pixelsPerMm = Number(o.pixelsPerMm) * scale;
        if (o.origin) { var ox = o.origin.x !== undefined ? o.origin.x : o.origin[0], oy = o.origin.y !== undefined ? o.origin.y : o.origin[1]; o.origin = [Number(ox) * scale, Number(oy) * scale]; }
        o.quickFrame = false; o.onFirstFrame = null; o.progressive = false;
        render(cv, design, o).then(function (stats) {
          if (!stats.ok) return fail(stats.error ? stats.error.code : 'RENDER_FAILED', stats.error ? stats.error.message : 'The picture could not be drawn.');
          stats.scale = scale; stats.warnings = warnings.concat(stats.warnings || []);
          var done = function (blob) {
            if (!blob) return fail('ENCODE_FAILED', 'The browser could not make a PNG this large.');
            stats.exportMs = stats.totalMs; stats.bytes = blob.size;
            if (typeof options.onStats === 'function') { try { options.onStats(stats); } catch (e) { /* the caller's problem */ } }
            cv.width = cv.height = 1;
            resolve(blob);
          };
          try {
            if (typeof cv.toBlob === 'function') cv.toBlob(done, 'image/png');
            else if (typeof cv.convertToBlob === 'function') cv.convertToBlob({ type: 'image/png' }).then(done, function () { done(null); });
            else fail('ENCODE_FAILED', 'This browser cannot save a canvas as PNG.');
          } catch (e) { fail('ENCODE_FAILED', String(e && e.message || e)); }
        });
      } catch (e) { fail('EXPORT_FAILED', String(e && e.message || e)); }
    });
  }

  /* a tileable patch of cloth as a canvas (for a CSS background or a pattern), or null without a canvas */
  function fabricCanvas(fabric, color, pixelsPerMm, lightAngle) {
    try {
      var t = Core.fabricTileBytes(fabric, color, pixelsPerMm, lightAngle), cv = makeCanvas(t.width, t.height);
      if (!cv) return null;
      cv.getContext('2d').putImageData(new ImageData(t.data, t.width, t.height), 0, 0);
      return cv;
    } catch (e) { return null; }
  }

  return {
    version: VERSION,
    render: render,
    exportImage: exportImage,
    dispose: dispose,
    fabricCanvas: fabricCanvas,
    layout: function (design, options, width, height) {
      try { var o = Core.normalizeOptions(options); return layout(compileCached(design, o), o, Math.max(1, width | 0), Math.max(1, height | 0)); } catch (e) { return null; }
    },
    normalizeOptions: Core ? Core.normalizeOptions : null,
    FABRICS: Core ? Core.FABRICS.slice() : [], SCENES: Core ? Core.SCENES.slice() : [], GARMENTS: Core ? Core.GARMENTS.slice() : [], PLACEMENTS: Core ? Core.PLACEMENTS.slice() : [],
    DEFAULTS: Core ? Core.DEFAULTS : {},
    limits: { maxSide: MAX_SIDE, maxPixels: MAX_PIXELS },
    _garments: GARMENT
  };
});
