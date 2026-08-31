# Import a built card through Nora MCP

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
   quality report. `release` gates structure; its writing score is advisory.
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
   `nora.world.inspect`. Compare the returned World/name and runtime-card binding
   with the intended card. If full card inspection is required use the returned
   avatar with `st.character.inspect`, not a guessed name/path.
8. Report “created World” separately from browser activation. `nora.world.snapshot`
   reports actual capability evidence. `nora.world.open_plan` does not open a page.
   If the user wants to test MVU/Helper/status UI, hand the exact World and request
   to `tavern`; generated imports and third-party scripts need their normal runtime
   and any required execution authorization. Never manufacture READY receipts.

The user's editable project remains available for revisions. Keep staged artifacts
until their operation is settled; uncertain imports must not lose their retry input.
Existing worlds and source cards are not deleted by this workflow.
