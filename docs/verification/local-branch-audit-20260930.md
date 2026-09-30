# Local Branch Audit 2026-09-30

## Scope

User requested inspection of all local independent branches and local main integration.
Audit baseline: `main` at `c657f9c2ce598f600dbaa42f755e6d730c8f6218`.
No GitHub push, product release, runtime replacement or branch deletion is included.

## Branch Inventory

All 12 Tavern branch tips were ancestors of main before this integration. This
does not mean their working directories were clean. Working changes were checked
separately against main and the previous integration record.

| Branch (codex/) | Result |
| --- | --- |
| cardforge-validation-alignment | Committed changes already in main; clean |
| dialogue-quote-style | Already in main; local dependency link excluded |
| extension-manager | Already in main |
| helper-script-persistence | Functionality integrated; old working copy retained |
| helper-upstream-upgrade | Already in main; clean |
| launcher-build-reuse | Already in main |
| launcher-telemetry | New uncommitted telemetry implementation to commit and merge |
| preset-prompt-editor | Already integrated with newer compact controls; old 44px editor layout not reapplied |
| startup-followup | Source optimizations integrated; obsolete generated assets not copied over current output |
| startup-preload-audit | Already in main; local dependency link excluded |
| storage-lifecycle | Already in main; clean |
| tavern-mcp-parity | MCP additions integrated; old working copy lacks subsequent storage and upstream changes |

The prior source-integration decisions are recorded in
`docs/verification/local-branch-integration-20260928.md`. Examples checked directly:
main retains the newer Helper 4.11.2 rather than the old startup worktree's 4.9.3;
main preserves deletion preview/expected-plan protection missing from the old MCP
worktree; main preserves compact preset title actions and draft collapse/reopen
tests instead of replacing them with the old editor-body pencil layout.

Untracked research and MCP audit documents in the main worktree are preserved and
not automatically added to this feature commit. Old working copies are not reset
or advertised as clean. This audit is not a new exhaustive behavioral acceptance
of every historical feature.

## Integration

Commit the Tavern telemetry sources, contract, tests and diagnostics documentation,
then fast-forward local main. Also commit and fast-forward the matching
`codex/launcher-telemetry` branch in the nora-landing repository, based on `79d55d0`.
The Worker is already deployed; Git integration alone does not publish a launcher.

Targeted verification includes client opt-out, retry and restart handling, actual
Worker contract with in-memory D1, existing website API compatibility, and
launcher download/runtime/update regressions. Desktop visual and three-platform
packaged acceptance remain outside this merge. Authenticated production statistics
query acceptance awaits the existing read key; ingestion and database deduplication
have been verified separately on production and test rows removed.
