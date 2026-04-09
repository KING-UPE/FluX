import { WebRTCConnection, ChunkData } from './webrtc';

const CHUNK_SIZE = 64 * 1024; // 64KB
const MAX_BUFFERED = 4 * 1024 * 1024; // 4MB backpressure

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

  public start() {
    if (!this.rtc.isOpen) {
      this.onError('P2P connection not ready.');
      return;
    }

    const payload = this.files.map(f => ({
      name: (f as any).webkitRelativePath || f.name,
      size: f.size,
      type: f.type
    }));

    this.rtc.send(JSON.stringify({
      type: 'transfer_req',
      totalFiles: this.files.length,
      totalSize: this.totalSize,
      files: payload,
    }));

    const handler = (data: ChunkData) => {
      if (typeof data === 'string') {
        const msg = JSON.parse(data);
        if (msg.type === 'ready') {
          this.startTime = Date.now();
          this.sendNextFile(0);
        }
        else if (msg.type === 'cancel') this.onError('Receiver declined the transfer.');
      }
    };
    this.rtc.onData(handler);
  }

  private async sendNextFile(index: number) {
    if (index >= this.files.length) {
      this.rtc.send(JSON.stringify({ type: 'all_done' }));
      this.onComplete();
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
        if (ch.bufferedAmount > MAX_BUFFERED) {
          await new Promise<void>(resolve => {
            ch.onbufferedamountlow = () => {
              ch.onbufferedamountlow = null;
              resolve();
            };
          });
        }

        const { done, value } = await reader.read();
        if (done) break;

        let localOffset = 0;
        while (localOffset < value.byteLength) {
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

  private updateStats() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    if (elapsed < 0.5) return; // Wait to stabilize

    const bytesPerSec = this.totalSent / elapsed;
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
        this.onComplete();
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
