import { zstdDecompressSync } from 'node:zlib';

/** One complete standard frame; skippable metadata frames produce no plaintext. */
export interface ZstdFrame { start: number; end: number; skippable: boolean }

/**
 * Walk RFC 8878 frame/block lengths, never searching for magic inside payloads.
 * DSH writes a header frame followed by independently compressed append batches.
 * Reject incomplete tails rather than silently importing an incomplete history.
 */
export function* scanZstdFrames(input: Uint8Array): Generator<ZstdFrame> {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let offset = 0;
  const requireBytes = (count: number) => {
    if (count > bytes.length - offset) throw new Error(`Truncated Zstandard frame at byte ${offset}`);
  };
  while (offset < bytes.length) {
    const start = offset;
    requireBytes(4);
    const magic = bytes.readUInt32LE(offset); offset += 4;
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      requireBytes(4);
      const length = bytes.readUInt32LE(offset); offset += 4;
      requireBytes(length); offset += length;
      yield { start, end: offset, skippable: true }; continue;
    }
    if (magic !== 0xfd2fb528) throw new Error(`Invalid Zstandard frame magic at byte ${start}`);
    requireBytes(1);
    const descriptor = bytes[offset++]!;
    if (descriptor & 0x08) throw new Error(`Reserved Zstandard frame-header bit at byte ${offset - 1}`);
    const singleSegment = !!(descriptor & 0x20);
    const sizeFlag = descriptor >>> 6;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const sizeBytes = sizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << sizeFlag;
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + sizeBytes;
    requireBytes(headerBytes); offset += headerBytes;
    let last = false;
    while (!last) {
      requireBytes(3);
      const block = bytes.readUIntLE(offset, 3); offset += 3;
      last = !!(block & 1);
      const type = (block >>> 1) & 3;
      if (type === 3) throw new Error(`Reserved Zstandard block type at byte ${offset - 3}`);
      const payloadBytes = type === 1 ? 1 : block >>> 3; // RLE stores one byte, not its expanded size.
      requireBytes(payloadBytes); offset += payloadBytes;
    }
    if (descriptor & 4) { requireBytes(4); offset += 4; }
    yield { start, end: offset, skippable: false };
  }
}

export function decompressZstdFrames(input: Uint8Array, maxBytes = 64 * 1024 * 1024): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive safe integer');
  const chunks: Buffer[] = [];
  let total = 0, frameCount = 0;
  for (const frame of scanZstdFrames(input)) {
    if (frame.skippable) continue;
    frameCount++;
    let chunk: Buffer;
    try {
      // Decode exactly one frame: Node's one-shot decoder may stop after the first frame.
      chunk = zstdDecompressSync(input.subarray(frame.start, frame.end), { maxOutputLength: Math.max(1, maxBytes - total) });
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error(`Decoded Zstandard session log exceeds ${maxBytes} bytes`, { cause });
      }
      throw new Error(`Cannot decode Zstandard frame ${frameCount} at byte ${frame.start}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    total += chunk.length;
    if (total > maxBytes) throw new Error(`Decoded Zstandard session log exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  if (!frameCount) throw new Error('Zstandard session log contains no data frames');
  return Buffer.concat(chunks, total);
}
