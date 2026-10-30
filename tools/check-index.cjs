#!/usr/bin/env node
'use strict';
/*
 * Checks for the NoCap portfolio page (index.html): gallery cards, hover preview, badges, filters, links, layout.
 *
 *   node tools/check-index.cjs
 *
 * One line per check: PASS or FAIL <short reason>. Last line is a SUMMARY.
 * Exit code: 0 all pass, 1 any check failed.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'index.html');
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const BANNED_COPY = /elevate|unlock|seamless|cutting-edge|revolutionize|smile journey/gi;
const CARD_COUNT = 22;
const FILTER_COUNT = 8;
const PAN_CARD = 4; // which card the hover tests use (any card works; this one is mid-grid at every width)
const PAN_EARLY_MS = 2000; // the pan must already be under way by now
const PAN_END_MS = 7000; // and have reached the bottom of the screenshot by now (about 6s plus a short delay)
const PAN_BACK_MS = 1500; // after leaving, the image is back at the top by now

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
async function withPage(browser, opts, fn) {
  const { width = 1280, height = 800, reduced = false, touch = false } = opts;
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    hasTouch: touch,
    isMobile: touch,
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

// (a) Every card has a .g-shot img of its own demo (assets/shots/<demo>.jpg) that loads, with width/height attributes
// equal to the file's pixel size (so nothing shifts while it loads) and an alt that names the demo.
async function checkImages(browser) {
  return withPage(browser, {}, async (page) => {
    await loadCardImages(page);
    const cards = await page.evaluate(() => [...document.querySelectorAll('#galleryGrid .g-card')].map((card) => {
      const img = card.querySelector('.g-shot img');
      const href = card.getAttribute('href') || '';
      if (!img) return { href, missing: true };
      return {
        href, src: img.getAttribute('src') || '', alt: img.getAttribute('alt') || '',
        nw: img.naturalWidth, nh: img.naturalHeight, w: +img.getAttribute('width'), h: +img.getAttribute('height'),
      };
    }));
    if (cards.length !== CARD_COUNT) return `${cards.length} cards (want ${CARD_COUNT})`;
    const missing = cards.filter((c) => c.missing);
    if (missing.length) return `${missing.length} card(s) without a .g-shot img, e.g. ${missing[0].href}`;
    const wrong = cards.filter((c) => c.src !== 'assets/shots/' + c.href.replace(/\.html$/, '') + '.jpg');
    if (wrong.length) return `${wrong.length} card(s) show another demo's shot, e.g. ${wrong[0].href} -> ${wrong[0].src}`;
    const broken = cards.filter((c) => !(c.nw > 0));
    if (broken.length) return `${broken.length} image(s) did not load, e.g. ${broken[0].src}`;
    const size = cards.filter((c) => c.w !== c.nw || c.h !== c.nh);
    if (size.length) return `${size.length} image(s) with width/height unlike the file, e.g. ${size[0].src} ${size[0].w}x${size[0].h} vs ${size[0].nw}x${size[0].nh}`;
    const alt = cards.filter((c) => !/\S website preview$/.test(c.alt));
    if (alt.length) return `${alt.length} image(s) without a "<name> website preview" alt, e.g. ${alt[0].src}`;
    return null;
  });
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
    };
  }, i);
}

async function hoverCard(page, i) {
  await centre(page, '#galleryGrid .g-card', i);
  await page.locator('#galleryGrid .g-card').nth(i).hover();
}

// (b) Desktop (1280x800, hover and fine pointer): hovering a card moves its screenshot within 2s, reaches the bottom of
// the screenshot by 7s and returns to the top after the pointer leaves. Keyboard focus (Tab, :focus-visible) also
// moves it. Under reduced motion, and on a touch phone (hover: none), hovering does not move it.
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

  const keyboard = await withPage(browser, {}, async (page) => {
    const before = await panState(page, 0);
    let i = -1;
    for (let tab = 0; tab < 60 && i < 0; tab++) {
      await page.keyboard.press('Tab');
      i = await page.evaluate(() => [...document.querySelectorAll('#galleryGrid .g-card')].indexOf(document.activeElement));
    }
    if (i < 0) return 'keyboard: Tab never reached a gallery card';
    const visible = await page.evaluate(() => { try { return document.activeElement.matches(':focus-visible'); } catch (e) { return false; } });
    if (!visible) return 'keyboard: focused card is not :focus-visible';
    await page.waitForTimeout(PAN_EARLY_MS);
    const after = await panState(page, i);
    return after.key === before.key ? `keyboard: focusing card ${i + 1} did not move its image` : null;
  });
  if (keyboard) return keyboard;

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

// Effective opacity of every card (product up the ancestor chain, so a faded gallery wrapper counts).
function cardOpacities(page) {
  return page.evaluate(() => [...document.querySelectorAll('#galleryGrid .g-card')].map((card) => {
    let opacity = 1;
    for (let n = card; n && n.nodeType === 1; n = n.parentElement) opacity *= parseFloat(getComputedStyle(n).opacity);
    return Math.round(opacity * 100) / 100;
  }));
}

// Cards must actually show: on a phone (390x844, 320x568) and on desktop, each card scrolled into view reaches full
// opacity (the gallery's scroll reveal must fire even though one column of 22 cards is many screens tall), and with
// JS off every card is fully visible without scrolling.
async function checkVisible(browser) {
  for (const [width, height] of [[390, 844], [320, 568], [1280, 800]]) {
    const reason = await withPage(browser, { width, height }, async (page) => {
      const n = await page.locator('#galleryGrid .g-card').count();
      for (let i = 0; i < n; i++) {
        await centre(page, '#galleryGrid .g-card', i, i === 0 ? 800 : 60);
        const op = (await cardOpacities(page))[i];
        if (op < 0.99) return `card ${i + 1} at opacity ${op} after scrolling it into view`;
      }
      return null;
    });
    if (reason) return `@${width} ${reason}`;
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto('file://' + PAGE, { waitUntil: 'load' });
    const ops = await cardOpacities(page);
    const hidden = ops.filter((o) => o < 0.99).length;
    return hidden ? `JS off: ${hidden} card(s) not fully visible (opacity ${Math.min(...ops)})` : null;
  } finally {
    await context.close();
  }
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

// (d) The 8 filter buttons: clicking each shows exactly the cards of its category (all of them for "all"), marks itself
// active, and the "all" button's label states the card count. Every data-cat value has a button.
async function checkFilters(browser) {
  return withPage(browser, {}, async (page) => {
    const info = await page.evaluate(() => ({
      buttons: [...document.querySelectorAll('.filter-btn')].map((b) => ({ filter: b.dataset.filter, text: b.textContent.trim() })),
      cats: [...document.querySelectorAll('#galleryGrid .g-card')].map((c) => c.dataset.cat),
    }));
    if (info.buttons.length !== FILTER_COUNT) return `${info.buttons.length} filter buttons (want ${FILTER_COUNT})`;
    if (info.cats.length !== CARD_COUNT) return `${info.cats.length} cards (want ${CARD_COUNT})`;
    const orphan = [...new Set(info.cats)].filter((c) => !info.buttons.some((b) => b.filter === c));
    if (orphan.length) return `data-cat without a filter button: ${orphan.join(', ')}`;
    const all = info.buttons.find((b) => b.filter === 'all');
    if (!all) return 'no "all" filter button';
    if (!all.text.includes(String(CARD_COUNT))) return `"all" button reads "${all.text}" (want the count ${CARD_COUNT})`;
    await centre(page, '.filters');
    for (const [i, b] of info.buttons.entries()) {
      await page.locator('.filter-btn').nth(i).click();
      const got = await page.evaluate((i) => ({
        shown: [...document.querySelectorAll('#galleryGrid .g-card')].filter((c) => c.getClientRects().length).map((c) => c.dataset.cat),
        active: document.querySelectorAll('.filter-btn')[i].classList.contains('active'),
        actives: document.querySelectorAll('.filter-btn.active').length,
      }), i);
      const want = b.filter === 'all' ? info.cats.length : info.cats.filter((c) => c === b.filter).length;
      if (got.shown.length !== want) return `"${b.text}" shows ${got.shown.length} cards (want ${want})`;
      if (b.filter !== 'all' && got.shown.some((c) => c !== b.filter)) return `"${b.text}" shows a card from another category`;
      if (!got.active || got.actives !== 1) return `"${b.text}" is not the one active button after a click`;
    }
    return null;
  });
}

// (e) Every local href/src resolves: files exist (relative to index.html), #anchors name an element id. External
// links (http, https, mailto, tel, data) are not followed. Every .g-card links to a distinct, existing local demo.
async function checkLinks(browser) {
  const found = await withPage(browser, {}, (page) => page.evaluate(() => ({
    refs: [...document.querySelectorAll('[href], [src]')].map((el) => el.getAttribute(el.hasAttribute('href') ? 'href' : 'src')),
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

// (h) No text in a gallery card (chrome bar, tag, title, description, badges, location) under 14px, at 390 and 1280.
async function checkType(browser) {
  const bad = [];
  for (const width of [390, 1280]) {
    const small = await withPage(browser, { width }, (page) => page.evaluate(`(() => {
      const name = ${describeEl};
      return ${CARD_TEXT_FN}.filter((el) => parseFloat(getComputedStyle(el).fontSize) < 14)
        .map((el) => name(el) + ' ' + parseFloat(getComputedStyle(el).fontSize) + 'px');
    })()`));
    if (small.length) bad.push(`@${width} ${small.length} text element(s) <14px, e.g. ${[...new Set(small)].slice(0, 2).join(', ')}`);
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
};

/* ---------- runner ---------- */

async function main() {
  const browser = await chromium.launch();
  let failed = 0;
  try {
    console.log('index.html');
    for (const [id, check] of Object.entries(CHECKS)) {
      let reason;
      try {
        reason = await check(browser);
      } catch (e) {
        reason = `error: ${clip(String(e.message || e).split('\n')[0], 100)}`;
      }
      if (reason) failed++;
      console.log(`  ${id.padEnd(9)} ${reason ? 'FAIL ' + reason : 'PASS'}`);
    }
  } finally {
    await browser.close();
  }
  const total = Object.keys(CHECKS).length;
  console.log(`SUMMARY ${total} checks: ${total - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
