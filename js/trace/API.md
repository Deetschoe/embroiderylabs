# Trace: picture to embroidery shapes (API 1.1.0)

Turns a picture (logo, drawing, clip art, photograph) into coloured shapes the stitch engine can sew.
Everything runs in the visitor's browser. No dependencies, no network.

    picture pixels --Trace.trace--> { objects, colors, size, warnings } --Engine.generate--> stitches --Engine.export--> .pes / .dst

Not to be confused with `Editor.Trace` (js/editor/trace.js), which only shows a picture UNDER the artwork to
draw over by hand. This module is the global `Trace` and does not touch the editor.

Files

| file | what |
|---|---|
| `js/trace/trace.js` | the algorithm. UMD: `window.Trace`, `self.Trace` in a worker, `require()` in node |
| `js/trace/client.js` | page side: `Trace.imageDataFrom` (read + shrink a picture) and `Trace.createClient` (worker with main-thread fallback) |
| `js/trace/worker.js` | the worker `createClient` starts. Must sit next to `trace.js` |
| `tests/trace/run.js` | `node tests/trace/run.js` (31 tests, no npm packages) |

```html
<script src="js/trace/trace.js"></script>
<script src="js/trace/client.js"></script>
```

## The short version

```js
const tracer = Trace.createClient();                         // once per page

async function pictureToShapes(file, hoop) {                 // file: File from <input> or a drop
  const image = await Trace.imageDataFrom(file, { maxSide: 1600 });   // decode + shrink, see "Large pictures"
  const result = await tracer.trace(image, { width: 100, hoop }, { onProgress: f => bar.value = f });
  if (!result.ok) return show(result.warnings);              // nothing sewable; warnings say why
  show(result.warnings);                                     // plain sentences, show them to the visitor
  return result;
}

// a) straight to the engine
const gen = Engine.generate({ name: 'picture', hoop, objects: result.objects });
// b) into the editor document, as one undo step
Editor.Model.addMany(Trace.toEditorObjects(result), 'Trace picture');
```

Keep `image` and call `tracer.trace(image, otherOptions)` again when a setting changes; a new call cancels the
one still running.

## Trace.trace(image, options?, hooks?) -> result

Synchronous. Use it in node or in your own worker; in a page use the client below.

`image`: `{ width, height, data }`, `data` = RGBA bytes (`ImageData` works as is), at most 40 megapixels.

| option | default | meaning |
|---|---|---|
| `width` | `100` | finished width in mm, 10 to 400. Height follows the picture's shape |
| `colors` | `6` | most thread colours, 2 to 30, or `'auto'`. Fewer are used when the picture has fewer (`COLORS_MERGED`). `'auto'` picks the fewest colours that show the picture well (see below), at most `maxColors` |
| `maxColors` | `10` | with `colors: 'auto'` only: the most it may pick, 2 to 30 |
| `detail` | `'medium'` | `'low'`, `'medium'`, `'high'`: smallest shape kept (3 / 1.6 / 1 mm2 for flat art, 10 / 5.5 / 3 mm2 for photographs) and working grid (0.28 / 0.22 / 0.18 mm) |
| `background` | `'auto'` | `'auto'`: leave out transparent areas and a plain colour that runs round the border. `'on'`: always leave out the border colour. `'off'`: sew everything. `true` / `false` are accepted |
| `mode` | `'auto'` | `'auto'`, `'logo'`, `'photo'`. Photo mode smooths harder, keeps only bigger shapes and sews fills without underlay |
| `holes` | `true` | when a background colour is removed, also remove enclosed areas of that colour (the inside of an O) |
| `outline` | `false` | add a running-stitch outline in the darkest colour round every shape |
| `hoop` | `null` | `{ width, height }` mm. The picture is centred in it and `EXCEEDS_HOOP` is raised if it does not fit |
| `x`, `y` | `0` | mm, top-left corner of the picture. Given explicitly they win over the centring |

Wrong or out-of-range options never throw: the nearest valid value is used and an `INVALID_OPTION` warning
(with `param`) says so.

### Automatic colour count (`colors: 'auto'`)

The palette step is run for 1, 2, 3 ... colours on the picture's colour histogram (with the border background as
one extra colour when it will be left out; it is not a thread). For each count two numbers are measured in OKLab:
`rms`, the average colour error, and `miss`, the share of the picture further than 0.07 from every palette colour
(a colour no thread is close to). The pick is the smallest count, from 2, where either

- the picture is flat art and fully explained: `rms` <= 0.012, `miss` <= 0.2%, and two more colours would lower
  `rms` by no more than 0.004 (so the faint colours of a pale picture still count), or
- nothing sizeable is missed (`miss` <= 0.5% for flat art, 2% for photographs) and two more colours would cut
  `rms` by less than 20% (diminishing returns),

else `maxColors`. All distances shrink for a low-contrast picture, like every other colour threshold. Picks on
the sample pictures: logos get exactly their own colours (2 to 8), photographs 4 to 10 (soft, bold subjects 4 to 6;
busy ones reach the cap). Costs 50 to 200 ms. The chosen count then goes through the same pipeline as a number would,
except that a background colour also used inside the design may add one thread (never past `maxColors`) and
`COLORS_MERGED` is not raised. `stats.autoColors.curve` holds the measurements.

Above 12 colours: the logo / photograph test uses a probe palette as large as the request, so flat art with many
colours stays flat art, and spare palette slots are not given to the blend along edges (it would be sewn as
hairlines of an in-between thread). Results for 12 colours or fewer are unchanged from 1.0.0.

`hooks`: `{ onProgress(fraction 0..1), shouldCancel() -> boolean }`. When `shouldCancel` returns true the call
throws an Error with `code: 'CANCELLED'`.

`Trace.traceAsync(image, options?, { onProgress, shouldCancel, signal })` is the same work in slices on the
calling thread and returns a Promise (rejects with `code: 'CANCELLED'`). `createClient` uses it as its fallback.

### result

```js
{
  ok: true,                      // false: nothing to sew, objects is [] and warnings holds an 'error'
  objects: [ ... ],              // in sewing order, ready for Engine.generate
  colors: [ { index, hex, name, thread: { chart: 'Brother', index, name, hex }, objects, areaMm2, lengthMm, share } ],
  size: { width, height },       // mm
  origin: { x, y },              // mm, where the picture's top-left corner was put
  mode: 'logo' | 'photo',        // what it was treated as
  background: { removed, reason: 'transparent' | 'border' | null, color },   // color: hex of a removed border colour
  stats: { objects, regions, lines, colors, points, estimatedStitches, workWidth, workHeight, mmPerPixel, timeMs, stages, detect,
           autoColors },            // colors 'auto' only, else null: { picked, max, curve: [{ k, n, rms, miss }] }
  warnings: [ { code, severity: 'error' | 'warning' | 'info', message, ... } ],
  version: '1.1.0'
}
```

Objects are exactly what `Engine.generate` takes (js/engine/API.md), plus a few extra fields the engine ignores:

```js
// a filled shape: rings[0] is the outline, the rest are holes (wound the other way)
{ id: 't1', name: 'White 1', type: 'path', rings: [[[x, y], ...], ...], fillRule: 'nonzero',
  color: '#f4f1e8', paint: 'fill', fill: { angle: 45, spacing: 0.4, stitchLength: 3 /*, underlay: false */ },
  trace: { kind: 'fill', color: 0, areaMm2, widthMm, holes, stitches } }
// a line: a satin column (even bands of about 1 to 3.6 mm), a bean stitch or a single run (hairlines)
{ id: 't3', name: 'Dark blue line 2', type: 'polyline', points: [[x, y], ...], closed: false,
  color: '#1d3b6e', paint: 'line', line: { type: 'satin', width: 2, spacing: 0.4 },   // or { type: 'bean' | 'running', stitchLength: 2 }
  trace: { kind: 'line', color: 1, lengthMm, widthMm, stitches } }
```

`trace.color` is the index into `colors`. `trace.stitches` and `stats.estimatedStitches` are estimates (5 to 17% off
the engine's count on the sample pictures); the real number is
`Engine.generate(...).totals.stitches`. `colors[i].hex` is the picture's colour; `thread` is the nearest of the
64 Brother chart threads (`Trace.THREADS`), which is what a PES file can name.

What the order means: objects are grouped by colour (colour changes = colours - 1), big background-like
colours first, small details last. Each fill reaches 0.45 mm under the colours sewn after it, so neighbours
overlap instead of leaving a gap. Do not reorder them without thinking about that.

Fills marked `underlay: false`: every fill of a photograph, and in logos a fill that lies against a fill sewn
before it (two sets of underlay along one seam make the engine report `TOO_DENSE`).

### warnings

Show `message` to the visitor; switch on `code`.

| code | severity | when |
|---|---|---|
| `INVALID_IMAGE`, `IMAGE_TOO_LARGE`, `EMPTY_IMAGE` | error | no result (`ok: false`) |
| `INVALID_OPTION` | info | an option was replaced (`param`, `value`) |
| `PHOTO_POSTERIZED` | warning | treated as a photograph: flat colour bands instead of shading |
| `LOW_RESOLUTION` | warning | fewer than 2 picture pixels per mm |
| `DETAIL_LOST` | info / warning | small print or fine detail was left out or merged |
| `MANY_SMALL_SHAPES`, `TOO_MANY_SHAPES` | warning | confetti; over 1500 shapes the smallest are dropped |
| `MANY_STITCHES` | warning | long sew |
| `EXCEEDS_HOOP` | warning | larger than `hoop` |
| `BACKGROUND_REMOVED`, `COLORS_MERGED`, `SINGLE_COLOR`, `RESOLUTION_REDUCED` | info | what was done |

`Engine.generate` adds its own warnings afterwards (`TOO_DENSE`, `THIN_FILL`, ...). Show both lists.

## Large pictures: shrink first

`Trace.trace` never needs more than about 1600 pixels on the long side (at 400 mm wide that is still 4 px/mm,
and thread cannot show more). A 12-megapixel phone photo must be shrunk on a canvas before it is traced:

```js
const image = await Trace.imageDataFrom(source, { maxSide: 1600 });
// source: File | Blob | <img> | <canvas> | ImageBitmap | ImageData | { width, height, data }
// resolves { width, height, data }; never enlarges; keeps transparency; turns phone photos the right way up
// rejects with code 'IMAGE_UNREADABLE' when the browser cannot decode the file
```

Doing the same by hand:

```js
const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
const c = document.createElement('canvas');
c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
const g = c.getContext('2d', { willReadFrequently: true });
g.imageSmoothingQuality = 'high';
g.drawImage(bmp, 0, 0, c.width, c.height);      // imageDataFrom halves in steps first, which is cleaner for big reductions
const image = g.getImageData(0, 0, c.width, c.height);
```

Measured in headless Chrome 157 on the development Mac: a 4000 x 3000 JPEG is decoded and shrunk in 83 ms.
This step runs on the main thread (canvas); it is the only part that does.

## Trace.createClient(options?) -> client

Runs traces in a Web Worker and falls back to the main thread (in slices) when a worker cannot start, which is
what happens on a page opened from `file://`.

| option | default | |
|---|---|---|
| `workerUrl` | `worker.js` next to `client.js` | |
| `forceMainThread` | `false` | never start a worker |
| `readyTimeoutMs` | `4000` | a worker that has not answered by then is given up |
| `onModeChange(mode)` | | `'worker'` or `'main'` |

| member | |
|---|---|
| `client.trace(image, options, { onProgress, signal })` | Promise of the result above. One job at a time: a new call cancels the running one. The image is copied, the caller keeps its pixels |
| `client.cancel()` | cancels the running job (its promise rejects with `code: 'CANCELLED'`); returns whether there was one |
| `client.ready` | Promise of `'worker'` or `'main'` |
| `client.mode` | `'starting'`, `'worker'`, `'main'` |
| `client.terminate()` | ends the worker; later calls reject with `code: 'TERMINATED'` |

Errors are `Error` objects with `code`: `CANCELLED`, `TERMINATED`, `TRACE_ERROR`. A picture that cannot be
traced is not an error: the promise resolves with `ok: false`.

Worker messages, should you want your own client (same pattern as js/engine/worker.js): in
`{ type: 'trace', id, image, options }`; out `{ type: 'ready', version }`, `{ type: 'progress', id, fraction }`,
`{ type: 'result', id, result }`, `{ type: 'error', id, error: { code, message } }`. There is no cancel message;
cancel by terminating the worker and starting a new one.

## Into the editor

```js
const list = Trace.toEditorObjects(result);        // [{ geom, style }]
const made = Editor.Model.addMany(list, 'Trace picture');   // [] when the document would exceed its 2000 objects
```

- fills become `geom: { type: 'path', rings, fillRule: 'nonzero' }` (holes kept), or `polygon` when there is no
  hole; lines become `geom: { type: 'pen', pts, closed }`
- `style`: `{ name, color, paint, lineType, lineWidth, spacing, stitchLen, angle }`, plus `underlay: false` where
  the tracer set it
- `Trace.toEditorObjects(result, { holes: 'polygon' })` gives single keyhole polygons instead of paths
  (`Trace.toPolygon(rings)` does one), for code that has no ring type
- coordinates are mm in the same frame as the editor's hoop when you passed `hoop` (or `x` / `y`) to the trace
- one gap: `Editor.Model.toEngine()` does not pass a per-object `underlay`, so shapes brought in this way are
  sewn WITH underlay. For photographs that brings back the engine's `TOO_DENSE` warning and about a third more
  stitches. Carrying `style.underlay` through to `fill.underlay` in the editor would close it

Checked by tests/trace/run.js against the real js/editor/model.js: every object is taken, and the editor's own
`toEngine()` output sews to within 1% of the direct result (2091 against 2099 stitches).

## Speed (measured, not promised)

Headless Chrome 157, in the worker, 100 mm wide, medium detail, picture already shrunk to 1600 px:

| picture | trace | whole conversion incl. Engine.generate |
|---|---|---|
| logos (800 to 1000 px) | 70 to 280 ms | 80 to 300 ms |
| photographs (1600 px) | 240 to 350 ms | 260 to 400 ms |
| 12 MP JPEG, 150 mm | 440 ms | 540 ms (83 ms of it reading and shrinking) |

The page was never held up for more than about 100 ms in worker mode (that is the canvas step). On the main
thread (`file://`) a logo holds the page for about 100 ms at a time and a large high-detail trace for up to
about 300 ms at a time; progress still arrives and cancel still works. The largest job allowed (400 mm, high,
12 colours) takes about 1.3 s in node; a 1200 px photograph at 150 mm, high, 30 colours about 1.2 s.

## What it cannot do

- Photographs come out posterised: a handful of flat colours, soft shading turned into bands, fine texture
  (fur, stripes, leaves) merged into blobs. Bold, simple pictures work far better. A white studio background is
  kept unless `background: 'on'`.
- Lettering lower than about 5 mm is left out (reported as `DETAIL_LOST`) rather than sewn as squiggles.
  Lettering around 6 mm is sewn as satin and is readable but rough.
- Edges are found on a 0.18 to 0.28 mm grid, so a straight edge can sit about 0.1 mm off.
- A smooth gradient in a logo becomes a few bands, with no special warning.
- With few colours, similar colours merge (brown into red, cream into a white background). More colours fixes it.
- The engine's `TOO_DENSE` warning comes back for photographs sewn with underlay (see the editor gap above), and
  its `THIN_FILL` warning appears on some photographs (3 of the 9 samples) for slivers too narrow to fill well.
- Nothing made by this has been sewn on a real machine. The files were read back with pyembroidery and drawn,
  which shows where the needle goes, not how cloth and thread behave. Every result needs a test sew.
