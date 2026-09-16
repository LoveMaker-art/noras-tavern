# Import a newly built card through Nora MCP

This reference is for CardForge's new-card build artifacts. For an existing card,
assess it and follow the `tavern` skill's original-file import route. Authorized
prose polishing uses its reviewed candidate through that same existing-file route;
see [prose-polishing.md](prose-polishing.md).
Do not create a build project simply to stage an existing card: serialization can
change third-party metadata, and new-card quality gates are not import gates.

## Ownership and intent

CardForge authors and packages cards. The already-configured `nora` MCP imports
them through World Core. Use one existing MCP connection, not a second client,
raw HTTP, legacy Python CLI or direct writes to character/chat directories.

`nora.world.import` creates a **new World**. It is neither library-only storage
nor an update of an existing World. Export-only requests end with delivery of the
JSON/PNG. If the request is just “put it in my card library”, resolve that distinct
intent through the `tavern` skill; do not substitute new-World creation.

## Prepare locally

1. Build the latest authored sources, inspect the artifact, and review the returned
   quality report. `release` gates structure; writing scoring is opt-in and advisory.
2. Discover the installed `nora.world.import` and `nora.operation.get` schemas.
   Hermes normally registers these as `mcp__nora__nora_world_import` and
   `mcp__nora__nora_operation_get`. If deferred, use `tool_search`, `tool_describe`
   and `tool_call` with their installed schemas. Logical names below are not
   literal shell commands. Missing tools are a prerequisite failure, not a cue to
   reinstall MCP or widen permissions.
3. Resolve the actual MCP upload directory on the same host. Read only
   `mcp_servers.nora.env.NORA_MCP_UPLOAD_ROOT` from the current Hermes configuration
   (do not print the whole config or secrets). If it is unset, ask `tavern-ops` to
   resolve the installed MCP's effective directory; do not guess a path or modify
   configuration. The directory must already exist.
4. Choose one stable idempotency key for this intended new World. Keep it for
   retries; a genuinely separate new World uses a new key, even with identical bytes.
   Preview and then stage using the same project, directory and key:

   ```text
   node scripts/nora-cardforge.js prepare-import --project <project> --upload-root <actual-directory> --idempotency-key <key> --dry-run
   node scripts/nora-cardforge.js prepare-import --project <project> --upload-root <actual-directory> --idempotency-key <same-key>
   ```

The preview writes nothing unless an explicit CLI `--output` report was requested.
The second command copies the hash-verified PNG (preferred) or JSON to a
content-addressed file, reusing identical bytes. It does not contact Tavern,
execute scripts, call a model, change a World or generate user consent.
Treat `stage=prepared` as staging evidence only. A hash mismatch requires rebuilding;
a conflicting destination is preserved and reported, never overwritten.

## Import and recover

5. Once new-World creation is authorized, call the actual registered MCP tool for
   the returned `mcpCall.tool`, passing `mcpCall.arguments` plus `confirm: true`.
   The CLI deliberately omits `confirm`. Do not pass the entire preparation report
   as tool arguments. Preserve the exact bytes/key after an uncertain result.
6. Read the returned `operation.operation_id` with `nora.operation.get`.
   `PENDING`/`RUNNING` means wait with bounded polling, not success. On transport
   uncertainty query `recovery.operationId` from the preparation report first.
   Do not keep creating fresh keys or repeatedly import to make an error disappear.
   For a confirmed retryable `FAILED` operation use the existing `nora.operation.retry`
   workflow. Otherwise report its code/stage and stop rather than manipulating files.
7. Require `operation.status=COMPLETED`; inspect its `world_id` with
   `nora.world.inspect`. Save the actual structured result (not the text-wrapper MCP
   envelope) and the prepared handoff in the project's reports directory, then run:

   ```text
   node scripts/nora-cardforge.js verify-import --prepared <handoff.json> --inspection <world-inspect.json>
   ```

   It compares operation/source identity, World name/readiness, the World-card format
   marker, persona and full cast including activation settings. A missing marker or
   panel's data is a failed handoff, not a
   successful import with an optional future configuration task. Do not edit reports
   to pass. If full card inspection is required use the returned
   avatar with `st.character.inspect`, not a guessed name/path.
8. Report “created World” separately from browser activation. `nora.world.snapshot`
   reports actual capability evidence. `nora.world.open_plan` does not open a page.
   If the user wants to test MVU/Helper/status UI, hand the exact World and request
   to `tavern`; generated imports and third-party scripts need their normal runtime
   and any required execution authorization. Never manufacture READY receipts.

The user's new-card project remains available for draft refinement. Keep staged artifacts
until their operation is settled; uncertain imports must not lose their retry input.
Existing worlds and source cards are not deleted by this workflow.

## Persona and cast transport

The existing `nora.world.import` accepts `personaName` and `personaDescription`.
`prepare-import` fills them from the authored card; pass the returned arguments
unchanged. The cast is embedded in `extensions.nora_world.story_context` and
materialized by World Core. New-format cards also carry the persona there for
direct file import; a nonempty caller-supplied persona overrides it.
No follow-up `world.update` is normally needed to populate these fields.
If an installed tool lacks the documented parameters, report the version/interface
gap instead of silently dropping fields or rewriting the card. Runtime readback
is still required: CLI staging cannot prove the target server supports this format.
