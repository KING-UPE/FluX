import { WebRTCConnection, ChunkData } from './webrtc';

const CHUNK_SIZE = 16 * 1024; // safely 16KB maximum for iOS Safari SCTP limits
const MAX_BUFFERED = 1 * 1024 * 1024; // 1MB conservative backpressure limit

export interface TransferStats {
  progress: number; // 0-100
  speedStr: string; // "12.5 MB/s"
  etaStr: string; // "1:45"
  fileName: string;
}

export class FileSender {
  private files: File[];
  private rtc: WebRTCConnection;
  private onStats: (stats: TransferStats) => void;
  private onComplete: () => void;
  private onError: (msg: string) => void;

  private totalSize = 0;
  private totalSent = 0;
  private startTime = 0;
  private lastStatsTime = 0;
  private currentFileName = '';

  constructor(
    files: File[],
    rtc: WebRTCConnection,
    onStats: (stats: TransferStats) => void,
    onComplete: () => void,
    onError: (msg: string) => void
  ) {
    this.files = files;
    this.rtc = rtc;
    this.onStats = onStats;
    this.onComplete = onComplete;
    this.onError = onError;
    this.totalSize = files.reduce((acc, f) => acc + f.size, 0);
  }

  private isStarted = false;
  private responseHandler: ((data: ChunkData) => void) | null = null;

  public start() {
    if (this.isStarted) return;
    if (!this.rtc.isOpen) {
      this.onError('P2P connection not ready.');
      return;
    }
    this.isStarted = true;

    const payload = this.files.length <= 20 
      ? this.files.map(f => ({
          name: (f as any).webkitRelativePath || f.name,
          size: f.size,
          type: f.type
        }))
      : [{ 
          name: (this.files[0] as any).webkitRelativePath || this.files[0].name, 
          size: this.files[0].size, 
          type: this.files[0].type 
        }]; // Just send the first one as a sample for large transfers

    this.rtc.send(JSON.stringify({
      type: 'transfer_req',
      totalFiles: this.files.length,
      totalSize: this.totalSize,
      files: payload,
    }));

    this.responseHandler = (data: ChunkData) => {
      if (typeof data === 'string') {
        const msg = JSON.parse(data);
        if (msg.type === 'ready') {
          this.startTime = Date.now();
          this.updateStats(true); // Fire initial 0% progress immediately
          this.sendNextFile(0);
        }
        else if (msg.type === 'cancel') {
          this.cleanup();
          this.onError('Receiver declined the transfer.');
        }
        else if (msg.type === 'transfer_complete_ack') {
          this.cleanup();
          this.onComplete();
        }
      }
    };
    this.rtc.onData(this.responseHandler);
  }

  private cleanup() {
    if (this.responseHandler) {
      this.rtc.offData(this.responseHandler);
      this.responseHandler = null;
    }
  }

  private async sendNextFile(index: number) {
    if (index >= this.files.length) {
      this.updateStats(true); // Final 100% update
      this.rtc.send(JSON.stringify({ type: 'all_done' }));
      // We no longer call onComplete here. 
      // We wait for 'transfer_complete_ack' in the start() handler.
      return;
    }

    const file = this.files[index];
    this.currentFileName = (file as any).webkitRelativePath || file.name;

    this.rtc.send(JSON.stringify({
      type: 'file_start',
      name: this.currentFileName,
      size: file.size,
      mimeType: file.type,
    }));

    const ch = this.rtc.dataChannel;
    if (!ch || ch.readyState !== 'open') return;

    try {
      const stream = (file as any).stream();
      const reader = stream.getReader();
      let fileSent = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        let localOffset = 0;
        while (localOffset < value.byteLength) {
          if (ch.bufferedAmount > MAX_BUFFERED) {
            await new Promise<void>(resolve => {
              const timeout = setTimeout(() => {
                ch.onbufferedamountlow = null;
                resolve();
              }, 150); // safety fallback

              ch.onbufferedamountlow = () => {
                ch.onbufferedamountlow = null;
                clearTimeout(timeout);
                resolve();
              };
            });
          }

          const end = Math.min(localOffset + CHUNK_SIZE, value.byteLength);
          ch.send(value.slice(localOffset, end));
          localOffset = end;
        }

        fileSent += value.byteLength;
        this.totalSent += value.byteLength;
        this.updateStats();
      }

      this.rtc.send(JSON.stringify({ type: 'file_done' }));
      this.sendNextFile(index + 1);
    } catch (e) {
      this.onError('Streaming error: ' + (e as Error).message);
    }
  }

  private updateStats(force = false) {
    const now = Date.now();
    const elapsed = (now - this.startTime) / 1000;
    
    // Throttle updates to every 200ms unless forced (start/end)
    if (!force && now - this.lastStatsTime < 200) return;
    this.lastStatsTime = now;

    const bytesPerSec = elapsed > 0 ? this.totalSent / elapsed : 0;
    const mbps = (bytesPerSec / (1024 * 1024)).toFixed(1);
    
    const remainingBytes = this.totalSize - this.totalSent;
    const etaSecs = bytesPerSec > 0 ? remainingBytes / bytesPerSec : 0;
    
    let etaStr = '--:--';
    if (etaSecs > 0 && etaSecs < 7200) {
      const m = Math.floor(etaSecs / 60);
      const s = Math.floor(etaSecs % 60);
      etaStr = `${m}:${s.toString().padStart(2, '0')}`;
    }

    this.onStats({
      progress: this.totalSize === 0 ? 100 : (this.totalSent / this.totalSize) * 100,
      speedStr: `${mbps} MB/s`,
      etaStr,
      fileName: this.currentFileName
    });
  }
}

export interface IncomingRequest {
  totalFiles: number;
  totalSize: number;
  files: any[];
}

export class FileReceiver {
  private rtc: WebRTCConnection;
  private onTransferRequest: (req: IncomingRequest) => void;
  private onStats: (stats: TransferStats) => void;
  private onComplete: () => void;
  private onError: (msg: string) => void;

  private reqInfo: IncomingRequest | null = null;
  private outDirHandle: any = null; // window.showDirectoryPicker handle
  private currentWriter: any = null; // WritableStreamDefaultWriter
  private currentFileName = '';
  
  private totalSize = 0;
  private totalReceived = 0;
  private startTime = 0;

  // Fallback for mobile / no filesystem API
  private fallbackBuffers: ArrayBuffer[] = [];
  private fallbackMimes: Record<string, string> = {};
  private fallbackName = '';

  constructor(
    rtc: WebRTCConnection,
    onTransferRequest: (req: IncomingRequest) => void,
    onStats: (stats: TransferStats) => void,
    onComplete: () => void,
    onError: (msg: string) => void
  ) {
    this.rtc = rtc;
    this.onTransferRequest = onTransferRequest;
    this.onStats = onStats;
    this.onComplete = onComplete;
    this.onError = onError;
  }

  private queue: Promise<void> = Promise.resolve();

  public handleData(data: ChunkData) {
    // Chain every incoming chunk to ensure strict sequential disk writes
    this.queue = this.queue.then(() => this._processData(data)).catch(e => {
       console.error("Stream processing error:", e);
    });
  }

  private async _processData(data: ChunkData) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg.type === 'transfer_req') {
        this.reqInfo = msg;
        this.totalSize = msg.totalSize;
        this.onTransferRequest(this.reqInfo as IncomingRequest);
      } 
      else if (msg.type === 'file_start') {
        // Normalize any Windows-style backslashes to forward slashes
        const normalizedName = msg.name.replace(/\\/g, '/');
        this.currentFileName = normalizedName;
        this.fallbackName = normalizedName;
        this.fallbackMimes[normalizedName] = msg.mimeType;
        if (this.outDirHandle) {
          try {
            const paths = normalizedName.split('/');
            let currentDir = this.outDirHandle;
            // Create directories natively
            for (let i = 0; i < paths.length - 1; i++) {
              if (paths[i]) {
                currentDir = await currentDir.getDirectoryHandle(paths[i], { create: true });
              }
            }
            const fileHandle = await currentDir.getFileHandle(paths[paths.length - 1], { create: true });
            const writable = await fileHandle.createWritable();
            this.currentWriter = writable.getWriter();
          } catch (e) {
            console.error('FS Error:', e);
          }
        }
      }
      else if (msg.type === 'file_done') {
        if (this.currentWriter) {
          await this.currentWriter.close();
          this.currentWriter = null;
        } else if (this.outDirHandle) {
           // Should have writer if dir handle is present, but maybe it failed.
        } else {
           // Mobile fallback multi-download
           this.triggerMobileDownload();
        }
      }
      else if (msg.type === 'all_done') {
        // Wait for the disk queue to be completely empty before confirming
        this.queue.then(() => {
          this.rtc.send(JSON.stringify({ type: 'transfer_complete_ack' }));
          this.onComplete();
        });
      }
    } else {
      if (this.currentWriter) {
        await this.currentWriter.write(new Uint8Array(data));
      } else {
        this.fallbackBuffers.push(data);
      }
      this.totalReceived += data.byteLength;
      this.updateStats();
    }
  }

  public async accept() {
    if (!this.reqInfo) return;

    this.startTime = Date.now();

    if ('showDirectoryPicker' in window && this.reqInfo.totalFiles > 1) {
      try {
        this.outDirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
      } catch (e) {
        this.onError('Directory access denied.');
        this.rtc.send(JSON.stringify({ type: 'cancel' }));
        return;
      }
    } else if ('showSaveFilePicker' in window && this.reqInfo.totalFiles === 1) {
      try {
        const handle = await (window as any).showSaveFilePicker({ suggestedName: this.reqInfo.files[0].name });
        // We simulate a dir handle interface for exactly 1 file to reuse logic
        this.outDirHandle = {
          getDirectoryHandle: () => this.outDirHandle,
          getFileHandle: async () => handle
        };
      } catch (e) {
        this.onError('File access denied.');
        this.rtc.send(JSON.stringify({ type: 'cancel' }));
        return;
      }
    }

    this.rtc.send(JSON.stringify({ type: 'ready' }));
  }

  public decline() {
    this.rtc.send(JSON.stringify({ type: 'cancel' }));
  }

  private triggerMobileDownload() {
    if (this.fallbackBuffers.length === 0) return;
    const blob = new Blob(this.fallbackBuffers, { type: this.fallbackMimes[this.fallbackName] || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.fallbackName.split('/').pop() || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    this.fallbackBuffers = [];
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  private updateStats() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    if (elapsed < 0.5) return; 

    const bytesPerSec = this.totalReceived / elapsed;
    const mbps = (bytesPerSec / (1024 * 1024)).toFixed(1);
    
    const remainingBytes = this.totalSize - this.totalReceived;
    const etaSecs = bytesPerSec > 0 ? remainingBytes / bytesPerSec : 0;
    
    let etaStr = '--:--';
    if (etaSecs > 0 && etaSecs < 7200) {
      const m = Math.floor(etaSecs / 60);
      const s = Math.floor(etaSecs % 60);
      etaStr = `${m}:${s.toString().padStart(2, '0')}`;
    }

    this.onStats({
      progress: this.totalSize === 0 ? 100 : (this.totalReceived / this.totalSize) * 100,
      speedStr: `${mbps} MB/s`,
      etaStr,
      fileName: this.currentFileName
    });
  }
}
