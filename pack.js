// pack.js — the git packfile codec: object hashing, pack read/write,
// delta application, and the pkt-line framing the smart-HTTP protocol
// rides on. Written from the git object format, stdlib only.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

// Git object type numbers, as they appear in a pack entry header.
export const OBJ_COMMIT = 1;
export const OBJ_TREE = 2;
export const OBJ_BLOB = 3;
export const OBJ_TAG = 4;
export const OBJ_OFS_DELTA = 6;
export const OBJ_REF_DELTA = 7;

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_NAMES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_NUMBERS = { commit: 1, tree: 2, blob: 3, tag: 4 };

// The id of a git object: SHA-1 over "<type> <length>\0<bytes>".
export function hashObject(type, data) {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// Read one varint from the delta stream: 7 bits per byte, little-endian,
// high bit set while more bytes follow.
function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let byte = 0;
  do {
    if (offset >= buf.length) throw new Error('delta varint is truncated');
    byte = buf[offset++];
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if (shift > 63) throw new Error('delta varint is too long');
  } while (byte & 0x80);
  return { value, offset };
}

// Apply a git delta instruction stream to a base object's bytes. The stream
// starts with the base size and the target size as varints, then copy and
// insert operations: a byte >= 0x80 copies (offset/size encoded in its low
// bits), a byte < 0x80 inserts that many literal bytes, 0 is invalid.
export function applyDelta(base, delta) {
  const baseBuf = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuf = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  let read = readVarint(deltaBuf, offset);
  const sourceSize = read.value;
  offset = read.offset;
  read = readVarint(deltaBuf, offset);
  const targetSize = read.value;
  offset = read.offset;
  if (sourceSize !== baseBuf.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuf.length}`);
  }
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < deltaBuf.length) {
    const op = deltaBuf[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let shift = 0; shift < 4; shift += 1) {
        if (op & (1 << shift)) {
          if (offset >= deltaBuf.length) throw new Error('delta copy offset is truncated');
          copyOffset += deltaBuf[offset++] << (shift * 8);
        }
      }
      for (let shift = 0; shift < 3; shift += 1) {
        if (op & (0x10 << shift)) {
          if (offset >= deltaBuf.length) throw new Error('delta copy size is truncated');
          copySize += deltaBuf[offset++] << (shift * 8);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuf.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      baseBuf.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > deltaBuf.length) throw new Error('delta insert is truncated');
      if (written + op > targetSize) throw new Error('delta writes past its target size');
      deltaBuf.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// Read the pack entry header at `offset`: the type lives in bits 4-6 of
// the first byte, the size in its low 4 bits plus 7-bit continuation
// bytes. Returns the type, the inflated size and the offset of the
// compressed payload.
function readEntryHeader(pack, offset) {
  const first = pack[offset++];
  const type = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;
  while (pack[offset - 1] & 0x80) {
    size |= (pack[offset] & 0x7f) << shift;
    shift += 7;
    offset += 1;
  }
  return { type, size, offset };
}

// Read the ofs-delta base offset: bytes with the high bit set except the
// last, decoded as offset = ((offset + 1) << 7) | (byte & 0x7f) per byte.
function readOfsDeltaOffset(pack, offset) {
  let byte = pack[offset++];
  let baseOffset = byte & 0x7f;
  while (byte & 0x80) {
    byte = pack[offset++];
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset, offset };
}

// Inflate one zlib stream starting at `offset`. Returns the decompressed
// bytes and exactly how many input bytes the stream consumed, from the
// engine's bytesWritten counter.
function inflateAt(pack, offset) {
  const result = inflateSync(pack.subarray(offset), { info: true });
  return { data: result.buffer, consumed: result.engine.bytesWritten };
}

// Parse a whole packfile into objects. Returns a Map oid -> {type, data}
// and the number of delta entries resolved. Deltas resolve against other
// entries in the same pack, or against `resolveBase` (the client's
// have-objects for a thin pack). A cycle or a missing base throws.
export function readPack(pack, options = {}) {
  const resolveBase = options.resolveBase || null;
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const entries = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readEntryHeader(pack, offset);
    offset = header.offset;
    let delta = null;
    if (header.type === OBJ_OFS_DELTA) {
      const read = readOfsDeltaOffset(pack, offset);
      offset = read.offset;
      delta = { kind: 'ofs', baseOffset: entryOffset - read.baseOffset };
    } else if (header.type === OBJ_REF_DELTA) {
      if (offset + 20 > pack.length) throw new Error('ref-delta base id is truncated');
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      delta = { kind: 'ref', baseOid };
    }
    const inflated = inflateAt(pack, offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} inflated to ${inflated.data.length} bytes, header says ${header.size}`);
    }
    offset += inflated.consumed;
    entries.push({ offset: entryOffset, type: header.type, size: header.size, delta, data: inflated.data });
  }
  const byOffset = new Map(entries.map((entry) => [entry.offset, entry]));
  const byOid = new Map();
  const resolving = new Set();
  let deltaCount = 0;
  const resolve = (entry) => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let result;
    if (entry.delta === null) {
      const typeName = TYPE_NAMES[entry.type];
      if (typeName === undefined) throw new Error(`pack entry at ${entry.offset} has unknown type ${entry.type}`);
      result = { type: typeName, data: entry.data };
    } else {
      deltaCount += 1;
      let base = null;
      if (entry.delta.kind === 'ofs') {
        const baseEntry = byOffset.get(entry.delta.baseOffset);
        if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.delta.baseOffset} is not in the pack`);
        base = resolve(baseEntry);
      } else {
        const baseEntry = entries.find((candidate) => {
          if (candidate.delta !== null) return false;
          const name = TYPE_NAMES[candidate.type];
          return name !== undefined && hashObject(name, candidate.data) === entry.delta.baseOid;
        });
        if (baseEntry) {
          base = resolve(baseEntry);
        } else if (resolveBase) {
          const held = resolveBase(entry.delta.baseOid);
          if (held) base = { type: held.type, data: held.data };
        }
        if (!base) throw new Error(`ref-delta base ${entry.delta.baseOid} is not in the pack`);
      }
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    resolving.delete(entry.offset);
    entry.resolved = result;
    return result;
  };
  const objects = new Map();
  for (const entry of entries) {
    const object = resolve(entry);
    objects.set(hashObject(object.type, object.data), object);
  }
  return { objects, deltaCount };
}

// Write a packfile holding the given objects as full (non-delta) entries.
// `objects` is an array of {type, data}; the pack is deterministic for a
// given input order. The trailer is the SHA-1 of everything before it.
export function writePack(objects) {
  const parts = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeNumber = TYPE_NUMBERS[object.type];
    if (typeNumber === undefined) throw new Error(`cannot pack object type ${object.type}`);
    const size = object.data.length;
    const headerBytes = [];
    let first = (typeNumber << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// Verify a pack's trailer checksum: the last 20 bytes must be the SHA-1
// of everything before them.
export function verifyPackChecksum(pack) {
  if (pack.length < 32) return { ok: false, actual: '', expected: '' };
  const actual = pack.toString('hex', pack.length - 20);
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return { ok: actual === expected, actual, expected };
}

// ---------------------------------------------------------------- pkt-line

// Encode one pkt-line: a 4-hex-digit length (including the 4 digits)
// followed by the payload. Length 0 is the flush packet "0000".
export function pktLine(payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const length = data.length + 4;
  const prefix = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

// Encode a list of lines, where 'flush' and 'delim' are control packets.
export function encodePktLines(lines) {
  const parts = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

// Split a buffer into pkt-line packets: {kind: 'data'|'flush'|'delim',
// payload}. Throws on a truncated or malformed framing.
export function decodePktLines(buffer) {
  const packets = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line is truncated');
    const length = parseInt(buffer.toString('ascii', offset, offset + 4), 16);
    if (Number.isNaN(length) || length < 0) throw new Error('pkt-line has a bad length');
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + length > buffer.length) throw new Error('pkt-line is truncated');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

// Frame pack bytes as sideband packets: each pkt-line payload starts with
// the band byte (1 = pack data). A pkt-line is at most 65520 bytes long
// INCLUDING its 4-byte length prefix, so the band byte plus the chunk it
// carries is at most 65516 bytes — the chunk itself at most 65515. (A
// 65520-byte chunk makes a 65525-byte pkt-line, which a strict reader
// rejects; real git tolerates it, the kit's client does not.)
export const SIDEBAND_CHUNK = 65515;
export function sidebandPack(pack) {
  const parts = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}
