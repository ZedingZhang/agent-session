# Writing an adapter

An adapter translates a source format into `AdapterSession[]`; core handles schema validation, canonical identity, publication and deduplication. Built-ins live in `src/adapters`; community adapters can ship independently.

```ts
import type { SessionAdapter } from 'ctxcrate';

const adapter: SessionAdapter = {
  id: 'my-agent',
  version: '1.0.0',
  description: 'My Agent exported transcripts',
  detect: input => input.filename.endsWith('.my-agent.json'),
  parse: input => {
    const source = JSON.parse(input.content);
    return [{
      title: source.title,
      externalId: source.id,
      sourceFormat: 'my-agent-v1',
      sourceContent: input.content,
      header: { model: source.model },
      events: source.messages.map((message: { role: 'user' | 'assistant'; text: string }) => ({
        type: 'message' as const,
        timestamp: null,
        data: { role: message.role, content: message.text, raw: message },
      })),
    }];
  },
};
export default adapter;
```

`parse` may be async. `input` contains a filename and decoded UTF-8 content. Return one session per logical conversation. Never include `session.imported` in adapter drafts; core inserts it. Preserve the original content for `sourceContent`, use a stable nonempty title, and preserve source IDs/metadata. Use `null` when event timestamps are unknown. Unknown source events should become `source.event` with their full original row. Prefer lossless content blocks and raw data over a flattened transcript.

Detection should be cheap and should return false for unrelated formats. Built-ins have precedence in automatic selection; use `--adapter my-agent` to select a community adapter explicitly. Duplicate adapter IDs are rejected. Load a compiled ESM file using `--plugin ./path/adapter.mjs` or an installed package name. A package must expose its adapter as the default export. Package resolution checks the current working directory first, then the CLI installation. Plugins run with normal process access; loading one is an explicit trust decision.

To propose an adapter:

1. Provide a minimal anonymized source fixture and a documented source version.
2. Test messages, tool calls/results, unknown events, malformed input and missing timestamps.
3. Assert deterministic output, validate through `materialize`, and test `serialize`/`parseArchive` roundtrips.
4. Document unsupported fields, binary attachments and any lossy conversions.
5. Add user examples and bump your adapter version when normalization changes.

Run `npm run check` before submitting. For built-ins, register the adapter in `AdapterRegistry`. For external plugins, the SDK exports all public interfaces and validators. See `examples/custom-adapter.mjs` for a dependency-free working example.
