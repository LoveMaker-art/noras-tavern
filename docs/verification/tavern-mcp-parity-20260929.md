# Tavern MCP parity implementation status

Subsequent authorized local deployment and real Nora conversation evidence is in
[local acceptance](tavern-mcp-local-acceptance-20260929.md). The implementation-stage
record below describes the earlier pre-deployment checks, not the current deployment state.

## Scope and evidence

- Base: local main `f59f4e37fd6e439599efdeb5905d04d6bc6756df`.
- Branch: `codex/tavern-mcp-parity`.
- Source implementation and focused automated checks only. Not merged, published,
  registered in the user's running Nora, or deployed to a managed runtime.
- No real chat mutation, browser interaction, plugin installation or paid model
  request was performed. Tests use fixtures, temporary storage and fake providers.
- This is not a claim that every Tavern UI operation is covered.

## Implemented

| Area | Behavioral delta |
| --- | --- |
| MVU model | Optional context/output limits; patch preserves omitted settings |
| MVU diagnostics | Read-only recent metadata through existing per-user rotating history; raw error prose omitted |
| Card library | Authoritative catalog and import-to-library without creating a World; legacy records remain identified |
| Card management | Conditional original-file deletion and exact duplicate cleanup, sharing import-time reference/content checks; returns removed/retained |
| Profiles/books | Conditional deletion of reusable profiles and independent library books |
| World restart | Existing restart service exposed with source revision and idempotency key |
| Presets | Revision-bound chunk reads and library deletion through UI adapter; backend conditional deletion prevents stale overwrite |
| Large preset fields | nora.preset.edit_file reads up to 10 MiB of JSON edits from the allowed upload directory; edits the existing library template with the same validators |
| Plugins | Library-aligned inventory, disabled installation, local editable update/uninstall; protected components excluded |
| Nested plugin configuration | Existing nested objects and array fields with revision/type checks; preserves siblings and blocks secrets, new fields, resizing and prototype paths |
| Text model | Shared UI service creates/tests/saves a custom profile; credentials excluded from receipt |
| Messages | Ordinary assistant edit, user edit/regenerate, existing candidate selection and retry through dispatcher |
| Navigation | Page state, panel open/guarded close, library categories, explicit drawer state, guarded World switch and unsent draft control |
| File exports | Native card PNG/JSON, preset/book JSON and Nora profile JSON; private unique artifact, size and SHA-256 receipt, source unchanged |
| Capabilities | Retry existing World capability initialization without granting new permissions |
| Library Regex | Inspect/edit existing rules of an explicit non-legacy original; no World-copy synchronization |
| Skill references | Updated the existing domain references rather than adding another instruction subsystem |

## Diagnostic history policy

Reuse `nora-telemetry/mvu-diagnostics.ndjson` and its single rotated predecessor
within each user data root. Existing default rotation threshold: 2 MiB per file.
The MCP response includes only selected identifiers, time, code, stage, counters,
persisted state and duration. It excludes summary, fallback prose and validation
error text. This is bounded recent history, not a permanent audit log. An empty
result does not establish successful execution. No second log store was added.

## Verification

- MCP TypeScript compilation passed.
- 18 focused MCP tests passed, including actual stdio discovery and read-only
  policy, diagnostic redaction, upload restrictions, preset file edit/import,
  actual export artifacts and binary response/CSRF handling.
- 108 focused engine/UI-adapter tests passed, covering conditional writes,
  target isolation, preset chunks, diagnostic rotation, plugin protections,
  candidate bounds, model receipt redaction and shared-adapter regressions.
- `git diff --check` and changed UI entry-point syntax check passed.
- Webpack frontend build passed with entry/lib-core size warnings. Generated
  release artifacts were restored after verification; this is not a deployment.
- Tests do not demonstrate production browser interaction or successful calls
  to the user's chosen provider. The new capability retry/page navigation paths
  still require target-environment workflow acceptance.

## Explicit boundaries and acceptance still required

- The previously listed five gaps above are now implemented within the agreed scope.
- The user approved generic plugin configuration limited to existing fields,
  including nested/array fields, preserving types and secrets. Arbitrary new plugin
  schemas, external pages and custom buttons are not universally controllable.
- A guarded editor close can require the user's existing confirmation; no forced
  draft discard was added. A declined close returns applied=false.
- Large-file preset edits target the library template, not a silently updated World.
- Card removal preserves immutable provenance archives and all World/chat copies.
  Referenced originals/duplicates are retained and must not be reported deleted.
- Export is a local artifact, not an external upload. Profile JSON retains Nora's
  profile envelope; it is not misrepresented as a full ST character card.
- Production page workflows and real provider/plugin execution remain unverified;
  deployment requires separate authorization. The current running MCP is unchanged.

The independent branch now exposes 57 MCP tools and 90 live actions. Counts are
inventory only, not evidence of product fit or successful production execution.
