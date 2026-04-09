import { socketService } from './socket';

export type ChunkData = ArrayBuffer | string;

/**
 * WebRTC connection for direct peer-to-peer file transfer over LAN.
 * No data touches the internet — files fly directly between devices on Wi-Fi.
 */
export class WebRTCConnection {
  public peerConnection: RTCPeerConnection;
  public peerId: string;
  public dataChannel: RTCDataChannel | null = null;
  private iceCandidateQueue: RTCIceCandidateInit[] = [];
  private messageQueue: ChunkData[] = [];
  private onDataCallbacks: ((data: ChunkData) => void)[] = [];
  private onOpenCallback: (() => void) | null;
  private heartbeatInterval: any = null;

  constructor(peerId: string, isInitiator: boolean, onOpen?: () => void) {
    this.peerId = peerId;
    this.onOpenCallback = onOpen || null;

    this.peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        // Relay servers to handle mobile/cellular NAT traversal
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ],
      iceCandidatePoolSize: 10,
    });

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      console.log(`[P2P ${this.peerId.slice(0,6)}] Connection State: ${state}`);
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection.iceConnectionState;
      console.log(`[ICE ${this.peerId.slice(0,6)}] ICE State: ${state}`);
    };

    this.peerConnection.onsignalingstatechange = () => {
      console.log(`[SIG ${this.peerId.slice(0,6)}] Signaling: ${this.peerConnection.signalingState}`);
    };

    (this.peerConnection as any).onicecandidateerror = (e: any) => {
      console.error(`[ICE ${this.peerId.slice(0,6)}] Candidate Error:`, e.errorCode, e.errorText, e.url);
    };

    if (isInitiator) {
      this.dataChannel = this.peerConnection.createDataChannel('flux', {
        ordered: true,
      });
      this.dataChannel.bufferedAmountLowThreshold = 1024 * 1024;
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
        this.dataChannel.bufferedAmountLowThreshold = 1024 * 1024;
        this.setupDataChannel(this.dataChannel);
      };
    }

    this.peerConnection.onicecandidate = (e) => {
      if (e.candidate) {
        // Log candidate type to help debug mobile connectivity
        if (e.candidate.candidate.includes('relay')) {
           console.log(`[ICE ${this.peerId.slice(0,6)}] Found Relay Candidate!`);
        }
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
      this.startHeartbeat();
      this.onOpenCallback?.();
    };

    ch.onmessage = (e) => {
      this.onDataCallbacks.forEach(cb => cb(e.data));
    };

    ch.onclose = () => console.log(`DataChannel closed: ${this.peerId.slice(0,6)}`);
  }

  public onData(cb: (data: ChunkData) => void) {
    this.onDataCallbacks.push(cb);
  }

  public offData(cb: (data: ChunkData) => void) {
    this.onDataCallbacks = this.onDataCallbacks.filter(c => c !== cb);
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

  private flushMessageQueue() {
    while (this.messageQueue.length > 0 && this.dataChannel?.readyState === 'open') {
      try {
        const msg = this.messageQueue.shift()!;
        this.dataChannel.send(msg as any); 
      } catch (e) {
        console.error('Failed to send queued message:', e);
      }
    }
  }

  public send(data: ChunkData) {
    if (this.dataChannel?.readyState === 'open') {
      try {
        this.dataChannel.send(data as any);
      } catch (e) {
        console.error('DataChannel send error:', e);
      }
    } else {
      this.messageQueue.push(data);
    }
  }

  private startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      if (this.dataChannel?.readyState === 'open') {
        this.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } else {
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }
      }
    }, 5000); // 5s heartbeat to keep mobile connections alive
  }

  public get isOpen(): boolean {
    return this.dataChannel?.readyState === 'open';
  }

  public close(reason = 'Manual') {
    console.log(`[P2P ${this.peerId.slice(0,6)}] Finalizing Connection (Reason: ${reason})`);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.dataChannel?.close();
    this.peerConnection.close();
  }
}
