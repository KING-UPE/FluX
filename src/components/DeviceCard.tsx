"use client";

import { useState, useRef, useEffect } from "react";
import { FileSender, FileReceiver, IncomingRequest, TransferStats } from "@/lib/fileTransfer";
import { WebRTCConnection, ChunkData } from "@/lib/webrtc";

interface PeerData {
  id: string;
  name: string;
  deviceType: string;
  rtcState: 'connecting' | 'connected' | 'failed';
  rtc?: WebRTCConnection;
}

interface DeviceCardProps {
  peer: PeerData;
  onStatusChange?: (status: string) => void;
}

function DeviceIcon({ type, color }: { type: string, color: string }) {
  if (type === 'phone') return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-colors duration-500">
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
      <line x1="12" y1="18" x2="12" y2="18"/>
    </svg>
  );
  if (type === 'laptop') return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-colors duration-500">
      <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>
    </svg>
  );
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-colors duration-500">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/>
      <line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
  );
}

export default function DeviceCard({ peer, onStatusChange }: DeviceCardProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [status, setStatus] = useState<'idle' | 'sending' | 'receiving' | 'incoming_req' | 'done' | 'error'>('idle');
  const [stats, setStats] = useState<TransferStats | null>(null);
  const [incomingReq, setIncomingReq] = useState<IncomingRequest | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const receiverRef = useRef<FileReceiver | null>(null);

  const { name, deviceType, rtcState, rtc } = peer;

  useEffect(() => {
    onStatusChange?.(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Setup receiver immediately when we have the RTC object
  useEffect(() => {
    if (rtc && rtcState === 'connected') {
      const receiver = new FileReceiver(
        rtc,
        (req) => {
          setIncomingReq(req);
          setStatus('incoming_req');
        },
        (s) => {
          setStats(s);
          setStatus('receiving');
        },
        () => {
          setStatus('done');
          setTimeout(() => { setStatus('idle'); setStats(null); }, 4000);
        },
        (err) => {
           setStatus('error');
           setErrorMsg(err);
           setTimeout(() => { setStatus('idle'); setErrorMsg(''); }, 5000);
        }
      );
      receiverRef.current = receiver;

      const handleData = async (data: ChunkData) => {
        await receiver.handleData(data);
      };
      rtc.onData(handleData);

      return () => {
        rtc.offData(handleData);
      };
    }
  }, [rtc, rtcState]);

  const startTransfer = (files: FileList | File[]) => {
    if (!rtc || !rtc.isOpen) return;
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    setStatus('sending');
    const sender = new FileSender(
      fileArray, rtc,
      (s) => setStats(s),
      () => {
        setStatus('done');
        setTimeout(() => { setStatus('idle'); setStats(null); }, 4000);
      },
      (err) => {
        setStatus('error');
        setErrorMsg(err);
        setTimeout(() => { setStatus('idle'); setErrorMsg(''); }, 5000);
      }
    );
    sender.start();
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(false); };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    
    if (e.dataTransfer.files?.length > 0) {
      startTransfer(e.dataTransfer.files);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) startTransfer(e.target.files);
  };

  // Dynamic Theme Integration
  let themeText = 'text-neon-blue';
  let themeBg = 'bg-neon-blue';
  let themeBorder = 'border-neon-blue';
  let themeShadow = 'shadow-[0_0_10px_#00f0ff]';
  let themeStroke = '#00f0ff';
  let hoverBg = 'hover:bg-neon-blue hover:text-black';

  if (status === 'done') {
     themeText = 'text-green-400'; themeBg = 'bg-green-400'; themeBorder = 'border-green-400'; themeShadow = 'shadow-[0_0_10px_#4ade80]'; themeStroke = '#4ade80'; hoverBg = 'hover:bg-green-400 hover:text-black';
  } else if (status === 'incoming_req') {
     themeText = 'text-purple-500'; themeBg = 'bg-purple-500'; themeBorder = 'border-purple-500'; themeShadow = 'shadow-[0_0_10px_#a855f7]'; themeStroke = '#a855f7'; hoverBg = 'hover:bg-purple-500 hover:text-black';
  } else if (status === 'error' || rtcState === 'failed') {
     themeText = 'text-red-500'; themeBg = 'bg-red-500'; themeBorder = 'border-red-500'; themeShadow = 'shadow-[0_0_10px_#ef4444]'; themeStroke = '#ef4444'; hoverBg = 'hover:bg-red-500 hover:text-black';
  } else if (rtcState !== 'connected') {
     themeText = 'text-amber-400'; themeBg = 'bg-amber-400'; themeBorder = 'border-amber-400'; themeShadow = 'shadow-[0_0_10px_#f59e0b] animate-pulse'; themeStroke = '#f59e0b'; hoverBg = 'hover:bg-amber-400 hover:text-black';
  }

  const progress = stats?.progress || 0;

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative w-full rounded-2xl p-6 flex flex-col justify-center transition-all duration-300 overflow-hidden glass-panel 
      ${isDragOver ? `scale-[1.02] ${themeBorder} ${themeShadow}` : "border-white/10"}`}
    >
      <input type="file" multiple ref={fileInputRef} onChange={handleFileSelect} className="hidden" />
      <input type="file" {...{webkitdirectory: "", directory: ""} as any} multiple ref={folderInputRef} onChange={handleFileSelect} className="hidden" />

      {/* Header */}
      <div className="flex items-center justify-between z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
            <DeviceIcon type={deviceType} color={themeStroke} />
          </div>
          <div>
            <h3 className="text-white font-medium text-lg">{name}</h3>
            {status === 'error' ? (
              <p className="text-sm text-red-400/70">{errorMsg}</p>
            ) : status === 'done' ? (
              <p className="text-sm text-green-400/70">✓ Transfer Complete</p>
            ) : rtcState !== 'connected' ? (
              <p className="text-sm text-amber-400/70">{rtcState === 'failed' ? 'Connection lost' : 'Connecting...'}</p>
            ) : (
              <p className={`text-sm ${themeText} transition-colors`}>{status === 'idle' ? 'Ready for files' : 'Active'}</p>
            )}
          </div>
        </div>
        <div className={`w-3 h-3 rounded-full ${themeBg} ${themeShadow} transition-colors duration-500`} />
      </div>

      {/* Dynamic Main Content Area */}
      <div className="z-10 mt-6 flex-1 flex flex-col justify-center">
        {status === 'idle' && rtcState === 'connected' && (
          <div className="flex gap-4 items-center justify-center">
            <button 
              onClick={() => fileInputRef.current?.click()}
              className={`flex-1 py-3 px-4 bg-white/5 border border-white/10 rounded-xl text-sm font-medium text-white/70 transition-all duration-300 ${hoverBg} hover:shadow-[0_0_15px] hover:border-transparent`}
            >
              Select Files
            </button>
            <button 
              onClick={() => folderInputRef.current?.click()}
              className={`flex-1 py-3 px-4 bg-white/5 border border-white/10 rounded-xl text-sm font-medium text-white/70 transition-all duration-300 ${hoverBg} hover:shadow-[0_0_15px] hover:border-transparent`}
            >
              Send Folder
            </button>
          </div>
        )}

        {status === 'incoming_req' && incomingReq && (
          <div className="flex flex-col items-center justify-center h-full text-center animate-in fade-in zoom-in duration-300">
            <p className="text-white mb-1 font-medium">{incomingReq.totalFiles} incoming files</p>
            <p className="text-white/40 text-xs mb-4">
              {(incomingReq.totalSize / (1024 * 1024)).toFixed(2)} MB total
            </p>
            <div className="flex gap-3 w-full">
              <button 
                onClick={() => {
                  receiverRef.current?.decline();
                  setStatus('idle');
                  setIncomingReq(null);
                }}
                className="flex-1 py-2 px-4 bg-white/5 hover:bg-white/10 text-white/70 border border-white/20 rounded-xl text-sm font-medium transition-colors"
              >
                Decline
              </button>
              <button 
                onClick={() => receiverRef.current?.accept()}
                className={`flex-1 py-2 px-4 bg-transparent border ${themeBorder} ${themeText} rounded-xl text-sm font-bold transition-all duration-300 ${hoverBg} hover:shadow-[0_0_15px]`}
              >
                Accept
              </button>
            </div>
          </div>
        )}

        {(status === 'sending' || status === 'receiving') && (
          <div className="w-full flex flex-col gap-2 relative">
            {/* Live Progress Info */}
            <div className="flex justify-between items-end mb-1">
              <div className="w-[60%]">
                <p className="text-white/80 text-sm font-medium truncate">
                  {status === 'sending' ? 'Sending' : 'Receiving'} {stats?.fileName || '...'}
                </p>
                <div className="flex gap-2 text-xs text-white/40 mt-1">
                  <span>{stats?.speedStr || '0 MB/s'}</span>
                  <span>•</span>
                  <span>ETA: {stats?.etaStr || '--:--'}</span>
                </div>
              </div>
              <div className={`text-2xl font-bold ${themeText} transition-colors duration-500`}>
                {Math.round(progress)}%
              </div>
            </div>

            {/* Embedded Linear Progress Bar */}
            <div className="w-full h-2 bg-black/40 rounded-full overflow-hidden border border-white/5">
              <div 
                className={`h-full ${themeBg} ${themeShadow} transition-all duration-300 ease-out`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
