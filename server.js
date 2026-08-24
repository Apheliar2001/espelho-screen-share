const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const port = Number(process.env.PORT || 3000);
const rootDir = __dirname;
const developmentAssetsDir = path.join(__dirname, 'public');
const rooms = new Map();
let activeSession = null;

function send(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}
function broadcast(roomId, sender, message) {
  for (const client of rooms.get(roomId) || []) if (client !== sender) send(client, message);
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
  for (const client of rooms.get(activeSession) || []) send(client, { type: 'session-expired' });
  rooms.delete(activeSession);
  activeSession = null;
}

const server = http.createServer((req, res) => {
  const rawPath = decodeURIComponent(req.url.split('?')[0]);
  const requested = rawPath === '/' ? '/index.html' : rawPath;
  if (!['/index.html', '/style.css', '/app.js'].includes(requested)) { res.writeHead(404); res.end('Not found'); return; }
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
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' }); res.end(data);
}

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});
wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'create-session') {
        expireActiveSession();
        const room = crypto.randomBytes(18).toString('base64url');
        activeSession = room; socket.room = room; socket.isHost = true;
        rooms.set(room, new Set([socket])); send(socket, { type: 'session-created', room });
      } else if (message.type === 'end-session' && socket.isHost && socket.room === activeSession) {
        expireActiveSession();
      } else if (message.type === 'join' && /^[a-zA-Z0-9_-]{12,64}$/.test(message.room)) {
        if (message.room !== activeSession) { send(socket, { type: 'invalid-session' }); socket.close(); return; }
        const clients = rooms.get(message.room);
        if (clients.size >= 2) { send(socket, { type: 'room-full' }); socket.close(); return; }
        socket.room = message.room; clients.add(socket);
        send(socket, { type: 'joined', peers: clients.size - 1 }); broadcast(socket.room, socket, { type: 'peer-joined' });
      } else if (socket.room === activeSession && ['offer', 'answer', 'ice-candidate'].includes(message.type)) {
        broadcast(socket.room, socket, message);
      }
    } catch { /* Ignore invalid WebSocket payloads. */ }
  });
  socket.on('close', () => removeClient(socket));
  socket.on('error', () => removeClient(socket));
});

server.listen(port, '0.0.0.0', () => console.log(`Screen Share listening on ${port}`));
