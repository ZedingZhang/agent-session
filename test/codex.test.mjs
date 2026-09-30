import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { codexAdapter, AdapterRegistry, LocalSessionStore, importFile, importSessionDirectory,
  discoverCodexLogs, materialize, sha256, projectTimeline, exportSession, parseSessionJson } from 'ctxcrate';

const content = await readFile('examples/codex-rollout.jsonl', 'utf8');
const rows = content.trim().split('\n').map(JSON.parse);
const input = text => ({ filename: 'rollout-demo.jsonl', content: text });
const parse = native => codexAdapter.parse(input(native.map(r => JSON.stringify(r)).join('\n')))[0];
const response = p => ({ timestamp: '2026-10-01T02:00:01Z', type: 'response_item', payload: p });
const event = p => ({ timestamp: '2026-10-01T02:00:01Z', type: 'event_msg', payload: p });
const message = text => response({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const mirror = text => event({ type: 'user_message', message: text });
const archive = session => materialize({ title: session.title, adapter: { id: 'codex', version: codexAdapter.version },
  source: { format: session.sourceFormat, sha256: sha256(session.sourceContent), externalId: session.externalId, header: session.header } }, session.events);

test('Codex native detection and mapping retain every source row, header and tool identity', () => {
  assert.equal(new AdapterRegistry().select(input(content)).id, 'codex');
  assert.equal(codexAdapter.detect(input('\uFEFF\n' + content)), true);
  assert.equal(codexAdapter.detect(input('{"role":"user","content":"generic"}')), false);
  const session = parse(rows);
  assert.equal(session.title, '帮我修复登录跳转问题');
  assert.equal(session.externalId, rows[0].payload.id);
  assert.deepEqual(session.header, rows[0]);
  assert.equal(session.events.length, rows.length - 1);
  assert.deepEqual(session.events.map(e => e.data.raw), rows.slice(1));
  assert.equal(session.events.filter(e => e.type === 'message').length, 3);
  assert.equal(session.events.find(e => e.type === 'tool.call').data.arguments, '{"cmd":"npm.cmd test"}');
  const timeline = projectTimeline(archive(session));
  assert.equal(timeline.filter(e => e.label === 'User').length, 1);
  assert.equal(timeline.filter(e => e.label === 'Agent').length, 2);
  assert.match(timeline.find(e => e.label === 'Shell').text, /npm.cmd test/);
  assert.match(timeline.find(e => e.label === 'Test failed').text, /Expected \/dashboard/);
  assert.match(timeline.find(e => e.callId === 'patch-login' && e.label === 'Tool result').text, /Success/);
});

test('mirror pairing preserves identical repeated turns and unmatched event-only messages', () => {
  const session = parse([rows[0], event({ type: 'task_started' }), mirror('repeat'), message('repeat'),
    event({ type: 'task_complete' }), event({ type: 'task_started' }), mirror('repeat'),
    event({ type: 'task_complete' }), event({ type: 'task_started' }), message('repeat'), mirror('repeat'), mirror('repeat')]);
  assert.equal(session.events.filter(e => e.type === 'message').length, 4);
  assert.equal(session.events.filter(e => e.type === 'source.event' && e.data.sourceType.endsWith('user_message')).length, 2);
  const differing = parse([rows[0], mirror('abridged'), message('full transcript')]);
  assert.equal(differing.events.filter(e => e.type === 'message').length, 2);
});

test('structured content, custom calls, legacy shell and opaque/unknown records survive export', () => {
  const native = [rows[0], response({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] }),
    response({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect image' }, { type: 'input_image', image_url: 'data:image/png;base64,fictional' }] }),
    response({ type: 'function_call', namespace: 'functions', name: 'exec_command', arguments: 'not-json', call_id: 'fn' }),
    response({ type: 'function_call_output', call_id: 'fn', output: [{ type: 'input_text', text: 'Process exited with code 2\nFinal output:\nfailed' }, { type: 'input_image', image_url: 'fictional' }] }),
    response({ type: 'local_shell_call', id: 'legacy', action: { type: 'exec', command: ['echo', 'hello'] } }),
    response({ type: 'function_call_output', output: 'missing call ID' }),
    response({ type: 'message', role: 'future-role', content: [] }),
    rows[10], { type: 'compacted', payload: { message: 'summary', replacement_history: [{ opaque: true }] } },
    { type: 'world_state', payload: { state: { demo: true } } }, { type: 'future_record', payload: 42 }];
  const session = parse(native), events = archive(session);
  assert.deepEqual(session.events.map(e => e.data.raw), native.slice(1));
  assert.equal(session.events[2].data.name, 'functions.exec_command');
  assert.equal(session.events[2].data.arguments, 'not-json');
  assert.equal(session.events[4].data.name, 'shell');
  assert.equal(session.events[5].type, 'source.event');
  assert.equal(session.events[6].type, 'source.event');
  assert.match(projectTimeline(events).find(e => e.label === 'Shell failed').text, /failed/);
  assert.deepEqual(parseSessionJson(exportSession(events, 'json')), events);
  assert.match(exportSession(events, 'markdown', { all: true }), /fictional-opaque-demo/);
});

test('malformed headers, truncated JSONL and invalid clocks fail before any archive is published', async () => {
  assert.throws(() => parse([{ type: 'session_meta', payload: {} }]), /session ID/);
  assert.throws(() => codexAdapter.parse(input(content + '{broken')), /line 15/);
  assert.throws(() => parse([rows[0], { ...rows[3], timestamp: 'bad-clock' }]), /timestamp/);
  const store = new LocalSessionStore(await mkdtemp(join(tmpdir(), 'ctxcrate-codex-corrupt-')));
  const path = join(store.root, 'rollout-bad.jsonl'); await writeFile(path, content + '{broken');
  await assert.rejects(importFile(store, new AdapterRegistry(), path), /Invalid Codex JSONL/);
  assert.deepEqual(await store.list(), []);
  assert.equal((await readdir(store.root)).includes('sessions'), false);
});

test('exit-code examples in shell stdout do not become native process status', () => {
  const session = parse([rows[0], response({ type: 'function_call', name: 'exec_command', call_id: 'demo', arguments: '{"cmd":"echo example"}' }),
    response({ type: 'function_call_output', call_id: 'demo', output: 'Example output:\nProcess exited with code 1\n' })]);
  assert.equal(projectTimeline(archive(session)).at(-1).label, 'Shell result');
});

test('directory discovery imports active/archive rollouts, skips indexes and supports safe retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctxcrate-codex-directory-'));
  const active = join(root, 'sessions', '2026', '10', '01'), archived = join(root, 'archived_sessions');
  await mkdir(active, { recursive: true }); await mkdir(archived);
  await writeFile(join(active, 'rollout-one.jsonl'), content);
  await writeFile(join(archived, 'rollout-copy.jsonl'), content);
  await writeFile(join(root, 'history.jsonl'), '{bad-index');
  await writeFile(join(root, 'session_index.jsonl'), '{bad-index');
  const store = new LocalSessionStore(join(root, 'library')), registry = new AdapterRegistry();
  assert.equal((await discoverCodexLogs(root)).length, 2);
  const result = await importSessionDirectory(store, registry, root, { adapter: 'codex' });
  assert.deepEqual(result.sessions.map(s => s.status), ['created', 'exists']);
  assert.equal((await importSessionDirectory(store, registry, root)).sessions.every(s => s.status === 'exists'), true);
  await mkdir(join(root, 'dsh'));
  await writeFile(join(root, 'dsh', 'session.v4.jsonl'), await readFile('examples/deepseek-session.jsonl', 'utf8'));
  const mixed = await importSessionDirectory(store, registry, root);
  assert.equal(mixed.sessions.length, 3);
  assert.deepEqual((await store.list()).map(s => s.adapter).sort(), ['codex', 'deepseek-harness']);
  const broken = join(archived, 'rollout-z-broken.jsonl'); await writeFile(broken, content + '{bad');
  await assert.rejects(importSessionDirectory(store, registry, root, { adapter: 'codex' }), /earlier imports are retained/);
  assert.equal((await store.list()).length, 2);
  await assert.rejects(importSessionDirectory(store, registry, root, { adapter: 'json' }), /supports codex or deepseek/);
});

test('CLI Codex import, history, playback projection and Markdown/JSON exports work together', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ctxcrate-codex-cli-'));
  const cli = (...args) => execFileSync(process.execPath, ['dist/cli.js', '--library', root, ...args], { encoding: 'utf8', stdio: 'pipe' });
  cli('import', 'examples/codex-rollout.jsonl');
  const sessions = JSON.parse(cli('history', '--adapter', 'codex', '--json'));
  assert.equal(sessions.length, 1); assert.equal(sessions[0].messageCount, 3);
  const id = sessions[0].id;
  const shown = cli('show', id, '--timezone', 'Asia/Singapore');
  assert.match(shown, /\[10:00:04\] Shell: npm.cmd test/);
  assert.match(shown, /Test failed/); assert.equal((shown.match(/User:/g) ?? []).length, 1);
  assert.match(cli('show', id, '--replay', '--max-delay', '0'), /Test failed/);
  const json = join(root, 'export.json'); cli('export', id, '-o', json);
  assert.equal(parseSessionJson(await readFile(json, 'utf8'))[0].data.source.format, 'codex-rollout');
  assert.match(cli('import', json), /^exists/);
  assert.match(cli('export', id, '--format', 'markdown'), /Expected \/dashboard but received \/login/);
  assert.match(cli('adapters'), /^codex\s/m);
});
