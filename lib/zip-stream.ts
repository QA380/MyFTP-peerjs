// Streaming, store-only ZIP writer with ZIP64 support.
// Files are never fully loaded into memory: the CRC is computed by streaming each Blob,
// and the archive is emitted as small headers interleaved with the original Blobs.

export type ZipChunk = Uint8Array<ArrayBuffer> | Blob;

export type ZipSource = {
  name: string;
  getBlob: () => Promise<Blob>;
  lastModified?: Date;
};

const MAX_32 = 0xffffffff;
const MAX_16 = 0xffff;

let crcTable: Uint32Array | null = null;
const getCrcTable = () => {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }
  return crcTable;
};

const crc32OfBlob = async (blob: Blob): Promise<number> => {
  const table = getCrcTable();
  let crc = 0xffffffff;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let i = 0; i < value.length; i++) {
      crc = table[(crc ^ value[i]) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const toDosDateTime = (value: Date) => {
  const year = Math.min(Math.max(value.getFullYear(), 1980), 2107);
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
  };
};

const writeU64 = (view: DataView, offset: number, value: number) => {
  view.setUint32(offset, value % 0x100000000, true);
  view.setUint32(offset + 4, Math.floor(value / 0x100000000), true);
};

const encoder = new TextEncoder();

// Turn item names into safe, unique archive paths that keep their folder structure
export const normalizeZipPath = (rawName: string, used: Set<string>) => {
  const parts = rawName
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..");
  let path = parts.length > 0 ? parts.join("/") : "file";

  if (used.has(path.toLowerCase())) {
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
    const base = path.slice(slash + 1);
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    let n = 2;
    while (used.has(`${dir}${stem} (${n})${ext}`.toLowerCase())) n++;
    path = `${dir}${stem} (${n})${ext}`;
  }

  used.add(path.toLowerCase());
  return path;
};

type CentralRecord = {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
};

/** Writes a ZIP archive by passing each chunk, in order, to `write`. Entries are read one at a time. */
export const writeZip = async (
  entries: ZipSource[],
  write: (chunk: ZipChunk) => Promise<void> | void,
  onProgress?: (done: number, total: number) => void
) => {
  const used = new Set<string>();
  const records: CentralRecord[] = [];
  let offset = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const blob = await entry.getBlob();
    const nameBytes = encoder.encode(normalizeZipPath(entry.name, used));
    const size = blob.size;
    const crc = await crc32OfBlob(blob);
    const { time, date } = toDosDateTime(entry.lastModified ?? new Date());
    const zip64 = size >= MAX_32;

    const header = new Uint8Array(30 + nameBytes.length + (zip64 ? 20 : 0));
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, zip64 ? 45 : 20, true);
    view.setUint16(6, 0x0800, true); // UTF-8 names
    view.setUint16(8, 0, true); // stored, no compression
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, zip64 ? MAX_32 : size, true);
    view.setUint32(22, zip64 ? MAX_32 : size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, zip64 ? 20 : 0, true);
    header.set(nameBytes, 30);
    if (zip64) {
      const extra = 30 + nameBytes.length;
      view.setUint16(extra, 0x0001, true);
      view.setUint16(extra + 2, 16, true);
      writeU64(view, extra + 4, size);
      writeU64(view, extra + 12, size);
    }

    await write(header);
    await write(blob);
    records.push({ nameBytes, crc, size, offset, time, date });
    offset += header.length + size;
    onProgress?.(i + 1, entries.length);
  }

  const centralStart = offset;
  for (const record of records) {
    const sizeOverflow = record.size >= MAX_32;
    const offsetOverflow = record.offset >= MAX_32;
    const extraLen = sizeOverflow || offsetOverflow ? 4 + (sizeOverflow ? 16 : 0) + (offsetOverflow ? 8 : 0) : 0;
    const needs64 = extraLen > 0;

    const header = new Uint8Array(46 + record.nameBytes.length + extraLen);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 45, true);
    view.setUint16(6, needs64 ? 45 : 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, record.time, true);
    view.setUint16(14, record.date, true);
    view.setUint32(16, record.crc, true);
    view.setUint32(20, sizeOverflow ? MAX_32 : record.size, true);
    view.setUint32(24, sizeOverflow ? MAX_32 : record.size, true);
    view.setUint16(28, record.nameBytes.length, true);
    view.setUint16(30, extraLen, true);
    view.setUint32(42, offsetOverflow ? MAX_32 : record.offset, true);
    header.set(record.nameBytes, 46);
    if (needs64) {
      let p = 46 + record.nameBytes.length;
      view.setUint16(p, 0x0001, true);
      view.setUint16(p + 2, extraLen - 4, true);
      p += 4;
      if (sizeOverflow) {
        writeU64(view, p, record.size);
        writeU64(view, p + 8, record.size);
        p += 16;
      }
      if (offsetOverflow) {
        writeU64(view, p, record.offset);
      }
    }

    await write(header);
    offset += header.length;
  }

  const centralSize = offset - centralStart;
  const count = records.length;

  if (count >= MAX_16 || centralSize >= MAX_32 || centralStart >= MAX_32) {
    const end64 = new Uint8Array(56 + 20);
    const view = new DataView(end64.buffer);
    view.setUint32(0, 0x06064b50, true);
    writeU64(view, 4, 44);
    view.setUint16(12, 45, true);
    view.setUint16(14, 45, true);
    writeU64(view, 24, count);
    writeU64(view, 32, count);
    writeU64(view, 40, centralSize);
    writeU64(view, 48, centralStart);
    // ZIP64 end-of-central-directory locator
    view.setUint32(56, 0x07064b50, true);
    writeU64(view, 64, offset);
    view.setUint32(72, 1, true);
    await write(end64);
  }

  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, Math.min(count, MAX_16), true);
  view.setUint16(10, Math.min(count, MAX_16), true);
  view.setUint32(12, Math.min(centralSize, MAX_32), true);
  view.setUint32(16, Math.min(centralStart, MAX_32), true);
  await write(end);
};

/** Builds the archive as a Blob that references the source Blobs, so file data is not copied into memory. */
export const buildZipBlob = async (entries: ZipSource[], onProgress?: (done: number, total: number) => void) => {
  const parts: BlobPart[] = [];
  await writeZip(entries, (chunk) => {
    parts.push(chunk);
  }, onProgress);
  return new Blob(parts, { type: "application/zip" });
};
