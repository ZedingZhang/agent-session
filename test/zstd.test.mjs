import test from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { decompressZstdFrames, scanZstdFrames, AdapterRegistry, LocalSessionStore,
  importFile, importDshDirectory, discoverDshLogs, deepseekAdapter } from '../dist/index.js';

const fixture = await readFile(new URL('../examples/deepseek-session.jsonl', import.meta.url), 'utf8');
// Preserve CR in CRLF fixtures: trimming it changes source bytes and thus snapshot identity.
const lines = fixture.split('\n');
if (lines.at(-1) === '') lines.pop();
const compress = input => zstdCompressSync(Buffer.from(input), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
const batches = () => Buffer.concat(lines.map(line => compress(line + '\n')));
async function library() { return new LocalSessionStore(await mkdtemp(join(tmpdir(), 'ctxcrate-zstd-'))); }

test('concatenated header + append frames recover every event, including thousands of frames', () => {
  // Reproduce the silent first-frame loss observed in native DSH persistence logs.
  // Native decoder behavior can change across Node releases; our result must always include every frame.
  assert.ok(zstdDecompressSync(batches()).toString().startsWith(lines[0] + '\n'));
  assert.equal(decompressZstdFrames(batches()).toString(), fixture);
  for (const text of [fixture.replace(/\r\n/g, '\n'), fixture.replace(/\r?\n/g, '\r\n')]) {
    const frames = text.split('\n').slice(0, -1).map(line => compress(line + '\n'));
    assert.equal(decompressZstdFrames(Buffer.concat(frames)).toString(), text);
  }
  assert.equal([...scanZstdFrames(batches())].length, lines.length);
  const repeated = Buffer.concat([compress(lines[0] + '\n'), ...Array.from({ length: 4817 }, () => compress(lines[1] + '\n'))]);
  const decoded = decompressZstdFrames(repeated).toString();
  assert.equal(decoded.trimEnd().split('\n').length, 4818);
  assert.equal(deepseekAdapter.parse({ filename: 'session.v4.jsonl', content: decoded })[0].events.length, 4817);
});
test('frame boundaries handle raw/RLE blocks, dictionary ID widths and embedded magic bytes', () => {
  const payload = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 65]);
  for (const dictionaryBytes of [0, 1, 2, 4]) {
    const dictFlag = dictionaryBytes === 4 ? 3 : dictionaryBytes;
    const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20 | dictFlag, ...Array(dictionaryBytes).fill(0), payload.length]);
    const block = Buffer.alloc(3); block.writeUIntLE((payload.length << 3) | 1, 0, 3);
    const raw = Buffer.concat([header, block, payload]);
    assert.deepEqual(decompressZstdFrames(Buffer.concat([raw, raw])), Buffer.concat([payload, payload]));
  }
  const rle = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 5, (5 << 3) | 3, 0, 0, 65]);
  assert.equal(decompressZstdFrames(rle).toString(), 'AAAAA');
});
test('unknown content size, multi-block frames and skippable metadata preserve all plaintext', () => {
  const text = Buffer.from('x'.repeat(300000));
  const frame = zstdCompressSync(text, { params: { [constants.ZSTD_c_contentSizeFlag]: 0, [constants.ZSTD_c_checksumFlag]: 1 } });
  const skip = Buffer.alloc(11); skip.writeUInt32LE(0x184d2a5f, 0); skip.writeUInt32LE(3, 4); skip.set([1, 2, 3], 8);
  const data = Buffer.concat([skip, frame, skip, compress('tail')]);
  assert.equal([...scanZstdFrames(data)].length, 4);
  assert.deepEqual(decompressZstdFrames(data), Buffer.concat([text, Buffer.from('tail')]));
});
test('truncated frames, corrupt checksums, reserved blocks and trailing junk fail clearly', () => {
  const bytes = batches();
  for (const length of [1, 4, 5, 7, bytes.length - 1]) {
    assert.throws(() => decompressZstdFrames(bytes.subarray(0, length)), /Truncated/);
  }
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => decompressZstdFrames(corrupt), /Cannot decode Zstandard frame/);
  assert.throws(() => decompressZstdFrames(Buffer.concat([bytes, Buffer.from('junk')])), /Invalid.*magic/);
  assert.throws(() => decompressZstdFrames(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0, 7, 0, 0])), /Reserved.*block/);
  assert.throws(() => decompressZstdFrames(Buffer.alloc(0)), /no data frames/);
});
test('output cap applies across frames and to highly compressible unknown-size frames', () => {
  assert.throws(() => decompressZstdFrames(Buffer.concat([compress('1234'), compress('5678')]), 7), /exceeds/);
  const frame = zstdCompressSync(Buffer.from('a'.repeat(20000)), { params: { [constants.ZSTD_c_contentSizeFlag]: 0 } });
  assert.throws(() => decompressZstdFrames(frame, 100), /exceeds/);
  assert.throws(() => decompressZstdFrames(frame, 0), /positive safe integer/);
});
test('compressed import matches plain JSONL identity and never publishes a truncated prefix', async () => {
  const store = await library(), registry = new AdapterRegistry();
  const plain = join(store.root, 'session.v4.jsonl'), compressed = plain + '.zstd';
  await writeFile(plain, fixture); await writeFile(compressed, batches());
  const a = await importFile(store, registry, plain);
  const b = await importFile(store, registry, compressed);
  assert.equal(a.sessions[0].id, b.sessions[0].id); assert.equal(b.sessions[0].status, 'exists');
  assert.equal((await store.read(b.sessions[0].id)).length, 8);
  const empty = await library(); await writeFile(join(empty.root, 'session.v4.jsonl.zstd'), batches().subarray(0, -1));
  await assert.rejects(importFile(empty, registry, join(empty.root, 'session.v4.jsonl.zstd')), /Truncated/);
  assert.equal((await empty.list()).length, 0);
});
test('legacy v0 compact rows retain batch data and initial timestamp', async () => {
  const store = await library();
  const content = [JSON.stringify({ type: 'session', version: 0, id: 'legacy' }),
    JSON.stringify({ type: 'text-chunks', seq0: 1, time0: 1000, data: { texts: ['Hi', 'there'], dt: [0, 1] } }),
    lines[6]].join('\n') + '\n';
  const file = join(store.root, 'session.jsonl.zstd'); await writeFile(file, compress(content));
  const result = await importFile(store, new AdapterRegistry(), file);
  const events = await store.read(result.sessions[0].id);
  assert.equal(events[1].type, 'source.event'); assert.equal(events[1].timestamp, '1970-01-01T00:00:01.000Z');
  assert.deepEqual(events[1].data.raw.data.texts, ['Hi', 'there']);
  assert.equal(events[2].type, 'message');
});
test('directory import selects newest generation per session and CLI supports the native library', async () => {
  const store = await library(); const native = join(store.root, 'native');
  await mkdir(join(native, 'first'), { recursive: true }); await mkdir(join(native, 'second'));
  await writeFile(join(native, 'first', 'session.v3.jsonl.zstd'), compress(fixture.replace('"version":4', '"version":3')));
  await writeFile(join(native, 'first', 'session.v4.jsonl.zstd'), batches());
  await writeFile(join(native, 'second', 'session.v4.jsonl'), fixture.replace('demo-dsh', 'other'));
  await writeFile(join(native, 'notes.txt'), 'ignored');
  assert.equal((await discoverDshLogs(native)).length, 2);
  assert.equal((await importDshDirectory(store, new AdapterRegistry(), native)).sessions.length, 2);
  assert.equal((await store.list()).length, 2);
  const output = execFileSync(process.execPath, ['dist/cli.js', '--library', store.root, 'import', native], { encoding: 'utf8' });
  assert.equal(output.trim().split('\n').length, 2); assert.match(output, /exists/);
});
