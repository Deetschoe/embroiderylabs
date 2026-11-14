# js/trace working notes (image to embroidery)

Status: DONE for this round (2026-11-12). API is in js/trace/API.md. Read "Known poor spots" before promising
anything to a visitor.

Scratch (sample pictures, renders, demo page, throwaway scripts; not in the repo):
/private/tmp/claude-501/-Users-dieterschoening-Developer-EmbroideryLabs/932b156b-d936-4a4b-9f2b-9d917247677b/scratchpad/trace-work/
Port for my own static server: 8203 only (stopped). Never touch 8000.

## State
- js/trace/trace.js (about 1900 lines, UMD, no dependencies), worker.js, client.js, API.md: written.
- tests/trace/run.js: 29 tests, `node tests/trace/run.js` -> 29 passed (about 11 s; `--no-python` skips the
  PES/DST read-back, `--only=word`, `--keep=<dir>`, `--verbose`). tests/trace/e2e.js + render.py: trace ->
  Engine.generate -> Engine.export -> pyembroidery read-back -> picture of the stitches beside the source.
  `node tests/trace/e2e.js <outDir> <picture> width=100 [colors=6 detail=medium mode=auto background=auto]`
- Browser: scratch demo.html run in headless Chrome 157 over http (worker mode) and from file:// (main-thread
  fallback). Worker, progress, cancel + respawn, replace-running-job, AbortSignal, missing worker file fallback,
  terminate, unreadable file, 12 MP shrink: all behaved as API.md says. Reports in scratch reports/*.json.
- Wired into the editor on 2026-11-13 (js/editor/trace.js). Still no real sew.

## 2026-11-13: colours 'auto' and up to 30 colours (API 1.1.0)
- `colors: 'auto'` + `maxColors` (default 10): rule in API.md "Automatic colour count", code `chooseColours` /
  `AUTO` in trace.js. Tuned on the 47 sample pictures (trace-work/img, trace-verify-work/img, the user's line art):
  logos pick exactly their colours (badge 4, clipart 8, cat 8, cmyk 5, pale 4), photographs 4 to 10.
  Scratch tools: .../30968e87-.../scratchpad/autoc/ (curves.js prints the rms / miss curve per picture, same.js
  checks that numeric colours <= 12 give byte-identical results to 1.0.0: 138 runs, 0 differ).
- `LIMITS.colors` 2..30. Two fixes were needed above 12: the logo/photo probe palette grows with the request
  (16 flat colours were taken for a photograph with a 12-colour probe), and `withoutBlends` stops spare palette
  slots going to edge blends (only when more than `SEW.blendsAbove` = 12 colours are asked for).
- `buildPalette` split into `colourBins` + `kmeansBins` (same arithmetic) so the auto scan bins once.
- Editor wiring is js/editor/trace.js ("Turn into stitches"), see js/editor/NOTES.md.

## What the pipeline does (as coded)
1. resample to 0.18/0.22/0.28 mm per pixel (detail high/medium/low), premultiplied alpha, alpha >= 0.5 = picture
2. pixels classed core / transition (anti-aliased edge) / ridge (thin line), with a saddle guard so shapes of one
   colour touching at a corner are not taken for a line
3. texture finer than thread can show (0.5 mm checker, halftone) is blended to its average colour, but only
   where the busy area is a few mm across (small print must not be smeared)
4. bilateral smoothing in OKLab; background = transparent pixels or a flat border colour (found before the
   palette, so it does not use up a colour)
5. palette: weighted k-means over a colour histogram of core pixels; near-identical clusters merged
6. mode: logo when >= 72% of pixels sit within 0.012 OKLab of a 12-colour probe palette and half are flat
   (measured: logos 0.86-0.99, photographs 0.07-0.58)
7. regions: 4-connected components; specks absorbed into the best neighbour (photo: bigger minimum)
8. strokes pass first: even bands 0.9-3.6 mm -> satin along the recentred skeleton. Then hairlines: < 1 mm ->
   bean (running below 0.35 mm). Small print is left out (DETAIL_LOST), including the end letters of a word.
   A line that ends up lying on its own colour is dropped.
9. colour order by bulk, adjusted so a colour whose lines lie on another colour's fill sews after it;
   colour changes = colours - 1
10. underlap: each fill grows 0.45 mm under LATER colours only, never more than two layers
11. rings: crack-following trace, corner-aware smoothing, Douglas-Peucker, self-intersection fallback
12. fill angles vary between touching regions (45/135/0/90)
13. underlay off for: every photograph fill; a logo fill with >= 30% of its edge against fills already sewn
    with underlay (SEW.inlaidShare)

## Engine facts found by running it (do not re-derive)
- unknown fields on objects (name, trace, fillRule) are accepted; per-fill `underlay: false` is honoured
- satin lines are already widened by the engine, so trace.js adds no pull compensation
- TOO_DENSE = 6th densest 2 mm cell over 8 mm of thread per mm2. One underlaid fill alone puts 4.2-4.8 in a cell
  at its edge, so TWO underlaid fills along a straight seam (or at a sharp notch) reach 8.1-9.4 whatever the
  underlap distance. Removing underlay from either one clears it. That is why rule 13 exists. A single ragged
  photograph fill with underlay reaches 8.7 on its own, hence no underlay for photographs.
- PES v1 only names the nearest of 64 Brother chart threads; render.py draws with the design's own colours

## Editor facts (js/editor/model.js, read only)
- has a `path` type with rings; `Editor.Model.addMany([{ geom, style }], label)` adds a list as one undo step
  (returns [] over 2000 objects); `toEngine()` does NOT pass per-object underlay (gap, see API.md)
- js/editor/trace.js is `Editor.Trace`, a trace-over guide picture. Different thing from the global `Trace`.

## Measured
node 22, 100 mm, medium (objects / engine stitches / colour changes):
badge.png 11 / 9553 / 3; wordmark.png 25 / 2167 / 1; clipart.png 19 / 12962 / 5; clipart_q50.jpg 19 / 13154;
badge_q25.jpg 11 / 9611; badge_q60.jpg 13 / 9971; gradient.png 8 / 5556; drawing.png 6 lines / 215;
tiny.png 2 / 5937 (LOW_RESOLUTION). No engine warnings on any logo sample.
Photographs (5 colour changes each): Owl 97 / 21546; Parrot 40 / 15244; Penguin 24 / 12834; Leaf 128 / 23370;
Zebra 64 / 17453; Eagle 41 / 15001; Sunflower 34 / 15872; RedRose 111 / 23112; Soccer 30 / 14190.
Engine THIN_FILL on Leaf, RedRose, Eagle. PES read-back coverage 0.95-0.98.
Headless Chrome 157, worker: logos 70-280 ms trace, photographs 240-350 ms, 12 MP JPEG read+shrink 83 ms then
440 ms trace at 150 mm; Engine.generate 3-23 ms. Main thread (file://): same results, page held at most about
100 ms at a time for a logo, 230-310 ms for large jobs.

## Known poor spots
- photographs: recognisable for bold subjects (sunflower, eagle, rose, ball), rough for busy ones (parrot),
  zebra stripes merge into blobs; white studio background kept unless background:'on'
- clip art at 6 colours: cream wall merges with the page background (left bare), brown merges into red; 8 fixes it
- drawing.png: a triangle is bent where a curve crosses it at a shallow angle (skeletons merge)
- satin lettering about 6 mm tall is readable but rough; smaller text is left out
- a gradient in a logo becomes bands, with no warning of its own
- edges sit on the working grid (about +-0.1 mm); no sub-pixel edge placement
- rule 13 is a heuristic tuned on the samples and one synthetic scene; a fill without underlay may show the
  cloth through more on stretchy fabric. Untested on cloth.
- nothing has been sewn on a real machine

## Scratch helpers
serve.py (static server on 127.0.0.1:8203, stores POSTed reports), demo.html (`?suite=1&name=x` runs the
automated checks; without it, drop a picture), runchrome.sh <url> <report> (headless Chrome, waits for the
report), show.js (prints a report), summ.js / summ2.js (one line per sample, with / without rendering),
low.js (the TOO_DENSE seam scene), dense2.js (densest cell per object), img/ samples, out/ renders.
