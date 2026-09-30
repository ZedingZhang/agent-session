# Agent Session

[简体中文](README.zh-CN.md)

A local-first archive for AI agent conversations. Import different agent formats into one versioned **JSONL event stream**, browse history from the CLI, and merge file libraries without a server or database. Each source format lives in a small adapter that the community can extend.

**MVP:** DeepSeek Harness canonical session logs and export ZIPs, generic JSON/JSONL, Markdown transcripts, a TypeScript SDK, and external ESM adapters. MIT licensed. Requires Node.js **24+**.

## Quick start

```sh
git clone https://github.com/ZedingZhang/agent-session.git
cd agent-session
npm ci
npm run build
npm link

agent-session init
agent-session import examples/conversation.md
agent-session import examples/conversation.json
agent-session import examples/deepseek-session.jsonl
agent-session history
agent-session show <session-id-prefix>
```

The npm package is not published yet; install from this repository. You can use `node dist/cli.js` instead of `npm link` and `agent-session`.

## CLI

```sh
agent-session --help
agent-session --library ./my-library import conversation.json --adapter json
agent-session import session.v4.jsonl --adapter deepseek-harness
agent-session import dsh-session-example.zip
agent-session list --adapter deepseek-harness --query README
agent-session list --json
agent-session show <id> --all
agent-session show <id> --json
agent-session export <id> --output session.jsonl
agent-session --library ./my-library sync ./another-library
agent-session adapters
```

`history` aliases `list`. IDs accept unambiguous lowercase hexadecimal prefixes of at least eight characters. `show` displays messages and tools by default; `--all` includes original lifecycle and unknown events. `--json` on `show` emits JSONL; on `list` it emits a JSON array. Export to a file refuses to overwrite existing files.

The default library is `~/.agent-session`. Override it with `AGENT_SESSION_HOME` or `--library`. The CLI does not contact agent APIs or upload conversations.

## Input formats

| Adapter | Input | Behavior |
| --- | --- | --- |
| `deepseek-harness` | Canonical `session[.vN].jsonl`, `{ "header": ..., "events": [...] }`, or Web export `.zip` | Reads headers 1–4; normalizes messages and tool events, preserves original rows |
| `json` | A message array, `{ "title": ..., "messages": [...] }`, `{ "events": [...] }`, a single message, or JSONL rows | `role` + `content` messages; unknown typed events remain `source.event` |
| `markdown` | `.md` / `.markdown` with role headings | Converts `## User`, `## Assistant`, `## System`, `## Developer`, `## Tool` (also `Human`) into messages |

DeepSeek auto-detection runs before generic JSON detection. Unknown formats fail clearly; choose an adapter explicitly when necessary. Markdown headings inside fenced code are treated as content. Surrounding Markdown message whitespace is trimmed; the preamble is retained in source metadata. Generic JSON accepts strings, structured blocks, or other JSON content and preserves each original message, including tool-call extensions, in `raw`.

The DeepSeek adapter is based on the [official session types](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/session/src/types.ts) and [canonical export implementation](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session-query/session-log-export/src/archive.ts). Fixtures cover native v4 tool messages and legacy v3 tool-result wrappers. Older/unrecognized event shapes remain raw source events; this project does not run DeepSeek's migration engine.

ZIP imports root and descendant session logs without extracting paths to disk. Attachment references are retained, but ZIP image/file binaries are **not archived** in this MVP; the CLI reports that limitation. Compressed `.jsonl.zstd` persistence files are not supported; use a canonical Harness export. Unsupported newer log versions fail before any sessions from that input are published. Input files and aggregate uncompressed ZIP session logs default to a 64 MiB limit; the SDK exposes `maxBytes`.

## Unified event schema

Each line has `schemaVersion`, `sessionId`, `eventId`, `seq`, `timestamp`, `type`, and `data`. `seq` is the authoritative order; `timestamp` is an original ISO timestamp or `null` when unknown. We never invent historical timestamps. Sequence zero is `session.imported` with title, adapter ID/version, source format/digest, external session ID and source metadata.

Event types: `session.imported`, `message`, `tool.call`, `tool.result`, and `source.event`. Message content and raw data accept lossless JSON values. Unknown lifecycle, reasoning, usage, provider metadata and plugin events remain in the archive rather than being silently discarded.

See the [schema specification](docs/session-schema.md) and generated [JSON Schema](schema/session-event.v1.schema.json). JSON Schema validates individual events; the reader additionally verifies sequence order, common session ID, event IDs and the full content digest.

## Local storage and sync

```text
<library>/
  sessions/
    <sha256-session-id>.jsonl
```

The library has no separate index to get out of sync. Session IDs hash canonical normalized drafts (including metadata and source digest), with event IDs `<sessionId>:<seq>`. The same input, title and adapter version produce the same archive; changing source bytes, fallback filename title or normalization produces a new snapshot. Re-importing a growing live session produces a new snapshot, not an in-place update. Canonical export/re-import preserves identity exactly.

`sync` validates both libraries, then merges immutable snapshots in both directions. It never deletes sessions or resolves conflicts by overwriting. Complete temporary files are atomically published using hard links, so concurrent imports cannot expose partial logs. This requires a local filesystem that supports hard links (for example NTFS, ext4 or APFS); FAT/exFAT and some network mounts are not supported. Stale `.tmp` files after an interrupted process are ignored. Multi-file sync is not transactional: an I/O failure can leave a partial merge; retrying is safe.

To exchange data across machines, copy the library using your preferred file transfer or folder synchronization tool, then merge local copies. There is no network sync service in the MVP.

## Contribute an adapter

Adapters implement `SessionAdapter`: `id`, `version`, `description`, `detect(input)` and `parse(input)`. No storage or CLI changes are required. Load a trusted ESM file or installed package:

```sh
agent-session --plugin ./examples/custom-adapter.mjs import notes.txt --adapter notes
agent-session --plugin agent-session-adapter-example adapters
```

Plugins execute code in the Node process. Install only adapters you trust. See the [adapter authoring guide](docs/adapters.md), [working plugin example](examples/custom-adapter.mjs) and [contributing guide](CONTRIBUTING.md).

## TypeScript SDK

```ts
import { AdapterRegistry, LocalSessionStore, importFile } from '@zedings/agent-session';

const library = new LocalSessionStore('./my-library');
const registry = new AdapterRegistry();
const result = await importFile(library, registry, './session.json');
const events = await library.read(result.sessions[0]!.id);
const summaries = await library.list();
await library.sync('./another-library');
```

Build output includes TypeScript declarations. Runtime schemas and normalization utilities are exported as well.

## Development

```sh
npm ci
npm run check
npm run schema
npm pack --dry-run
```

Tests cover adapter normalization, unknown event retention, fenced Markdown, hash/sequence validation, concurrent publication, deduplication, export/re-import, sync corruption checks, ZIP size limits, plugin loading and actual CLI workflows. CI runs checks on Linux, macOS and Windows with Node 24 and 26, and verifies that the committed JSON Schema is current.

Future work: live incremental ingestion, searchable derived indexes, attachment storage, more community adapters, and session lineage browsing. MVP history is a chronological source archive; fork seeds and source `surfaceOp` edits are retained as raw metadata, not replayed into a reconstructed agent runtime view.
