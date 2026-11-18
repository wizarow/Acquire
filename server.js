'use strict';
/*
 * Acquire server. Zero dependencies, Node 18+.
 *   - serves /public
 *   - real-time rooms over Server-Sent Events (SSE) + JSON POSTs
 *
 * Env: PORT (3000), TRUST_PROXY=1 behind a proxy/CDN.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Engine = require('./public/engine.js');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const EMPTY_TTL_MS = 30 * 60 * 1000;
const HOST_GRACE_MS = 45 * 1000;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/* ------------------------------------------------------------------ */
/* Rooms                                                               */
/* ------------------------------------------------------------------ */
const rooms = new Map();      // code -> room
const clients = new Map();    // code -> Set<{res, pid}>
const hostTimers = new Map(); // code -> {claim, handover} timeouts while the host is away
const CLAIM_BROADCAST_MS = 10500; // just after the engine lets others replace an away host

function newCode() {
  for (let i = 0; i < 50; i++) {
    let c = '';
    for (let j = 0; j < 4; j++) c += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function send(res, event, data) {
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}
function broadcast(room) {
  const set = clients.get(room.code);
  if (!set) return;
  for (const c of set) { try { send(c.res, 'snapshot', Engine.snapshot(room, c.pid)); } catch (e) { /* closed */ } }
}
function closeRoom(code) {
  const set = clients.get(code);
  if (set) for (const c of set) { try { send(c.res, 'closed', {}); c.res.end(); } catch (e) { /* ignore */ } }
  clients.delete(code); rooms.delete(code);
  clearHostTimers(code);
}
function clearHostTimers(code) {
  const t = hostTimers.get(code);
  if (t) { clearTimeout(t.claim); clearTimeout(t.handover); hostTimers.delete(code); }
}
// While the host is away: after ~10s others may take over (we push a fresh snapshot so
// the button appears); after 45s the seat is handed over / opened automatically.
function scheduleHostHandover(room) {
  const host = Engine.find(room, room.hostPid);
  if (!host || host.connected) { clearHostTimers(room.code); return; }
  if (hostTimers.has(room.code)) return; // already counting down
  hostTimers.set(room.code, {
    claim: setTimeout(() => { if (rooms.has(room.code)) broadcast(room); }, CLAIM_BROADCAST_MS),
    handover: setTimeout(() => {
      hostTimers.delete(room.code);
      if (rooms.has(room.code) && Engine.promoteHost(room, Date.now())) broadcast(room);
    }, HOST_GRACE_MS)
  });
}
// A player who joined over HTTP but never opened the live stream (tab closed, bad network)
// would look connected forever and could freeze the host seat. Mark them away if no stream shows up.
const GHOST_MS = 15000;
function ghostCheck(code, pid) {
  setTimeout(() => {
    const r = rooms.get(code); if (!r) return;
    const p = Engine.find(r, pid);
    if (!p || !p.connected) return;
    const set = clients.get(code);
    if (set && [...set].some(c => c.pid === pid)) return;
    Engine.setConnected(r, pid, false, Date.now());
    scheduleHostHandover(r); broadcast(r);
  }, GHOST_MS).unref();
}
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyone = room.players.some(p => p.connected);
    if (now - room.updatedAt > ROOM_TTL_MS || (!anyone && now - room.updatedAt > EMPTY_TTL_MS)) closeRoom(room.code);
  }
}, 5 * 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'";

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', ch => { size += ch.length; if (size > 8192) { reject(new Error('too_large')); req.destroy(); } else chunks.push(ch); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}
function clientIp(req) {
  if (TRUST_PROXY) { const f = req.headers['x-forwarded-for']; if (f) return String(f).split(',')[0].trim(); }
  return req.socket.remoteAddress || 'unknown';
}
const buckets = new Map();
function limited(ip, key, max, perMs) {
  const k = ip + '|' + key, now = Date.now();
  let b = buckets.get(k);
  if (!b || now - b.t > perMs) b = { t: now, n: 0 };
  b.n++; buckets.set(k, b);
  return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > 120000) buckets.delete(k); }, 60000).unref();

const validPid = pid => typeof pid === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(pid);
const validCode = c => typeof c === 'string' && /^[A-Z]{4}$/.test(c);

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' || pathname.startsWith('/r/') ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': rel === '/index.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP
    });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = clientIp(req);

  try {
    if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true, app: 'acquire' });
    if (req.method === 'GET' && p === '/api/stats') return json(res, 200, { liveRooms: rooms.size });

    if (req.method === 'POST' && p === '/api/rooms') {
      if (limited(ip, 'create', 12, 60000)) return json(res, 429, { error: 'slow_down' });
      const body = await readBody(req);
      if (!validPid(body.pid)) return json(res, 400, { error: 'bad_pid' });
      const code = newCode();
      if (!code) return json(res, 503, { error: 'busy' });
      rooms.set(code, Engine.createRoom(code, body.pid, Date.now(), typeof body.name === 'string' ? body.name.slice(0, 80) : ''));
      ghostCheck(code, body.pid);
      return json(res, 200, { ok: true, code });
    }

    let m = p.match(/^\/api\/rooms\/([A-Za-z]{4})\/(join|act|events|info)$/);
    if (m) {
      const code = m[1].toUpperCase(), kind = m[2];
      const room = rooms.get(code);

      if (kind === 'info' && req.method === 'GET') {
        if (limited(ip, 'join', 240, 60000)) return json(res, 429, { error: 'slow_down' });
        if (!room) return json(res, 404, { error: 'no_room' });
        const pid = url.searchParams.get('pid');
        return json(res, 200, { ok: true, ...Engine.info(room, validPid(pid) ? pid : null) });
      }

      if (kind === 'events' && req.method === 'GET') {
        const pid = url.searchParams.get('pid');
        if (!room) return json(res, 404, { error: 'no_room' });
        if (!validPid(pid) || !Engine.find(room, pid)) return json(res, 403, { error: 'not_in_room' });
        res.writeHead(200, {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
        });
        res.write('retry: 2000\n\n');
        const client = { res, pid };
        if (!clients.has(code)) clients.set(code, new Set());
        clients.get(code).add(client);
        Engine.setConnected(room, pid, true, Date.now());
        scheduleHostHandover(room);
        broadcast(room);
        const ping = setInterval(() => { try { send(res, 'tick', { t: Date.now() }); } catch (e) { /* closed */ } }, 20000);
        req.on('close', () => {
          clearInterval(ping);
          const set = clients.get(code);
          if (set) { set.delete(client); }
          const r = rooms.get(code);
          if (r) {
            // Only mark offline if this player has no other open stream.
            const stillHere = set && [...set].some(c => c.pid === pid);
            if (!stillHere) { Engine.setConnected(r, pid, false, Date.now()); scheduleHostHandover(r); broadcast(r); }
          }
        });
        return;
      }

      if (req.method === 'POST' && (kind === 'join' || kind === 'act')) {
        if (limited(ip, kind, 240, 60000)) return json(res, 429, { error: 'slow_down' });
        const body = await readBody(req);
        if (!validPid(body.pid)) return json(res, 400, { error: 'bad_pid' });
        if (!room) return json(res, 404, { error: 'no_room' });
        if (kind === 'join') {
          const takeover = typeof body.takeover === 'string' ? body.takeover.slice(0, 40) : '';
          const nm = typeof body.name === 'string' ? body.name.slice(0, 80) : '';
          const r = takeover ? Engine.takeSeat(room, body.pid, takeover, Date.now()) : Engine.addPlayer(room, body.pid, Date.now(), nm);
          if (!r.ok) return json(res, 409, { error: r.error });
          ghostCheck(code, body.pid);
          scheduleHostHandover(room);
          broadcast(room);
          return json(res, 200, { ok: true, code });
        }
        const r = Engine.act(room, body.pid, body.action, Date.now());
        if (!r.ok) return json(res, 400, { error: r.error, by: r.by || undefined });
        for (const fx of r.effects) {
          if (fx.type === 'removed') {
            // Tell the removed player's open streams, then drop them.
            const set = clients.get(room.code);
            if (set) for (const c of [...set]) if (c.pid === fx.pid) { try { send(c.res, 'removed', {}); c.res.end(); } catch (e) { /* closed */ } set.delete(c); }
          }
        }
        scheduleHostHandover(room);
        broadcast(room);
        return json(res, 200, { ok: true });
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
    json(res, 405, { error: 'method_not_allowed' });
  } catch (e) {
    if (!res.headersSent) json(res, e.message === 'too_large' ? 413 : 400, { error: e.message || 'bad_request' });
  }
});

server.listen(PORT, () => console.log('Acquire running on http://localhost:' + PORT));

function shutdown() { process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
