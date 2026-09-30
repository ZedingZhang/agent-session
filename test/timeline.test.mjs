import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectTimeline, formatTimelineEntry, timelineSpansDays, playbackDelay, replayTimeline,
  sanitizeTerminal, materialize, sha256, LocalSessionStore, AdapterRegistry, importFile, parseArchive } from '../dist/index.js';

const metadata = { title: 'Replay', adapter: { id: 'test', version: '1' }, source: { format: 'test', sha256: sha256('test') } };
const time = second => `2026-09-30T02:00:${String(second).padStart(2, '0')}.000Z`;
const call = (id, name, args, second = 1) => ({ type: 'tool.call', timestamp: time(second), data: { callId: id, name, arguments: args } });
const result = (id, content, options = {}, second = 2) => ({ type: 'tool.result', timestamp: time(second), data: { callId: id, content, ...options } });
const projection = drafts => projectTimeline(materialize(metadata, drafts));

test('login repair timeline displays user, agent, tools, recorded diff and non-error shell failure', async () => {
  const store = new LocalSessionStore(await mkdtemp(join(tmpdir(), 'agent-timeline-')));
  const imported = await importFile(store, new AdapterRegistry(), 'examples/login-replay.jsonl');
  const events = await store.read(imported.sessions[0].id);
  const before = JSON.stringify(events);
  const entries = projectTimeline(events);
  const text = entries.map(e => formatTimelineEntry(e, { timeZone: 'Asia/Singapore' })).join('\n');
  for (const line of ['[10:00:01] User: 帮我修复登录跳转问题', '[10:00:03] Agent: 我先查看认证逻辑',
    '[10:00:04] Tool: read_file src/auth/login.ts', '[10:00:06] Tool result: 245 lines',
    '[10:00:10] Tool: write_file src/auth/login.ts', '[10:00:11] Diff: src/auth/login.ts',
    "- redirect('/login')", "+ redirect('/dashboard')", '[10:00:15] Shell: npm test',
    '[10:00:21] Test failed: Expected /dashboard but received /login']) assert.ok(text.includes(line), line);
  assert.equal(JSON.stringify(events), before);
});
test('call IDs associate interleaved tool results with the correct command', () => {
  const entries = projection([call('read', 'read', { file_path: 'a.ts', limit: 5 }),
    call('test', 'bash', { command: 'npm test' }), result('read', 'file content', { raw: { data: { meta: { totalLines: 245, lines: [1, 2, 3, 4, 5] } } } }),
    result('test', 'FAIL login\n[exit code: 1]')]);
  assert.equal(entries[0].text, 'read a.ts (limit=5)');
  assert.equal(entries[2].label, 'Tool result'); assert.equal(entries[2].text, '5 lines shown (245 total)');
  assert.equal(entries[3].label, 'Test failed');
});
test('only recorded applied diffs are shown; failed writes and guessed before-state never produce diffs', () => {
  const failed = projection([call('edit', 'edit', { path: 'a', old_string: 'before', new_string: 'after' }),
    result('edit', 'Edit failed', { isError: true, raw: { data: { meta: { diffs: [{ oldText: 'before', newText: 'after' }] } } } })]);
  assert.ok(failed.every(e => e.label !== 'Diff'));
  const noData = projection([call('write', 'write_file', { path: 'a', content: 'new' }), result('write', 'Updated file')]);
  assert.ok(noData.every(e => e.label !== 'Diff'));
  const recorded = projection([call('write', 'write', { file_path: 'a' }), result('write', { path: 'a', before: 'old', after: 'new' })]);
  assert.equal(recorded.at(-1).label, 'Diff'); assert.match(recorded.at(-1).text, /- old\n\+ new/);
});
test('shell status uses explicit code and understands commands without classifying successful tests as failures', () => {
  const entries = projection([call('pass', 'exec_command', { cmd: 'npm run test:unit' }), result('pass', { stdout: '0 tests failed', exitCode: 0 }),
    call('fail', 'pwsh', { command: 'pytest' }), result('fail', { stdout: 'assertion failed', stderr: 'details', exitCode: 1 }),
    call('other', 'bash', { command: 'git status' }), result('other', 'fatal\n[exit code: 128]')]);
  assert.equal(entries[1].label, 'Shell result');
  assert.equal(entries[3].label, 'Test failed');
  assert.equal(entries[5].label, 'Shell failed');
  assert.equal(projection([call('pass', 'bash', { command: 'npm test' }), result('pass', '0 tests failed')])[1].label, 'Shell result');
});
test('unknown tools, orphan results and malformed arguments stay readable', () => {
  const entries = projection([call('unknown', 'community_tool', '{bad json'), result('orphan', 'Some output')]);
  assert.match(entries[0].text, /community_tool \{bad json/);
  assert.match(entries[1].text, /\(orphan\) Some output/);
});
test('missing and regressing timestamps preserve source order; multi-day output includes dates', () => {
  const events = materialize(metadata, [
    { type: 'message', timestamp: time(10), data: { role: 'user', content: 'first' } },
    { type: 'message', timestamp: null, data: { role: 'assistant', content: 'unknown' } },
    { type: 'message', timestamp: time(1), data: { role: 'assistant', content: 'clock went back' } },
    { type: 'message', timestamp: '2026-10-01T02:00:00Z', data: { role: 'assistant', content: 'next day' } },
  ]);
  const entries = projectTimeline(events);
  assert.deepEqual(entries.map(e => e.text), ['first', 'unknown', 'clock went back', 'next day']);
  assert.match(formatTimelineEntry(entries[1]), /^\[unknown time\]/);
  assert.equal(timelineSpansDays(entries, 'UTC'), true);
  assert.match(formatTimelineEntry(entries[3], { timeZone: 'UTC', includeDate: true }), /^\[2026-10-01 02:00:00\]/);
  assert.throws(() => formatTimelineEntry(entries[0], { timeZone: 'Not/AZone' }));
});
test('compact results highlight late failure diagnostics; verbose display retains all output and arguments', () => {
  const body = Array.from({ length: 50 }, (_, i) => `progress ${i}`).join('\n') + '\nExpected /dashboard but received /login\n[exit code: 1]';
  const events = materialize(metadata, [call('test', 'bash', { command: 'npm test' }), result('test', body)]);
  const compact = projectTimeline(events), verbose = projectTimeline(events, { verbose: true });
  assert.match(compact[1].text, /Expected \/dashboard but received \/login/);
  assert.match(compact[1].text, /excerpt/);
  assert.equal(verbose[1].text, body);
});
test('terminal escapes are removed and source lifecycle is opt-in', () => {
  const events = materialize(metadata, [{ type: 'message', timestamp: null, data: { role: 'user', content: '\x1b[2Jhello\x1b]0;evil\x07\nnext' } },
    { type: 'source.event', timestamp: null, data: { sourceType: 'turn/start', raw: { type: 'turn/start' } } }]);
  assert.equal(projectTimeline(events).length, 1);
  assert.equal(projectTimeline(events, { all: true }).length, 2);
  assert.equal(sanitizeTerminal('\x1b[31mhello\x1b[0m'), 'hello');
  assert.equal(formatTimelineEntry(projectTimeline(events)[0]), '[unknown time] User: hello\nnext');
});
test('playback timing is bounded, scaled, immediate for missing/negative clocks and cancellable', async () => {
  const a = { seq: 1, timestamp: time(1), label: 'User', text: 'a' };
  const b = { ...a, seq: 2, timestamp: time(11), text: 'b' };
  assert.equal(playbackDelay(a, b), 2000);
  assert.equal(playbackDelay(a, b, { speed: 10 }), 1000);
  assert.equal(playbackDelay(b, a), 0);
  assert.equal(playbackDelay(a, { ...b, timestamp: null }), 0);
  assert.throws(() => playbackDelay(a, b, { speed: 0 }), /positive/);
  assert.throws(() => playbackDelay(a, b, { maxDelayMs: -1 }), /nonnegative/);
  const played = []; for await (const entry of replayTimeline([a, b], { maxDelayMs: 0 })) played.push(entry);
  assert.deepEqual(played, [a, b]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(async () => { for await (const _ of replayTimeline([a], { signal: controller.signal })) {} }, /abort/i);
});
test('CLI show defaults to timeline, offers playback, and keeps JSONL output unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-timeline-cli-'));
  const store = new LocalSessionStore(root);
  const imported = await importFile(store, new AdapterRegistry(), 'examples/login-replay.jsonl');
  const id = imported.sessions[0].id;
  const cli = (...args) => execFileSync(process.execPath, ['dist/cli.js', '--library', root, 'show', id, ...args], { encoding: 'utf8', stdio: 'pipe' });
  const immediate = cli('--timezone', 'Asia/Singapore');
  assert.match(immediate, /\[10:00:21\] Test failed: Expected/);
  assert.equal(cli('--replay', '--max-delay', '0', '--timezone', 'Asia/Singapore'), immediate);
  assert.deepEqual(parseArchive(cli('--json')), await store.read(id));
  assert.throws(() => cli('--replay', '--speed', '0'), /positive/);
  assert.throws(() => cli('--json', '--replay'), /cannot be combined/);
});
