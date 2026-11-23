/**
 * Minimal ZIP writer (deflate), used to produce the `.xpi` package without
 * depending on the system `zip` binary.
 */

import { deflateRawSync } from "node:zlib";
import { crc32 } from "./crc32";

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

class ByteWriter {
  private parts: Uint8Array[] = [];
  length = 0;

  bytes(data: Uint8Array): void {
    this.parts.push(data);
    this.length += data.length;
  }

  u16(value: number): void {
    const buffer = new Uint8Array(2);
    new DataView(buffer.buffer).setUint16(0, value, true);
    this.bytes(buffer);
  }

  u32(value: number): void {
    const buffer = new Uint8Array(4);
    new DataView(buffer.buffer).setUint32(0, value >>> 0, true);
    this.bytes(buffer);
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

/** DOS date/time, required by the ZIP format. */
function dosDateTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

interface CentralRecord {
  name: Uint8Array;
  crc: number;
  compressedSize: number;
  rawSize: number;
  offset: number;
}

export function createZip(entries: ZipEntry[], now = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const writer = new ByteWriter();
  const records: CentralRecord[] = [];

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const compressed = new Uint8Array(deflateRawSync(entry.data));
    const offset = writer.length;

    writer.u32(0x04034b50); // local file header
    writer.u16(20); // version needed to extract
    writer.u16(0x0800); // UTF-8 file names
    writer.u16(8); // deflate
    writer.u16(time);
    writer.u16(date);
    writer.u32(crc);
    writer.u32(compressed.length);
    writer.u32(entry.data.length);
    writer.u16(name.length);
    writer.u16(0); // extra field length
    writer.bytes(name);
    writer.bytes(compressed);

    records.push({
      name,
      crc,
      compressedSize: compressed.length,
      rawSize: entry.data.length,
      offset,
    });
  }

  const centralStart = writer.length;

  for (const record of records) {
    writer.u32(0x02014b50); // central directory header
    writer.u16(20); // version made by
    writer.u16(20); // version needed
    writer.u16(0x0800);
    writer.u16(8);
    writer.u16(time);
    writer.u16(date);
    writer.u32(record.crc);
    writer.u32(record.compressedSize);
    writer.u32(record.rawSize);
    writer.u16(record.name.length);
    writer.u16(0); // extra field
    writer.u16(0); // comment
    writer.u16(0); // disk number
    writer.u16(0); // internal attributes
    writer.u32(0); // external attributes
    writer.u32(record.offset);
    writer.bytes(record.name);
  }

  const centralSize = writer.length - centralStart;

  writer.u32(0x06054b50); // end of central directory
  writer.u16(0);
  writer.u16(0);
  writer.u16(records.length);
  writer.u16(records.length);
  writer.u32(centralSize);
  writer.u32(centralStart);
  writer.u16(0); // comment length

  return writer.finish();
}
