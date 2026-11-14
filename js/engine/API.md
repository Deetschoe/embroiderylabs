# Embroidery Labs engine: public API (version 1.0.0)

Shapes in millimetres go in; stitches, a report and a machine file come out. Everything runs in the
visitor's browser. Nothing here talks to a server, and nothing needs a build step.

Status: every claim below is checked by `node tests/run.js --all` (node, pyembroidery byte comparison,
headless Chrome). **No file has been sewn on a physical machine yet.** The file to try first is
`tests/engine/golden/testsew.pes` (about 33 x 45 mm, two colours, about 2,100 stitches; the engine's export
of the `testsew` design in `tests/engine/designs.js` is byte-identical to it).

Only what this file documents is stable. `Engine.Writer` and `Engine.Digitizer` are exposed for tests and
tools and may change.

## 1. Loading

```html
<!-- classic scripts, in this order; they create ONE global: window.Engine -->
<script src="js/engine/lineart.js"></script>   <!-- optional: the 'lineart' fill style (section 4) -->
<script src="js/engine/embwriter.js"></script>
<script src="js/engine/digitize.js"></script>
<script src="js/engine/engine.js"></script>
```

| Where | How | Result |
|---|---|---|
| page | the script tags above | `window.Engine` |
| Web Worker | `importScripts('lineart.js', 'embwriter.js', 'digitize.js', 'engine.js')` | `self.Engine` (this is what `worker.js` does) |
| node | `const Engine = require('./js/engine/engine.js')` | the same object (finds `lineart.js` next to it by itself) |

Without `lineart.js` everything works the same, except that `fill.style: 'lineart'` sews the normal fill and
reports `PARAM_CLAMPED`. Load it before `digitize.js`. The worker always loads it, so a page that leaves the
tag out still gets line art whenever the worker runs; only the main-thread fallback then lacks it.

`worker.js` must stay in the same folder as `engine.js`. A page never loads `worker.js` itself:
`Engine.createClient()` does.

## 2. The whole API

```js
Engine.version                       // '1.0.0'
Engine.generate(design, options?)    // -> result      (synchronous, never throws for bad design data)
Engine.export(result, options?)      // -> file        (synchronous, throws Error with .code)
Engine.exportFile(result, options?)  // same function as Engine.export
Engine.preview(result)               // -> { runs, jumps } for drawing
Engine.validate(resultOrIr)          // -> string[] (empty = stitch data is well formed)
Engine.createClient(options?)        // -> client: the same generate/export as Promises, in a Web Worker
Engine.FORMATS                       // [{ id, ext, mime, label }]
Engine.DEFAULTS, Engine.LIMITS       // numbers used when a setting is missing / out of range
Engine.FILL_PATTERNS                 // { smooth, brick, ribbed, diagonal, crosshatch }: values of fill.pattern, each { label }
Engine.FILL_STYLES                   // { tatami: { label: 'Fill' }, lineart: { label: 'Auto (line art)' } }: values of fill.style
Engine.OP                            // { STITCH: 0, JUMP: 1, TRIM: 2, COLOR_CHANGE: 3, END: 4 }
```

### Example (what an editor does)

```js
const engine = Engine.createClient();          // one per page; worker when possible, main thread otherwise

const design = {
  name: 'My logo',
  hoop: { width: 100, height: 100 },           // mm
  objects: [
    { id: 'a', type: 'ellipse', cx: 50, cy: 50, rx: 30, ry: 20, color: '#cc3344',
      paint: 'both', fill: { angle: 45 }, line: { type: 'satin', width: 2.5, color: '#111111' } },
    { id: 'b', type: 'polyline', points: [[20, 85], [50, 78], [80, 85]], color: '#224488',
      line: { type: 'bean' } },
  ],
};

let latest = null;
async function redraw() {                      // call on every edit; older calls resolve null
  const result = await engine.generate(design);
  if (!result) return;                         // superseded by a newer call: ignore
  latest = result;
  const { runs } = Engine.preview(result);     // draw: one polyline per run, runs[i].color
  // result.totals.stitches, result.warnings, result.canExport ...
}

async function download(format) {              // 'pes' | 'dst' | 'pec' | 'pes6'
  const file = await engine.export(latest, { format, name: design.name });
  const url = URL.createObjectURL(new Blob([file.bytes], { type: file.mime }));
  const a = document.createElement('a'); a.href = url; a.download = file.filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

## 3. Units and coordinates

- Everything a page passes in or reads out is in **millimetres**, origin at the **top-left corner of the
  hoop**, x to the right, **y down** (the same way a canvas draws). Angles are degrees.
- Points are `[x, y]` or `{ x, y }`; both are accepted everywhere.
- Colours are `'#rrggbb'` or `'#rgb'` (case does not matter, `#` optional). Named colours and `rgb()`
  are not understood: resolve them first.
- The exported file is centred on the design's own bounding box (that is how machines place a design),
  so where a design sits inside the hoop does not change the file. The hoop is used for the
  outside-the-hoop checks only.

## 4. Design (input)

```js
design = {
  name?:   string,                      // used for the file name and the label stored in the file
  hoop?:   { width, height },           // mm, each 10..1000. Default 100 x 100
  objects: [ object, ... ],             // sewn in this order, first object first
}
```

`generate` does not modify the design. The design must be plain data (it is copied to the worker).

### Shapes

| `type` | Fields (mm) | Notes |
|---|---|---|
| `'rect'` | `x, y, width, height, rotation?` | `rotation` in degrees, clockwise on screen, about the centre. Negative sizes are allowed. |
| `'ellipse'` | `cx, cy, rx, ry, rotation?` | |
| `'circle'` | `cx, cy, r` | same as an ellipse with `rx = ry = r` |
| `'line'` | `x1, y1, x2, y2` | open: can only be painted as a line |
| `'polygon'` | `points, fillRule?` | closed automatically |
| `'polyline'` | `points, closed?, fillRule?` | freehand strokes; `closed: true` makes it fillable. Default open. |
| `'path'` | `rings, fillRule?` | compound path. Each ring is a point list (closed) or `{ points, closed? }` (`closed` defaults to true). Holes are simply further rings. |

`fillRule` is `'nonzero'` (default, what canvas `fill()` shows) or `'evenodd'`. With `'nonzero'` a hole
must run in the opposite direction to its outer ring; with `'evenodd'` direction does not matter.
Curves must be flattened to points by the caller (a point every 0.5 to 1 mm is plenty).

### Fields every object can have

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | any | none | echoed back in `result.objects[i].id` and in warnings as `objectId` |
| `visible` | boolean | `true` | `false` skips the object |
| `color` | colour | `'#000000'` | thread colour |
| `paint` | `'fill' \| 'line' \| 'both'` | `'fill'` if the shape has a closed ring, else `'line'` | `'both'` sews the fill first, then the outline on top |
| `fill` | object | see below | used when the object is filled |
| `line` | object | see below | used when the object has a line |

`fill` settings:

| Field | Default | Range (clamped) | Meaning |
|---|---|---|---|
| `spacing` | 0.4 | 0.2 to 2.0 | distance between rows, mm. Below 0.3 raises `TOO_DENSE`. |
| `stitchLength` | 3.0 | 1.0 to 7.0 | stitch length along a row, mm |
| `angle` | 0 | any | direction of the rows in degrees: 0 = horizontal, 90 = vertical |
| `pattern` | `'smooth'` | `smooth`, `brick`, `ribbed`, `diagonal`, `crosshatch` | where the needle lands row to row (`Engine.FILL_PATTERNS`). `crosshatch` is an open lattice: two passes at right angles, rows at 3 x `spacing` (at least 1.2 mm), no underlay. An unknown value gives `PARAM_CLAMPED` and the smooth fill. |
| `underlay` | `true` | boolean | edge run plus a loose cross layer under the fill |
| `pullComp` | 0.2 | 0 to 1.0 | each row end is lengthened by this much, mm, to make up for the fabric pulling in |
| `style` | `'tatami'` | `tatami`, `lineart` | how the shape is sewn (`Engine.FILL_STYLES`). `tatami` is the fill described above. `lineart` is for drawings: see below. An unknown value gives `PARAM_CLAMPED` and `tatami`. |
| `lineart` | `{}` | object | settings for `style: 'lineart'`, below. Ignored otherwise. |

#### `fill.style: 'lineart'` (Auto, line art)

For traced drawings, line art, logos and lettering: one filled object that is mostly lines. The engine
measures the drawing's width everywhere (on a 0.05 mm grid) and sews each part the way it would be digitized
by hand. A line's width is measured all along it (the width most of the line has, so a tapering line counts as
fairly wide):

| Part of the drawing | Sewn as |
|---|---|
| lines 0.9 mm wide and more (up to `thin`) | satin along the line, as wide as the line where it is (plus 0.12 mm pull each side), with a running underlay along the centre; stitches on the inside of a sharp bend are shortened |
| lines 0.65 to 0.9 mm | a narrow ring: out along one edge of the line, back along the other |
| lines 0.45 to 0.65 mm | a triple run spread over the line's width |
| lines under 0.45 mm | a running stitch (1.3 mm) along the centre |
| areas wider than `thin` | one running ring 0.15 mm inside the edge, and the normal tatami fill inside it (`spacing`, `stitchLength`, `angle`, `pattern`, `underlay`, `pullComp` of this object apply to it) |
| black the thread would still miss | a small loop just inside its edge, or one stitch there and back |

Sewing order: each connected black area is ONE thread. The needle travels inside the black from piece to
piece, and the order is planned so that most of that travel is covered by stitches sewn later. Separate black
areas always start with a trim, even when they are close together: no thread is laid across bare fabric
(a normal fill joins pieces under 2 mm apart with a stitch). Gaps under 0.2 mm and holes under 0.3 mm2 in the
drawing are closed (the thread cannot show them), specks under 0.2 mm2 are left out.

| `fill.lineart` field | Default | Range (clamped) | Meaning |
|---|---|---|---|
| `detail` | `'normal'` | `'fine'`, `'normal'`, `'bold'` | how much small detail is kept: the gap, hole and speck sizes above are halved (`fine`) or doubled (`bold`). Unknown: `PARAM_CLAMPED` and `normal`. |
| `thin` | 2.0 | 0.5 to 5 | mm. Parts wider than this get the edge ring and tatami; narrower parts are lines. |
| `satinMin` | 0.9 | 0.5 to 3 | mm. Lines at least this wide are satin. |
| `beanMin` | 0.45 | 0.2 to 2 | mm. Lines at least this wide get more than one pass. |
| `res` | automatic | 0.03 to 0.5 | mm per grid pixel; only a coarser grid than the automatic one is used |

The grid is 0.05 mm and never more than 6 million pixels, so for a drawing larger than about 120 x 120 mm it
gets coarser; above 0.1 mm `LINEART_REDUCED` says so (the finest lines may be lost). The same drawing always
gives the same stitches, in node and in every browser. Time, for planning: a busy 82 x 144 mm drawing
(435 rings, about 23,500 stitches) takes about 1.5 to 2 s; the result is kept (8 drawings), so generating the
design again after an edit to another object is immediate.

`line` settings:

| Field | Default | Range (clamped) | Meaning |
|---|---|---|---|
| `type` | `'running'` | `'running' \| 'bean' \| 'satin' \| 'raw'` | `'bean'` is a triple run (forward, back, forward). `'run'` is accepted for `'running'`. `'raw'` sews exactly through the points given, one stitch per point (stitches read from a machine file); `stitchLength`, `width` and `spacing` are not used, and a step over the format limit is still split. |
| `stitchLength` | 2.5 | 1.0 to 7.0 | running and bean stitch length, mm |
| `width` | 3.0 | 1.0 to 12.0 | satin only: column width, mm. Under 1 mm is sewn as a bean stitch (`SATIN_TOO_NARROW`); over 9 mm warns; over 12 mm is cut to 12 mm (`SATIN_TOO_WIDE`). Stitches over 7 mm are split. |
| `spacing` | 0.4 | 0.2 to 2.0 | satin only: distance between stitches along the column, mm |
| `underlay` | `true` | boolean | satin only |
| `color` | the object's `color` | colour | a different thread for the outline (adds a colour change) |

A missing setting takes its default. A setting of the wrong type or outside its range is replaced and
reported with `PARAM_CLAMPED` (or `STITCH_TOO_LONG` for an over-long stitch length); generation goes on.

Closed outlines painted as a line follow every ring (outer ring and holes). A closed shape painted
`'fill'` or `'both'` that contains an open ring: the open ring is sewn as a line and
`OPEN_PATH_NOT_FILLED` is reported.

## 5. Result (output of generate)

```js
result = {
  ok:        boolean,                   // same as canExport
  canExport: boolean,                   // false when any warning has severity 'error'
  name:      string,                    // design.name, or ''
  hoop:      { width, height },         // mm, the hoop actually used
  threads:   [ { color: '#rrggbb', stitches, lengthM } ],   // one per colour block, in sewing order
  objects:   [ { index, id?, stitches, skipped } ],         // one per design.objects entry, same order
  totals: {
    stitches,                           // needle penetrations
    jumps,                              // moves without sewing (one per thread run)
    trims,                              // thread cuts
    colorChanges,                       // threads.length - 1 (0 for an empty design)
    colors,                             // threads.length. The same colour used twice with another in between counts twice.
    threadLengthM,                      // estimate: sewn length x 1.1 + 50 mm per trim
    timeMin,                            // estimate: 600 stitches/min + 6 s per trim + 45 s per colour change
    longestStitchMm,
  },
  bounds:    { minX, minY, maxX, maxY, width, height } | null,   // of the stitches, mm, hoop top-left origin
  warnings:  [ warning, ... ],
  ir:        { ... },                   // the stitches. Opaque: hand it to export / preview. See section 10.
  version:   '1.0.0',
  timeMs:    number,                    // how long generate took
}
```

Guarantees for every result, whatever the input: no `NaN` anywhere; no sewn stitch longer than 12.1 mm;
no zero-length stitch; every thread run starts and ends with lock stitches; the same design always gives
the same stitches.

### Warnings

```js
warning = { code, severity: 'error' | 'warning' | 'info', message, objectIndex?, objectId?, ...extra }
```

`message` is a plain sentence that can be shown to the visitor as it is. `objectIndex` / `objectId` are
present when the warning belongs to one object. Only `'error'` blocks export.

| `code` | Severity | When | Extra fields |
|---|---|---|---|
| `EMPTY_DESIGN` | error | no stitches at all | |
| `OUTSIDE_HOOP` | error | the design would fit, but part of it is outside the hoop | `objectIndexes` |
| `EXCEEDS_HOOP` | error | the stitches are wider or taller than the hoop | `objectIndexes` (objects that poke out) |
| `NON_FINITE_INPUT` | warning | NaN, Infinity, a missing number, or a coordinate beyond 2000 mm. Bad points are dropped; a shape with a bad size is skipped. | `dropped?` |
| `INVALID_OBJECT` | warning | not an object, or an unknown `type`. Skipped. | |
| `INVALID_HOOP` | warning | hoop missing a size or outside 10..1000 mm. 100 x 100 is used. | |
| `INVALID_COLOR` | info | colour not understood. Black is used. | |
| `TINY_OBJECT` | warning | too small to hold a stitch (about 1 mm2 of fill or 0.6 mm of line). Skipped. | |
| `THIN_FILL` | info | a fill under 1 mm wide; a line would sew better | |
| `OPEN_PATH_NOT_FILLED` | warning | an open path was asked to fill; it was sewn as a line | |
| `SATIN_TOO_WIDE` | warning | satin wider than 9 mm (split), or wider than 12 mm (cut to 12 mm) | |
| `SATIN_TOO_NARROW` | info | satin under 1 mm, sewn as a bean stitch | |
| `STITCH_TOO_LONG` | warning | a stitch length over 7 mm was asked for (7 is used), or stitches over 7 mm exist | `count?`, `longestMm?` |
| `TOO_DENSE` | warning | row or satin spacing under 0.3 mm, or thread stacked too thickly in one place (about three fills on top of each other) | `densityMmPerMm2?`, `at?: { x, y }` mm |
| `TOO_LARGE` | warning | one fill would need more than about 400,000 stitches. Skipped. | |
| `PARAM_CLAMPED` | info | a setting was replaced (also: an unknown `fill.style`, or `'lineart'` without `lineart.js` loaded; the normal fill is sewn) | `param`, `value` |
| `LINEART_REDUCED` | info | a `lineart` drawing is so large that it was measured on a grid coarser than 0.1 mm | `resolutionMm` |
| `INTERNAL_ERROR` | warning | the engine failed on one object and skipped it (a bug: please report) | `detail` |
| `TOO_MANY_STITCHES` | error | the whole design needs more than 500,000 stitches (`LIMITS.maxStitches`). Nothing is exported. | `stitches`, `limit` |
| `LARGE_DESIGN` | warning | more than 100,000 stitches (`LIMITS.largeDesign`): slow to sew, small home machines may not load it. Still exportable. | `stitches`, `threshold`, `timeMin` |
| `COLORS_MERGED` | warning | two or more design colours are stored under the same Brother thread entry (.pes / .pec). The stops are unchanged. | `groups: [{ paletteIndex, paletteName, paletteColor, colors, formats }]` |
| `COLOR_SUBSTITUTED` | info | a colour is listed under a Brother thread entry that is not its nearest one, because that one was taken. Only the name on the machine differs. | `colors: [{ color, paletteIndex, paletteName, paletteColor, nearestIndex, nearestName }]`, `formats` |

## 6. Export

```js
file = Engine.export(result, { format?: 'pes', name?: string })
file = { bytes: Uint8Array, filename, mime, format, label, stitches }
```

| `format` | File | `Engine.FORMATS` label | Notes |
|---|---|---|---|
| `'pes'` (default) | `.pes` | Brother PES (v1) | the safest choice for Brother / Babylock home machines. Colours are the nearest of the 64 Brother palette threads. |
| `'dst'` | `.dst` | Tajima DST | commercial machines. Stores no colours, only where to stop. |
| `'pec'` | `.pec` | Brother PEC | the stitch block of a PES on its own |
| `'pes6'` | `.pes` | Brother PES (v6) | keeps exact RGB colours for software that reads them |

`Engine.FORMATS` is `[{ id, ext, mime, label }]` in the order above; use it to build a format menu.
`mime` is `'application/octet-stream'` for all four.

- `name` falls back to `result.name`, then `'design'`.
- `file.filename` is safe to use as a download name: ASCII letters, digits, space, dash and underscore
  only, at most 60 characters, plus the extension (`'My Logo v2.pes'`).
- `file.label` is the name stored inside the file: printable ASCII, accents removed, never empty
  (`'Untitled'`). PES and PEC keep 8 characters, DST 16.
- `export` needs only `result.ir`, `result.warnings`, `result.canExport`, `result.name`, `result.totals`.

`export` throws an `Error` with a `code`:

| `error.code` | When |
|---|---|
| `UNKNOWN_FORMAT` | `format` is not in `Engine.FORMATS` |
| `INVALID_RESULT` | the first argument is not a result of `generate` |
| `EMPTY_DESIGN`, `OUTSIDE_HOOP`, `EXCEEDS_HOOP` | the result has a warning of severity `'error'`: the code and message of the first one. `error.warnings` holds all of them. |
| `NOT_EXPORTABLE` | `canExport` is false without an error warning |
| `INVALID_IR` | the stitch data was altered and is no longer well formed |
| `TOO_MANY_COLORS` | more than 255 colour blocks |

`error.message` can be shown to the visitor.

## 7. Preview

```js
const { runs, jumps } = Engine.preview(result);
runs  = [ { thread, color: '#rrggbb', points: Float32Array [x0, y0, x1, y1, ...] } ]   // mm, hoop top-left origin
jumps = [ { x1, y1, x2, y2, thread } ]                                                 // moves between runs
```

One run is one unbroken length of thread (needle down to trim), in sewing order. `thread` is an index
into `result.threads`. Draw each run as a polyline; draw jumps dashed if at all. `preview` is cheap
(one pass over the stitches) and runs on the main thread.

## 8. Async client (use this from pages)

```js
const client = Engine.createClient(options?)
```

| Option | Default | Meaning |
|---|---|---|
| `workerUrl` | `worker.js` next to `engine.js` | where the worker script is |
| `forceMainThread` | `false` | never start a worker |
| `readyTimeoutMs` | 4000 | a worker that has not started by then is given up; `0` waits forever |
| `cancelAfterMs` | 800 | see "stale requests"; a negative number never cancels |
| `onModeChange` | none | called with `'worker'` or `'main'` when the mode is decided or changes |

```js
client.generate(design, { onProgress? })  // Promise<result | null>
client.export(result, { format?, name? }) // Promise<file>      (client.exportFile is the same function)
client.ready                              // Promise<'worker' | 'main' | 'closed'>
client.mode                               // 'starting' | 'worker' | 'main' | 'closed'
client.terminate()                        // stop the worker; later calls reject with code 'CLIENT_CLOSED'
```

- Results and files are identical to the synchronous calls, byte for byte, in both modes.
- **Fallback.** The client runs on the main thread when a worker cannot be constructed (pages opened
  from `file://`, strict content security policies), fails to load, crashes, or does not report ready
  in time. Work that was in flight is done again on the main thread; no call is lost. Calls may be made
  straight away, without waiting for `ready`.
- **Stale requests.** Only the newest `generate` matters. A call that had not started when a newer one
  arrived resolves `null`. A call already running resolves with its result when it finishes, unless it
  is still running `cancelAfterMs` after being superseded: then the worker is restarted and it resolves
  `null`. So: always ignore a `null`, and a non-null result may belong to an older call than the
  latest (the latest still resolves afterwards).
- `export` calls are never dropped and can be made while a `generate` is running.
- `onProgress(done, total)` reports objects finished (at most about 20 times a second in a worker).
- `generate` rejects only if the engine itself throws (not expected); bad design data becomes warnings.
  `export` rejects with the same errors `Engine.export` throws (`error.code`, `error.message`,
  `error.warnings`).
- A result that came from the worker can be passed to `Engine.preview`, `Engine.export` and
  `client.export` as often as needed.

## 9. Worker protocol (only needed when not using createClient)

```
page -> worker   { type: 'generate', id, design, progress?: boolean }
                 { type: 'export',   id, result, options: { format, name } }
worker -> page   { type: 'ready',    version }                    once, after loading
                 { type: 'progress', id, done, total }
                 { type: 'result',   id, result }                 answer to 'generate'
                 { type: 'exported', id, file }                   answer to 'export'
                 { type: 'error',    id, error: { code, message, warnings? } }
```

Requests are handled one at a time, in order. Every answer carries the `id` of its request.

## 10. Stitch data (`result.ir`), for reference

```js
ir = {
  units: '0.1mm', origin: 'hoop-centre',
  hoop: { w, h },                        // 0.1 mm
  threads: [ { color: '#rrggbb' } ],     // one per colour block
  commands: Int32Array,                  // (op, x, y) triples; x right, y down, 0.1 mm, origin = hoop centre
  bounds: { minX, minY, maxX, maxY } | null,
}
```

Ops are `Engine.OP`. Each thread run is `JUMP` (to the start), `STITCH` at the same point, more
`STITCH`es, `TRIM`. `COLOR_CHANGE` comes only after a `TRIM`; `END` is last and appears once.
`Engine.validate(result)` checks these rules and returns the violations.

To millimetres in design coordinates: `x_mm = (x + Math.round(ir.hoop.w / 2)) / 10`, `y_mm = (y + Math.round(ir.hoop.h / 2)) / 10`
(for a hoop size that is a multiple of 0.2 mm that is simply `x / 10 + hoop.width / 2`). `Engine.preview` does this for you.
Stitches are snapped to a 0.1 mm grid fixed to the design coordinates, so the hoop size never changes them.

## 11. Constants

```js
Engine.DEFAULTS = {
  hoop:  { width: 100, height: 100 },
  color: '#000000',
  fill:  { spacing: 0.4, stitchLength: 3.0, angle: 0, underlay: true, pullComp: 0.2 },
  line:  { type: 'running', width: 3.0, stitchLength: 2.5, spacing: 0.4, underlay: true },
}

Engine.LIMITS = {
  coord: 2000, hoop: [10, 1000],
  fillSpacing: [0.2, 2.0], fillStitchLength: [1.0, 7.0], pullComp: [0, 1.0],
  lineStitchLength: [1.0, 7.0], satinSpacing: [0.2, 2.0], satinWidth: [1.0, 12.0],
  denseBelow: 0.3, satinWideAbove: 9.0, longStitchAbove: 7.0, minStitch: 0.3, maxStitch: 12.1,
  maxFillDensity: 8.0, maxDensity: 15.0, objectStitches: 400000,
}
```

Use `LIMITS` for slider ranges and `DEFAULTS` for initial values so the editor and the engine agree.

## 12. What the engine does not do

- No text, no curves, no SVG parsing, no image tracing: the caller turns those into points.
- No automatic reordering of objects or colours: the list order is the sewing order.
- No reading of embroidery files.
- Speed, for planning: a 100 x 100 mm fill (about 10,000 stitches) takes a few milliseconds; a 190 mm
  circle (about 28,000 stitches) about 10 ms on a laptop.
