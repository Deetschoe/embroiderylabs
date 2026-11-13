# Archive

Three tools that were set aside on 13 Nov 2026 so the site can focus on embroidery. Nothing here is deployed
(`archive/` is in `.vercelignore` and `.dockerignore`, and the old URLs redirect to the home page).

| Page | What it does |
| --- | --- |
| `blanks.html` | Compare garment blanks (weight, fabric, fit, approximate price), each row linked to its source |
| `techpack.html` | Build and print a tech pack |
| `dropcalc.html` | Work out the profit and break-even of a drop |

They still run locally: serve the repo root and open `/archive/blanks.html` (and so on). They share
`../css/base.css`, `../js/site.js` and `../emb.png` with the live site; their own styles and scripts are in
`archive/css` and `archive/js`.

```sh
node archive/tests/dropcalc.test.js   # drop calculator maths
```

To bring one back: move its page to the repo root, its files back to `css/` and `js/`, undo the `../` paths
in the page, add it to the `Dockerfile`, remove its redirect from `vercel.json` and `nginx.conf`, and link it
from `index.html`.
