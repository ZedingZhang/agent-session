import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { eventSchema } from '../dist/index.js';
await mkdir(new URL('../schema/', import.meta.url), { recursive: true });
await writeFile(new URL('../schema/session-event.v1.schema.json', import.meta.url), JSON.stringify({
  ...z.toJSONSchema(eventSchema),
  $id: 'https://github.com/ZedingZhang/ctxcrate/blob/main/schema/session-event.v1.schema.json',
  title: 'ctxcrate Event v1',
}, null, 2) + '\n');
