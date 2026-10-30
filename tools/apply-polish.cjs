#!/usr/bin/env node
'use strict';
/*
 * Inline the shared polish block (tools/polish.html) into one demo page.
 *
 *   node tools/apply-polish.cjs <file.html> [--bg=#hex] [--fg=#hex] [--accent=#hex] [--book=#anchor] [--tel=+91...]
 *
 * bg, fg, accent  colours of the mobile call/book bar (defaults: NoCap navy, white, lime).
 * book            where the Book link points (default #contact).
 * tel             phone number for the Call link (default: the first tel: link already in the file).
 *
 * Prints one line: "inserted" or "already applied". Idempotent. Writes the file in place.
 * Exit codes: 0 done, 1 cannot apply (message on stderr, file untouched), 2 bad arguments.
 * Only Node built-ins.
 */
const fs = require('fs');
const path = require('path');

const MARKER = '/* nocap:polish v1 */';
const DEFAULTS = { bg: '#12163B', fg: '#FFFFFF', accent: '#C8FF3D', book: '#contact' };
const FLAGS = ['bg', 'fg', 'accent', 'book', 'tel'];

function fail(code, msg) {
  console.error(`apply-polish: ${msg}`);
  process.exit(code);
}

/* ---------- arguments: --flag=value or --flag value ---------- */

function parseArgs(argv) {
  const opts = {};
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z]+)(?:=([\s\S]*))?$/.exec(argv[i]);
    if (!m) { files.push(argv[i]); continue; }
    if (!FLAGS.includes(m[1])) fail(2, `unknown flag --${m[1]} (use ${FLAGS.map((f) => '--' + f).join(' ')})`);
    const value = m[2] !== undefined ? m[2] : argv[++i];
    if (value === undefined || value === '') fail(2, `--${m[1]} needs a value`);
    opts[m[1]] = value;
  }
  if (files.length !== 1) fail(2, 'usage: node tools/apply-polish.cjs <file.html> [--bg=#hex --fg=#hex --accent=#hex --book=#anchor --tel=+91...]');
  return { file: files[0], opts };
}

/* ---------- colour helpers: pick readable text for the Book button ---------- */

function parseHex(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.replace(/./g, '$&$&');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function luminance(hex) {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Text colour for the accent-filled Book button: the page's own bg or fg when one reads at AA, else black or white.
function onAccent(accent, bg, fg) {
  const pool = [bg, fg, '#FFFFFF', '#000000'];
  return pool.find((c) => contrast(accent, c) >= 4.5) || pool.reduce((best, c) => (contrast(accent, c) > contrast(accent, best) ? c : best));
}

/* ---------- template: split polish.html on its "nc:" comments and fill placeholders ---------- */

function loadTemplate(values) {
  const tpl = fs.readFileSync(path.join(__dirname, 'polish.html'), 'utf8');
  const parts = {};
  for (const m of tpl.matchAll(/<!--\s*nc:(\w+)\s*-->([\s\S]*?)(?=<!--\s*nc:|$)/g)) parts[m[1]] = m[2].trim();
  for (const name of ['css', 'noscript', 'body']) {
    if (!parts[name]) fail(1, `tools/polish.html has no "nc:${name}" part`);
  }
  const fill = (s) => s.replace(/\{\{(\w+)\}\}/g, (all, key) => {
    if (!(key in values)) fail(1, `tools/polish.html uses unknown placeholder ${all}`);
    return values[key];
  });
  return {
    css: fill(parts.css).replace(/^<style>\s*/, '').replace(/\s*<\/style>$/, ''), // goes inside the page's own <style>
    noscript: fill(parts.noscript),
    body: fill(parts.body),
  };
}

/* ---------- main ---------- */

function lastMatch(src, re) {
  let last = null;
  for (const m of src.matchAll(re)) last = m;
  return last;
}

function main() {
  const { file, opts } = parseArgs(process.argv.slice(2));
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) fail(1, `${file} does not exist`);
  const src = fs.readFileSync(abs, 'utf8');

  if (src.includes(MARKER)) { console.log('already applied'); return; }

  const style = lastMatch(src, /<\/style\s*>/gi);
  const body = lastMatch(src, /<\/body\s*>/gi);
  if (!style) fail(1, `${file} has no </style> to insert the polish CSS before`);
  if (!body) fail(1, `${file} has no </body> to insert the polish script before`);
  if (style.index > body.index) fail(1, `${file} has its last </style> after </body>`);

  for (const k of ['bg', 'fg', 'accent']) {
    const v = opts[k] || DEFAULTS[k];
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) fail(2, `--${k} must be a #hex colour, got "${v}"`);
    opts[k] = v;
  }
  const book = opts.book || DEFAULTS.book;
  if (/[\s"'<>]/.test(book)) fail(2, `--book must be a plain anchor or URL, got "${book}"`);

  let tel;
  if (opts.tel) {
    const digits = opts.tel.replace(/^tel:/i, '').replace(/[\s().-]/g, '');
    if (!/^\+?[0-9x]{5,15}$/i.test(digits)) fail(2, `--tel must look like +919876543210, got "${opts.tel}"`);
    tel = 'tel:' + digits;
  } else {
    const found = /href\s*=\s*["'](tel:[^"']+)["']/i.exec(src);
    if (!found) fail(1, `${file} has no tel: link; pass --tel=+91XXXXXXXXXX`);
    tel = found[1];
  }

  const warnings = [];
  if (contrast(opts.bg, opts.fg) < 4.5) warnings.push(`--fg ${opts.fg} on --bg ${opts.bg} is below 4.5:1`);
  if (book.startsWith('#') && !src.includes(`id="${book.slice(1)}"`) && !src.includes(`id='${book.slice(1)}'`)) {
    warnings.push(`no element with id="${book.slice(1)}" for the Book link`);
  }

  const block = loadTemplate({
    BG: opts.bg, FG: opts.fg, ACCENT: opts.accent, ON_ACCENT: onAccent(opts.accent, opts.bg, opts.fg), BOOK: book, TEL: tel,
  });

  // CSS goes inside the last <style>, the noscript rule right after it, the bar and script just before </body>.
  const beforeStyle = src.slice(0, style.index);
  const between = src.slice(style.index + style[0].length, body.index);
  const result = beforeStyle + (/(^|\n)$/.test(beforeStyle) ? '' : '\n') + block.css + '\n'
    + style[0] + '\n' + block.noscript
    + between + (/(^|\n)$/.test(between) ? '' : '\n') + block.body + '\n'
    + src.slice(body.index);

  fs.writeFileSync(abs, result);
  for (const w of warnings) console.error(`apply-polish: warning: ${w}`);
  console.log('inserted');
}

main();
