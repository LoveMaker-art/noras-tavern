# Isolated Python → Node rehearsal

Use only after explicit authorization to test on a disposable copy. Never target
the live installation or remove the temporary-home restriction. The default
file updater still refuses Python data. Ports 8799 and 8809 are reserved.

The repository harness `ops/tests/verify_python_release.py` accepts
`--release-dir <approved-candidate>` and `--old-ref <reviewed-python-commit>`.
It creates a marked temporary home, extracts the actual historical Python app,
uses that app's serializer to generate synthetic data, then runs the new Node
process and a fresh read-only MCP probe. It does not start the old Python server,
invoke generation, reload Hermes or register Liveware. Read the result before
claiming success. Its source and fixture are development files, not runtime data.
Run the same harness with `--fail-after-start` to verify automatic recovery after
a real Node startup. This is distinct from a later successful manual rollback.

## Transaction

1. Review pinned archives, installed code, managed skills/AGENTS and MCP config.
   Report old code that will leave active directories and preserved custom plugins.
2. Require an offline source. Copy the complete project state. Convert only that
   copy through `prepare-state.mjs`; existing current Node data is validated only.
   No Node v1→v2 conversion is performed by this updater.
   Prepare the native public-directory contract before taking code fingerprints;
   startup-created empty directories must not masquerade as concurrent code edits.
3. Convert Python productions to stable-ID Worlds/Sessions, retaining all raw
   messages and alternatives. Library templates are distinct from World-owned
   cast profiles, player state and relationships. Native activation consumes the
   cast; ledger compression receives the same actor IDs.
4. Validate old ledger coverage/signature. Valid ledgers remain pending until a
   Node dispatch accepts their context; do not invent an activation or edit lock.
   Their prior shared-memory projection is preserved. Invalid coverage leaves raw
   history intact and is reported rather than activating stale memory.
5. Preserve recognized Profile files and custom model credentials. Resolve the
   original Python built-in model separately from the Hermes primary model.
   Never log keys or contact a model to migrate data.
6. Switch complete code trees, state and reviewed host files with a durable rename
   journal. Original Python data namespaces are archived inside the copied state
   under `python-source`; old executable code stays outside active paths in the
   transaction backup. USER.md/MEMORY.md are included; the entire Hermes home is not.
7. On failure restore original trees. Python was required offline and remains
   offline after rollback: starting its main() could trigger billable backlog.
   Later rollback must refuse newer conversations/edits instead of erasing them.

## Limits to report

- Broken references, unsupported cast/Profile schemas, mixed native/Python data
  or changed outputs refuse conversion. Do not delete records to bypass validation.
- Python-specific exclusion-key lore requires explicit semantic mapping; old
  `/assets/` images require their source mapping. Such inputs stop the transaction.
  World covers are archived but are not displayed by the current UI.
- Old Python imports discarded some executable scripts and images. Conversion
  cannot restore absent MVU/Regex/Tavern Helper code; re-import original cards only
  with separate user authorization.
- Saved character state is preserved and used. The Python background character
  state-generation algorithm is not reinstated; newer conversation/ledger governs
  subsequent narrative, with current MVU handling unchanged.
- `isolated-installed` proves only the reported fixture/HTTP checks. Production
  writer draining, real user-data reconciliation, Liveware/UI acceptance and
  gateway activation remain separate gates. Do not distribute this as a universal
  automatic Python upgrade or claim visual compatibility from API tests.
