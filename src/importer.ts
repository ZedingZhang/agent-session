import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { unzipSync } from 'fflate';
import { AdapterRegistry } from './adapters/registry.js';
import { jsonSchema, materialize, parseArchive, sha256 } from './schema.js';
import type { SessionEvent } from './schema.js';
import type { AdapterInput } from './adapters/types.js';
import { LocalSessionStore } from './store.js';
import { decompressZstdFrames } from './zstd.js';
import { parseSessionJson } from './exporter.js';

export interface ImportOptions { adapter?: string; title?: string; maxBytes?: number }
export async function importFile(store: LocalSessionStore, registry: AdapterRegistry, filename: string, options: ImportOptions = {}) {
  const limit = options.maxBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('maxBytes must be a positive safe integer');
  if ((await stat(filename)).size > limit) throw new Error(`Input exceeds ${limit} bytes`);
  const bytes = await readFile(filename);
  if (bytes.length > limit) throw new Error(`Input exceeds ${limit} bytes`);
  const inputs: AdapterInput[] = [];
  const warnings: string[] = [];
  if (/\.zip$/i.test(filename)) {
    let total = 0;
    const entries = unzipSync(bytes, { filter(entry) {
      if (!/(^|\/)session(?:\.v[1-9]\d*)?\.jsonl$/.test(entry.name)) return false;
      total += entry.originalSize;
      if (total > limit) throw new Error(`ZIP session logs exceed ${limit} bytes`);
      return true;
    } });
    if (Object.values(entries).reduce((sum, entry) => sum + entry.length, 0) > limit) throw new Error('Decoded ZIP exceeds byte limit');
    for (const name of Object.keys(entries).sort()) inputs.push({ filename: name, content: new TextDecoder('utf-8', { fatal: true }).decode(entries[name]) });
    if (!inputs.length) throw new Error('ZIP contains no session[.vN].jsonl logs');
    warnings.push('ZIP media/files are not archived in MVP; attachment references remain in the original events.');
  } else {
    const compressed = /\.jsonl\.zstd$/i.test(filename);
    const plaintext = compressed ? decompressZstdFrames(bytes, limit) : bytes;
    inputs.push({ filename: basename(filename).replace(/\.zstd$/i, ''),
      content: new TextDecoder('utf-8', { fatal: true }).decode(plaintext) });
  }
  const archives: SessionEvent[][] = [];
  for (const input of inputs) {
    let sessionJson = false;
    try {
      const format = JSON.parse(input.content.replace(/^\uFEFF/, '')).format;
      sessionJson = format === 'ctxcrate' || format === 'agent-session';
    } catch { /* Other input formats. */ }
    if (sessionJson) {
      if (options.title || options.adapter) throw new Error('Canonical JSON exports cannot be retitled or re-adapted');
      archives.push(parseSessionJson(input.content)); continue;
    }
    // Canonical archives can be re-imported without re-normalization or changed IDs.
    const first = input.content.replace(/^\uFEFF/, '').split(/\r?\n/)[0];
    let canonicalArchive = false;
    try { canonicalArchive = JSON.parse(first ?? '').type === 'session.imported'; } catch { /* Adapter parses input. */ }
    if (canonicalArchive) {
      if (options.title || options.adapter) throw new Error('Canonical archives cannot be retitled or re-adapted');
      archives.push(parseArchive(input.content)); continue;
    }
    const adapter = registry.select(input, options.adapter);
    const sessions = await adapter.parse(input);
    if (!sessions.length) throw new Error(`Adapter ${adapter.id} returned no sessions`);
    for (const session of sessions) {
      archives.push(materialize({ title: options.title ?? session.title,
        adapter: { id: adapter.id, version: adapter.version },
        source: { format: session.sourceFormat, sha256: sha256(session.sourceContent),
          ...(session.externalId !== undefined ? { externalId: session.externalId } : {}),
          ...(session.header !== undefined ? { header: jsonSchema.parse(session.header) } : {}) } }, session.events));
    }
  }
  const results = [];
  for (const archive of archives) results.push(await store.save(archive));
  return { sessions: results, warnings };
}

/** Recursively find the latest native DSH generation in each session directory. */
export async function discoverDshLogs(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  let latest: { path: string; version: number; compressed: boolean } | undefined;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discoverDshLogs(path));
    else if (entry.isFile()) {
      const match = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/.exec(entry.name);
      if (!match) continue;
      const version = Number(match[1] ?? 0), compressed = !!match[2];
      if (!latest || version > latest.version || (version === latest.version && compressed)) latest = { path, version, compressed };
    }
  }
  if (latest) files.push(latest.path);
  return files.sort();
}

export async function importDshDirectory(store: LocalSessionStore, registry: AdapterRegistry, directory: string, options: ImportOptions = {}) {
  const files = await discoverDshLogs(directory);
  if (!files.length) throw new Error('Directory contains no native DSH session[.vN].jsonl[.zstd] files');
  const sessions: { id: string; status: 'created' | 'exists' }[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    try {
      const result = await importFile(store, registry, file, { ...options, adapter: options.adapter ?? 'deepseek-harness' });
      sessions.push(...result.sessions); warnings.push(...result.warnings);
    } catch (cause) {
      throw new Error(`Directory import stopped at ${file}; earlier imports are retained and retrying is safe. ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
  }
  return { sessions, warnings };
}

/** Discover only native rollout files; history.jsonl and session_index.jsonl are not transcripts. */
export async function discoverCodexLogs(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  const nativeRoots = entries.filter(e => e.isDirectory() && ['sessions', 'archived_sessions'].includes(e.name));
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && /^rollout-.+\.jsonl$/.test(entry.name)) files.push(child);
    }
  };
  // A Codex home can contain plugin caches and fixtures: only scan its native history trees.
  if (nativeRoots.length) for (const root of nativeRoots) await walk(join(directory, root.name));
  else await walk(directory);
  return files.sort();
}

/** Directory adapters are explicit when supplied; automatic mode discovers both native formats. */
export async function importSessionDirectory(store: LocalSessionStore, registry: AdapterRegistry, directory: string, options: ImportOptions = {}) {
  if (options.adapter && !['codex', 'deepseek-harness'].includes(options.adapter))
    throw new Error('Directory import supports codex or deepseek-harness adapters');
  const files: { path: string; adapter: string }[] = [];
  if (options.adapter !== 'codex') files.push(...(await discoverDshLogs(directory)).map(path => ({ path, adapter: 'deepseek-harness' })));
  if (options.adapter !== 'deepseek-harness') files.push(...(await discoverCodexLogs(directory)).map(path => ({ path, adapter: 'codex' })));
  if (!files.length) throw new Error(`Directory contains no native ${options.adapter ?? 'DSH or Codex'} session logs`);
  const sessions: { id: string; status: 'created' | 'exists' }[] = [], warnings: string[] = [];
  for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
    try {
      const result = await importFile(store, registry, file.path, { ...options, adapter: file.adapter });
      sessions.push(...result.sessions); warnings.push(...result.warnings);
    } catch (cause) {
      throw new Error(`Directory import stopped at ${file.path}; earlier imports are retained and retrying is safe. ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
  }
  return { sessions, warnings };
}
