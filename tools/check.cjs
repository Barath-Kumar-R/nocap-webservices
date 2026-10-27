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
async function withPage(browser, file, opts, fn) {
  const { width = 1280, height = 800, js = true, reduced = false, offline = false } = opts;
  const context = await browser.newContext({
    viewport: { width, height },
    javaScriptEnabled: js,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
  });
  try {
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

// JS off: headings must not depend on script to become visible (effective opacity, see renderStates).
async function checkNoJs(browser, file) {
  const states = await withPage(browser, file, { js: false }, (page) => renderStates(page, 'h1,h2'));
  const hidden = states.filter((h) => h.opacity < 0.99);
  if (!hidden.length) return null;
  return `${hidden.length} heading(s) hidden without JS, e.g. "${hidden[0].text}" opacity ${hidden[0].opacity}`;
}

async function checkReduced(browser, file) {
  const running = await withPage(browser, file, { reduced: true }, (page) =>
    page.evaluate(() => document.getAnimations()
      .filter((a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming().iterations === Infinity)
      .map((a) => a.animationName || a.transitionProperty || 'animation')));
  if (!running.length) return null;
  return `${running.length} infinite animation(s) running under reduced motion, e.g. ${[...new Set(running)].slice(0, 3).join(', ')}`;
}

// Body >= 16px, every rendered p >= 14px, p over 80 chars >= 16px. Checked on desktop and phone widths.
async function checkType(browser, file) {
  const bad = [];
  for (const width of [1280, 390]) {
    const r = await withPage(browser, file, { width }, (page) => page.evaluate(() => {
      const size = (el) => parseFloat(getComputedStyle(el).fontSize);
      const ps = [...document.querySelectorAll('p')].filter((p) => p.getClientRects().length && p.innerText.trim());
      const tiny = ps.filter((p) => size(p) < 14);
      const longSmall = ps.filter((p) => p.innerText.trim().length > 80 && size(p) >= 14 && size(p) < 16);
      return {
        body: size(document.body),
        tiny: tiny.length, tinyMin: tiny.length ? Math.min(...tiny.map(size)) : 0,
        longSmall: longSmall.length, longMin: longSmall.length ? Math.min(...longSmall.map(size)) : 0,
      };
    }));
    if (r.body < 16) bad.push(`@${width} body ${r.body}px`);
    if (r.tiny) bad.push(`@${width} ${r.tiny} p <14px (min ${r.tinyMin}px)`);
    if (r.longSmall) bad.push(`@${width} ${r.longSmall} long p <16px (min ${r.longMin}px)`);
  }
  return bad.length ? bad.join('; ') : null;
}

// At 390: rendered buttons / btn / cta / sticky-bar links are at least 44x44.
// Plain wrappers around a real control (a div.btn-row) and parts inside a control (an icon span in a
// button) are skipped: the control itself is the tap target and is judged on its own.
async function checkTap(browser, file) {
  const small = await withPage(browser, file, { width: 390 }, (page) => page.evaluate(() => {
    const sel = 'button, [class*=btn], [class*=cta], .nc-bar a';
    const control = 'a[href], button, input, select, textarea, summary, [role=button], [tabindex], [onclick]';
    return [...document.querySelectorAll(sel)].filter((el) => {
      const isControl = el.matches(control);
      const outer = el.parentElement && el.parentElement.closest(sel);
      if (outer && outer.matches(control)) return false;
      if (!isControl && el.querySelector(control)) return false;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0
        && (Math.round(r.width) < 44 || Math.round(r.height) < 44);
    }).map((el) => {
      const cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
      const r = el.getBoundingClientRect();
      return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} ${Math.round(r.width)}x${Math.round(r.height)}`;
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

// Visible text and title: no banned words, no emoji. Plain text glyphs are exempt: copyright, registered and
// trademark signs and the rating stars U+2605 / U+2606.
async function checkCopy(browser, file) {
  const text = await withPage(browser, file, {}, (page) => page.evaluate(() => document.title + '\n' + document.body.innerText));
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
