#!/usr/bin/env node
'use strict';
/*
 * Screenshots of the NoCap dental demos, for the portfolio gallery and the featured showcase.
 *
 *   node tools/shoot.cjs [file.html ...] [--max-kb=N] [--phone-max-kb=N] [--min-quality=N] [--out=DIR]
 *
 * With no file names it shoots every demo in tools/demos.json. The flags change the size budgets, the lowest JPEG
 * quality tried (default 60) and where the files go (default assets/shots), without editing the script.
 * --max-kb is the desktop budget (default 225: a fully revealed 1280x2400 page is 106 to 218KB at quality 60, so 150
 * cannot be met at any acceptable quality); --phone-max-kb is the phone budget (default 150).
 *
 * Writes, per demo, into assets/shots/:
 *   <name>.jpg     1280px wide, the top 2400px of the page (the whole page if it is shorter), under 225KB
 *   <name>-m.jpg   390px phone viewport, first screen (844 CSS px), under 150KB
 * where <name> is the demo file name without .html.
 *
 * Fixed clock: every page sees Wednesday 28 October 2026, 11:00 India time (Date only, via Playwright's
 * clock.setFixedTime; timers, animation frames and performance.now run normally), so lines that follow the clock
 * (open now, the next days in a picker) do not depend on when the shots are taken.
 *
 * Real fonts only: before every shot the page's own web fonts must be loaded (heading and body font from
 * tools/demos.json). If they are not, the demo FAILS and none of its files are written, so a blocked Google Fonts
 * can never leave fallback-font screenshots behind.
 *
 * Output: one line per demo (desktop KB and quality, phone KB, quality and scale, font check), then a SUMMARY.
 * Exit code: 0 all shot, 1 any demo failed, 2 bad arguments. Re-runnable: existing files are overwritten.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const DEMOS = JSON.parse(fs.readFileSync(path.join(__dirname, 'demos.json'), 'utf8'));

// Size budget per JPEG and the quality ladder (start, step, floor); defaults are the project's, see the flags above.
const FLAGS = Object.fromEntries(
  process.argv.slice(2).filter((a) => /^--[a-z-]+=/.test(a)).map((a) => [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)])
);
const OUT_DIR = path.resolve(FLAGS.out || path.join(ROOT, 'assets', 'shots'));
const DESKTOP_MAX_BYTES = (Number(FLAGS['max-kb']) || 225) * 1024;
const PHONE_MAX_BYTES = (Number(FLAGS['phone-max-kb']) || 150) * 1024;
const QUALITY_START = 78;
const QUALITY_STEP = 6;
const QUALITY_FLOOR = Number(FLAGS['min-quality']) || 60;
const QUALITIES = [];
for (let q = QUALITY_START; q > QUALITY_FLOOR; q -= QUALITY_STEP) QUALITIES.push(q);
QUALITIES.push(QUALITY_FLOOR); // tried in order; the first that fits wins
const DESKTOP = { width: 1280, height: 800, maxShotHeight: 2400 };
const PHONE = { width: 390, height: 844, scales: [2, 1.5] }; // tried in order
const FONTS_WAIT_MS = 1200; // after document.fonts.ready, so intros that start on load are under way
const FINITE_ANIMATION_CAP_MS = 3000;
const SCROLL_STEP_WAIT_MS = 150;
const AFTER_SCROLL_BACK_MS = 600;
// What Date says in every shot: a weekday late morning, inside every demo clinic's stated hours (see the header).
const SHOT_TIME = new Date('2026-10-28T11:00:00+05:30');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- steps ---------- */

// Waits for document.fonts.ready, then checks both pinned fonts: `targets` is [{ family, selector }], the selector being
// an element that is set in that font (h1 for the heading font, p for the body font). Two things must hold per family:
//  - document.fonts.check() is true, asked for the weight and style that element really renders in. A plain
//    check('16px "Family"') asks for weight 400 and fails for families whose static weights (500, 600, 700...) are not
//    the ones loaded, even though the page shows the real font;
//  - at least one FontFace of that family is loaded (and none failed). check() alone answers true for a family that
//    has no @font-face at all (Google Fonts blocked, or a typo in the family name), so it cannot prove the font is real.
async function checkFonts(page, targets) {
  return page.evaluate(async (list) => {
    await document.fonts.ready;
    const bare = (s) => String(s).replace(/^["']|["']$/g, '');
    return list.map(({ family, selector }) => {
      const el = document.querySelector(selector) || document.body;
      const cs = getComputedStyle(el);
      const faces = Array.from(document.fonts).filter((f) => bare(f.family) === family);
      return {
        family,
        check: document.fonts.check(cs.fontStyle + ' ' + cs.fontWeight + ' 16px "' + family + '"'),
        loaded: faces.some((f) => f.status === 'loaded') && !faces.some((f) => f.status === 'error'),
      };
    });
  }, targets);
}

// Resolves once every finite CSS animation has finished (capped), so entrance animations are in their end state.
async function waitForFiniteAnimations(page) {
  await page.evaluate(async (cap) => {
    const capped = (p) => Promise.race([p, new Promise((r) => setTimeout(r, cap))]);
    const finite = document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().iterations !== Infinity);
    await capped(Promise.all(finite.map((a) => a.finished.catch(() => {}))));
  }, FINITE_ANIMATION_CAP_MS);
}

// Scrolls top to bottom in steps so scroll-triggered reveals (.reveal / .in, IntersectionObserver) fire, then back up
// in the same steps (not one jump), so scroll-linked widgets (timelines, parallax) end in their state for scroll 0.
async function scrollThrough(page) {
  await page.evaluate(async (wait) => {
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const total = () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const step = Math.round(window.innerHeight / 2);
    const positions = [];
    for (let y = 0; y < total(); y += step) positions.push(y);
    positions.push(total());
    for (const y of positions.concat(positions.slice(0, -1).reverse())) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await pause(wait);
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, SCROLL_STEP_WAIT_MS);
  await sleep(AFTER_SCROLL_BACK_MS);
}

async function assertAtTop(page) {
  const y = await page.evaluate(() => window.scrollY);
  if (y !== 0) throw new Error('page is not at scroll 0 before the shot (scrollY ' + y + ')');
}

// Height in CSS px of the part of the page that goes into the desktop shot.
async function desktopClipHeight(page) {
  const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
  return Math.min(h, DESKTOP.maxShotHeight);
}

// Encodes the page as JPEG, lowering quality until it fits maxBytes. Returns { buffer, quality } or null if nothing fits.
async function encodeUnderLimit(page, shotOptions, maxBytes) {
  for (const quality of QUALITIES) {
    const buffer = await page.screenshot({ ...shotOptions, type: 'jpeg', quality });
    if (buffer.length <= maxBytes) return { buffer, quality };
  }
  return null;
}

/* ---------- per-demo quirks (keyed by demo file name) ---------- */
/*
 * ready(page, kind)       after fonts and the settle wait, before the scroll-through; kind is 'desktop' or 'phone'
 * beforeShot(page, kind)  after the page is back at scroll 0, just before the shot
 * Either may return a short note for the output line; either throws to fail the demo.
 */
const QUIRKS = {
  // Typewriter intro: types for about 5s, then the cursor blinks, then the twin is swapped for the real heading.
  '11-byte-pixelart.html': {
    async ready(page) {
      await page
        .waitForFunction(
          () => !document.querySelector('.tw-vis') && !document.querySelector('.tw-src.sr') && !document.documentElement.classList.contains('tw-pending'),
          null,
          { timeout: 12000 }
        )
        .catch(() => {
          throw new Error('typewriter intro did not finish within 12s');
        });
    },
  },

  // Line-draw intro: the gold vine finishes within about 1.5s of load.
  '13-bloom-dental-luxury.html': {
    async ready(page) {
      await sleep(1500);
    },
  },

  // Hand-drawn underlines only draw once their word has been on screen. The scroll-through normally triggers them;
  // any underline inside the shot that still has not drawn gets the .drawn class, then the 0.8s stroke transition runs.
  '17-oakwood-family-warm.html': {
    async beforeShot(page, kind) {
      const limit = kind === 'desktop' ? DESKTOP.maxShotHeight : PHONE.height;
      const forced = await page.evaluate((maxTop) => {
        let n = 0;
        document.querySelectorAll('.uw:not(.drawn)').forEach((el) => {
          if (el.getBoundingClientRect().top + window.scrollY < maxTop) {
            el.classList.add('drawn');
            n++;
          }
        });
        return n;
      }, limit);
      await sleep(1000);
      return forced ? 'forced ' + forced + ' underline(s)' : '';
    },
  },

  // The WebGL scene must be the live canvas, not the static SVG fallback. The page sets .plate.is-live once its first
  // frame has drawn; the canvas then fades in over the SVG, which is hidden.
  '22-helix-dental-webgl3d.html': {
    async ready(page) {
      await sleep(2000);
      await page.waitForSelector('.plate.is-live', { timeout: 5000 }).catch(() => {
        throw new Error('WebGL scene is not live (static fallback illustration would be shot)');
      });
    },
    async beforeShot(page) {
      const state = await page.evaluate(() => {
        const stage = document.querySelector('[data-signature="webgl-scene"]');
        const canvas = stage && stage.querySelector('canvas');
        const svg = stage && stage.querySelector('svg[data-fallback]');
        const box = canvas && canvas.getBoundingClientRect();
        return {
          live: !!(stage && stage.closest('.plate.is-live')),
          canvas: !!canvas && box.width > 0 && box.height > 0 && getComputedStyle(canvas).opacity === '1',
          svgHidden: !svg || getComputedStyle(svg).visibility === 'hidden',
        };
      });
      if (!state.live || !state.canvas || !state.svgHidden) {
        throw new Error('WebGL scene is not what is on screen (live ' + state.live + ', canvas visible ' + state.canvas + ', fallback hidden ' + state.svgHidden + ')');
      }
      return 'webgl live';
    },
  },
};

/* ---------- one page load, one shot ---------- */

// Opens `file` in a fresh context (real fonts, default animated-in state, no emulated reduced motion), runs the font
// check and the waits, then calls shoot(page), which returns the encoded shot (or null). Quirk notes are added to it.
// Always closes the context.
async function withDemoPage(browser, demoFile, kind, contextOptions, shoot) {
  const [headingFont, bodyFont] = DEMOS[demoFile].fonts;
  const context = await browser.newContext({
    ...contextOptions,
    reducedMotion: 'no-preference',
    colorScheme: 'light',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata', // the demos are clinics in Tamil Nadu; "open now" lines follow the clock
  });
  try {
    await context.clock.setFixedTime(SHOT_TIME);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await page.goto('file://' + path.join(ROOT, demoFile), { waitUntil: 'load' });

    const fonts = await checkFonts(page, [
      { family: headingFont, selector: 'h1' },
      { family: bodyFont, selector: 'p' },
    ]);
    const bad = fonts.filter((f) => !f.check || !f.loaded);
    if (bad.length) {
      const why = bad.map((f) => '"' + f.family + '" (check ' + f.check + ', loaded ' + f.loaded + ')').join(', ');
      const err = new Error('web font not loaded: ' + why);
      err.fontFailure = true;
      throw err;
    }

    const notes = [];
    const note = (n) => n && notes.push(n);
    await sleep(FONTS_WAIT_MS);
    await waitForFiniteAnimations(page);
    const quirk = QUIRKS[demoFile] || {};
    if (quirk.ready) note(await quirk.ready(page, kind));
    if (kind === 'desktop') await scrollThrough(page);
    await assertAtTop(page);
    if (quirk.beforeShot) note(await quirk.beforeShot(page, kind));
    await assertAtTop(page);
    const result = await shoot(page);
    return result && { ...result, notes };
  } finally {
    await context.close();
  }
}

async function shootDesktop(browser, demoFile) {
  return withDemoPage(browser, demoFile, 'desktop', { viewport: { width: DESKTOP.width, height: DESKTOP.height }, deviceScaleFactor: 1 }, async (page) => {
    const height = await desktopClipHeight(page);
    const clip = { x: 0, y: 0, width: DESKTOP.width, height };
    const shot = await encodeUnderLimit(page, { fullPage: true, clip }, DESKTOP_MAX_BYTES);
    if (!shot) throw new Error('desktop shot is over ' + DESKTOP_MAX_BYTES / 1024 + 'KB even at quality ' + QUALITIES[QUALITIES.length - 1]);
    return { ...shot, scale: 1, height };
  });
}

async function shootPhone(browser, demoFile) {
  for (const scale of PHONE.scales) {
    const result = await withDemoPage(
      browser,
      demoFile,
      'phone',
      { viewport: { width: PHONE.width, height: PHONE.height }, deviceScaleFactor: scale, isMobile: true, hasTouch: true },
      async (page) => {
        const shot = await encodeUnderLimit(page, { clip: { x: 0, y: 0, width: PHONE.width, height: PHONE.height } }, PHONE_MAX_BYTES);
        return shot && { ...shot, scale };
      }
    );
    if (result) return result;
  }
  throw new Error('phone shot is over ' + PHONE_MAX_BYTES / 1024 + 'KB at every scale and quality');
}

/* ---------- main ---------- */

const kb = (n) => (n / 1024).toFixed(1) + 'KB';

async function shootDemo(browser, demoFile) {
  const name = demoFile.replace(/\.html$/, '');
  const [headingFont, bodyFont] = DEMOS[demoFile].fonts;
  // Both shots are made before anything is written, so a failed demo leaves its old files (if any) untouched.
  const desktop = await shootDesktop(browser, demoFile);
  const phone = await shootPhone(browser, demoFile);
  const notes = [...new Set([...desktop.notes, ...phone.notes])];
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name + '.jpg'), desktop.buffer);
  fs.writeFileSync(path.join(OUT_DIR, name + '-m.jpg'), phone.buffer);
  return (
    `${demoFile}  desktop ${kb(desktop.buffer.length)} q${desktop.quality} (${DESKTOP.width}x${desktop.height})` +
    `  phone ${kb(phone.buffer.length)} q${phone.quality} @${phone.scale}x` +
    `  fonts ok (${headingFont}, ${bodyFont})` +
    notes.map((n) => ` [${n}]`).join('')
  );
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((a) => path.basename(a));
  const unknown = args.filter((a) => !DEMOS[a]);
  if (unknown.length) {
    console.error('Unknown demo file(s): ' + unknown.join(', '));
    process.exit(2);
  }
  const files = args.length ? args : Object.keys(DEMOS);

  const browser = await chromium.launch();
  const failures = [];
  let done = 0;
  try {
    for (const demoFile of files) {
      try {
        console.log(await shootDemo(browser, demoFile));
        done++;
      } catch (e) {
        failures.push(demoFile);
        console.log(`${demoFile}  FAIL ${e.fontFailure ? '[fonts] ' : ''}${e.message.split('\n')[0]}  (no files written)`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`SUMMARY ${done}/${files.length} demos shot` + (failures.length ? `, FAILED: ${failures.join(', ')}` : ''));
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
