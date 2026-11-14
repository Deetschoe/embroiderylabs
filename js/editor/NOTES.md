# Embroidr editor: notes for the next engineer

Status: **PART 1 (the core) and PART 2 (SVG import, trace picture, phone / tablet layout, stitch-out
playback, empty state, example, help) ARE DONE and were tested in headless Chrome.** No `TODO(part2)`
is left in the code.

Nothing here has been sewn on a real machine. Exported files were read back with pyembroidery only.

## File map

The page is `app.html`. It loads, in this order (classic scripts, `defer`, no modules, works from `file://`):

```
js/site.js                       shared (EL.toast, EL.confirm, EL.store, EL.download ...)   DO NOT EDIT
js/engine/{embwriter,digitize,engine}.js    window.Engine, see js/engine/API.md            DO NOT EDIT
js/editor/geom.js     Editor.Geom    pure geometry + colour helpers, no DOM
js/editor/model.js    Editor.Model   document in mm, selection, defaults, undo history, event bus
js/editor/view.js     Editor.View    pan/zoom transform, DPR canvas, rulers, hoop, drawing, hit testing, side preview
js/editor/io.js       Editor.IO      engine client (live stitches), export, autosave / restore, Editor.toast
js/editor/svgimport.js Editor.SvgImport  SVG file -> shapes (own parser, reads a DOMParser tree, never inserts it)
js/editor/trace.js    Editor.Trace   picture to draw over: decode, move / scale / opacity / lock, optional storage
js/editor/panels.js   Editor.Panels  properties panel, sewing-order list, stats, warnings, hoop + fabric controls
js/editor/tools.js    Editor.Tools   pointer tools (select/pen/line/rect/ellipse/polygon/eraser/pan), wheel, pinch
js/editor/main.js                    boot, top bar (name, undo, view mode, export menu), keyboard, zoom HUD, drawer,
                                     phone sheet + dock + More menu, playback, file drops, example, help
css/editor.css                       editor-only styles (base.css is shared, do not edit)
```

One global, `window.Editor`. Modules talk through a tiny event bus, `Editor.on(name, fn)` /
`Editor.emit(name, data)`:

| event | meaning |
| --- | --- |
| `change` `{reason}` | the document changed. `reason` is the undo label ("Move", "Draw rectangle" ...) or `live` (mid-drag), `cancel`, `undo`, `redo`, `load`, `name` |
| `selection` | selection changed |
| `defaults` | next-shape style changed |
| `history` | undo / redo availability changed |
| `tool` | current tool changed |
| `viewmode` | Design / Stitch-out switched |
| `stitch` | a new engine result is in `Editor.IO.result` (or null) |
| `busy` | `Editor.IO.busy` flipped (stitches are being made for a newer document) |
| `saved` | `Editor.IO.saveState` changed (`saved`, `pending`, `failed`) |
| `fabric` | fabric colour changed (view only, not part of the design) |
| `exported` | a file was handed to the browser |
| `play` | the playback position `Editor.View.play.n` changed (or playback started / stopped) |
| `trace` | the trace picture changed (added, moved, scaled, opacity, lock, removed) |
| `units` | the display unit changed (`Editor.Units.get()` is `'in'` or `'mm'`). The document stays in millimetres |
| `prefs` | a view preference changed (`Editor.Prefs.grid()`: the dot grid, off by default) |

## Model shape (all lengths in millimetres, origin = hoop top-left)

```
Model.doc = { name, hoop: { w, h }, objects: [ object, ... ] }     // array order = sewing order, last is on top
object    = { id, name, type, <geometry>,
              color '#rrggbb', paint 'fill'|'line'|'both',
              lineType 'running'|'bean'|'satin', lineWidth, spacing, stitchLen, angle }
geometry  = rect    { x, y, w, h }
            ellipse { cx, cy, rx, ry }
            line    { x1, y1, x2, y2 }
            polygon { pts: [[x, y], ...] }            always closed
            pen     { pts: [[x, y], ...], closed }    freehand; open strokes can only be sewn as a line
            path    { rings: [[[x, y], ...], ...], fillRule 'nonzero'|'evenodd' }
                    compound outline: every ring is closed, holes are just more rings (letters O, A, B).
                    Goes to the engine as its own multi-ring `'path'` object. Curves are already flattened.
Model.defaults  = same style keys, used for the next shape (edited by the panel when nothing is selected)
Model.selection = [id, ...]
```

Rules that keep undo honest:

- Every change goes through `M.commit(label, fn, {key})` or `M.begin()` / `M.touch()` / `M.end(label)`
  (a drag) / `M.cancel()`. Never write to `M.doc` from outside.
- `key` coalesces repeats (slider scrub, arrow nudges) into one step for 1.2 s; `M.seal()` ends a run.
- History holds 200 steps. `M.serialize()` / `M.load(data)` are the storage format; `load` validates
  every field and drops objects it cannot read (returns how many).
- `M.toEngine()` is the only place the document is turned into engine input.
- `M.addMany(list, label)` adds many shapes as ONE undo step and returns the made objects (`[]` if the
  design would pass `M.MAX_OBJECTS` = 2000). A shape may hold at most `M.MAX_POINTS` = 20000 points.
  This is the door for other code that makes shapes (SVG import uses it; the js/trace engineer can pass
  `{ type: 'path', rings, fillRule, color, paint: 'fill' }` for regions with holes, no keyhole needed).

## File menu and design files

`File` (top left; in the More menu on phones) has New, Open, Save and Export .PES. Save downloads
`<name>.embroidr`: the autosave payload as JSON (`IO.projectFile()`), which Open reads back through
`Model.load`, so every field is checked and a hand-edited or hostile file can only give valid shapes.
New and Open ask before replacing a design that has shapes. A machine file (.pes, .dst) holds stitches,
not shapes, so it cannot be opened for editing; the toast says so. Shortcuts: Cmd/Ctrl+O, Cmd/Ctrl+S.

## Tabs (`tabs.js`)

Several designs are open at once, one tab each (up to 12). The design on the hoop is still the single
document in `Model` and is autosaved by `io.js` as before; `Editor.Tabs` keeps a copy of every open design in
`localStorage['el-editor-tabs-v1']` and swaps them through `IO.applyPayload` / `Model.load`. File > New and
opening a design file make a new tab, so nothing is replaced without asking; closing a tab that has shapes
asks. Undo history belongs to the design on the hoop and starts fresh when another tab is picked. The trace
picture is shared by all tabs. `Editor.Tabs.designs()` lists every open design (the mockup uses it), event `tabs`.

## Mockup (`mockup.js`, `mockups/`)

Mockup is the third choice of the view switch in the top bar (Design, Stitch-out, Mockup; on phones a button
in the tab row; also in File and in the export menu). It swaps the editor for a garment view: hoodie or
T-shirt, front or back, any colour (chips, picker, hue / saturation / lightness), on a white stage. Each open design is stitched with `Engine.generate` and drawn once by `js/realistic`
(thread only, up to 8 px per mm; the two scripts are loaded the first time the view opens), then placed on the
garment at true size from `pxPerMm` in `GARMENTS`. Drag to move, Size to scale, front and back keep their own
placements, everything is stored in `localStorage['el-editor-mockup-v1']`. Downloads: "Download picture" is the
mockup on white as a 2000 x 2000 PNG; the arrow beside it offers the same with a transparent background, and
the stitching alone on a clear background. The garment pictures are white blanks tinted
per pixel; see `mockups/README.md` for where they come from and the licence question.

## Eraser

The eraser is a disc (`eraserRadius()` in `tools.js`, about 9 px on screen). Rubbing over a line, a stroke or
an outline-only shape removes just the part under it (`Geom.eraseLine`); what is left becomes open strokes with
the same thread (`Model.strokePiece`), one undo step per rub. A filled shape cannot lose a bite (that needs the
fill outline to be cut, which is not built), so pressing one without rubbing removes it whole.

## Fill patterns

Each filled shape has `pattern` (`smooth`, `brick`, `ribbed`, `diagonal`, `crosshatch`), shown as Pattern in
the Stitch section. The list comes from `Engine.FILL_PATTERNS`; the engine does the work (`fill.pattern`, see
js/engine/API.md). Designs saved before this have no `pattern` and load as `smooth`.

## Units

The document, the engine and the stitch settings (density, stitch length, line width) are always millimetres.
`Editor.Units` (in `model.js`) only formats SIZES for people: hoop note, hoop list, design size, rulers, cursor
position, export and import messages. Inches are the default; the choice and the grid switch are stored in
`localStorage['el-editor-prefs-v1']`. Use `Editor.Units.num(mm)` / `.short(mm)` / `.size(w, h)` for anything new
that shows a length, never `toFixed` plus a hard-coded "mm".

## Turn a picture into stitches (`trace.js` + js/trace)

With a picture loaded, the "SVG or picture" section shows a card on top of the picture controls: Colours (a
slider 2 to 30 and "Pick the colours for me (up to 10)", on by default), thread swatches, the stitch count and
size, one short note, and the primary button "Turn into stitches" (also offered in the toast after a picture is
opened). The picture is traced by the global `Trace` (js/trace/trace.js + client.js, loaded before
js/editor/trace.js) in a Web Worker, or on the main thread in slices from `file://`: at the picture's width on
the hoop (10 to 400 mm; wider is traced at 400 and scaled), at x = y = 0, so moving the picture or changing its
opacity needs no new trace. A new picture, width or colour setting starts a new trace after 300 ms (an older answer
is dropped); progress and Cancel show while it works. The swatch names are the Brother threads the .pes writer
will list (`Engine.Writer.buildUniquePalette`, so two close shades get two names); the stitch count is the real
engine's count for the shapes as the editor will send them (`Model.toEngine` + `Engine.generate`).
The button adds the shapes with ONE `Model.addMany(list, 'Turn picture into stitches')`, named after their
thread ("Khaki", "Pewter 2", "Black line 3"), then hides the picture: `V.trace.hidden`, `img` = null, `pic` kept;
"Show picture" brings it back, and the flag is stored with the picture. The colour setting is a per-visitor
convenience in `localStorage['el-editor-stitchify-v1']`. In the page: `Editor.Trace.stitch()`, `.setColors()`,
`.cancel()`, `.preview()`.

Known gap: `Model.toEngine()` does not pass the tracer's `underlay: false` (model.js is not this package's), so
photographs are sewn with underlay: about a third more stitches and the engine's TOO_DENSE note on some seams.

## How things flow

`tools.js` or `panels.js` change the model -> `change` -> `view.js` redraws, `io.js` asks the engine
for stitches (debounced 50 ms, 140 ms mid-drag; results for an older revision are ignored) and saves to
`localStorage['el-editor-doc-v1']` 400 ms later -> `stitch` -> panels show counts / warnings, the view
draws the stitch-out and the side preview. Export awaits `IO.fresh()` so the file is always made from
the stitches of the document as it is now, then `EL.download`.

## How to add a tool

1. `app.html`: add a `<button class="tool" data-tool="NAME" data-key="K" aria-pressed="false" aria-label="...">`
   to `nav.rail` (and to `nav.dock` or `#more` for the phone).
2. `tools.js`: add `NAME` and its label to `NAMES`; in the `pointerdown` handler start a gesture
   (`gesture = { type: '...', pid, ... }`), handle it in the `pointermove` switch and in `endGesture`
   (commit on release, discard on cancel). Draw-in-progress goes in `V.draft` via `setDraft`.
   Create the shape with `M.add(geometry, 'Draw ...')`; the model adds id, name and the defaults.
3. `main.js`: add the letter to the `TOOL_KEYS` map.
4. A new shape type also needs: `geom.js` (bounds, hit, transform, translate), `view.js` (path),
   `model.js` (`cleanObject`, `toEngine`, `TYPE_NAMES`), `panels.js` (`GLYPHS`, picked by `M.glyphOf`).
5. `css/editor.css`: a cursor rule `.view[data-tool="NAME"]` if the crosshair is wrong.

## Part 1: done and verified by running (headless Chrome, synthetic mouse / key / touch events, zero console errors)

Test scripts are scratch files, not in the repo. The five Part 1 scripts were run again on the final Part 2 code and pass.

- Draw: rectangle, ellipse, line (Shift = straight), pen (open, auto-closed loop), polygon (Enter,
  double-click, Esc, Backspace removes a point, tool switch commits >= 3 points); a click draws nothing.
- Select: real-geometry hit test, topmost first, Shift-click, marquee, move, 8 handles, Shift-proportional,
  line end handles, group resize, arrows 1 mm / Shift 5 mm, Delete, duplicate, copy / paste, `[` `]`, eraser.
- View: wheel / ctrl-wheel zoom to cursor, pinch (touch), middle mouse, Space-drag, hand tool, fit for
  every hoop preset, + / - / 0, DPR 2 backing store.
- Properties: every control, with a selection and as defaults; sliders by mouse and keyboard; number
  fields clamp and refuse nonsense; controls that do not apply are disabled with a reason in `title`.
- Sewing order: row per object, click / Shift-click, rename (hostile markup stays text), delete, drag
  reorder, header buttons, arrow keys, Alt+arrows, F2.
- Engine: live counts and stats, outside-hoop error flags the row and blocks export, too-dense warning
  does not block.
- Undo / redo: 35 steps walked back to empty and forward again comparing every stored state.
- Autosave / restore: design, name, hoop, defaults, fabric; damaged entries dropped; unreadable JSON
  gives an empty working editor.
- Export: .PES (button, Cmd+E), .DST and PES v6 (menu, keyboard and mouse); the real downloaded files
  were read with pyembroidery: stitch count, thread count / colours and size equal the on-screen stats.
  Empty or blocked design gives a toast and no file.
- Layout: 1440 and 1000 px (drawer), 390 px phone with touch, light and dark; no horizontal page scroll.

## Part 2: what was added

**SVG import** (`svgimport.js`). Browse (`#trace-input`), the upload button, or drop a file on the canvas.
`SvgImport.parse(text, hoop)` has no side effects; `importText` / `importFile` add the result with
`M.addMany(list, 'Import SVG')` and always show a toast saying what came in and what was left out.
The file is read as text and parsed by `DOMParser` into a separate document that is only read: no node
is adopted, nothing goes through `innerHTML`, colours are normalised to `#rrggbb` by a canvas, numbers
must be finite, layer names are our own words. Files over 5 MB, `.svgz` and nested entity definitions
are refused. Fills become `path` (or `polygon` when there is one ring), strokes become line objects:
under 0.6 mm running, under 1.2 mm bean, otherwise satin of that width (1 to 12 mm). A drawing
with a real size (mm, cm, in, pt ...) that fits the hoop keeps it; anything else is scaled to fit,
aspect kept. Always centred. Text, images, gradients / patterns, clip
paths, masks, filters, markers and dashes are left out and counted.

**Trace picture** (`trace.js`, state in `V.trace`). PNG / JPG / WebP / GIF up to 25 MB, decoded in the
browser, drawn under the artwork, hidden in Stitch-out, never passed to `M.toEngine()` and never part of
the design autosave. Controls in the Trace section: opacity, width, lock, fit, remove (with Undo).
With the select tool an unlocked picture can be dragged (a shape above it wins the press; Shift+drag
starts a marquee instead; 8 mm of it must stay on the hoop). A downscaled copy (1600, then 1024, then
640 px) is kept in `localStorage['el-editor-trace-v1']` only if it fits; the visitor is told once when
it does not, and the copy is dropped first when the design itself can no longer be saved.

**Phone (<= 720 px).** Bottom sheet `#sheet` with `data-detent` peek / half / full: drag the grip, tap
it, or ArrowUp / ArrowDown / Enter / Escape on it. Tabs Properties / Layers. Picking a tool or pressing
on the canvas returns it to peek. `Editor.sheet = { set, get, tab }`. The dock holds four tools and
More (`#more`: the other tools, picture / SVG, example, theme, help). The stage re-fits above the sheet
(`V.sheetCover()`, `padding()` in `view.js`) unless the visitor has zoomed by hand. Pinch zoom keeps the
point under the fingers; two fingers pan. Inside the sheet the pane scrolls as one piece.
**Tablet (<= 1100 px).** Properties stay, layers are a drawer opened from the top bar. With a coarse
pointer controls are 44 px and the stage keeps more room at the bottom for the zoom buttons.

**Playback.** In Stitch-out the bar `#play` has play / pause, a scrubber and a count. `V.setPlay(n)`
draws the first `n` stitches in sewing order with the needle marker at `V.needle`.
`Editor.playback = { play, stop, playing }`. Speed is `max(150, n / 15)` stitches per second. With
`prefers-reduced-motion: reduce` nothing animates: each press jumps to the end of the next thread colour.

**Empty state, example, help.** An empty hoop shows a short hint and "Load example" (`#btn-example`):
a blue badge with a star-shaped hole and a gold star over it, one undo step. The help dialog (`?` or the
top-bar button) lists the shortcuts and says the files are made in the browser, checked against a
reference library, not test-sewn, so sew a test on scrap fabric first. The Hoop section says the same.

## Part 2: verified by running (same harness, zero console errors unless noted)

- Hostile SVG (scripts, `on*` handlers, `javascript:` paints and links, foreignObject, external image /
  use / CSS URLs, external entity): nothing ran before or after a reload, the server log shows no
  request for the beacon URL, no fetch / XHR / dialog, only valid shapes with plain colours were added,
  the stored design contains no text from the file. An entity-expansion file is refused.
- SVG geometry: rect with rx, circle, ellipse, line, polyline, polygon, every path command with relative
  and compact forms, nested transforms, viewBox, attribute and style paints, fill-rule: every outline is
  within 0.25 mm of Chrome's own SVG geometry. No needle point lands inside the holes of O, A and B.
- End to end, over http (engine in a worker) and from `file://` (engine on the main thread): import a
  two-colour SVG with holes, draw an ellipse, export PES with the button and DST from the menu; both
  downloaded files read back with pyembroidery give the same stitch count (3,354), colours (3) and size
  (80.4 x 55.6 mm) as the read-outs on the page.
- Trace picture: browse, drop, opacity, width, move, lock, fit, remove + Undo, hidden in Stitch-out,
  absent from engine input and from the design autosave, restored after reload, too-big and
  storage-full handling, refused files.
- Playback: play, pause, scrubber by pointer and keys, stops at the end, needle marker, reduced motion.
- Phone 390 px with touch: sheet drag and keys, tabs, dock, More, pinch and two-finger pan without a
  jump, 44 px targets, nothing covered. Tablet 1024 px with touch: every panel reachable.
- Screenshots looked at: empty, design, stitch-out, help, sheet half / full, More; light and dark; 1440,
  1024 (touch) and 390 px. No horizontal page scroll anywhere.
- Storage full: the top-bar tag reads "Not saved" and one toast says why (on the phone the tag is hidden
  and the toast is the only notice); saving resumes when room is freed.

## Not verified

- No physical sew-out. No real phone, no Safari, no Firefox: Chrome only.
- Safe-area insets (`env(safe-area-inset-*)`) are zero in headless Chrome, so the notch / home-bar
  padding was never seen with real values.
- Pen / stylus pointer type; trackpad two-finger pan (the wheel heuristic in `tools.js` was not exercised).
- The `matchMedia` pixel-density listener in `main.js` does not fire under Chrome's emulation, so only
  the fallback in `view.js draw()` was seen working.
- SVG geometry was compared with Chrome only; files from Illustrator / Inkscape / Figma were not tried.

## Known gaps

- SVG: no text (turn it into outlines first), no images, gradients, clip paths, masks, dashes; a stroke
  with a gradient paint is left out. `<style>` rules: only tag, `.class` and `#id` selectors.
- `path` shapes can be moved and resized but not edited point by point (no node editing for any type).
  No rotation.
- An unlocked trace picture takes a plain drag on empty hoop that would otherwise start a marquee
  (Shift+drag or the lock avoids it). Its controls stay visible in Stitch-out while the picture is hidden.
- A shape can be dragged far off the hoop (the engine then flags it and export is blocked).
- Selection handles are still drawn in Stitch-out.
- Phone: the full detent covers the stage; at half the hoop size label sits partly under the zoom
  buttons; a toast can cover the top of the sheet for a few seconds.
- Keyboard arrows on a slider make one undo step per key press (mouse scrubs are one step).
- Arrow keys do not nudge while focus is on a button (by design, so buttons and lists keep their own keys).
- The side preview canvas is a fixed 512 px; slightly soft on a DPR 3 phone.
- `css/editor.css` has a `/* BASE-CANDIDATE: */` block: `.split` (button with a "more" arrow) and
  `.menu` (popup of `role=menuitem` buttons). Move to base.css if another page needs them.
