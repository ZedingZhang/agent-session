# Contributing

Contributions to adapters, schema documentation and CLI ergonomics are welcome. Discuss breaking schema or identity changes in an issue first; a new agent adapter usually needs no core changes.

Use Node.js 24+ and run `npm ci`, `npm run check`, and `npm run schema`. Commit changes to `schema/session-event.v1.schema.json` when the public schema changes. CI tests Windows, Linux and macOS; keep paths portable and use Node filesystem APIs.

In Windows PowerShell, use `npm.cmd ci`, `npm.cmd run check`, and `npm.cmd run schema` to avoid script-policy restrictions on `npm.ps1`. For a build without npm's lifecycle banners, use `npm.cmd --silent run build`. See the README's Windows quick start and terminal troubleshooting notes.

Tests use fictional, minimal transcripts. Do not submit private session logs, credentials or user attachment binaries. Add failure-path tests for malformed input and preserve unknown source fields. See [adapter authoring](docs/adapters.md).

Pull requests should describe the resulting behavior, supported source format/version, known limitations and validation. Keep new runtime dependencies small. This project uses the MIT license; contributions are submitted under that license.
