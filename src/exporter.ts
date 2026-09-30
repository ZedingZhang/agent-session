import { extname } from 'node:path';
import { z } from 'zod';
import { canonical, eventSchema, metadataSchema, parseArchive, serialize } from './schema.js';
import type { SessionEvent } from './schema.js';
import { formatTimelineEntry, projectTimeline, sanitizeTerminal, timelineSpansDays } from './timeline.js';

export type ExportFormat = 'jsonl' | 'json' | 'markdown';
export interface ExportOptions { all?: boolean; timeZone?: string }
export const sessionJsonSchema = z.object({
  format: z.enum(['ctxcrate', 'agent-session']), schemaVersion: z.literal(1),
  sessionId: z.string().regex(/^[a-f0-9]{64}$/), metadata: metadataSchema,
  events: z.array(eventSchema).min(1),
}).strict();

/** Explicit format wins; otherwise infer from a known output extension, defaulting to JSONL. */
export function resolveExportFormat(format?: string, filename?: string): ExportFormat {
  if (format !== undefined) {
    if (format === 'md' || format === 'markdown') return 'markdown';
    if (format === 'json' || format === 'jsonl') return format;
    throw new Error(`Unknown export format: ${format}; choose markdown, json or jsonl`);
  }
  const extension = extname(filename ?? '').toLowerCase();
  return extension === '.json' ? 'json' : ['.md', '.markdown'].includes(extension) ? 'markdown' : 'jsonl';
}

/** Restore a lossless single-document export, checking wrapper metadata and archive identity. */
export function parseSessionJson(text: string): SessionEvent[] {
  const document = sessionJsonSchema.parse(JSON.parse(text.replace(/^\uFEFF/, '')));
  const events = parseArchive(serialize(document.events));
  if (document.sessionId !== events[0]!.sessionId || canonical(document.metadata) !== canonical(events[0]!.data)) {
    throw new Error('JSON export metadata/session ID does not match its event stream');
  }
  return events;
}

function literal(value: string): string {
  return sanitizeTerminal(value).replace(/\r?\n/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&');
}
function fenced(value: string, language = 'text'): string {
  const text = sanitizeTerminal(value).replace(/\r\n?/g, '\n');
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
}

/** Markdown is a complete readable timeline; JSON/JSONL retain every raw source field. */
export function exportSession(input: readonly SessionEvent[], format: ExportFormat, options: ExportOptions = {}): string {
  const events = parseArchive(serialize([...input]));
  const header = events[0]!;
  if (header.type !== 'session.imported') throw new Error('Missing session metadata');
  if (format === 'jsonl') return serialize(events);
  if (format === 'json') return JSON.stringify({ format: 'ctxcrate', schemaVersion: 1,
    sessionId: header.sessionId, metadata: header.data, events }, null, 2) + '\n';
  if (format !== 'markdown') throw new Error(`Unknown export format: ${String(format)}`);
  const timeZone = new Intl.DateTimeFormat('en', { timeZone: options.timeZone }).resolvedOptions().timeZone;
  const entries = projectTimeline(events, { all: options.all, verbose: true });
  const timeOptions = { timeZone, includeDate: timelineSpansDays(entries, timeZone) };
  const lines = [`# ${literal(header.data.title)}`, '',
    `- Session ID: ${header.sessionId}`,
    `- Adapter: ${literal(header.data.adapter.id)} @ ${literal(header.data.adapter.version)}`,
    `- Source format: ${literal(header.data.source.format)}`,
    ...(header.data.source.externalId ? [`- Source session ID: ${literal(header.data.source.externalId)}`] : []),
    `- Display timezone: ${literal(timeZone)}`, ''];
  for (const entry of entries) {
    const heading = formatTimelineEntry({ ...entry, text: '' }, timeOptions).trim().replace(/:$/, '');
    lines.push(`## ${heading}`, '', `Event: ${entry.seq}${entry.callId ? ` · Call: ${literal(entry.callId)}` : ''}`, '',
      fenced(entry.text, entry.label === 'Diff' ? 'diff' : 'text'), '');
  }
  if (!entries.length) lines.push('No visible timeline entries. Use --all to include source events.', '');
  return lines.join('\n');
}
