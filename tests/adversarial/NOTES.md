# Adversarial engine tests: working notes

Key `engine-verify`, own port 8107 (never 8000). Scratch (use as `ADV_TMP`):
`/private/tmp/claude-501/-Users-dieterschoening-Developer-EmbroideryLabs/932b156b-d936-4a4b-9f2b-9d917247677b/scratchpad/engine-verify-work/`

State: FINISHED. Everything below was run on the final engine code.

- Whole adversarial suite: `node tests/adversarial/run.js` -> 3012 passed, 0 failed, 0 skipped (about 75 s).
- Author's suite: `node tests/run.js` -> 116 passed, 0 failed; with `--browser --port=8107` -> 120 passed, 0 failed.
- Python oracle: `venv/bin/python` (pyembroidery 1.5.0). Browser: headless Chrome 157.

## Files

| file | what | last run |
|---|---|---|
| lib/common.js, decoders.js, corpus.js, geom.js, child.js, hostile-cases.js, invariants.js, pyread.py, palette.js, scale-child.js | harness, own PEC/PES/DST decoder, shapes, raster oracle | used by all |
| 01-readers.test.js | own decoder + pyembroidery vs `result.ir`, header fields | 969 / 0 |
| 02-geometry.test.js | 0.1 mm raster of every shape, coverage, travel, lengths | 618 / 0; `ADV_GEOM_ALL=1`: 1558 / 0 |
| 03-hostile.test.js | 591 hostile cases + 300 random designs, each in a child process with a timeout | 891 / 0, 2592 files read by pyembroidery |
| 04-sequencing.test.js | colour order, trims, END, opening move, centring, which way is up | 306 / 0 |
| 05-scale.test.js + browser/worker-stress.html, worker-stress.js, stress-designs.js | large designs in child processes; worker path in headless Chrome on 127.0.0.1:8107 (server started and closed by the test) | 67 / 0 (browser part run 4 times in a row) |
| 06-dst.test.js | DST vs PES geometry, header, 12.1 mm limit | 136 / 0 |
| 07-defects.test.js | one minimal repro per defect | 25 / 0; on the engine with the fixes switched off: 8 passed, 17 failed |
| run.js | runs all seven | see above |

Switches: `ADV_NO_BROWSER=1`, `ADV_ONLY_BROWSER=1`, `ADV_HUGE=1` (1000 mm hoop, 4.9 million stitches, 2.7 GB),
`ADV_GEOM_ALL=1`, `ADV_VERBOSE=1`, `ADV_PORT`, `ADV_CHROME_LOG=<file>`, `ADV_ENGINE_DIR=<another copy of js/engine>`.

## Engine changes made (all inside internals, API.md untouched)

- D1 FIXED, `js/engine/embwriter.js` `writePesBlocks`: a thread run of more than 65,535 stitches wrapped the
  u16 point count of the PES CSewSeg section (PES v1 and v6; the PEC part was fine). Runs are now cut into
  sections of at most 65,535 points, each starting on the last point of the one before. Output for shorter
  runs is byte-identical (author's 1496-file byte comparison still passes). Reached by one dense fill of
  100 x 140 mm, so inside a 130 x 180 hoop.
- D2 FIXED, `js/engine/digitize.js`:
  - `tatamiRow` / `rowConnector` (+ helper `rowCap`): with fill `stitchLength` above about 4.3 mm the
    first/last stitch of a row (up to 1.3 L) and single-stitch rows (up to 1.6 L) went over 7 mm: the legal
    7 mm gave stitches up to 10.98 mm and a STITCH_TOO_LONG warning. Such stitches are now divided.
  - `fillShape`: the pitch is capped at 6.85 mm, because snapping to the 0.1 mm grid turned 7.0 into up to
    7.1 mm at many angles (STITCH_TOO_LONG at 90, 45, 13 degrees ...). Only settings above 6.85 mm change.
  - After both: 720 fills (4 lengths x 180 angles) longest 6.98 mm, no warning. Default-length output unchanged.

How the old engine was run for 07: a copy of `js/engine` in the scratch folder (`old-engine/`) with
`PES_SECTION_MAX = Infinity`, `rowCap` returning `Infinity` and the `fillShape` cap removed, then
`ADV_ENGINE_DIR=<that folder> node tests/adversarial/07-defects.test.js`.

## Open findings (not changed, to report)

- F1 (low): DST header +Y / -Y are swapped relative to the y-up records (same as pyembroidery); at most
  0.1 mm on a centred design. Fixing breaks the author's byte-identity oracle.
- F3 (API level): more than 64 distinct colours (or near-identical colours) give consecutive colour blocks
  the same Brother palette entry in PES v1 / PEC, or unrelated Brother names; the engine gives no warning.
  Needs a new warning code, which is an API change.
- F4 (API level): there is no limit on the total number of stitches, only 400,000 per fill. Peak memory is
  about 0.5 GB per million stitches (node: 298,000 stitches 380 MB, 4.9 million 2.7 GB). In Chrome a
  4.9-million-stitch design works (1.1 s in the worker, 28 MB PES, main thread never blocked over 13 ms);
  a 19.7-million-stitch design (1000 mm hoop, 64 dense fills) that was superseded repeatedly ended twice in
  "V8 javascript OOM" (the tab dies) and once in a fallback to the main thread, in 5 runs. Not reachable
  with a Brother-sized hoop and a sane design (a 200 x 300 hoop filled once at the densest setting is
  298,000 stitches). A total limit needs a new warning code, which is an API change.
- Fallback consequence (by design, API section 8): once a client has fallen back to `'main'` it stays
  there, and work the worker did not finish is run again on the main thread.
- Satin width: needle swing = asked width + 2 x 0.2 mm pull compensation. API.md says only "column width".
  A satin of 6.7 mm or more therefore has stitches over 7 mm and raises STITCH_TOO_LONG (documented).
- `id: NaN` is echoed back as NaN (API says id is "any"); not a defect, exempted in lib/invariants.js.
- Stitches under 0.4 mm: these are the row-turn stitches (= row spacing, 0.36 after grid snap on angled
  fills). Engine drops only under 0.3 mm. Not a defect; counted and reported.

## Not testable here

A physical Brother machine: acceptance by a model, hoop-size rejection, placement, how a machine takes a
file with no opening jump, how Brother's PC software shows a run cut into several PES sections. Nothing
was sewn. Only Chrome was used (no Safari, no Firefox, no phone).

## Notes from attack 4

- A design whose first stitch is exactly the centre of its bounding box gets no opening jump record in PES /
  PEC (the stream starts with a stitch of (0, 0)); pyembroidery writes the same. Machine behaviour unknown.
- A colour that starts exactly where the previous one ended has no move after the colour change. Correct.
- Orientation: top of the canvas = smaller y in PES / PEC = top of the design on the machine screen.

## Notes from attack 5

- Chrome's worker is about 3 times faster than a cold node process: 298,263 stitches in about 52 ms.
- 50 requests in one tick: 48 resolve null, 2 are answered; 120 requests 4 ms apart: about 95 answered, each
  with its own design; the newest is always answered.
- Superseded slow request: new request answered about 840 ms after the slow one started (800 ms default).
- `terminate()` with a call pending: the generate resolves null, the export rejects CLIENT_CLOSED.
- A design holding a function, a DOM node and a Symbol is generated (on the main thread) with the same result.
