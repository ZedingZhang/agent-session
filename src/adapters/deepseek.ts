import { basename } from 'node:path';
import { roleSchema, jsonSchema } from '../schema.js';
import type { EventDraft } from '../schema.js';
import type { SessionAdapter } from './types.js';
import { object, parseJson, sourceEvent, timestamp } from './utils.js';
export const deepseekAdapter: SessionAdapter = {
  id: 'deepseek-harness', version: '1.1.0', description: 'DeepSeek Harness native JSONL / concatenated .jsonl.zstd (headers 0–4)',
  detect(input) {
    try {
      const parsed = parseJson(input.content);
      const header = Array.isArray(parsed) ? parsed[0] : object(parsed).type === 'session' ? parsed : object(parsed).header;
      return !!header && object(header).type === 'session';
    } catch { return false; }
  },
  parse(input) {
    const parsed = parseJson(input.content);
    const root = Array.isArray(parsed) ? undefined : object(parsed);
    const header = object(Array.isArray(parsed) ? parsed[0] : root?.type === 'session' ? root : root?.header);
    if (header.type !== 'session' || ![0, 1, 2, 3, 4].includes(header.version as number))
      throw new Error('Expected a DeepSeek Harness session header with version 0–4');
    const rows = Array.isArray(parsed) ? parsed.slice(1) : root?.type === 'session' ? [] : root?.events;
    if (!Array.isArray(rows)) throw new Error('Missing DeepSeek Harness events');
    const events: EventDraft[] = [];
    let title = basename(input.filename);
    for (const value of rows) {
      const row = object(value);
      if (typeof row.type !== 'string') throw new Error('DeepSeek event is missing type');
      const time = timestamp(row.time ?? row.time0);
      const data = row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? object(row.data) : {};
      if (row.type === 'session/title' && typeof data.title === 'string' && data.title) title = data.title;
      if (['system/message', 'developer/message', 'user/message', 'human/message', 'assistant/message'].includes(row.type)) {
        const msg = data.message === undefined ? data : object(data.message);
        if (msg.content === undefined) { events.push(sourceEvent(row, time)); continue; }
        const role = roleSchema.parse(row.type.split('/')[0]!.replace('human', 'user'));
        events.push({ type: 'message', timestamp: time, data: { role, content: jsonSchema.parse(msg.content), raw: jsonSchema.parse(row) } });
      } else if (row.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
        events.push({ type: 'tool.call', timestamp: time, data: {
          callId: data.callId, name: data.name, arguments: jsonSchema.parse(data.arguments ?? null), raw: jsonSchema.parse(row) } });
      } else if (row.type === 'tool/result') {
        const msg = data.message === undefined ? data : object(data.message);
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        const legacy = blocks.find(b => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool-result') as Record<string, unknown> | undefined;
        const source = msg.source && typeof msg.source === 'object' ? object(msg.source) : {};
        const callId = msg.toolCallId ?? source.callId ?? legacy?.toolCallId ?? data.callId;
        if (typeof callId !== 'string' || !callId) { events.push(sourceEvent(row, time)); continue; }
        const isError = msg.isError ?? legacy?.isError;
        events.push({ type: 'tool.result', timestamp: time, data: {
          callId, content: jsonSchema.parse(legacy?.content ?? msg.content ?? null),
          ...(typeof isError === 'boolean' ? { isError } : {}), raw: jsonSchema.parse(row) } });
      } else events.push(sourceEvent(row, time));
    }
    return [{ title, sourceFormat: `deepseek-harness-v${header.version}`, sourceContent: input.content,
      ...(typeof header.id === 'string' ? { externalId: header.id } : {}), header, events }];
  },
};
