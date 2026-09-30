import { jsonSchema } from '../schema.js';
import type { EventDraft } from '../schema.js';
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}
export function parseJson(content: string): unknown {
  const clean = content.replace(/^\uFEFF/, '').trim();
  try { return JSON.parse(clean); }
  catch {
    return clean.split(/\r?\n/).filter(line => line.trim()).map((line, i) => {
      try { return JSON.parse(line); }
      catch { throw new Error(`Invalid JSON/JSONL at line ${i + 1}`); }
    });
  }
}
export function timestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('Invalid timestamp');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date.toISOString();
}
export function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(block => {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (['text', 'input_text', 'output_text'].includes(String(b.type)) && typeof b.text === 'string') return b.text;
      if (b.type === 'reasoning' && typeof b.text === 'string') return `[reasoning] ${b.text}`;
    }
    return JSON.stringify(block);
  }).join('\n');
  return JSON.stringify(content);
}
export function sourceEvent(row: Record<string, unknown>, time: string | null): EventDraft {
  return { type: 'source.event', timestamp: time,
    data: { sourceType: typeof row.type === 'string' ? row.type : 'unknown', raw: jsonSchema.parse(row) } };
}
