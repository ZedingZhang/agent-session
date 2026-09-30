import { basename } from 'node:path';
import { jsonSchema, roleSchema } from '../schema.js';
import type { EventDraft } from '../schema.js';
import type { SessionAdapter } from './types.js';
import { object, timestamp } from './utils.js';

function records(content: string): Record<string, unknown>[] {
  const rows = content.replace(/^\uFEFF/, '').split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [object(JSON.parse(line))]; }
    catch { throw new Error(`Invalid Codex JSONL at line ${index + 1}`); }
  });
  const header = rows[0];
  if (!header || header.type !== 'session_meta') throw new Error('Expected a Codex rollout session_meta header');
  const meta = object(header.payload);
  if (typeof (meta.id ?? meta.session_id) !== 'string' || !(meta.id ?? meta.session_id))
    throw new Error('Codex session_meta is missing a session ID');
  return rows;
}
function payload(row: Record<string, unknown>): Record<string, unknown> {
  return row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown> : {};
}
function blocks(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map(block => {
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      const b = block as Record<string, unknown>;
      if (['input_text', 'output_text'].includes(String(b.type)) && typeof b.text === 'string') return { ...b, type: 'text' };
    }
    return block;
  });
}
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap(block => {
    const b = block && typeof block === 'object' ? block as Record<string, unknown> : {};
    return ['input_text', 'output_text', 'text'].includes(String(b.type)) && typeof b.text === 'string' ? [b.text] : [];
  }).join('\n');
}
function messageKey(row: Record<string, unknown>): string | undefined {
  const p = payload(row);
  const role = row.type === 'response_item' && p.type === 'message' ? p.role
    : row.type === 'event_msg' ? ({ user_message: 'user', agent_message: 'assistant' } as Record<string, string>)[String(p.type)] : undefined;
  const text = row.type === 'response_item' ? messageText(p.content) : typeof p.message === 'string' ? p.message : '';
  return ['user', 'assistant'].includes(String(role)) && text ? JSON.stringify([role, text]) : undefined;
}
/** Pair exact mirror messages one-for-one inside turn boundaries; never deduplicate repeated turns. */
function mirrorIndexes(rows: Record<string, unknown>[]): Set<number> {
  const mirrors = new Set<number>();
  let start = 1;
  const flush = (end: number) => {
    const available = new Map<string, number>();
    for (let i = start; i < end; i++) {
      if (rows[i]!.type !== 'response_item') continue;
      const key = messageKey(rows[i]!);
      if (key) available.set(key, (available.get(key) ?? 0) + 1);
    }
    for (let i = start; i < end; i++) {
      if (rows[i]!.type !== 'event_msg') continue;
      const key = messageKey(rows[i]!);
      const count = key ? available.get(key) ?? 0 : 0;
      if (key && count) { available.set(key, count - 1); mirrors.add(i); }
    }
  };
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i]!.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(String(payload(rows[i]!).type))) || rows[i]!.type === 'compacted') {
      flush(i); start = i + 1;
    }
  }
  flush(rows.length);
  return mirrors;
}
export const codexAdapter: SessionAdapter = {
  id: 'codex', version: '1.0.0', description: 'Codex CLI native rollout JSONL (session_meta / response_item / event_msg)',
  detect(input) {
    try {
      const first = input.content.replace(/^\uFEFF/, '').split(/\r?\n/).find(line => line.trim());
      return object(JSON.parse(first ?? '')).type === 'session_meta';
    } catch { return false; }
  },
  parse(input) {
    const rows = records(input.content), header = rows[0]!, meta = object(header.payload);
    const mirrors = mirrorIndexes(rows), events: EventDraft[] = [];
    let title = typeof meta.title === 'string' && meta.title.trim() ? meta.title : '';
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]!, p = payload(row), time = timestamp(row.timestamp);
      let event: EventDraft | undefined;
      if (row.type === 'response_item') {
        if (p.type === 'message' && roleSchema.safeParse(p.role).success && p.content !== undefined) {
          event = { type: 'message', timestamp: time, data: { role: roleSchema.parse(p.role), content: jsonSchema.parse(blocks(p.content)), raw: jsonSchema.parse(row) } };
        } else if (['function_call', 'custom_tool_call'].includes(String(p.type)) && typeof p.call_id === 'string' && p.call_id && typeof p.name === 'string' && p.name) {
          event = { type: 'tool.call', timestamp: time, data: { callId: p.call_id,
            name: typeof p.namespace === 'string' && p.namespace ? `${p.namespace}.${p.name}` : p.name,
            arguments: jsonSchema.parse((p.type === 'function_call' ? p.arguments : p.input) ?? null), raw: jsonSchema.parse(row) } };
        } else if (['function_call_output', 'custom_tool_call_output'].includes(String(p.type)) && typeof p.call_id === 'string' && p.call_id && p.output !== undefined) {
          event = { type: 'tool.result', timestamp: time, data: { callId: p.call_id, content: jsonSchema.parse(blocks(p.output)),
            ...(typeof p.is_error === 'boolean' ? { isError: p.is_error } : {}), raw: jsonSchema.parse(row) } };
        } else if (p.type === 'local_shell_call' && typeof (p.call_id ?? p.id) === 'string' && (p.call_id ?? p.id) && p.action !== undefined) {
          event = { type: 'tool.call', timestamp: time, data: { callId: String(p.call_id ?? p.id), name: 'shell',
            arguments: jsonSchema.parse(p.action), raw: jsonSchema.parse(row) } };
        }
      } else if (row.type === 'event_msg' && !mirrors.has(i) && ['user_message', 'agent_message'].includes(String(p.type)) && typeof p.message === 'string') {
        event = { type: 'message', timestamp: time, data: { role: p.type === 'user_message' ? 'user' : 'assistant', content: p.message, raw: jsonSchema.parse(row) } };
      }
      events.push(event ?? { type: 'source.event', timestamp: time, data: {
        sourceType: `codex.${String(row.type ?? 'unknown')}${typeof p.type === 'string' ? `.${p.type}` : ''}`, raw: jsonSchema.parse(row),
      } });
      if (!title && event?.type === 'message' && event.data.role === 'user') {
        const candidates = Array.isArray(event.data.content) ? event.data.content : [event.data.content];
        const text = candidates.map(c => messageText(typeof c === 'string' ? c : [c]))
          .find(t => t.trim() && !/^\s*<(?:environment_context|user_instructions|permissions|system|developer)/i.test(t));
        if (text) title = text.trim().split(/\r?\n/)[0]!.slice(0, 120);
      }
    }
    return [{ title: title || basename(input.filename), sourceFormat: 'codex-rollout', sourceContent: input.content,
      externalId: String(meta.id ?? meta.session_id), header: jsonSchema.parse(header), events }];
  },
};
