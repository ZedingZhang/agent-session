import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { unzipSync } from 'fflate';
import { AdapterRegistry } from './adapters/registry.js';
import { jsonSchema, materialize, parseArchive, sha256 } from './schema.js';
import type { SessionEvent } from './schema.js';
import type { AdapterInput } from './adapters/types.js';
import { LocalSessionStore } from './store.js';

export interface ImportOptions { adapter?: string; title?: string; maxBytes?: number }
export async function importFile(store: LocalSessionStore, registry: AdapterRegistry, filename: string, options: ImportOptions = {}) {
  const limit = options.maxBytes ?? 64 * 1024 * 1024;
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
    if (!inputs.length) throw new Error('ZIP contains no session[.v1–4].jsonl logs; unzip newer formats and inspect them first');
    warnings.push('ZIP media/files are not archived in MVP; attachment references remain in the original events.');
  } else inputs.push({ filename: basename(filename), content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
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
