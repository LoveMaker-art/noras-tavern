# MVU test diagnostics

This is optional diagnostic capture, not a different MVU execution mode.
No model selection, output protocol, validation, retry or persistence decisions change.

## Enable for a reproduction

On the target user's data root, create `.nora-mvu-trace.json` with an `expiresAt`
Unix timestamp in milliseconds, no more than 24 hours ahead, and the exact
`chatId` being tested. There is no model-facing configuration and no public
write endpoint for this switch. Remove the file or set `expiresAt` to zero to
stop server-side collection. Refresh the page after enabling/disabling.

The authenticated diagnostics router exposes `/trace-config` and accepts
`/trace`; the existing `/recent` reader includes these records. Records are
stored only in that user's `nora-telemetry/mvu-diagnostics*.ndjson`, with the
existing 2 MiB active file plus one rotation and private file permissions.
The server accepts at most 600 trace records per configuration expiry window;
one page sends at most 120 client-side records. Fields are redacted and bounded.
Large captures explicitly report truncation; they must not be described as full captures.

## Evidence

- `schema-module-loaded`, `schema-register-start/complete`, `schema-query-received/answered`:
  actual local schema module and registration callbacks; not proof of UI rendering.
- `schema-script-start/error/rejection/console`: the Helper iframe logging prelude
  runs before card module imports and relays selected-schema script startup,
  import/syntax/runtime errors. If the prelude itself never loads, it cannot report;
  absence alone must not be presented as a diagnosed cause.
- `schema-check`: current card, script flags, character script authorization, runtime phase.
- `model-request/response`: a matched request ID at the Tavern chat-completion HTTP
  boundary, including final frontend messages and visible response/tool calls, abort,
  HTTP status and finish reason. Provider-specific backend transformations may follow
  request capture. Hidden reasoning, headers, credentials and inline media are omitted.
- `parser-input/accepted/rejected`: what the MVU parser received and its actual decision.
  These events have a page ID and chat ID; do not falsely attribute concurrent parser
  events to a wire request solely by temporal order.

The private request marker is stripped before model dispatch, even when tracing
is disabled. Only Nora MVU requests from the selected chat are captured. Stream
bytes, write return values and errors are passed through unchanged. Collection
failure must not prevent gameplay. Reproducing the user's original error still
requires the user's page; offline tests only establish capture behavior.
