import { VIDEO_TYPES, mimeFromName } from './uploader';

export interface ScanEntry {
  file: File;
  /** Path relative to the dropped/selected root, including the root folder name. */
  path: string;
  /** Gallery to create/use for this file; undefined = event default / chosen gallery. */
  galleryName?: string;
}
export interface ScanSummary {
  photos: number;
  videos: number;
  skipped: number;
  folders: number;
  totalBytes: number;
}
export interface ScanResult {
  entries: ScanEntry[];
  summary: ScanSummary;
  /** Distinct gallery names the entries would create, in first-seen order. */
  galleryNames: string[];
}

const MAX_NAME = 120;
const cleanName = (n: string) => n.trim().slice(0, MAX_NAME);

/** True for files we silently skip: hidden/system files and anything that is not an accepted media type. */
const isJunk = (name: string) => name.startsWith('.') || name.startsWith('~$') || !mimeFromName(name);

interface Raw {
  file: File;
  parts: string[];
}

/** Applies the gallery rule and builds the summary from `[root, dirA, ..., file]` path parts. */
function build(raw: Raw[], skipped: number, rootFolders: number): ScanResult {
  const entries: ScanEntry[] = [];
  const names = new Map<string, string>();
  const dirs = new Set<string>();
  let photos = 0;
  let videos = 0;
  let totalBytes = 0;
  for (const { file, parts } of raw) {
    let galleryName: string | undefined;
    if (parts.length >= 3) galleryName = cleanName(parts[1]!);
    else if (parts.length === 2 && rootFolders > 1) galleryName = cleanName(parts[0]!);
    if (galleryName) {
      const key = galleryName.toLowerCase();
      if (!names.has(key)) names.set(key, galleryName);
      galleryName = names.get(key);
    }
    if (parts.length > 1) dirs.add(parts.slice(0, -1).join('/'));
    if (VIDEO_TYPES.includes(mimeFromName(file.name))) videos++;
    else photos++;
    totalBytes += file.size;
    entries.push({ file, path: parts.join('/'), galleryName: galleryName || undefined });
  }
  return { entries, galleryNames: [...names.values()], summary: { photos, videos, skipped, folders: dirs.size, totalBytes } };
}

/** Result of an `<input type="file" webkitdirectory>` selection. */
export function scanFileList(files: FileList | File[]): ScanResult {
  const raw: Raw[] = [];
  const roots = new Set<string>();
  let skipped = 0;
  for (const file of Array.from(files)) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const parts = rel.split('/').filter(Boolean);
    if (parts.some((p, i) => i < parts.length - 1 && p.startsWith('.')) || isJunk(file.name)) {
      skipped++;
      continue;
    }
    if (parts.length > 1) roots.add(parts[0]!);
    raw.push({ file, parts });
  }
  return build(raw, skipped, roots.size);
}

const readFile = (e: FileSystemFileEntry) => new Promise<File>((res, rej) => e.file(res, rej));

async function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  // readEntries returns batches (~100) until it yields an empty array.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    all.push(...batch);
  }
  return all;
}

/** Result of a drag-and-drop; folders are walked recursively. Must be called synchronously from the drop handler. */
export async function scanDataTransfer(dt: DataTransfer): Promise<ScanResult> {
  // Entries are only valid during the event dispatch, so grab them all before awaiting anything.
  const top: FileSystemEntry[] = [];
  const loose: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry) top.push(entry);
    else {
      const f = item.getAsFile();
      if (f) loose.push(f);
    }
  }
  if (!top.length && !loose.length) loose.push(...Array.from(dt.files));

  const raw: Raw[] = [];
  let skipped = 0;
  let rootFolders = 0;

  async function walk(entry: FileSystemEntry, parts: string[]): Promise<void> {
    if (entry.isFile) {
      if (entry.name.startsWith('.') || isJunk(entry.name)) {
        skipped++;
        return;
      }
      try {
        raw.push({ file: await readFile(entry as FileSystemFileEntry), parts: [...parts, entry.name] });
      } catch {
        skipped++;
      }
    } else if (entry.isDirectory) {
      if (entry.name.startsWith('.')) return;
      let children: FileSystemEntry[] = [];
      try {
        children = await readAll(entry as FileSystemDirectoryEntry);
      } catch {
        return;
      }
      const next = [...parts, entry.name];
      const files = children.filter((c) => c.isFile);
      const dirs = children.filter((c) => c.isDirectory);
      for (let i = 0; i < files.length; i += 50) await Promise.all(files.slice(i, i + 50).map((c) => walk(c, next)));
      for (const d of dirs) await walk(d, next);
    }
  }

  for (const e of top) {
    if (e.isDirectory) rootFolders++;
    await walk(e, []);
  }
  for (const f of loose) {
    if (isJunk(f.name)) skipped++;
    else raw.push({ file: f, parts: [f.name] });
  }
  return build(raw, skipped, rootFolders);
}

/** True when a drop contains at least one directory (decided synchronously). */
export function dropHasFolder(dt: DataTransfer): boolean {
  return Array.from(dt.items ?? []).some((i) => i.kind === 'file' && typeof i.webkitGetAsEntry === 'function' && i.webkitGetAsEntry()?.isDirectory);
}
