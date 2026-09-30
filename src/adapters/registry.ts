import { isAbsolute, resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { deepseekAdapter } from './deepseek.js';
import { codexAdapter } from './codex.js';
import { jsonAdapter } from './json.js';
import { markdownAdapter } from './markdown.js';
import type { AdapterInput, SessionAdapter } from './types.js';

export class AdapterRegistry {
  private readonly adapters = new Map<string, SessionAdapter>();
  constructor(builtins = true) {
    if (builtins) for (const adapter of [codexAdapter, deepseekAdapter, markdownAdapter, jsonAdapter]) this.register(adapter);
  }
  register(adapter: SessionAdapter): void {
    if (!adapter || !/^[a-z0-9][a-z0-9-]*$/.test(adapter.id) || typeof adapter.version !== 'string' ||
      !adapter.version || typeof adapter.description !== 'string' ||
      typeof adapter.detect !== 'function' || typeof adapter.parse !== 'function') throw new Error('Invalid adapter contract');
    if (this.adapters.has(adapter.id)) throw new Error(`Duplicate adapter: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }
  list(): SessionAdapter[] { return [...this.adapters.values()]; }
  select(input: AdapterInput, id?: string): SessionAdapter {
    const adapter = id ? this.adapters.get(id) : this.list().find(a => a.detect(input));
    if (!adapter) throw new Error(id ? `Unknown adapter: ${id}` : 'No adapter detected; use --adapter or --plugin');
    return adapter;
  }
  async load(specifier: string): Promise<void> {
    let target: string;
    if (isAbsolute(specifier) || specifier.startsWith('.')) target = pathToFileURL(resolve(specifier)).href;
    else {
      // Support adapters installed in the user's project, as well as beside the CLI.
      const localRequire = createRequire(join(process.cwd(), 'package.json'));
      try { target = pathToFileURL(localRequire.resolve(specifier)).href; }
      catch { target = specifier; }
    }
    const module = await import(target);
    this.register(module.default);
  }
}
