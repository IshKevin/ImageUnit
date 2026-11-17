import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';

/**
 * Minimal streaming ZIP writer. Entries are stored uncompressed (photos and videos are already
 * compressed), so the archive is produced as fast as storage can deliver the files, with only one
 * file open and one chunk in memory at a time. ZIP64 records are written only when sizes or
 * offsets need them, keeping ordinary archives readable by every unzip tool.
 */
export interface ZipEntry {
  name: string;
  date?: Date;
  /** Opens the file only when its turn comes; `size` must be exact. */
  open: () => Promise<{ body: AsyncIterable<Uint8Array>; size: number }>;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const FLAGS = 0x0008 | 0x0800; // sizes in a trailing data descriptor; UTF-8 names

function dosDateTime(d: Date) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface Written { name: Buffer; crc: number; size: number; offset: number; time: number; date: number; zip64: boolean }

async function* generate(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>): AsyncGenerator<Buffer> {
  const done: Written[] = [];
  let offset = 0;

  for await (const entry of entries) {
    const { body, size } = await entry.open();
    const name = Buffer.from(entry.name, 'utf8');
    const zip64 = size >= MAX32;
    const { time, date } = dosDateTime(entry.date ?? new Date());

    const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (zip64) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(16, 2); } // sizes follow in the descriptor
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(zip64 ? MAX32 : 0, 18);
    header.writeUInt32LE(zip64 ? MAX32 : 0, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(extra.length, 28);
    yield Buffer.concat([header, name, extra]);

    let crc = 0;
    let written = 0;
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      crc = crc32(buf, crc);
      written += buf.length;
      yield buf;
    }
    if (written !== size) throw new Error(`${entry.name}: expected ${size} bytes, read ${written}`);

    const descriptor = Buffer.alloc(zip64 ? 24 : 16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    if (zip64) {
      descriptor.writeBigUInt64LE(BigInt(size), 8);
      descriptor.writeBigUInt64LE(BigInt(size), 16);
    } else {
      descriptor.writeUInt32LE(size, 8);
      descriptor.writeUInt32LE(size, 12);
    }
    yield descriptor;

    done.push({ name, crc: crc >>> 0, size, offset, time, date, zip64 });
    offset += header.length + name.length + extra.length + size + descriptor.length;
  }

  // Central directory.
  const cdStart = offset;
  for (const e of done) {
    const bigSize = e.size >= MAX32;
    const bigOffset = e.offset >= MAX32;
    const fields: bigint[] = [];
    if (bigSize) fields.push(BigInt(e.size), BigInt(e.size));
    if (bigOffset) fields.push(BigInt(e.offset));
    const extra = Buffer.alloc(fields.length ? 4 + fields.length * 8 : 0);
    if (fields.length) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(fields.length * 8, 2);
      fields.forEach((v, i) => extra.writeBigUInt64LE(v, 4 + i * 8));
    }
    const needs64 = e.zip64 || bigOffset;
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE((3 << 8) | 45, 4); // made by: Unix, spec 4.5
    h.writeUInt16LE(needs64 ? 45 : 20, 6);
    h.writeUInt16LE(FLAGS, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(e.time, 12);
    h.writeUInt16LE(e.date, 14);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(bigSize ? MAX32 : e.size, 20);
    h.writeUInt32LE(bigSize ? MAX32 : e.size, 24);
    h.writeUInt16LE(e.name.length, 28);
    h.writeUInt16LE(extra.length, 30);
    h.writeUInt16LE(0, 32); // comment
    h.writeUInt16LE(0, 34); // disk
    h.writeUInt16LE(0, 36); // internal attributes
    h.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    h.writeUInt32LE(bigOffset ? MAX32 : e.offset, 42);
    yield Buffer.concat([h, e.name, extra]);
    offset += h.length + e.name.length + extra.length;
  }
  const cdSize = offset - cdStart;

  if (done.length >= MAX16 || cdStart >= MAX32 || cdSize >= MAX32) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE((3 << 8) | 45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeUInt32LE(0, 16);
    rec.writeUInt32LE(0, 20);
    rec.writeBigUInt64LE(BigInt(done.length), 24);
    rec.writeBigUInt64LE(BigInt(done.length), 32);
    rec.writeBigUInt64LE(BigInt(cdSize), 40);
    rec.writeBigUInt64LE(BigInt(cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(offset), 8);
    loc.writeUInt32LE(1, 16);
    yield Buffer.concat([rec, loc]);
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(done.length, MAX16), 8);
  end.writeUInt16LE(Math.min(done.length, MAX16), 10);
  end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
  end.writeUInt32LE(Math.min(cdStart, MAX32), 16);
  yield end;
}

export function zipStream(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>): Readable {
  return Readable.from(generate(entries), { objectMode: false });
}

/** A file name that is safe inside an archive on every operating system. */
export function safeZipName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '_').replace(/^[.\s]+/, '').trim();
  return cleaned.slice(0, 180) || 'file';
}
