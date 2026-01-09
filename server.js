// server.js — CommonJS, usa dotenv para carregar credenciais do .env
require('dotenv').config(); // carregar .env em dev
const express = require('express');
const http = require('http');
const path = require('path');
const ws = require('ws');
const multer = require('multer');
const fs = require('fs');
const https = require('https');

const app = express();
const server = http.createServer(app);
const wss = new ws.Server({ server });

const PORT = process.env.PORT || 5000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g,'_'))
});
const upload = multer({ storage });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// ---------- XIRSYS /ice endpoint (TURN proxy) ----------
const XIRSYS_IDENT = process.env.XIRSYS_IDENT || null;
const XIRSYS_SECRET = process.env.XIRSYS_SECRET || null;
const XIRSYS_CHANNEL = process.env.XIRSYS_CHANNEL || 'MyFirstApp';

let iceCache = { expires: 0, body: null };

app.get('/ice', async (req, res) => {
  // opcional: ?force=1 para forçar renovação
  const force = req.query && (req.query.force === '1' || req.query.force === 'true');
  if (!force && iceCache.expires > Date.now() && iceCache.body) {
    return res.json(iceCache.body);
  }

  if (!XIRSYS_IDENT || !XIRSYS_SECRET) {
    return res.status(500).json({ error: 'XIRSYS_IDENT/XIRSYS_SECRET não configurados no servidor' });
  }

  const payload = JSON.stringify({ format: 'urls' });
  const auth = Buffer.from(`${XIRSYS_IDENT}:${XIRSYS_SECRET}`).toString('base64');
  const pathReq = `/_turn/${encodeURIComponent(XIRSYS_CHANNEL)}`;

  const options = {
    hostname: 'global.xirsys.net',
    path: pathReq,
    method: 'PUT',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 15000
  };

  const request = https.request(options, (xr) => {
    let raw = '';
    xr.setEncoding('utf8');
    xr.on('data', (chunk) => raw += chunk);
    xr.on('end', () => {
      try {
        const parsed = JSON.parse(raw);
        // cache curto: Xirsys fornece credenciais temporárias
        iceCache.body = parsed;
        iceCache.expires = Date.now() + (60 * 1000); // 60s
        console.log('Obtidos iceServers do Xirsys (cache 60s)');
        return res.json(parsed);
      } catch (e) {
        console.error('Resposta Xirsys parse fail', e, raw);
        return res.status(502).json({ error: 'Xirsys parse fail', details: raw });
      }
    });
  });

  request.on('timeout', () => {
    request.destroy();
    console.error('Xirsys request timeout');
    return res.status(504).json({ error: 'Xirsys timeout' });
  });

  request.on('error', (err) => {
    console.error('Xirsys request error', err);
    if (iceCache.body) return res.json(iceCache.body);
    return res.status(502).json({ error: 'Xirsys request error', details: err.message });
  });

  request.write(payload);
  request.end();
});
// ------------------------------------------------------

/* rooms: roomId -> { host: ws|null, peers: Map(id->ws) } */
const rooms = {};

function safeSend(socket, obj) {
  if (!socket || socket.readyState !== ws.OPEN) return;
  try { socket.send(JSON.stringify(obj)); } catch(e) {}
}

wss.on('connection', (socket) => {
  socket.id = Math.random().toString(36).slice(2,9);
  socket.roomId = null;
  socket.isHost = false;

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e){ return; }
    const type = msg.type;

    if (type === 'create') {
      const { roomId } = msg;
      socket.roomId = roomId;
      if (!rooms[roomId]) rooms[roomId] = { host: null, peers: new Map() };
      rooms[roomId].host = socket;
      socket.isHost = true;
      safeSend(socket, { type: 'created', id: socket.id });
      console.log('Room created', roomId, 'host', socket.id);
      return;
    }

    if (type === 'join') {
      const { roomId } = msg;
      socket.roomId = roomId;
      if (!rooms[roomId]) rooms[roomId] = { host: null, peers: new Map() };
      rooms[roomId].peers.set(socket.id, socket);
      socket.isHost = false;
      safeSend(socket, { type: 'joined', id: socket.id });
      const host = rooms[roomId].host;
      if (host && host.readyState === ws.OPEN) safeSend(host, { type: 'new-peer', id: socket.id });
      console.log('Peer joined', socket.id, 'room', roomId);
      return;
    }

    if (['offer','answer','ice'].includes(type)) {
      const { roomId } = msg;
      const room = rooms[roomId];
      if (!room) return;
      msg.from = socket.id;
      if (msg.to) {
        let target = null;
        if (room.peers.has(msg.to)) target = room.peers.get(msg.to);
        else if (room.host && room.host.id === msg.to) target = room.host;
        if (target && target.readyState === ws.OPEN) {
          safeSend(target, msg);
          console.log('Forwarded', type, 'from', socket.id, 'to', msg.to);
        }
        return;
      }
      if (socket.isHost) {
        for (const peer of room.peers.values()) safeSend(peer, msg);
        console.log('Broadcast', type, 'from host', socket.id, 'to peers');
      } else {
        if (room.host && room.host.readyState === ws.OPEN) {
          safeSend(room.host, msg);
          console.log('Forwarded', type, 'from peer', socket.id, 'to host');
        }
      }
      return;
    }

    if (socket.isHost && ['video_url','play','pause','seek','sync','screen-stopped'].includes(type)) {
      const room = rooms[socket.roomId];
      if (!room) return;
      for (const peer of room.peers.values()) safeSend(peer, msg);
      return;
    }

  });

  socket.on('close', () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;
    if (socket.isHost) {
      for (const peer of room.peers.values()) safeSend(peer, { type: 'host-left' });
      delete rooms[roomId];
      console.log('Host left, room removed', roomId);
    } else {
      room.peers.delete(socket.id);
      if (room.host && room.host.readyState === ws.OPEN) safeSend(room.host, { type: 'peer-left', id: socket.id });
      console.log('Peer left', socket.id, 'room', roomId);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('Server listening on port', PORT));