const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.PORT || 3000);
const publicDir = __dirname;
const developmentAssetsDir = path.join(__dirname, 'public');
const rooms = new Map();
let activeSession = null;

function send(socket, message) {
  const payload = Buffer.from(JSON.stringify(message));
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  socket.write(Buffer.concat([header, payload]));
}

function broadcast(roomId, sender, message) {
  const clients = rooms.get(roomId);
  if (!clients) return;
  for (const client of clients) if (client !== sender) send(client, message);
}

function removeClient(socket) {
  for (const [roomId, clients] of rooms) {
    if (!clients.delete(socket)) continue;
    broadcast(roomId, socket, { type: 'peer-left' });
    if (clients.size === 0) rooms.delete(roomId);
    break;
  }
}

function expireActiveSession() {
  if (!activeSession) return;
  const clients = rooms.get(activeSession);
  if (clients) {
    for (const client of clients) send(client, { type: 'session-expired' });
    rooms.delete(activeSession);
  }
  activeSession = null;
}

const server = http.createServer((req, res) => {
  const rawPath = decodeURIComponent(req.url.split('?')[0]);
  const requested = rawPath === '/' ? '/index.html' : rawPath;
  if (!['/index.html', '/style.css', '/app.js'].includes(requested)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err && filePath !== path.join(publicDir, 'index.html')) {
      fs.readFile(path.join(developmentAssetsDir, path.basename(filePath)), (fallbackError, fallbackData) => {
        if (fallbackError) { res.writeHead(404); res.end('Not found'); return; }
        const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
        res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' }); res.end(fallbackData);
      });
      return;
    }
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') return socket.destroy();
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  let buffer = Buffer.alloc(0);

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const length = buffer[1] & 127;
      const masked = Boolean(buffer[1] & 128);
      let offset = 2;
      let payloadLength = length;
      if (length === 126) { if (buffer.length < 4) return; payloadLength = buffer.readUInt16BE(2); offset = 4; }
      if (length === 127 || !masked) { socket.destroy(); return; }
      const total = offset + 4 + payloadLength;
      if (buffer.length < total) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = buffer.subarray(offset + 4, total);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(total);
      try {
        const message = JSON.parse(payload.toString());
        if (message.type === 'create-session') {
          expireActiveSession();
          const room = crypto.randomBytes(18).toString('base64url');
          activeSession = room;
          socket.room = room;
          socket.isHost = true;
          rooms.set(room, new Set([socket]));
          send(socket, { type: 'session-created', room });
        } else if (message.type === 'end-session' && socket.isHost && socket.room === activeSession) {
          expireActiveSession();
        } else if (message.type === 'join' && /^[a-zA-Z0-9_-]{12,64}$/.test(message.room)) {
          removeClient(socket);
          socket.room = message.room;
          if (socket.room !== activeSession) { send(socket, { type: 'invalid-session' }); socket.end(); return; }
          if (!rooms.has(socket.room)) rooms.set(socket.room, new Set());
          const clients = rooms.get(socket.room);
          if (clients.size >= 2) { send(socket, { type: 'room-full' }); socket.end(); return; }
          clients.add(socket);
          send(socket, { type: 'joined', peers: clients.size - 1 });
          broadcast(socket.room, socket, { type: 'peer-joined' });
        } else if (socket.room && socket.room === activeSession && ['offer', 'answer', 'ice-candidate'].includes(message.type)) {
          broadcast(socket.room, socket, message);
        }
      } catch { /* Ignora mensagens inválidas. */ }
    }
  });
  socket.on('close', () => removeClient(socket));
  socket.on('error', () => removeClient(socket));
});

server.listen(port, '0.0.0.0', () => console.log(`Screen Share em http://localhost:${port}`));
