# Codex CLI adapter

Adapter ID: `codex`. Adapter version: `1.0.0`. No Codex installation, login, API key or network access is required to read saved logs.

## Input and discovery

Single files must be JSONL starting with `session_meta` and a nonempty `payload.id` (or legacy `payload.session_id`). UTF-8 BOM and blank lines are accepted. JSON parse errors include the physical line number; malformed/truncated files fail before publication. The normal 64 MiB per-file import limit applies.

Recursive directory import selects `rollout-*.jsonl`, including dated `sessions` and `archived_sessions` trees. Pass the actual configured `CODEX_HOME`, its session folder, or an individual log path. Symlink directories are not followed. Index/history/config/auth files are not selected. Native DSH and Codex directories can also be discovered automatically without `--adapter`; an explicit adapter restricts discovery.

```powershell
node dist/cli.js import "$env:USERPROFILE\.codex" --adapter codex
node dist/cli.js import examples/codex-rollout.jsonl
node dist/cli.js history --adapter codex
node dist/cli.js show YOUR_SESSION_ID --verbose
node dist/cli.js export YOUR_SESSION_ID --format json --output session.json
```

Directory imports stop on a corrupt selected file, preserving earlier successful imports. Retry is safe: unchanged snapshots deduplicate. A file that is still being appended may have an incomplete last line; retry after the source writer finishes. Growing native sessions become new immutable archive snapshots.

## Mapping and fidelity

| Native record | Canonical representation |
| --- | --- |
| First `session_meta` | Full row retained in `source.header`; native `id` retained as `source.externalId` |
| `response_item.message` | Supported roles become `message`; `input_text` / `output_text` blocks become displayable `text`; original blocks and fields remain in `raw` |
| `function_call` / `custom_tool_call` | `tool.call` with native `call_id`, name (including optional namespace), original arguments string or custom input |
| `function_call_output` / `custom_tool_call_output` | `tool.result` with native `call_id`; strings and structured content retained; text blocks normalized for display |
| Legacy `local_shell_call` | `tool.call` named `shell`; native `call_id` or legacy `id`, full action retained |
| `event_msg.user_message` / `agent_message` | Visible message when not paired with an identical main message; otherwise retained as a source event |
| Reasoning, compaction, turn context, usage, world state, web search, lifecycle, unknown or incomplete tool shapes | `source.event`, with the complete native row |

Every non-header source row becomes exactly one canonical event and retains its full JSON value in `data.raw`. The original native line order is retained. The first full header row includes cwd, provider, CLI version, Git and fork metadata when present. Thread `id` takes precedence over root `session_id` so child threads retain distinct native identities. Missing event timestamps remain `null`; malformed timestamps fail instead of becoming invented clocks.

Mirrors are matched by exact role/text, one-for-one between task/compaction boundaries. Repeated messages are not globally deduplicated. Divergent/abridged event messages remain visible. This favors retaining uncertain content over concealing a possibly distinct turn. `task_complete.last_agent_message` is retained as lifecycle data rather than synthesized as another assistant reply.

Titles use an explicit metadata title or the first non-environment user text, falling back to the filename. JSON/JSONL exports preserve canonical identity and native JSON fields, including encrypted reasoning. Markdown is a readable projection; use `--all` to include retained source events. Native bytes, whitespace and compressed representations are not reproduced by canonical export.

## Timeline details and limits

Function/custom tool calls participate in existing call-ID association. Native `Process exited with code N` result headers are recognized for shell failure display, including PowerShell `npm.cmd test` commands. Malformed argument strings remain readable and are not rejected or executed.

Patch tool input is shown as tool arguments. A requested patch is not presented as an applied Diff without recorded applied changes. `--verbose` and Markdown export retain its full text.

This is archive import and viewing, not native `codex resume` migration. Compaction replacement history, fork/history-base references and paginated inherited context are retained as source data, not expanded into a reconstructed final runtime conversation. Images and attachments remain references/content blocks; external files are not copied or dereferenced. Opaque reasoning is retained without decryption. Nested tool programs inside a single custom/function call are not split into invented individual actions. `codex exec --json` streaming events and prompt-only `history.jsonl` are different formats and are not covered by this adapter.

## Evidence

Implementation checked against the official OpenAI Codex source at commit [`5aa92804d255dcaefe169dd7febb4006a2474e32`](https://github.com/openai/codex/tree/5aa92804d255dcaefe169dd7febb4006a2474e32): [session metadata](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/protocol/src/protocol.rs) and [response item types](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/protocol/src/models.rs).

On 2026-10-01, a local read-only audit parsed 124 native rollout files (68,632 records), compared every canonical raw row and header against its source JSON value, verified JSON export/re-import and projected timelines. The initial field survey included CLI 0.144.x–0.159.0 and alpha versions. This demonstrates compatibility with that corpus, not every Codex version. No private logs are checked in; `examples/codex-rollout.jsonl` is fictional.

Regression tests cover dual-stream mirrors, repeated and event-only turns, namespaced/function/custom calls, structured outputs, images and opaque records, missing call IDs, legacy shell, corrupt input, active/archive directory discovery, retry/dedup and actual CLI viewing/export/playback.
