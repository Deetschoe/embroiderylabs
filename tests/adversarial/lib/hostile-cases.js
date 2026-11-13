/*
 * Hostile input for the public API: each entry builds a fresh `design` argument for Engine.generate.
 * Built inside the child process (NaN, Infinity and undefined do not survive JSON).
 */
'use strict';

const H = (objects, hoop) => ({ name: 'hostile', hoop: hoop || { width: 100, height: 100 }, objects });
const rnd = seed => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };
const ring = (cx, cy, rx, ry, n) => Array.from({ length: n }, (_, i) => [cx + rx * Math.cos(2 * Math.PI * i / n), cy + ry * Math.sin(2 * Math.PI * i / n)]);
const sq = (x, y, s, extra) => Object.assign({ type: 'rect', x, y, width: s, height: s, color: '#336699' }, extra);
const good = () => sq(30, 30, 20);

const cases = {};
// ---- the design argument itself
[['null', null], ['undefined', undefined], ['number', 42], ['string', 'design'], ['array', []], ['empty object', {}], ['true', true]].forEach(([k, v]) => { cases['design is ' + k] = () => v; });
cases['objects null'] = () => ({ objects: null });
cases['objects string'] = () => ({ objects: 'abc' });
cases['objects object'] = () => ({ objects: { 0: good(), length: 1 } });
cases['objects number'] = () => ({ objects: 7 });
cases['objects empty'] = () => H([]);
cases['objects of junk'] = () => H([null, undefined, 5, 'x', [], {}, true, NaN, () => 1, good()]);
cases['objects sparse'] = () => { const a = []; a[3] = good(); a[9] = sq(60, 60, 10); return H(a); };
cases['all invisible'] = () => H([sq(10, 10, 20, { visible: false }), sq(50, 50, 20, { visible: false })]);
cases['visible is a string'] = () => H([sq(10, 10, 20, { visible: 'false' }), sq(50, 50, 20, { visible: 0 }), sq(70, 70, 20, { visible: null })]);
// ---- hoop
[['null', null], ['empty', {}], ['zero', { width: 0, height: 0 }], ['negative', { width: -100, height: -100 }], ['NaN', { width: NaN, height: NaN }], ['Infinity', { width: Infinity, height: Infinity }],
 ['strings', { width: '100', height: '100' }], ['huge', { width: 1e9, height: 1e9 }], ['one side', { width: 100 }], ['array', [100, 100]], ['number', 100], ['fraction', { width: 100.05, height: 99.95 }],
 ['tiny', { width: 10, height: 10 }], ['largest', { width: 1000, height: 1000 }], ['just under', { width: 9.999, height: 100 }], ['just over', { width: 1000.001, height: 100 }]]
  .forEach(([k, v]) => { cases['hoop ' + k] = () => ({ name: 'h', hoop: v, objects: [sq(2, 2, 6)] }); });
cases['hoop odd tenth with centred shape'] = () => ({ name: 'h', hoop: { width: 100.1, height: 100.3 }, objects: [sq(20.05, 20.05, 40.03)] });
// ---- names
[['number', 12345], ['object', { a: 1 }], ['empty', ''], ['spaces', '   '], ['emoji', '\u{1F9F5}\u{1F9F5}'], ['path', '../../etc/passwd'], ['nul', 'a\u0000b\r\nc'], ['accents', 'Café Über ñ'],
 ['long', 'x'.repeat(100000)], ['html', '<img src=x onerror=alert(1)>'], ['dots', '....'], ['cjk', '刺繡'], ['null', null], ['array', ['a', 'b']], ['colon cr', 'LA:evil\rST:9999999']]
  .forEach(([k, v]) => { cases['name ' + k] = () => ({ name: v, hoop: { width: 100, height: 100 }, objects: [good()] }); });
// ---- sizes
[['zero', 0, 0], ['zero width', 0, 20], ['zero height', 20, 0], ['negative', -20, -20], ['NaN', NaN, 20], ['Infinity', Infinity, 20], ['-Infinity', 20, -Infinity], ['string', '20', '20'], ['tiny', 1e-9, 1e-9], ['sub stitch', 0.5, 0.5],
 ['one mm', 1, 1], ['hairline', 80, 0.05], ['null', null, null], ['undefined', undefined, undefined], ['huge', 1e7, 1e7], ['object', {}, []]]
  .forEach(([k, w, h]) => { cases['rect ' + k] = () => H([{ type: 'rect', x: 30, y: 30, width: w, height: h, color: '#112233' }, good()]); });
[['NaN', NaN], ['Infinity', Infinity], ['1e9', 1e9], ['-1e9', -1e9], ['string', '45'], ['1e-300', 1e-300], ['360000.5', 360000.5]].forEach(([k, v]) => { cases['rect rotation ' + k] = () => H([{ type: 'rect', x: 30, y: 30, width: 30, height: 20, rotation: v, color: '#112233' }]); });
[['zero', 0], ['negative', -10], ['NaN', NaN], ['Infinity', Infinity], ['tiny', 1e-9], ['0.3', 0.3], ['0.6', 0.6], ['huge', 1e6], ['string', '10'], ['null', null]].forEach(([k, v]) => {
  cases['circle r ' + k] = () => H([{ type: 'circle', cx: 50, cy: 50, r: v, color: '#aa0000' }, good()]);
  cases['ellipse rx ' + k] = () => H([{ type: 'ellipse', cx: 50, cy: 50, rx: v, ry: 10, color: '#aa0000' }, good()]);
});
cases['ellipse rotation NaN'] = () => H([{ type: 'ellipse', cx: 50, cy: 50, rx: 20, ry: 10, rotation: NaN, color: '#aa0000' }]);
cases['ellipse centre NaN'] = () => H([{ type: 'ellipse', cx: NaN, cy: 50, rx: 20, ry: 10, color: '#aa0000' }, good()]);
// ---- lines
[['zero length', 50, 50, 50, 50], ['NaN', NaN, 50, 60, 50], ['Infinity', 10, 10, Infinity, 10], ['0.2 mm', 50, 50, 50.2, 50], ['0.6 mm', 50, 50, 50.6, 50], ['0.7 mm', 50, 50, 50.7, 50], ['strings', '10', '10', '80', '80'], ['missing', 10, 10, undefined, undefined]]
  .forEach(([k, x1, y1, x2, y2]) => { for (const type of ['running', 'bean', 'satin']) cases['line ' + k + ' ' + type] = () => H([{ type: 'line', x1, y1, x2, y2, color: '#000000', line: { type } }, good()]); });
// ---- point lists
const P = (k, points, extra) => {
  cases['polygon ' + k] = () => H([Object.assign({ type: 'polygon', points: typeof points === 'function' ? points() : points, color: '#005500' }, extra), good()]);
  cases['polyline ' + k] = () => H([Object.assign({ type: 'polyline', points: typeof points === 'function' ? points() : points, color: '#005500' }, extra), good()]);
  cases['closed polyline both ' + k] = () => H([Object.assign({ type: 'polyline', closed: true, paint: 'both', line: { type: 'satin', width: 2 }, points: typeof points === 'function' ? points() : points, color: '#005500' }, extra), good()]);
};
P('no points', []); P('points null', null); P('points string', 'abc'); P('points number', 5); P('points object', { 0: [1, 1], 1: [5, 5], length: 2 });
P('one point', [[50, 50]]); P('two points', [[20, 20], [80, 80]]); P('two identical', [[50, 50], [50, 50]]);
P('collinear', [[10, 10], [50, 50], [90, 90]]); P('collinear back', [[10, 10], [90, 90], [50, 50], [10, 10]]); P('all coincident', () => Array.from({ length: 50 }, () => [40, 40]));
P('NaN points', [[10, 10], [NaN, 50], [90, 10], [50, NaN], [90, 90], [10, 90]]); P('all NaN', [[NaN, NaN], [NaN, NaN], [NaN, NaN]]);
P('Infinity points', [[10, 10], [Infinity, 10], [90, 90], [10, -Infinity]]); P('string coords', [['10', '10'], ['90', '10'], ['50', '90']]);
P('mixed forms', [[10, 10], { x: 90, y: 10 }, [90, 90, 5], { x: 10, y: 90, z: 1 }]); P('short tuples', [[10], [90, 10], [], [50, 90], null, undefined, 7, 'p']);
P('nested too deep', [[[10, 10]], [[90, 10]], [[50, 90]]]); P('repeated closing point', [[10, 10], [90, 10], [90, 90], [10, 90], [10, 10], [10, 10]]);
P('duplicates everywhere', () => [].concat(...[[10, 10], [90, 10], [90, 90], [10, 90]].map(p => [p, p, p, p])));
P('zero area zigzag', [[10, 10], [90, 90], [10, 10], [90, 90], [10, 10]]); P('near zero area', [[10, 50], [90, 50], [90, 50.0001], [10, 50.0001]]);
P('needle', [[10, 50], [90, 49.9], [90, 50.1]]); P('micro', [[50, 50], [50.4, 50], [50.4, 50.4], [50, 50.4]]);
P('1e-7 jitter', () => ring(50, 50, 30, 30, 400).map((p, i) => [p[0] + (i % 2) * 1e-7, p[1] - (i % 3) * 1e-7]));
P('far outside', [[1e6, 1e6], [1e6 + 50, 1e6], [1e6 + 50, 1e6 + 50]]); P('negative far', [[-5000, -5000], [-4950, -5000], [-4950, -4950]]);
P('partly far', [[10, 10], [1e7, 10], [90, 90]]); P('at the coord limit', [[1990, 1990], [1999, 1990], [1999, 1999], [1990, 1999]]); P('past the coord limit', [[1995, 1995], [2001, 1995], [2001, 2001], [1995, 2001]]);
P('1e308', [[1e308, 1e308], [-1e308, 1e308], [0, -1e308]]); P('bowtie', [[20, 20], [80, 80], [80, 20], [20, 80]]);
P('pentagram', [[50, 10], [74, 85], [12, 38], [88, 38], [26, 85]]); P('figure eight', () => Array.from({ length: 200 }, (_, i) => { const a = 2 * Math.PI * i / 200; return [50 + 35 * Math.sin(a), 50 + 30 * Math.sin(2 * a)]; }));
P('scribble 10000', () => { const r = rnd(7); let x = 50, y = 50; return Array.from({ length: 10000 }, () => { x = Math.min(95, Math.max(5, x + (r() - 0.5) * 6)); y = Math.min(95, Math.max(5, y + (r() - 0.5) * 6)); return [x, y]; }); });
P('random 300', () => { const r = rnd(11); return Array.from({ length: 300 }, () => [5 + 90 * r(), 5 + 90 * r()]); });
P('spikes', () => Array.from({ length: 400 }, (_, i) => { const a = 2 * Math.PI * i / 400, q = i % 2 ? 44 : 3; return [50 + q * Math.cos(a), 50 + q * Math.sin(a)]; }));
P('dense circle 20000', () => ring(50, 50, 40, 40, 20000)); P('grid aligned', [[10, 10], [10.4, 10], [10.4, 90], [10.8, 90], [10.8, 10], [90, 10], [90, 90], [10, 90]]);
P('fillRule junk', [[10, 10], [90, 10], [50, 90]], { fillRule: 'banana' }); P('evenodd bowtie', [[20, 20], [80, 80], [80, 20], [20, 80]], { fillRule: 'evenodd' });
// ---- paths
const PA = (k, rings, extra) => { cases['path ' + k] = () => H([Object.assign({ type: 'path', rings: typeof rings === 'function' ? rings() : rings, color: '#550055' }, extra), good()]); };
PA('no rings', []); PA('rings null', null); PA('rings string', 'x'); PA('empty ring', [[]]); PA('ring of junk', [[null, 5, 'a']]); PA('ring objects without points', [{}, { closed: true }, { points: null }]);
PA('open only fill', [{ points: [[10, 10], [90, 10], [50, 80]], closed: false }], { paint: 'fill' }); PA('open and closed both', [{ points: [[10, 10], [90, 10], [50, 40]], closed: false }, ring(50, 65, 20, 20, 40)], { paint: 'both' });
PA('two point ring', [[[10, 10], [90, 90]]]); PA('hole same direction nonzero', [ring(50, 50, 40, 40, 80), ring(50, 50, 15, 15, 40)]); PA('hole bigger than outer', [ring(50, 50, 10, 10, 40), ring(50, 50, 40, 40, 80).reverse()]);
PA('identical rings evenodd', [ring(50, 50, 30, 30, 60), ring(50, 50, 30, 30, 60)], { fillRule: 'evenodd' }); PA('identical rings opposite', [ring(50, 50, 30, 30, 60), ring(50, 50, 30, 30, 60).reverse()]);
PA('touching holes', [[[10, 10], [90, 10], [90, 90], [10, 90]], [[30, 30], [30, 50], [50, 50], [50, 30]], [[50, 50], [50, 70], [70, 70], [70, 50]]]);
PA('hole touching edge', [[[10, 10], [90, 10], [90, 90], [10, 90]], [[10, 30], [10, 60], [40, 60], [40, 30]]]);
PA('2000 rings', () => Array.from({ length: 2000 }, (_, i) => ring(6 + (i % 45) * 2, 6 + Math.floor(i / 45) * 2, 0.8, 0.8, 8)));
PA('200 nested evenodd', () => Array.from({ length: 200 }, (_, i) => ring(50, 50, 45 - i * 0.22, 45 - i * 0.22, 60)), { fillRule: 'evenodd' });
PA('closed is a string', [{ points: [[10, 10], [90, 10], [50, 80]], closed: 'no' }]);
// ---- settings
const BAD = [0, -1, NaN, Infinity, -Infinity, 1e-9, 1e9, '0.4', null, {}, [], true, 'abc'];
for (const param of ['spacing', 'stitchLength', 'pullComp', 'angle', 'underlay']) BAD.forEach((v, i) => { cases['fill.' + param + ' = ' + (typeof v === 'object' ? JSON.stringify(v) : String(v)) + ' #' + i] = () => H([sq(20, 20, 40, { fill: { [param]: v } })]); });
for (const param of ['stitchLength', 'width', 'spacing', 'underlay', 'type']) for (const type of ['running', 'bean', 'satin']) BAD.forEach((v, i) => {
  cases['line.' + param + ' = ' + (typeof v === 'object' ? JSON.stringify(v) : String(v)) + ' ' + type + ' #' + i] = () => H([{ type: 'polyline', points: [[10, 20], [60, 30], [90, 80]], color: '#000000', line: Object.assign({ type }, { [param]: v }) }]);
});
[['fill null', { fill: null }], ['fill string', { fill: 'yes' }], ['fill number', { fill: 4 }], ['line null', { line: null, paint: 'both' }], ['line string', { line: 'satin', paint: 'line' }], ['paint junk', { paint: 'banana' }], ['paint number', { paint: 3 }],
 ['paint FILL', { paint: 'FILL' }], ['type upper', { type: 'RECT' }], ['type junk', { type: 'hexagon' }], ['type missing', { type: undefined }], ['type number', { type: 1 }], ['id object', { id: { a: 1 } }], ['id NaN', { id: NaN }]]
  .forEach(([k, extra]) => { cases['object ' + k] = () => H([sq(20, 20, 30, extra), good()]); });
[['angle 1e9', 1e9], ['angle -1e9', -1e9], ['angle 1e300', 1e300], ['angle 89.9999', 89.9999], ['angle 90.0001', 90.0001], ['angle 0.0001', 0.0001], ['angle 360', 360], ['angle 720.5', 720.5], ['angle -0', -0]]
  .forEach(([k, v]) => { cases['fill ' + k] = () => H([{ type: 'polygon', points: [[15, 15], [32, 15], [32, 62], [68, 62], [68, 15], [85, 15], [85, 85], [15, 85]], color: '#444444', fill: { angle: v } }]); });
cases['densest and shortest'] = () => H([sq(10, 10, 80, { fill: { spacing: 0.2, stitchLength: 1 } })]);
cases['satin 12 mm on a tight zigzag'] = () => H([{ type: 'polyline', points: Array.from({ length: 40 }, (_, i) => [10 + i * 2, i % 2 ? 30 : 70]), color: '#000000', line: { type: 'satin', width: 12 } }]);
cases['satin on a 10000 point scribble'] = () => { const r = rnd(5); let x = 50, y = 50; return H([{ type: 'polyline', points: Array.from({ length: 10000 }, () => { x = Math.min(92, Math.max(8, x + (r() - 0.5) * 4)); y = Math.min(92, Math.max(8, y + (r() - 0.5) * 4)); return [x, y]; }), color: '#000000', line: { type: 'satin', width: 3 } }]); };
cases['satin hairpin'] = () => H([{ type: 'polyline', points: [[10, 50], [90, 50], [10, 50.5]], color: '#000000', line: { type: 'satin', width: 6 } }]);
cases['satin closed tiny circle'] = () => H([{ type: 'circle', cx: 50, cy: 50, r: 1.2, color: '#000000', paint: 'line', line: { type: 'satin', width: 6 } }]);
cases['bean on duplicates'] = () => H([{ type: 'polyline', points: [[10, 10], [10, 10], [10.01, 10], [50, 50], [50, 50], [90, 10]], color: '#000000', line: { type: 'bean' } }]);
// ---- colours
[['#FFF', 0], ['#ffffff', 0], ['FFFFFF', 0], ['#FfFfFf', 0], [' #fff ', 0], ['rgb(255,255,255)', 1], ['white', 1], ['#gggggg', 1], ['#ffff', 1], ['', 1], [null, 1], [123, 1], [{ r: 1 }, 1], ['#12345678', 1], [NaN, 1], [0xffffff, 1], ['transparent', 1]]
  .forEach(([v], i) => { cases['colour ' + (typeof v === 'string' ? JSON.stringify(v) : String(v)) + ' #' + i] = () => H([sq(10, 10, 20, { color: v }), sq(40, 40, 20, { color: v }), sq(70, 70, 20, { color: '#000000' })]); });
cases['same white five ways'] = () => H(['#FFF', '#ffffff', 'FFFFFF', '#FfFfFf', 'fff'].map((c, i) => sq(5 + i * 18, 40, 14, { color: c })));
cases['line colour junk'] = () => H([sq(20, 20, 40, { paint: 'both', line: { type: 'satin', color: 'banana' } })]);
cases['line colour same as fill, written differently'] = () => H([sq(20, 20, 40, { color: '#ABC', paint: 'both', line: { type: 'satin', color: 'aabbcc' } })]);
const grid = (n, hoop, colour) => ({ name: 'grid', hoop: { width: hoop, height: hoop }, objects: Array.from({ length: n }, (_, i) => { const per = Math.ceil(Math.sqrt(n)), cell = (hoop - 4) / per; return { type: 'rect', x: 2 + (i % per) * cell, y: 2 + Math.floor(i / per) * cell, width: cell * 0.8, height: cell * 0.8, color: colour(i) }; }) });
const hex = v => '#' + ('00000' + (v & 0xffffff).toString(16)).slice(-6);
cases['300 objects one colour'] = () => grid(300, 200, () => '#123456');
cases['300 objects 3 colours interleaved'] = () => grid(300, 200, i => ['#ff0000', '#00ff00', '#0000ff'][i % 3]);
cases['60 colours'] = () => grid(60, 200, i => hex(i * 0x040404 + 0x0000ff * (i % 2)));
cases['64 colours'] = () => grid(64, 200, i => hex(i * 0x030609));
cases['65 colours'] = () => grid(65, 200, i => hex(i * 0x030609));
cases['100 near-identical greys'] = () => grid(100, 200, i => hex(0x010101 * (100 + i)));
cases['255 colour blocks'] = () => grid(255, 300, i => hex(i * 0x01f3a7 + 5));
cases['256 colour blocks'] = () => grid(256, 300, i => hex(i * 0x01f3a7 + 5));
cases['400 colour blocks'] = () => grid(400, 300, i => hex(i * 0x01f3a7 + 5));
cases['two colours alternating 300 times'] = () => grid(300, 300, i => (i % 2 ? '#000000' : '#ffffff'));
// ---- hoop edges
cases['rect exactly the hoop'] = () => H([{ type: 'rect', x: 0, y: 0, width: 100, height: 100, color: '#000000' }]);
cases['rect exactly the hoop, no pull'] = () => H([{ type: 'rect', x: 0, y: 0, width: 100, height: 100, color: '#000000', fill: { pullComp: 0 } }]);
cases['line on the hoop edge'] = () => H([{ type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, color: '#000000' }]);
cases['satin on the hoop edge'] = () => H([{ type: 'line', x1: 0, y1: 0, x2: 100, y2: 0, color: '#000000', line: { type: 'satin', width: 4 } }]);
cases['entirely outside'] = () => H([sq(150, 150, 20)]);
cases['straddling the edge'] = () => H([sq(90, 90, 20)]);
cases['fits but shifted out'] = () => H([sq(-5, 40, 20)]);
cases['bigger than the hoop'] = () => H([sq(-10, -10, 120)]);
cases['one in, one far out'] = () => H([good(), sq(1500, 1500, 20)]);
cases['largest hoop full circle'] = () => ({ name: 'big', hoop: { width: 1000, height: 1000 }, objects: [{ type: 'circle', cx: 500, cy: 500, r: 499, color: '#000000' }] });
cases['largest hoop corner to corner line'] = () => ({ name: 'big', hoop: { width: 1000, height: 1000 }, objects: [{ type: 'line', x1: 1, y1: 1, x2: 999, y2: 999, color: '#000000' }] });
cases['largest hoop two far dots'] = () => ({ name: 'big', hoop: { width: 1000, height: 1000 }, objects: [sq(1, 1, 5), sq(994, 994, 5), sq(1, 994, 5, { color: '#ff0000' })] });
cases['only tiny objects'] = () => H([sq(10, 10, 0.4), { type: 'line', x1: 50, y1: 50, x2: 50.3, y2: 50, color: '#000000' }, { type: 'circle', cx: 70, cy: 70, r: 0.2, color: '#000000' }]);
cases['a single lock-sized line'] = () => H([{ type: 'line', x1: 50, y1: 50, x2: 50.65, y2: 50, color: '#000000' }]);

// random whole designs: every seed gives the same design
function fuzz(seed) {
  const r = rnd(seed * 2654435761), pick = a => a[Math.floor(r() * a.length)], num = (a, b) => a + (b - a) * r();
  const weird = () => pick([0, -1, NaN, Infinity, 1e-9, 1e9, '3', null, undefined, 0.2, 0.3, 1, 2, 7, 12, 0.05]);
  const maybe = (v, p) => (r() < (p || 0.12) ? weird() : v);
  const hoop = pick([[100, 100], [130, 180], [200, 300], [300, 200], [50, 50], [10, 10], [100.1, 99.9]]);
  const W = hoop[0], Ht = hoop[1], n = 1 + Math.floor(r() * 6), objects = [];
  const pts = (k, spread) => { const cx = num(0.1, 0.9) * W, cy = num(0.1, 0.9) * Ht, style = pick(['random', 'ring', 'walk']); let x = cx, y = cy;
    return Array.from({ length: k }, (_, i) => { if (style === 'ring') { const a = 2 * Math.PI * i / k, q = spread * (0.4 + 0.6 * r()); return [maybe(cx + q * Math.cos(a), 0.01), cy + q * Math.sin(a)]; } if (style === 'walk') { x += num(-1, 1) * spread * 0.2; y += num(-1, 1) * spread * 0.2; return [x, y]; } return [cx + num(-1, 1) * spread, maybe(cy + num(-1, 1) * spread, 0.01)]; }); };
  for (let i = 0; i < n; i++) {
    const type = pick(['rect', 'ellipse', 'circle', 'line', 'polygon', 'polygon', 'polyline', 'path']), s = num(0.5, 0.45 * Math.min(W, Ht));
    const o = { id: i, type, color: pick(['#000', '#ff0000', '#00FF00', 'abcdef', '#123', 'junk', '#fefefe', '#ff0000']), paint: pick(['fill', 'line', 'both', undefined, undefined]),
      fill: r() < 0.7 ? { spacing: maybe(num(0.2, 2)), stitchLength: maybe(num(1, 7)), angle: maybe(num(-360, 360)), underlay: r() < 0.5, pullComp: maybe(num(0, 1)) } : undefined,
      line: r() < 0.7 ? { type: pick(['running', 'bean', 'satin', 'run', 'zig']), stitchLength: maybe(num(1, 7)), width: maybe(num(0.5, 14)), spacing: maybe(num(0.2, 2)), underlay: r() < 0.5, color: r() < 0.3 ? pick(['#ffffff', '#000', 'x']) : undefined } : undefined };
    if (type === 'rect') Object.assign(o, { x: num(-0.1, 0.9) * W, y: num(-0.1, 0.9) * Ht, width: maybe(s * num(-1, 2)), height: maybe(s * num(0, 2)), rotation: maybe(num(-720, 720), 0.05) });
    else if (type === 'ellipse') Object.assign(o, { cx: num(0, 1) * W, cy: num(0, 1) * Ht, rx: maybe(s), ry: maybe(s * num(0.02, 1)), rotation: num(-180, 180) });
    else if (type === 'circle') Object.assign(o, { cx: num(0, 1) * W, cy: num(0, 1) * Ht, r: maybe(s * 0.7) });
    else if (type === 'line') Object.assign(o, { x1: num(0, 1) * W, y1: num(0, 1) * Ht, x2: num(0, 1) * W, y2: maybe(num(0, 1) * Ht, 0.05) });
    else if (type === 'polygon') Object.assign(o, { points: pts(2 + Math.floor(r() * 40), s), fillRule: pick(['nonzero', 'evenodd', undefined]) });
    else if (type === 'polyline') Object.assign(o, { points: pts(1 + Math.floor(r() * 60), s), closed: r() < 0.5 });
    else Object.assign(o, { rings: Array.from({ length: 1 + Math.floor(r() * 4) }, () => (r() < 0.2 ? { points: pts(3 + Math.floor(r() * 20), s * 0.6), closed: r() < 0.5 } : pts(3 + Math.floor(r() * 30), s * 0.7))), fillRule: pick(['nonzero', 'evenodd']) });
    objects.push(o);
  }
  return { name: 'fuzz ' + seed, hoop: { width: W, height: Ht }, objects };
}

module.exports = { cases, fuzz };
