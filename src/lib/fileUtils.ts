/**
 * Shared helpers for picking, describing and naming transferred files.
 *
 * A File on its own is not enough: folder transfers need the *relative* path
 * ("Photos/2024/a.jpg") and `webkitRelativePath` is read-only and empty for
 * drag-and-dropped files, so we carry the path alongside the File.
 */
export interface FluxFile {
  file: File;
  path: string;
}

// ── Formatting ──────────────────────────────────────────────

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : decimals)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 24 * 3600) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Path safety ─────────────────────────────────────────────
// File names arrive from a remote peer, so they are untrusted input. Without
// this, "../../evil.exe" would escape the directory the receiver picked.

const INVALID_CHARS = /[<>:"|?*]/g;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/** Drop control characters without needing an escape-laden regex literal. */
function stripControlChars(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 32 && code !== 127) out += input[i];
  }
  return out;
}

export function sanitizeSegment(segment: string): string {
  let s = stripControlChars(segment).replace(INVALID_CHARS, '_').trim();
  s = s.replace(/[. ]+$/, ''); // Windows rejects trailing dots/spaces
  if (!s || s === '.' || s === '..') s = '_';
  if (RESERVED.test(s)) s = `_${s}`;
  return s.slice(0, 180);
}

export function sanitizePath(path: string): string {
  const cleaned = String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '') // strip Windows drive letters
    .split('/')
    .filter(seg => seg && seg !== '.' && seg !== '..')
    .map(sanitizeSegment)
    .join('/');
  return cleaned || 'file';
}

export function baseName(path: string): string {
  const parts = sanitizePath(path).split('/');
  return parts[parts.length - 1] || 'download';
}

// ── Capability probes ───────────────────────────────────────

/** Chrome/Edge desktop can stream straight to disk. Safari/Firefox/mobile cannot. */
export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

export function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** iOS Safari has no folder <input>, so the "Send Folder" button is a dead end there. */
export function supportsDirectoryInput(): boolean {
  if (typeof document === 'undefined') return false;
  const input = document.createElement('input');
  return 'webkitdirectory' in input;
}

export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}

// ── File collection ─────────────────────────────────────────

export function toFluxFiles(input: FileList | File[] | null | undefined): FluxFile[] {
  if (!input) return [];
  return Array.from(input).map(file => ({
    file,
    path: sanitizePath((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name),
  }));
}

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (cb: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (cb: (e: FsEntry[]) => void, err: (e: unknown) => void) => void };
}

async function walkEntry(entry: FsEntry, prefix: string, out: FluxFile[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File | null>(resolve => {
      entry.file!(resolve, () => resolve(null));
    });
    if (file) out.push({ file, path: sanitizePath(prefix + entry.name) });
    return;
  }

  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    const children: FsEntry[] = [];
    // readEntries returns at most ~100 entries per call — keep going until empty.
    for (;;) {
      const batch = await new Promise<FsEntry[]>(resolve => {
        reader.readEntries(resolve, () => resolve([]));
      });
      if (batch.length === 0) break;
      children.push(...batch);
    }
    for (const child of children) {
      await walkEntry(child, `${prefix}${entry.name}/`, out);
    }
  }
}

/**
 * Expand a drop into a flat file list, recursing into dropped folders.
 * `DataTransfer.files` alone silently ignores directories, which is why
 * dragging a folder onto a device card used to do nothing.
 */
export async function getFilesFromDataTransfer(dt: DataTransfer): Promise<FluxFile[]> {
  const entries: FsEntry[] = [];

  // The item list is invalidated by the first await, so snapshot entries first.
  if (dt.items?.length) {
    for (const item of Array.from(dt.items)) {
      if (item.kind !== 'file') continue;
      const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null })
        .webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
  }

  if (entries.length === 0) return toFluxFiles(dt.files);

  const out: FluxFile[] = [];
  for (const entry of entries) {
    await walkEntry(entry, '', out);
  }
  // Directories that turned out to be empty leave nothing behind — fall back.
  return out.length > 0 ? out : toFluxFiles(dt.files);
}

export function totalSizeOf(files: FluxFile[]): number {
  return files.reduce((sum, f) => sum + f.file.size, 0);
}
