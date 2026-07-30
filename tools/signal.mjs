#!/usr/bin/env node
/**
 * signal.mjs — the rendezvous for peer-hosted matches.
 *
 * Two browsers cannot find each other without somewhere to swap SDP offers and
 * ICE candidates. That is all this does. It never sees game traffic: once the
 * DataChannels open it is idle, and if it dies mid-match nothing happens.
 *
 *   node tools/signal.mjs                 # listen on 8787
 *   node tools/signal.mjs --port 9000
 *   node tools/signal.mjs --selftest      # run the protocol against itself, print PASS/FAIL
 *
 * A host connects with an empty room and is handed a short code ("K7QF2M"); the
 * player reads it out and friends join with it. Codes avoid vowels and 0/1/I/O so
 * they survive being said over voice chat.
 *
 * WHY NO DEPENDENCIES: the repo has no `ws` installed and this file must not add
 * one, so the RFC 6455 handshake and framing are done by hand below. That is
 * about 120 lines and signalling traffic is a few small JSON messages per join,
 * so nothing here needs to be fast. If `ws` ever lands in package.json this file
 * can shrink, but it will not need to change shape.
 *
 * Protocol (JSON text frames), mirrored by src/net/transport/Signaling.ts:
 *   c->s {t:'hello', room, role:'host'|'guest', name?}
 *   s->c {t:'joined', room, peerId, role, peers:[{peerId,role,name}]}
 *   s->c {t:'peer-join', peer:{peerId,role,name}}
 *   s->c {t:'peer-leave', peerId, reason}
 *   c->s {t:'signal', to?, data}     -> s->c {t:'signal', from, data}
 *   s->c {t:'error', message}
 */

import { createServer } from 'node:http';
import { createHash, randomInt } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const ROOM_ALPHABET = '23456789BCDFGHJKLMNPQRSTVWXYZ';
const MAX_FRAME_BYTES = 1 << 20; // 1 MB — SDP is a few KB; anything bigger is abuse.
const HEARTBEAT_MS = 30_000;

/* ------------------------------------------------------------------ framing */

function frame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

/**
 * Incremental RFC 6455 reader. Handles fragmentation and control frames; rejects
 * unmasked client frames and oversized payloads, as the spec requires.
 */
class FrameReader {
  constructor(onMessage, onClose, onPing) {
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.onPing = onPing;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return true;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (b.length < 4) return true;
        len = b.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (b.length < 10) return true;
        const hi = b.readUInt32BE(2);
        const lo = b.readUInt32BE(6);
        if (hi !== 0) return false;
        len = lo;
        offset = 10;
      }
      if (!masked) return false; // client frames must be masked
      if (len > MAX_FRAME_BYTES) return false;
      if (b.length < offset + 4 + len) return true;
      const mask = b.subarray(offset, offset + 4);
      const payload = Buffer.allocUnsafe(len);
      const start = offset + 4;
      for (let i = 0; i < len; i++) payload[i] = b[start + i] ^ mask[i & 3];
      this.buf = b.subarray(start + len);

      if (opcode === 0x8) {
        this.onClose(payload);
        return true;
      }
      if (opcode === 0x9) {
        this.onPing(payload);
        continue;
      }
      if (opcode === 0xa) continue; // pong

      if (opcode === 0x0) {
        if (this.fragments.length === 0) return false;
        this.fragments.push(payload);
      } else {
        if (this.fragments.length !== 0) return false;
        this.fragOpcode = opcode;
        this.fragments = [payload];
      }
      if (!fin) continue;
      const full = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
      this.fragments = [];
      if (this.fragOpcode === 0x1) this.onMessage(full.toString('utf8'));
      // Binary frames are not part of the signalling protocol; ignore them.
    }
  }
}

/* -------------------------------------------------------------------- rooms */

let peerCounter = 0;

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.peerId = `p${++peerCounter}`;
    this.room = null;
    this.role = null;
    this.name = undefined;
    this.alive = true;
    this.closed = false;
  }

  sendJson(obj) {
    if (this.closed) return;
    try {
      this.socket.write(frame(JSON.stringify(obj)));
    } catch {
      /* socket is going away; the close handler will clean up */
    }
  }

  ping() {
    if (this.closed) return;
    try {
      this.socket.write(frame(Buffer.alloc(0), 0x9));
    } catch {
      /* ignore */
    }
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write(frame(Buffer.alloc(0), 0x8));
    } catch {
      /* ignore */
    }
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
  }
}

class Rooms {
  constructor(log) {
    this.map = new Map();
    this.log = log;
  }

  makeCode() {
    for (let attempt = 0; attempt < 64; attempt++) {
      let code = '';
      for (let i = 0; i < 6; i++) code += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
      if (!this.map.has(code)) return code;
    }
    throw new Error('room code space exhausted');
  }

  join(conn, requestedRoom, role, name) {
    let code = (requestedRoom || '').toUpperCase().trim();
    if (role === 'host') {
      if (!code) code = this.makeCode();
      const existing = this.map.get(code);
      if (existing && [...existing.values()].some((c) => c.role === 'host')) {
        conn.sendJson({ t: 'error', message: `room ${code} already has a host` });
        return null;
      }
    } else {
      if (!code) {
        conn.sendJson({ t: 'error', message: 'a room code is required to join' });
        return null;
      }
      if (!this.map.has(code)) {
        conn.sendJson({ t: 'error', message: `no such room: ${code}` });
        return null;
      }
    }

    let room = this.map.get(code);
    if (!room) {
      room = new Map();
      this.map.set(code, room);
    }

    const peers = [...room.values()].map((c) => ({ peerId: c.peerId, role: c.role, name: c.name }));
    conn.room = code;
    conn.role = role;
    conn.name = name;
    for (const other of room.values()) {
      other.sendJson({ t: 'peer-join', peer: { peerId: conn.peerId, role, name } });
    }
    room.set(conn.peerId, conn);
    conn.sendJson({ t: 'joined', room: code, peerId: conn.peerId, role, peers });
    this.log(`join  ${code} ${conn.peerId} as ${role}${name ? ` (${name})` : ''} — ${room.size} in room`);
    return code;
  }

  route(conn, msg) {
    const room = conn.room ? this.map.get(conn.room) : null;
    if (!room) return;
    const out = { t: 'signal', from: conn.peerId, data: msg.data };
    if (msg.to) {
      const target = room.get(msg.to);
      if (target) target.sendJson(out);
      return;
    }
    for (const other of room.values()) {
      if (other !== conn) other.sendJson(out);
    }
  }

  leave(conn, reason) {
    if (!conn.room) return;
    const room = this.map.get(conn.room);
    if (!room) return;
    room.delete(conn.peerId);
    for (const other of room.values()) {
      other.sendJson({ t: 'peer-leave', peerId: conn.peerId, reason });
    }
    this.log(`leave ${conn.room} ${conn.peerId} (${reason}) — ${room.size} left`);
    if (room.size === 0) {
      this.map.delete(conn.room);
      this.log(`close ${conn.room}`);
    }
  }

  get stats() {
    let peers = 0;
    for (const r of this.map.values()) peers += r.size;
    return { rooms: this.map.size, peers };
  }
}

/* ------------------------------------------------------------------- server */

export function startSignalServer({ port = 8787, host = '0.0.0.0', quiet = false } = {}) {
  const log = quiet ? () => {} : (m) => console.log(`[signal] ${m}`);
  const rooms = new Rooms(log);
  const conns = new Set();

  const http = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...rooms.stats }));
      return;
    }
    res.writeHead(404).end();
  });

  http.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);

    const conn = new Conn(socket);
    conns.add(conn);

    const finish = (reason) => {
      if (!conns.delete(conn)) return;
      rooms.leave(conn, reason);
      conn.destroy();
    };

    const reader = new FrameReader(
      (text) => {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          conn.sendJson({ t: 'error', message: 'malformed json' });
          return;
        }
        if (!msg || typeof msg.t !== 'string') return;
        if (msg.t === 'hello') {
          if (conn.room) {
            conn.sendJson({ t: 'error', message: 'already joined' });
            return;
          }
          const role = msg.role === 'host' ? 'host' : 'guest';
          rooms.join(conn, msg.room, role, typeof msg.name === 'string' ? msg.name : undefined);
          return;
        }
        if (msg.t === 'signal') {
          if (!conn.room) {
            conn.sendJson({ t: 'error', message: 'not in a room' });
            return;
          }
          rooms.route(conn, msg);
          return;
        }
        if (msg.t === 'bye') {
          finish(msg.reason || 'bye');
        }
      },
      () => finish('closed'),
      (payload) => {
        conn.alive = true;
        try {
          socket.write(frame(payload, 0xa));
        } catch {
          /* ignore */
        }
      },
    );

    socket.on('data', (chunk) => {
      conn.alive = true;
      if (reader.push(chunk) === false) finish('protocol error');
    });
    socket.on('error', () => finish('socket error'));
    socket.on('close', () => finish('disconnected'));
  });

  const heartbeat = setInterval(() => {
    for (const conn of [...conns]) {
      if (!conn.alive) {
        rooms.leave(conn, 'heartbeat timeout');
        conns.delete(conn);
        conn.destroy();
        continue;
      }
      conn.alive = false;
      conn.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const ready = new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => {
      const addr = http.address();
      log(`listening on ws://${host}:${addr.port}  (health: http://${host}:${addr.port}/health)`);
      resolve(addr.port);
    });
  });

  return {
    ready,
    get port() {
      const a = http.address();
      return a ? a.port : port;
    },
    stats: () => rooms.stats,
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const c of [...conns]) {
          conns.delete(c);
          c.destroy();
        }
        http.close(() => resolve());
        http.closeAllConnections?.();
      }),
  };
}

/* ----------------------------------------------------------------- selftest */

async function selftest() {
  const server = startSignalServer({ port: 0, host: '127.0.0.1', quiet: true });
  const port = await server.ready;
  const url = `ws://127.0.0.1:${port}`;
  const fails = [];
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
    if (!ok) fails.push(name);
  };

  const open = (u) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(u);
      ws.messages = [];
      ws.onmessage = (e) => ws.messages.push(JSON.parse(e.data));
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error('ws error'));
    });
  const waitFor = async (ws, pred, ms = 3000) => {
    const t0 = Date.now();
    for (;;) {
      const hit = ws.messages.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for message');
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const host = await open(url);
  host.send(JSON.stringify({ t: 'hello', room: '', role: 'host', name: 'hostie' }));
  const joined = await waitFor(host, (m) => m.t === 'joined');
  const room = joined.room;
  check('host receives a room code', /^[23456789BCDFGHJKLMNPQRSTVWXYZ]{6}$/.test(room), room);

  const guest = await open(url);
  guest.send(JSON.stringify({ t: 'hello', room: room.toLowerCase(), role: 'guest', name: 'g1' }));
  const gJoined = await waitFor(guest, (m) => m.t === 'joined');
  check('guest joins by code (case-insensitive)', gJoined.room === room, gJoined.room);
  check(
    'guest sees the host in the roster',
    gJoined.peers.length === 1 && gJoined.peers[0].role === 'host',
    JSON.stringify(gJoined.peers),
  );

  const notified = await waitFor(host, (m) => m.t === 'peer-join');
  check('host is told the guest arrived', notified.peer.peerId === gJoined.peerId);

  // A realistically sized SDP: multi-KB, forcing the 16-bit length path.
  const bigSdp = `v=0\r\n${'a=candidate:filler '.repeat(400)}`;
  host.send(JSON.stringify({ t: 'signal', to: gJoined.peerId, data: { kind: 'offer', sdp: bigSdp } }));
  const offer = await waitFor(guest, (m) => m.t === 'signal' && m.data.kind === 'offer');
  check('offer relayed intact', offer.data.sdp === bigSdp, `${offer.data.sdp.length} bytes`);
  check('offer is attributed to the host', offer.from === joined.peerId);

  guest.send(JSON.stringify({ t: 'signal', to: joined.peerId, data: { kind: 'answer', sdp: 'v=0 answer' } }));
  const answer = await waitFor(host, (m) => m.t === 'signal' && m.data.kind === 'answer');
  check('answer relayed back', answer.data.sdp === 'v=0 answer');

  guest.send(JSON.stringify({ t: 'signal', data: { kind: 'ice', candidate: { candidate: 'x' } } }));
  const ice = await waitFor(host, (m) => m.t === 'signal' && m.data.kind === 'ice');
  check('ice broadcast without an explicit target', ice.data.candidate.candidate === 'x');

  const stranger = await open(url);
  stranger.send(JSON.stringify({ t: 'hello', room: 'ZZZZZZ', role: 'guest' }));
  const err = await waitFor(stranger, (m) => m.t === 'error');
  check('joining a dead room is refused', /no such room/.test(err.message), err.message);
  stranger.close();

  const second = await open(url);
  second.send(JSON.stringify({ t: 'hello', room, role: 'host' }));
  const dupErr = await waitFor(second, (m) => m.t === 'error');
  check('a room cannot have two hosts', /already has a host/.test(dupErr.message), dupErr.message);
  second.close();

  guest.close();
  const left = await waitFor(host, (m) => m.t === 'peer-leave');
  check('host is told the guest left', left.peerId === gJoined.peerId);

  host.close();
  await new Promise((r) => setTimeout(r, 100));
  const s = server.stats();
  check('rooms are reclaimed when empty', s.rooms === 0 && s.peers === 0, JSON.stringify(s));

  await server.close();
  console.log(fails.length === 0 ? '\nALL PASS (11/11)' : `\n${fails.length} FAILED: ${fails.join(', ')}`);
  process.exit(fails.length === 0 ? 0 : 1);
}

/* --------------------------------------------------------------------- main */

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  if (argv.includes('--selftest')) {
    selftest().catch((err) => {
      console.error('FAIL  selftest threw:', err);
      process.exit(1);
    });
  } else {
    const server = startSignalServer({
      port: Number(arg('--port', 8787)),
      host: arg('--host', '0.0.0.0'),
    });
    server.ready.catch((err) => {
      console.error('[signal] could not listen:', err.message);
      process.exit(1);
    });
    const shutdown = () => {
      console.log('\n[signal] shutting down');
      server.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}
