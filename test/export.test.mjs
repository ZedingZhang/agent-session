import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { exportSession, parseSessionJson, resolveExportFormat, serialize, materialize, sha256,
  LocalSessionStore, AdapterRegistry, importFile } from '../dist/index.js';

async function fixture() {
  const store = new LocalSessionStore(await mkdtemp(join(tmpdir(), 'agent-export-')));
  const result = await importFile(store, new AdapterRegistry(), 'examples/login-replay.jsonl');
  return { store, id: result.sessions[0].id, events: await store.read(result.sessions[0].id) };
}
test('JSON export preserves all events, raw metadata and original archive identity', async () => {
  const { events } = await fixture();
  const original = JSON.stringify(events);
  const text = exportSession(events, 'json');
  const document = JSON.parse(text);
  assert.equal(document.format, 'agent-session'); assert.equal(document.schemaVersion, 1);
  assert.equal(document.sessionId, events[0].sessionId);
  assert.deepEqual(document.metadata, events[0].data);
  assert.deepEqual(document.events, events);
  assert.deepEqual(parseSessionJson(text), events);
  assert.equal(JSON.stringify(events), original);
  assert.equal(exportSession(events, 'jsonl'), serialize(events));
});
test('JSON export/import roundtrip deduplicates and validates wrapper and event corruption', async () => {
  const { store, events, id } = await fixture();
  const path = join(store.root, 'session.json');
  await writeFile(path, exportSession(events, 'json'));
  assert.deepEqual((await importFile(store, new AdapterRegistry(), path)).sessions[0], { id, status: 'exists' });
  const other = new LocalSessionStore(await mkdtemp(join(tmpdir(), 'agent-export-other-')));
  assert.equal((await importFile(other, new AdapterRegistry(), path)).sessions[0].id, id);
  const document = JSON.parse(await readFile(path, 'utf8'));
  document.metadata.title = 'Corrupted wrapper';
  assert.throws(() => parseSessionJson(JSON.stringify(document)), /metadata\/session ID/);
  document.metadata = events[0].data; document.events[2].data.content[0].text = 'Corrupted event';
  assert.throws(() => parseSessionJson(JSON.stringify(document)), /hash mismatch/);
  await assert.rejects(importFile(other, new AdapterRegistry(), path, { title: 'Retitled' }), /cannot be retitled/);
});
test('Markdown export includes full messages, tools and recorded diffs with explicit timezone', async () => {
  const { events } = await fixture();
  const text = exportSession(events, 'markdown', { timeZone: 'Asia/Singapore' });
  assert.match(text, /^# 修复登录跳转问题/);
  assert.match(text, /## \[10:00:01\] User/);
  assert.match(text, /## \[10:00:11\] Diff/);
  assert.match(text, /```diff\nsrc\/auth\/login.ts\n- redirect\('\/login'\)\n\+ redirect\('\/dashboard'\)/);
  assert.match(text, /Expected \/dashboard but received \/login/);
  assert.match(text, /"content":"redirect\('\/dashboard'\)"/); // Full write arguments, not a CLI preview.
  assert.doesNotMatch(text, /## \[.*\] Source/);
  assert.match(exportSession(events, 'markdown', { all: true }), /Source/);
});
test('Markdown fences protect embedded fences and metadata headings; long results are not truncated', () => {
  const metadata = { title: '# title\n<script>bad</script>', adapter: { id: 'test', version: '1' }, source: { format: 'test', sha256: sha256('test') } };
  const events = materialize(metadata, [
    { type: 'message', timestamp: null, data: { role: 'user', content: '```js\n## Assistant\n```\n````' } },
    { type: 'tool.result', timestamp: null, data: { callId: 'orphan', content: 'line\n'.repeat(100) } },
  ]);
  const text = exportSession(events, 'markdown', { timeZone: 'UTC' });
  assert.match(text, /&lt;script&gt;/); assert.doesNotMatch(text, /<script>/);
  assert.match(text, /`````text\n```js/);
  assert.equal((text.match(/^line$/gm) ?? []).length, 99); // First line shares its orphan call ID.
  assert.doesNotMatch(text, /truncated/);
});
test('format inference and CLI file exports support Markdown, JSON and legacy JSONL without overwriting', async () => {
  assert.equal(resolveExportFormat(undefined, 'SESSION.MD'), 'markdown');
  assert.equal(resolveExportFormat(undefined, 'session.json'), 'json');
  assert.equal(resolveExportFormat(), 'jsonl'); assert.equal(resolveExportFormat('md'), 'markdown');
  assert.equal(resolveExportFormat('json', 'file.md'), 'json');
  assert.throws(() => resolveExportFormat('xml'), /Unknown export format/);
  const { store, id, events } = await fixture();
  const cli = (...args) => execFileSync(process.execPath, ['dist/cli.js', '--library', store.root, 'export', id.slice(0, 12), ...args], { encoding: 'utf8', stdio: 'pipe' });
  const markdown = join(store.root, 'session.md'), json = join(store.root, 'session.json');
  cli('-o', markdown, '--timezone', 'Asia/Singapore'); cli('-o', json);
  assert.match(await readFile(markdown, 'utf8'), /## \[10:00:01\] User/);
  assert.deepEqual(parseSessionJson(await readFile(json, 'utf8')), events);
  assert.equal(cli(), serialize(events));
  assert.deepEqual(parseSessionJson(cli('--format', 'json')), events);
  assert.match(cli('--format', 'md'), /# 修复登录跳转问题/);
  assert.throws(() => cli('--format', 'xml'), /Allowed choices/);
  assert.throws(() => cli('-o', json), /EEXIST/);
  assert.deepEqual(parseSessionJson(await readFile(json, 'utf8')), events);
});
