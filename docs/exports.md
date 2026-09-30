# Export formats

Select a session by full ID or an unambiguous prefix of at least eight characters. `export <id> -o <file>` writes a new UTF-8 file, refusing to overwrite any existing file. Parent directories must already exist. Without `-o`, export writes to stdout.

```powershell
node dist/cli.js history --query login
node dist/cli.js export YOUR_SESSION_ID --format markdown -o login.md --timezone Asia/Singapore
node dist/cli.js export YOUR_SESSION_ID --format json -o login.json
node dist/cli.js export YOUR_SESSION_ID --format jsonl -o login.jsonl
```

`--format` accepts `markdown` (alias `md`), `json`, and `jsonl`. An explicit format wins over the output filename; otherwise `.md` / `.markdown` select Markdown, `.json` selects JSON, and the default is JSONL. File extensions are case-insensitive.

## Markdown

Markdown is a human-readable timeline report. It contains a title, session ID, adapter name/version, source format/ID, display timezone, and one section per visible timeline entry. Sections include the recorded time, label, archive event sequence and tool call ID where applicable. Full tool arguments/results and recorded diffs are included, without CLI preview truncation. Multiline content is fenced, with dynamically sized fences to preserve embedded backticks. Metadata is escaped. Human-readable text has terminal control sequences removed.

`--all` includes lifecycle and unknown source records; default output includes messages, tools, shell output and recorded changes. `--timezone` selects an IANA timezone; the default is the system timezone. Dates are included when entries span multiple days; unknown timestamps remain explicit.

This is a display projection, not a lossless archive container. It does not carry every raw provider field, infer missing file changes, reconstruct final source runtime context, or promise identity-preserving Markdown re-import. Use JSON/JSONL to back up or transfer the complete archive.

## JSON

JSON is a single pretty-printed document with these fields:

| Field | Meaning |
| --- | --- |
| `format` | Literal `agent-session`, distinguishes the document from generic adapter input |
| `schemaVersion` | Literal `1`, the contained event schema version |
| `sessionId` | Original content-addressed snapshot ID |
| `metadata` | Exact metadata from the `session.imported` event |
| `events` | All canonical events, including the import header, original timestamps and every raw source field |

All events are included regardless of display options. JSON and JSONL preserve raw content, including control characters encoded as JSON escapes. The JSON export importer validates the document schema, contiguous sequence/order, event identities, content hash, and agreement between wrapper metadata/ID and the event header. It does not normalize the archive a second time, so ID and deduplication behavior remain stable. `--title` / `--adapter` overrides are rejected when importing this canonical document.

```powershell
node dist/cli.js import login.json
```

## JSONL

JSONL retains the existing canonical format: one event per line with a trailing newline. This remains the default when no known filename extension or explicit format is given. JSONL export/re-import behavior is unchanged.

## SDK

```ts
import { writeFile } from 'node:fs/promises';
import { exportSession, parseSessionJson } from '@zedings/agent-session';

await writeFile('session.md', exportSession(events, 'markdown', {
  timeZone: 'Asia/Singapore', all: true,
}), { flag: 'wx', encoding: 'utf8' });

const json = exportSession(events, 'json');
const restoredEvents = parseSessionJson(json);
```

`resolveExportFormat` and the document runtime schema `sessionJsonSchema` are also exported. Export validates the input archive before rendering and does not change source events or identity.
