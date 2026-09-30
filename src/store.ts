import { link, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { canonical, parseArchive, serialize } from './schema.js';
import type { SessionEvent, SessionMetadata } from './schema.js';

export const defaultLibrary = () => resolve(process.env.AGENT_SESSION_HOME ?? join(homedir(), '.agent-session'));
export interface SessionSummary {
  id: string; title: string; adapter: string; eventCount: number; messageCount: number; lastTimestamp: string | null;
}
function errno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
export class LocalSessionStore {
  readonly root: string;
  constructor(root = defaultLibrary()) { this.root = resolve(root); }
  private get directory(): string { return join(this.root, 'sessions'); }
  async init(): Promise<void> { await mkdir(this.directory, { recursive: true }); }
  private async ids(): Promise<string[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if (errno(error, 'ENOENT')) return []; throw error; }
    return names.filter(n => /^[a-f0-9]{64}\.jsonl$/.test(n)).map(n => n.slice(0, -6)).sort();
  }
  async resolveId(prefix: string): Promise<string> {
    if (!/^[a-f0-9]{8,64}$/.test(prefix)) throw new Error('Session ID must be 8–64 lowercase hex characters');
    const matches = (await this.ids()).filter(id => id.startsWith(prefix));
    if (!matches.length) throw new Error(`Session not found: ${prefix}`);
    if (matches.length > 1) throw new Error(`Ambiguous session ID: ${prefix}; use a longer prefix`);
    return matches[0]!;
  }
  async read(prefix: string): Promise<SessionEvent[]> {
    const id = await this.resolveId(prefix);
    const events = parseArchive(await readFile(join(this.directory, `${id}.jsonl`), 'utf8'));
    if (events[0]!.sessionId !== id) throw new Error(`Filename/session ID mismatch: ${id}`);
    return events;
  }
  async save(events: SessionEvent[]): Promise<{ id: string; status: 'created' | 'exists' }> {
    // Validate the entire snapshot before touching the destination.
    const text = serialize(events);
    const verified = parseArchive(text);
    const id = verified[0]!.sessionId;
    await this.init();
    const target = join(this.directory, `${id}.jsonl`);
    const temp = join(this.directory, `.${randomUUID()}.tmp`);
    await writeFile(temp, text, { flag: 'wx', mode: 0o600 });
    try {
      // A hard link publishes a complete file atomically without overwriting another writer.
      await link(temp, target);
      return { id, status: 'created' };
    } catch (error) {
      if (!errno(error, 'EEXIST')) throw error;
      const existing = await this.read(id);
      if (canonical(existing) !== canonical(verified)) throw new Error(`Conflicting archive: ${id}`);
      return { id, status: 'exists' };
    } finally { await unlink(temp); }
  }
  async list(): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    for (const id of await this.ids()) {
      const events = await this.read(id);
      const metadata = events[0]!.data as SessionMetadata;
      summaries.push({ id, title: metadata.title, adapter: metadata.adapter.id, eventCount: events.length - 1,
        messageCount: events.filter(e => e.type === 'message').length,
        lastTimestamp: events.map(e => e.timestamp).filter((t): t is string => t !== null).sort().at(-1) ?? null });
    }
    return summaries.sort((a, b) => (b.lastTimestamp ?? '').localeCompare(a.lastTimestamp ?? '') || a.id.localeCompare(b.id));
  }
  async sync(otherRoot: string): Promise<{ pulled: number; pushed: number }> {
    const other = new LocalSessionStore(otherRoot);
    if (other.root === this.root) return { pulled: 0, pushed: 0 };
    // Preflight both libraries: corrupt input stops the operation before publication.
    const local = await Promise.all((await this.ids()).map(id => this.read(id)));
    const remote = await Promise.all((await other.ids()).map(id => other.read(id)));
    let pulled = 0, pushed = 0;
    for (const events of remote) if ((await this.save(events)).status === 'created') pulled++;
    for (const events of local) if ((await other.save(events)).status === 'created') pushed++;
    await this.init(); await other.init();
    return { pulled, pushed };
  }
}
