const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { AccessToken } = require('livekit-server-sdk');

const port = Number(process.env.PORT || 3000);
const rootDir = __dirname;
const developmentAssetsDir = path.join(__dirname, 'public');
const rooms = new Map();
const streams = new Map();
const maxViewers = 10;

function send(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}
function broadcast(roomId, sender, message) {
  for (const client of rooms.get(roomId) || []) if (client !== sender) send(client, message);
}
function onlineStreams() { return [...streams.entries()].map(([id, stream]) => ({ id, name: stream.name })); }
function publishOnlineStreams() { for (const client of wss.clients) send(client, { type: 'online-streams', streams: onlineStreams() }); }
function notifyWatchers(roomId) { const clients = rooms.get(roomId); const host = [...(clients || [])].find((client) => client.isHost); if (host) send(host, { type: 'watchers', viewers: [...clients].filter((client) => !client.isHost).map((client) => client.name || 'Usuário') }); }
function endStream(hostId) {
  const stream = streams.get(hostId);
  if (!stream) return;
  for (const client of rooms.get(stream.room) || []) send(client, { type: 'session-expired' });
  rooms.delete(stream.room); streams.delete(hostId); publishOnlineStreams();
}
function removeClient(socket) {
  if (socket.isHost && streams.get(socket.hostId)?.socket === socket) { endStream(socket.hostId); return; }
  for (const [roomId, clients] of rooms) {
    if (!clients.delete(socket)) continue;
    broadcast(roomId, socket, { type: 'peer-left', peerId: socket.id });
    notifyWatchers(roomId);
    if (clients.size === 0) rooms.delete(roomId);
    break;
  }
}

function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
function readJson(req) { return new Promise((resolve, reject) => { let body = ''; req.on('data', (chunk) => { body += chunk; if (body.length > 20_000) reject(new Error('Request too large')); }); req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } }); req.on('error', reject); }); }
async function liveKitToken(req, res) {
  const { hostId, name, clientId, role } = await readJson(req);
  const stream = streams.get(hostId);
  if (!stream) return json(res, 404, { error: 'stream-unavailable' });
  if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) return json(res, 503, { error: 'livekit-not-configured' });
  const identity = role === 'host' ? `host-${hostId}` : `viewer-${clientId}`;
  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity, name: String(name || 'Usuário').slice(0, 36) });
  token.addGrant({ roomJoin: true, room: stream.room, canPublish: role === 'host', canSubscribe: true, canPublishData: true });
  return json(res, 200, { token: await token.toJwt(), url: process.env.LIVEKIT_URL, room: stream.room });
}
async function nativeSession(req, res) {
  const { hostId, name } = await readJson(req);
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(hostId || '') || !String(name || '').trim()) {
    return json(res, 400, { error: 'invalid-session' });
  }
  if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
    return json(res, 503, { error: 'livekit-not-configured' });
  }
  endStream(hostId);
  const room = crypto.randomBytes(18).toString('base64url');
  const displayName = String(name).trim().slice(0, 36);
  streams.set(hostId, { room, name: displayName, native: true });
  rooms.set(room, new Set());
  const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: `host-${hostId}`, name: displayName
  });
  token.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
  publishOnlineStreams();
  return json(res, 200, {
    hostId, room, name: displayName, url: process.env.LIVEKIT_URL, token: await token.toJwt()
  });
}
async function nativeEndSession(req, res) {
  const { hostId } = await readJson(req);
  if (hostId) endStream(hostId);
  return json(res, 200, { ok: true });
}
const server = http.createServer(async (req, res) => {
  const rawPath = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST' && rawPath === '/api/livekit-token') { try { return await liveKitToken(req, res); } catch { return json(res, 400, { error: 'invalid-request' }); } }
  if (req.method === 'POST' && rawPath === '/api/native-session') { try { return await nativeSession(req, res); } catch { return json(res, 400, { error: 'invalid-request' }); } }
  if (req.method === 'POST' && rawPath === '/api/native-end-session') { try { return await nativeEndSession(req, res); } catch { return json(res, 400, { error: 'invalid-request' }); } }
  const requested = rawPath === '/' ? '/index.html' : rawPath;
  if (!['/index.html', '/style.css', '/app.js', '/logo.svg'].includes(requested)) { res.writeHead(404); res.end('Not found'); return; }
  const filePath = path.join(rootDir, requested);
  fs.readFile(filePath, (error, data) => {
    if (!error) return respond(res, filePath, data);
    fs.readFile(path.join(developmentAssetsDir, path.basename(filePath)), (fallbackError, fallbackData) => {
      if (fallbackError) { res.writeHead(404); res.end('Not found'); return; }
      respond(res, filePath, fallbackData);
    });
  });
});
function respond(res, filePath, data) {
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' }); res.end(data);
}

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});
wss.on('connection', (socket) => {
  socket.id = crypto.randomBytes(9).toString('base64url');
  send(socket, { type: 'online-streams', streams: onlineStreams() });
  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'create-session') {
        if (!/^[a-zA-Z0-9_-]{16,80}$/.test(message.hostId || '') || !String(message.name || '').trim()) { send(socket, { type: 'invalid-host' }); return; }
        endStream(message.hostId);
        const room = crypto.randomBytes(18).toString('base64url');
        socket.room = room; socket.isHost = true; socket.hostId = message.hostId;
        const stream = { room, name: String(message.name).trim().slice(0, 36), socket };
        rooms.set(room, new Set([socket])); streams.set(message.hostId, stream);
        send(socket, { type: 'session-created', room }); publishOnlineStreams();
      } else if (message.type === 'end-session' && socket.isHost) {
        endStream(socket.hostId);
      } else if (message.type === 'join' && /^[a-zA-Z0-9_-]{16,80}$/.test(message.hostId || '')) {
        const stream = streams.get(message.hostId);
        if (!stream) { send(socket, { type: 'stream-unavailable' }); return; }
        const clients = rooms.get(stream.room);
        if (clients.size - 1 >= maxViewers) { send(socket, { type: 'room-full' }); socket.close(); return; }
        socket.room = stream.room; socket.name = String(message.name || 'Usuário').trim().slice(0, 36) || 'Usuário'; clients.add(socket);
        const host = [...clients].find((client) => client.isHost);
        send(socket, { type: 'joined', peers: clients.size - 1, hostId: host?.id });
        notifyWatchers(stream.room);
        if (host) send(host, { type: 'peer-joined', peerId: socket.id, viewers: clients.size - 1 });
      } else if (socket.room && rooms.has(socket.room) && ['offer', 'answer', 'ice-candidate'].includes(message.type)) {
        const target = [...(rooms.get(socket.room) || [])].find((client) => client.id === message.to);
        if (target) send(target, { ...message, from: socket.id });
      }
    } catch { /* Ignore invalid WebSocket payloads. */ }
  });
  socket.on('close', () => removeClient(socket));
  socket.on('error', () => removeClient(socket));
});

server.listen(port, '0.0.0.0', () => console.log(`Screen Share listening on ${port}`));
