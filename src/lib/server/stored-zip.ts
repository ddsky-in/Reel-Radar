import { setImmediate } from 'node:timers/promises';
import { ApiError } from './errors';

export interface StoredZipEntry { name: string; body: Blob; crc32: number }
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(bytes: Uint8Array, previous = 0): number {
  let crc = previous ^ 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export async function checksumStoredBlob(body: Blob, signal: AbortSignal): Promise<number> {
  let checksum = 0;
  // Yield between bounded blocks so cancellation and the request deadline remain responsive.
  for (let offset = 0; offset < body.size; offset += 64 * 1024) {
    signal.throwIfAborted();
    const bytes = new Uint8Array(await body.slice(offset, offset + 64 * 1024).arrayBuffer());
    signal.throwIfAborted();
    checksum = crc32(bytes, checksum);
    await setImmediate(undefined, { signal });
  }
  signal.throwIfAborted();
  return checksum;
}

function entryName(name: string): Uint8Array<ArrayBuffer> {
  const bytes = encoder.encode(name);
  if (!bytes.length || bytes.length > 255 || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes(':') || Array.from(name).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('Invalid ZIP filename');
  return bytes;
}

export function storedZipOverhead(names: string[]): number {
  return 22 + names.reduce((size, name) => size + 76 + entryName(name).length * 2, 0);
}

/** Bounded, uncompressed ZIP with UTF-8 names and deterministic timestamps. */
export function createStoredZip(entries: StoredZipEntry[], maximumBytes: number): Blob {
  if (!entries.length || entries.length > 65535 || new Set(entries.map(entry => entry.name)).size !== entries.length) throw new Error('Invalid ZIP entries');
  const names = entries.map(entry => entryName(entry.name));
  const size = storedZipOverhead(entries.map(entry => entry.name)) + entries.reduce((total, entry) => total + entry.body.size, 0);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 22 || size > maximumBytes || size > 0xffffffff) throw new ApiError(413, 'CAROUSEL_TOO_LARGE', 'The carousel exceeds the ZIP download limit.');
  const files: BlobPart[] = [], directory: BlobPart[] = [];
  let offset = 0, directorySize = 0;
  entries.forEach((entry, index) => {
    if (!Number.isInteger(entry.crc32) || entry.crc32 < 0 || entry.crc32 > 0xffffffff) throw new Error('Invalid ZIP checksum');
    const name = names[index], local = new Uint8Array(30 + name.length), localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(12, 33, true);
    localView.setUint32(14, entry.crc32, true);
    localView.setUint32(18, entry.body.size, true);
    localView.setUint32(22, entry.body.size, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    files.push(local, entry.body);
    const central = new Uint8Array(46 + name.length), centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(14, 33, true);
    centralView.setUint32(16, entry.crc32, true);
    centralView.setUint32(20, entry.body.size, true);
    centralView.setUint32(24, entry.body.size, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    directory.push(central);
    directorySize += central.length;
    offset += local.length + entry.body.size;
  });
  const end = new Uint8Array(22), endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);
  return new Blob([...files, ...directory, end], { type: 'application/zip' });
}
