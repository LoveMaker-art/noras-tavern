# Chat Backup UI And MCP Integration - 2026-10-02

## Scope

Integrate the chat-backup UI, shared backend reads and guarded MCP operations
into local main, based on `66555bca`. Preserve original chats, world resources,
libraries, model configuration and unrelated worktree documents. No GitHub
push, release, runtime replacement, restart, browser or model call this turn.

## Behavioral Changes

- Backup policy and storage usage remain visible at the top. Compact themed
  rows show time, message count and excerpt. Management enables selection;
  detail actions provide download, retention, deletion and guarded restoration.
- Current-chat filtering uses both world and session. Other-session rows,
  details and destructive confirmations identify their session explicitly.
- UI and MCP read details through the existing store's strict JSONL validation.
  Browser preview retains at most forty messages; each response has at most
  twenty messages and each message is capped at four thousand characters.
  Files larger than sixteen MiB remain download-only for browser preview.
- Selected-file reads, downloads, retention and deletion carry the inventory
  digest. Restoration uses server preview and the confirmed digest/revision,
  protects the current chat, and never calls a model or automatically reloads.
- Uncertain restoration retains its approved proof. A separate verification
  action works after navigation, missing inventory items or failed refresh.
  The dialog cannot silently close while a restore outcome remains unresolved.
- Seven Nora backup tools cover list, read, download, retention, deletion,
  restore preview and restore. Operator-only writes require explicit approval;
  unknown transport outcomes do not initiate a new restore request.
- Legacy inventory excludes only verified managed filenames, not all files
  with a managed-looking prefix. Orphan files remain visible and read-only.
- Skill guidance reuses the existing chat-ledger reference rather than adding
  a separate backup skill or a second storage/write subsystem.

## Review Corrections

Two independent read-only reviews identified missing session confirmation,
duplicated UI validation, preview/hash mismatch, uncertain-response verification
depending on a surviving detail view, and hidden orphan inventory. These were
corrected before integration, with regression cases for identical-time sessions,
malformed headers, digest-bound operations and verification after inventory loss
and failed refresh.

## Technical Verification

| Check | Result |
| --- | --- |
| Backup UI, store and real HTTP tests | 68 passed, 0 failed |
| MCP TypeScript build and unit/stdio-discovery tests | Build passed; 25 passed |
| Real stdio MCP to isolated backend/store/ledger | 1 passed |
| Owned-source lint and whitespace check | Passed |
| Frontend build and runtime-asset generation | Passed |
| gzip/Brotli decompression byte parity | 10 passed |

The integration test exercises restoration and deletion only in temporary
fixtures. It verifies scope isolation, approval, stale revisions, active
generation, protected checkpoints, replay, export permissions and MVU-byte
preservation. No user's original chat was restored or deleted.

## Remaining Boundaries

- The installed local MCP still lacks main's ledger reset tool and advanced
  ledger configuration fields. This was confirmed by comparing source with
  installed `dist/server.js`. This turn does not authorize runtime replacement.
- The final review corrections are source/build verified, not a new browser or
  natural-language Nora acceptance run. Earlier deployment is not proof that
  this final merged source is installed.
- Frontend entry/lib-core retain build size warnings (387/785 KiB raw). They
  are not themselves evidence of a particular user's loading latency.
- This targeted review does not replace Windows/Intel-Mac installer, external
  telemetry receiver or real slow-model acceptance. Earlier broader main-review
  results are recorded separately in `local-main-integration-20261001.md`.
- Worktree research/verification documents outside this feature remain intact.
  Closing/reloading the browser or restarting the server is outside the dialog's
  in-memory uncertain-request guard; no persistent client recovery was added.
