# NoCap Portfolio Upgrade: Design

Date: 2026-10-27
Branch: `main-ag7yrd`

## Goal

Win more clients. The portfolio page should leave a strong first impression, and each of the 22 demos should show a distinct, well-crafted style. Nothing should read as AI-generated, and nothing should feel cluttered or hard to use.

## Scope

- Upgrade `index.html` (portfolio page).
- Upgrade all 22 demos (`01-…` to `22-…`) with **one signature moment each** plus shared polish.
- Out of scope: new non-dental demos, full rebuilds of demos, backends.

## Constraints

- Static HTML/CSS/JS, no build step, hosts on GitHub Pages.
- Each demo stays a single self-contained file (inline CSS/JS), so a client can be sent one file.
- Keep each demo's style identity and the NoCap brand colours (lime / coral / navy) on the portfolio page.
- No real photos or logos available: use CSS and SVG illustration, not stock imagery.
- Interactive features (quiz, booking assistant) are front-end only.

## Portfolio page (`index.html`)

1. **Hero:** keep the existing bloom. Add a slow scrolling strip of style names to show range at a glance.
2. **Featured work:** large browser + phone frame that cycles 3-4 standout demos, with a "View live" button. Pausable, and stops cycling on hover/focus.
3. **Gallery cards:** replace gradient swatches with Playwright screenshots of the finished demos. On hover (pointer devices only) the screenshot slowly pans down the page. Each card gets small capability badges (`WebGL`, `Parallax`, `Glass`, `Animated`).
4. **Capabilities strip:** short list of design directions covered, linking to the existing filters.
5. **Kept:** filters, contact links, mobile and reduced-motion support.
6. **UX audit of the current page:** review the scroll-pinned manifesto section and 13px body text, and fix whatever fails the UX rules below.

## Demos: signature moment per family

| Family | Demos | Signature moment |
|---|---|---|
| Modern | 01-03, 14-15 | Cursor-reactive bento tiles; typographic hero reveal; before/after smile slider; appointment picker |
| Bold | 04-06, 18-19 | Sticker + marquee pop; neobrutalist press states; glass blur hero; kinetic type |
| Tech | 07-09 | Chat-style booking assistant; spatial depth stack; cursor-following aurora |
| Tactile | 10-11 | Draggable collage; pixel-art or typewriter intro |
| Luxury | 12-13 | Magnetic cursor; slow image reveals; line-draw intro |
| Warm | 16-17 | Smile-care quiz; hand-drawn underline animation |
| 3D | 20-22 | Stronger tilt cards; multi-layer parallax; richer WebGL scene |

Shared polish on every demo: scroll reveals, clear hover/focus states, tighter mobile layout, one obvious booking CTA.

## Rules: must not feel AI-generated

Each is checked in review of every demo.

- **Distinct type pairing per demo.** No two demos share the same heading + body font pair, and none uses the default "Inter on everything" look.
- **No stock-AI tells:** no purple-to-blue gradient backgrounds unless the style is aurora/glass; no gradient-text headlines except where the style demands it; no emoji used as icons (use inline SVG); no rows of identical rounded cards with identical shadows as the whole page.
- **Asymmetry and rhythm.** Vary section layouts; do not centre everything.
- **Specific, plain copy.** Real local detail (area names, opening hours, Rs prices, doctor names, Indian phone format). Banned words: "elevate", "unlock", "seamless", "cutting-edge", "revolutionize", "transform your smile journey". Short sentences. Avoid em-dash-heavy copy.
- **Restraint with motion.** One signature moment per demo; the rest of the page is calm.

## Rules: UX must be uncluttered and easy

Each is checked in review of every demo and the portfolio page.

- **One primary CTA per screen** (Book / Call / WhatsApp). Max 6 nav items.
- **Mobile:** sticky booking/call bar; tap targets at least 44px; no horizontal scroll at 390px.
- **Readability:** body text at least 16px on demos (14px minimum for captions); WCAG AA contrast; visible keyboard focus.
- **Content visible without JS or animation.** Reveal animations must fall back to visible content.
- **No scroll hijacking** except where the existing portfolio manifesto section is kept; it must be scrollable and skippable.
- **Motion:** transitions 600ms or less; `prefers-reduced-motion` disables heavy animation; no autoplay sound.
- **Density:** max ~7 sections per demo. Signature moment must never block reading the page or reaching the CTA.

## Process

1. Demos first, in parallel batches grouped by family; each batch reviewed against the rules above before the next starts.
2. Generate screenshots from the finished demos.
3. Rebuild the portfolio page with the screenshots.
4. Commit per batch on `main-ag7yrd`, push there. No push to `main` without explicit approval.

## Verification (before calling anything done)

- Playwright loads every page: zero console errors.
- No horizontal overflow at 390px and 1280px.
- `prefers-reduced-motion` check on all pages.
- Every link and button on the portfolio page clicks through correctly.
- Rule checks above done per demo, with notes recorded.
- Screenshots of results shown to the user.
