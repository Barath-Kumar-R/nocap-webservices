#!/usr/bin/env node
'use strict';
/*
 * Checks for the NoCap portfolio page (index.html): gallery cards, hover preview, badges, filters, links, layout,
 * the featured showcase, the style strip, the capabilities list, the manifesto, type and tap sizes, the sticky nav,
 * the WhatsApp float and the custom cursor.
 *
 *   node tools/check-index.cjs [page.html] [--only=check,check]
 *
 * page.html defaults to index.html next to tools/ (another path is for testing the checks on a changed copy; local
 * links then resolve next to that copy). --only runs just the named checks.
 * One line per check: PASS or FAIL <short reason>. Last line is a SUMMARY.
 * Exit code: 0 all pass, 1 any check failed, 2 bad arguments.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const PAGE = path.resolve(ARGS.find((a) => !a.startsWith('--')) || path.join(ROOT, 'index.html'));
const ONLY = (ARGS.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const BANNED_COPY = /elevate|unlock|seamless|cutting-edge|revolutionize|smile journey/gi;
const CARD_COUNT = 22;
// Which demos each filter must show (by file number). Pinned here, not read from the page, so a card with the wrong
// data-cat fails instead of quietly moving to another filter.
const FILTER_CARDS = {
  modern: ['01', '02', '03', '14', '15'],
  bold: ['04', '05', '06', '18', '19'],
  tech: ['07', '08', '09'],
  tactile: ['10', '11'],
  luxury: ['12', '13'],
  warm: ['16', '17'],
  '3d': ['20', '21', '22'],
};
// The hero stats, as the counters end: these exact strings must be in the markup (JS off) and on screen at the end.
const STATS = ['22', '0', '48 hrs'];
const PAN_CARD = 4; // which card the hover tests use (any card works; this one is mid-grid at every width)
const PAN_EARLY_MS = 2000; // the pan must already be under way by now
const PAN_END_MS = 8000; // and have reached the bottom of the screenshot by now (about 6s plus a short delay)
const PAN_BACK_MS = 1500; // after leaving, the image is back at the top by now
const PARK_MS = 3000; // a pointer resting just inside a card's bottom edge must keep it hovered this long
const SHOT_DIFF_MAX = 8; // mean RGB difference (0-255) allowed between a shot and its 640px variant at 16x30
// The featured showcase cycles these demos in this order: [file without .html, the name its slide shows].
const FEATURED = [
  ['22-helix-dental-webgl3d', 'Helix Dental Digital Studio'],
  ['21-depthscape-dental-parallax3d', 'Depthscape Dental Studio'],
  ['12-aura-dental-luxury', 'Aura Dental Studio'],
  ['07-novacare-ai-native', 'NovaCare Dental'],
];
const CYCLE_EARLY_MS = 4000; // two auto-advances must be at least this far apart (the slide time is 5s)
const CYCLE_LATE_MS = 6500; // and an auto-advance must have come by this long after the last one
const CYCLE_HOLD_MS = 6500; // a paused showcase is watched this long and must not change
const STRIP_NAMES = 22; // one style name per demo in the strip under the hero
const NAV_MAX = 6;
const TAP_MIN = 44;
const FLOAT_WIDTHS = [320, 390, 768, 1024, 1280, 1440, 1920];

/* ---------- shared page setup ---------- */

function isFontLoadFailure(entry) {
  if (entry.type !== 'error' || !/^Failed to load resource/.test(entry.text)) return false;
  try {
    return FONT_HOSTS.includes(new URL(entry.url).hostname);
  } catch (e) {
    return false;
  }
}

// Opens index.html in a fresh context, runs fn(page, errors), always cleans up.
// errors collects console errors and uncaught exceptions: { type: 'error' | 'pageerror', text, url }.
// touch: a phone context (hasTouch, isMobile), where (hover: none) and (pointer: coarse) match.
// js:false opens the page with JavaScript disabled.
async function withPage(browser, opts, fn) {
  const { width = 1280, height = 800, reduced = false, touch = false, js = true } = opts;
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    hasTouch: touch,
    isMobile: touch,
    javaScriptEnabled: js,
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push({ type: 'error', text: m.text(), url: m.location().url || '' });
    });
    page.on('pageerror', (e) => errors.push({ type: 'pageerror', text: String(e.message || e).split('\n')[0], url: '' }));
    await page.goto('file://' + PAGE, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    return await fn(page, errors);
  } finally {
    await context.close();
  }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function describeError(e) {
  const where = e.url && !e.url.startsWith('file://') ? ` [${clip(e.url, 50)}]` : '';
  return `${e.type === 'pageerror' ? 'exception' : 'console'}: ${clip(e.text, 70)}${where}`;
}

// Scrolls the i-th match of `selector` to the middle of the viewport at once. The page sets scroll-behavior:smooth, and
// Playwright's own scroll-before-click can race that animation, so targets are placed first and then given time for
// the gallery's reveal transition (0.6s) to finish.
async function centre(page, selector, i = 0, settleMs = 700) {
  await page.evaluate(([sel, i]) => document.querySelectorAll(sel)[i].scrollIntoView({ block: 'center', behavior: 'instant' }), [selector, i]);
  await page.waitForTimeout(settleMs);
}

// Gallery images are lazy: bring every card into view, then wait until each image has finished (loaded or failed).
async function loadCardImages(page) {
  const n = await page.locator('#galleryGrid .g-card').count();
  for (let i = 0; i < n; i++) await centre(page, '#galleryGrid .g-card', i, 60);
  await page.waitForFunction(() => [...document.querySelectorAll('.g-card img')].every((img) => img.complete), null,
    { timeout: 15000 }).catch(() => {});
}

// Scrolls the whole page top to bottom in viewport steps, so observers fire and lazy content loads.
async function scrollThrough(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, innerHeight * 0.8);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
  });
  await loadCardImages(page);
  await page.evaluate(() => scrollTo(0, 0));
}

/* ---------- checks: each returns null (pass) or a short failure reason ---------- */

// Shows of an element: whether it renders at all (display:none on it or an ancestor leaves no client rects), its
// computed visibility, and its effective opacity (product up the ancestor chain, so a faded wrapper counts).
const SHOWN_FN = `(el) => {
  let opacity = 1;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) opacity *= parseFloat(getComputedStyle(n).opacity);
  return { rendered: el.getClientRects().length > 0, hidden: getComputedStyle(el).visibility !== 'visible',
    opacity: Math.round(opacity * 100) / 100 };
}`;
const notShown = (s) => (!s.rendered ? 'display:none' : s.hidden ? 'visibility:hidden' : s.opacity < 0.99 ? `opacity ${s.opacity}` : '');

// How alike two image files look: each is drawn at 16x30 on a canvas, and the mean RGB difference (0-255) is returned
// per pair. The files are served from a made-up http origin through page.route, because a page cannot read canvas
// pixels of file:// images.
async function imageDiffs(browser, pairs) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const dir = path.dirname(PAGE);
    await page.route('http://shots.check/**', (route) => {
      const rel = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
      if (!rel) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>diff</title>' });
      const file = path.join(dir, rel);
      return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
    });
    await page.goto('http://shots.check/');
    return await page.evaluate(async (pairs) => {
      const load = (src) => new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error('cannot load ' + src));
        img.src = '/' + src;
      });
      const pixels = (img) => {
        const c = document.createElement('canvas');
        c.width = 16; c.height = 30;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 16, 30);
        return ctx.getImageData(0, 0, 16, 30).data;
      };
      const out = [];
      for (const [a, b] of pairs) {
        const [pa, pb] = [pixels(await load(a)), pixels(await load(b))];
        let sum = 0;
        for (let k = 0; k < pa.length; k += 4) sum += Math.abs(pa[k] - pb[k]) + Math.abs(pa[k + 1] - pb[k + 1]) + Math.abs(pa[k + 2] - pb[k + 2]);
        out.push(Math.round(sum / (pa.length / 4 * 3) * 10) / 10);
      }
      return out;
    }, pairs);
  } finally {
    await context.close();
  }
}

// (a) Every card has a .g-shot img of its own demo that loads and shows once scrolled into view (not display:none,
// visibility:hidden or faded). Its alt is the card's own name plus " website preview". src is the full shot
// assets/shots/<demo>.jpg with width/height equal to that file's pixels (so nothing shifts while it loads); srcset
// offers the same picture 640px wide (<demo>-640.jpg, half the height, 640w) and the full one (1280w), and whichever
// the browser picked has the matching size. The 640 file must show the same picture as the full one, so a re-shot
// page with a stale 640 copy fails.
async function checkImages(browser) {
  const result = await withPage(browser, {}, async (page) => {
    await loadCardImages(page);
    const n = await page.locator('#galleryGrid .g-card').count();
    if (n !== CARD_COUNT) return { reason: `${n} cards (want ${CARD_COUNT})` };
    const cards = [];
    for (let i = 0; i < n; i++) {
      await centre(page, '#galleryGrid .g-card', i, i === 0 ? 800 : 60);
      // With srcset, naturalWidth is scaled by the picked candidate's density, so the file's own pixel size is read by
      // loading currentSrc into a plain Image.
      cards.push(await page.evaluate(`(async (i) => {
        const shown = ${SHOWN_FN};
        const card = document.querySelectorAll('#galleryGrid .g-card')[i];
        const img = card.querySelector('.g-shot img');
        const h3 = card.querySelector('h3');
        const href = card.getAttribute('href') || '';
        if (!img) return { href, missing: true };
        const file = img.complete && img.naturalWidth ? await new Promise((res) => {
          const probe = new Image();
          probe.onload = () => res({ nw: probe.naturalWidth, nh: probe.naturalHeight });
          probe.onerror = () => res({ nw: 0, nh: 0 });
          probe.src = img.currentSrc || img.src;
        }) : { nw: 0, nh: 0 };
        return {
          href, name: h3 ? h3.textContent.trim() : '', src: img.getAttribute('src') || '', srcset: img.getAttribute('srcset') || '',
          current: decodeURIComponent(new URL(img.currentSrc || img.src).pathname).split('/').slice(-3).join('/'),
          alt: img.getAttribute('alt') || '', nw: file.nw, nh: file.nh,
          w: +img.getAttribute('width'), h: +img.getAttribute('height'), shown: shown(img),
        };
      })(${i})`));
    }
    return { cards };
  });
  if (result.reason) return result.reason;
  const { cards } = result;
  const missing = cards.filter((c) => c.missing);
  if (missing.length) return `${missing.length} card(s) without a .g-shot img, e.g. ${missing[0].href}`;
  const base = (c) => 'assets/shots/' + c.href.replace(/\.html$/, '');
  const wrong = cards.filter((c) => c.src !== base(c) + '.jpg');
  if (wrong.length) return `${wrong.length} card(s) show another demo's shot, e.g. ${wrong[0].href} -> ${wrong[0].src}`;
  const set = cards.filter((c) => c.srcset.replace(/\s+/g, ' ').trim() !== `${base(c)}-640.jpg 640w, ${base(c)}.jpg 1280w`);
  if (set.length) return `${set.length} image(s) without srcset "<demo>-640.jpg 640w, <demo>.jpg 1280w", e.g. ${set[0].href}: "${set[0].srcset}"`;
  const hidden = cards.filter((c) => notShown(c.shown));
  if (hidden.length) return `${hidden.length} image(s) not visible after scrolling into view, e.g. ${hidden[0].href} (${notShown(hidden[0].shown)})`;
  const broken = cards.filter((c) => !(c.nw > 0));
  if (broken.length) return `${broken.length} image(s) did not load, e.g. ${broken[0].current}`;
  const size = cards.filter((c) => (c.current === base(c) + '.jpg'
    ? c.w !== c.nw || c.h !== c.nh
    : c.current !== base(c) + '-640.jpg' || c.nw !== 640 || c.nh !== Math.round(c.h * 640 / c.w)));
  if (size.length) {
    const c = size[0];
    return `${size.length} image(s) whose loaded file does not match: ${c.current} is ${c.nw}x${c.nh}, width/height say ${c.w}x${c.h}`;
  }
  const alt = cards.filter((c) => c.alt !== `${c.name} website preview`);
  if (alt.length) return `${alt.length} image(s) whose alt is not "<card name> website preview", e.g. "${alt[0].alt}" on ${alt[0].name}`;
  const diffs = await imageDiffs(browser, cards.map((c) => [base(c) + '.jpg', base(c) + '-640.jpg']));
  const stale = cards.map((c, i) => ({ c, d: diffs[i] })).filter((x) => x.d > SHOT_DIFF_MAX);
  if (stale.length) return `${stale.length} 640px shot(s) do not match the full shot, e.g. ${base(stale[0].c)}-640.jpg (diff ${stale[0].d})`;
  return null;
}

// Pan state of card i's screenshot: the computed object-position and transform (compared as text), and where the
// image sits in its window. bottom: the last row of the screenshot is showing (translate: the image's bottom edge meets
// the window's; object-position: it reads 100% vertically).
function panState(page, i) {
  return page.evaluate((i) => {
    const img = document.querySelectorAll('#galleryGrid .g-card .g-shot img')[i];
    if (!img) return null;
    const cs = getComputedStyle(img);
    const win = img.parentElement.getBoundingClientRect();
    const r = img.getBoundingClientRect();
    const moved = r.top < win.top - 1;
    return {
      key: cs.objectPosition + ' | ' + cs.transform,
      bottom: moved ? Math.abs(r.bottom - win.bottom) <= 1.5 : /(^|\s)100%$/.test(cs.objectPosition),
      gap: Math.round((r.bottom - win.bottom) * 10) / 10,
      // how far down the page the window shows: px slid (translate) plus the vertical object-position (object-position)
      progress: (win.top - r.top) + (parseFloat(cs.objectPosition.split(' ')[1]) || 0),
      hovered: img.closest('.g-card').matches(':hover'),
    };
  }, i);
}

async function hoverCard(page, i) {
  await centre(page, '#galleryGrid .g-card', i);
  await page.locator('#galleryGrid .g-card').nth(i).hover();
}

// Presses Tab until a gallery card has focus; returns its index, or -1.
async function tabToCard(page) {
  for (let tab = 0; tab < 60; tab++) {
    await page.keyboard.press('Tab');
    const i = await page.evaluate(() => [...document.querySelectorAll('#galleryGrid .g-card')].indexOf(document.activeElement));
    if (i >= 0) return i;
  }
  return -1;
}

// (b) Desktop (1280x800, hover and fine pointer): hovering a card moves its screenshot within 2s, reaches the bottom of
// the screenshot by 8s and returns to the top after the pointer leaves. A pointer resting 2px inside a card's bottom
// edge keeps it hovered for 3s and the pan only moves forward (a hover lift that moves the card out from under the
// pointer would make it flicker and restart). Keyboard focus (Tab, :focus-visible) also moves it. Under reduced
// motion neither hover nor keyboard focus moves it, and on a touch phone (hover: none) hovering does not.
async function checkPan(browser) {
  const desktop = await withPage(browser, {}, async (page) => {
    const before = await panState(page, PAN_CARD);
    if (!before) return 'no .g-card .g-shot img to hover';
    await hoverCard(page, PAN_CARD);
    await page.waitForTimeout(PAN_EARLY_MS);
    const early = await panState(page, PAN_CARD);
    if (early.key === before.key) return `hover: image did not move after ${PAN_EARLY_MS / 1000}s (${clip(before.key, 60)})`;
    await page.waitForTimeout(PAN_END_MS - PAN_EARLY_MS);
    const end = await panState(page, PAN_CARD);
    if (!end.bottom) return `hover: pan did not reach the bottom of the screenshot after ${PAN_END_MS / 1000}s (gap ${end.gap}px)`;
    await page.mouse.move(2, 2);
    await page.waitForTimeout(PAN_BACK_MS);
    const back = await panState(page, PAN_CARD);
    if (back.key !== before.key) return `leave: image not back at the top after ${PAN_BACK_MS / 1000}s (${clip(back.key, 60)})`;
    return null;
  });
  if (desktop) return desktop;

  const parked = await withPage(browser, {}, async (page) => {
    await centre(page, '#galleryGrid .g-card', PAN_CARD);
    const box = await page.locator('#galleryGrid .g-card').nth(PAN_CARD).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2);
    let last = (await panState(page, PAN_CARD)).progress;
    for (let t = 0; t < PARK_MS; t += 100) {
      await page.waitForTimeout(100);
      const s = await panState(page, PAN_CARD);
      if (!s.hovered) return `pointer 2px inside the card's bottom edge: card lost :hover after ${(t + 100) / 1000}s`;
      if (s.progress < last - 0.5) return `pointer 2px inside the card's bottom edge: pan went back (${Math.round(last)} -> ${Math.round(s.progress)}px) after ${(t + 100) / 1000}s`;
      last = s.progress;
    }
    return last > 0 ? null : `pointer 2px inside the card's bottom edge: image did not move in ${PARK_MS / 1000}s`;
  });
  if (parked) return parked;

  const keyboard = await withPage(browser, {}, async (page) => {
    const before = await panState(page, 0);
    const i = await tabToCard(page);
    if (i < 0) return 'keyboard: Tab never reached a gallery card';
    const visible = await page.evaluate(() => { try { return document.activeElement.matches(':focus-visible'); } catch (e) { return false; } });
    if (!visible) return 'keyboard: focused card is not :focus-visible';
    await page.waitForTimeout(PAN_EARLY_MS);
    const after = await panState(page, i);
    return after.key === before.key ? `keyboard: focusing card ${i + 1} did not move its image` : null;
  });
  if (keyboard) return keyboard;

  const reducedFocus = await withPage(browser, { reduced: true }, async (page) => {
    const before = await panState(page, 0);
    const i = await tabToCard(page);
    if (i < 0) return 'reduced motion: Tab never reached a gallery card';
    await page.waitForTimeout(PAN_EARLY_MS);
    const after = await panState(page, i);
    return after.key !== before.key ? `reduced motion: keyboard focus moved the image (${clip(after.key, 60)})` : null;
  });
  if (reducedFocus) return reducedFocus;

  for (const [label, opts] of [['reduced motion', { reduced: true }], ['touch', { touch: true, width: 390, height: 844 }]]) {
    const still = await withPage(browser, opts, async (page) => {
      const before = await panState(page, PAN_CARD);
      await hoverCard(page, PAN_CARD);
      await page.waitForTimeout(PAN_EARLY_MS);
      const after = await panState(page, PAN_CARD);
      return after.key !== before.key ? `${label}: hover moved the image (${clip(after.key, 60)})` : null;
    });
    if (still) return still;
  }
  return null;
}

// How every card shows (see SHOWN_FN): rendered at all, visibility, effective opacity.
function cardStates(page) {
  return page.evaluate(`[...document.querySelectorAll('#galleryGrid .g-card')].map(${SHOWN_FN})`);
}

// Cards must actually show: on a phone (390x844, 320x568) and on desktop, each card scrolled into view is rendered,
// visible and at full opacity (the gallery's scroll reveal must fire even though one column of 22 cards is many
// screens tall), and with JS off every card shows without scrolling.
async function checkVisible(browser) {
  for (const [width, height] of [[390, 844], [320, 568], [1280, 800]]) {
    const reason = await withPage(browser, { width, height }, async (page) => {
      const n = await page.locator('#galleryGrid .g-card').count();
      if (n !== CARD_COUNT) return `${n} cards (want ${CARD_COUNT})`;
      for (let i = 0; i < n; i++) {
        const rendered = await page.evaluate((i) => document.querySelectorAll('#galleryGrid .g-card')[i].getClientRects().length > 0, i);
        if (rendered) await centre(page, '#galleryGrid .g-card', i, i === 0 ? 800 : 60);
        const why = notShown((await cardStates(page))[i]);
        if (why) return `card ${i + 1} not visible after scrolling it into view (${why})`;
      }
      return null;
    });
    if (reason) return `@${width} ${reason}`;
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto('file://' + PAGE, { waitUntil: 'load' });
    const states = await cardStates(page);
    const hidden = states.map((s, i) => ({ i, why: notShown(s) })).filter((x) => x.why);
    return hidden.length ? `JS off: ${hidden.length} card(s) not visible, e.g. card ${hidden[0].i + 1} (${hidden[0].why})` : null;
  } finally {
    await context.close();
  }
}

// Hero stats with JavaScript disabled read their true values straight from the markup (22 / 0 / 48 hrs, as pinned in
// STATS, and each equal to what its counter counts to: data-count plus data-suffix). With JS on under reduced motion
// they show the same values at once, never a count from 0; with JS on they end on the same values.
async function checkNoJsStats(browser) {
  const read = (page) => page.evaluate(() => [...document.querySelectorAll('.hero-stats b')].map((b) => ({
    text: b.textContent.trim(), counter: (b.dataset.count || '') + (b.dataset.suffix || ''),
  })));
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, javaScriptEnabled: false });
  let off;
  try {
    const page = await context.newPage();
    await page.goto('file://' + PAGE, { waitUntil: 'load' });
    off = await read(page);
  } finally {
    await context.close();
  }
  const texts = (stats) => stats.map((s) => s.text).join(' / ');
  if (texts(off) !== STATS.join(' / ')) return `JS off: stats read "${texts(off)}" (want "${STATS.join(' / ')}")`;
  const odd = off.find((s) => s.text !== s.counter);
  if (odd) return `JS off: stat "${odd.text}" is not what its counter counts to ("${odd.counter}")`;
  const reduced = await withPage(browser, { reduced: true }, async (page) => {
    for (let k = 0; k < 6; k++) {
      const now = texts(await read(page));
      if (now !== STATS.join(' / ')) return `reduced motion: stats read "${now}" at ${k * 100}ms (want "${STATS.join(' / ')}" throughout)`;
      await page.waitForTimeout(100);
    }
    return null;
  });
  if (reduced) return reduced;
  return withPage(browser, {}, async (page) => {
    await page.waitForTimeout(2000);
    const end = texts(await read(page));
    return end === STATS.join(' / ') ? null : `JS on: counters end on "${end}" (want "${STATS.join(' / ')}")`;
  });
}

// (c) Every card has a .badges row holding 1 to 3 badges, each with text.
async function checkBadges(browser) {
  return withPage(browser, {}, async (page) => {
    const rows = await page.evaluate(() => [...document.querySelectorAll('#galleryGrid .g-card')].map((card) => {
      const row = card.querySelector('.badges');
      return {
        href: card.getAttribute('href') || '',
        row: !!row,
        n: row ? row.children.length : 0,
        empty: row ? [...row.children].filter((b) => !b.textContent.trim()).length : 0,
      };
    }));
    if (!rows.length) return 'no gallery cards';
    const none = rows.filter((r) => !r.row);
    if (none.length) return `${none.length} card(s) without .badges, e.g. ${none[0].href}`;
    const count = rows.filter((r) => r.n < 1 || r.n > 3);
    if (count.length) return `${count.length} card(s) with ${count[0].n} badges (want 1-3), e.g. ${count[0].href}`;
    const empty = rows.filter((r) => r.empty);
    return empty.length ? `${empty.length} card(s) with an empty badge, e.g. ${empty[0].href}` : null;
  });
}

// (d) The 8 filter buttons (all plus the 7 in FILTER_CARDS): clicking each shows exactly the demos pinned for it (all
// 22 for "all"), compared by file number, not just by count, and marks itself the one active button. The "all" button's
// label states 22.
async function checkFilters(browser) {
  const allCards = Array.from({ length: CARD_COUNT }, (_, i) => String(i + 1).padStart(2, '0'));
  const want = { all: allCards, ...FILTER_CARDS };
  return withPage(browser, {}, async (page) => {
    const buttons = await page.evaluate(() => [...document.querySelectorAll('.filter-btn')]
      .map((b) => ({ filter: b.dataset.filter, text: b.textContent.trim() })));
    const names = buttons.map((b) => b.filter);
    if (names.slice().sort().join() !== Object.keys(want).sort().join()) return `filter buttons are [${names.join(', ')}] (want [${Object.keys(want).join(', ')}])`;
    const all = buttons.find((b) => b.filter === 'all');
    if (!all.text.includes(String(CARD_COUNT))) return `"all" button reads "${all.text}" (want the count ${CARD_COUNT})`;
    await centre(page, '.filters');
    for (const [i, b] of buttons.entries()) {
      await page.locator('.filter-btn').nth(i).click();
      const got = await page.evaluate((i) => ({
        shown: [...document.querySelectorAll('#galleryGrid .g-card')].filter((c) => c.getClientRects().length)
          .map((c) => (c.getAttribute('href') || '').slice(0, 2)),
        active: document.querySelectorAll('.filter-btn')[i].classList.contains('active'),
        actives: document.querySelectorAll('.filter-btn.active').length,
      }), i);
      const shown = got.shown.slice().sort().join(', ');
      if (shown !== want[b.filter].join(', ')) return `"${b.text}" shows [${shown}] (want [${want[b.filter].join(', ')}])`;
      if (!got.active || got.actives !== 1) return `"${b.text}" is not the one active button after a click`;
    }
    return null;
  });
}

// (e) Every local href, src and srcset URL resolves: files exist (relative to the page), #anchors name an element id.
// External links (http, https, mailto, tel, data) are not followed. Every .g-card links to a distinct, existing local
// demo.
async function checkLinks(browser) {
  const found = await withPage(browser, {}, (page) => page.evaluate(() => ({
    refs: [
      ...[...document.querySelectorAll('[href]')].map((el) => el.getAttribute('href')),
      ...[...document.querySelectorAll('[src]')].map((el) => el.getAttribute('src')),
      ...[...document.querySelectorAll('[srcset]')].flatMap((el) => el.getAttribute('srcset').split(',')
        .map((part) => part.trim().split(/\s+/)[0]).filter(Boolean)),
    ],
    ids: [...document.querySelectorAll('[id]')].map((el) => el.id),
    cards: [...document.querySelectorAll('#galleryGrid .g-card')].map((c) => c.getAttribute('href') || ''),
  })));
  const bad = [];
  for (const ref of found.refs) {
    if (/^(https?:|mailto:|tel:|data:)/i.test(ref)) continue;
    if (ref.startsWith('#')) {
      if (!found.ids.includes(decodeURIComponent(ref.slice(1)))) bad.push(`${ref} (no such id)`);
      continue;
    }
    const file = decodeURIComponent(ref.split(/[?#]/)[0]);
    if (!file || !fs.existsSync(path.join(path.dirname(PAGE), file))) bad.push(`${ref} (no such file)`);
  }
  if (bad.length) return `${bad.length} broken link(s): ${bad.slice(0, 3).join(', ')}`;
  if (found.cards.length !== CARD_COUNT) return `${found.cards.length} cards (want ${CARD_COUNT})`;
  const external = found.cards.filter((h) => !/^[\w.-]+\.html$/.test(h));
  if (external.length) return `card link is not a local demo: ${external[0]}`;
  if (new Set(found.cards).size !== found.cards.length) return 'two cards link to the same demo';
  return null;
}

// (f) No console errors and no uncaught exceptions while the page loads and is scrolled top to bottom (all lazy images
// requested), at 1280 and 390. Failed requests to Google Fonts are ignored.
async function checkConsole(browser) {
  const seen = new Set();
  for (const width of [1280, 390]) {
    await withPage(browser, { width, height: width === 390 ? 844 : 800 }, async (page, errors) => {
      await scrollThrough(page);
      await page.waitForTimeout(300);
      for (const e of errors) if (!isFontLoadFailure(e)) seen.add(describeError(e));
    });
  }
  if (!seen.size) return null;
  const [first, ...rest] = [...seen].sort();
  return first + (rest.length ? ` (+${rest.length} more)` : '');
}

// (g) No horizontal page overflow at 320, 390, 768 and 1280, and nothing inside a card pokes out of it (cards clip
// their overflow, so a too-wide badge row would be cut off silently rather than scroll the page). Card body content
// must also stay inside the body's padding, so text never runs up to the card edge.
async function checkOverflow(browser) {
  const bad = [];
  for (const width of [320, 390, 768, 1280]) {
    const r = await withPage(browser, { width }, (page) => page.evaluate(() => {
      const out = [];
      for (const card of document.querySelectorAll('#galleryGrid .g-card')) {
        const cardBox = card.getBoundingClientRect();
        const body = card.querySelector('.g-body');
        const bodyBox = body ? body.getBoundingClientRect() : cardBox;
        const pad = body ? getComputedStyle(body) : null;
        const inner = body
          ? { left: bodyBox.left + parseFloat(pad.paddingLeft), right: bodyBox.right - parseFloat(pad.paddingRight) }
          : cardBox;
        for (const el of card.querySelectorAll('.g-chrome *, .g-body *')) {
          const r = el.getBoundingClientRect();
          if (!r.width && !r.height) continue;
          const box = el.closest('.g-body') ? inner : cardBox;
          if (r.right > box.right + 0.5 || r.left < box.left - 0.5) {
            const cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
            out.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} in ${card.getAttribute('href')}`);
          }
        }
      }
      return { scroll: document.documentElement.scrollWidth, inner: innerWidth, out };
    }));
    if (r.scroll > r.inner) bad.push(`@${width} scrollWidth ${r.scroll}>${r.inner}`);
    if (r.out.length) bad.push(`@${width} ${r.out.length} element(s) outside their card or its padding, e.g. ${r.out[0]}`);
  }
  return bad.length ? bad.join('; ') : null;
}

// Rendered elements inside gallery cards that directly hold non-empty text (each element once).
const CARD_TEXT_FN = `(() => {
  const els = [];
  const seen = new Set();
  for (const card of document.querySelectorAll('#galleryGrid .g-card')) {
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !n.nodeValue.trim()) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
      els.push(el);
    }
  }
  return els;
})()`;

const describeEl = `(el) => { const cls = (el.getAttribute('class') || '').trim().split(/\\s+/)[0];
  return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + ' "' + el.textContent.trim().slice(0, 18) + '"'; }`;

// Rendered elements anywhere on the page that directly hold non-empty text (each element once). Skipped: text in
// script/style/noscript/svg (SVG labels scale with their drawing and are judged by eye), text that does not render
// (display:none up the chain, visibility:hidden) and visually hidden screen-reader text (a box of 1px or less).
// Faded text (a scroll reveal that has not run yet) still counts: it will show.
const PAGE_TEXT_FN = `(() => {
  const els = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.nodeValue.trim()) continue;
    seen.add(el);
    if (el.closest('script, style, noscript, svg')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 && r.height <= 1) continue;
    els.push(el);
  }
  return els;
})()`;

// (h) Type sizes over the whole page, at 390 and 1280: no rendered text under 14px (labels, eyebrows, stat captions,
// card chrome, footer, strip; gallery cards included), body text at least 16px, and every paragraph of running text
// (a p over 80 characters) at least 16px.
async function checkType(browser) {
  const bad = [];
  for (const width of [390, 1280]) {
    const r = await withPage(browser, { width }, (page) => page.evaluate(`(() => {
      const name = ${describeEl};
      const size = (el) => parseFloat(getComputedStyle(el).fontSize);
      const small = ${PAGE_TEXT_FN}.filter((el) => size(el) < 14).map((el) => name(el) + ' ' + size(el) + 'px');
      const paras = [...document.querySelectorAll('p')].filter((p) => p.getClientRects().length && getComputedStyle(p).visibility !== 'hidden'
        && p.textContent.trim().replace(/\\s+/g, ' ').length > 80 && size(p) < 16).map((p) => name(p) + ' ' + size(p) + 'px');
      return { body: size(document.body), small, paras };
    })()`));
    if (r.body < 16) bad.push(`@${width} body ${r.body}px`);
    if (r.small.length) bad.push(`@${width} ${r.small.length} text element(s) <14px, e.g. ${[...new Set(r.small)].slice(0, 2).join(', ')}`);
    if (r.paras.length) bad.push(`@${width} ${r.paras.length} paragraph(s) of running text <16px, e.g. ${r.paras[0]}`);
  }
  return bad.length ? bad.join('; ') : null;
}

// (i) WCAG AA for text in gallery cards, badges included: 4.5:1, or 3:1 for large text (24px, or 18.66px bold).
// The background is the first opaque-enough background colour up the ancestor chain (alpha blended over white);
// card text sits on flat colours, so a background image anywhere in that chain is reported rather than guessed.
async function checkContrast(browser) {
  const r = await withPage(browser, {}, (page) => page.evaluate(`(() => {
    const name = ${describeEl};
    const parse = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
    const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const bad = [], unknown = [];
    let badges = 0;
    for (const el of ${CARD_TEXT_FN}) {
      const layers = [];
      let image = false;
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.backgroundImage !== 'none') { image = true; break; }
        const c = parse(cs.backgroundColor);
        if (c.a > 0) { layers.push(c); if (c.a >= 1) break; }
      }
      if (image) { unknown.push(name(el)); continue; }
      let bg = { r: 255, g: 255, b: 255, a: 1 };
      for (const c of layers.reverse()) bg = over(c, bg);
      const cs = getComputedStyle(el);
      const fg = over(parse(cs.color), bg);
      const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10);
      const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
      const got = ratio(fg, bg);
      if (el.closest('.badges')) badges++;
      if (got < need) bad.push(name(el) + ' ' + got.toFixed(2) + ':1');
    }
    return { bad, unknown, badges };
  })()`));
  if (!r.badges) return 'no badge text to measure';
  if (r.unknown.length) return `${r.unknown.length} text element(s) over a background image, e.g. ${r.unknown[0]}`;
  return r.bad.length ? `${r.bad.length} text element(s) under AA, e.g. ${[...new Set(r.bad)].slice(0, 2).join(', ')}` : null;
}

// Page copy: no banned words and no emoji in the visible text or the title (glyphs © and arrows are fine).
async function checkCopy(browser) {
  const text = await withPage(browser, {}, (page) => page.evaluate(() => document.title + '\n' + document.body.innerText));
  const problems = [];
  const banned = [...new Set((text.match(BANNED_COPY) || []).map((w) => w.toLowerCase()))];
  if (banned.length) problems.push(`banned: ${banned.join(', ')}`);
  const emoji = [...new Set(text.replace(/[©®™]/g, '').match(/\p{Extended_Pictographic}/gu) || [])];
  if (emoji.length) problems.push(`emoji: ${emoji.slice(0, 5).join(' ')}`);
  return problems.length ? problems.join('; ') : null;
}

/* ---------- shared helpers for the page-level checks ---------- */

// Colour maths for page evaluation: parse a computed colour, blend over another, WCAG contrast ratio, and the
// background an element's text sits on (the first opaque-enough colour up the ancestor chain, blended over white; null
// when a background image is in the way, so it is never guessed).
const COLOR_LIB = `
  const parse = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== 'none') return null;
      const c = parse(cs.backgroundColor);
      if (c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (const c of layers.reverse()) bg = over(c, bg);
    return bg;
  };
  const textRatio = (el) => { const bg = bgOf(el); if (!bg) return null; return ratio(over(parse(getComputedStyle(el).color), bg), bg); };
  const needFor = (el) => { const cs = getComputedStyle(el); const s = parseFloat(cs.fontSize), w = parseInt(cs.fontWeight, 10);
    return s >= 24 || (s >= 18.66 && w >= 700) ? 3 : 4.5; };
`;

// Sets scroll-behavior to auto, so scripted scrolls and fragment jumps land at once and can be measured.
const instantScroll = (page) => page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; });

// Bottom edge of the sticky nav in the viewport (0 when there is no nav).
const navBottom = (page) => page.evaluate(() => { const n = document.querySelector('nav'); return n ? n.getBoundingClientRect().bottom : 0; });

// Presses Tab (or Shift+Tab) until fn(document.activeElement) is true in the page; returns whether it got there.
async function tabUntil(page, test, { back = false, max = 200 } = {}) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
    if (await page.evaluate(test)) return true;
  }
  return false;
}

/* ---------- featured showcase ---------- */

// The showcase as it shows now: names of its slides that are fully on screen (each slide names its demo in an h3;
// rendered, visible and at full opacity), and the text of its aria-live region (null when it has none).
const FEAT_FN = `(() => {
  const shown = ${SHOWN_FN};
  const ok = (el) => { const s = shown(el); return s.rendered && !s.hidden && s.opacity >= 0.99; };
  const sec = document.getElementById('featured');
  if (!sec) return null;
  const live = sec.querySelector('[aria-live]');
  return {
    names: [...sec.querySelectorAll('h3')].filter(ok).map((h) => h.textContent.trim()),
    all: [...sec.querySelectorAll('h3')].map((h) => h.textContent.trim()),
    live: live ? live.textContent.trim() : null,
  };
})()`;

async function featName(page) {
  const s = await page.evaluate(FEAT_FN);
  return s ? s.names.join(' + ') : null;
}

// Watches the showcase for up to ms; returns the first change ({ at, from, to }) or null if it held still.
async function watchFeatured(page, ms) {
  const from = await featName(page);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await page.waitForTimeout(200);
    const to = await featName(page);
    if (to !== from) return { at: Date.now() - t0, from, to };
  }
  return null;
}

// Waits for the next auto-advance and for its fade to finish; returns the slide name then, or null if none came.
async function nextAdvance(page, ms = CYCLE_LATE_MS) {
  const change = await watchFeatured(page, ms);
  if (!change) return null;
  await page.waitForTimeout(800);
  return { at: change.at, name: await featName(page) };
}

// Puts the showcase in the middle of the screen with the pointer parked far from it (over the nav, top left), and
// gives its scroll reveal (a 0.6s fade) time to finish.
async function showFeatured(page) {
  await page.mouse.move(5, 5);
  await centre(page, '#featured', 0, 1000);
}

// A showcase button by its accessible name.
const featButton = (page, name) => page.locator('#featured').getByRole('button', { name });

// What the showcase shows on the current slide: its "View live" link(s) and its images, each judged visible as in
// FEAT_FN. For images: src, width/height attributes, the pixel size of the file in src (probe: read by loading src
// into a plain Image, which needs page script, so it is skipped with JS off), alt and loading. Waits for the
// rendered images to finish first (hidden slides' lazy images never load, so they are not waited for).
async function featSlideParts(page, probe = true) {
  await page.waitForFunction(() => [...document.querySelectorAll('#featured img')].filter((img) => img.getClientRects().length)
    .every((img) => img.complete), null, { timeout: 15000 }).catch(() => {});
  if (!probe) {
    return page.evaluate(`(() => {
      const shown = ${SHOWN_FN};
      const ok = (el) => { const s = shown(el); return s.rendered && !s.hidden && s.opacity >= 0.99; };
      const sec = document.getElementById('featured');
      return {
        links: [...sec.querySelectorAll('a')].filter((a) => ok(a) && /view live/i.test(a.textContent)).map((a) => ({ href: a.getAttribute('href') || '' })),
        imgs: [...sec.querySelectorAll('img')].filter(ok).map((img) => ({ src: img.getAttribute('src') || '', loaded: img.complete && img.naturalWidth > 0 })),
      };
    })()`);
  }
  return page.evaluate(`(async () => {
    const shown = ${SHOWN_FN};
    const ok = (el) => { const s = shown(el); return s.rendered && !s.hidden && s.opacity >= 0.99; };
    const sec = document.getElementById('featured');
    const links = [...sec.querySelectorAll('a')].filter((a) => ok(a) && /view live/i.test(a.textContent)).map((a) => ({
      href: a.getAttribute('href') || '', h: a.getBoundingClientRect().height, w: a.getBoundingClientRect().width }));
    const size = (src) => new Promise((res) => { const p = new Image(); p.onload = () => res([p.naturalWidth, p.naturalHeight]); p.onerror = () => res([0, 0]); p.src = src; });
    const imgs = [];
    for (const img of sec.querySelectorAll('img')) {
      if (!ok(img)) continue;
      const [nw, nh] = await size(img.getAttribute('src'));
      imgs.push({ src: img.getAttribute('src') || '', w: +img.getAttribute('width'), h: +img.getAttribute('height'), nw, nh,
        alt: img.getAttribute('alt') || '', loading: img.getAttribute('loading') || 'eager', loaded: img.complete && img.naturalWidth > 0 });
    }
    return { links, imgs };
  })()`);
}

// featured-cycle: section#featured cycles FEATURED in order. On a desktop (1280x800, motion allowed) it advances by
// itself, 4-6.5s apart, without announcing; it holds still while hovered (and resumes after), while keyboard focus is
// inside it, while scrolled off screen, under reduced motion (where Next still works) and after Pause (Play resumes).
// Previous, Next, Pause and the four slide dots are real buttons with names, at least 44x44; user navigation is
// announced in the aria-live region. Every slide shows one "View live" link (44px tall) to its own demo file, and its
// desktop shot and -m phone shot as images with their real pixel sizes, alt naming the demo, lazy except on the first
// slide. With JS off the first slide shows, the others do not, the other three are plain links, and no button shows.
async function checkFeatured(browser) {
  const names = FEATURED.map(([, n]) => n);
  const auto = await withPage(browser, {}, async (page) => {
    const s = await page.evaluate(FEAT_FN);
    if (!s) return 'no section#featured';
    if (s.all.join(', ') !== names.join(', ')) return `slides are [${s.all.join(', ')}] (want [${names.join(', ')}])`;
    await showFeatured(page);
    const first = await featName(page);
    if (first !== names[0]) return `first slide shown is "${first}" (want "${names[0]}")`;
    const a = await nextAdvance(page);
    if (!a) return `no auto-advance within ${CYCLE_LATE_MS / 1000}s on screen`;
    if (a.name !== names[1]) return `auto-advance went to "${a.name}" (want "${names[1]}")`;
    const b = await nextAdvance(page);
    if (!b) return `no second auto-advance within ${CYCLE_LATE_MS / 1000}s`;
    if (b.at + 800 < CYCLE_EARLY_MS) return `auto-advances only ${((b.at + 800) / 1000).toFixed(1)}s apart (want about 5s)`;
    if (b.name !== names[2]) return `second auto-advance went to "${b.name}" (want "${names[2]}")`;
    const live = (await page.evaluate(FEAT_FN)).live;
    if (live === null) return 'no aria-live region in #featured';
    if (live) return `auto-advance was announced ("${clip(live, 40)}"); only user navigation should be`;
    // off screen: scrolled well past it, it must not advance
    await centre(page, '#why', 0, 0);
    await page.waitForTimeout(CYCLE_HOLD_MS);
    await centre(page, '#featured', 0, 300);
    const back = await featName(page);
    if (back !== names[2]) return `advanced while off screen ("${names[2]}" -> "${back}")`;
    return null;
  });
  if (auto) return auto;

  const hover = await withPage(browser, {}, async (page) => {
    await showFeatured(page);
    const box = await page.locator('#featured').boundingBox();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
    if (await watchFeatured(page, CYCLE_HOLD_MS)) return 'changed slide while hovered';
    await page.mouse.move(5, 5);
    return (await nextAdvance(page)) ? null : `did not resume within ${CYCLE_LATE_MS / 1000}s after the pointer left`;
  });
  if (hover) return hover;

  const focus = await withPage(browser, {}, async (page) => {
    await showFeatured(page);
    const inside = await tabUntil(page, () => !!document.activeElement.closest('#featured'));
    if (!inside) return 'Tab never reached a control inside #featured';
    await centre(page, '#featured', 0, 300);
    return (await watchFeatured(page, CYCLE_HOLD_MS)) ? 'changed slide while keyboard focus was inside it' : null;
  });
  if (focus) return focus;

  const paused = await withPage(browser, {}, async (page) => {
    await showFeatured(page);
    const pause = featButton(page, /pause/i);
    if (!(await pause.count())) return 'no Pause button in #featured';
    await pause.first().click();
    await page.mouse.move(5, 5);
    if (await watchFeatured(page, CYCLE_HOLD_MS)) return 'changed slide after Pause';
    const play = featButton(page, /play/i);
    if (!(await play.count())) return 'Pause did not become a Play button';
    await play.first().click();
    await page.mouse.move(5, 5);
    return (await nextAdvance(page)) ? null : `Play did not resume the cycle within ${CYCLE_LATE_MS / 1000}s`;
  });
  if (paused) return paused;

  const reduced = await withPage(browser, { reduced: true }, async (page) => {
    await showFeatured(page);
    if (await watchFeatured(page, CYCLE_HOLD_MS)) return 'reduced motion: advanced by itself';
    await featButton(page, /next/i).first().click();
    await page.waitForTimeout(800);
    const now = await featName(page);
    return now === names[1] ? null : `reduced motion: Next shows "${now}" (want "${names[1]}")`;
  });
  if (reduced) return reduced;

  const controls = await withPage(browser, {}, async (page) => {
    await showFeatured(page);
    const sizes = await page.evaluate(() => [...document.querySelectorAll('#featured button')]
      .filter((b) => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden')
      .map((b) => { const r = b.getBoundingClientRect(); return { name: (b.getAttribute('aria-label') || b.textContent).trim(), w: r.width, h: r.height }; }));
    const unnamed = sizes.filter((b) => !b.name);
    if (unnamed.length) return `${unnamed.length} showcase button(s) without an accessible name`;
    const small = sizes.filter((b) => b.w < TAP_MIN || b.h < TAP_MIN);
    if (small.length) return `showcase button "${small[0].name}" is ${small[0].w.toFixed(1)}x${small[0].h.toFixed(1)} (want at least ${TAP_MIN}x${TAP_MIN})`;
    const dots = sizes.filter((b) => !/^(previous|prev|next|pause|play)\b/i.test(b.name));
    if (dots.length !== FEATURED.length) return `${dots.length} slide dot button(s) (want ${FEATURED.length})`;
    await featButton(page, /^next/i).first().click();
    await page.waitForTimeout(800);
    if ((await featName(page)) !== names[1]) return `Next shows "${await featName(page)}" (want "${names[1]}")`;
    const live = (await page.evaluate(FEAT_FN)).live || '';
    if (!live.includes(names[1])) return `Next was not announced (live region reads "${clip(live, 40)}")`;
    await featButton(page, /^prev/i).first().click();
    await page.waitForTimeout(800);
    if ((await featName(page)) !== names[0]) return `Previous shows "${await featName(page)}" (want "${names[0]}")`;
    for (let i = 0; i < FEATURED.length; i++) {
      await featButton(page, dots[i].name).first().click();
      await page.waitForTimeout(800);
      const now = await featName(page);
      if (now !== names[i]) return `dot "${dots[i].name}" shows "${now}" (want "${names[i]}")`;
      const [file] = FEATURED[i];
      const parts = await featSlideParts(page);
      if (parts.links.length !== 1) return `slide ${i + 1} shows ${parts.links.length} "View live" link(s) (want 1)`;
      const link = parts.links[0];
      if (link.href !== file + '.html') return `slide ${i + 1} "View live" goes to "${link.href}" (want ${file}.html)`;
      if (!fs.existsSync(path.join(path.dirname(PAGE), link.href))) return `slide ${i + 1} "View live" target ${link.href} does not exist`;
      if (link.h < TAP_MIN) return `slide ${i + 1} "View live" is ${link.h.toFixed(1)}px tall (want ${TAP_MIN})`;
      for (const src of [`assets/shots/${file}.jpg`, `assets/shots/${file}-m.jpg`]) {
        const img = parts.imgs.find((m) => m.src === src);
        if (!img) return `slide ${i + 1} does not show ${src} (shows ${parts.imgs.map((m) => m.src).join(', ') || 'no image'})`;
        if (!img.loaded) return `slide ${i + 1} image ${src} did not load`;
        if (img.w !== img.nw || img.h !== img.nh) return `${src} has width/height ${img.w}x${img.h}, file is ${img.nw}x${img.nh}`;
        if (!img.alt.includes(names[i])) return `${src} alt "${img.alt}" does not name "${names[i]}"`;
        if (i > 0 && img.loading !== 'lazy') return `${src} is not loading="lazy" (only the first slide loads at once)`;
      }
    }
    return null;
  });
  if (controls) return controls;

  return withPage(browser, { js: false }, async (page) => {
    const s = await page.evaluate(FEAT_FN);
    if (s.names.join(', ') !== names[0]) return `JS off: slides shown are [${s.names.join(', ')}] (want just "${names[0]}")`;
    const parts = await featSlideParts(page, false);
    if (parts.links.length !== 1 || parts.links[0].href !== FEATURED[0][0] + '.html') return `JS off: the first slide has no "View live" link to ${FEATURED[0][0]}.html`;
    const srcs = parts.imgs.map((m) => m.src);
    if (!srcs.includes(`assets/shots/${FEATURED[0][0]}.jpg`) || !srcs.includes(`assets/shots/${FEATURED[0][0]}-m.jpg`)) return `JS off: first slide images not shown (${srcs.join(', ') || 'none'})`;
    const unloaded = parts.imgs.filter((m) => !m.loaded);
    if (unloaded.length) return `JS off: ${unloaded[0].src} did not load`;
    const other = await page.evaluate(`(() => {
      const shown = ${SHOWN_FN};
      const ok = (el) => { const s = shown(el); return s.rendered && !s.hidden && s.opacity >= 0.99; };
      const sec = document.getElementById('featured');
      return {
        hrefs: [...sec.querySelectorAll('a')].filter(ok).map((a) => a.getAttribute('href')),
        buttons: [...sec.querySelectorAll('button')].filter(ok).map((b) => (b.getAttribute('aria-label') || b.textContent).trim()),
      };
    })()`);
    const missing = FEATURED.slice(1).filter(([file]) => !other.hrefs.includes(file + '.html'));
    if (missing.length) return `JS off: no plain link to ${missing.map(([f]) => f).join(', ')}`;
    return other.buttons.length ? `JS off: ${other.buttons.length} dead button(s) show, e.g. "${other.buttons[0]}"` : null;
  });
}

/* ---------- style strip ---------- */

// The strip's state: its two lists (the second aria-hidden, the same names), the transform of its moving track, and
// for the first list whether every name sits inside the viewport (a static, wrapping row).
const STRIP_FN = `(() => {
  ${COLOR_LIB}
  const strip = document.querySelector('.style-strip');
  if (!strip) return null;
  const lists = [...strip.querySelectorAll('ul, ol')];
  const items = (l) => [...l.querySelectorAll('li')].map((li) => li.textContent.trim().replace(/\\s+/g, ' '));
  const first = lists[0];
  const shownLis = first ? [...first.querySelectorAll('li')].filter((li) => li.getClientRects().length) : [];
  const moving = document.getAnimations().filter((a) => a.effect && a.effect.target && strip.contains(a.effect.target) && a.playState === 'running');
  const track = moving.length ? moving[0].effect.target : (first || strip);
  return {
    lists: lists.map((l) => ({ hidden: l.getAttribute('aria-hidden') === 'true' || !!l.closest('[aria-hidden="true"]'), items: items(l), rendered: l.getClientRects().length > 0 })),
    running: moving.length,
    transform: getComputedStyle(track).transform,
    inside: shownLis.every((li) => { const r = li.getBoundingClientRect(); return r.left >= -0.5 && r.right <= innerWidth + 0.5; }),
    small: shownLis.filter((li) => parseFloat(getComputedStyle(li).fontSize) < 14).length,
    contrast: shownLis.map((li) => { const r = textRatio(li); return r === null ? null : +r.toFixed(2); }),
    button: !!strip.querySelector('button'),
    scroll: document.documentElement.scrollWidth, inner: innerWidth,
  };
})()`;

// strip: .style-strip under the hero holds STRIP_NAMES style names in a list, and the same names again in a second
// list marked aria-hidden (so assistive tech reads one list); names are at least 14px and AA on their background.
// With motion allowed it moves (an infinite animation), holds still while hovered and after its pause button is
// pressed. Under reduced motion and with JS off nothing in it animates and every name of the first list sits inside
// the viewport (a static wrapping row). No horizontal page overflow at 320, 390 or 1280.
async function checkStrip(browser) {
  const live = await withPage(browser, {}, async (page) => {
    await page.mouse.move(5, 5);
    const s = await page.evaluate(STRIP_FN);
    if (!s) return 'no .style-strip';
    if (s.lists.length !== 2) return `${s.lists.length} list(s) in the strip (want 2: the names and an aria-hidden copy)`;
    if (s.lists[0].hidden || !s.lists[1].hidden) return 'the second list (only) must be aria-hidden="true"';
    if (s.lists[0].items.length !== STRIP_NAMES) return `${s.lists[0].items.length} style names (want ${STRIP_NAMES})`;
    if (s.lists[0].items.join('|') !== s.lists[1].items.join('|')) return 'the aria-hidden copy does not repeat the same names';
    if (s.small) return `${s.small} style name(s) under 14px`;
    const weak = s.contrast.filter((c) => c === null || c < 4.5);
    if (weak.length) return `style name contrast ${weak[0] === null ? 'over a background image' : weak[0] + ':1'} (want 4.5:1)`;
    if (!s.running) return 'nothing in the strip moves with motion allowed';
    await centre(page, '.style-strip', 0, 100);
    const a = (await page.evaluate(STRIP_FN)).transform;
    await page.waitForTimeout(600);
    if ((await page.evaluate(STRIP_FN)).transform === a) return 'the strip does not move';
    const box = await page.locator('.style-strip').boundingBox();
    await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
    await page.waitForTimeout(300);
    const h1 = (await page.evaluate(STRIP_FN)).transform;
    await page.waitForTimeout(600);
    if ((await page.evaluate(STRIP_FN)).transform !== h1) return 'the strip keeps moving while hovered';
    await page.mouse.move(5, 5);
    if (!s.button) return 'no pause button in the strip';
    await page.locator('.style-strip button').first().click();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    const p1 = (await page.evaluate(STRIP_FN)).transform;
    await page.waitForTimeout(600);
    if ((await page.evaluate(STRIP_FN)).transform !== p1) return 'the strip keeps moving after its pause button';
    return null;
  });
  if (live) return live;
  for (const [label, opts] of [['reduced motion', { reduced: true }], ['JS off', { js: false }]]) {
    for (const width of [390, 1280]) {
      const r = await withPage(browser, { ...opts, width }, async (page) => {
        const s = await page.evaluate(STRIP_FN);
        if (s.running) return `${s.running} animation(s) running in the strip`;
        if (!s.inside) return 'the names do not all fit on screen (want a static wrapping row)';
        return null;
      });
      if (r) return `${label} @${width}: ${r}`;
    }
  }
  for (const width of [320, 390, 1280]) {
    const s = await withPage(browser, { width }, (page) => page.evaluate(STRIP_FN));
    if (s.scroll > s.inner) return `@${width} page scrollWidth ${s.scroll}>${s.inner}`;
  }
  return null;
}

/* ---------- capabilities ---------- */

// capabilities-link: section#capabilities lists the 7 design directions as links to #gallery, one per filter
// (data-filter, the same keys as FILTER_CARDS), each with a description and a real example demo of that direction
// (the name of one of its cards). With JS, activating one (click, or Enter on the last) selects that filter (the
// gallery shows exactly its pinned cards, one active button), scrolls the filter bar into view below the sticky nav
// and puts focus on the active filter button. Without JS each link simply jumps to #gallery.
async function checkCapabilities(browser) {
  const keys = Object.keys(FILTER_CARDS);
  const read = (page) => page.evaluate(() => {
    const sec = document.getElementById('capabilities');
    if (!sec) return null;
    const cardNames = {};
    for (const c of document.querySelectorAll('#galleryGrid .g-card')) {
      const n = (c.getAttribute('href') || '').slice(0, 2);
      cardNames[n] = (c.querySelector('h3') || { textContent: '' }).textContent.trim();
    }
    return {
      cardNames,
      links: [...sec.querySelectorAll('a[data-filter]')].map((a) => {
        const item = a.closest('li') || a.parentElement;
        return { filter: a.dataset.filter, href: a.getAttribute('href'), text: a.textContent.trim(), item: item.textContent.replace(/\s+/g, ' ').trim(), h: a.getBoundingClientRect().height };
      }),
    };
  });
  const r = await withPage(browser, {}, async (page) => {
    const s = await read(page);
    if (!s) return 'no section#capabilities';
    const got = s.links.map((l) => l.filter);
    if (got.slice().sort().join() !== keys.slice().sort().join()) return `capability links [${got.join(', ')}] (want one for each of [${keys.join(', ')}])`;
    for (const l of s.links) {
      if (l.href !== '#gallery') return `"${l.text}" links to "${l.href}" (want #gallery)`;
      if (l.item.length - l.text.length < 40) return `"${l.text}" has no description`;
      const examples = FILTER_CARDS[l.filter].map((n) => s.cardNames[n]);
      if (!examples.some((name) => name && l.item.includes(name))) return `"${l.text}" names no example demo of its own direction (one of ${examples.join(', ')})`;
    }
    await instantScroll(page);
    for (const [i, key] of keys.entries()) {
      const link = page.locator(`#capabilities a[data-filter="${key}"]`);
      await link.scrollIntoViewIfNeeded();
      if (i === keys.length - 1) { await link.focus(); await page.keyboard.press('Enter'); } else await link.click();
      await page.waitForTimeout(900);
      const g = await page.evaluate(() => {
        const bar = document.querySelector('.filters').getBoundingClientRect();
        const nav = document.querySelector('nav').getBoundingClientRect();
        const active = [...document.querySelectorAll('.filter-btn.active')];
        return {
          active: active.map((b) => b.dataset.filter),
          shown: [...document.querySelectorAll('#galleryGrid .g-card')].filter((c) => c.getClientRects().length).map((c) => (c.getAttribute('href') || '').slice(0, 2)).sort(),
          barTop: bar.top, navBottom: nav.bottom, inner: innerHeight,
          focus: document.activeElement && document.activeElement.classList.contains('filter-btn') ? document.activeElement.dataset.filter : null,
        };
      });
      if (g.active.join() !== key) return `"${key}" capability: active filter is [${g.active.join(', ')}]`;
      if (g.shown.join(', ') !== FILTER_CARDS[key].join(', ')) return `"${key}" capability: gallery shows [${g.shown.join(', ')}] (want [${FILTER_CARDS[key].join(', ')}])`;
      if (g.barTop < g.navBottom - 0.5 || g.barTop > g.inner * 0.6) return `"${key}" capability: filter bar lands at ${Math.round(g.barTop)}px (nav ends at ${Math.round(g.navBottom)}px)`;
      if (g.focus !== key) return `"${key}" capability: focus is not on the active filter button`;
    }
    return null;
  });
  if (r) return r;
  return withPage(browser, { js: false }, async (page) => {
    const s = await read(page);
    const wrong = s.links.filter((l) => l.href !== '#gallery');
    if (wrong.length) return `JS off: "${wrong[0].text}" links to "${wrong[0].href}"`;
    await page.locator('#capabilities a[data-filter]').first().click();
    await page.waitForTimeout(300);
    const hash = await page.evaluate(() => location.hash);
    return hash === '#gallery' ? null : `JS off: a capability link went to "${hash}" (want #gallery)`;
  });
}

/* ---------- manifesto ---------- */

// The manifesto's words and how they read: effective opacity, visibility, contrast with the page behind them, and
// whether anything in the section is pinned (sticky or fixed); also the section's height against the viewport.
const MANIFESTO_FN = `(() => {
  ${COLOR_LIB}
  const shown = ${SHOWN_FN};
  const sec = document.querySelector('#manifesto, .manifesto-wrap');
  if (!sec) return null;
  let words = [...sec.querySelectorAll('.w')];
  if (!words.length) words = [...sec.querySelectorAll('h2, p')];
  return {
    words: words.map((w) => { const s = shown(w); const c = textRatio(w); return { text: w.textContent.trim(), opacity: s.opacity, hidden: s.hidden || !s.rendered, contrast: c === null ? 0 : +c.toFixed(2), need: needFor(w) }; }),
    pinned: [sec, ...sec.querySelectorAll('*')].some((el) => /sticky|fixed/.test(getComputedStyle(el).position)),
    height: sec.getBoundingClientRect().height, inner: innerHeight,
  };
})()`;

const unreadWord = (m) => m.words.find((w) => w.hidden || w.opacity < 0.99 || w.contrast < w.need);
const describeWord = (w) => `"${w.text}" ${w.hidden ? 'hidden' : w.opacity < 0.99 ? 'at opacity ' + w.opacity : 'contrast ' + w.contrast + ':1'}`;

// manifesto-nojs: the manifesto (#manifesto or .manifesto-wrap) reads in full without script and without motion:
// with JS off (1280 and 390) and under reduced motion every word is at full opacity with AA contrast for its size,
// nothing is pinned and the section is at most 1.2 screens tall. With motion allowed every word stays readable at
// every 10% of the way through it (the reveal may change colour, never hide a word). A "Skip" link (an in-page link
// in or just before the section) is reached by Tab, is visible when focused (on screen, below the nav, at least
// 44x44), and Enter on it scrolls past the manifesto so the next Tab lands after it. Checked at 1280 and 390 with JS
// on, and at 1280 with JS off.
async function checkManifesto(browser) {
  for (const [label, opts] of [['JS off @1280', { js: false }], ['JS off @390', { js: false, width: 390, height: 844 }], ['reduced motion', { reduced: true }]]) {
    const r = await withPage(browser, opts, async (page) => {
      let m = await page.evaluate(MANIFESTO_FN);
      if (!m) return 'no manifesto section';
      if (m.pinned) return 'the manifesto is pinned (sticky or fixed)';
      if (m.height > m.inner * 1.2) return `the manifesto is ${Math.round(m.height)}px tall (${(m.height / m.inner).toFixed(1)} screens)`;
      if (opts.reduced) { await centre(page, '#manifesto, .manifesto-wrap', 0, 300); m = await page.evaluate(MANIFESTO_FN); }
      const w = unreadWord(m);
      return w ? describeWord(w) : null;
    });
    if (r) return `${label}: ${r}`;
  }
  const scrolled = await withPage(browser, {}, async (page) => {
    await instantScroll(page);
    const span = await page.evaluate(() => {
      const sec = document.querySelector('#manifesto, .manifesto-wrap');
      const top = sec.getBoundingClientRect().top + scrollY;
      return { from: top - innerHeight, to: top + sec.offsetHeight };
    });
    for (let k = 0; k <= 10; k++) {
      await page.evaluate((y) => scrollTo(0, y), span.from + (span.to - span.from) * k / 10);
      await page.waitForTimeout(250);
      const w = unreadWord(await page.evaluate(MANIFESTO_FN));
      if (w) return `${k * 10}% through: ${describeWord(w)}`;
    }
    return null;
  });
  if (scrolled) return `motion: ${scrolled}`;
  for (const [label, opts] of [['@1280', {}], ['@390', { width: 390, height: 844 }], ['JS off', { js: false }]]) {
    const r = await withPage(browser, opts, async (page) => {
      await instantScroll(page);
      const isSkip = () => {
        const a = document.activeElement;
        const sec = document.querySelector('#manifesto, .manifesto-wrap');
        if (!a || a.tagName !== 'A' || !/skip/i.test(a.textContent) || !(a.getAttribute('href') || '').startsWith('#')) return false;
        return sec.contains(a) || sec.previousElementSibling === a || (a.parentElement && a.parentElement.nextElementSibling === sec);
      };
      if (!(await tabUntil(page, isSkip))) return 'no Skip link reached by Tab';
      await page.waitForTimeout(400);
      const f = await page.evaluate(`(() => {
        const shown = ${SHOWN_FN};
        const a = document.activeElement;
        const r = a.getBoundingClientRect();
        const s = shown(a);
        return { s, top: r.top, bottom: r.bottom, w: r.width, h: r.height, nav: document.querySelector('nav').getBoundingClientRect().bottom, inner: innerHeight };
      })()`);
      if (!f.s.rendered || f.s.hidden || f.s.opacity < 0.99) return 'the focused Skip link is not visible';
      if (f.top < f.nav - 0.5 || f.bottom > f.inner + 0.5) return `the focused Skip link is off screen or under the nav (top ${Math.round(f.top)}, nav ${Math.round(f.nav)})`;
      if (f.w < TAP_MIN || f.h < TAP_MIN) return `the Skip link is ${f.w.toFixed(1)}x${f.h.toFixed(1)} (want at least ${TAP_MIN}x${TAP_MIN})`;
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);
      const past = await page.evaluate(() => {
        const sec = document.querySelector('#manifesto, .manifesto-wrap');
        let words = [...sec.querySelectorAll('.w')];
        if (!words.length) words = [...sec.querySelectorAll('h2, p')];
        return { bottom: Math.max(...words.map((w) => w.getBoundingClientRect().bottom)), nav: document.querySelector('nav').getBoundingClientRect().bottom };
      });
      if (past.bottom > past.nav + 1) return `Enter on Skip left the manifesto words on screen (their bottom at ${Math.round(past.bottom)}px, nav ${Math.round(past.nav)}px)`;
      await page.keyboard.press('Tab');
      const after = await page.evaluate(() => {
        const sec = document.querySelector('#manifesto, .manifesto-wrap');
        const a = document.activeElement;
        return a && a !== document.body && !sec.contains(a) && !!(sec.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      return after ? null : 'after Skip, Tab does not land past the manifesto';
    });
    if (r) return `Skip ${label}: ${r}`;
  }
  return null;
}

/* ---------- tap targets, nav ---------- */

// tap: at 390 and 1280 every rendered, visible link, button and form control is at least 44x44 (compared unrounded),
// filter buttons, nav items and footer links included. Exempt: a link inside running text (a p that holds more text
// than the link) and visually hidden screen-reader text (a box of 1px or less; the skip link is judged in
// manifesto-nojs when focused).
async function checkTap(browser) {
  const bad = [];
  for (const [width, height] of [[390, 844], [1280, 800]]) {
    const small = await withPage(browser, { width, height }, (page) => page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('a[href], button, [role=button], input, select, textarea, summary')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 1 && r.height <= 1) continue;
        const p = el.tagName === 'A' && el.parentElement.closest('p');
        if (p && p.textContent.trim() !== el.textContent.trim()) continue;
        if (r.width < 44 || r.height < 44) {
          const cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
          out.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} "${(el.getAttribute('aria-label') || el.textContent).trim().slice(0, 16)}" ${+r.width.toFixed(1)}x${+r.height.toFixed(1)}`);
        }
      }
      return out;
    }));
    if (small.length) bad.push(`@${width} ${small.length} target(s) under ${TAP_MIN}px, e.g. ${small.slice(0, 2).join(', ')}`);
  }
  return bad.length ? bad.join('; ') : null;
}

// nav: distinct nav links (by href plus text) excluding the logo and the btn/cta link: at most NAV_MAX (as in
// tools/check.cjs).
async function checkNav(browser) {
  const count = await withPage(browser, {}, (page) => page.evaluate(() => {
    const links = [...document.querySelectorAll('nav a')];
    const cls = (a) => a.getAttribute('class') || '';
    const looksLikeLogo = (a) => /^(\/|#|#top)?$/.test(a.getAttribute('href') || '') || !!a.querySelector('svg, [class*=logo], [class*=brand]');
    const items = links.filter((a, i) => !/logo|brand/i.test(cls(a)) && !/btn|cta/i.test(cls(a)) && !(i === 0 && looksLikeLogo(a)));
    return new Set(items.map((a) => `${a.getAttribute('href') || ''}|${a.textContent.trim().replace(/\s+/g, ' ').toLowerCase()}`)).size;
  }));
  return count <= NAV_MAX ? null : `${count} distinct nav links (max ${NAV_MAX}, logo and CTA excluded)`;
}

/* ---------- landings under the sticky nav ---------- */

// anchors: at 721, 1024, 1280 and 390 wide, a jump to every in-page link target (#id, as a click or a typed URL
// does, so nav links hidden at that width count too) lands with the target's first line of text and its first
// heading at or below the sticky nav's bottom edge. Then Tab through the whole page and Shift+Tab back: no focused
// element (that fits on screen) ever sits under the nav.
async function checkAnchors(browser) {
  const bad = [];
  for (const [width, height] of [[721, 800], [1024, 800], [1280, 800], [390, 844]]) {
    const r = await withPage(browser, { width, height }, async (page) => {
      await instantScroll(page);
      const ids = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href^="#"]')]
        .map((a) => decodeURIComponent(a.getAttribute('href').slice(1))).filter(Boolean))]);
      for (const id of ids) {
        await page.evaluate(() => { history.replaceState(null, '', location.pathname); scrollTo(0, 0); });
        await page.evaluate((id) => { location.hash = id; }, id);
        await page.waitForTimeout(200);
        const m = await page.evaluate((id) => {
          const t = document.getElementById(id);
          if (!t) return null;
          const nav = document.querySelector('nav').getBoundingClientRect().bottom;
          const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
          let first = null;
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const el = n.parentElement;
            if (!n.nodeValue.trim() || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 1 && r.height <= 1) continue;
            first = { text: n.nodeValue.trim().slice(0, 20), top: r.top };
            break;
          }
          const h = t.matches('h1, h2, h3') ? t : t.querySelector('h1, h2, h3');
          return { nav, first, heading: h ? { text: h.textContent.trim().slice(0, 20), top: h.getBoundingClientRect().top } : null };
        }, id);
        if (!m) continue;
        for (const part of [m.first, m.heading]) {
          if (part && part.top < m.nav - 0.5) return `#${id} lands with "${part.text}" ${Math.round(m.nav - part.top)}px under the nav`;
        }
      }
      await page.evaluate(() => { history.replaceState(null, '', location.pathname); scrollTo(0, 0); document.activeElement.blur(); });
      const under = () => page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body || a.closest('nav') || getComputedStyle(a).position === 'fixed') return null;
        const nav = document.querySelector('nav').getBoundingClientRect().bottom;
        const r = a.getBoundingClientRect();
        if (r.height > innerHeight - nav) return null;
        return r.top < nav - 0.5 ? `${a.tagName.toLowerCase()} "${(a.getAttribute('aria-label') || a.textContent).trim().replace(/\s+/g, ' ').slice(0, 20)}" ${Math.round(nav - r.top)}px under the nav` : null;
      });
      const seen = new Set();
      for (const back of [false, true]) {
        for (let i = 0; i < 250; i++) {
          await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
          const key = await page.evaluate(() => { const a = document.activeElement; return a === document.body ? 'body' : [...document.querySelectorAll('*')].indexOf(a); });
          if (key === 'body' || (!back && seen.has(key))) break;
          seen.add(key);
          const u = await under();
          if (u) return `${back ? 'Shift+Tab' : 'Tab'}: ${u}`;
        }
      }
      return null;
    });
    if (r) bad.push(`@${width} ${r}`);
  }
  return bad.length ? bad.join('; ') : null;
}

/* ---------- WhatsApp float ---------- */

// float: at FLOAT_WIDTHS, scrolled through the whole page in steps of 3/4 of a screen, the WhatsApp float (whenever it
// shows: rendered, visible, opacity above 0.05) never overlaps a line of text, a link, a button or a form field.
// Text is measured line by line (Range rects), so wide blocks with a free corner do not count.
async function checkFloat(browser) {
  const bad = [];
  for (const width of FLOAT_WIDTHS) {
    const height = width < 721 ? 844 : 800;
    const r = await withPage(browser, { width, height }, async (page) => {
      await instantScroll(page);
      const total = await page.evaluate(() => document.documentElement.scrollHeight);
      for (let y = 0; y < total; y += Math.round(height * 0.75)) {
        await page.evaluate((y) => scrollTo(0, y), y);
        await page.waitForTimeout(350);
        const hit = await page.evaluate(() => {
          const f = document.querySelector('.wa-float');
          if (!f) return null;
          const cs = getComputedStyle(f);
          let op = 1;
          for (let n = f; n && n.nodeType === 1; n = n.parentElement) op *= parseFloat(getComputedStyle(n).opacity);
          if (cs.display === 'none' || cs.visibility === 'hidden' || op <= 0.05 || !f.getClientRects().length) return null;
          const fr = f.getBoundingClientRect();
          const meets = (r) => r.width > 0 && r.height > 0 && r.left < fr.right && r.right > fr.left && r.top < fr.bottom && r.bottom > fr.top;
          const visible = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const c = getComputedStyle(n); if (c.visibility === 'hidden' || parseFloat(c.opacity) <= 0.05) return false; } return el.getClientRects().length > 0; };
          for (const el of document.querySelectorAll('a[href], button, input, select, textarea')) {
            if (f.contains(el) || !visible(el)) continue;
            if (meets(el.getBoundingClientRect())) return `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent).trim().slice(0, 20)}"`;
          }
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const el = n.parentElement;
            if (!n.nodeValue.trim() || f.contains(el) || el.closest('script, style, noscript') || !visible(el)) continue;
            const range = document.createRange();
            range.selectNodeContents(n);
            for (const rr of range.getClientRects()) if (meets(rr)) return `text "${n.nodeValue.trim().slice(0, 20)}"`;
          }
          return null;
        });
        if (hit) return `covers ${hit} at scroll ${y}`;
      }
      return null;
    });
    if (r) bad.push(`@${width} ${r}`);
  }
  return bad.length ? bad.slice(0, 3).join('; ') + (bad.length > 3 ? ` (+${bad.length - 3} more widths)` : '') : null;
}

/* ---------- custom cursor ---------- */

// The custom cursor's parts (.cursor-dot, .cursor-ring, or any element whose class names a cursor): whether any of
// them shows (rendered, visible, opacity above 0.05, and on screen), and the html cursor style.
const CURSOR_FN = `(() => {
  const parts = [...document.querySelectorAll('[class*="cursor"]')].filter((el) => el !== document.documentElement);
  const shows = parts.filter((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) return false;
    let op = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) op *= parseFloat(getComputedStyle(n).opacity);
    const r = el.getBoundingClientRect();
    return op > 0.05 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  });
  const dot = document.querySelector('.cursor-dot');
  const r = dot ? dot.getBoundingClientRect() : null;
  return { parts: parts.length, shows: shows.map((el) => el.className), cursor: getComputedStyle(document.body).cursor,
    dot: r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null };
})()`;

// cursor-hidden: before the first pointer move on a desktop no part of the custom cursor shows and the system cursor
// is not hidden; after a move the dot shows at the pointer (the feature still works). With JS off, and on a touch
// phone after a tap, no part shows.
async function checkCursor(browser) {
  const desk = await withPage(browser, {}, async (page) => {
    await page.waitForTimeout(500);
    const before = await page.evaluate(CURSOR_FN);
    if (before.shows.length) return `before any pointer move, "${before.shows[0]}" shows`;
    if (before.cursor === 'none') return 'the system cursor is hidden before the custom cursor shows';
    await page.mouse.move(400, 300);
    await page.mouse.move(420, 320);
    await page.waitForTimeout(400);
    const after = await page.evaluate(CURSOR_FN);
    if (!after.parts) return null; // no custom cursor at all is fine
    if (!after.shows.length) return 'after a pointer move the custom cursor does not show';
    if (after.dot && Math.hypot(after.dot.x - 420, after.dot.y - 320) > 4) return `the cursor dot is at ${Math.round(after.dot.x)},${Math.round(after.dot.y)}, not at the pointer`;
    return null;
  });
  if (desk) return desk;
  const off = await withPage(browser, { js: false }, (page) => page.evaluate(CURSOR_FN));
  if (off.shows.length) return `JS off: "${off.shows[0]}" shows`;
  return withPage(browser, { touch: true, width: 390, height: 844 }, async (page) => {
    await page.touchscreen.tap(200, 400);
    await page.waitForTimeout(400);
    const s = await page.evaluate(CURSOR_FN);
    return s.shows.length ? `touch: "${s.shows[0]}" shows after a tap` : null;
  });
}

const CHECKS = {
  images: checkImages,
  visible: checkVisible,
  pan: checkPan,
  badges: checkBadges,
  filters: checkFilters,
  links: checkLinks,
  console: checkConsole,
  overflow: checkOverflow,
  type: checkType,
  contrast: checkContrast,
  copy: checkCopy,
  'nojs-stats': checkNoJsStats,
  'featured-cycle': checkFeatured,
  strip: checkStrip,
  'capabilities-link': checkCapabilities,
  'manifesto-nojs': checkManifesto,
  tap: checkTap,
  nav: checkNav,
  anchors: checkAnchors,
  float: checkFloat,
  'cursor-hidden': checkCursor,
};

/* ---------- runner ---------- */

async function main() {
  const unknown = ONLY.filter((id) => !CHECKS[id]);
  if (unknown.length || !fs.existsSync(PAGE)) {
    console.error(`check-index: ${unknown.length ? `unknown check(s): ${unknown.join(', ')}` : `no such page: ${PAGE}`}`);
    process.exit(2);
  }
  const run = Object.entries(CHECKS).filter(([id]) => !ONLY.length || ONLY.includes(id));
  const browser = await chromium.launch();
  let failed = 0;
  try {
    console.log(path.relative(ROOT, PAGE) || PAGE);
    for (const [id, check] of run) {
      let reason;
      try {
        reason = await check(browser);
      } catch (e) {
        reason = `error: ${clip(String(e.message || e).split('\n')[0], 100)}`;
      }
      if (reason) failed++;
      console.log(`  ${id.padEnd(17)} ${reason ? 'FAIL ' + reason : 'PASS'}`);
    }
  } finally {
    await browser.close();
  }
  const total = run.length;
  console.log(`SUMMARY ${total} checks: ${total - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
