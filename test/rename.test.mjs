import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultLibrary, LocalSessionStore, AdapterRegistry, importFile, exportSession, parseSessionJson } from 'ctxcrate';

test('default library preserves legacy installations and prefers explicit settings and the new directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ctxcrate-home-'));
  const current = join(home, '.ctxcrate'), legacy = join(home, '.agent-session');
  assert.equal(defaultLibrary(home, {}), current);
  await mkdir(legacy);
  assert.equal(defaultLibrary(home, {}), legacy);
  await mkdir(current);
  assert.equal(defaultLibrary(home, {}), current);
  assert.equal(defaultLibrary(home, { AGENT_SESSION_HOME: legacy }), legacy);
  assert.equal(defaultLibrary(home, { CTXCRATE_HOME: current, AGENT_SESSION_HOME: legacy }), current);
});

test('legacy JSON exports retain archive identity and re-export with ctxcrate branding', async () => {
  const store = new LocalSessionStore(await mkdtemp(join(tmpdir(), 'ctxcrate-legacy-')));
  const registry = new AdapterRegistry();
  const { sessions } = await importFile(store, registry, 'examples/login-replay.jsonl');
  const events = await store.read(sessions[0].id);
  const document = JSON.parse(exportSession(events, 'json'));
  document.format = 'agent-session';
  const text = JSON.stringify(document);
  assert.deepEqual(parseSessionJson(text), events);
  const file = join(store.root, 'legacy.json');
  await writeFile(file, text);
  assert.deepEqual((await importFile(store, registry, file)).sessions, [{ id: sessions[0].id, status: 'exists' }]);
  assert.equal(JSON.parse(exportSession(parseSessionJson(text), 'json')).format, 'ctxcrate');
});

test('package and CLI expose the ctxcrate name and matching version', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(pkg.name, 'ctxcrate');
  assert.deepEqual(pkg.bin, { ctxcrate: 'dist/cli.js' });
  assert.equal(pkg.repository.url, 'git+https://github.com/ZedingZhang/ctxcrate.git');
  const cli = (...args) => execFileSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' });
  assert.match(cli('--help'), /^Usage: ctxcrate /);
  assert.equal(cli('--version').trim(), pkg.version);
});
