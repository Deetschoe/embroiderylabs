# tests/trace verification notes (key: trace-verify)

Independent test of js/trace (image to embroidery). Started 2026-11-12.
Scratch: /private/tmp/claude-501/-Users-dieterschoening-Developer-EmbroideryLabs/932b156b-d936-4a4b-9f2b-9d917247677b/scratchpad/trace-verify-work/
Port for my own server: 8204 only. Never touch 8000.

## Plan
1. own image set (>= 16) in scratch img/ (logos rendered in headless Chrome, photos via sips)  DONE
2. matrix: 60 / 100 mm x 3 / 6 / 10 colours -> trace -> Engine.generate -> PES -> pyembroidery -> contact sheet
3. hunt classic auto-digitizing faults, fix in js/trace/trace.js, regression test each in tests/trace/
4. tune defaults + auto mode
5. node tests/trace/run.js and node tests/run.js green

## Tools written (in the repo, tests/trace/tools/)
- matrix.js: `node tests/trace/tools/matrix.js <imageDir> <outDir> [--only=a,b] [--widths=60,100] [--colors=3,6,10] [key=value]`
  one line per run + <outDir>/<image>_<width>.png sheets (rows 3/6/10 colours; source | traced shapes | PES read-back)
  + results.json. Full set takes about 3 minutes.
- sheet.py: the sheet renderer (pyembroidery + Pillow + numpy from venv/). Counts stitches < 0.5 mm and > 7 mm.

## Image set (scratch img/, 24 pictures; mksvg.js + mkimg.sh rebuild the logos)
L01 peak icon+text on white, L02 surf 5 colours transparent, L03 script wordmark, L04 thin strokes + small text,
L05 badge rings transparent, L06 outlined clip-art cat, L07 200 px, L08 badge JPEG q8, L09 pencil sketch,
L10 cartoon face, L11 logo on gradient background, L12 gold/white on black, L13 nearly white, L14 CMYK primaries,
P01 owl (stand-in for pet/portrait: macOS bundles no pet or person photo), P02 road landscape, P03 nest (busy),
P04 night grass (dark), P05 gingerbread on white, P06 basketball transparent corners, P07 pale rose,
P08 dahlia JPEG q12, P09 medal, P10 daisy.

## State
- baseline before any change: tests/trace/run.js 29 passed; tests/run.js 116 passed
- baseline matrix: scratch out/base/ + out/base.txt (trace.js untouched at that point)
- next: look at every sheet, list faults, fix

## Findings (baseline, trace.js untouched; sheets in scratch out/base/)
Numbers: trace 27-591 ms; 135-27,423 stitches; no crash; no stitch over 7 mm; stitches under 0.5 mm are 10-25% of
many designs (engine fill row ends; engine is not my file: report, do not fix). Photos reach 0.2-1.2 mm past the
picture edge (underlap/pull). Engine TOO_DENSE on L05 (6/10 colours), L10 (100 mm, 6 colours); THIN_FILL up to 7 (L08).
Auto mode: all L* logo except L11 (photo: gradient background); all P* photo except P07 pale rose (logo).

Faults, in fixing order (tick when fixed + regression test added):
- [x] A1 (SEW.borderShare 0.6 for drawings; test still to add) background kept when the subject is cropped by the picture edge (L10 cartoon: border share < 0.9)
- [x] A2 (removeBackground(): hole only when the shape round it stands on the background alone; test to add) subject removed with the background: enclosed background-coloured parts left bare (L06 cat eye whites and
      muzzle, L08 white star + white letters + grey ring). Wanted: an enclosed bg-coloured part stays a hole only if
      it is a real hole (letter counter / line-art interior), else it is sewn.
- [ ] A3 gradient background (L11): photo mode, background sewn as bands, letter holes filled; no warning
- [ ] B lost line art: L09 pencil sketch gives 135-222 stitches of fragments; L04 circle outlines dashed at 100 mm,
      fern stem gone at 60 mm
- [ ] C lettering: bold 6-9 mm letters lumpy (constant-width satin along skeleton); smaller ones come out as wrong
      letters ("OUTFITTERS" -> "OUTPITTEAS"), blobs with filled holes, or half-dropped words ("Ember & Oak" ->
      "E le & O(/" at 60 mm). Wanted: a word is readable or left out whole with DETAIL_LOST.
- [ ] D low-res halo (L07 6/10 colours): the blur colour between navy and white becomes a palette colour, sewn as
      grey bits on letter corners
- [ ] E pale pictures: L13 collapses to one colour; P07 pale rose picks logo and becomes one cream blob
      (absolute OKLab thresholds; scale by the picture's colour spread)
- [ ] F small salient colour lost: P01 owl's yellow eyes turn tan at 6 colours
- [ ] G L06 at 60 mm ear interiors solid black, eye outlines blobs; L10 at 60 mm eyes are blue blobs
- [ ] H 1 mm bar sewn as a bean line (L03 underline, L01 teal bar at 60 mm)
- [ ] I MANY_STITCHES only above 60,000; task wants a warning + reason far above about 40,000 at 100 mm
- [ ] J 3 colours: L05 white+orange average into peach; L02 loses dark brown (inherent unless cheap)
Fine: L14 CMYK primaries, L12 hexagon, L06 at 100 mm apart from bare whites, P05, P06, P10, P08; P02/P03 posters;
P09 medal poor (laurel lost, gold banded); P04 usable.
Still to do: odd inputs (1 px wide, 8000 px wide, all transparent), worker vs main thread (Chrome, port 8204),
hoop / EXCEEDS_HOOP, defaults, regression tests, final full matrix.

## Log
- 23:00 the ENGINE changed under me (js/engine/*.js written 22:49-22:58 by someone else): new engine warnings
  COLORS_MERGED / COLOR_SUBSTITUTED (two design colours share a Brother chart entry in PES). tests/trace/run.js
  checkEngine now lets COLORS_MERGED through (file-format notice). Stitch counts differ from the baseline run.
- trace.js: background section rewritten (colourise() + removeBackground()); stats.detect.border added (additive).
  Backup of trace.js after that step: scratch trace.after-bg.js. No copy of the author's original exists (js/ is
  untracked in git), the baseline numbers are in scratch out/base.txt.
- tools: matrix.js got --panel= --crop=x0,y0,x1,y1 (zoom) and SEW.name=value (try a sewing constant);
  sheet.py draws thread at >= 24 px/mm so coverage no longer depends on the size. scratch seq.js prints colour blocks.
- in progress: fewer colour changes (SEW.overShare 0.2: a line waits for another colour only if a fifth of it lies on it)
- decided for lettering (C): keep satin for simple strokes; where the satin rebuild does not match the shape, leave the
  letter as a fill (shape kept exactly); drop small print as whole words. Not coded yet.

## RESUMED 00:59 (second session, same key trace-verify; first session was cut off about 00:35)
State found on resume (verified by running): tests/trace/run.js 29 passed, tests/run.js 117 passed.
trace.js holds, beyond the background rewrite (A1, A2), three pieces the notes above did not record:
- spread scaling (fault E): `spread` = distance from the main colour that 1% of the picture lies beyond; all colour
  thresholds are multiplied by spreadK = clamp(spread / SEW.fullSpread, 0.3, 1). stats.detect.spread added.
- ink merge (faults B, D): a palette colour that is thin everywhere, a mix of background + a darker colour and lies
  against that colour joins it (SEW.inkCore / inkTouch / inkOff).
- SEW.overShare is a constant now but still 0.06 (the original value): the "fewer colour changes" idea is NOT in.
NO regression test exists yet for any of this. Order of work now: full matrix (scratch out/r1) -> look -> fix
I, A3, C, remaining -> regression tests -> odd inputs -> Chrome worker vs main on 8204 -> final matrix + table.

## Sheets of matrix r1 (current code, scratch out/r1 + out/r1m montages, table out/r1.txt), looked at 01:10-01:40
No crash, trace 27-304 ms, 224-27,423 stitches, no stitch > 7 mm. Auto: L* logo (L11 photo), P* photo.
- L01 good at 100; 60 mm: OUTFITTERS dropped whole (fine), teal bar a thin line (H)
- L02 good at 6; T of SUNSET broken at 60 mm
- L03 60 mm "E le & O(/" (half-dropped word: C), underline turns red; 100 mm roughly readable
- L04 60 mm circles dashed, stem lost, only "W" of the word left (C); 100 mm usable
- L05 100/6 good; 60 mm ROADHOUSE white blocks, MOTOR CLUB a stray scrap (C); TOO_DENSE at 6/10
- L06 100 good; 60 mm ears black, eyes blobs (G)
- L07 good at 60; 100 mm small word messy
- L08 100/6 good-ish; 60 mm letter blobs; scraps outside the badge edge at 60/6; red dots at 100/3
- L09 pencil readable at both sizes (was fragments); zigzag blobs left of bulb at 100
- L10 100/6 good; 60 mm eyes blobs; white collar bare
- L11 photo mode, bands sewn; 60 mm "I" of PINEHAUS dropped (A3/F)
- L12 hexagon good; 60 mm diamond has a spur top+bottom; lettering half-dropped (C)
- L13 good at 100 (3-4 pale colours), lumpy lettering at 60
- L14 good at 100; 60 mm "INT W" (C)
- P01 owl usable; yellow eyes only at 10 colours (F)   - P02 road usable poster
- P03 nest usable poster (eggs clear)                  - P04 night grass usable poster
- P05 gingerbread: background removed, good at 6; 60/10 loses eyes+buttons, shadow sewn lilac with the icing
- P06 basketball good                                  - P07 pale rose usable (subtle), photo mode now
- P08 dahlia good poster                               - P09 medal poor at 60 (laurel lost, 1 mangled), usable 100/6
- P10 daisy good
Biggest fault by far: half-dropped / blob lettering under about 6 mm cap height (C). Then 60 mm line art.
