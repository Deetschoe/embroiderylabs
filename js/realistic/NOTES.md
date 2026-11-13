# Realistic stitch renderer: working notes

Owner request: in Stitch Out, an "Export to realistic image" button and a live "viewport shader" that shows
the design as real thread on real-looking fabric / on a shirt. Static site, no server, no dependencies.

Owned folders: `js/realistic/**`, `tests/realistic/**`. Nothing else in the repo was touched; the module is
NOT wired into any page yet (that is the integrator's job, against `API.md`).

## Files
- `core.js` (`RealisticCore`): no DOM. Options, stitch commands -> thread segments, loft map, procedural
  fabrics, the tile rasteriser. Runs on the page, in a worker and in node. The whole file is one function
  (`core.factory`) whose source text is what the Blob worker is built from, so it must stay self-contained.
- `realistic.js` (`Realistic`): the public API. Layout, scenes (hoop, T-shirt, hoodie), progressive tiles,
  worker pool with main-thread fallback, PNG export.
- `API.md`: the contract for the integrator.
- `tests/realistic/run.js`: `node tests/realistic/run.js` (pure tests + headless Chrome), `--pure` for node only.

## Decisions
- ONE renderer: a software rasteriser in plain JS on typed arrays. No WebGL, no three.js. The experiment was
  whether JS on the CPU is fast enough to be interactive; it is (numbers below), so there is no second path to
  keep in step and nothing that fails where WebGL is missing. Output is `putImageData` into a 2D canvas.
- Painter's algorithm in sewing order, linear-light float tile buffers, sRGB out. 256 px tiles, stitched tiles
  first, from the centre out. Thin-on-screen thread is supersampled (up to 4x4) only in tiles with stitches.
- Thread: capsule with a cylinder normal, Kajiya-Kay style sheen from the thread direction (turned by the twist
  angle) against the light, 2-ply groove, filament streaks, taper and darkening into the needle hole, a small
  arc out of each hole, a soft shadow per stitch, seeded variation per stitch.
- Satin: threads sewn side by side closer than their width are squeezed (`squeeze[]`) and shaded from the top,
  otherwise the picture depended on which way round a column was sewn (found by the light-angle test).
- Loft map: coarse grid of thread layers, gives the design's shadow on the cloth and hides cloth under fills.
- Fabrics: periodic height maps (jersey V wales, brushed fleece, 2/1 twill, 3/1 denim with pale weft), lit,
  cached per colour / scale / light. Below about one pixel per yarn the weave fades to its mean colour.
- Scenes are Canvas 2D on top of the core picture: hoop ring; T-shirt and hoodie outlines in millimetres with
  folds, seams, rib, cords. Composites are throttled and skipped during export (a 27 MP garment export went
  from 101 s to 1.3 s when the per-tile composites were removed).
- Workers are Blob workers (works from file://). If a worker cannot start or fails, the main thread takes over
  in 14 ms slices.

## Measured (headless Chrome, Apple M2 Pro, 4 workers; final code; table in API.md)
- 1200 x 800 viewport: first frame 20-40 ms, final frame 62 ms (2.5k stitches), 184 ms (21k), 230 ms (103k).
- Without workers: final frame 182 / 652 / 718 ms; the page stays responsive (time sliced).
- Export 2400 x 2400 (default): 0.19 / 0.34 / 0.77 s to render plus 0.15-0.2 s PNG encoding; 13-15 MB files.
- Export 3600 x 3600: 0.37 / 0.39 / 0.82 s plus 0.4 s PNG; 26-34 MB files.
- Largest export allowed, 6000 x 6000 with 103k stitches: 1.0 s render, 2.1 s with PNG, 92 MB file, browser
  memory (all its processes) up by 240-460 MB at the peak over two runs, JS heap 61 MB afterwards.
- Scratch demo, ten canvases at once (badge, 11k stitches): all drawn in 1.4 s cold, 0.4-0.6 s warm.

## Status
- Done and run: core.js, realistic.js, API.md, tests (`node tests/realistic/run.js`: 642 checks, 28 tests, of
  which 10 in headless Chrome from file://).
- Looked at, full size and zoomed: all four fabrics, light angles, swatch, hoop, T-shirt and hoodie in both
  placements and both framings, show jumps, transparent export, the six test designs.
- Found late by the scratch demo and fixed: two canvases rendering at once shared workers and the first one
  never finished. Worker answers are now routed by job id; there is a test for it and for a worker dying mid-way.

## Known gaps
- No WebGL path (by decision). No DPR handling: the caller sizes the canvas in device pixels.
- Fabric zoomed far in (30+ px/mm) is stylised, denim most of all (its pale weft dots are too regular).
  Fleece is the weakest of the four.
- The hoodie is the weakest scene: the hood is a simple keyhole shape. Garments are flat front views only.
- Satin is fairly matte next to real rayon thread, and two columns sewn in opposite directions still differ by
  about 10% in brightness under the same light.
- Chest framing shows soft cloudy shading from the crease map; on pale cloth it can read as slightly uneven.
- PNGs are large because cloth texture does not compress; default export scale is 2 for that reason.
- Only run in headless Chrome 157 on macOS. Firefox, Safari, phones and real `http://` serving were not run
  (port 8205 was never used; everything was tested from file://).
- Not wired into any page.

## Verification pass (a second person: art direction, break tests, budgets)
Changed, each with a regression test in `tests/realistic` that fails on the code as it was:
- A needle point repeated in place no longer draws fuzzy stubs (compile compares the raw points).
- Export can no longer exceed 36 MP (a 1e9 x 1e9 view gave 8192 x 8192): the view itself is shrunk, shape kept.
- A canvas whose picture the browser threw away (context lost/restored, forced with a GPU process crash) is
  redrawn by itself: `remember()` keeps the last design and options per canvas in a WeakMap.
- Page thread: `SYNC_COST` 1.6e6 -> 0.45e6 (a 1000 x 1000 picture of three stitches was drawn in one 120-140 ms
  go); tiles are 128 px where supersampled (a 256 px tile took up to 177 ms without workers); the quick frame is
  at most 300,000 pixels on a draft fabric (`makeFabric(..., draft)`); the weave's shape is kept between colours
  and lights (denim: 96 ms cold, 7 ms for a new colour); the table and the garment's big soft shadow are drawn
  once per render, not once per composite.
- Look: more sheen and stitches that differ from their neighbours (`ks` 1.3, per-stitch glint 0.55 to 1.55),
  thread as bright as cloth of its colour (white on white came out grey), fibre scatter so that the knit of
  dark cloth shows, calmer mottling, a hoop with two bevelled rings and a steel screw with a brass nut, a hood
  whose inside is shaded cloth and not a black hole.
- The browser tests no longer use the engine's `heavy` stress design (the engine now refuses it as over 500,000
  stitches, which left nothing to draw): `T.heavy()` in `tests/realistic/browser/page.html` makes 105,000
  stitches itself.

Still gives it away (honest list): thread is too clean (no fuzz, no stray fibres, every stitch dead straight);
no depth of field, lens softness or sensor noise; cloth has no real wrinkles, only soft shading; whole-garment
views are tidy vector flat-lays (hoodie weakest), fine as a mockup, not as a photograph; fleece close up is
flat; white thread fills on white cloth read slightly grey. The chest framing, the swatch close-ups and the
hoop are the pictures to post.
