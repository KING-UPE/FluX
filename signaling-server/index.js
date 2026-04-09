const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 120000,
  pingInterval: 25000,
});

const userRooms = {};
const userInfo = {};

io.on('connection', (socket) => {
  console.log(`+ ${socket.id}`);

  socket.on('join_room', async ({ deviceName, deviceType }) => {
    const rawIp = socket.handshake.headers['x-forwarded-for'] || socket.conn.remoteAddress || '';
    const isLocalDev = !socket.handshake.headers['x-forwarded-for'];
    
    let clientIp = rawIp.split(',')[0].trim();
    
    // IPv6 Hotspot / CGNAT Prefix Normalization
    // Mobile hotspots assign distinct IPv6 addresses to each device (no NAT). We match them by their /64 subnet prefix.
    if (clientIp.includes(':')) {
      const parts = clientIp.split(':');
      if (parts.length >= 4) {
         clientIp = parts.slice(0, 4).join(':') + ':*';
      }
    }

    const lanID = isLocalDev ? 'local-dev-network' : clientIp;

    socket.join(lanID);
    userRooms[socket.id] = lanID;
    userInfo[socket.id] = { name: deviceName, deviceType: deviceType || 'device' };
    console.log(`  ${deviceName} [${deviceType}] joined LAN: ${lanID}`);

    const sockets = await io.in(lanID).fetchSockets();
    const peers = sockets
      .filter(s => s.id !== socket.id)
      .map(s => ({
        id: s.id,
        name: userInfo[s.id]?.name || 'Unknown',
        deviceType: userInfo[s.id]?.deviceType || 'device',
      }));

    socket.emit('existing_users', peers);
    socket.to(lanID).emit('user_joined', {
      id: socket.id,
      name: deviceName,
      deviceType,
    });
  });

  // ── WebRTC Signaling Relay (tiny data only) ──────────────
  socket.on('webrtc_offer', ({ offer, to }) => {
    io.to(to).emit('webrtc_offer', { offer, sender: socket.id });
  });

  socket.on('webrtc_answer', ({ answer, to }) => {
    io.to(to).emit('webrtc_answer', { answer, sender: socket.id });
  });

  socket.on('ice_candidate', ({ candidate, to }) => {
    io.to(to).emit('ice_candidate', { candidate, sender: socket.id });
  });

  socket.on('disconnect', () => {
    const info = userInfo[socket.id];
    console.log(`- ${info?.name || socket.id}`);
    const room = userRooms[socket.id];
    if (room) {
      socket.to(room).emit('user_left', socket.id);
      delete userRooms[socket.id];
      delete userInfo[socket.id];
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`FLUX Signaling Server on port ${PORT}`));
