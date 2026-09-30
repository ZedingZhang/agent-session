import { basename } from 'node:path';
import type { EventDraft } from '../schema.js';
import type { SessionAdapter } from './types.js';
import { roleSchema } from '../schema.js';
export const markdownAdapter: SessionAdapter = {
  id: 'markdown', version: '1.0.0', description: 'Markdown transcript with role headings',
  detect: ({ filename }) => /\.(md|markdown)$/i.test(filename),
  parse(input) {
    const lines = input.content.replace(/^\uFEFF/, '').split(/\r?\n/);
    const events: EventDraft[] = [];
    let role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | undefined;
    let body: string[] = [], preamble: string[] = [];
    let fence: { char: string; length: number } | undefined;
    const flush = () => {
      if (role) events.push({ type: 'message', timestamp: null,
        data: { role, content: body.join('\n').trim() } });
      body = [];
    };
    for (const line of lines) {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      const heading = !fence && /^#{1,6}\s+(system|developer|user|human|assistant|tool)\s*:?\s*$/i.exec(line);
      if (heading) {
        flush(); role = roleSchema.parse(heading[1]!.toLowerCase().replace('human', 'user')); continue;
      }
      if (marker) {
        const token = marker[1]!;
        if (!fence) fence = { char: token[0]!, length: token.length };
        else if (token[0] === fence.char && token.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      }
      (role ? body : preamble).push(line);
    }
    flush();
    if (!events.length) throw new Error('Markdown requires role headings such as ## User and ## Assistant');
    const title = /^#\s+(.+)$/m.exec(preamble.join('\n'))?.[1] ?? basename(input.filename);
    return [{ title, sourceFormat: 'markdown', sourceContent: input.content,
      header: { preamble: preamble.join('\n') }, events }];
  },
};
