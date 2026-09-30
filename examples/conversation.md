# Planning a session library

## User
How should I store conversations from different agents?

## Assistant
Use a versioned event stream, with one JSON object per line and an adapter for each source.

## User
Can it work offline?

## Assistant
Yes. Store immutable snapshots in a local file library and merge libraries by content ID.
