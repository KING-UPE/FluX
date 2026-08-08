import { WebRTCConnection, ChunkData, DC_LOW_WATER } from './webrtc';
import JSZip from 'jszip';
import {
  FluxFile,
  sanitizePath,
  baseName,
  formatBytes,
  formatDuration,
  supportsFileSystemAccess,
  supportsDirectoryPicker,
} from './fileUtils';

const CHUNK_SIZE = 16 * 1024;            // iOS Safari SCTP is unhappy above this
const READ_SIZE = 2 * 1024 * 1024;       // how much of the file we pull into memory at once
const HIGH_WATER = 2 * 1024 * 1024;      // pause sending once this much is queued
const ACCEPT_TIMEOUT = 120_000;          // give up if the peer never answers
const MAX_LISTED_FILES = 200;            // cap the preview list in the request payload

/** Above this, an in-memory ZIP is a real risk of crashing the receiving tab. */
export const ZIP_MEMORY_WARN_BYTES = 1.5 * 1024 * 1024 * 1024;

export type TransferPhase = 'waiting' | 'transferring' | 'packaging' | 'done';
export type SaveMode = 'auto' | 'zip';
/** Where the received bytes actually end up. */
export type SaveTarget = 'disk' | 'zip' | 'download';

export interface TransferStats {
  progress: number;      // 0-100
  speedStr: string;      // "12.5 MB/s"
  etaStr: string;        // "1:45"
  fileName: string;
  bytesDone: number;
  totalBytes: number;
  fileIndex: number;     // 1-based, for "3 of 12"
  totalFiles: number;
  phase: TransferPhase;
  saveTarget?: SaveTarget;
}

export interface IncomingFileInfo {
  name: string;
  size: number;
  type: string;
}

export interface IncomingRequest {
  id: string;
  totalFiles: number;
  totalSize: number;
  files: IncomingFileInfo[];
  /** True when the sender only listed the first MAX_LISTED_FILES names. */
  truncated: boolean;
}

/** A finished download the user can re-save if the browser blocked the auto-click. */
export interface SavedItem {
  name: string;
  url: string;
  size: number;
}

/** File System Access API — still absent from TS's DOM lib. */
interface FilePickerWindow {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
}

/** Every control frame that crosses the data channel. */
interface ControlMessage {
  type?: string;
  id?: string;
  reason?: string;
  index?: number;
  name?: string;
  size?: number;
  mimeType?: string;
  totalFiles?: number;
  totalSize?: number;
  truncated?: boolean;
  files?: IncomingFileInfo[];
}

function newTransferId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Blob.arrayBuffer() is missing on older iOS Safari; fall back to FileReader. */
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Read failed'));
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Speed over a trailing window rather than the whole transfer, so the number
 * reacts to the link actually slowing down instead of drifting toward an average.
 */
class SpeedMeter {
  private samples: Array<[number, number]> = [];

  reset() { this.samples = []; }

  push(totalBytes: number) {
    const now = Date.now();
    this.samples.push([now, totalBytes]);
    while (this.samples.length > 2 && now - this.samples[0][0] > 3000) this.samples.shift();
  }

  bytesPerSecond(): number {
    if (this.samples.length < 2) return 0;
    const [t0, b0] = this.samples[0];
    const [t1, b1] = this.samples[this.samples.length - 1];
    const dt = (t1 - t0) / 1000;
    return dt > 0 ? Math.max(0, (b1 - b0) / dt) : 0;
  }
}

// ════════════════════════════════════════════════════════════
//  Sender
// ════════════════════════════════════════════════════════════

export interface SenderCallbacks {
  onStats: (stats: TransferStats) => void;
  onDone: () => void;
  onError: (message: string) => void;
  onCancelled: (message: string) => void;
}

export class FileSender {
  public readonly id = newTransferId();

  private files: FluxFile[];
  private rtc: WebRTCConnection;
  private cb: SenderCallbacks;

  private totalSize = 0;
  private totalSent = 0;
  private fileIndex = 0;
  private currentName = '';
  private phase: TransferPhase = 'waiting';

  private meter = new SpeedMeter();
  private lastEmit = 0;
  private started = false;
  private stopped = false;

  private dataHandler: ((data: ChunkData) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private acceptTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(files: FluxFile[], rtc: WebRTCConnection, cb: SenderCallbacks) {
    this.files = files;
    this.rtc = rtc;
    this.cb = cb;
    this.totalSize = files.reduce((sum, f) => sum + f.file.size, 0);
  }

  public get isActive(): boolean {
    return this.started && !this.stopped;
  }

  public start() {
    if (this.started) return;
    this.started = true;

    if (this.files.length === 0) { this.fail('No files selected.'); return; }
    if (!this.rtc.isOpen) { this.fail('Peer is not connected.'); return; }

    this.dataHandler = data => { if (typeof data === 'string') this.handleControl(data); };
    this.rtc.onData(this.dataHandler);

    this.closeHandler = () => this.fail('Connection to peer was lost.');
    this.rtc.onClose(this.closeHandler);

    this.rtc.send(JSON.stringify({
      type: 'transfer_req',
      id: this.id,
      totalFiles: this.files.length,
      totalSize: this.totalSize,
      truncated: this.files.length > MAX_LISTED_FILES,
      files: this.files.slice(0, MAX_LISTED_FILES).map(f => ({
        name: f.path,
        size: f.file.size,
        type: f.file.type,
      })),
    }));

    this.emit(true);
    this.acceptTimer = setTimeout(() => {
      if (this.phase === 'waiting') this.fail('Peer did not respond in time.');
    }, ACCEPT_TIMEOUT);
  }

  /** Stop sending and tell the peer, e.g. the user pressed Cancel. */
  public cancel(message = 'Transfer cancelled.') {
    if (this.stopped) return;
    try { this.rtc.send(JSON.stringify({ type: 'cancel', id: this.id, reason: 'sender_cancel' })); } catch {}
    this.teardown();
    this.cb.onCancelled(message);
  }

  /** Drop listeners without notifying anyone — used when the card unmounts. */
  public destroy() {
    this.teardown();
  }

  private handleControl(raw: string) {
    let msg: ControlMessage;
    try { msg = JSON.parse(raw) as ControlMessage; } catch { return; }
    // Messages for someone else's transfer (or the peer's own outgoing one).
    if (!msg.id || msg.id !== this.id) return;
    if (this.stopped) return;

    if (msg.type === 'ready' && this.phase === 'waiting') {
      if (this.acceptTimer) { clearTimeout(this.acceptTimer); this.acceptTimer = null; }
      this.phase = 'transferring';
      this.meter.reset();
      this.meter.push(0);
      this.emit(true);
      void this.pump();
    } else if (msg.type === 'cancel') {
      this.teardown();
      this.cb.onCancelled(
        msg.reason === 'busy'
          ? 'Peer is busy with another transfer.'
          : 'Peer declined the transfer.'
      );
    } else if (msg.type === 'transfer_complete_ack') {
      this.phase = 'done';
      this.emit(true);
      this.teardown();
      this.cb.onDone();
    }
  }

  private async pump() {
    const channel = this.rtc.dataChannel;
    if (!channel) { this.fail('Data channel unavailable.'); return; }

    try {
      for (let i = 0; i < this.files.length; i++) {
        if (this.stopped) return;

        const { file, path } = this.files[i];
        this.fileIndex = i;
        this.currentName = path;

        this.rtc.send(JSON.stringify({
          type: 'file_start',
          id: this.id,
          index: i,
          name: path,
          size: file.size,
          mimeType: file.type,
        }));
        this.emit(true);

        let offset = 0;
        while (offset < file.size) {
          if (this.stopped) return;
          if (channel.readyState !== 'open') { this.fail('Connection to peer was lost.'); return; }

          const slice = file.slice(offset, Math.min(offset + READ_SIZE, file.size));
          const buffer = new Uint8Array(await readBlob(slice));
          if (buffer.byteLength === 0) {
            // The file shrank or became unreadable (moved/unmounted mid-transfer).
            this.fail(`Could not read "${baseName(path)}" — the file may have changed.`);
            return;
          }
          offset += buffer.byteLength;

          let pos = 0;
          while (pos < buffer.byteLength) {
            if (this.stopped) return;
            if (channel.readyState !== 'open') { this.fail('Connection to peer was lost.'); return; }

            await this.waitForDrain(channel);
            if (this.stopped) return;
            if (channel.readyState !== 'open') { this.fail('Connection to peer was lost.'); return; }

            const end = Math.min(pos + CHUNK_SIZE, buffer.byteLength);
            channel.send(buffer.slice(pos, end));
            this.totalSent += end - pos;
            pos = end;
            this.emit();
          }
        }

        if (this.stopped) return;
        this.rtc.send(JSON.stringify({ type: 'file_done', id: this.id, index: i }));
      }

      if (this.stopped) return;
      this.fileIndex = Math.max(0, this.files.length - 1);
      this.rtc.send(JSON.stringify({ type: 'all_done', id: this.id }));

      // Bytes are out the door, but the receiver may still be zipping or
      // flushing to disk — say so instead of sitting at "Sending 100%".
      this.phase = 'packaging';
      this.emit(true);
    } catch (e) {
      this.fail(`Transfer failed: ${(e as Error).message}`);
    }
  }

  /**
   * Block until the outgoing buffer drains. The previous implementation gave up
   * after a fixed 150 ms whether or not the buffer had cleared, which let the
   * queue grow unbounded on slow links until send() threw.
   */
  private waitForDrain(channel: RTCDataChannel): Promise<void> {
    if (channel.bufferedAmount <= HIGH_WATER) return Promise.resolve();

    return new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        channel.removeEventListener('bufferedamountlow', onLow);
        clearInterval(poll);
        resolve();
      };
      const onLow = () => finish();
      channel.addEventListener('bufferedamountlow', onLow);
      // Safety net: some browsers drop bufferedamountlow under load.
      const poll = setInterval(() => {
        if (this.stopped || channel.readyState !== 'open' || channel.bufferedAmount <= DC_LOW_WATER) {
          finish();
        }
      }, 50);
    });
  }

  private emit(force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 150) return;
    this.lastEmit = now;

    this.meter.push(this.totalSent);
    const bps = this.meter.bytesPerSecond();
    const remaining = Math.max(0, this.totalSize - this.totalSent);

    this.cb.onStats({
      progress: this.totalSize === 0
        ? (this.phase === 'waiting' ? 0 : 100)
        : Math.min(100, (this.totalSent / this.totalSize) * 100),
      speedStr: `${formatBytes(bps)}/s`,
      etaStr: bps > 0 && remaining > 0 ? formatDuration(remaining / bps) : '--:--',
      fileName: this.currentName,
      bytesDone: this.totalSent,
      totalBytes: this.totalSize,
      fileIndex: Math.min(this.fileIndex + 1, this.files.length),
      totalFiles: this.files.length,
      phase: this.phase,
    });
  }

  private fail(message: string) {
    if (this.stopped) return;
    this.teardown();
    this.cb.onError(message);
  }

  private teardown() {
    this.stopped = true;
    if (this.acceptTimer) { clearTimeout(this.acceptTimer); this.acceptTimer = null; }
    if (this.dataHandler) { this.rtc.offData(this.dataHandler); this.dataHandler = null; }
    if (this.closeHandler) { this.rtc.offClose(this.closeHandler); this.closeHandler = null; }
  }
}

// ════════════════════════════════════════════════════════════
//  Receiver
// ════════════════════════════════════════════════════════════

export interface ReceiverCallbacks {
  onRequest: (req: IncomingRequest) => void;
  onStats: (stats: TransferStats) => void;
  onDone: (fileCount: number) => void;
  onError: (message: string) => void;
  onCancelled: (message: string) => void;
  /** Blobs ready to save — shown as tappable links when auto-download is blocked. */
  onSaveReady: (items: SavedItem[]) => void;
}

export class FileReceiver {
  private rtc: WebRTCConnection;
  private cb: ReceiverCallbacks;

  private request: IncomingRequest | null = null;
  private activeId: string | null = null;
  private accepted = false;

  // Native filesystem targets (Chrome/Edge desktop)
  private outDirHandle: FileSystemDirectoryHandle | null = null;
  private singleFileHandle: FileSystemFileHandle | null = null;
  private writer: FileSystemWritableFileStream | null = null;

  // Buffered targets (everything else)
  private zip: JSZip | null = null;
  private buffers: ArrayBuffer[] = [];
  private savedItems: SavedItem[] = [];

  private currentName = '';
  private currentMime = '';
  private fileIndex = 0;
  private filesWritten = 0;
  private saveTarget: SaveTarget = 'download';

  private totalSize = 0;
  private totalReceived = 0;
  private packagingPercent = 0;
  private phase: TransferPhase = 'waiting';

  private meter = new SpeedMeter();
  private lastEmit = 0;
  private queue: Promise<void> = Promise.resolve();
  private destroyed = false;
  private closeHandler: (() => void) | null = null;

  constructor(rtc: WebRTCConnection, cb: ReceiverCallbacks) {
    this.rtc = rtc;
    this.cb = cb;
    this.closeHandler = () => {
      if (this.activeId && this.accepted) {
        this.resetTransfer();
        this.cb.onError('Connection to peer was lost.');
      }
    };
    this.rtc.onClose(this.closeHandler);
  }

  /** Chunks are chained so writes to disk stay strictly in order. */
  public handleData(data: ChunkData) {
    if (this.destroyed) return;
    this.queue = this.queue
      .then(() => this.processData(data))
      .catch(e => console.error('Stream processing error:', e));
  }

  public get isReceiving(): boolean {
    return this.accepted && this.activeId !== null;
  }

  public get hasPendingRequest(): boolean {
    return this.request !== null && !this.accepted;
  }

  private async processData(data: ChunkData) {
    if (typeof data !== 'string') {
      // Binary before an accept means a stale/unsolicited chunk — drop it.
      if (!this.accepted) return;
      await this.writeChunk(data);
      return;
    }

    let msg: ControlMessage;
    try { msg = JSON.parse(data) as ControlMessage; } catch { return; }

    switch (msg.type) {
      case 'transfer_req':
        await this.onRequest(msg);
        return;
      case 'cancel':
        if (msg.id && msg.id === this.activeId) {
          await this.abortWriting();
          this.resetTransfer();
          this.cb.onCancelled('Sender cancelled the transfer.');
        }
        return;
      case 'file_start':
        if (this.guard(msg.id)) await this.onFileStart(msg);
        return;
      case 'file_done':
        if (this.guard(msg.id)) await this.onFileDone();
        return;
      case 'all_done':
        if (this.guard(msg.id)) await this.onAllDone();
        return;
      default:
        // 'ready' / 'transfer_complete_ack' belong to our own outgoing transfer.
        return;
    }
  }

  private guard(id: string | undefined): boolean {
    return this.accepted && !!id && id === this.activeId;
  }

  private async onRequest(msg: ControlMessage) {
    // One transfer at a time per peer — otherwise two file streams interleave
    // on the same channel and both land corrupted.
    if (this.activeId && this.accepted) {
      this.rtc.send(JSON.stringify({ type: 'cancel', id: msg.id, reason: 'busy' }));
      return;
    }

    this.resetTransfer();
    this.clearSavedItems();

    this.request = {
      id: msg.id ?? newTransferId(),
      totalFiles: msg.totalFiles ?? 0,
      totalSize: msg.totalSize ?? 0,
      files: Array.isArray(msg.files) ? msg.files : [],
      truncated: !!msg.truncated,
    };
    this.activeId = this.request.id;
    this.totalSize = this.request.totalSize;
    this.cb.onRequest(this.request);
  }

  /**
   * @param mode 'auto' streams straight to disk where the browser allows it,
   *             'zip' always produces a single downloadable archive.
   */
  public async accept(mode: SaveMode = 'auto') {
    const req = this.request;
    if (!req || this.accepted) return;

    const multiple = req.totalFiles > 1;

    const picker = (typeof window !== 'undefined' ? window : {}) as unknown as FilePickerWindow;

    if (mode === 'auto' && supportsFileSystemAccess()) {
      try {
        if (multiple && supportsDirectoryPicker() && picker.showDirectoryPicker) {
          this.outDirHandle = await picker.showDirectoryPicker({ mode: 'readwrite' });
          this.saveTarget = 'disk';
        } else if (!multiple && picker.showSaveFilePicker) {
          this.singleFileHandle = await picker.showSaveFilePicker({
            // Must be a bare file name — a folder transfer's "dir/file.txt" throws.
            suggestedName: baseName(req.files[0]?.name || 'download'),
          });
          this.saveTarget = 'disk';
        }
      } catch {
        // Dismissing the picker used to abort the whole transfer. Fall back to
        // a download instead so the files still arrive.
        this.outDirHandle = null;
        this.singleFileHandle = null;
      }
    }

    if (this.saveTarget !== 'disk') {
      this.saveTarget = multiple ? 'zip' : 'download';
      if (multiple) this.zip = new JSZip();
    }

    this.accepted = true;
    this.phase = 'transferring';
    this.meter.reset();
    this.meter.push(0);
    this.emit(true);

    this.rtc.send(JSON.stringify({ type: 'ready', id: this.activeId }));
  }

  public decline() {
    if (!this.request) return;
    this.rtc.send(JSON.stringify({ type: 'cancel', id: this.activeId, reason: 'declined' }));
    this.resetTransfer();
  }

  /** Abort a transfer that is already running. */
  public async cancel(message = 'Transfer cancelled.') {
    if (!this.activeId) return;
    this.rtc.send(JSON.stringify({ type: 'cancel', id: this.activeId, reason: 'receiver_cancel' }));
    await this.abortWriting();
    this.resetTransfer();
    this.cb.onCancelled(message);
  }

  public destroy() {
    this.destroyed = true;
    if (this.closeHandler) { this.rtc.offClose(this.closeHandler); this.closeHandler = null; }
    void this.abortWriting();
    this.clearSavedItems();
  }

  // ── Writing ───────────────────────────────────────────────

  private async onFileStart(msg: ControlMessage) {
    this.currentName = sanitizePath(msg.name ?? 'file');
    this.currentMime = msg.mimeType || 'application/octet-stream';
    this.fileIndex = typeof msg.index === 'number' ? msg.index : this.fileIndex;
    this.buffers = [];
    this.writer = null;

    if (this.outDirHandle || this.singleFileHandle) {
      try {
        this.writer = await this.openWriter(this.currentName);
      } catch (e) {
        // Out of quota, permission revoked, illegal name… buffer it instead of
        // dropping the bytes on the floor like the previous version did.
        console.error('Filesystem write failed, falling back to download:', e);
        this.writer = null;
        this.outDirHandle = null;
        this.singleFileHandle = null;
        this.saveTarget = (this.request?.totalFiles ?? 1) > 1 ? 'zip' : 'download';
        if (this.saveTarget === 'zip' && !this.zip) this.zip = new JSZip();
      }
    }

    this.emit(true);
  }

  private async openWriter(name: string): Promise<FileSystemWritableFileStream> {
    if (this.singleFileHandle) {
      return await this.singleFileHandle.createWritable();
    }

    const segments = name.split('/');
    let dir = this.outDirHandle!;
    for (let i = 0; i < segments.length - 1; i++) {
      dir = await dir.getDirectoryHandle(segments[i], { create: true });
    }
    const handle = await dir.getFileHandle(segments[segments.length - 1], { create: true });
    return await handle.createWritable();
  }

  private async writeChunk(data: ArrayBuffer) {
    if (this.writer) {
      try {
        await this.writer.write(new Uint8Array(data));
      } catch (e) {
        console.error('Write error:', e);
        this.writer = null;
        this.buffers.push(data);
      }
    } else {
      this.buffers.push(data);
    }

    this.totalReceived += data.byteLength;
    this.emit();
  }

  private async onFileDone() {
    if (this.writer) {
      try { await this.writer.close(); } catch (e) { console.error('Close error:', e); }
      this.writer = null;
    } else if (this.zip) {
      // Blob (not ArrayBuffer) keeps large files off the JS heap where possible.
      this.zip.file(this.currentName, new Blob(this.buffers, { type: this.currentMime }));
      this.buffers = [];
    } else {
      // Single-file, no filesystem API: hand it straight to the browser.
      this.stageBlob(baseName(this.currentName), new Blob(this.buffers, { type: this.currentMime }));
      this.buffers = [];
    }
    this.filesWritten++;
  }

  private async onAllDone() {
    if (this.zip) {
      this.phase = 'packaging';
      this.packagingPercent = 0;
      this.emit(true);

      const archive = this.zip;
      this.zip = null;
      try {
        const blob = await archive.generateAsync(
          // STORE, not DEFLATE: transferred media is already compressed, and
          // deflating gigabytes in the main thread freezes the tab.
          { type: 'blob', compression: 'STORE', streamFiles: false },
          meta => {
            this.packagingPercent = meta.percent;
            this.emit();
          }
        );
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        this.stageBlob(`flux-${stamp}.zip`, blob);
      } catch (e) {
        this.resetTransfer();
        this.cb.onError(`Could not build the ZIP: ${(e as Error).message}`);
        return;
      }
    }

    const count = this.filesWritten;
    this.phase = 'done';
    this.emit(true);

    this.rtc.send(JSON.stringify({ type: 'transfer_complete_ack', id: this.activeId }));
    this.activeId = null;
    this.accepted = false;
    this.request = null;
    this.cb.onDone(count);
  }

  // ── Saving to the browser ─────────────────────────────────

  private stageBlob(name: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    this.savedItems = [...this.savedItems, { name, url, size: blob.size }];
    // Publish first: if the browser blocks the programmatic click (common on
    // iOS Safari) the user still has a real link to tap.
    this.cb.onSaveReady(this.savedItems);
    this.triggerDownload(name, url);
  }

  private triggerDownload(name: string, url: string) {
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      console.warn('Automatic download blocked, manual save available:', e);
    }
  }

  public clearSavedItems() {
    this.savedItems.forEach(item => URL.revokeObjectURL(item.url));
    this.savedItems = [];
    this.cb.onSaveReady([]);
  }

  // ── Bookkeeping ───────────────────────────────────────────

  private async abortWriting() {
    if (this.writer) {
      try { await this.writer.abort(); } catch {}
      this.writer = null;
    }
  }

  /** Reset every per-transfer counter. Skipping this made a second transfer
   *  report >100% progress and a nonsense ETA. */
  private resetTransfer() {
    this.request = null;
    this.activeId = null;
    this.accepted = false;
    this.outDirHandle = null;
    this.singleFileHandle = null;
    this.writer = null;
    this.zip = null;
    this.buffers = [];
    this.currentName = '';
    this.currentMime = '';
    this.fileIndex = 0;
    this.filesWritten = 0;
    this.totalSize = 0;
    this.totalReceived = 0;
    this.packagingPercent = 0;
    this.saveTarget = 'download';
    this.phase = 'waiting';
    this.meter.reset();
  }

  private emit(force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 150) return;
    this.lastEmit = now;

    this.meter.push(this.totalReceived);
    const bps = this.meter.bytesPerSecond();
    const remaining = Math.max(0, this.totalSize - this.totalReceived);

    const progress = this.phase === 'packaging'
      ? this.packagingPercent
      : this.totalSize === 0
        ? (this.phase === 'done' ? 100 : 0)
        : Math.min(100, (this.totalReceived / this.totalSize) * 100);

    this.cb.onStats({
      progress,
      speedStr: `${formatBytes(bps)}/s`,
      etaStr: bps > 0 && remaining > 0 ? formatDuration(remaining / bps) : '--:--',
      fileName: this.currentName,
      bytesDone: this.totalReceived,
      totalBytes: this.totalSize,
      fileIndex: Math.min(this.fileIndex + 1, Math.max(1, this.request?.totalFiles ?? 1)),
      totalFiles: this.request?.totalFiles ?? 1,
      phase: this.phase,
      saveTarget: this.saveTarget,
    });
  }
}
