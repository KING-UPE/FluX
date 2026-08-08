"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";
import DeviceCard, { BroadcastRequest } from "./DeviceCard";
import ConnectionLoader from "./ConnectionLoader";
import { socketService, PeerInfo, ConnectionState, SignalState } from "@/lib/socket";
import { WebRTCConnection, fetchTurnServers } from "@/lib/webrtc";
import { useAppTheme, ThemeColors, defaultTheme } from "@/lib/themeContext";
import { toFluxFiles, supportsDirectoryInput } from "@/lib/fileUtils";

interface PeerData {
  id: string;
  name: string;
  deviceType: string;
  rtcState: 'connecting' | 'connected' | 'failed';
  rtc?: WebRTCConnection;
  activeStatus?: string;
}

export default function RoomViewer() {
  const [mounted, setMounted] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('waking');
  const [signalState, setSignalState] = useState<SignalState>('online');
  const [peers, setPeers] = useState<Record<string, PeerData>>({});
  const [broadcast, setBroadcast] = useState<BroadcastRequest | null>(null);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const [isRescanning, setIsRescanning] = useState(false);
  const { setTheme } = useAppTheme();

  const rtcMapRef = useRef<Record<string, WebRTCConnection>>({});
  const iceServersRef = useRef<RTCIceServer[]>([{ urls: 'stun:stun.l.google.com:19302' }]);
  const globalFileInputRef = useRef<HTMLInputElement>(null);
  const globalFolderInputRef = useRef<HTMLInputElement>(null);
  const bootstrappedRef = useRef(false);

  const updatePeer = useCallback((id: string, update: Partial<PeerData>) => {
    setPeers(prev => {
      const current = prev[id];
      if (!current) return prev;

      const hasChange = (Object.keys(update) as Array<keyof PeerData>).some(key => {
        if (key === 'activeStatus') {
          // 'idle', null and undefined all mean the same thing here.
          return (current.activeStatus || 'idle') !== (update.activeStatus || 'idle');
        }
        return current[key] !== update[key];
      });

      if (!hasChange) return prev;
      return { ...prev, [id]: { ...current, ...update } };
    });
  }, []);

  const createRTC = useCallback((peerId: string, isInitiator: boolean, reason?: string): WebRTCConnection => {
    if (rtcMapRef.current[peerId]) {
      rtcMapRef.current[peerId].close(reason || 'Re-init');
    }

    const rtc = new WebRTCConnection(peerId, isInitiator, iceServersRef.current, () => {
      console.log(`✓ P2P ready with ${peerId.slice(0,6)}`);
      updatePeer(peerId, { rtcState: 'connected', rtc });
    });

    // addEventListener, not onconnectionstatechange: the constructor already
    // registered a handler there and assigning would silently replace it.
    rtc.peerConnection.addEventListener('connectionstatechange', () => {
      const state = rtc.peerConnection.connectionState;
      if (state === 'connected') updatePeer(peerId, { rtcState: 'connected' });
      if (state === 'failed' || state === 'disconnected') updatePeer(peerId, { rtcState: 'failed' });
    });

    rtcMapRef.current[peerId] = rtc;
    return rtc;
  }, [updatePeer]);

  const retryPeerConnection = useCallback((peerId: string) => {
    updatePeer(peerId, { rtcState: 'connecting', rtc: undefined });
    const rtc = createRTC(peerId, true, 'Manual retry');
    updatePeer(peerId, { rtc });
  }, [createRTC, updatePeer]);

  const resetAllConnections = useCallback(() => {
    Object.values(rtcMapRef.current).forEach(r => r.close('Signaling reconnected'));
    rtcMapRef.current = {};
    setPeers({});
  }, []);

  const [roomPin, setRoomPin] = useState<string>('');
  const [manualPinInput, setManualPinInput] = useState<string[]>(Array(5).fill(''));
  const pinInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const handlePinChange = useCallback((index: number, val: string) => {
    const digits = val.replace(/\D/g, '');
    if (!digits) {
      setManualPinInput(prev => {
        const next = [...prev];
        next[index] = '';
        return next;
      });
      return;
    }

    // Typing one digit advances; pasting/autofilling several fills the rest.
    setManualPinInput(prev => {
      const next = [...prev];
      for (let i = 0; i < digits.length && index + i < 5; i++) {
        next[index + i] = digits[i];
      }
      return next;
    });
    const focusAt = Math.min(index + digits.length, 4);
    pinInputRefs.current[focusAt]?.focus();
  }, []);

  const handlePinKeyDown = useCallback((index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !manualPinInput[index] && index > 0) {
      pinInputRefs.current[index - 1]?.focus();
    }
    if (e.key === 'ArrowLeft' && index > 0) pinInputRefs.current[index - 1]?.focus();
    if (e.key === 'ArrowRight' && index < 4) pinInputRefs.current[index + 1]?.focus();
  }, [manualPinInput]);

  const handlePinPaste = useCallback((index: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    const digits = e.clipboardData.getData('text').replace(/\D/g, '');
    if (!digits) return;
    e.preventDefault();
    handlePinChange(index, digits);
  }, [handlePinChange]);

  const startConnection = useCallback(async (overridePin?: string) => {
    setConnectionState('waking');

    const isAwake = await socketService.wakeServer(setConnectionState);
    if (!isAwake) return;

    // Check URL parameters for seamless QR joining
    let targetRoom = overridePin;
    if (!targetRoom && typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      targetRoom = urlParams.get('room') || undefined;
    }

    socketService.connect({
      onUserJoined: (peer: PeerInfo) => {
        setPeers(prev => ({
          ...prev,
          [peer.id]: {
            ...(prev[peer.id] || {}),
            id: peer.id, name: peer.name, deviceType: peer.deviceType,
            rtcState: prev[peer.id]?.rtcState || 'connecting',
          }
        }));
        // A re-announce (rescan) repeats user_joined for peers we already have a
        // live link to — tearing that down would interrupt an active transfer.
        const existing = rtcMapRef.current[peer.id];
        if (existing?.isOpen) return;
        const rtc = createRTC(peer.id, true, 'New User Joined');
        updatePeer(peer.id, { rtc });
      },
      onExistingUsers: (existingPeers: PeerInfo[]) => {
        setPeers(prev => {
          const next = { ...prev };
          existingPeers.forEach(p => {
            next[p.id] = {
              ...(next[p.id] || {}),
              id: p.id, name: p.name, deviceType: p.deviceType,
              rtcState: next[p.id]?.rtcState || 'connecting',
            };
          });
          return next;
        });
      },
      onUserLeft: (leftId: string) => {
        rtcMapRef.current[leftId]?.close('Peer left');
        delete rtcMapRef.current[leftId];
        setPeers(prev => {
          const next = { ...prev };
          delete next[leftId];
          return next;
        });
      },
      onStateChange: setConnectionState,
      onSignalChange: setSignalState,
      onReconnected: resetAllConnections,
      onRoomInfo: (pin: string) => {
        setRoomPin(pin);
        if (typeof window !== 'undefined' && targetRoom) {
          const url = new URL(window.location.href);
          url.searchParams.set('room', pin);
          window.history.replaceState({}, '', url.toString());
        }
      },
      roomCode: targetRoom,
    });

    // Signaling listeners are now handled in a dedicated useEffect for proper cleanup.
  }, [createRTC, updatePeer, resetAllConnections]);

  useEffect(() => {
    const socket = socketService.socket;
    if (!socket) return;

    const handleOffer = async ({ offer, sender }: { offer: RTCSessionDescriptionInit, sender: string }) => {
      // Handle Glare: If we both sent an offer, the one with the "smaller" ID is the polite one.
      const myId = socket.id || '';
      const isPolite = myId < sender;
      const currentRTC = rtcMapRef.current[sender];

      if (currentRTC && isPolite && currentRTC.peerConnection.signalingState !== 'stable') {
         console.log(`[SIG] Glare detected, rollback for ${sender.slice(0,6)} (Polite)`);
         await currentRTC.peerConnection.setLocalDescription({ type: "rollback" } as RTCSessionDescriptionInit);
         await currentRTC.handleOffer(offer);
         return;
      }

      const rtc = createRTC(sender, false, 'Incoming Offer');
      setPeers(prev => ({
        ...prev,
        [sender]: {
          ...prev[sender],
          id: sender,
          name: prev[sender]?.name || `Node-${sender.slice(0,4)}`,
          deviceType: prev[sender]?.deviceType || 'device',
          rtcState: 'connecting', rtc
        }
      }));
      await rtc.handleOffer(offer);
    };

    const handleAnswer = async ({ answer, sender }: { answer: RTCSessionDescriptionInit, sender: string }) => {
      await rtcMapRef.current[sender]?.handleAnswer(answer);
    };

    const handleIceCandidate = async ({ candidate, sender }: { candidate: RTCIceCandidateInit, sender: string }) => {
      await rtcMapRef.current[sender]?.handleIceCandidate(candidate);
    };

    socket.on('webrtc_offer', handleOffer);
    socket.on('webrtc_answer', handleAnswer);
    socket.on('ice_candidate', handleIceCandidate);

    return () => {
      socket.off('webrtc_offer', handleOffer);
      socket.off('webrtc_answer', handleAnswer);
      socket.off('ice_candidate', handleIceCandidate);
    };
  }, [createRTC, connectionState]); // Watch connectionState to ensure listeners bind once socket is ready

  const handleExitRoom = useCallback(() => {
    Object.values(rtcMapRef.current).forEach(r => r.close('Exit Room'));
    rtcMapRef.current = {};
    setPeers({});
    setRoomPin('');
    setManualPinInput(Array(5).fill(''));
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('room');
      window.history.replaceState({}, '', url.toString());
    }
    socketService.disconnect();
    setTimeout(() => startConnection(), 100);
  }, [startConnection]);

  const handleRescan = useCallback(() => {
    setIsRescanning(true);
    socketService.rescan();
    setTimeout(() => setIsRescanning(false), 1200);
  }, []);

  const peerList = useMemo(() => Object.values(peers), [peers]);
  const hasActiveTransfer = useMemo(
    () => peerList.some(p => p.activeStatus === 'sending' || p.activeStatus === 'receiving'),
    [peerList]
  );

  // Only interrupt a page close when there is something to lose. The old
  // unconditional guard nagged on every navigation away from an idle room.
  useEffect(() => {
    if (!hasActiveTransfer) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasActiveTransfer]);

  useEffect(() => {
    // Guarded so React 19 StrictMode's double-mount does not open two sockets.
    if (!bootstrappedRef.current) {
      bootstrappedRef.current = true;
      // Fetch TURN credentials before starting any P2P connections
      fetchTurnServers().then(servers => {
        iceServersRef.current = servers;
        startConnection();
      });
    }

    // Deliberate: the room UI reads window APIs, so it must not render on the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
    return () => {
      Object.values(rtcMapRef.current).forEach(r => r.close());
      socketService.disconnect();
    };
  }, [startConnection]);

  useEffect(() => {
    // Alone in the room? Drop ?room= so a refresh falls back to auto-discovery.
    if (!mounted || connectionState !== 'connected' || peerList.length > 0) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('room')) return;
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url.toString());
  }, [peerList.length, connectionState, mounted]);

  // ── Theme computation (must be before early returns to honour Rules of Hooks) ──
  const computedTheme = useMemo((): ThemeColors => {
    const activePeers = Object.values(peers);
    if (connectionState !== 'connected') {
      return { themeText: "text-amber-400", themeBg: "bg-amber-400", themeBorder: "border-amber-400", themeShadow: "shadow-[0_0_10px_#f59e0b]", themeHover: "hover:bg-amber-400 hover:text-black hover:shadow-[0_0_15px_#f59e0b] hover:border-transparent", glowColor: "bg-amber-400/20", accent: "#f59e0b" };
    } else if (activePeers.some(p => p.activeStatus === 'error' || p.rtcState === 'failed')) {
      return { themeText: "text-red-500", themeBg: "bg-red-500", themeBorder: "border-red-500", themeShadow: "shadow-[0_0_10px_#ef4444]", themeHover: "hover:bg-red-500 hover:text-black hover:shadow-[0_0_15px_#ef4444] hover:border-transparent", glowColor: "bg-red-500/20", accent: "#ef4444" };
    } else if (activePeers.some(p => p.activeStatus === 'incoming_req')) {
      return { themeText: "text-purple-500", themeBg: "bg-purple-500", themeBorder: "border-purple-500", themeShadow: "shadow-[0_0_10px_#a855f7]", themeHover: "hover:bg-purple-500 hover:text-black hover:shadow-[0_0_15px_#a855f7] hover:border-transparent", glowColor: "bg-purple-500/30", accent: "#a855f7" };
    } else if (activePeers.some(p => p.activeStatus === 'done')) {
      return { themeText: "text-green-500", themeBg: "bg-green-500", themeBorder: "border-green-500", themeShadow: "shadow-[0_0_10px_#4ade80]", themeHover: "hover:bg-green-400 hover:text-black hover:shadow-[0_0_15px_#4ade80] hover:border-transparent", glowColor: "bg-green-500/20", accent: "#4ade80" };
    } else if (activePeers.some(p => p.activeStatus === 'sending' || p.activeStatus === 'receiving')) {
      return { themeText: "text-neon-blue", themeBg: "bg-neon-blue", themeBorder: "border-neon-blue", themeShadow: "shadow-[0_0_10px_#00f0ff]", themeHover: "hover:bg-neon-blue hover:text-black hover:shadow-[0_0_15px_#00f0ff] hover:border-transparent", glowColor: "bg-neon-blue/40 animate-pulse", accent: "#00f0ff" };
    }
    return defaultTheme;
  }, [connectionState, peers]);

  // Sync into global context BEFORE early returns
  useEffect(() => { setTheme(computedTheme); }, [computedTheme, setTheme]);

  const roomUrl = roomPin && typeof window !== 'undefined'
    ? `${window.location.origin}/?room=${roomPin}`
    : '';

  const copyToClipboard = useCallback(async (value: string, kind: 'code' | 'link') => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API needs a secure context; fall back to a hidden textarea.
      const el = document.createElement('textarea');
      el.value = value;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(el);
    }
    setCopied(kind);
    setTimeout(() => setCopied(null), 1800);
  }, []);

  if (!mounted) return null;
  if (connectionState !== 'connected') {
    return <ConnectionLoader state={connectionState} onRetry={startConnection} />;
  }

  // Safe to read browser APIs directly: nothing below renders on the server.
  const isSecure = window.isSecureContext;
  const canPickFolder = supportsDirectoryInput();
  const inRoom = peerList.length > 0;

  // Destructure computed theme for use in JSX
  const { themeText, themeBg, themeBorder, themeShadow, themeHover, glowColor } = computedTheme;

  // Multicast Feature — each card runs its own sender so progress, cancelling
  // and per-peer errors stay independent.
  const handleGlobalSend = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = toFluxFiles(e.target.files);
    e.target.value = "";
    if (files.length === 0) return;
    setBroadcast({ token: Date.now(), files });
  };

  return (
    <>
    <div className={`fixed top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[400px] rounded-[100%] blur-[120px] pointer-events-none transition-colors duration-1000 ${glowColor}`} />

    {/* Global Header Integrated Into Room Context */}
    <header className="w-full pt-12 pb-6 px-6 sm:px-14 flex justify-between items-center gap-4 z-50 relative">
      <div>
        <h1 className="text-4xl font-bold tracking-tighter text-white flex items-baseline">
          FLU<span className={`${themeText} text-[42px] ml-1.5 transition-colors duration-500`}>X</span>
        </h1>
        <p className="text-sm font-medium text-white/50 tracking-widest uppercase mt-1">
          P2P LAN Transfer
        </p>
      </div>

      <div className="flex items-center gap-3 bg-white/5 border border-white/10 px-4 py-2 rounded-full glass-panel">
        <div className={`w-2 h-2 rounded-full animate-pulse transition-all duration-500 ${
          signalState === 'online' ? `${themeBg} ${themeShadow}`
            : signalState === 'reconnecting' ? 'bg-amber-400 shadow-[0_0_10px_#f59e0b]'
            : 'bg-red-500 shadow-[0_0_10px_#ef4444]'
        }`} />
        <span className="text-xs text-white/70 font-medium">
           {signalState === 'online'
             ? (socketService.myDeviceInfo?.name || "Connecting...")
             : signalState === 'reconnecting' ? 'Reconnecting…' : 'Signal lost'}
        </span>
      </div>
    </header>

    <div className="w-full max-w-6xl mx-auto py-1 px-6">
      {!isSecure && (
        <div className="mb-6 p-4 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex items-start gap-4">
          <div className="bg-amber-500/20 p-2 rounded-lg">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </div>
          <div>
            <h4 className="text-amber-400 font-bold text-sm">Insecure Context Detected</h4>
            <p className="text-white/60 text-xs leading-relaxed mt-1">
              WebRTC (P2P) is disabled by your browser on non-HTTPS origins.
              <br />
              <span className="font-semibold text-white/80">Fix:</span> Use <code className="bg-white/10 px-1 rounded">https://</code> or a tunnel such as ngrok to test on mobile.
            </p>
          </div>
        </div>
      )}

      {signalState !== 'online' && (
        <div className="mb-6 p-4 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex items-center gap-4">
          <div className="w-4 h-4 border-2 border-amber-400/30 border-t-amber-400 rounded-full animate-spin shrink-0" />
          <p className="text-white/70 text-xs leading-relaxed">
            {signalState === 'reconnecting'
              ? 'Lost the signaling server. Transfers already running keep going; new devices will not appear until this reconnects.'
              : 'Could not reach the signaling server. Reload the page to try again.'}
          </p>
        </div>
      )}

      <div className="flex flex-col lg:flex-row items-stretch justify-start mt-4 gap-8 max-w-[1400px] mx-auto px-4 w-full h-full min-h-[600px]">

        {/* Left Side: Dynamic Workspace */}
        <div className="flex flex-col flex-1 w-full min-w-0">
          {peerList.length > 1 && (
            <div className="flex justify-start mb-6">
              <input type="file" multiple ref={globalFileInputRef} onChange={handleGlobalSend} className="hidden" />
              <input type="file" {...{webkitdirectory: "", directory: ""} as Record<string, string>} multiple ref={globalFolderInputRef} onChange={handleGlobalSend} className="hidden" />
              <div className="flex flex-wrap gap-4">
                <button
                  onClick={() => globalFileInputRef.current?.click()}
                  className={`flex items-center gap-2 bg-transparent border ${themeBorder} ${themeText} font-semibold px-5 py-2.5 rounded-xl transition-all duration-300 ${themeHover} shadow-lg`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>
                  Send to All
                </button>
                {canPickFolder && (
                  <button
                    onClick={() => globalFolderInputRef.current?.click()}
                    className={`flex items-center gap-2 bg-transparent border ${themeBorder} ${themeText} font-semibold px-5 py-2.5 rounded-xl transition-all duration-300 ${themeHover} shadow-lg`}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                    Send Folder to All
                  </button>
                )}
              </div>
            </div>
          )}

          {peerList.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-10 bg-white/[0.02] border border-white/5 rounded-3xl relative overflow-hidden transition-all hover:bg-white/[0.03] flex-1 min-h-[500px]">
               <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-neon-blue to-transparent opacity-30" />
               <div className="w-24 h-24 rounded-full border-2 border-dashed border-white/20 animate-[spin_4s_linear_infinite] flex items-center justify-center mb-8 relative">
                <div className="w-3 h-3 bg-neon-blue rounded-full absolute top-1 blur-[1px]" />
              </div>
              <h2 className="text-3xl font-semibold text-white mb-4">Scanning Network...</h2>
              <p className="text-white/40 max-w-sm text-center leading-relaxed text-lg">
                Open FLUX on another device connected to the exact same Wi-Fi network.
              </p>
              <p className="text-white/25 max-w-sm text-center leading-relaxed text-sm mt-3">
                On a different network? Scan the QR code or type the join code from the other device.
              </p>
              <button
                onClick={handleRescan}
                disabled={isRescanning}
                className="mt-8 flex items-center gap-2 px-5 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white/60 text-sm font-medium hover:bg-white/10 hover:text-white/90 hover:border-white/20 transition-all duration-300 disabled:opacity-50"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={isRescanning ? 'animate-spin' : ''}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                {isRescanning ? 'Scanning…' : 'Scan again'}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 auto-rows-max">
              {peerList.map(peer => (
                <DeviceCard
                  key={peer.id}
                  peer={peer}
                  broadcast={broadcast}
                  onStatusChange={(status) => updatePeer(peer.id, { activeStatus: status })}
                  onRetryConnection={() => retryPeerConnection(peer.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="hidden lg:block w-px border-l border-dashed border-white/10" />
        <div className="lg:hidden h-px w-full border-t border-dashed border-white/10 my-2" />

        {/* Right Side: Persistent Manual Pin Side */}
        <div className="flex flex-col items-center justify-center p-6 lg:p-8 bg-white/[0.02] border border-white/5 rounded-3xl w-full lg:w-[320px] xl:w-[360px] flex-shrink-0 relative transition-all hover:bg-white/[0.03] min-h-[500px]">
           <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
           <h3 className="text-white/60 font-medium mb-8 uppercase tracking-widest text-xs">Room Invite</h3>

           {roomPin ? (
             <div className="flex flex-col gap-6 items-center w-full justify-center">
               <div className="p-4 bg-white rounded-2xl shadow-[0_0_30px_rgba(255,255,255,0.1)]">
                 <QRCodeSVG value={roomUrl} size={110} />
               </div>
               <div className="flex flex-col items-center w-full">
                 <p className="text-white/40 text-[10px] uppercase tracking-widest mb-2 font-semibold">Join Code</p>
                 <button
                   onClick={() => copyToClipboard(roomPin, 'code')}
                   title="Copy join code"
                   className="group text-4xl font-mono text-white tracking-widest px-5 py-2.5 bg-white/5 border border-white/10 rounded-2xl shadow-inner hover:border-white/25 transition-colors flex items-center gap-3"
                 >
                   {roomPin}
                   <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/25 group-hover:text-white/60 transition-colors"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                 </button>
                 <button
                   onClick={() => copyToClipboard(roomUrl, 'link')}
                   className="mt-3 text-white/40 hover:text-white/80 text-[11px] uppercase tracking-widest font-semibold transition-colors"
                 >
                   {copied === 'link' ? 'Link copied' : copied === 'code' ? 'Code copied' : 'Copy invite link'}
                 </button>
               </div>
             </div>
           ) : (
              <div className="h-[260px] flex items-center justify-center"><div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin"/></div>
           )}

           <div className="w-full h-px bg-white/5 my-8" />

           {inRoom ? (
              <div className="w-full relative flex flex-col items-center mt-2">
                 <button
                  onClick={handleExitRoom}
                  className="w-full bg-red-500/10 border border-red-500/20 text-red-400 font-bold py-3.5 rounded-xl hover:bg-red-500 hover:text-white transition-all duration-300 shadow-xl tracking-wide uppercase text-sm flex items-center justify-center gap-2"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                  Exit Room
                </button>
              </div>
           ) : (
             <>
               <h3 className="text-white/40 text-[10px] uppercase tracking-widest mb-6 font-semibold text-center">Manually Enter Code</h3>
               <div className="w-full relative flex flex-col items-center gap-6">
                  <div className="flex gap-2 w-full justify-center">
                    {manualPinInput.map((p, i) => (
                      <input
                        key={i}
                        ref={el => { pinInputRefs.current[i] = el; }}
                        value={p}
                        onChange={e => handlePinChange(i, e.target.value)}
                        onKeyDown={e => handlePinKeyDown(i, e)}
                        onPaste={e => handlePinPaste(i, e)}
                        onFocus={e => e.target.select()}
                        inputMode="numeric"
                        autoComplete={i === 0 ? "one-time-code" : "off"}
                        aria-label={`Join code digit ${i + 1}`}
                        className="w-10 h-12 bg-black/40 border border-white/10 rounded-xl text-center text-xl font-mono text-white focus:outline-none focus:border-neon-blue focus:ring-1 focus:ring-neon-blue/50 transition-all shadow-inner"
                      />
                    ))}
                  </div>
                  <button
                    onClick={() => { const full = manualPinInput.join(''); if(full.length === 5) startConnection(full); }}
                    disabled={manualPinInput.join('').length !== 5}
                    className="w-full bg-white/10 text-white font-bold py-3.5 rounded-xl disabled:opacity-30 disabled:cursor-not-allowed hover:bg-neon-blue hover:text-black transition-all duration-300 shadow-xl tracking-wide uppercase text-sm"
                  >
                    Join
                  </button>
               </div>
             </>
           )}
        </div>
      </div>
    </div>
    </>
  );
}
