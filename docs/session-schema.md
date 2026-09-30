# Session Schema v1

## Event envelope

| Field | Type | Semantics |
| --- | --- | --- |
| `schemaVersion` | literal `1` | Normalized archive format, independent of the source agent's version |
| `sessionId` | 64 lowercase hex characters | SHA-256 of the canonical array of drafts |
| `eventId` | `<sessionId>:<seq>` | Stable identity within this snapshot |
| `seq` | nonnegative safe integer | Zero-based, contiguous order; source event sequence stays in `raw` |
| `timestamp` | ISO datetime with offset or `null` | Original event time; no inferred import time |
| `type` | discriminated string | Determines the payload schema |
| `data` | JSON object | Typed payload below |

## Payloads

| Type | Required fields in `data` | Optional fields |
| --- | --- | --- |
| `session.imported` | `title`, `adapter: {id, version}`, `source: {format, sha256}` | `source.externalId`, `source.header` |
| `message` | `role`, `content` | `raw` |
| `tool.call` | `callId`, `name`, `arguments` | `raw` |
| `tool.result` | `callId`, `content` | `isError`, `raw` |
| `source.event` | `sourceType`, `raw` | None |

Roles are `system`, `developer`, `user`, `assistant`, `tool`. Content, arguments, raw data and the source header accept JSON values: strings, finite numbers, booleans, null, arrays, and objects. Binary attachments require future storage support; preserve references as structured blocks today. Tool arguments remain strings when the source records strings, including invalid JSON arguments; they are not parsed destructively.

`session.imported` occurs exactly once at sequence zero, with timestamp `null`. It means "snapshot imported", not "the source conversation started or ended". No synthetic completion event is inserted. Real source start/end events remain `source.event`.

Normalized events represent an archive of source records. `raw` preserves full source rows including sequence IDs, stream records, model information, usage, edit operations and unknown keys. The MVP does not project source edits or fork inheritance into runtime message state.

## Identity algorithm

1. Construct a draft array beginning with `{type: "session.imported", timestamp: null, data: metadata}`, followed by normalized adapter drafts.
2. Recursively sort object keys, omit undefined object properties, preserve array order and serialize compact JSON without whitespace. Admitted data must be valid JSON.
3. Compute SHA-256 of this UTF-8 string as `sessionId`.
4. Add `schemaVersion: 1`, contiguous `seq`, `sessionId`, and `eventId` to each draft.
5. Store canonical JSON per line, ending in a newline, as `sessions/<sessionId>.jsonl`.

`source.sha256` hashes the original source text provided by the adapter. The identity includes this digest, title and adapter version, so normalization changes remain separate snapshots. Native canonical import bypasses adapters and keeps existing identity.

The runtime validator checks every event, exact sequence order, header placement, identities, filename consistency and the full draft digest. A content hash detects corruption; it does not authenticate the author. The generated JSON Schema covers individual event structure; it cannot enforce cross-event invariants.

## Versioning

Breaking normalized structure or semantics requires a new `schemaVersion`. Readers reject unknown schema versions. v1 has no migration engine. Adapter versions are separate: bump the adapter version when normalization changes, and include old/new fixtures. New source event vocabulary can be retained through `source.event` without changing v1.

## Deliberate MVP tradeoffs

Snapshots are immutable rather than live append targets. File scanning rebuilds history on each invocation, avoiding an authoritative index; it is intended for small personal libraries. ZIP imports materialize bounded log text in memory. Sync preflights all archives, then performs independent atomic file publications; it is retryable but not a multi-file transaction. There is no deletion propagation or mutable title editing.
