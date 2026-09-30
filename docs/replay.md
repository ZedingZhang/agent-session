# Session timelines and playback

The archive remains the source of truth. Timeline projection reads normalized events and original tool metadata, produces display entries, and never rewrites the archive, accesses the source filesystem or runs tools. Existing imported snapshots work without re-importing. `show --json` retains its canonical JSONL behavior.

## Projection rules

| Recorded data | Timeline output |
| --- | --- |
| User / assistant message | `User` / `Agent`, including preserved reasoning content |
| System / developer message | `System` / `Developer` |
| File tool call | `Tool: <name> <path>`, with read range when recorded |
| Known shell tool call | `Shell: <command>` |
| Read result metadata | Recorded total lines, or shown lines and total when a range is partial |
| Failed tool result | `Tool failed` or `Shell failed` |
| Recognized test shell command with failure evidence | `Test failed` |
| Successful result with recorded applied changes | `Diff`, with removed/added/context lines |
| Unknown lifecycle/source record | `Source`, when `--all` is enabled |

Results are matched to preceding calls by `callId`, so overlapping tools remain correctly associated. An orphan result shows its call ID. Unknown tools or malformed arguments use a text/JSON fallback. An assistant `tool-call` content block is suppressed only when its ID has a normalized tool-call event; this avoids duplicate display while preserving unknown content.

Shell names include DSH `bash`, `pwsh`, `powershell`, and common adapter names such as `exec_command`, `shell` and `run_command`. Arguments use `command`, `cmd` or `script`. File tools support `file_path`, `path`, `filePath` and `filename`.

Shell exit codes are read from structured result `exitCode`, DSH metadata, or the recorded `[exit code: N]` marker. DSH uses `isError` for infrastructure failures, so a nonzero shell exit must also be checked. Test command classification recognizes npm/pnpm/yarn/bun test, vitest, jest, pytest, cargo/go/dotnet/mvn/gradle test, node --test and ctest. Without an exit code, explicit test failure diagnostics may identify a failure. A recorded zero exit code takes precedence over text that mentions failure. This is display classification, not an independent test run; arbitrary custom wrappers may remain generic Shell output.

Diffs are taken from `raw.data.meta.diffs` (DSH applied hunks), explicit structured result `before` / `after`, or an explicit result `diff` string for recognized file-edit tools. No diff is shown for a failed result. Tool-call arguments alone do not establish applied changes and are never used to invent a diff. The renderer uses the `diff` package to derive removed/added/context lines from recorded before/after text. Computation is bounded for large files; a coarse before/after representation is used when the bounded algorithm cannot finish. Default diff display is capped at 200 lines. `--verbose` removes display truncation but retains the computation bounds.

Tool result previews normally show at most eight lines / 1,200 characters. Long failures use diagnostic excerpts so an assertion near the end is not hidden behind command banners. Messages are displayed in full. `--verbose` includes complete arguments for file tools and full result text. ANSI/OSC and terminal control sequences are removed from human-readable output; raw JSONL exports are unchanged.

## Clock and ordering

The timeline uses archive `seq` order. It does not sort by timestamps, which may be missing, equal, or non-monotonic. Default time formatting is `HH:mm:ss` in the system timezone. Set `--timezone <IANA-zone>` to override it. If visible entries span multiple dates, include `YYYY-MM-DD` too. Missing times show `[unknown time]`.

Assembled Agent messages retain their recorded event timestamp, often completion time. This MVP does not reconstruct per-token timestamps from embedded streams or expand legacy compact chunk batches. Use `--all` / `--json` to inspect retained source events. Fork seeds, `surfaceOp` replacements, and compaction events remain chronological history, not a reconstructed final runtime context.

## Timed playback

`show <id> --replay --speed 4 --max-delay 2` produces the same visible entries as immediate `show`, with bounded waits. Delay is `max(0, currentTime - previousTime) / speed`, capped at `maxDelay` seconds. The first entry is immediate; adjacent entries with unknown clocks or regressing timestamps are immediate. Entries derived from the same event, such as a result and its diff, have the same timestamp and no extra pause. Ctrl+C terminates playback. `--json` and `--replay` cannot be combined.

The SDK exports an async iterator with an optional `AbortSignal`:

```ts
import { projectTimeline, formatTimelineEntry, timelineSpansDays, replayTimeline } from 'ctxcrate';

const entries = projectTimeline(events, { verbose: false });
const timeZone = 'Asia/Singapore';
const includeDate = timelineSpansDays(entries, timeZone);
for await (const entry of replayTimeline(entries, { speed: 4, maxDelayMs: 2000, signal })) {
  console.log(formatTimelineEntry(entry, { timeZone, includeDate }));
}
```
