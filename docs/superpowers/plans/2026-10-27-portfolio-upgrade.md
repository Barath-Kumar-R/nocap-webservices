# NoCap Portfolio Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each of the 22 demos one signature moment plus shared polish, then rebuild the portfolio page around screenshots of the finished demos.

**Architecture:** A Playwright check script (`tools/check.cjs`) turns the spec's rules into pass/fail checks and gates every demo. A shared polish block is inserted into each demo by `tools/apply-polish.cjs`; each demo then gets its own fonts and signature moment, inline, so every demo stays one self-contained file. Screenshots are taken last and feed the portfolio page.

**Tech Stack:** Static HTML/CSS/JS, Node 22 + the pre-installed Playwright (CommonJS scripts, `require('playwright')`), Google Fonts links.

**Spec:** `docs/superpowers/specs/2026-10-27-portfolio-upgrade-design.md`

## Global Constraints

- Static HTML/CSS/JS, no build step, hosts on GitHub Pages; each demo is one self-contained file (inline CSS/JS).
- Keep each demo's style identity; keep NoCap lime / coral / navy on `index.html`.
- No photos or logos: CSS and inline SVG only. Interactive features are front-end only.
- Distinct heading + body font pair per demo (pinned in `tools/demos.json`, Task 1). No emoji as icons. No gradient-text headlines except where the style demands it.
- Banned copy words: elevate, unlock, seamless, cutting-edge, revolutionize, "smile journey". Short plain sentences; real local detail (area names, Rs prices, opening hours, Indian phone format).
- One primary CTA per screen; at most 6 nav links; at most 7 `h2` sections per demo.
- Mobile: sticky call/book bar; tap targets at least 44px; no horizontal scroll at 390px.
- Body text at least 16px on demos; any `p` at least 14px; WCAG AA contrast; visible keyboard focus.
- Content visible without JS; `prefers-reduced-motion` disables heavy animation; transitions 600ms or less; no autoplay sound; no scroll hijacking.
- Work on `main-ag7yrd`, commit per demo, push there. No push to `main` without explicit approval.

## Review Focus

1. Google Fonts blocked in the sandbox: screenshots would silently capture fallback fonts. Expected: `shoot.cjs` fails loudly instead.
2. A client opens a single demo file offline (`file://`, no network). Expected: content readable, no uncaught errors, fallback fonts only.
3. 320px-wide phones and 1920px-wide monitors. Expected: no horizontal overflow.
4. Keyboard-only use. Expected: Tab reaches the signature moment and the CTA, focus is visible, and the moment can be left again.
5. No WebGL (old phones, blocked GPU) on demo 22. Expected: static hero fallback, no uncaught error.

---

## Signature moments (pinned; Tasks 3-9 reference this table)

Every signature element carries `data-signature="<id>"`. Each must (a) leave the page fully readable and the CTA reachable without it, (b) be static under `prefers-reduced-motion`, (c) be absent or static without JS. Table deviates from the spec's family list in two places (15, 19) because the spec listed four moments for five demos; flagged for review.

| Demo | id | Behaviour |
|---|---|---|
| 01 | `bento-spotlight` | Soft light follows the cursor across bento tiles; tiles lift 4px on hover |
| 02 | `type-reveal` | Hero headline reveals line by line under a mask, once on load |
| 03 | `smile-slider` | Draggable before/after divider (CSS/SVG teeth), keyboard arrows move it |
| 04 | `sticker-marquee` | Rotated sticker row scrolls as a marquee; stickers wobble on hover |
| 05 | `brutal-press` | Cards and buttons translate into their hard shadow on press |
| 06 | `glass-orbs` | Frosted hero panel over slow-drifting orbs that shift slightly with the pointer |
| 07 | `chat-booking` | Chat-style assistant: pick treatment, day, time, then a confirm card (no backend) |
| 08 | `depth-stack` | Hero cards stacked in depth, separating on hover/scroll |
| 09 | `aurora-cursor` | Aurora gradient bands ease toward the cursor |
| 10 | `drag-collage` | Hero collage pieces are draggable and settle with a small rotation |
| 11 | `typewriter-intro` | Pixel-font headline types out once, with a blinking cursor |
| 12 | `magnetic-cursor` | CTA and nav links pull slightly toward the cursor; pointer devices only |
| 13 | `line-draw-intro` | Gold SVG line draws around the hero heading on load |
| 14 | `slot-picker` | Day and time slot picker that fills a booking summary line |
| 15 | `treatment-timeline` | Scroll-linked vertical timeline of a treatment (visit 1 to follow-up) |
| 16 | `smile-quiz` | Three-question care quiz ending in a suggested treatment |
| 17 | `hand-underline` | Hand-drawn SVG underlines draw in under key words |
| 18 | `kinetic-type` | Hero words shift weight and slant with pointer position; always readable |
| 19 | `prism-split` | Hero colour planes split and re-align following the pointer |
| 20 | `tilt-cards` | Service cards tilt in 3D with pointer, with a moving highlight |
| 21 | `layer-parallax` | Four-plus depth layers move at different rates on scroll |
| 22 | `webgl-scene` | Richer WebGL scene; static hero fallback when WebGL is unavailable |

Fonts (heading + body) are pinned in `tools/demos.json`. Changed from today: 01 Bricolage Grotesque + Figtree; 12 Fraunces + Jost (General Sans is not on Google Fonts and silently falls back); 15 Outfit + Public Sans; 18 Syne + DM Sans; 22 Red Hat Display + Red Hat Text. All other demos keep their current pair.

---

### Task 1: Check harness and demo config

**Files:**
- Create: `tools/demos.json`, `tools/check.cjs`

**Interfaces:**
- Produces: `tools/demos.json` as `{ "<file>.html": { "fonts": ["<Heading>", "<Body>"], "signature": "<id>" } }` for all 22 demos (ids from the table above; fonts as above).
- Produces: `node tools/check.cjs [file.html ...]` (default: all 22 in `demos.json`). Prints one row per file and per check id, exits 1 if any check fails.
- Check ids and rules: `console` (zero console errors, 1280 and 390 wide); `overflow` (scrollWidth <= innerWidth at 320, 390, 1280, 1920); `nojs` (JS disabled: every `h1,h2` has opacity >= 0.99); `reduced` (reduced motion: no running infinite `document.getAnimations()`); `type` (body font-size >= 16px, every `p` >= 14px, any `p` over 80 chars >= 16px); `tap` (at 390: visible `button, [class*=btn], [class*=cta], .nc-bar a` at least 44x44); `nav` (`nav a` count <= 7 including logo); `sections` (`h2` count <= 7); `copy` (innerText has no banned word and no `\p{Extended_Pictographic}`); `polish` (source contains `/* nocap:polish v1 */`); `fonts` (Google Fonts link families equal `demos.json`); `signature` (exactly one `[data-signature]`, value equals `demos.json`); `focus` (after 3 Tabs, `:focus-visible` element has non-`none` outline or box-shadow); `offline` (all non-file requests aborted: no uncaught page errors, h1 visible); `bar` (at 390, `.nc-bar` is position:fixed and holds a `tel:` link and a booking link).

- [ ] **Step 1:** Write `tools/demos.json` with all 22 entries.
- [ ] **Step 2:** Write `tools/check.cjs` implementing every check id above, one function per id, using `chromium.launch()` with `file://` URLs.
- [ ] **Step 3:** Run `node tools/check.cjs` on the current files. Expected: exit 1; `polish`, `signature`, `bar` fail for all 22; save the output to `docs/superpowers/baseline-check.txt` as the baseline.
- [ ] **Step 4:** Run `node tools/check.cjs 12-aura-dental-luxury.html` twice and confirm identical results (checks are deterministic).
- [ ] **Step 5:** Commit `tools/` and the baseline: `git commit -m "Add Playwright rule checks and demo config"`.

### Task 2: Shared polish block

**Files:**
- Create: `tools/polish.html`, `tools/apply-polish.cjs`

**Interfaces:**
- Produces: `node tools/apply-polish.cjs <file.html> [--bg=#hex --fg=#hex --accent=#hex --book=#anchor --tel=+91...]`. Idempotent. Inserts the `<style>` block before the last `</style>` and the script before `</body>`, both starting with `/* nocap:polish v1 */`. `--tel` defaults to the first `tel:` link in the file; exit 1 if none and no `--tel`. `--book` defaults to `#contact`.
- Block contents: `.nc-bar` sticky bottom bar (only <= 720px) with a Call link and a Book link, colours from `--nc-bg/--nc-fg/--nc-accent` custom properties set by the flags, min-height 44px, plus `body{padding-bottom}` on mobile; `:focus-visible` outline; `@media (prefers-reduced-motion: reduce)` rule that stops animations/transitions; `<noscript>` style forcing `.reveal`-style classes visible.

- [ ] **Step 1:** Run `node tools/check.cjs 03-happytooth-flat.html`; confirm `polish` and `bar` fail (already known from baseline).
- [ ] **Step 2:** Write `tools/polish.html` (the block) and `tools/apply-polish.cjs`.
- [ ] **Step 3:** Apply to demo 03 only with its brand colours. Expected: `polish`, `bar`, `nojs`, `reduced`, `focus` pass for 03; other checks unchanged from baseline.
- [ ] **Step 4:** Run the apply script a second time on 03; `git diff` shows no change (idempotent).
- [ ] **Step 5:** Commit: `git commit -m "Add shared polish block and apply script"`.

### Tasks 3-9: Demo batches (same procedure; one task per family)

| Task | Family | Demos |
|---|---|---|
| 3 | Modern | 01, 02, 03, 14, 15 |
| 4 | Bold | 04, 05, 06, 18, 19 |
| 5 | Tech | 07, 08, 09 |
| 6 | Tactile | 10, 11 |
| 7 | Luxury | 12, 13 |
| 8 | Warm | 16, 17 |
| 9 | 3D | 20, 21, 22 |

**Files:** Modify only the demos listed for the task.

**Interfaces:**
- Consumes: `tools/demos.json` (fonts, signature id), the signature table above, `tools/apply-polish.cjs`, `tools/check.cjs`.
- Produces: each demo passing every `check.cjs` check.

For each demo in the batch, in order:

- [ ] **Step 1:** Run `node tools/check.cjs <file>`; note failing checks.
- [ ] **Step 2:** Replace the Google Fonts link and `font-family` rules with the pinned pair from `demos.json`. Keep weights the page already uses.
- [ ] **Step 3:** Run `node tools/apply-polish.cjs <file>` with the demo's own palette for `--bg/--fg/--accent`.
- [ ] **Step 4:** Implement the signature moment per the table, marked `data-signature="<id>"`, inline CSS and JS in the existing file's style. Keep section count <= 7 `h2`.
- [ ] **Step 5:** Rewrite copy that fails the rules: banned words, emoji icons (replace with inline SVG), generic phrases. Keep local detail already present (areas, hours, Rs prices).
- [ ] **Step 6:** Fix `type` and `tap` failures (raise sizes to the Global Constraints values without breaking the layout), and any `overflow` failures.
- [ ] **Step 7:** Run `node tools/check.cjs <file>`. Expected: all checks pass.
- [ ] **Step 8:** Look at the page at 1280 and 390 in Playwright screenshots (saved to the scratchpad directory) and confirm by eye that it is uncluttered and matches its style; write one line of notes per demo in the commit body.
- [ ] **Step 9:** Commit: `git commit -m "Upgrade <demo>: <signature id> and polish"`.

Task-specific steps:

- **Task 9 (demo 22):** extra step before commit: launch Chromium with `--disable-gpu --disable-webgl`, load `22-helix-dental-webgl3d.html`, assert zero page errors and the h1 and CTA visible (pins Review Focus 5); add this as a named case `webgl-off` to `tools/check.cjs` that runs only for files whose signature is `webgl-scene`.
- **Tasks 3-9:** after the last demo in each batch, run `node tools/check.cjs` on the whole batch plus `git push -u origin main-ag7yrd`.

### Task 10: Screenshots

**Files:**
- Create: `tools/shoot.cjs`, `assets/shots/<NN>-<slug>.jpg` (22, 1280 wide, top 2400px of the page), `assets/shots/<NN>-<slug>-m.jpg` (22, 390 wide, top 844px)

**Interfaces:**
- Consumes: finished demos from Tasks 3-9.
- Produces: `node tools/shoot.cjs` writes the files above; each full-size JPEG is under 150KB (quality 78). Exits 1 if any demo's heading font does not load (`document.fonts.check('16px "<Heading>"')` false) or any shot is over 150KB. Slug is the filename minus `NN-` and `.html`.

- [ ] **Step 1:** Write `tools/shoot.cjs` with the font and size assertions; wait for `document.fonts.ready` and a 1.2s settle (signature intros finished) before each shot.
- [ ] **Step 2:** Run it. If it fails on fonts because the sandbox blocks Google Fonts, stop and report to the user; do not commit fallback-font shots (pins Review Focus 1).
- [ ] **Step 3:** Confirm 44 files exist and are within size limits; open three at random and check they look right.
- [ ] **Step 4:** Commit: `git commit -m "Add demo screenshots"`.

### Task 11: Portfolio gallery cards

**Files:**
- Modify: `index.html` (gallery CSS near line 78-95, the 22 `.g-card` blocks, filter script near line 564)
- Create: `tools/check-index.cjs`

**Interfaces:**
- Produces: `node tools/check-index.cjs` runs the portfolio checks: every `.g-card img` has `naturalWidth > 0`; hovering a card moves its image (`transform` changes) on pointer devices and not under reduced motion; each card has `.badges` with at least one badge; all 8 filter buttons show the right card counts; every `.g-card` `href` and every other local link resolves to an existing file; zero console errors; no horizontal overflow at 320 / 390 / 1280.
- Each `.g-swatch` becomes `<div class="g-shot"><img loading="lazy" decoding="async" alt="<demo name> website preview" src="assets/shots/<file>.jpg"></div>`; hover pans the image from top to bottom over 6s using `object-position`/translate. Badges (`WebGL`, `Parallax`, `Glass`, `Animated`, ...) are assigned from the signature table.

- [ ] **Step 1:** Write `tools/check-index.cjs` with the checks above; run it. Expected: FAIL on `g-card img`, `badges`.
- [ ] **Step 2:** Replace swatches with the shot markup and add the CSS and badges.
- [ ] **Step 3:** Run `node tools/check-index.cjs`. Expected: PASS.
- [ ] **Step 4:** Commit: `git commit -m "Portfolio: screenshot cards with hover preview and badges"`.

### Task 12: Portfolio showcase, hero strip, capabilities, UX audit

**Files:**
- Modify: `index.html`, `tools/check-index.cjs`

**Interfaces:**
- Produces: `section#featured` before `#gallery` with a browser-and-phone frame cycling demos 22, 21, 12 and 07 (`<img>` desktop + `-m` phone shot, "View live" link to the demo); cycles every 5s; pauses on hover/focus and under reduced motion; has previous/next buttons (44px). `.style-strip` marquee of style names under the hero, static under reduced motion. `section#capabilities` listing the 7 filter categories, each linking to `#gallery` and activating that filter.
- UX audit fixes in `index.html`: text raised to the Global Constraints sizes (replace the 13px body copy); manifesto section made skippable (a visible "Skip" link) and fully readable with JS disabled and under reduced motion; sticky nav keeps <= 6 links.
- New checks in `check-index.cjs`: `featured-cycle` (image changes after 5.5s; does not change while hovered); `capabilities-link` (clicking one activates the matching filter); `manifesto-nojs` (all words at opacity >= 0.99 with JS off); `type` rule as in `check.cjs`.

- [ ] **Step 1:** Add the four new checks; run; expected FAIL.
- [ ] **Step 2:** Implement the featured showcase, strip, capabilities section and audit fixes.
- [ ] **Step 3:** Run `node tools/check-index.cjs`. Expected: PASS.
- [ ] **Step 4:** Commit: `git commit -m "Portfolio: featured showcase, style strip, capabilities, UX fixes"`.

### Task 13: Final verification

- [ ] **Step 1:** Run `node tools/check.cjs && node tools/check-index.cjs`. Expected: both exit 0.
- [ ] **Step 2:** Take full-page screenshots of `index.html` at 1280 and 390 into the scratchpad and show them to the user.
- [ ] **Step 3:** Confirm `git status` is clean and `git push -u origin main-ag7yrd` has run. Ask the user whether to merge to `main` (which triggers the Pages deploy); `tools/` and `docs/` will be published with the site, which is harmless but visible if someone types the path.
