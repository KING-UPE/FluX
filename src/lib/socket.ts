import { io, Socket } from 'socket.io-client';

// Production: env var (Render). Local dev: same hostname.
function getSignalingUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_SIGNALING_URL || '';
  const isEnvLocal = envUrl.includes('localhost') || envUrl.includes('127.0.0.1');

  if (typeof window !== 'undefined') {
    const isWindowLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    
    // If we're on a LAN IP (mobile/other device), but the env says localhost,
    // we MUST use the current hostname to find the signaling server.
    if (!isWindowLocal && isEnvLocal) {
      return `http://${window.location.hostname}:3001`;
    }
    
    // Fallback: Use env if provided and non-local, otherwise use current hostname
    if (envUrl && !isEnvLocal) return envUrl;
    return `http://${window.location.hostname}:3001`;
  }
  
  return envUrl || 'http://localhost:3001';
}

const SIGNALING_SERVER_URL = getSignalingUrl();

// ── Futuristic Name Generator ──────────────────────────────
const PREFIXES = [
  'Neon', 'Quantum', 'Dark', 'Cyber', 'Void', 'Flux',
  'Hyper', 'Zero', 'Apex', 'Onyx', 'Axion', 'Cryo',
  'Nova', 'Stealth', 'Prism', 'Arc', 'Ion', 'Helix'
];
const SUFFIXES = [
  'Vault', 'Pulse', 'Vector', 'Core', 'Link', 'Shell',
  'Node', 'Grid', 'Wire', 'Forge', 'Byte', 'Shard',
  'Drift', 'Cipher', 'Blade', 'Echo', 'Nexus', 'Port'
];

export function getOrCreateDeviceName(): string {
  if (typeof window === 'undefined') return 'Unknown';
  let name = localStorage.getItem('flux-device-name');
  if (!name) {
    const pre = PREFIXES[Math.floor(Math.random() * PREFIXES.length)];
    const suf = SUFFIXES[Math.floor(Math.random() * SUFFIXES.length)];
    name = `${pre} ${suf}`;
    localStorage.setItem('flux-device-name', name);
  }
  return name;
}

function getDeviceType(): string {
  if (typeof navigator === 'undefined') return 'device';
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'phone';
  if (/Android/.test(ua)) return 'phone';
  if (/Macintosh/.test(ua)) return 'laptop';
  if (/Windows/.test(ua)) return 'desktop';
  return 'device';
}

export interface PeerInfo { id: string; name: string; deviceType: string; }
export type ConnectionState = 'waking' | 'connecting' | 'connected' | 'failed';
/** Health of the signaling link *after* the room is up. */
export type SignalState = 'online' | 'reconnecting' | 'offline';

export interface ConnectOptions {
  onUserJoined: (peer: PeerInfo) => void;
  onExistingUsers: (peers: PeerInfo[]) => void;
  onUserLeft: (id: string) => void;
  onStateChange: (state: ConnectionState) => void;
  onSignalChange: (state: SignalState) => void;
  onRoomInfo: (pin: string) => void;
  /** Signaling came back after a drop — every peer id is stale, start over. */
  onReconnected: () => void;
  roomCode?: string | null;
}

class SocketService {
  public socket: Socket | null = null;
  public roomCode: string = "local-lan-room";
  public myDeviceInfo: { name: string; type: string } | null = null;
  private hasConnected = false;

  async wakeServer(onStateChange: (state: ConnectionState) => void): Promise<boolean> {
    // Fast path: local dev
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 1500);
      const r = await fetch(`${SIGNALING_SERVER_URL}/health`, { signal: c.signal });
      clearTimeout(t);
      if (r.ok) { onStateChange('connecting'); return true; }
    } catch {}

    // Slow path: Render cold start
    onStateChange('waking');
    for (let i = 0; i < 30; i++) {
      try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 3500);
        const r = await fetch(`${SIGNALING_SERVER_URL}/health`, { signal: c.signal });
        clearTimeout(t);
        if (r.ok) { onStateChange('connecting'); return true; }
      } catch {}
      await new Promise(r => setTimeout(r, 4000));
    }
    onStateChange('failed');
    return false;
  }

  connect(options: ConnectOptions) {
    const {
      onUserJoined, onExistingUsers, onUserLeft,
      onStateChange, onSignalChange, onRoomInfo, onReconnected,
      roomCode,
    } = options;

    this.myDeviceInfo = {
      name: getOrCreateDeviceName(),
      type: getDeviceType()
    };

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }
    this.hasConnected = false;

    this.socket = io(SIGNALING_SERVER_URL, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 50,
      reconnectionDelay: 1000,
      timeout: 30000,
    });

    this.socket.on('connect', () => {
      console.log('Connected:', this.socket?.id);
      onStateChange('connected');
      onSignalChange('online');

      // A reconnect hands us a brand new socket id, so every peer's view of us
      // (and our WebRTC sessions with them) is dead. Tell the UI to rebuild.
      if (this.hasConnected) onReconnected();
      this.hasConnected = true;

      this.socket?.emit('join_room', {
        deviceName: this.myDeviceInfo?.name,
        deviceType: this.myDeviceInfo?.type,
        roomCode: roomCode || undefined
      });
    });

    this.socket.on('disconnect', (reason: string) => {
      console.log('Signaling disconnected:', reason);
      // An explicit client-side disconnect is expected; anything else is a drop.
      if (reason !== 'io client disconnect') onSignalChange('reconnecting');
    });

    this.socket.io.on('reconnect_failed', () => onSignalChange('offline'));
    this.socket.on('connect_error', () => console.log('Server not reachable...'));
    this.socket.on('existing_users', (peers: PeerInfo[]) => onExistingUsers(peers));
    this.socket.on('user_joined', (peer: PeerInfo) => onUserJoined(peer));
    this.socket.on('user_left', (id: string) => onUserLeft(id));
    this.socket.on('room_info', (data: { pin: string }) => onRoomInfo(data.pin));
  }

  /** Ask the server to re-announce us and resend the peer list. */
  rescan() {
    this.socket?.emit('rescan');
  }

  disconnect() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }
    this.socket = null;
    this.hasConnected = false;
  }
}

export const socketService = new SocketService();
