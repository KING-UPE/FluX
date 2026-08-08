import { socketService } from './socket';

export type ChunkData = ArrayBuffer | string;

/**
 * Resume sending once the outgoing buffer has drained to this level.
 * Must stay well below the sender's high-water mark, otherwise
 * `bufferedamountlow` never fires and transfers stall.
 */
export const DC_LOW_WATER = 256 * 1024;

// ── Cached ICE servers (fetched once, reused for all connections) ──
let cachedIceServers: RTCIceServer[] | null = null;

/**
 * Fetch TURN server credentials from Metered.ca free API.
 * Call this once at app startup — results are cached globally.
 */
export async function fetchTurnServers(): Promise<RTCIceServer[]> {
  if (cachedIceServers) return cachedIceServers;

  const fallback: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  const apiKey = process.env.NEXT_PUBLIC_METERED_API_KEY;
  if (!apiKey) {
    console.warn('[TURN] No NEXT_PUBLIC_METERED_API_KEY set — using STUN only (P2P will fail across NATs)');
    cachedIceServers = fallback;
    return fallback;
  }

  try {
    const resp = await fetch(
      `https://flux.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const servers: RTCIceServer[] = await resp.json();
    console.log(`[TURN] Fetched ${servers.length} ICE servers from Metered.ca`);
    cachedIceServers = [...fallback, ...servers];
    return cachedIceServers;
  } catch (e) {
    console.error('[TURN] Failed to fetch TURN credentials, falling back to STUN:', e);
    cachedIceServers = fallback;
    return fallback;
  }
}

/**
 * WebRTC connection for direct peer-to-peer file transfer.
 * Uses TURN relay when direct P2P fails (mobile, cellular, symmetric NAT).
 */
export class WebRTCConnection {
  public peerConnection: RTCPeerConnection;
  public peerId: string;
  public dataChannel: RTCDataChannel | null = null;
  private iceCandidateQueue: RTCIceCandidateInit[] = [];
  private messageQueue: ChunkData[] = [];
  private onDataCallbacks: ((data: ChunkData) => void)[] = [];
  private onCloseCallbacks: (() => void)[] = [];
  private onOpenCallback: (() => void) | null;
  private closed = false;

  constructor(peerId: string, isInitiator: boolean, iceServers: RTCIceServer[], onOpen?: () => void) {
    this.peerId = peerId;
    this.onOpenCallback = onOpen || null;

    this.peerConnection = new RTCPeerConnection({
      iceServers,
      iceCandidatePoolSize: 10,
    });

    // addEventListener (not onconnectionstatechange) so callers can attach their
    // own handler without silently detaching this one.
    this.peerConnection.addEventListener('connectionstatechange', () => {
      const state = this.peerConnection.connectionState;
      console.log(`[P2P ${this.peerId.slice(0,6)}] Connection State: ${state}`);
      // 'disconnected' is often transient and recovers, so it is not fatal here.
      if (state === 'failed' || state === 'closed') this.notifyClosed();
    });

    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection.iceConnectionState;
      console.log(`[ICE ${this.peerId.slice(0,6)}] ICE State: ${state}`);
    };

    this.peerConnection.onsignalingstatechange = () => {
      console.log(`[SIG ${this.peerId.slice(0,6)}] Signaling: ${this.peerConnection.signalingState}`);
    };

    this.peerConnection.onicecandidateerror = (e: RTCPeerConnectionIceErrorEvent) => {
      // Error 701 = STUN host lookup received error (often just no internet).
      // We silence this to keep logs clean for LAN-only mode.
      if (e.errorCode === 701) {
        console.warn(`[ICE ${this.peerId.slice(0,6)}] STUN lookup failed (offline/LAN-only mode)`);
      } else {
        console.error(`[ICE ${this.peerId.slice(0,6)}] Candidate Error:`, e.errorCode, e.errorText, e.url);
      }
    };

    if (isInitiator) {
      this.dataChannel = this.peerConnection.createDataChannel('flux', {
        ordered: true,
      });
      this.dataChannel.bufferedAmountLowThreshold = DC_LOW_WATER;
      this.setupDataChannel(this.dataChannel);

      this.peerConnection.createOffer().then(offer => {
        return this.peerConnection.setLocalDescription(offer);
      }).then(() => {
        socketService.socket?.emit('webrtc_offer', {
          offer: this.peerConnection.localDescription,
          to: this.peerId,
        });
      });
    } else {
      this.peerConnection.ondatachannel = (e) => {
        this.dataChannel = e.channel;
        this.dataChannel.bufferedAmountLowThreshold = DC_LOW_WATER;
        this.setupDataChannel(this.dataChannel);
      };
    }

    this.peerConnection.onicecandidate = (e) => {
      if (e.candidate) {
        socketService.socket?.emit('ice_candidate', {
          candidate: e.candidate,
          to: this.peerId,
        });
      }
    };
  }

  private setupDataChannel(ch: RTCDataChannel) {
    ch.binaryType = 'arraybuffer';

    ch.onopen = () => {
      console.log(`✓ DataChannel OPEN with ${this.peerId.slice(0,6)}`);
      this.flushMessageQueue();
      this.onOpenCallback?.();
    };

    ch.onmessage = (e) => {
      // A throwing listener must not stop the others from seeing the chunk.
      this.onDataCallbacks.slice().forEach(cb => {
        try { cb(e.data); } catch (err) { console.error('DataChannel listener error:', err); }
      });
    };

    ch.onclose = () => {
      console.log(`DataChannel closed: ${this.peerId.slice(0,6)}`);
      this.notifyClosed();
    };

    ch.onerror = (e) => {
      // A local close() also fires onerror with an abort — that is not a fault.
      const err = (e as RTCErrorEvent).error;
      if (err?.name === 'OperationError' || ch.readyState === 'closing' || ch.readyState === 'closed') {
        console.log(`DataChannel with ${this.peerId.slice(0,6)} shut down: ${err?.message ?? 'closed'}`);
      } else {
        console.error(`DataChannel error with ${this.peerId.slice(0,6)}:`, e);
      }
      this.notifyClosed();
    };
  }

  public onData(cb: (data: ChunkData) => void) {
    this.onDataCallbacks.push(cb);
  }

  public offData(cb: (data: ChunkData) => void) {
    this.onDataCallbacks = this.onDataCallbacks.filter(c => c !== cb);
  }

  /** Fires once when this connection can no longer carry data, so in-flight
   *  transfers can fail loudly instead of hanging at a frozen percentage. */
  public onClose(cb: () => void) {
    if (this.closed) { cb(); return; }
    this.onCloseCallbacks.push(cb);
  }

  public offClose(cb: () => void) {
    this.onCloseCallbacks = this.onCloseCallbacks.filter(c => c !== cb);
  }

  private notifyClosed() {
    if (this.closed) return;
    this.closed = true;
    const callbacks = this.onCloseCallbacks.slice();
    this.onCloseCallbacks = [];
    callbacks.forEach(cb => {
      try { cb(); } catch (err) { console.error('Close listener error:', err); }
    });
  }

  public async handleOffer(offer: RTCSessionDescriptionInit) {
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    this.flushIceQueue();
    socketService.socket?.emit('webrtc_answer', {
      answer: this.peerConnection.localDescription,
      to: this.peerId,
    });
  }

  public async handleAnswer(answer: RTCSessionDescriptionInit) {
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    this.flushIceQueue();
  }

  public async handleIceCandidate(candidate: RTCIceCandidateInit) {
    if (!this.peerConnection.remoteDescription) {
      this.iceCandidateQueue.push(candidate);
      return;
    }
    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('ICE error:', e);
    }
  }

  private async flushIceQueue() {
    while (this.iceCandidateQueue.length > 0) {
      const c = this.iceCandidateQueue.shift()!;
      try { await this.peerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
  }

  /** send() is overloaded per payload type, so the union needs narrowing. */
  private rawSend(channel: RTCDataChannel, data: ChunkData) {
    if (typeof data === 'string') channel.send(data);
    else channel.send(data);
  }

  private flushMessageQueue() {
    while (this.messageQueue.length > 0 && this.dataChannel?.readyState === 'open') {
      try {
        const msg = this.messageQueue.shift()!;
        this.rawSend(this.dataChannel, msg);
      } catch (e) {
        console.error('Failed to send queued message:', e);
      }
    }
  }

  public send(data: ChunkData) {
    if (this.dataChannel?.readyState === 'open') {
      try {
        this.rawSend(this.dataChannel, data);
      } catch (e) {
        console.error('DataChannel send error:', e);
      }
    } else {
      this.messageQueue.push(data);
    }
  }

  public get isOpen(): boolean {
    return this.dataChannel?.readyState === 'open';
  }

  public close(reason = 'Manual') {
    console.log(`[P2P ${this.peerId.slice(0,6)}] Finalizing Connection (Reason: ${reason})`);
    this.notifyClosed();
    try { this.dataChannel?.close(); } catch {}
    try { this.peerConnection.close(); } catch {}
  }
}
