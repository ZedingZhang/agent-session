# Agent Session

[简体中文](README.zh-CN.md)

A local-first archive for AI agent conversations. Import different agent formats into one versioned **JSONL event stream**, browse history from the CLI, and merge file libraries without a server or database. Each source format lives in a small adapter that the community can extend.

**MVP:** DeepSeek Harness native JSONL / Zstandard session logs and session directories, export ZIPs, generic JSON/JSONL, Markdown transcripts, CLI timelines and timed playback, a TypeScript SDK, and external ESM adapters. MIT licensed. Requires Node.js **24+**.

## Quick start

### Windows PowerShell

Use `npm.cmd` so PowerShell does not select the `npm.ps1` shim, which may be blocked by the script execution policy. No execution-policy change is needed. The commands below run the CLI directly, so `npm link` is optional.

```powershell
git clone https://github.com/ZedingZhang/agent-session.git
cd agent-session
npm.cmd ci
npm.cmd --silent run build

node dist/cli.js init
node dist/cli.js import examples/conversation.md
node dist/cli.js import examples/conversation.json
node dist/cli.js import examples/deepseek-session.jsonl
node dist/cli.js history
```

Copy an ID prefix from history and run `node dist/cli.js show YOUR_ID_PREFIX`, replacing `YOUR_ID_PREFIX` with that value. If the repository is already on disk, start in its directory and skip `git clone`.

The silent build suppresses npm's script banners; a successful build normally prints nothing. Wait for the PowerShell prompt to return before entering the next command. `$LASTEXITCODE` should be `0`. If you prefer a linked CLI, run `npm.cmd link`, then use `agent-session.cmd` in PowerShell to avoid its `.ps1` shim too.

### macOS / Linux

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

### Terminal output troubleshooting

If build output overlaps the next prompt or typed command, use `npm.cmd --silent run build` in PowerShell (or `npm --silent run build` on macOS/Linux). This suppresses npm's lifecycle banners without hiding TypeScript compiler errors. This repository disables npm color/progress output and TypeScript pretty diagnostics to reduce terminal formatting. If the display still overlaps, try the same command in a fresh standalone PowerShell window to distinguish terminal rendering from the build itself. The overlap has not been reproduced in our terminal; these settings are a workaround, not a confirmed terminal-specific fix.

## CLI

```sh
agent-session --help
agent-session --library ./my-library import conversation.json --adapter json
agent-session import session.v4.jsonl --adapter deepseek-harness
agent-session import session.v4.jsonl.zstd
agent-session import dsh-session-example.zip
agent-session list --adapter deepseek-harness --query README
agent-session list --json
agent-session show <id> --all
agent-session show <id> --replay --speed 4
agent-session show <id> --verbose --timezone UTC
agent-session show <id> --json
agent-session export <id> --output session.jsonl
agent-session --library ./my-library sync ./another-library
agent-session adapters
```

`history` aliases `list`. IDs accept unambiguous lowercase hexadecimal prefixes of at least eight characters. `show` displays a readable timeline of messages, tools, shell commands, results and recorded diffs by default; `--all` includes original lifecycle and unknown events. `--json` on `show` emits the unchanged JSONL archive; on `list` it emits a JSON array. Export to a file refuses to overwrite existing files.

The default library is `~/.agent-session`. Override it with `AGENT_SESSION_HOME` or `--library`. The CLI does not contact agent APIs or upload conversations.

## Session timelines and playback

`show <id>` prints the session process immediately, in archive sequence order. It links tool results to calls by `callId`, understands DSH result metadata, and reports recorded shell exit failures even when DSH's `isError` is false. Existing imported sessions work without re-importing; this is a display projection, not a new archive schema.

Try the fictional login-repair fixture in PowerShell:

```powershell
node dist/cli.js import examples/login-replay.jsonl
node dist/cli.js history --query "修复登录跳转问题"
# Replace YOUR_ID_PREFIX with the ID from history
node dist/cli.js show YOUR_ID_PREFIX --timezone Asia/Singapore
node dist/cli.js show YOUR_ID_PREFIX --replay --speed 4
```

```text
[10:00:01] User: 帮我修复登录跳转问题
[10:00:03] Agent: 我先查看认证逻辑
[10:00:04] Tool: read_file src/auth/login.ts
[10:00:06] Tool result: 245 lines
[10:00:10] Tool: write_file src/auth/login.ts
[10:00:11] Tool result: Updated file
[10:00:11] Diff: src/auth/login.ts
- redirect('/login')
+ redirect('/dashboard')
[10:00:15] Shell: npm test
[10:00:21] Test failed: Expected /dashboard but received /login
[exit code: 1]
```

`--replay` displays those same entries one by one, using recorded time gaps divided by `--speed` (default `1`). Each pause is capped by `--max-delay` seconds (default `2`); use `--max-delay 0` for immediate playback. Ctrl+C stops playback. Playback displays recorded events; it does not execute shell commands or apply file changes.

Times use the system timezone by default. `--timezone UTC` or an IANA zone such as `Asia/Singapore` overrides it; sessions spanning multiple dates include the date in each timestamp. Missing timestamps show `[unknown time]`; missing or regressing clocks never reorder events or add a playback pause.

Tool output is summarized by default, with read line counts from recorded metadata and excerpts for long failures. `--verbose` displays full tool arguments, results and diffs. Diffs use recorded applied `meta.diffs`, explicit before/after data or an explicit result patch; no before-state is inferred from tool arguments or the current filesystem. A missing diff remains missing. A recognized test command with a nonzero recorded exit code is labeled `Test failed`; when no code is available, explicit failure diagnostics are used. See [replay behavior](docs/replay.md) for exact rules and limitations.

## Input formats

| Adapter | Input | Behavior |
| --- | --- | --- |
| `deepseek-harness` | Native `session[.vN].jsonl[.zstd]`, `{ "header": ..., "events": [...] }`, a session directory, or export `.zip` | Reads headers 0–4; normalizes messages and tool events, preserves original rows |
| `json` | A message array, `{ "title": ..., "messages": [...] }`, `{ "events": [...] }`, a single message, or JSONL rows | `role` + `content` messages; unknown typed events remain `source.event` |
| `markdown` | `.md` / `.markdown` with role headings | Converts `## User`, `## Assistant`, `## System`, `## Developer`, `## Tool` (also `Human`) into messages |

DeepSeek auto-detection runs before generic JSON detection. Unknown formats fail clearly; choose an adapter explicitly when necessary. Markdown headings inside fenced code are treated as content. Surrounding Markdown message whitespace is trimmed; the preamble is retained in source metadata. Generic JSON accepts strings, structured blocks, or other JSON content and preserves each original message, including tool-call extensions, in `raw`.

The DeepSeek adapter is based on the [official session types](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/session/src/types.ts) and [canonical export implementation](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session-query/session-log-export/src/archive.ts). Fixtures cover native v4 tool messages, legacy v3 tool-result wrappers and v0 compact batches. Compact chunk batches remain complete `source.event` records with their original arrays and `time0` timestamp; they are not expanded into synthetic messages. Other unrecognized event shapes also remain raw source events; this project does not run DeepSeek's migration engine.

### Import native DeepSeek Harness data

No export button or export plugin is required. Import the compressed persistence file directly, or pass your DSH session directory:

```powershell
# Windows PowerShell; default local DSH installation
node dist/cli.js import "$env:USERPROFILE\.dsh\sessions"
node dist/cli.js history

# One session file; substitute its actual path
node dist/cli.js import "C:\path\to\session.v4.jsonl.zstd"
```

```sh
# macOS / Linux; or point to your configured persistence root
node dist/cli.js import "$HOME/.dsh/sessions"
```

Directory import recursively discovers `session[.vN].jsonl[.zstd]` and selects the highest generation in each session directory, preferring compressed logs when both representations exist. It skips unrelated files and does not follow symlink directories. Older generations remain directly importable by specifying their file path. A directory import stops on the first error and retains earlier successful imports; retrying deduplicates them.

Native DSH compressed logs consist of independent concatenated Zstandard frames: one header frame followed by append-batch frames. The reader walks frame headers and block lengths, then decompresses **every frame** using Node's built-in `zlib.zstdDecompressSync`. A single call on the concatenated input may only return the first frame on affected Node versions. No additional compression dependency is needed. Standard skippable frames are ignored; truncated tails, malformed frames and checksum failures report errors instead of silently saving a header-only or partial history. A single file is fully decoded and normalized before publication. Compressed and uncompressed versions of the same logical log produce the same identity.

ZIP imports root and descendant uncompressed session logs without extracting paths to disk. Attachment references are retained, but attachment binaries are **not archived** in this MVP; the CLI reports that limitation for ZIPs. Unsupported newer log versions fail before any sessions from that single file or ZIP are published. Input files, decoded Zstandard text and aggregate uncompressed ZIP session logs each default to a 64 MiB limit; the SDK exposes `maxBytes`. The limit applies per selected file during directory import.

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

The SDK also exports `projectTimeline(events)`, `formatTimelineEntry(entry, {timeZone})`, `timelineSpansDays(entries, timeZone)`, and the async iterator `replayTimeline(entries, {speed, maxDelayMs, signal})`. Projection leaves archive data and identities untouched.

## Development

In Windows PowerShell:

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run schema
npm.cmd pack --dry-run
```

On macOS/Linux:

```sh
npm ci
npm run check
npm run schema
npm pack --dry-run
```

Tests cover adapter normalization, unknown event retention, fenced Markdown, hash/sequence validation, concurrent publication, deduplication, export/re-import, sync corruption checks, ZIP size limits, plugin loading and actual CLI workflows. Zstandard regressions cover thousands of append frames, raw/RLE/multi-block frames, skippable metadata, unknown content sizes, checksums, truncated tails, output limits, legacy compact rows and directory generation selection. Timeline tests cover recorded diffs, interleaved calls, test failures, missing clocks, timezone/date formatting, output excerpts, terminal escape removal and bounded/cancellable playback. CI runs checks on Linux, macOS and Windows with Node 24 and 26, and verifies that the committed JSON Schema is current.

Future work: live incremental ingestion, searchable derived indexes, attachment storage, more community adapters, and session lineage browsing. MVP history is a chronological source archive; fork seeds and source `surfaceOp` edits are retained as raw metadata, not replayed into a reconstructed agent runtime view.
