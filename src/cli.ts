#!/usr/bin/env node
import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { AdapterRegistry } from './adapters/registry.js';
import { textContent } from './adapters/utils.js';
import { importFile } from './importer.js';
import { LocalSessionStore } from './store.js';
import { serialize } from './schema.js';
import type { SessionEvent, SessionMetadata } from './schema.js';

const program = new Command().name('agent-session').version('0.1.0')
  .description('Archive AI agent sessions locally as unified JSONL events')
  .option('--library <directory>', 'Local file library (or AGENT_SESSION_HOME)')
  .option('--plugin <module>', 'Load a trusted adapter package or ESM file', (value, previous: string[]) => [...previous, value], []);
const store = () => new LocalSessionStore(program.opts().library);
async function registry() {
  const result = new AdapterRegistry();
  for (const plugin of program.opts().plugin as string[]) await result.load(plugin);
  return result;
}
// Prevent terminal control sequences in imported text from manipulating the viewer.
const safe = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
function render(event: SessionEvent): string {
  const prefix = `[${event.seq}] ${event.timestamp ?? 'unknown time'}`;
  switch (event.type) {
    case 'message': return `${prefix} ${event.data.role}\n${textContent(event.data.content)}`;
    case 'tool.call': return `${prefix} tool.call ${event.data.name} (${event.data.callId})\n${textContent(event.data.arguments)}`;
    case 'tool.result': return `${prefix} tool.result (${event.data.callId})${event.data.isError ? ' ERROR' : ''}\n${textContent(event.data.content)}`;
    case 'source.event': return `${prefix} ${event.data.sourceType}\n${JSON.stringify(event.data.raw)}`;
    default: return '';
  }
}
program.command('init').description('Create a local library').action(async () => {
  await store().init(); console.log(`Library: ${store().root}`);
});
program.command('adapters').description('List built-in and loaded adapters').action(async () => {
  for (const adapter of (await registry()).list()) console.log(`${adapter.id}\t${adapter.version}\t${adapter.description}`);
});
program.command('import <file>').description('Import JSON/JSONL, Markdown or a DeepSeek export ZIP')
  .option('-a, --adapter <id>', 'Select an adapter explicitly').option('--title <title>', 'Override session title')
  .action(async (file, options) => {
    const result = await importFile(store(), await registry(), file, options);
    for (const session of result.sessions) console.log(`${session.status}\t${session.id}`);
    for (const warning of result.warnings) console.error(`Warning: ${warning}`);
  });
program.command('list').alias('history').description('List archived sessions')
  .option('--json', 'Print machine-readable summaries').option('--adapter <id>', 'Filter by adapter')
  .option('--query <text>', 'Filter by title').action(async options => {
    const sessions = (await store().list()).filter(s => (!options.adapter || s.adapter === options.adapter) &&
      (!options.query || s.title.toLowerCase().includes(options.query.toLowerCase())));
    if (options.json) console.log(JSON.stringify(sessions, null, 2));
    else if (!sessions.length) console.log('No sessions. Use agent-session import <file>.');
    else for (const s of sessions) console.log(safe(`${s.id.slice(0, 12)}\t${s.adapter}\t${s.messageCount} messages\t${s.lastTimestamp ?? 'unknown time'}\t${s.title}`));
  });
program.command('show <id>').description('View a session by full ID or unambiguous prefix (8+ characters)')
  .option('--json', 'Print the canonical JSONL event stream')
  .option('--all', 'Include source lifecycle and unknown events').action(async (id, options) => {
    const events = await store().read(id);
    if (options.json) { process.stdout.write(serialize(events)); return; }
    const metadata = events[0]!.data as SessionMetadata;
    console.log(safe(`${metadata.title}\n${events[0]!.sessionId}\nAdapter: ${metadata.adapter.id}\n`));
    for (const event of events.slice(1)) if (options.all || event.type !== 'source.event') console.log(safe(render(event)) + '\n');
  });
program.command('export <id>').description('Export a canonical JSONL archive')
  .option('-o, --output <file>', 'Write a new file (never overwrite)').action(async (id, options) => {
    const text = serialize(await store().read(id));
    if (options.output) await writeFile(options.output, text, { flag: 'wx', mode: 0o600 });
    else process.stdout.write(text);
  });
program.command('sync <other-library>').description('Merge two local libraries in both directions; never delete')
  .action(async other => console.log(JSON.stringify(await store().sync(other))));
try { await program.parseAsync(); }
catch (error) { console.error(safe(`Error: ${error instanceof Error ? error.message : String(error)}`)); process.exitCode = 1; }
