"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  FileSender,
  FileReceiver,
  IncomingRequest,
  TransferStats,
  SavedItem,
  SaveMode,
  ZIP_MEMORY_WARN_BYTES,
} from "@/lib/fileTransfer";
import { WebRTCConnection, ChunkData } from "@/lib/webrtc";
import {
  FluxFile,
  formatBytes,
  baseName,
  toFluxFiles,
  getFilesFromDataTransfer,
  supportsDirectoryInput,
  supportsFileSystemAccess,
} from "@/lib/fileUtils";

interface PeerData {
  id: string;
  name: string;
  deviceType: string;
  rtcState: 'connecting' | 'connected' | 'failed';
  rtc?: WebRTCConnection;
  activeStatus?: string;
}

export interface BroadcastRequest {
  token: number;
  files: FluxFile[];
}

interface DeviceCardProps {
  peer: PeerData;
  onStatusChange: (status: string) => void;
  onRetryConnection: () => void;
  broadcast?: BroadcastRequest | null;
}

type Notice = { kind: 'error' | 'info' | 'success'; text: string };

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

const SAVE_TARGET_LABEL: Record<string, string> = {
  disk: 'To disk',
  zip: 'As ZIP',
  download: 'To downloads',
};

/** One live transfer: label, numbers, bar and a way out of it. */
function TransferRow({
  title, stats, themeText, themeBg, themeShadow, onCancel,
}: {
  title: string;
  stats: TransferStats;
  themeText: string;
  themeBg: string;
  themeShadow: string;
  onCancel: () => void;
}) {
  const progress = Math.max(0, Math.min(100, stats.progress));
  const indeterminate = stats.phase === 'waiting';

  return (
    <div className="w-full flex flex-col gap-2">
      <div className="flex justify-between items-end gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-white/80 text-sm font-medium truncate" title={stats.fileName}>
            {title}
          </p>
          <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-white/40 mt-1">
            {stats.totalFiles > 1 && <span>{stats.fileIndex} of {stats.totalFiles}</span>}
            {stats.totalFiles > 1 && <span>•</span>}
            <span>{formatBytes(stats.bytesDone)} / {formatBytes(stats.totalBytes)}</span>
            {stats.phase === 'transferring' && (
              <>
                <span>•</span>
                <span>{stats.speedStr}</span>
                <span>•</span>
                <span>ETA {stats.etaStr}</span>
              </>
            )}
            {stats.saveTarget && (
              <>
                <span>•</span>
                <span>{SAVE_TARGET_LABEL[stats.saveTarget]}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className={`text-2xl font-bold ${themeText} transition-colors duration-500 tabular-nums`}>
            {indeterminate ? '--' : `${Math.round(progress)}%`}
          </div>
          <button
            onClick={onCancel}
            aria-label="Cancel transfer"
            title="Cancel transfer"
            className="w-7 h-7 flex items-center justify-center rounded-lg bg-white/5 border border-white/10 text-white/50 hover:bg-red-500/20 hover:border-red-500/40 hover:text-red-400 transition-all"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      <div className="w-full h-2 bg-black/40 rounded-full overflow-hidden border border-white/5">
        {indeterminate ? (
          <div className={`h-full w-1/3 ${themeBg} ${themeShadow} rounded-full animate-flux-indeterminate`} />
        ) : (
          <div
            className={`h-full ${themeBg} ${themeShadow} transition-all duration-300 ease-out`}
            style={{ width: `${progress}%` }}
          />
        )}
      </div>
    </div>
  );
}

export default function DeviceCard({ peer, onStatusChange, onRetryConnection, broadcast }: DeviceCardProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [sendStats, setSendStats] = useState<TransferStats | null>(null);
  const [recvStats, setRecvStats] = useState<TransferStats | null>(null);
  const [incomingReq, setIncomingReq] = useState<IncomingRequest | null>(null);
  const [isAccepting, setIsAccepting] = useState(false);
  const [savedItems, setSavedItems] = useState<SavedItem[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const receiverRef = useRef<FileReceiver | null>(null);
  const senderRef = useRef<FileSender | null>(null);
  // Seeded with whatever broadcast is already in flight, so a device that joins
  // *after* a "send to all" does not get handed the previous selection.
  const lastBroadcastRef = useRef(broadcast?.token ?? 0);
  const dragDepthRef = useRef(0);

  const { name, deviceType, rtcState, rtc } = peer;
  const [canPickFolder, setCanPickFolder] = useState(true);

  useEffect(() => { setCanPickFolder(supportsDirectoryInput()); }, []);

  // ── Report a single derived status upward (drives the room-wide theme) ──
  const statusCallbackRef = useRef(onStatusChange);
  statusCallbackRef.current = onStatusChange;

  useEffect(() => {
    let status = 'idle';
    if (notice?.kind === 'error') status = 'error';
    else if (incomingReq) status = 'incoming_req';
    else if (sendStats) status = 'sending';
    else if (recvStats) status = 'receiving';
    else if (notice?.kind === 'success') status = 'done';
    statusCallbackRef.current(status);
  }, [notice, incomingReq, sendStats, recvStats]);

  // Notices are transient — clear them so the card returns to its idle actions.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.kind === 'error' ? 6000 : 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // ── Receiver lives for as long as the connection does ──
  useEffect(() => {
    if (!rtc || rtcState !== 'connected') return;

    const receiver = new FileReceiver(rtc, {
      onRequest: req => { setIsAccepting(false); setIncomingReq(req); },
      onStats: stats => { setIsAccepting(false); setRecvStats(stats); },
      onDone: count => {
        setRecvStats(null);
        setIncomingReq(null);
        setIsAccepting(false);
        setNotice({ kind: 'success', text: `Received ${count} file${count === 1 ? '' : 's'}` });
      },
      onError: message => {
        setRecvStats(null);
        setIncomingReq(null);
        setIsAccepting(false);
        setNotice({ kind: 'error', text: message });
      },
      onCancelled: message => {
        setRecvStats(null);
        setIncomingReq(null);
        setIsAccepting(false);
        setNotice({ kind: 'info', text: message });
      },
      onSaveReady: items => setSavedItems(items),
    });
    receiverRef.current = receiver;

    const handleData = (data: ChunkData) => receiver.handleData(data);
    rtc.onData(handleData);

    return () => {
      rtc.offData(handleData);
      receiver.destroy();
      receiverRef.current = null;
      setIncomingReq(null);
      setRecvStats(null);
      setSavedItems([]);
      setIsAccepting(false);
    };
  }, [rtc, rtcState]);

  // Abandon an in-flight send if the card goes away.
  useEffect(() => () => { senderRef.current?.destroy(); }, []);

  const startTransfer = useCallback((files: FluxFile[]) => {
    if (files.length === 0) return;
    if (!rtc || !rtc.isOpen) {
      setNotice({ kind: 'error', text: 'Peer is not connected yet.' });
      return;
    }
    if (senderRef.current?.isActive) {
      setNotice({ kind: 'error', text: 'Already sending to this device.' });
      return;
    }

    setNotice(null);
    const sender = new FileSender(files, rtc, {
      onStats: stats => setSendStats(stats),
      onDone: () => {
        senderRef.current = null;
        setSendStats(null);
        setNotice({ kind: 'success', text: `Sent ${files.length} file${files.length === 1 ? '' : 's'}` });
      },
      onError: message => {
        senderRef.current = null;
        setSendStats(null);
        setNotice({ kind: 'error', text: message });
      },
      onCancelled: message => {
        senderRef.current = null;
        setSendStats(null);
        setNotice({ kind: 'info', text: message });
      },
    });
    senderRef.current = sender;
    sender.start();
  }, [rtc]);

  // "Send to all" from the header fans out through each card.
  useEffect(() => {
    if (!broadcast || broadcast.token === lastBroadcastRef.current) return;
    lastBroadcastRef.current = broadcast.token;
    startTransfer(broadcast.files);
  }, [broadcast, startTransfer]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  };
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    if (!e.dataTransfer) return;

    setIsPreparing(true);
    try {
      // Walks dropped directories — DataTransfer.files skips their contents.
      const files = await getFilesFromDataTransfer(e.dataTransfer);
      if (files.length === 0) {
        setNotice({ kind: 'error', text: 'Nothing to send in that drop.' });
        return;
      }
      startTransfer(files);
    } catch (err) {
      setNotice({ kind: 'error', text: `Could not read the dropped items: ${(err as Error).message}` });
    } finally {
      setIsPreparing(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = toFluxFiles(e.target.files);
    e.target.value = ''; // allow re-picking the same file
    startTransfer(files);
  };

  const acceptIncoming = (mode: SaveMode) => {
    setIncomingReq(null);
    // 'auto' opens a native picker; hold a placeholder so the card does not
    // flash its idle buttons while the dialog is up.
    setIsAccepting(true);
    void receiverRef.current?.accept(mode);
  };

  const declineIncoming = () => {
    receiverRef.current?.decline();
    setIncomingReq(null);
    setNotice({ kind: 'info', text: 'Transfer declined.' });
  };

  const dismissSaved = () => {
    receiverRef.current?.clearSavedItems();
    setSavedItems([]);
  };

  // ── Theme ──
  const status = peer.activeStatus || 'idle';
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

  const isIdle = !sendStats && !recvStats && !incomingReq && !isAccepting && rtcState === 'connected';
  const heavyZipRisk =
    !!incomingReq && !supportsFileSystemAccess() && incomingReq.totalSize > ZIP_MEMORY_WARN_BYTES;

  const subtitle = notice
    ? notice.text
    : rtcState === 'failed' ? 'Connection lost'
    : rtcState !== 'connected' ? 'Connecting...'
    : sendStats || recvStats ? 'Transfer in progress'
    : 'Ready for files';

  const subtitleClass = notice?.kind === 'error' ? 'text-red-400/70'
    : notice?.kind === 'success' ? 'text-green-400/70'
    : notice?.kind === 'info' ? 'text-white/50'
    : rtcState !== 'connected' ? 'text-amber-400/70'
    : `${themeText} transition-colors`;

  const sendTitle = sendStats?.phase === 'waiting'
    ? `Waiting for ${name} to accept…`
    : sendStats?.phase === 'packaging'
      ? `Finishing up on ${name}…`
      : `Sending ${baseName(sendStats?.fileName || '') || '...'}`;

  const recvTitle = recvStats?.phase === 'packaging'
    ? 'Packaging ZIP…'
    : `Receiving ${baseName(recvStats?.fileName || '') || '...'}`;

  return (
    <div
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative w-full rounded-2xl p-6 flex flex-col justify-center transition-all duration-300 overflow-hidden glass-panel
      ${isDragOver ? `scale-[1.02] ${themeBorder} ${themeShadow}` : "border-white/10"}`}
    >
      <input type="file" multiple ref={fileInputRef} onChange={handleFileSelect} className="hidden" />
      <input type="file" {...{webkitdirectory: "", directory: ""} as Record<string, string>} multiple ref={folderInputRef} onChange={handleFileSelect} className="hidden" />

      {/* Drop target feedback — previously the card scaled with no explanation */}
      {isDragOver && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm pointer-events-none">
          <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`${themeText} mb-3`}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <p className={`${themeText} font-semibold text-sm`}>Release to send to {name}</p>
          <p className="text-white/40 text-xs mt-1">Files and folders</p>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between z-10">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
            <DeviceIcon type={deviceType} color={themeStroke} />
          </div>
          <div className="min-w-0">
            <h3 className="text-white font-medium text-lg truncate">{name}</h3>
            <p className={`text-sm ${subtitleClass} truncate`} title={subtitle}>{subtitle}</p>
          </div>
        </div>
        <div className={`w-3 h-3 rounded-full ${themeBg} ${themeShadow} transition-colors duration-500 shrink-0`} />
      </div>

      {/* Dynamic Main Content Area */}
      <div className="z-10 mt-6 flex-1 flex flex-col justify-center gap-4">

        {rtcState === 'failed' && (
          <button
            onClick={onRetryConnection}
            className="w-full py-3 px-4 bg-white/5 border border-red-500/30 rounded-xl text-sm font-medium text-red-400 hover:bg-red-500 hover:text-white hover:border-transparent transition-all duration-300 flex items-center justify-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            Reconnect
          </button>
        )}

        {rtcState === 'connecting' && !sendStats && !recvStats && (
          <div className="flex items-center justify-center gap-3 text-white/30 text-sm py-3">
            <div className="w-4 h-4 border-2 border-white/20 border-t-amber-400 rounded-full animate-spin" />
            Negotiating a direct link…
          </div>
        )}

        {incomingReq && (
          <div className="flex flex-col gap-3 flux-pop">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-white font-medium text-sm">
                {incomingReq.totalFiles} incoming file{incomingReq.totalFiles === 1 ? '' : 's'}
              </p>
              <p className="text-white/40 text-xs">{formatBytes(incomingReq.totalSize)}</p>
            </div>

            {incomingReq.files.length > 0 && (
              <div className="max-h-24 overflow-y-auto rounded-xl bg-black/30 border border-white/5 divide-y divide-white/5">
                {incomingReq.files.slice(0, 50).map((file, i) => (
                  <div key={`${file.name}-${i}`} className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <span className="text-white/70 text-xs truncate" title={file.name}>{file.name}</span>
                    <span className="text-white/30 text-[10px] shrink-0">{formatBytes(file.size)}</span>
                  </div>
                ))}
                {(incomingReq.truncated || incomingReq.files.length > 50) && (
                  <div className="px-3 py-1.5 text-white/30 text-[10px]">
                    + {incomingReq.totalFiles - Math.min(50, incomingReq.files.length)} more
                  </div>
                )}
              </div>
            )}

            {heavyZipRisk && (
              <p className="text-amber-400/80 text-[11px] leading-relaxed">
                This browser has to hold the whole transfer in memory before saving.
                {' '}For {formatBytes(incomingReq.totalSize)} that may fail — a desktop Chrome or Edge tab can write straight to disk.
              </p>
            )}

            <div className="flex gap-3 w-full">
              <button
                onClick={declineIncoming}
                className="flex-1 py-2 px-4 bg-white/5 hover:bg-white/10 text-white/70 border border-white/20 rounded-xl text-sm font-medium transition-colors"
              >
                Decline
              </button>
              <button
                onClick={() => acceptIncoming('auto')}
                className={`flex-1 py-2 px-4 bg-transparent border ${themeBorder} ${themeText} rounded-xl text-sm font-bold transition-all duration-300 ${hoverBg} hover:shadow-[0_0_15px]`}
              >
                Accept
              </button>
            </div>

            {supportsFileSystemAccess() && incomingReq.totalFiles > 1 && (
              <button
                onClick={() => acceptIncoming('zip')}
                className="text-white/40 hover:text-white/70 text-[11px] underline underline-offset-2 transition-colors self-center"
              >
                Skip the folder picker — download as one ZIP
              </button>
            )}
          </div>
        )}

        {isAccepting && !recvStats && (
          <div className="flex items-center justify-center gap-3 text-white/40 text-sm py-3">
            <div className={`w-4 h-4 border-2 border-white/10 rounded-full animate-spin ${themeText}`} style={{ borderTopColor: 'currentColor' }} />
            Choose where to save…
          </div>
        )}

        {sendStats && (
          <TransferRow
            title={sendTitle}
            stats={sendStats}
            themeText={themeText}
            themeBg={themeBg}
            themeShadow={themeShadow}
            onCancel={() => senderRef.current?.cancel()}
          />
        )}

        {recvStats && (
          <TransferRow
            title={recvTitle}
            stats={recvStats}
            themeText={themeText}
            themeBg={themeBg}
            themeShadow={themeShadow}
            onCancel={() => void receiverRef.current?.cancel()}
          />
        )}

        {/* Saved blobs: browsers (iOS Safari especially) often swallow an
            automatic download, which used to lose the files silently. */}
        {savedItems.length > 0 && !recvStats && (
          <div className="flex flex-col gap-2 rounded-xl bg-green-500/5 border border-green-500/20 p-3 flux-pop">
            <div className="flex items-center justify-between gap-2">
              <p className="text-green-400/90 text-xs font-semibold">Ready to save</p>
              <button onClick={dismissSaved} className="text-white/30 hover:text-white/60 text-[10px] uppercase tracking-wider transition-colors">
                Dismiss
              </button>
            </div>
            {savedItems.map(item => (
              <a
                key={item.url}
                href={item.url}
                download={item.name}
                className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-white/5 border border-white/10 hover:bg-green-500/20 hover:border-green-500/40 transition-all"
              >
                <span className="text-white/80 text-xs truncate" title={item.name}>{item.name}</span>
                <span className="text-white/40 text-[10px] shrink-0">{formatBytes(item.size)}</span>
              </a>
            ))}
            <p className="text-white/30 text-[10px] leading-relaxed">
              Tap a file if your browser did not download it automatically.
            </p>
          </div>
        )}

        {isIdle && (
          <div className="flex flex-col gap-2">
            <div className="flex gap-4 items-center justify-center">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isPreparing}
                className={`flex-1 py-3 px-4 bg-white/5 border border-white/10 rounded-xl text-sm font-medium text-white/70 transition-all duration-300 disabled:opacity-40 ${hoverBg} hover:shadow-[0_0_15px] hover:border-transparent`}
              >
                {isPreparing ? 'Reading…' : 'Select Files'}
              </button>
              {canPickFolder && (
                <button
                  onClick={() => folderInputRef.current?.click()}
                  disabled={isPreparing}
                  className={`flex-1 py-3 px-4 bg-white/5 border border-white/10 rounded-xl text-sm font-medium text-white/70 transition-all duration-300 disabled:opacity-40 ${hoverBg} hover:shadow-[0_0_15px] hover:border-transparent`}
                >
                  Send Folder
                </button>
              )}
            </div>
            <p className="text-white/25 text-[10px] text-center">
              {canPickFolder ? 'or drop files and folders onto this card' : 'Folder sending is not supported by this browser'}
            </p>
          </div>
        )}
      </div>

    </div>
  );
}
