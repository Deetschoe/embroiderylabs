# Realistic stitch renderer: API (v1.0.0)

Draws the engine's computed stitches as thread sewn into cloth, in a `<canvas>`, live and as a PNG.
Everything runs in the visitor's browser. No dependencies, no network requests, no WebGL. Works from `file://`.

```html
<script src="js/realistic/core.js"></script>       <!-- window.RealisticCore: the maths, no DOM -->
<script src="js/realistic/realistic.js"></script>  <!-- window.Realistic: what you call -->
```

`core.js` must come first. Both are classic scripts (UMD); in node `require('./js/realistic/realistic.js')`
gives the same object, but only the parts that need no canvas do anything there (see "In node").

```js
var result = Engine.generate(design);                       // js/engine, unchanged
var stats = await Realistic.render(canvas, result, { fabric: 'jersey', fabricColor: '#1f2937' });
var blob  = await Realistic.exportImage(result, { scene: 'garment', garment: 'hoodie', fabric: 'fleece' });
```

## Realistic.render(canvas, design, options) -> Promise<stats>

Draws into `canvas` at the canvas's own pixel size (`canvas.width` x `canvas.height`). It does not resize the
canvas and knows nothing about `devicePixelRatio`: for a sharp picture on a retina screen, set
`canvas.width = cssWidth * devicePixelRatio` yourself.

- Never throws and never rejects. Bad input gives `warnings` or `{ ok: false, error }`.
- The returned promise has a `.cancel()` method. Calling `render` again on the same canvas cancels the render
  still running on it (its promise resolves with `cancelled: true`), so it is safe to call on every slider move.
- Small pictures (up to roughly 600 x 600 pixels of plain cloth) are drawn at once, before `render` returns.
  Larger ones show a quick coarse frame at once and are then drawn tile by tile (256 px tiles, 128 px where thin
  thread is supersampled; stitched tiles first, from the middle out), in up to four workers, or in 14 ms slices
  on the page's own thread where workers are not available.
- If the browser throws the canvas's picture away (its `contextlost` / `contextrestored` events: the graphics
  process restarted), the last picture rendered on that canvas is drawn again by itself. Nothing to do.
- The same design, options, canvas size and seed always give exactly the same pixels, with or without workers.
- Several canvases can be rendered at the same time; they share the workers.

### design

Either of these. All stitch coordinates are the engine's: integers in 0.1 mm.

1. An `Engine.generate()` result, as it is. Used: `result.ir.commands`, `result.ir.threads`, `result.ir.hoop`,
   `result.hoop`. Positions come out in millimetres from the hoop's top-left corner, like `result.bounds`.
2. A plain object: `{ stitches, threads, unit, offset, hoop }`
   - `stitches` (or `commands`): `Int32Array` or array of `(op, x, y)` triples. Ops as in `Engine.OP`:
     `0 STITCH, 1 JUMP, 2 TRIM, 3 COLOR_CHANGE, 4 END`.
   - `threads`: `[{ color: '#rrggbb' }, ...]` or `['#rrggbb', ...]`; one per colour block. `#rgb` and
     `rgb(r, g, b)` are also read. A missing colour is drawn black with a warning.
   - `unit`: millimetres per coordinate step, default `0.1`.
   - `offset`: `{ x, y }` or `[x, y]` in millimetres, added to every point. Default `0, 0`.
   - `hoop`: `{ width, height }` in millimetres. Only needed for `hoop: true`.

   `bounds` and `stats` on the design are not needed: the bounds are measured from the stitches.

Thread is drawn between consecutive STITCH points. JUMP, TRIM and COLOR_CHANGE lift the thread; END stops.
At most 2,000,000 stitches are drawn (`TOO_MANY_STITCHES`).

### options (all optional)

| option | default | values |
| --- | --- | --- |
| `fabric` | `'jersey'` | `'jersey'` (T-shirt knit), `'fleece'` (sweatshirt), `'twill'` (canvas, caps), `'denim'` |
| `fabricColor` | `'#e8e4dc'` | `#rgb`, `#rrggbb` or `rgb()`; any colour |
| `scene` | `'swatch'` | `'swatch'` (flat cloth filling the canvas) or `'garment'` |
| `hoop` | `false` | swatch only: draw an embroidery hoop around the design's hoop area |
| `garment` | `'tshirt'` | `'tshirt'` or `'hoodie'` (garment scene) |
| `placement` | `'left-chest'` | `'left-chest'` or `'center-chest'` (garment scene). The design is at true scale. |
| `framing` | `'garment'` | `'garment'` shows the whole garment, `'chest'` zooms in on the chest around the design |
| `lightAngle` | `315` | degrees, where the light comes FROM: 0 = top of the canvas, 90 = right, clockwise. Any number. |
| `lightElevation` | `48` | degrees above the cloth, 10 to 85. Low light shows more relief. |
| `pixelsPerMm` | fit | canvas pixels per millimetre. Without it the design (or hoop, or garment) is fitted to the canvas. |
| `origin` | centred | `[x, y]` or `{ x, y }`: canvas pixel of the design's 0,0 mm. Only read together with `pixelsPerMm`. |
| `margin` | `0.12` | free border when fitting, as a share of the canvas, 0 to 0.45 |
| `showJumps` | `false` | draw the jumps between objects of one colour as faint thin threads |
| `seed` | `1` | integer; changes the small random differences between stitches |
| `threadWidth` | `0.4` | millimetres, 0.15 to 1.2 |
| `transparent` | `false` | swatch: no cloth, only thread and its shadow. Garment: no backdrop behind the garment. |
| `backdrop` | `'#f1efea'` | garment scene: the surface the garment lies on |
| `onProgress` | none | `function (fraction)`, 0 to 1, called as tiles finish |
| `onFirstFrame` | none | `function ({ firstFrameMs })`, called once when the quick frame is on the canvas (large renders only) |
| `sync` | `false` | `true`: draw everything before returning, whatever the size (blocks the page) |
| `workers` | `true` | `false`: never use workers |
| `quickFrame` | `true` | `false`: no coarse first frame |
| `progressive` | `true` | `false`: hoop and garment scenes are only put together once, at the end |

A wrong value never stops the picture: the default (or the nearest allowed number) is used and a `BAD_OPTION`
warning says so. `Realistic.DEFAULTS`, `.FABRICS`, `.SCENES`, `.GARMENTS`, `.PLACEMENTS` list the values, for
building menus. `Realistic.normalizeOptions(options)` returns what would be used, plus `warnings`.

Panning and zooming: pass `pixelsPerMm` and `origin`. Canvas pixel = millimetre x `pixelsPerMm` + `origin`.
The `stats` of a fitted render give you both to start from.

### stats

```js
{ ok: true, cancelled: false,
  firstFrameMs, totalMs, compileMs,        // milliseconds since render() was called
  stitches, segments, threads,             // needle points read, thread pieces drawn, colours
  width, height,                           // canvas pixels
  pixelsPerMm, origin: [x, y],             // the view that was used
  designRect: { x, y, width, height },     // the stitches' bounding box in canvas pixels; null if no stitches
  garment: { kind, x, y } | null,          // garment scene: canvas pixel of the garment's neck point
  supersample, tiles, workers, quickFrame, // how it was drawn
  warnings: [{ code, message }] }
```

On failure: `{ ok: false, cancelled, error: { code, message }, warnings, firstFrameMs, totalMs }`.
A cancelled render resolves with `ok: false, cancelled: true` and no `error`.

Error codes: `CORE_MISSING` (core.js not loaded), `NO_CANVAS`, `EMPTY_CANVAS` (zero size), `RENDER_FAILED`.

Warning codes: `BAD_OPTION` (with `option`, `value`, `used`), `EMPTY_DESIGN`, `BAD_DESIGN`, `BAD_STITCHES`,
`BAD_THREAD_COLOR`, `TOO_MANY_STITCHES`, `LARGE_FOR_PLACEMENT` (wider than 130 mm on the left chest),
`QUICK_FRAME_FAILED`, `SCENE_FAILED`. A design with no stitches still draws the bare cloth, with `ok: true`
and an `EMPTY_DESIGN` warning.

## Realistic.exportImage(design, options) -> Promise<Blob>

Resolves with a PNG `Blob` (`image/png`). Rejects with an `Error` carrying `.code` (`NO_CANVAS`,
`ENCODE_FAILED`, `EXPORT_FAILED`, or one of render's error codes). Takes every render option, plus:

| option | default | meaning |
| --- | --- | --- |
| `width`, `height` | `1200` x `1200` (garment scene: `1200` x `1400`) | size of the view in screen pixels |
| `scale` | `2` | 1 to 4. The PNG is `width x scale` by `height x scale` pixels. |
| `transparent` | `false` | as above: thread only, or the garment without its backdrop |
| `onStats` | none | `function (stats)`: render's stats plus `scale`, `bytes`, `exportMs`, called before the promise resolves |

To export exactly what a viewport shows, pass the viewport's `width`, `height`, and the `pixelsPerMm` and
`origin` from its stats; both are multiplied by `scale` for you.

Limits (`Realistic.limits`): 8192 pixels a side and 36 million pixels in all. A larger request has its scale
lowered in steps of 0.25 and gets an `EXPORT_SCALED_DOWN` warning in `onStats`. A view that is too large even
at scale 1 is made smaller, keeping its shape (same warning); the PNG is then smaller than `width` x `height`.

File size: cloth texture hardly compresses. Count on about 2.3 bytes per pixel: 13 to 15 MB at the default
2400 x 2400, about 30 MB at 3600 x 3600, 92 MB at 6000 x 6000. That is why the default scale is 2.

```js
Realistic.exportImage(result, { fabric: 'twill', scale: 2 }).then(function (blob) {
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'stitch-out.png'; a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
});
```

## Smaller things

- `Realistic.layout(design, options, width, height)` -> `{ ppm, ox, oy, design: { x, y, width, height } | null,
  garment, fit }`: where a render of that size would put things, without drawing. Never throws (null on failure).
- `Realistic.fabricCanvas(fabric, color, pixelsPerMm, lightAngle)` -> a canvas holding one seamless patch of the
  cloth (for a CSS background or `ctx.createPattern`), or `null`.
- `Realistic.dispose()`: stops the workers and frees them. They start again on the next render.
- `Realistic.version`, `Realistic.limits`.
- `RealisticCore` is the engine room (compile, fabrics, the tile rasteriser). Use it only if you need pixels
  without a canvas; `tests/realistic/pure.test.js` shows how.

## In node

`require('./js/realistic/realistic.js')` works; `normalizeOptions` and `layout` are real. `render` resolves
`{ ok: false, error: { code: 'NO_CANVAS' } }`, `fabricCanvas` returns `null`, `exportImage` rejects with a code.

## Speed and memory

Measured in headless Chrome on an Apple M2 Pro with four workers. Slower machines will be slower; treat these as
a guide. "First" is the time until something is on the canvas, "final" until the picture is finished.

| stitches | 1200 x 800 viewport, first / final | same without workers | export 2400 x 2400 (render + PNG) | export 3600 x 3600 |
| --- | --- | --- | --- | --- |
| 2,472 | 32 / 62 ms | 33 / 182 ms | 185 + 205 ms, 12.8 MB | 366 + 405 ms, 26 MB |
| 21,296 | 20 / 184 ms | 16 / 652 ms | 341 + 156 ms, 14.8 MB | 392 + 383 ms, 32 MB |
| 102,802 | 38 / 230 ms | 40 / 718 ms | 767 + 147 ms, 14.9 MB | 821 + 382 ms, 34 MB |

Largest export allowed (6000 x 6000, 102,802 stitches): 1.0 s to render, 2.1 s with the PNG, a 92 MB file. The
browser's memory rose by roughly 250 to 460 MB while it ran (two runs) and the JS heap was back at 61 MB after.

Garment scenes cost more because the scene is put together from layers: a 2400 x 2800 garment with 100,000
stitches took 215 ms to the first frame and 2.3 s to the final one; a hoodie export at 4800 x 5600 took 1.3 s.

Checked again by a second person, on a busy machine, with a 33,000-stitch 100 mm design: first frame 30 to 70 ms
at 1200 x 800 and 70 to 110 ms for a 1000 x 1200 garment; export 2400 x 2400 in 0.5 s, 3600 x 3600 in 1.0 s;
300,000 stitches: first frame 0.19 s, finished in 2.1 s (6.4 s without workers). The longest the page's own
thread was held: about 90 ms (cold start, first render) and, in Chrome without a GPU only, 150 to 180 ms for
the first frame of a 2000 x 2400 garment (about 105 ms with a GPU): putting the garment scene together is
Canvas 2D work that grows with the canvas.

For a live viewport: call `render` when the design or an option changes, not every animation frame. A light
slider can call it on every `input` event; the previous render is cancelled for you.

## What it does not do

- No WebGL. One software renderer draws everything, so the picture is the same everywhere.
- Garments are flat front views of a T-shirt and a hoodie. No sleeves, back or cap placements.
- It draws the stitches it is given. It does not simulate pull, puckering or thread breaks.
- Checked in headless Chrome on macOS only. Firefox and Safari have not been run.
