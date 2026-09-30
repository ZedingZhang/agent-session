import { basename } from 'node:path';
import { roleSchema, jsonSchema } from '../schema.js';
import type { EventDraft } from '../schema.js';
import type { SessionAdapter } from './types.js';
import { object, parseJson, sourceEvent, timestamp } from './utils.js';
export const jsonAdapter: SessionAdapter = {
  id: 'json', version: '1.0.0', description: 'Generic JSON/JSONL role-content messages or typed events',
  detect: ({ filename, content }) => /\.jsonl?$/i.test(filename) || /^[\[{]/.test(content.trim()),
  parse(input) {
    const parsed = parseJson(input.content);
    const root = Array.isArray(parsed) ? undefined : object(parsed);
    const rows = Array.isArray(parsed) ? parsed : root!.messages ?? root!.events ??
      (root!.role || root!.type ? [root] : undefined);
    if (!Array.isArray(rows) || !rows.length) throw new Error('JSON input must contain a nonempty messages/events array');
    const events: EventDraft[] = rows.map(value => {
      const row = object(value);
      const time = timestamp(row.timestamp ?? row.time);
      if (row.role !== undefined) {
        const role = roleSchema.parse(row.role === 'human' ? 'user' : row.role);
        if (row.content === undefined) throw new Error('Message is missing content');
        return { type: 'message', timestamp: time, data: { role, content: jsonSchema.parse(row.content), raw: jsonSchema.parse(row) } };
      }
      if (typeof row.type !== 'string' || !row.type) throw new Error('Expected a message role or event type');
      return sourceEvent(row, time);
    });
    return [{ title: typeof root?.title === 'string' && root.title ? root.title : basename(input.filename),
      sourceFormat: 'json', sourceContent: input.content,
      ...(typeof root?.id === 'string' ? { externalId: root.id } : {}),
      ...(root ? { header: Object.fromEntries(Object.entries(root).filter(([key]) => !['messages', 'events'].includes(key))) } : {}), events }];
  },
};
