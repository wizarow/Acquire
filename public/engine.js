/*
 * Acquire room engine.
 * Pure state machine for one room. Used by the Node server (real rooms) and
 * inlined into the preview page (simulated rooms), so both behave the same.
 *
 * Flow: lobby (no host) -> someone claims host -> host sets category -> writing
 *       -> reveal (host may hide/show) -> host ends round -> lobby (no host) -> ...
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AcquireEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN_PLAYERS = 2, MAX_PLAYERS = 20, MAX_WORDS = 12, MAX_CHARS = 140, DEFAULT_WORDS = 4;
  var CLAIM_AFTER_MS = 10000; // an away host can be replaced after this long
  var ADJ = ['Quiet', 'Sneaky', 'Cosmic', 'Velvet', 'Rusty', 'Sunny', 'Nimble', 'Mellow', 'Zesty', 'Frosty',
    'Lucky', 'Dusty', 'Breezy', 'Jolly', 'Cheeky', 'Sleepy', 'Brave', 'Wobbly', 'Golden', 'Mighty'];
  var ANI = ['Otter', 'Falcon', 'Panda', 'Koala', 'Lynx', 'Heron', 'Gecko', 'Walrus', 'Badger', 'Ibis',
    'Yak', 'Moth', 'Newt', 'Quokka', 'Raven', 'Tapir', 'Wombat', 'Marmot', 'Dingo', 'Stoat'];

  function rand(n) { return Math.floor(Math.random() * n); }
  function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }
  function shuffle(a) {
    var b = a.slice();
    for (var i = b.length - 1; i > 0; i--) { var j = rand(i + 1); var t = b[i]; b[i] = b[j]; b[j] = t; }
    return b;
  }
  // Strips control and invisible characters, collapses whitespace, caps length.
  function clean(t, max) {
    return String(t == null ? '' : t)
      .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠﻿]/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, max);
  }
  function wordCount(t) { return t ? t.split(' ').length : 0; }
  function cleanCategory(c) {
    if (!c || typeof c !== 'object') return null;
    var label = clean(c.label, 60);
    if (label.length < 2) return null;
    return { label: label, pack: (c.pack === 'pg13' || c.pack === 'nsfw') ? c.pack : 'custom' };
  }
  function find(room, pid) {
    if (!pid) return null;
    for (var i = 0; i < room.players.length; i++) if (room.players[i].pid === pid) return room.players[i];
    return null;
  }
  function uniqueAlias(room) {
    var used = {}; room.players.forEach(function (p) { used[p.alias] = 1; });
    for (var i = 0; i < 40; i++) {
      var a = ADJ[rand(ADJ.length)] + ' ' + ANI[rand(ANI.length)];
      if (!used[a]) return a;
    }
    return 'Guest ' + (room.players.length + 1);
  }
  function err(code, extra) { var e = { ok: false, error: code }; if (extra) for (var k in extra) e[k] = extra[k]; return e; }
  function touch(room, now) { room.updatedAt = now; }

  function createRoom(code, creatorPid, now) {
    var room = {
      code: code, hostPid: null, createdAt: now, updatedAt: now,
      phase: 'lobby', round: 0, revealedAt: 0, hidden: false,
      settings: { words: DEFAULT_WORDS, spicy: false, category: null },
      players: [], order: null
    };
    addPlayer(room, creatorPid, now);
    return room;
  }

  function addPlayer(room, pid, now) {
    var p = find(room, pid);
    if (p) { p.connected = true; p.offAt = 0; touch(room, now); return { ok: true, alias: p.alias, rejoined: true }; }
    if (room.players.length >= MAX_PLAYERS) return err('room_full');
    p = { pid: pid, alias: uniqueAlias(room), connected: true, offAt: 0, joinedAt: now, locked: false, entry: null };
    room.players.push(p);
    touch(room, now);
    return { ok: true, alias: p.alias };
  }

  // A returning player (new tab or device) takes over a codename whose owner is offline.
  function takeSeat(room, newPid, alias, now) {
    if (find(room, newPid)) return addPlayer(room, newPid, now);
    var seat = null;
    room.players.forEach(function (p) { if (p.alias === alias) seat = p; });
    if (!seat) return err('no_seat');
    if (seat.connected) return err('seat_taken');
    if (room.hostPid === seat.pid) room.hostPid = newPid;
    seat.pid = newPid; seat.connected = true; seat.offAt = 0;
    touch(room, now);
    return { ok: true, alias: seat.alias, rejoined: true };
  }

  function setConnected(room, pid, on, now) {
    var p = find(room, pid); if (!p) return false;
    p.connected = !!on; p.offAt = on ? 0 : now; touch(room, now); return true;
  }

  // Called when the host has been away a while. In the lobby the seat simply opens up;
  // mid-round the longest-standing connected player takes over so the round can finish.
  function promoteHost(room, now) {
    var host = find(room, room.hostPid);
    if (!host || host.connected) return false;
    if (room.phase === 'lobby') { room.hostPid = null; touch(room, now); return true; }
    for (var i = 0; i < room.players.length; i++) {
      if (room.players[i].connected && room.players[i].pid !== room.hostPid) { room.hostPid = room.players[i].pid; touch(room, now); return true; }
    }
    return false;
  }

  function claimable(room, pid, now) {
    if (!find(room, pid) || room.hostPid === pid) return false;
    if (!room.hostPid) return true;
    var h = find(room, room.hostPid);
    return !!h && !h.connected && (now - (h.offAt || 0)) >= CLAIM_AFTER_MS;
  }

  function resetRound(room) {
    room.players.forEach(function (p) { p.locked = false; p.entry = null; });
    room.order = null; room.hidden = false;
  }

  function act(room, pid, a, now) {
    var p = find(room, pid);
    if (!p) return err('not_in_room');
    if (!a || typeof a !== 'object') return err('bad_action');
    var isHost = room.hostPid === pid;
    var effects = [];

    switch (a.type) {
      case 'claim': {
        if (isHost) break;
        if (!claimable(room, pid, now)) {
          var h = find(room, room.hostPid);
          return err('host_taken', { by: h ? h.alias : null });
        }
        room.hostPid = pid;
        break;
      }
      case 'release': {
        if (!isHost) return err('host_only');
        if (room.phase !== 'lobby') return err('wrong_phase');
        room.hostPid = null;
        break;
      }
      case 'settings':
      case 'start': {
        if (!isHost) return err('host_only');
        if (room.phase !== 'lobby') return err('wrong_phase');
        var s = a.type === 'start' ? (a.settings || {}) : a;
        if (s.words != null) room.settings.words = clamp(parseInt(s.words, 10) || DEFAULT_WORDS, 1, MAX_WORDS);
        if (s.spicy != null) room.settings.spicy = !!s.spicy;
        if (s.category !== undefined) room.settings.category = cleanCategory(s.category);
        var c = room.settings.category;
        if (c && ((c.pack === 'nsfw' && !room.settings.spicy) || (c.pack === 'pg13' && room.settings.spicy))) room.settings.category = null;
        if (a.type === 'start') {
          if (room.players.length < MIN_PLAYERS) return err('need_players');
          if (!room.settings.category) return err('need_category');
          resetRound(room);
          room.phase = 'writing';
          room.round++;
        }
        break;
      }
      case 'submit': {
        if (room.phase !== 'writing') return err('wrong_phase');
        if (p.locked) return err('already_locked');
        var text = clean(a.text, MAX_CHARS);
        if (!text) return err('empty');
        if (wordCount(text) > room.settings.words) return err('too_long');
        p.entry = text; p.locked = true;
        break;
      }
      case 'reveal': {
        if (!isHost) return err('host_only');
        if (room.phase !== 'writing') return err('wrong_phase');
        var entries = room.players.filter(function (q) { return q.locked; }).map(function (q) { return q.entry; });
        if (!entries.length) return err('nobody_locked');
        room.order = shuffle(entries);
        room.phase = 'revealed';
        room.hidden = false;
        room.revealedAt = now;
        if (room.settings.category) {
          effects.push({
            type: 'played', category: room.settings.category,
            spicy: !!room.settings.spicy, round: room.round, entries: entries.length
          });
        }
        break;
      }
      case 'hide':
      case 'show': {
        if (!isHost) return err('host_only');
        if (room.phase !== 'revealed') return err('wrong_phase');
        room.hidden = a.type === 'hide';
        break;
      }
      case 'end': {
        if (!isHost) return err('host_only');
        if (room.phase !== 'writing' && room.phase !== 'revealed') return err('wrong_phase');
        resetRound(room);
        room.phase = 'lobby';
        room.hostPid = null;
        room.settings.category = null;
        break;
      }
      case 'leave': {
        var wasHost = room.hostPid === pid;
        if (room.phase === 'lobby') {
          room.players = room.players.filter(function (q) { return q.pid !== pid; });
          if (wasHost) room.hostPid = null;
        } else {
          p.connected = false; p.offAt = now;
          if (wasHost) {
            var live = room.players.filter(function (q) { return q.connected && q.pid !== pid; });
            if (live.length) room.hostPid = live[0].pid;
          }
        }
        break;
      }
      default: return err('bad_action');
    }
    touch(room, now);
    return { ok: true, effects: effects };
  }

  // What one player is allowed to see. Entries stay private until the reveal,
  // and again while the host has them hidden.
  function snapshot(room, pid, now) {
    now = now || Date.now();
    var me = find(room, pid), host = find(room, room.hostPid);
    var connected = room.players.filter(function (p) { return p.connected; });
    var lockedCount = room.players.filter(function (p) { return p.locked; }).length;
    var showOrder = room.phase === 'revealed' && !room.hidden && room.order;
    return {
      code: room.code, phase: room.phase, round: room.round, revealedAt: room.revealedAt, hidden: !!room.hidden,
      settings: { words: room.settings.words, spicy: room.settings.spicy, category: room.settings.category },
      limits: { minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS, maxWords: MAX_WORDS },
      host: host ? { alias: host.alias, away: !host.connected } : null,
      claimable: claimable(room, pid, now),
      me: me ? { alias: me.alias, isHost: room.hostPid === pid, locked: me.locked } : null,
      players: room.players.map(function (p) {
        return { alias: p.alias, isHost: p.pid === room.hostPid, locked: p.locked, connected: p.connected, isMe: p.pid === pid };
      }),
      lockedCount: lockedCount, connectedCount: connected.length,
      allLocked: connected.length > 0 && connected.every(function (p) { return p.locked; }),
      orderCount: room.order ? room.order.length : 0,
      order: showOrder ? room.order.slice() : null
    };
  }

  // Public, anonymous facts for the join screen.
  function info(room, pid) {
    var member = !!find(room, pid);
    return {
      phase: room.phase, round: room.round, full: room.players.length >= MAX_PLAYERS, member: member,
      seats: member ? [] : room.players.filter(function (p) { return !p.connected; }).map(function (p) { return { alias: p.alias }; })
    };
  }

  return {
    MIN_PLAYERS: MIN_PLAYERS, MAX_PLAYERS: MAX_PLAYERS, MAX_WORDS: MAX_WORDS, DEFAULT_WORDS: DEFAULT_WORDS,
    createRoom: createRoom, addPlayer: addPlayer, takeSeat: takeSeat, setConnected: setConnected, promoteHost: promoteHost,
    act: act, snapshot: snapshot, info: info, find: find, clean: clean, cleanCategory: cleanCategory, shuffle: shuffle
  };
});
