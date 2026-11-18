'use strict';
/*
 * One source (src/app.html), two builds:
 *   node build.js
 *   -> public/index.html        online app (needs server.js: real rooms, no preview)
 *   -> dist/acquire-demo.html   the online screens on an in-page room, to try without a server
 *   -> dist/acquire-local.html  one phone, passed around, no server. Engine inlined, no
 *                               <html>/<head>/<body> wrapper, pure ASCII (safe to paste into
 *                               hosts that wrap the page themselves, e.g. a Claude artifact).
 *
 * Source directives, each on its own line:  //#if online | //#if local | //#else | //#endif
 */
const fs = require('fs');
const path = require('path');
const root = __dirname;
const srcFile = path.join(root, 'src', 'app.html');
if (!fs.existsSync(srcFile)) {
  // Deploy hosts may run this without the src folder. public/index.html is already built, so that is fine.
  console.log('src/app.html not found: skipping build, using the existing public/index.html');
  process.exit(0);
}
const src = fs.readFileSync(srcFile, 'utf8');
const engine = fs.readFileSync(path.join(root, 'public', 'engine.js'), 'utf8');

// Targets: online (real server), local (one phone), demo (online screens on an in-page room).
// Conditions: online = online UI (online + demo), live = real network transport, demo, local.
function on(cond, target) {
  if (cond === 'online') return target === 'online' || target === 'demo';
  if (cond === 'live') return target === 'online';
  return cond === target;
}
function pick(text, target) {
  const out = []; let state = 'all';
  text.split('\n').forEach(line => {
    const m = line.match(/^\s*\/\/#(if|else|endif)\s*(\w+)?\s*$/);
    if (!m) { if (state !== 'off') out.push(line); return; }
    if (m[1] === 'if') state = on(m[2], target) ? 'on' : 'off';
    else if (m[1] === 'else') state = state === 'on' ? 'off' : 'on';
    else state = 'all';
  });
  const res = out.join('\n');
  if (/\/\/#(if|else|endif)/.test(res)) throw new Error('unbalanced directive');
  return res;
}

// Text-size control (online and demo only): every plain font-size up to 30px follows --fs.
// Bigger display type and the local build are left alone.
function scaleCss(html) {
  return html.replace(/<style>[\s\S]*?<\/style>/, css => css.replace(/font-size:(\d+(?:\.\d+)?)px/g, (m, n) => (parseFloat(n) <= 30 ? 'font-size:calc(' + n + 'px*var(--fs))' : m)));
}

// Online
const online = scaleCss(pick(src, 'online'));
fs.writeFileSync(path.join(root, 'public', 'index.html'), online);
console.log('Wrote public/index.html (' + Math.round(online.length / 1024) + ' KB)');

// Standalone pages (local, demo): engine inlined, no <html>/<head>/<body>, pure ASCII
function standalone(html) {
  html = html.replace('<script src="/engine.js"></script>', () => '<script>\n' + engine + '\n</script>');
  html = html
    .replace(/<!doctype[^>]*>/i, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(html|head|body)\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*>/gi, '')
    .replace(/<link\b[^>]*rel="icon"[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
  const jsEsc = s => s.replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const htmlEsc = s => s.replace(/[\u{80}-\u{10FFFF}]/gu, c => '&#' + c.codePointAt(0) + ';');
  return html.split(/(<script[\s\S]*?<\/script>)/).map((part, i) => (i % 2 ? jsEsc(part) : htmlEsc(part))).join('');
}
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

const local = standalone(pick(src, 'local'));
fs.writeFileSync(path.join(root, 'dist', 'acquire-local.html'), local);
console.log('Wrote dist/acquire-local.html (' + Math.round(local.length / 1024) + ' KB)');

const demo = standalone(scaleCss(pick(src, 'demo'))).replace('<title>Acquire</title>', '<title>Acquire demo</title>');
fs.writeFileSync(path.join(root, 'dist', 'acquire-demo.html'), demo);
console.log('Wrote dist/acquire-demo.html (' + Math.round(demo.length / 1024) + ' KB)');
