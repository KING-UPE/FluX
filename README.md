# FLUX

Peer-to-peer file transfer in the browser. Files move directly between devices over
a WebRTC data channel — nothing is uploaded to a server, and there is no size limit
beyond what the receiving device can store.

- **Auto-discovery** — devices behind the same public IP land in the same room automatically.
- **Join code / QR** — a 5-digit code and QR link connect devices on different networks.
- **Files and folders** — pick them, or drag a whole folder onto a device card; the
  directory structure is preserved.
- **Send to all** — broadcast one selection to every device in the room at once.
- **Saves the best way each browser allows** — straight to disk via the File System
  Access API (Chrome/Edge desktop), otherwise a single ZIP or a direct download.

## Running locally

The app needs two processes: the Next.js front end and the signaling server that
introduces peers to each other.

```bash
npm install && (cd signaling-server && npm install)
```

```bash
npm run dev:all
```

That serves the app on `http://localhost:3000` and signaling on port `3001`.
To run them separately:

```bash
npm run dev
```

```bash
cd signaling-server && node index.js --port 3001
```

### Testing across devices

WebRTC only works in a secure context. `localhost` counts, but a LAN IP such as
`http://192.168.1.5:3000` does not — phones will show an "Insecure Context" warning
and no P2P connection will form. Use an HTTPS tunnel (ngrok, Cloudflare Tunnel) to
test on real devices.

## Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SIGNALING_URL` | web | Signaling server URL. Defaults to the current hostname on port 3001. |
| `NEXT_PUBLIC_METERED_API_KEY` | web | TURN credentials. Without it only STUN is used, so transfers fail across symmetric NATs and most mobile networks. |
| `NEXT_PUBLIC_SITE_URL` | web | Canonical URL used for metadata and Open Graph tags. |
| `SIGNALING_PORT` / `PORT` | signaling | Listening port. `--port` on the command line wins over both. |

## How it works

1. Both devices connect to the signaling server, which groups them by public IP and
   assigns the room a 5-digit PIN.
2. The devices exchange WebRTC offers, answers and ICE candidates through that server.
   Glare (both offering at once) is resolved by rolling back on the peer with the
   lower socket id.
3. Once the data channel opens, the signaling server is out of the loop. The sender
   announces the transfer, the receiver accepts and picks a destination, and the file
   is streamed in 16 KB chunks with backpressure applied via `bufferedAmountLow`.
4. The receiver writes each chunk straight to disk where possible, and otherwise
   buffers into a ZIP or a download.

## Layout

```
src/app/             Next.js routes, metadata, global styles
src/components/      RoomViewer (room + discovery), DeviceCard (per-peer transfers)
src/lib/webrtc.ts    RTCPeerConnection + data channel wrapper
src/lib/socket.ts    Signaling client
src/lib/fileTransfer.ts  Transfer protocol: FileSender / FileReceiver
src/lib/fileUtils.ts     File collection, folder traversal, path sanitizing
signaling-server/    Standalone socket.io service (deployed separately)
```

## Licence

MIT — see [LICENSE](LICENSE).
