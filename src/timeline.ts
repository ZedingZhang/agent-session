import { diffLines } from 'diff';
import { setTimeout as delay } from 'node:timers/promises';
import { textContent } from './adapters/utils.js';
import type { SessionEvent } from './schema.js';

export type TimelineLabel = 'User' | 'Agent' | 'System' | 'Developer' | 'Tool' | 'Tool result' |
  'Tool failed' | 'Diff' | 'Shell' | 'Shell result' | 'Shell failed' | 'Test failed' | 'Source';
export interface TimelineEntry {
  seq: number; timestamp: string | null; label: TimelineLabel; text: string; callId?: string;
}
export interface TimelineOptions { all?: boolean; verbose?: boolean }
export interface TimeFormatOptions { timeZone?: string; includeDate?: boolean }
export interface PlaybackOptions { speed?: number; maxDelayMs?: number; signal?: AbortSignal }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function parsed(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return record(value);
  try { return record(JSON.parse(value)); } catch { return {}; }
}
function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}
function toolName(name: string): string { return name.toLowerCase().split(/[./:]/).at(-1)!; }
const shellNames = new Set(['bash', 'shell', 'pwsh', 'powershell', 'exec_command', 'run_command', 'run_shell', 'execute_shell', 'terminal']);
const readNames = new Set(['read', 'read_file', 'readfile']);
const editNames = new Set(['edit', 'edit_file', 'write', 'write_file', 'apply_patch', 'str_replace_editor']);
function pathOf(args: Record<string, unknown>): string | undefined {
  return firstString(args.file_path, args.path, args.filePath, args.filename);
}
function preview(text: string, verbose = false, maxLines = 8, maxChars = 1200): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (verbose) return normalized;
  const lines = normalized.split('\n');
  const result = lines.slice(0, maxLines).join('\n').slice(0, maxChars);
  return result.length < normalized.length ? `${result}\n… (truncated; use --verbose for full output)` : result;
}
function failurePreview(text: string, verbose = false): string {
  if (verbose) return preview(text, true);
  const lines = text.replace(/\r\n?/g, '\n').trim().split('\n');
  if (lines.length <= 8) return preview(text);
  const selected = new Set<number>();
  for (const [index, line] of lines.entries()) {
    if (/(?:AssertionError|Expected|Received|\bFAIL\b|\bError:|\berror:|tests? failed|[✖×]|\[exit code:)/.test(line)) {
      for (let i = Math.max(0, index - 1); i <= Math.min(lines.length - 1, index + 2); i++) selected.add(i);
    }
  }
  if (!selected.size) return preview(text);
  return preview([...selected].sort((a, b) => a - b).map(i => lines[i]!).join('\n')) + '\n… (excerpt; use --verbose for full output)';
}
/** Remove ANSI/OSC sequences as well as terminal control characters from display text. */
export function sanitizeTerminal(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
function callSummary(name: string, value: unknown, verbose = false): string {
  const args = parsed(value);
  const command = firstString(args.command, args.cmd, args.script);
  if (shellNames.has(toolName(name))) return command ?? preview(textContent(value), verbose);
  const path = pathOf(args);
  if (path) {
    if (verbose) return `${name} ${path}\n${textContent(value)}`;
    const range = readNames.has(toolName(name)) ? ['offset', 'limit'].filter(k => args[k] !== undefined)
      .map(k => `${k}=${String(args[k])}`).join(', ') : '';
    return `${name} ${path}${range ? ` (${range})` : ''}`;
  }
  return `${name} ${preview(textContent(value), verbose, 3, 300)}`.trim();
}
function resultMeta(event: Extract<SessionEvent, { type: 'tool.result' }>): Record<string, unknown> {
  const raw = record(event.data.raw), data = record(raw.data);
  return record(data.meta ?? raw.meta ?? record(event.data.content).meta);
}
function outputObject(content: unknown): Record<string, unknown> {
  const value = record(content);
  return Object.keys(value).length ? value : parsed(textContent(content));
}
function outputText(content: unknown): string {
  const value = outputObject(content);
  if (value.stdout !== undefined || value.stderr !== undefined) {
    const stdout = firstString(value.stdout, record(value.stdout).text) ?? '';
    const stderr = firstString(value.stderr, record(value.stderr).text) ?? '';
    return [stdout, stderr ? `[stderr]\n${stderr}` : ''].filter(Boolean).join('\n');
  }
  return textContent(content);
}
interface RecordedDiff { path?: string; oldText: string | null; newText: string }
function recordedDiffs(meta: Record<string, unknown>, content: Record<string, unknown>): RecordedDiff[] {
  const diffs = meta.diffs ?? content.diffs;
  if (Array.isArray(diffs)) return diffs.flatMap(value => {
    const item = record(value);
    return (typeof item.oldText === 'string' || item.oldText === null) && typeof item.newText === 'string' && (item.oldText ?? '') !== item.newText
      ? [{ ...(typeof item.path === 'string' ? { path: item.path } : {}), oldText: item.oldText, newText: item.newText }] : [];
  });
  if ((typeof content.before === 'string' || content.before === null) && typeof content.after === 'string' && (content.before ?? '') !== content.after) {
    return [{ ...(typeof content.path === 'string' ? { path: content.path } : {}), oldText: content.before, newText: content.after }];
  }
  return [];
}
function diffText(diff: RecordedDiff, verbose = false): string {
  const before = diff.oldText ?? '', after = diff.newText;
  // Bound work on full-file payloads; coarse before/after display is still faithful to recorded data.
  const changes = before.length + after.length <= 400000
    ? diffLines(before, after, { maxEditLength: 1000, timeout: 100 }) : undefined;
  const parts = changes ?? [{ value: before, removed: true }, { value: after, added: true }];
  const output: string[] = [];
  const limit = verbose ? Infinity : 200;
  let truncated = false;
  outer: for (const part of parts) {
    if (!part.value) continue;
    const lines = part.value.replace(/\r\n?/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) {
      if (output.length === limit) { truncated = true; break outer; }
      output.push(`${part.removed ? '- ' : part.added ? '+ ' : '  '}${line}`);
    }
  }
  return `${diff.path ? `${diff.path}\n` : ''}${output.join('\n')}${truncated ? '\n… (diff truncated; use --verbose)' : ''}`;
}
function isTestCommand(command: string): boolean {
  return /(?:^|[;&|]\s*)\s*(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:[\s:]|$)|(?:npx\s+)?(?:vitest|jest|pytest)\b|(?:cargo|go|dotnet|mvn|gradle)\s+test\b|node\s+--test\b|ctest\b)/i.test(command);
}

/** A read-only display projection. Archive order wins over possibly missing/regressing clocks. */
export function projectTimeline(events: readonly SessionEvent[], options: TimelineOptions = {}): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const calls = new Map<string, Extract<SessionEvent, { type: 'tool.call' }>>();
  const knownCallIds = new Set(events.filter(e => e.type === 'tool.call').map(e => e.data.callId));
  const add = (event: SessionEvent, label: TimelineLabel, text: string, callId?: string) => {
    entries.push({ seq: event.seq, timestamp: event.timestamp, label, text, ...(callId ? { callId } : {}) });
  };
  for (const event of events) {
    switch (event.type) {
      case 'session.imported': break;
      case 'message': {
        const roleLabels = { user: 'User', assistant: 'Agent', system: 'System', developer: 'Developer', tool: 'Tool result' } as const;
        const content = Array.isArray(event.data.content) ? event.data.content.filter(block => {
          const value = record(block);
          return !(value.type === 'tool-call' && knownCallIds.has(String(value.id ?? value.toolCallId)));
        }) : event.data.content;
        // An assistant message can consist solely of tool-call blocks already displayed below.
        if (Array.isArray(content) && !content.length) break;
        add(event, roleLabels[event.data.role], textContent(content)); break;
      }
      case 'tool.call': {
        calls.set(event.data.callId, event);
        add(event, shellNames.has(toolName(event.data.name)) ? 'Shell' : 'Tool',
          callSummary(event.data.name, event.data.arguments, options.verbose), event.data.callId); break;
      }
      case 'tool.result': {
        const call = calls.get(event.data.callId);
        const name = call ? toolName(call.data.name) : '';
        const args = call ? parsed(call.data.arguments) : {};
        const meta = resultMeta(event), value = outputObject(event.data.content);
        const text = outputText(event.data.content);
        const status = value.exitCode ?? meta.exitCode ?? /\[exit code:\s*(-?\d+)\]/i.exec(text)?.[1];
        const exitCode = status !== undefined && status !== null && /^-?\d+$/.test(String(status)) ? Number(status) : undefined;
        const testFailure = /(?:^|\n)\s*(?:FAIL(?:ED)?\b|[✖×]|AssertionError\b|Expected[^\n]+(?:but received|but got))|\b[1-9]\d*\s+(?:tests?\s+)?failed\b/i.test(text);
        const shell = shellNames.has(name);
        const command = firstString(args.command, args.cmd, args.script) ?? '';
        const testFailed = shell && isTestCommand(command) && (exitCode !== undefined ? exitCode !== 0 : testFailure);
        const failed = event.data.isError === true || value.isError === true || value.success === false ||
          (exitCode !== undefined && exitCode !== 0) || testFailed;
        const label: TimelineLabel = testFailed ? 'Test failed' : shell ? (failed ? 'Shell failed' : 'Shell result') : (failed ? 'Tool failed' : 'Tool result');
        let summary = text || '(no output)';
        if (!options.verbose && !failed && readNames.has(name)) {
          const count = meta.totalLines ?? value.totalLines;
          const shown = Array.isArray(meta.lines) ? meta.lines.length : Array.isArray(value.lines) ? value.lines.length : undefined;
          if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) {
            summary = shown !== undefined && shown < count ? `${shown} lines shown (${count} total)` : `${count} lines`;
          }
        }
        if (shell && exitCode !== undefined && !/\[exit code:/i.test(summary)) summary += `\n[exit code: ${exitCode}]`;
        add(event, label, `${call ? '' : `(${event.data.callId}) `}${failed ? failurePreview(summary, options.verbose) : preview(summary, options.verbose)}`, event.data.callId);
        if (!failed) {
          const diffs = recordedDiffs(meta, value);
          // Without recorded applied changes, show only an explicit recorded patch after success.
          const patch = firstString(value.diff, meta.diff);
          if (diffs.length) for (const diff of diffs) add(event, 'Diff', diffText(diff, options.verbose), event.data.callId);
          else if (patch && editNames.has(name)) add(event, 'Diff', preview(patch, options.verbose, 200, 20000), event.data.callId);
        }
        break;
      }
      case 'source.event':
        if (options.all) add(event, 'Source', `${event.data.sourceType}\n${preview(JSON.stringify(event.data.raw), options.verbose)}`);
        break;
    }
  }
  return entries;
}

function dateParts(timestamp: string, timeZone?: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
}
export function timelineSpansDays(entries: readonly TimelineEntry[], timeZone?: string): boolean {
  return new Set(entries.filter(e => e.timestamp).map(e => {
    const parts = dateParts(e.timestamp!, timeZone);
    return `${parts.year}-${parts.month}-${parts.day}`;
  })).size > 1;
}
export function formatTimelineEntry(entry: TimelineEntry, options: TimeFormatOptions = {}): string {
  let time = 'unknown time';
  if (entry.timestamp) {
    const parts = dateParts(entry.timestamp, options.timeZone);
    time = `${options.includeDate ? `${parts.year}-${parts.month}-${parts.day} ` : ''}${parts.hour}:${parts.minute}:${parts.second}`;
  }
  const body = sanitizeTerminal(entry.text).replace(/\r\n?/g, '\n');
  return `[${time}] ${entry.label}:${body.startsWith('\n') ? '' : ' '}${body}`;
}
export function playbackDelay(previous: TimelineEntry | undefined, current: TimelineEntry, options: PlaybackOptions = {}): number {
  const speed = options.speed ?? 1, maxDelay = options.maxDelayMs ?? 2000;
  if (!Number.isFinite(speed) || speed <= 0) throw new Error('Playback speed must be a finite positive number');
  if (!Number.isFinite(maxDelay) || maxDelay < 0) throw new Error('Maximum playback delay must be a finite nonnegative number');
  if (!previous?.timestamp || !current.timestamp) return 0;
  return Math.min(maxDelay, Math.max(0, Date.parse(current.timestamp) - Date.parse(previous.timestamp)) / speed);
}
export async function* replayTimeline(entries: readonly TimelineEntry[], options: PlaybackOptions = {}): AsyncGenerator<TimelineEntry> {
  let previous: TimelineEntry | undefined;
  playbackDelay(undefined, entries[0] ?? { seq: 0, timestamp: null, label: 'Source', text: '' }, options);
  for (const entry of entries) {
    options.signal?.throwIfAborted();
    const milliseconds = playbackDelay(previous, entry, options);
    if (milliseconds) await delay(milliseconds, undefined, { signal: options.signal });
    yield entry; previous = entry;
  }
}
