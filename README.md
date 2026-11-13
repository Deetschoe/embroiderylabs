# Embroidery Labs

A free, open-source embroidery digitizer for the web. Draw a design or drop in an SVG, preview the stitches and export a file for your machine. Everything runs in the visitor's browser: there is no server, no account and no upload.

| Page | What it does |
| --- | --- |
| `index.html` | Home |
| `app.html` | **Embroidr**: draw a design, pick a fill pattern, and export a stitch file (.PES for Brother/Babylock, .DST). File > Save keeps a design file (.embroidr) you can open and edit again. Several designs can be open in tabs, and Mockup shows them stitched on a hoodie or T-shirt and downloads a picture. Sizes show in inches or millimetres. |

## Run it locally

No install and no build step. Serve the folder with any static server:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

## How it is put together

- Plain HTML, CSS and JavaScript. `css/base.css` and `js/site.js` are shared by every page; each page has its own stylesheet and script.
- `js/engine/` turns shapes into stitches and writes the machine files, in a Web Worker when the browser allows it. See `js/engine/API.md`.
- Hosting is static: `vercel.json` for Vercel, or the `Dockerfile` (nginx on port 8000, with `/health`).

## Tests

```sh
node tests/run.js            # engine tests (Node only)
node tests/run.js --all      # also compares output with pyembroidery and runs headless Chrome
node tests/adversarial/run.js  # hostile input, geometry and file-format checks
node tests/realistic/run.js  # realistic stitch preview
node tests/trace/run.js      # picture tracer
```

The `--all` run needs Python with `pyembroidery` (for example `python3 -m venv venv && venv/bin/pip install pyembroidery`). It is a test tool only; the site does not use Python.

## Archive

`archive/` holds three earlier tools (Blanks, Tech Packs, Drop Calc) that are set aside while the project focuses on embroidery. They are not deployed. See `archive/README.md`.

## Before you sew

Exported files are checked byte-for-byte against pyembroidery, but they have not been test-sewn on every machine. Sew a test on scrap fabric first.
