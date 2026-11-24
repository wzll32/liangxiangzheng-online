/**
 * 两相争 · 联机服务（零依赖，支持房间号）
 *
 * 用法：node server.js  →  浏览器开 http://localhost:8080
 *      公网部署时 PORT 由平台注入，监听 0.0.0.0。
 *
 * 分工：房主浏览器是唯一算得清局面的一方；
 *       另一方只发操作（POST /act），收局面快照（SSE /events）。
 *
 * 房间：?room=xxxx 区分不同对局；不传就是默认房。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const DEFAULT_ROOM = 'default';

/** room -> { id, streams:Set, hostId, lastSnapshot, lastSeen } */
const rooms = new Map();

function roomKey(id) {
  return String(id || DEFAULT_ROOM).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || DEFAULT_ROOM;
}

function getRoom(id) {
  const key = roomKey(id);
  let r = rooms.get(key);
  if (!r) {
    r = { id: key, streams: new Set(), hostId: null, lastSnapshot: null, lastSeen: Date.now() };
    rooms.set(key, r);
  }
  r.lastSeen = Date.now();
  return r;
}

function peersOf(r) {
  let hosts = 0, guests = 0;
  for (const s of r.streams) { if (s.role === 'host') hosts++; else guests++; }
  return { hosts: hosts, guests: guests };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function send(res, code, text, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(text);
}

function sse(res, event, data) {
  try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) { /* 已断 */ }
}

function broadcast(r, event, data) {
  for (const s of r.streams) sse(s.res, event, data);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let buf = '';
    req.on('data', function (c) { buf += c; if (buf.length > 8e6) req.destroy(); });
    req.on('end', function () { resolve(buf); });
    req.on('error', reject);
  });
}

function localIPs() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { send(res, 403, 'forbidden'); return; }
  fs.readFile(file, function (err, buf) {
    if (err) { send(res, 404, 'not found: ' + rel); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(buf);
  });
}

const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;
  const roomId = url.searchParams.get('room') || DEFAULT_ROOM;

  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(); return; }

  /* ---------------- SSE：连上就等事件 ---------------- */
  if (p === '/events') {
    const r = getRoom(roomId);
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'guest';
    const sid = url.searchParams.get('sid') || Math.random().toString(36).slice(2, 10);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('retry: 2000\n\n');

    const stream = { res: res, sid: sid, role: role };
    r.streams.add(stream);
    if (role === 'host') r.hostId = sid;

    sse(res, 'hello', { sid: sid, role: role, room: r.id });
    broadcast(r, 'peers', peersOf(r));
    if (role === 'host') broadcast(r, 'host', { sid: sid });
    else broadcast(r, 'guest', { sid: sid, host: r.hostId });
    if (r.lastSnapshot) sse(res, 'snap', r.lastSnapshot);

    const ping = setInterval(function () { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 15000);

    req.on('close', function () {
      clearInterval(ping);
      r.streams.delete(stream);
      if (role === 'host' && r.hostId === sid) r.hostId = null;
      broadcast(r, 'peers', peersOf(r));
      broadcast(r, 'bye', { sid: sid, role: role });
    });
    return;
  }

  /* ---------------- 房主推局面 ---------------- */
  if (p === '/sync' && req.method === 'POST') {
    const r = getRoom(roomId);
    const body = await readBody(req);
    try {
      const data = JSON.parse(body);
      data.room = r.id;
      r.lastSnapshot = data;
      broadcast(r, 'snap', data);
    } catch (e) { /* 忽略坏数据 */ }
    send(res, 200, '{"ok":true}', MIME['.json']);
    return;
  }

  /* ---------------- 客人发操作 ---------------- */
  if (p === '/act' && req.method === 'POST') {
    const r = getRoom(roomId);
    const body = await readBody(req);
    try { const d = JSON.parse(body); d.room = r.id; broadcast(r, 'act', d); } catch (e) { /* 忽略 */ }
    send(res, 200, '{"ok":true}', MIME['.json']);
    return;
  }

  /* ---------------- 房间内互发消息（选势力等） ---------------- */
  if (p === '/say' && req.method === 'POST') {
    const r = getRoom(roomId);
    const body = await readBody(req);
    try { const d = JSON.parse(body); d.room = r.id; broadcast(r, 'say', d); } catch (e) { /* 忽略 */ }
    send(res, 200, '{"ok":true}', MIME['.json']);
    return;
  }

  /* ---------------- 房间状态 ---------------- */
  if (p === '/state') {
    const r = rooms.get(roomKey(roomId)) || null;
    send(res, 200, JSON.stringify({
      ok: true, room: roomId, exists: !!r,
      peers: r ? peersOf(r) : { hosts: 0, guests: 0 }, rooms: rooms.size
    }), MIME['.json']);
    return;
  }

  /* ---------------- 健康检查 ---------------- */
  if (p === '/ping') {
    const r = rooms.get(roomKey(roomId)) || null;
    send(res, 200, JSON.stringify({
      ok: true,
      hosts: r ? peersOf(r).hosts : 0,
      guests: r ? peersOf(r).guests : 0,
      rooms: rooms.size,
      ips: localIPs()
    }), MIME['.json']);
    return;
  }

  /* ---------------- 测试日志（自测用） ---------------- */
  if (p === '/log' && req.method === 'POST') {
    const body = await readBody(req);
    fs.appendFileSync(path.join(ROOT, '_e2e.log'), body + '\n');
    send(res, 200, 'ok');
    return;
  }

  if (req.method === 'GET') { serveStatic(res, p); return; }
  send(res, 404, 'not found');
});

/* 空房间定时清理 */
setInterval(function () {
  const now = Date.now();
  for (const [k, r] of rooms) {
    if (r.streams.size === 0 && now - r.lastSeen > 6 * 3600 * 1000) rooms.delete(k);
  }
}, 30 * 60 * 1000);

server.listen(PORT, '0.0.0.0', function () {
  console.log('两相争 · 联机服务已启动（支持房间号）');
  console.log('  本机：  http://localhost:' + PORT);
  for (const ip of localIPs()) console.log('  手机：  http://' + ip + ':' + PORT);
  console.log('（公网部署后直接用平台给的网址，不再需要同 WiFi）');
});

module.exports = server;
