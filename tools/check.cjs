#!/usr/bin/env node
'use strict';
/*
 * Rule checks for the NoCap dental demos (pass/fail gate for every demo task).
 *
 *   node tools/check.cjs [file.html ...]     (default: every demo in tools/demos.json)
 *
 * One line per file, then one indented line per check: PASS or FAIL <short reason>.
 * Last line is a SUMMARY. Exit code: 0 all pass, 1 any check failed, 2 bad arguments.
 * Output has no timings, so two runs on the same files should print identical text.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const DEMOS = JSON.parse(fs.readFileSync(path.join(__dirname, 'demos.json'), 'utf8'));

const POLISH_MARKER = '/* nocap:polish v1 */';
const BANNED_COPY = /elevate|unlock|seamless|cutting-edge|revolutionize|smile journey/gi;
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const SETTLE_CAP_MS = 3000;

/* ---------- shared page setup ---------- */

// Wait until web fonts and finite animations/transitions have settled, so measurements do not race.
async function settle(page) {
  await page.evaluate(async (cap) => {
    const capped = (p) => Promise.race([p, new Promise((r) => setTimeout(r, cap))]);
    if (document.fonts && document.fonts.ready) await capped(document.fonts.ready);
    const finite = document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().iterations !== Infinity);
    await capped(Promise.all(finite.map((a) => a.finished.catch(() => {}))));
  }, SETTLE_CAP_MS);
  await page.waitForTimeout(100);
}

function isFontLoadFailure(entry) {
  if (entry.type !== 'error' || !/^Failed to load resource/.test(entry.text)) return false;
  try {
    return FONT_HOSTS.includes(new URL(entry.url).hostname);
  } catch (e) {
    return false;
  }
}

// Opens `file` in a fresh context, runs fn(page, errors), always cleans up.
// errors collects console errors and uncaught exceptions: { type: 'error' | 'pageerror', text, url }.
// opts.init: a function run in the page before any of its scripts (page.addInitScript).
async function withPage(browser, file, opts, fn) {
  const { width = 1280, height = 800, js = true, reduced = false, offline = false, init = null } = opts;
  const context = await browser.newContext({
    viewport: { width, height },
    javaScriptEnabled: js,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
  });
  try {
    if (init) await context.addInitScript(init);
    if (offline) {
      await context.route('**/*', (route) =>
        route.request().url().startsWith('file://') ? route.continue() : route.abort());
    }
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push({ type: 'error', text: m.text(), url: m.location().url || '' });
    });
    page.on('pageerror', (e) => errors.push({ type: 'pageerror', text: String(e.message || e).split('\n')[0], url: '' }));
    await page.goto('file://' + file.abs, { waitUntil: 'load' });
    await settle(page);
    return await fn(page, errors);
  } finally {
    await context.close();
  }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Short label for a collected error; remote URLs are kept (they name the failing host), file:// ones are noise.
function describeError(e) {
  const where = e.url && !e.url.startsWith('file://') ? ` [${clip(e.url, 50)}]` : '';
  return `${e.type === 'pageerror' ? 'exception' : 'console'}: ${clip(e.text, 70)}${where}`;
}

// Rendered state of every element matching `selector`, shared by nojs and offline so they agree on "visible":
// effective opacity (product up the ancestor chain, so a faded wrapper hides its heading), computed
// visibility, and whether the element has a non-empty box (false for display:none or zero size).
function renderStates(page, selector) {
  return page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => {
    let opacity = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) opacity *= parseFloat(getComputedStyle(n).opacity);
    const box = el.getBoundingClientRect();
    return {
      text: el.textContent.trim().slice(0, 30),
      opacity: Math.round(opacity * 100) / 100,
      hidden: getComputedStyle(el).visibility === 'hidden',
      empty: !el.getClientRects().length || box.width === 0 || box.height === 0,
    };
  }), selector);
}

/* ---------- checks: each returns null (pass) or a short failure reason ---------- */

async function checkConsole(browser, file) {
  const seen = new Set();
  for (const width of [1280, 390]) {
    await withPage(browser, file, { width }, (page, errors) => {
      for (const e of errors) if (!isFontLoadFailure(e)) seen.add(describeError(e));
    });
  }
  if (!seen.size) return null;
  const [first, ...rest] = [...seen].sort(); // sorted so the reported message does not depend on arrival order
  return first + (rest.length ? ` (+${rest.length} more)` : '');
}

async function checkOverflow(browser, file) {
  const bad = [];
  for (const width of [320, 390, 1280, 1920]) {
    const sw = await withPage(browser, file, { width }, (page) =>
      page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })));
    if (sw.scroll > sw.inner) bad.push(`@${width} scrollWidth ${sw.scroll}>${sw.inner}`);
  }
  return bad.length ? bad.join('; ') : null;
}

// JS off: there is at least one h1, and every h1 and h2 is shown without script: effective opacity >= 0.99, not
// visibility:hidden, and a non-empty box (display:none or a zero-size box fails), as renderStates judges them.
async function checkNoJs(browser, file) {
  const { states, h1s } = await withPage(browser, file, { js: false }, async (page) => ({
    states: await renderStates(page, 'h1,h2'),
    h1s: await page.evaluate(() => document.querySelectorAll('h1').length),
  }));
  if (!h1s) return 'no h1 element';
  const why = (h) => (h.opacity < 0.99 ? `opacity ${h.opacity}` : h.hidden ? 'visibility hidden' : h.empty ? 'no box (display:none or zero size)' : '');
  const hidden = states.filter(why);
  if (!hidden.length) return null;
  return `${hidden.length} heading(s) hidden without JS, e.g. "${hidden[0].text}" ${why(hidden[0])}`;
}

// Under reduced motion: no infinite CSS/Web animation running, and no requestAnimationFrame loop. rAF calls are
// counted for RAF_WINDOW_MS once the page has settled, on screen and with no input; a page that draws one frame (or a
// few) and stops passes, a loop that keeps asking for frames (about 60 a second) fails.
const RAF_WINDOW_MS = 1000;
const RAF_MAX_CALLS = 3;
function countAnimationFrames() {
  const raf = window.requestAnimationFrame;
  window.__ncRaf = 0;
  window.requestAnimationFrame = function (cb) {
    window.__ncRaf++;
    return raf.call(window, cb);
  };
}

async function checkReduced(browser, file) {
  const r = await withPage(browser, file, { reduced: true, init: countAnimationFrames }, async (page) => {
    const running = await page.evaluate(() => document.getAnimations()
      .filter((a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming().iterations === Infinity)
      .map((a) => a.animationName || a.transitionProperty || 'animation'));
    await page.evaluate(() => { window.__ncRaf = 0; });
    await page.waitForTimeout(RAF_WINDOW_MS);
    const frames = await page.evaluate(() => ({ calls: window.__ncRaf, visible: document.visibilityState }));
    return { running, frames };
  });
  if (r.running.length) return `${r.running.length} infinite animation(s) running under reduced motion, e.g. ${[...new Set(r.running)].slice(0, 3).join(', ')}`;
  if (r.frames.visible !== 'visible') return `page is ${r.frames.visible}, cannot count animation frames`;
  if (r.frames.calls > RAF_MAX_CALLS) return `requestAnimationFrame loop under reduced motion: ${r.frames.calls} calls in ${RAF_WINDOW_MS}ms with no input (max ${RAF_MAX_CALLS})`;
  return null;
}

// Body >= 16px, every rendered p >= 14px, p over 80 chars >= 16px. Checked on desktop and phone widths.
// Also any rendered element that directly holds non-empty text must be >= 14px (labels, eyebrows, spans,
// buttons...). Text in script/style/noscript/svg or under aria-hidden="true" is skipped, and so is text
// that is not rendered (display:none anywhere up the chain, visibility:hidden).
async function checkType(browser, file) {
  const bad = [];
  for (const width of [1280, 390]) {
    const r = await withPage(browser, file, { width }, (page) => page.evaluate(() => {
      const size = (el) => parseFloat(getComputedStyle(el).fontSize);
      const ps = [...document.querySelectorAll('p')].filter((p) => p.getClientRects().length && p.innerText.trim());
      const tiny = ps.filter((p) => size(p) < 14);
      const longSmall = ps.filter((p) => p.innerText.trim().length > 80 && size(p) >= 14 && size(p) < 16);
      const smallText = [];
      const seen = new Set();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!el || seen.has(el) || !n.nodeValue.trim()) continue;
        seen.add(el);
        if (el.closest('script, style, noscript, svg, [aria-hidden="true"]')) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
        if (size(el) < 14) {
          const cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
          smallText.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} ${size(el)}px`);
        }
      }
      return {
        body: size(document.body),
        tiny: tiny.length, tinyMin: tiny.length ? Math.min(...tiny.map(size)) : 0,
        longSmall: longSmall.length, longMin: longSmall.length ? Math.min(...longSmall.map(size)) : 0,
        smallText: smallText.length, smallFirst: [...new Set(smallText)].slice(0, 3),
      };
    }));
    if (r.body < 16) bad.push(`@${width} body ${r.body}px`);
    if (r.tiny) bad.push(`@${width} ${r.tiny} p <14px (min ${r.tinyMin}px)`);
    if (r.longSmall) bad.push(`@${width} ${r.longSmall} long p <16px (min ${r.longMin}px)`);
    if (r.smallText) bad.push(`@${width} ${r.smallText} text element(s) <14px: ${r.smallFirst.join(', ')}`);
  }
  return bad.length ? bad.join('; ') : null;
}

// At 390: rendered buttons / btn / cta / sticky-bar links, phone (tel:) and WhatsApp (wa.me) links, and the
// nav logo link (first nav link with class logo/brand) are at least 44x44, compared unrounded (43.6 fails).
// Plain wrappers around a real control (a div.btn-row) and parts inside a control (an icon span in a
// button) are skipped: the control itself is the tap target and is judged on its own.
async function checkTap(browser, file) {
  const small = await withPage(browser, file, { width: 390 }, (page) => page.evaluate(() => {
    const sel = 'button, [class*=btn], [class*=cta], .nc-bar a, a[href^="tel:"], a[href*="wa.me"]';
    const control = 'a[href], button, input, select, textarea, summary, [role=button], [tabindex], [onclick]';
    const targets = [...document.querySelectorAll(sel)]; // each element once, even if several parts match
    const logo = [...document.querySelectorAll('nav a')].find((a) => /logo|brand/i.test(a.getAttribute('class') || ''));
    if (logo && !targets.includes(logo)) {
      targets.push(logo);
      targets.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    }
    const px = (v) => +v.toFixed(1);
    return targets.filter((el) => {
      const isControl = el.matches(control);
      const outer = el.parentElement && el.parentElement.closest(sel);
      if (outer && outer.matches(control)) return false;
      if (!isControl && el.querySelector(control)) return false;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0
        && (r.width < 44 || r.height < 44);
    }).map((el) => {
      const cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
      const r = el.getBoundingClientRect();
      return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} ${px(r.width)}x${px(r.height)}`;
    });
  }));
  if (!small.length) return null;
  return `${small.length} target(s) under 44px: ${small.slice(0, 3).join(', ')}`;
}

// Distinct nav links (by href plus link text, so a repeated mobile menu counts once but several href="#"
// placeholders do not collapse) excluding the logo link and btn/cta links: at most 6.
// A logo is a link with class logo/brand, or the first nav link when it looks like one (href "/", "#" or
// "#top", or it wraps an svg or a logo/brand element). The first link is otherwise a real item and counts.
async function checkNav(browser, file) {
  const count = await withPage(browser, file, {}, (page) => page.evaluate(() => {
    const links = [...document.querySelectorAll('nav a')];
    const cls = (a) => a.getAttribute('class') || '';
    const looksLikeLogo = (a) => /^(\/|#|#top)?$/.test(a.getAttribute('href') || '')
      || !!a.querySelector('svg, [class*=logo], [class*=brand]');
    const items = links.filter((a, i) => !/logo|brand/i.test(cls(a)) && !/btn|cta/i.test(cls(a))
      && !(i === 0 && looksLikeLogo(a)));
    return new Set(items.map((a) => `${a.getAttribute('href') || ''}|${a.textContent.trim().replace(/\s+/g, ' ').toLowerCase()}`)).size;
  }));
  return count <= 6 ? null : `${count} distinct nav links (max 6, logo and CTA excluded)`;
}

async function checkSections(browser, file) {
  const count = await withPage(browser, file, {}, (page) => page.evaluate(() => document.querySelectorAll('h2').length));
  return count <= 7 ? null : `${count} h2 sections (max 7)`;
}

// Visible text, the title, and text kept in attributes (alt, title, aria-label, placeholder on any element; the meta
// description and the Open Graph / Twitter meta tags): no banned words, no emoji. Plain text glyphs are exempt:
// copyright, registered and trademark signs and the rating stars U+2605 / U+2606.
async function checkCopy(browser, file) {
  const text = await withPage(browser, file, {}, (page) => page.evaluate(() => {
    const attrs = [...document.querySelectorAll('[alt], [title], [aria-label], [placeholder]')]
      .flatMap((el) => ['alt', 'title', 'aria-label', 'placeholder'].map((a) => el.getAttribute(a) || ''));
    const meta = [...document.querySelectorAll('meta[name="description"], meta[property^="og:"], meta[name^="og:"], meta[name^="twitter:"], meta[property^="twitter:"]')]
      .map((m) => m.getAttribute('content') || '');
    return [document.title, document.body.innerText, ...attrs, ...meta].join('\n');
  }));
  const problems = [];
  const banned = [...new Set((text.match(BANNED_COPY) || []).map((w) => w.toLowerCase()))];
  if (banned.length) problems.push(`banned: ${banned.join(', ')}`);
  const emoji = [...new Set(text.replace(/[©®™★☆]/g, '').match(/\p{Extended_Pictographic}/gu) || [])];
  if (emoji.length) problems.push(`emoji: ${emoji.slice(0, 5).join(' ')}`);
  return problems.length ? problems.join('; ') : null;
}

async function checkPolish(browser, file) {
  return file.src.includes(POLISH_MARKER) ? null : `missing ${POLISH_MARKER}`;
}

// First two families of the Google Fonts link(s), in order, must equal [heading, body] from demos.json.
// More families after those (for example a mono face) are allowed.
function googleFamilies(src) {
  const families = [];
  for (const m of src.matchAll(/fonts\.googleapis\.com\/css2?\?([^"'\s)>]+)/g)) {
    for (const kv of m[1].replace(/&amp;/g, '&').split('&')) {
      if (!kv.startsWith('family=')) continue;
      for (const f of kv.slice(7).split('|')) families.push(decodeURIComponent(f.split(':')[0].replace(/\+/g, ' ')));
    }
  }
  return families;
}

async function checkFonts(browser, file) {
  const got = googleFamilies(file.src).slice(0, 2);
  const want = file.expected.fonts;
  return got.length === 2 && got[0] === want[0] && got[1] === want[1]
    ? null
    : `got [${got.join(', ') || 'none'}], want [${want.join(', ')}]`;
}

async function checkSignature(browser, file) {
  const values = await withPage(browser, file, {}, (page) =>
    page.evaluate(() => [...document.querySelectorAll('[data-signature]')].map((el) => el.getAttribute('data-signature'))));
  const want = file.expected.signature;
  if (values.length !== 1) return `${values.length} [data-signature] elements (want exactly 1: "${want}")`;
  return values[0] === want ? null : `data-signature "${values[0]}", want "${want}"`;
}

// Press Tab 3 times; each focused element must be :focus-visible with an outline or a box-shadow.
async function checkFocus(browser, file) {
  return withPage(browser, file, {}, async (page) => {
    for (let stop = 1; stop <= 3; stop++) {
      await page.keyboard.press('Tab');
      await settle(page);
      const r = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return { none: true };
        const cs = getComputedStyle(el);
        const cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
        return {
          name: el.tagName.toLowerCase() + (cls ? '.' + cls : ''),
          focusVisible: el.matches(':focus-visible'),
          outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0
            && !/^(transparent|rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\))$/.test(cs.outlineColor),
          shadow: cs.boxShadow !== 'none',
        };
      });
      if (r.none) return `Tab ${stop} reached no focusable element`;
      if (!r.focusVisible) return `Tab ${stop} ${r.name} is not :focus-visible`;
      if (!r.outline && !r.shadow) return `Tab ${stop} ${r.name} has no outline or box-shadow`;
    }
    return null;
  });
}

// Every non-file request aborted (fonts, CDNs): no uncaught errors, no script console errors, and the first
// h1 actually shown (effective opacity >= 0.99, not visibility:hidden, non-empty box).
// Aborted resource loads are expected here and are not counted.
async function checkOffline(browser, file) {
  return withPage(browser, file, { offline: true }, async (page, errors) => {
    const real = errors.filter((e) => e.type === 'pageerror' || !/^Failed to load resource/.test(e.text));
    if (real.length) return describeError(real[0]) + (real.length > 1 ? ` (+${real.length - 1} more)` : '');
    const [h1] = await renderStates(page, 'h1');
    if (!h1) return 'no h1 element';
    if (h1.opacity < 0.99) return `first h1 not visible (opacity ${h1.opacity})`;
    if (h1.hidden) return 'first h1 not visible (visibility hidden)';
    return h1.empty ? 'first h1 not visible (no box)' : null;
  });
}

// At 390: .nc-bar is a rendered fixed bar holding a tel: link and a booking link (book, appointment, WhatsApp).
async function checkBar(browser, file) {
  return withPage(browser, file, { width: 390 }, (page) => page.evaluate(() => {
    const bar = document.querySelector('.nc-bar');
    if (!bar) return 'no .nc-bar element';
    const cs = getComputedStyle(bar);
    if (cs.position !== 'fixed') return `.nc-bar position is ${cs.position}, want fixed`;
    if (!bar.getClientRects().length || cs.visibility === 'hidden') return '.nc-bar is not rendered at 390';
    const hrefs = [...bar.querySelectorAll('a[href]')].map((a) => ({ href: a.getAttribute('href'), text: a.textContent }));
    if (!hrefs.some((a) => /^tel:/i.test(a.href))) return '.nc-bar has no tel: link';
    if (!hrefs.some((a) => !/^tel:/i.test(a.href) && /book|appoint|whatsapp|wa\.me/i.test(a.href + ' ' + a.text))) return '.nc-bar has no booking link';
    return null;
  }));
}

// Only for demos whose signature is webgl-scene (see ONLY_FOR). Opens the page in its own Chromium with the 3D APIs
// switched off (--disable-3d-apis makes getContext('webgl' / 'webgl2') return null; the check confirms that first),
// at 1280 and 390, and 1.5s after load asserts: no uncaught exceptions and no console errors (Google Fonts failures
// excepted, as in console); the first h1 and the primary CTA (first btn/cta-class link or button after that h1)
// shown, judged as in nojs/offline; the static illustration ([data-fallback] inside the signature element) shown and
// at least 120x120px and really drawn (see fallbackInk); and at 390 no horizontal overflow.
const WEBGL_OFF_ARGS = ['--disable-3d-apis', '--disable-gpu'];
const FALLBACK_MIN_SHAPES = 3; // shape elements (path, circle, rect...) with a non-empty bounding box
const FALLBACK_MIN_INK = 0.02; // share of the fallback's pixels that differ clearly from its most common colour

// What the fallback actually draws: the number of shape elements inside it with a non-empty bounding box, and the
// share of the pixels of its screenshot that differ by more than 32 (0-255, in any channel) from the most common colour
// there. An empty <svg data-fallback></svg> has a box from CSS but no shapes and no ink. The PNG is decoded on a canvas
// in a blank page of the same context.
async function fallbackInk(page, sel) {
  const shapes = await page.evaluate((s) => [...document.querySelector(s).querySelectorAll('path, circle, ellipse, rect, line, polyline, polygon, text, use, image')]
    .filter((el) => { try { const b = el.getBBox(); return b.width > 0 || b.height > 0; } catch (e) { return false; } }).length, sel);
  const png = await page.locator(sel).first().screenshot();
  const blank = await page.context().newPage();
  try {
    const ink = await blank.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const counts = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const k = `${d[i] >> 3},${d[i + 1] >> 3},${d[i + 2] >> 3}`;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map((v) => v * 8 + 4);
      let inked = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.max(Math.abs(d[i] - common[0]), Math.abs(d[i + 1] - common[1]), Math.abs(d[i + 2] - common[2])) > 32) inked++;
      }
      return inked / (d.length / 4);
    }, png.toString('base64'));
    return { shapes, ink };
  } finally {
    await blank.close();
  }
}

async function checkWebglOff(browser, file) {
  const off = await chromium.launch({ args: WEBGL_OFF_ARGS });
  const shown = (s) => s.opacity >= 0.99 && !s.hidden && !s.empty;
  try {
    for (const width of [1280, 390]) {
      const reason = await withPage(off, file, { width }, async (page, errors) => {
        await page.waitForTimeout(1500);
        const gl = await page.evaluate(() => {
          const c = document.createElement('canvas');
          return !!(c.getContext('webgl') || c.getContext('experimental-webgl') || c.getContext('webgl2'));
        });
        if (gl) return `WebGL still available with ${WEBGL_OFF_ARGS.join(' ')}`;
        const real = errors.filter((e) => !isFontLoadFailure(e));
        if (real.length) return describeError(real[0]) + (real.length > 1 ? ` (+${real.length - 1} more)` : '');
        const [h1] = await renderStates(page, 'h1');
        if (!h1) return 'no h1 element';
        if (!shown(h1)) return `first h1 not visible (opacity ${h1.opacity}${h1.hidden ? ', hidden' : ''}${h1.empty ? ', no box' : ''})`;
        const hasCta = await page.evaluate(() => {
          const h = document.querySelector('h1');
          const cta = [...document.querySelectorAll('a[class*=btn], a[class*=cta], button[class*=btn], button[class*=cta]')]
            .find((el) => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
          if (cta) cta.setAttribute('data-webgl-off-cta', '');
          return !!cta;
        });
        if (!hasCta) return 'no btn/cta-class link or button after the h1';
        const [cta] = await renderStates(page, '[data-webgl-off-cta]');
        if (!shown(cta)) return `primary CTA "${cta.text}" not visible (opacity ${cta.opacity}${cta.hidden ? ', hidden' : ''}${cta.empty ? ', no box' : ''})`;
        const fbSel = '[data-signature="webgl-scene"] [data-fallback]';
        const [fb] = await renderStates(page, fbSel);
        if (!fb) return `no ${fbSel} illustration`;
        if (!shown(fb)) return `fallback illustration not visible (opacity ${fb.opacity}${fb.hidden ? ', hidden' : ''}${fb.empty ? ', no box' : ''})`;
        const box = await page.evaluate((sel) => {
          const r = document.querySelector(sel).getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height) };
        }, fbSel);
        if (box.w < 120 || box.h < 120) return `fallback illustration only ${box.w}x${box.h}px (want at least 120x120)`;
        const drawn = await fallbackInk(page, fbSel);
        if (drawn.shapes < FALLBACK_MIN_SHAPES) return `fallback illustration has ${drawn.shapes} drawn shape(s) (want at least ${FALLBACK_MIN_SHAPES})`;
        if (drawn.ink < FALLBACK_MIN_INK) return `fallback illustration is nearly blank: ${(drawn.ink * 100).toFixed(1)}% of its pixels drawn (want at least ${FALLBACK_MIN_INK * 100}%)`;
        if (width === 390) {
          const sw = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
          if (sw.scroll > sw.inner) return `scrollWidth ${sw.scroll}>${sw.inner}`;
        }
        return null;
      });
      if (reason) return `@${width} ${reason}`;
    }
    return null;
  } finally {
    await off.close();
  }
}

const CHECKS = {
  console: checkConsole,
  overflow: checkOverflow,
  nojs: checkNoJs,
  reduced: checkReduced,
  type: checkType,
  tap: checkTap,
  nav: checkNav,
  sections: checkSections,
  copy: checkCopy,
  polish: checkPolish,
  fonts: checkFonts,
  signature: checkSignature,
  focus: checkFocus,
  offline: checkOffline,
  bar: checkBar,
  'webgl-off': checkWebglOff,
};

// Checks that run only for some files; every other check runs for every file.
const ONLY_FOR = {
  'webgl-off': (file) => file.expected.signature === 'webgl-scene',
};

/* ---------- runner ---------- */

function resolveTargets(args) {
  const names = args.length ? args : Object.keys(DEMOS);
  return names.map((arg) => {
    const name = path.basename(arg);
    if (!DEMOS[name]) throw new Error(`${arg} is not listed in tools/demos.json`);
    const abs = [path.resolve(arg), path.join(ROOT, name)].find((p) => fs.existsSync(p));
    if (!abs) throw new Error(`${arg} does not exist`);
    return { name, abs, src: fs.readFileSync(abs, 'utf8'), expected: DEMOS[name] };
  });
}

async function main() {
  let files;
  try {
    files = resolveTargets(process.argv.slice(2));
  } catch (e) {
    console.error(`check: ${e.message}`);
    process.exit(2);
  }
  const browser = await chromium.launch();
  const failedBy = {};
  let total = 0;
  let failed = 0;
  try {
    for (const file of files) {
      console.log(file.name);
      for (const [id, check] of Object.entries(CHECKS)) {
        if (ONLY_FOR[id] && !ONLY_FOR[id](file)) continue;
        let reason;
        try {
          reason = await check(browser, file);
        } catch (e) {
          reason = `error: ${clip(String(e.message || e).split('\n')[0], 100)}`;
        }
        total++;
        if (reason) {
          failed++;
          failedBy[id] = (failedBy[id] || 0) + 1;
        }
        console.log(`  ${id.padEnd(9)} ${reason ? 'FAIL ' + reason : 'PASS'}`);
      }
    }
  } finally {
    await browser.close();
  }
  if (failed) console.log(`\nFailed by check: ${Object.entries(failedBy).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`SUMMARY ${files.length} files, ${total} checks: ${total - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
