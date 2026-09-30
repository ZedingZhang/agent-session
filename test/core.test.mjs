import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { zipSync, strToU8 } from 'fflate';
import { AdapterRegistry, LocalSessionStore, importFile, materialize, serialize, parseArchive,
  sha256, markdownAdapter, jsonAdapter, deepseekAdapter } from '../dist/index.js';

const fixture = await readFile(new URL('../examples/deepseek-session.jsonl', import.meta.url), 'utf8');
async function library() { return new LocalSessionStore(await mkdtemp(join(tmpdir(), 'ctxcrate-test-'))); }
const metadata = { title: 'Test', adapter: { id: 'test', version: '1' }, source: { format: 'test', sha256: sha256('test') } };
const draft = { type: 'message', timestamp: null, data: { role: 'user', content: 'Hello' } };
const sample = () => materialize(metadata, [draft]);

test('schema roundtrip, deterministic identity, tamper and ordering detection', () => {
  const events = sample();
  assert.deepEqual(parseArchive(serialize(events)), events);
  assert.equal(sample()[0].sessionId, events[0].sessionId);
  assert.throws(() => parseArchive(serialize(events).replace('Hello', 'Tampered')), /hash mismatch/);
  assert.throws(() => parseArchive(serialize([events[0], { ...events[1], seq: 3 }])), /identity\/order/);
  assert.throws(() => parseArchive(serialize(events) + '{broken'), /line 3/);
});
test('schema rejects non-JSON payloads and unsupported versions', () => {
  assert.throws(() => materialize(metadata, [{ ...draft, data: { role: 'user', content: undefined } }]));
  assert.throws(() => parseArchive(serialize(sample()).replace('"schemaVersion":1', '"schemaVersion":99')));
});
test('Markdown respects fenced code and preserves preamble', () => {
  const input = '# Demo\nPreamble\n## User\nHi\n```md\n## Assistant\n```\n## Assistant\nHello';
  const [session] = markdownAdapter.parse({ filename: 'test.md', content: input });
  assert.equal(session.events.length, 2);
  assert.match(session.events[0].data.content, /## Assistant/);
  assert.equal(session.title, 'Demo');
  assert.match(session.header.preamble, /Preamble/);
  assert.throws(() => markdownAdapter.parse({ filename: 'bad.md', content: 'No roles' }), /role headings/);
});
test('Generic JSON supports content blocks, JSONL and unknown typed events', () => {
  const [session] = jsonAdapter.parse({ filename: 'test.jsonl', content: '{"role":"human","content":"Hi"}\n{"type":"custom","extra":1}' });
  assert.equal(session.events[0].data.role, 'user');
  assert.equal(session.events[1].data.raw.extra, 1);
  assert.throws(() => jsonAdapter.parse({ filename: 'test.json', content: '[{"role":"alien","content":"Hi"}]' }));
  assert.throws(() => jsonAdapter.parse({ filename: 'test.json', content: '[{"role":"user"}]' }), /missing content/);
});
test('DeepSeek maps native messages, tools and unknown lifecycle without dropping raw data', () => {
  const input = { filename: 'session.v4.jsonl', content: fixture };
  assert.equal(new AdapterRegistry().select(input).id, 'deepseek-harness');
  const [session] = deepseekAdapter.parse(input);
  assert.equal(session.title, 'Read the README');
  assert.equal(session.events.length, 7);
  assert.deepEqual(session.events.map(e => e.type), ['source.event', 'message', 'source.event', 'tool.call', 'tool.result', 'message', 'source.event']);
  assert.equal(session.events[4].data.callId, 'call-1');
  assert.equal(session.events[5].data.raw.data.message.source.provider, 'deepseek');
  assert.throws(() => deepseekAdapter.parse({ ...input, content: fixture.replace('"version":4', '"version":5') }), /version/);
});
test('DeepSeek legacy tool wrapper maps call ID and error state', () => {
  const content = [JSON.stringify({ type: 'session', version: 3 }), JSON.stringify({ type: 'tool/result', time: 1,
    data: { message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'legacy', isError: true,
      content: [{ type: 'text', text: 'failed' }] }] } } })].join('\n');
  const [session] = deepseekAdapter.parse({ filename: 'session.v3.jsonl', content });
  assert.equal(session.events[0].data.callId, 'legacy');
  assert.equal(session.events[0].data.isError, true);
});
test('atomic publication handles concurrent deduplication', async () => {
  const store = await library();
  const results = await Promise.all(Array.from({ length: 8 }, () => store.save(sample())));
  assert.equal(results.filter(r => r.status === 'created').length, 1);
  assert.equal((await store.list()).length, 1);
  assert.equal((await readdir(join(store.root, 'sessions'))).length, 1);
  assert.deepEqual(await store.read(sample()[0].sessionId.slice(0, 8)), sample());
  await assert.rejects(store.read('../escape'), /ID must/);
});
test('import deduplication and canonical export/reimport preserve IDs', async () => {
  const store = await library(), registry = new AdapterRegistry();
  const file = join(store.root, 'input.jsonl'); await writeFile(file, fixture);
  const first = await importFile(store, registry, file);
  assert.equal(first.sessions[0].status, 'created');
  assert.equal((await importFile(store, registry, file)).sessions[0].status, 'exists');
  const archive = join(store.root, 'canonical.jsonl');
  await writeFile(archive, serialize(await store.read(first.sessions[0].id)));
  const other = await library();
  assert.equal((await importFile(other, registry, archive)).sessions[0].id, first.sessions[0].id);
  await assert.rejects(importFile(other, registry, archive, { title: 'Changed' }), /cannot be retitled/);
});
test('bidirectional sync is idempotent and preserves both libraries', async () => {
  const a = await library(), b = await library();
  await a.save(sample());
  await b.save(materialize({ ...metadata, title: 'Other' }, [draft]));
  assert.deepEqual(await a.sync(b.root), { pulled: 1, pushed: 1 });
  assert.deepEqual(await a.sync(b.root), { pulled: 0, pushed: 0 });
  assert.equal((await a.list()).length, 2); assert.equal((await b.list()).length, 2);
});
test('sync preflight rejects corrupted or misnamed archives before copying', async () => {
  const a = await library(), b = await library(); await a.save(sample()); await b.init();
  const badId = 'a'.repeat(64);
  await writeFile(join(b.root, 'sessions', `${badId}.jsonl`), serialize(sample()));
  await assert.rejects(a.sync(b.root), /Filename\/session ID mismatch/);
  assert.equal((await readdir(join(b.root, 'sessions'))).length, 1);
});
test('ZIP imports root and child logs without extracting paths or media', async () => {
  const store = await library(); const path = join(store.root, 'session.zip');
  await writeFile(path, zipSync({ 'session.v4.jsonl': strToU8(fixture),
    'subagents/child/session.v4.jsonl': strToU8(fixture.replace('demo-dsh', 'child-dsh')),
    '../../escape.txt': strToU8('ignored'), 'media/image.png': new Uint8Array([1, 2]) }));
  const result = await importFile(store, new AdapterRegistry(), path);
  assert.equal(result.sessions.length, 2); assert.equal(result.warnings.length, 1);
  assert.equal((await store.list()).length, 2);
});
test('ZIP and plain input enforce size limits', async () => {
  const store = await library(); const path = join(store.root, 'large.zip');
  const large = fixture + ' '.repeat(10000);
  await writeFile(path, zipSync({ 'session.v4.jsonl': strToU8(large) }));
  await assert.rejects(importFile(store, new AdapterRegistry(), path, { maxBytes: 4000 }), /exceed/);
  const plain = join(store.root, 'large.jsonl'); await writeFile(plain, fixture);
  await assert.rejects(importFile(store, new AdapterRegistry(), plain, { maxBytes: 1 }), /exceed/);
});
test('ZIP validates all sessions before publication', async () => {
  const store = await library(); const path = join(store.root, 'bad.zip');
  await writeFile(path, zipSync({ 'session.v4.jsonl': strToU8(fixture), 'subagents/new/session.v5.jsonl': strToU8(fixture.replace('"version":4', '"version":5')) }));
  await assert.rejects(importFile(store, new AdapterRegistry(), path), /version/);
  assert.equal((await store.list()).length, 0);
});
test('external ESM adapters load through the public registry contract', async () => {
  const registry = new AdapterRegistry(); await registry.load(resolve('examples/custom-adapter.mjs'));
  assert.equal(registry.select({ filename: 'note.txt', content: 'A note' }).id, 'notes');
  assert.throws(() => registry.register(markdownAdapter), /Duplicate adapter/);
  assert.throws(() => registry.register({ id: 'bad' }), /Invalid adapter/);
});
test('CLI end-to-end import, history, show, export, sync and failures', async () => {
  const store = await library(), other = await library();
  const cli = (...args) => execFileSync(process.execPath, ['dist/cli.js', '--library', store.root, ...args], { encoding: 'utf8' });
  cli('init'); const result = cli('import', 'examples/conversation.json');
  const id = result.trim().split('\t')[1];
  assert.equal(JSON.parse(cli('history', '--json'))[0].id, id);
  assert.match(cli('show', id.slice(0, 12)), /Hello!/);
  assert.equal(parseArchive(cli('show', id, '--json'))[0].sessionId, id);
  const output = join(store.root, 'export.jsonl'); cli('export', id, '-o', output);
  assert.equal(parseArchive(await readFile(output, 'utf8'))[0].sessionId, id);
  assert.deepEqual(JSON.parse(cli('sync', other.root)), { pulled: 0, pushed: 1 });
  assert.throws(() => cli('show', 'bad'), /ID must/);
  assert.throws(() => cli('export', id, '-o', output), /EEXIST/);
});
