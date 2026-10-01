# Local Main Integration Review - 2026-10-01

## Scope And Evidence

Requested outcome: consolidate every local feature branch into local main,
review correctness and redundancy, and clean verified obsolete leftovers.
No installer packaging, GitHub push, release, managed-runtime replacement,
service restart, browser interaction, real provider calls or user-data writes
were performed. Frontend compilation is not installer packaging.

Initial main was `aa5ec682`; the last locally recorded origin/main was
`6a532ca8`. All 18 pre-existing branch tips were already main ancestors.
The outstanding authored work was the ledger branch's 37 files and main's
three launcher-version metadata files. These were committed separately as
`8c19eee` and `17e97cc`, then integrated in `9d2900e` before review fixes.
Launcher source version 2.0.0 remains unpublished metadata, not an assertion
that an installed launcher or the online release was upgraded.

## Consolidated Capability Areas

| Area | Main's integrated content and review boundary |
| --- | --- |
| World and libraries | Independent world resources, library operations, deduplication, lifecycle and deletion previews; regression fixtures exercise isolation and permissions. |
| Presets and rendering | Preset prompt editing, quote rendering, startup/readiness and deferred editor/runtime loading; executable rendering and module contracts retained. |
| ST and Helper | Upstream integration and script persistence; no old compiled worktree bundle was substituted for newer source. |
| MCP and Nora | Existing library, model, plugin and ledger interfaces plus skill references; stdio discovery and transport tests pass, not a new natural-language acceptance run. |
| Storage and diagnostics | Protected chat snapshots, restore coordination and shared bounded log writing; operational fixtures cover preservation and failure paths. |
| Launcher | First-install selection, extraction, model reconfiguration, component reuse, telemetry and error diagnostics; simulated checks are not Windows/macOS installer acceptance. |
| Ledger | Session settings, bounded output/context budget, configurable timeout, cancellation, failure pause and protected reset; default enabled semantics retained. |

## Correctness Fixes From This Review

- Helper saves retain system/post-history/depth prompts, embedded books and
  unrelated serialized card fields through the actual ST formatter.
- Failed world deletion with `deletion_pending` cannot revive script consent.
- Ledger inspection and read-triggered lease expiry do not initiate model work.
  Only explicitly deferred eligible jobs resume after a real activity release.
- Cancellation cannot let an old failure overwrite a new configuration revision.
  Ordinary history editing no longer silently clears a failure pause.
- A compression task captures one model configuration. Currency is checked
  before every provider part/retry and before publishing a candidate. Already
  dispatched network I/O is not claimed to be instantly revocable on switching.
- Restoring/resetting cancels and waits for that session, not unrelated tasks.
  Cancelling queued work settles its ownership without bypassing serialization.
- Configuration changes enforce foreground ownership server-side; disabling
  alone remains available to cancel background work.
- In-place reset/retry confirmations preserve the editor's unsaved-draft guard.
- Backup, deletion and ledger messages have checked English translations.

## Redundancy Cleanup

Removed an unused model wrapper, duplicated UI controller cache state and unused
constructor arguments. The UI composition entry remains 500 lines; its limit
was not increased. Valid behavior tests and permission protections were kept.

Reviewed 95 pending paths in four historical worktrees: preset editor (3),
Helper persistence (5), startup followup (41) and MCP parity (46). No unique
unintegrated authored capability was found. After exact byte comparison with
the safety backup, restored 77 superseded tracked edits and removed 18 obsolete
untracked source/test/document copies. Two old dependency symlinks were removed,
not their package directories. Historical generated bundles were superseded by
the current-source rebuild, not presumed byte-identical.

Safety backup: `/tmp/nora-integration-safety-20261001-5qFgtv`, including inventory,
binary diffs and original files. Three unrelated research/verification documents
in `main-integration-audit` were preserved, not silently committed or deleted.

Stale tests were aligned with their real inputs: pinned vendor syntax, world
consent identity, loaded-only extension summaries, AST import composition,
current provider routing, delivery paths and complete isolated installations.
Rollback tests explicitly retain recovery snapshots after failure; production
rollback protections were not relaxed to obtain passing results.

## Verification Results

| Check | Result |
| --- | --- |
| Full Tavern tests in isolated delivery tree | 1,271 cases: 1,256 pass, 15 skip, 0 fail |
| Tavern executable/static contracts | 27 pass |
| Slow loopback provider | Actual 125-second response completes; no real model/key |
| MCP TypeScript build, transport and stdio discovery | 20 pass |
| Authored layout/docs/component regression tests | 39 pass |
| Deployment Python suite | 337 cases: 318 pass, 19 skip, 0 fail |
| Selected launcher model/runtime/telemetry/error tests | 148 cases: 142 pass, 6 skip, 0 fail |
| Owned-source lint, Story Profile parity, frontend build | Pass |
| Compressed frontend artifact byte parity | 10 gzip/Brotli files pass |

The full engine run used correct per-package links for vendored file dependencies;
copying the whole external node_modules link gives a misleading module-identity
failure. Contracts also need the generated standalone public library in the
temporary export. Root source-layout tests run against authored source, not the
delivery projection. These setup corrections do not weaken assertions.

Final full-engine log: `/tmp/nora-integration-final-engine-20261001.log`.
Independent read-only reviewers also reproduced cancellation, model switching,
lease expiry and historical-worktree equivalence. Maximum exercised background
provider concurrency stayed one.

## Remaining Boundaries

- Chat backup management's newer UI/server operations are not exposed as MCP
  tools. Existing ledger/chat tools do not constitute complete backup control.
  This is an existing feature gap, not a merge conflict; adding a new mutation
  interface needs its own confirmed authorization and data-safety design.
- The build still warns about entry/lib-core asset size (387/785 KiB raw).
  Startup budgets pass; this is not proof that all real devices load quickly.
- No real-browser visual acceptance, real Nora conversation, Windows install,
  Intel-Mac install, external D1 receiver acceptance or real slow local model
  was run this turn. Skipped tests are not counted as passes. The 125-second
  test separately covers the slow-provider case skipped by the normal suite.
- Local source integration does not update the currently installed 8799 runtime.
  No claim of runtime deployment or publish readiness is made.
