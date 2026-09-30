#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import { stat, writeFile } from 'node:fs/promises';
import { AdapterRegistry } from './adapters/registry.js';
import { importDshDirectory, importFile } from './importer.js';
import { LocalSessionStore } from './store.js';
import { serialize } from './schema.js';
import type { SessionMetadata } from './schema.js';
import { projectTimeline, formatTimelineEntry, timelineSpansDays, replayTimeline, sanitizeTerminal } from './timeline.js';
import { exportSession, resolveExportFormat } from './exporter.js';

const program = new Command().name('agent-session').version('0.4.0')
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
const safe = sanitizeTerminal;
function numeric(value: string, positive = true): number {
  const number = Number(value);
  if (!Number.isFinite(number) || (positive ? number <= 0 : number < 0)) throw new InvalidArgumentError(positive ? 'Expected a finite positive number' : 'Expected a finite nonnegative number');
  return number;
}
program.command('init').description('Create a local library').action(async () => {
  await store().init(); console.log(`Library: ${store().root}`);
});
program.command('adapters').description('List built-in and loaded adapters').action(async () => {
  for (const adapter of (await registry()).list()) console.log(`${adapter.id}\t${adapter.version}\t${adapter.description}`);
});
program.command('import <path>').description('Import a file or recursively import a native DSH session directory')
  .option('-a, --adapter <id>', 'Select an adapter explicitly').option('--title <title>', 'Override session title')
  .action(async (file, options) => {
    const isDirectory = (await stat(file)).isDirectory();
    const result = await (isDirectory ? importDshDirectory : importFile)(store(), await registry(), file, options);
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
program.command('show <id>').description('Display a session timeline by full ID or unambiguous prefix (8+ characters)')
  .option('--json', 'Print the canonical JSONL event stream')
  .option('--all', 'Include source lifecycle and unknown events')
  .option('--verbose', 'Print complete tool arguments, results and diffs')
  .option('--timezone <zone>', 'Display timezone, e.g. Asia/Singapore or UTC (default: system timezone)')
  .option('--replay', 'Play recorded events with timing; no commands are executed')
  .option('--speed <factor>', 'Playback speed multiplier', value => numeric(value), 1)
  .option('--max-delay <seconds>', 'Maximum pause between playback entries', value => numeric(value, false), 2)
  .action(async (id, options) => {
    if (options.json && options.replay) throw new Error('--json and --replay cannot be combined');
    const events = await store().read(id);
    if (options.json) { process.stdout.write(serialize(events)); return; }
    const timeZone = new Intl.DateTimeFormat('en', { timeZone: options.timezone }).resolvedOptions().timeZone;
    const entries = projectTimeline(events, options);
    const formatOptions = { timeZone, includeDate: timelineSpansDays(entries, timeZone) };
    const metadata = events[0]!.data as SessionMetadata;
    console.log(safe(`${metadata.title}\n${events[0]!.sessionId}\nAdapter: ${metadata.adapter.id}\nTimezone: ${timeZone}\n`));
    if (!entries.length) { console.log('No visible events. Use --all to include source events.'); return; }
    if (options.replay) {
      for await (const entry of replayTimeline(entries, { speed: options.speed, maxDelayMs: options.maxDelay * 1000 })) console.log(formatTimelineEntry(entry, formatOptions));
    } else for (const entry of entries) console.log(formatTimelineEntry(entry, formatOptions));
  });
program.command('export <id>').description('Export a session as Markdown, JSON or JSONL')
  .addOption(new Option('-f, --format <format>', 'Export format (otherwise inferred from output extension)').choices(['markdown', 'md', 'json', 'jsonl']))
  .option('-o, --output <file>', 'Write a new file (never overwrite)')
  .option('--all', 'Include source lifecycle and unknown events in Markdown')
  .option('--timezone <zone>', 'Markdown display timezone (default: system timezone)')
  .action(async (id, options) => {
    const format = resolveExportFormat(options.format, options.output);
    const text = exportSession(await store().read(id), format, { all: options.all, timeZone: options.timezone });
    if (options.output) await writeFile(options.output, text, { flag: 'wx', mode: 0o600 });
    else process.stdout.write(text);
  });
program.command('sync <other-library>').description('Merge two local libraries in both directions; never delete')
  .action(async other => console.log(JSON.stringify(await store().sync(other))));
try { await program.parseAsync(); }
catch (error) { console.error(safe(`Error: ${error instanceof Error ? error.message : String(error)}`)); process.exitCode = 1; }
