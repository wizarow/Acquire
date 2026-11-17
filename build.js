'use strict';
/*
 * One source (src/app.html), two builds:
 *   node build.js
 *   -> public/index.html        online app (needs server.js: real rooms, no preview)
 *   -> dist/acquire-local.html  one phone, passed around, no server. Engine inlined, no
 *                               <html>/<head>/<body> wrapper, pure ASCII (safe to paste into
 *                               hosts that wrap the page themselves, e.g. a Claude artifact).
 *
 * Source directives, each on its own line:  //#if online | //#if local | //#else | //#endif
 */
const fs = require('fs');
const path = require('path');
const root = __dirname;
const src = fs.readFileSync(path.join(root, 'src', 'app.html'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'public', 'engine.js'), 'utf8');

function pick(text, target) {
  const out = []; let state = 'all';
  text.split('\n').forEach(line => {
    const m = line.match(/^\s*\/\/#(if|else|endif)\s*(\w+)?\s*$/);
    if (!m) { if (state !== 'off') out.push(line); return; }
    if (m[1] === 'if') state = m[2] === target ? 'on' : 'off';
    else if (m[1] === 'else') state = state === 'on' ? 'off' : 'on';
    else state = 'all';
  });
  const res = out.join('\n');
  if (/\/\/#(if|else|endif)/.test(res)) throw new Error('unbalanced directive');
  return res;
}

// Online
const online = pick(src, 'online');
fs.writeFileSync(path.join(root, 'public', 'index.html'), online);
console.log('Wrote public/index.html (' + Math.round(online.length / 1024) + ' KB)');

// Local
let html = pick(src, 'local');
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
html = html.split(/(<script[\s\S]*?<\/script>)/).map((part, i) => (i % 2 ? jsEsc(part) : htmlEsc(part))).join('');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'acquire-local.html'), html);
console.log('Wrote dist/acquire-local.html (' + Math.round(html.length / 1024) + ' KB)');
