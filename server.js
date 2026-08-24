const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

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

const server = http.createServer((req, res) => {
  const rawPath = decodeURIComponent(req.url.split('?')[0]);
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
