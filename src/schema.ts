import { createHash } from 'node:crypto';
import { z } from 'zod';

export const jsonSchema = z.json();
export const roleSchema = z.enum(['system', 'developer', 'user', 'assistant', 'tool']);
export const metadataSchema = z.object({
  title: z.string().min(1),
  adapter: z.object({ id: z.string().min(1), version: z.string().min(1) }).strict(),
  source: z.object({
    format: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    externalId: z.string().optional(), header: jsonSchema.optional(),
  }).strict(),
}).strict();
export const payloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.imported'), data: metadataSchema }).strict(),
  z.object({ type: z.literal('message'), data: z.object({
    role: roleSchema, content: jsonSchema, raw: jsonSchema.optional(),
  }).strict() }).strict(),
  z.object({ type: z.literal('tool.call'), data: z.object({
    callId: z.string().min(1), name: z.string().min(1), arguments: jsonSchema,
    raw: jsonSchema.optional(),
  }).strict() }).strict(),
  z.object({ type: z.literal('tool.result'), data: z.object({
    callId: z.string().min(1), content: jsonSchema, isError: z.boolean().optional(),
    raw: jsonSchema.optional(),
  }).strict() }).strict(),
  z.object({ type: z.literal('source.event'), data: z.object({
    sourceType: z.string().min(1), raw: jsonSchema,
  }).strict() }).strict(),
]);
const envelopeSchema = z.object({
  schemaVersion: z.literal(1), sessionId: z.string().regex(/^[a-f0-9]{64}$/),
  eventId: z.string().regex(/^[a-f0-9]{64}:\d+$/),
  seq: z.number().int().nonnegative().safe(), timestamp: z.iso.datetime({ offset: true }).nullable(),
});
export const eventSchema = z.union(payloadSchema.options.map(option => option.extend(envelopeSchema.shape)));
export type SessionMetadata = z.infer<typeof metadataSchema>;
export type EventPayload = z.infer<typeof payloadSchema>;
export type EventDraft = EventPayload & { timestamp: string | null };
export type SessionEvent = z.infer<typeof eventSchema>;

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter(k => obj[k] !== undefined).sort()
    .map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}
export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function materialize(metadata: SessionMetadata, drafts: EventDraft[]): SessionEvent[] {
  metadataSchema.parse(metadata);
  const all: EventDraft[] = [{ type: 'session.imported', timestamp: null, data: metadata }, ...drafts];
  const sessionId = sha256(canonical(all));
  return all.map((draft, seq) => eventSchema.parse({ ...draft, schemaVersion: 1,
    sessionId, eventId: `${sessionId}:${seq}`, seq }));
}
export function serialize(events: SessionEvent[]): string {
  return events.map(canonical).join('\n') + '\n';
}
export function parseArchive(text: string): SessionEvent[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length) throw new Error('Empty archive');
  const events = lines.map((line, i) => {
    try { return eventSchema.parse(JSON.parse(line)); }
    catch (cause) { throw new Error(`Invalid archive line ${i + 1}`, { cause }); }
  });
  const first = events[0]!;
  if (first.type !== 'session.imported' || first.timestamp !== null) throw new Error('Missing import header');
  for (const [seq, event] of events.entries()) {
    if (event.seq !== seq || event.sessionId !== first.sessionId ||
      event.eventId !== `${first.sessionId}:${seq}` || (seq > 0 && event.type === 'session.imported')) {
      throw new Error(`Invalid event identity/order at line ${seq + 1}`);
    }
  }
  const drafts = events.map(({ schemaVersion: _v, sessionId: _s, eventId: _e, seq: _n, ...draft }) => draft);
  if (sha256(canonical(drafts)) !== first.sessionId) throw new Error('Archive content hash mismatch');
  return events;
}
