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

// Global Room Alias Engine
const roomAliases = {}; // Map of lanID -> 5-digit PIN
const pinToRoom = {};   // Map of 5-digit PIN -> lanID

function getAliasForRoom(lanID) {
  if (!roomAliases[lanID]) {
    let pin;
    do {
      pin = Math.floor(10000 + Math.random() * 90000).toString();
    } while (pinToRoom[pin]);
    roomAliases[lanID] = pin;
    pinToRoom[pin] = lanID;
  }
  return roomAliases[lanID];
}

// Reclaim PINs from empty rooms — without this both maps grow forever and the
// 90k-PIN space eventually fills up on a long-running instance.
async function releaseRoomIfEmpty(lanID) {
  if (!lanID || !roomAliases[lanID]) return;
  const remaining = await io.in(lanID).fetchSockets();
  if (remaining.length > 0) return;
  const pin = roomAliases[lanID];
  delete roomAliases[lanID];
  delete pinToRoom[pin];
  console.log(`  Released room ${lanID} [PIN: ${pin}]`);
}

function describePeer(id) {
  return {
    id,
    name: userInfo[id]?.name || 'Unknown',
    deviceType: userInfo[id]?.deviceType || 'device',
  };
}

io.on('connection', (socket) => {
  console.log(`+ ${socket.id}`);

  socket.on('join_room', async ({ deviceName, deviceType, roomCode }) => {
    let lanID;

    if (roomCode && pinToRoom[roomCode]) {
      // Manual PIN override: Force user into the requested room
      lanID = pinToRoom[roomCode];
      console.log(`  Manual PIN Override: ${roomCode} -> ${lanID}`);
    } else {
      // Auto-Discovery Fallback: Generate room from Public IP
      const rawIp = socket.handshake.headers['x-forwarded-for'] || socket.conn.remoteAddress || '';
      const isLocalDev = !socket.handshake.headers['x-forwarded-for'];
      
      let clientIp = rawIp.split(',')[0].trim();
      
      // IPv6 Hotspot / CGNAT Prefix Normalization
      if (clientIp.includes(':')) {
        const parts = clientIp.split(':');
        if (parts.length >= 4) {
           clientIp = parts.slice(0, 4).join(':') + ':*';
        }
      }
      lanID = isLocalDev ? 'local-dev-network' : clientIp;
    }

    // Assign or fetch the unified PIN for this room
    const currentPin = getAliasForRoom(lanID);

    socket.join(lanID);
    userRooms[socket.id] = lanID;
    userInfo[socket.id] = { name: deviceName, deviceType: deviceType || 'device' };
    console.log(`  ${deviceName} [${deviceType}] joined LAN: ${lanID} [PIN: ${currentPin}]`);

    // Report connection config back safely to the UI
    socket.emit('room_info', { pin: currentPin });

    const sockets = await io.in(lanID).fetchSockets();
    const peers = sockets
      .filter(s => s.id !== socket.id)
      .map(s => describePeer(s.id));

    socket.emit('existing_users', peers);
    socket.to(lanID).emit('user_joined', {
      id: socket.id,
      name: deviceName,
      deviceType,
    });
  });

  // Manual re-scan: resend the peer list and re-announce this device, so a
  // device that was missed (or whose P2P link died) can be picked up again.
  socket.on('rescan', async () => {
    const lanID = userRooms[socket.id];
    if (!lanID) return;

    const sockets = await io.in(lanID).fetchSockets();
    socket.emit('existing_users', sockets.filter(s => s.id !== socket.id).map(s => describePeer(s.id)));
    socket.to(lanID).emit('user_joined', describePeer(socket.id));
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

  socket.on('disconnect', async () => {
    const info = userInfo[socket.id];
    console.log(`- ${info?.name || socket.id}`);
    const room = userRooms[socket.id];
    delete userRooms[socket.id];
    delete userInfo[socket.id];
    if (room) {
      socket.to(room).emit('user_left', socket.id);
      await releaseRoomIfEmpty(room);
    }
  });
});

// `--port` wins so local dev can pin 3001 cross-platform (npm scripts cannot
// set env vars portably, and PORT is often already taken by the Next dev server).
// SIGNALING_PORT then PORT keep hosted deployments such as Render working.
function resolvePort() {
  const flagIndex = process.argv.indexOf('--port');
  const fromFlag = flagIndex !== -1 ? Number(process.argv[flagIndex + 1]) : NaN;
  if (Number.isInteger(fromFlag) && fromFlag > 0) return fromFlag;
  return process.env.SIGNALING_PORT || process.env.PORT || 3001;
}

const PORT = resolvePort();
server.listen(PORT, () => console.log(`FLUX Signaling Server on port ${PORT}`));
