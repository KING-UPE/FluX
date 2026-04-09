"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import DeviceCard from "./DeviceCard";
import ConnectionLoader from "./ConnectionLoader";
import { socketService, PeerInfo, ConnectionState } from "@/lib/socket";
import { WebRTCConnection } from "@/lib/webrtc";
import { FileSender } from "@/lib/fileTransfer";

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
  const [peers, setPeers] = useState<Record<string, PeerData>>({});
  
  const rtcMapRef = useRef<Record<string, WebRTCConnection>>({});
  const globalFileInputRef = useRef<HTMLInputElement>(null);

  const updatePeer = useCallback((id: string, update: Partial<PeerData>) => {
    setPeers(prev => {
      if (!prev[id]) return prev;
      return { ...prev, [id]: { ...prev[id], ...update } };
    });
  }, []);

  const createRTC = useCallback((peerId: string, isInitiator: boolean): WebRTCConnection => {
    rtcMapRef.current[peerId]?.close();

    const rtc = new WebRTCConnection(peerId, isInitiator, () => {
      console.log(`✓ P2P ready with ${peerId.slice(0,6)}`);
      updatePeer(peerId, { rtcState: 'connected', rtc });
    });

    rtc.peerConnection.onconnectionstatechange = () => {
      const state = rtc.peerConnection.connectionState;
      if (state === 'connected') updatePeer(peerId, { rtcState: 'connected' });
      if (state === 'failed' || state === 'disconnected') updatePeer(peerId, { rtcState: 'failed' });
    };

    rtcMapRef.current[peerId] = rtc;
    return rtc;
  }, [updatePeer]);

  const [roomPin, setRoomPin] = useState<string>('');
  const [manualPinInput, setManualPinInput] = useState<string>('');

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

    socketService.connect(
      (peer: PeerInfo) => {
        setPeers(prev => ({
          ...prev,
          [peer.id]: {
            id: peer.id, name: peer.name, deviceType: peer.deviceType,
            rtcState: 'connecting',
          }
        }));
        const rtc = createRTC(peer.id, true);
        updatePeer(peer.id, { rtc });
      },
      (existingPeers: PeerInfo[]) => {
        const newPeers: Record<string, PeerData> = {};
        existingPeers.forEach(p => {
          newPeers[p.id] = {
            id: p.id, name: p.name, deviceType: p.deviceType,
            rtcState: 'connecting',
          };
        });
        setPeers(prev => ({ ...prev, ...newPeers }));
      },
      (leftId: string) => {
        rtcMapRef.current[leftId]?.close();
        delete rtcMapRef.current[leftId];
        setPeers(prev => {
          const next = { ...prev };
          delete next[leftId];
          return next;
        });
      },
      setConnectionState,
      (pin: string) => setRoomPin(pin),
      targetRoom
    );

    const bindSignaling = () => {
      const socket = socketService.socket;
      if (!socket) { setTimeout(bindSignaling, 300); return; }

      socket.on('webrtc_offer', async ({ offer, sender }) => {
        const rtc = createRTC(sender, false);
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
      });

      socket.on('webrtc_answer', async ({ answer, sender }) => {
        await rtcMapRef.current[sender]?.handleAnswer(answer);
      });

      socket.on('ice_candidate', async ({ candidate, sender }) => {
        await rtcMapRef.current[sender]?.handleIceCandidate(candidate);
      });
    };

    bindSignaling();
  }, [createRTC, updatePeer]);

  useEffect(() => {
    startConnection();
    setMounted(true);
    return () => {
      Object.values(rtcMapRef.current).forEach(r => r.close());
      socketService.disconnect();
    };
  }, [startConnection]);

  if (!mounted) return null;
  if (connectionState !== 'connected') {
    return <ConnectionLoader state={connectionState} onRetry={startConnection} />;
  }

  const peerList = Object.values(peers);

  // Dynamic Theme Lighting (Blob & Master Branding)
  let glowColor = "bg-neon-blue/10";
  let themeText = "text-neon-blue";
  let themeBg = "bg-neon-blue";
  let themeBorder = "border-neon-blue";
  let themeShadow = "shadow-[0_0_10px_#00f0ff]";
  let themeHover = "hover:bg-neon-blue hover:text-black hover:shadow-[0_0_15px_#00f0ff] hover:border-transparent";

  if (connectionState !== 'connected') {
     glowColor = "bg-amber-400/20"; themeText = "text-amber-400"; themeBg = "bg-amber-400"; themeBorder = "border-amber-400"; themeShadow = "shadow-[0_0_10px_#f59e0b]"; themeHover = "hover:bg-amber-400 hover:text-black hover:shadow-[0_0_15px_#f59e0b] hover:border-transparent";
  } else if (peerList.some(p => p.activeStatus === 'error' || p.rtcState === 'failed')) {
     glowColor = "bg-red-500/20"; themeText = "text-red-500"; themeBg = "bg-red-500"; themeBorder = "border-red-500"; themeShadow = "shadow-[0_0_10px_#ef4444]"; themeHover = "hover:bg-red-500 hover:text-black hover:shadow-[0_0_15px_#ef4444] hover:border-transparent";
  } else if (peerList.some(p => p.activeStatus === 'incoming_req')) {
     glowColor = "bg-purple-500/30"; themeText = "text-purple-500"; themeBg = "bg-purple-500"; themeBorder = "border-purple-500"; themeShadow = "shadow-[0_0_10px_#a855f7]"; themeHover = "hover:bg-purple-500 hover:text-black hover:shadow-[0_0_15px_#a855f7] hover:border-transparent";
  } else if (peerList.some(p => p.activeStatus === 'done')) {
     glowColor = "bg-green-500/20"; themeText = "text-green-500"; themeBg = "bg-green-500"; themeBorder = "border-green-500"; themeShadow = "shadow-[0_0_10px_#4ade80]"; themeHover = "hover:bg-green-400 hover:text-black hover:shadow-[0_0_15px_#4ade80] hover:border-transparent";
  } else if (peerList.some(p => p.activeStatus === 'sending' || p.activeStatus === 'receiving')) {
     glowColor = "bg-neon-blue/40 animate-pulse";
  }

  // Multicast Feature
  const handleGlobalSend = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const fileArray = Array.from(e.target.files);
    
    if (fileArray.length > 0) {
      console.log(`Multicasting ${fileArray.length} items to ${peerList.length} peers...`);
      peerList.forEach(peer => {
        if (peer.rtc && peer.rtc.isOpen) {
           const sender = new FileSender(
             fileArray, peer.rtc,
             () => {}, 
             () => console.log('Multicast done for ' + peer.name),
             (err) => console.log('Multicast error for ' + peer.name, err)
           );
           sender.start();
        }
      });
    }
  };

  return (
    <>
    <div className={`fixed top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[400px] rounded-[100%] blur-[120px] pointer-events-none transition-colors duration-1000 ${glowColor}`} />
    
    {/* Global Header Integrated Into Room Context */}
    <header className="w-full pt-12 pb-6 px-14 flex justify-between items-center z-50 relative">
      <div>
        <h1 className="text-4xl font-bold tracking-tighter text-white flex items-baseline">
          FLU<span className={`${themeText} text-[42px] ml-1.5 transition-colors duration-500`}>X</span>
        </h1>
        <p className="text-sm font-medium text-white/50 tracking-widest uppercase mt-1">
          P2P LAN Transfer
        </p>
      </div>
      
      <div className="flex items-center gap-3 bg-white/5 border border-white/10 px-4 py-2 rounded-full glass-panel">
        <div className={`w-2 h-2 ${themeBg} rounded-full ${themeShadow} animate-pulse transition-all duration-500`} />
        <span className="text-xs text-white/70 font-medium">
           {socketService.myDeviceInfo?.name || "Connecting..."}
        </span>
      </div>
    </header>

    <div className="w-full max-w-6xl mx-auto py-1 px-6">
      
      {peerList.length > 1 && (
        <div className="flex justify-end mb-4">
          <input type="file" multiple ref={globalFileInputRef} onChange={handleGlobalSend} className="hidden" />
          <button 
            onClick={() => globalFileInputRef.current?.click()}
            className={`flex items-center gap-2 bg-transparent border ${themeBorder} ${themeText} font-semibold px-4 py-2 rounded-xl transition-all duration-300 ${themeHover}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>
            Send to All Devices
          </button>
        </div>
      )}

      {peerList.length === 0 ? (
        <div className="flex flex-col lg:flex-row items-center justify-center mt-12 gap-10 max-w-5xl mx-auto px-4">
          
          {/* Autodiscovery Side */}
          <div className="flex flex-col items-center justify-center p-10 bg-white/[0.02] border border-white/5 rounded-3xl flex-1 w-full relative overflow-hidden transition-all hover:bg-white/[0.03]">
             <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-neon-blue to-transparent opacity-30" />
             <div className="w-20 h-20 rounded-full border-2 border-dashed border-white/20 animate-[spin_4s_linear_infinite] flex items-center justify-center mb-8 relative">
              <div className="w-3 h-3 bg-neon-blue rounded-full absolute top-1 blur-[1px]" />
            </div>
            <h2 className="text-2xl font-semibold text-white mb-3">Scanning Network...</h2>
            <p className="text-white/40 max-w-sm text-center leading-relaxed">
              Open FLUX on another device connected to the exact same Wi-Fi network.
            </p>
          </div>

          <div className="hidden lg:block w-px h-64 bg-gradient-to-b from-transparent via-white/10 to-transparent" />
          <div className="lg:hidden h-px w-full max-w-xs bg-gradient-to-r from-transparent via-white/10 to-transparent" />

          {/* Manual Pin Side */}
          <div className="flex flex-col items-center justify-center p-10 bg-white/[0.02] border border-white/5 rounded-3xl flex-1 w-full relative transition-all hover:bg-white/[0.03]">
             <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
             <h3 className="text-white/60 font-medium mb-8">Bypass network isolation</h3>
             
             {roomPin ? (
               <div className="flex flex-col sm:flex-row gap-8 items-center w-full justify-center">
                 <div className="p-3 bg-white rounded-xl shadow-[0_0_30px_rgba(255,255,255,0.1)]">
                   {typeof window !== 'undefined' && (
                     <QRCodeSVG value={`${window.location.origin}/?room=${roomPin}`} size={110} />
                   )}
                 </div>
                 <div className="flex flex-col items-center sm:items-start">
                   <p className="text-white/40 text-xs uppercase tracking-widest mb-2 font-semibold">Join Code</p>
                   <div className="text-4xl font-mono text-white tracking-widest px-5 py-3 bg-white/5 border border-white/10 rounded-xl shadow-inner">
                     {roomPin}
                   </div>
                 </div>
               </div>
             ) : (
                <div className="h-[134px] flex items-center justify-center"><div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin"/></div>
             )}

             <div className="mt-10 w-full max-w-sm relative flex gap-3">
                <input 
                  type="text" 
                  maxLength={5}
                  placeholder="Enter 5-digit PIN" 
                  value={manualPinInput}
                  onChange={(e) => setManualPinInput(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => { if(e.key === 'Enter' && manualPinInput.length === 5) startConnection(manualPinInput); }}
                  className="w-full bg-black/40 border border-white/10 rounded-xl px-5 py-4 text-white placeholder-white/30 focus:outline-none focus:border-neon-blue/50 focus:ring-1 focus:ring-neon-blue/50 font-mono tracking-widest transition-all text-center text-lg"
                />
                <button 
                  onClick={() => { if(manualPinInput.length === 5) startConnection(manualPinInput); }}
                  disabled={manualPinInput.length !== 5}
                  className="bg-white/10 text-white font-bold px-6 rounded-xl disabled:opacity-30 disabled:cursor-not-allowed hover:bg-neon-blue hover:text-black transition-all duration-300"
                >
                  Join
                </button>
             </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mt-2">
          {peerList.map(peer => (
            <DeviceCard 
              key={peer.id} 
              peer={peer} 
              onStatusChange={(status) => updatePeer(peer.id, { activeStatus: status })}
            />
          ))}
        </div>
      )}
    </div>
    </>
  );
}
