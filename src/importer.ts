import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { unzipSync } from 'fflate';
import { AdapterRegistry } from './adapters/registry.js';
import { jsonSchema, materialize, parseArchive, sha256 } from './schema.js';
import type { SessionEvent } from './schema.js';
import type { AdapterInput } from './adapters/types.js';
import { LocalSessionStore } from './store.js';
import { decompressZstdFrames } from './zstd.js';

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
