# NoCap-Webservices
Free websites for everyone 

## What is in this repo

- `index.html`: the NoCap Webservices portfolio page.
- `01-...html` to `22-...html`: 22 demo websites for fictional dental clinics, one design style each. They are design portfolio pieces, not live businesses: the clinics, doctors and prices are made up, and the phone numbers are placeholders. Each demo is one self-contained HTML file (inline CSS and JS, Google Fonts only), so it can be opened straight in a browser or sent as a single file.
- `client-questionnaire.html`: a planning questionnaire for new clients.
- `tools/`: the scripts that check the pages and make the screenshots. `tools/demos.json` pins each demo's font pair and signature feature.
- `assets/shots/`: generated screenshots and thumbnails used by `index.html`. Do not edit them by hand; re-run `shoot.cjs` and `make-thumbs.py` after changing a demo.

## Tools

Setup on a fresh machine (Node 22 and Python 3), from the repo folder:

    npm i playwright && npx playwright install chromium
    pip install pillow

Commands:

- `node tools/check.cjs [file.html ...]`: rule checks for the demos (console errors, overflow, text and tap sizes, JS off, reduced motion, fonts, copy and more). With no file names it checks all 22. Exits 1 if any check fails.
- `node tools/check-index.cjs`: the same kind of checks for `index.html` (gallery, filters, links, featured showcase, contrast, contact links).
- `node tools/shoot.cjs [file.html ...]`: writes the desktop (1280px) and phone (390px) screenshots to `assets/shots/`. Needs Google Fonts reachable; it fails rather than shoot fallback fonts.
- `python3 -I tools/make-thumbs.py`: makes the 640px gallery thumbnails from the desktop shots. Add `--check` to only report whether they are up to date.
