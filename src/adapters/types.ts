import type { EventDraft } from '../schema.js';
export interface AdapterInput { filename: string; content: string }
export interface AdapterSession {
  title: string; sourceFormat: string; sourceContent: string;
  externalId?: string; header?: unknown; events: EventDraft[];
}
/** Community adapters export this interface as their default ESM export. */
export interface SessionAdapter {
  id: string; version: string; description: string;
  detect(input: AdapterInput): boolean;
  parse(input: AdapterInput): AdapterSession[] | Promise<AdapterSession[]>;
}
