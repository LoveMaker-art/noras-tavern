# Rolling Chat Backup Safety

## Accepted Outcome

Backups are an auxiliary rollback mechanism, not a prerequisite for normal
play. This supersedes the earlier requirement to pause rewriting when the
pre-rewrite backup fails. Canonical chat persistence, revision, ownership and
concurrent-write checks remain mandatory. Backup failures must not masquerade
as chat-save failures or successful backup creation.

The default is 50 automatic snapshots per session, 30 days, and a shared
512 MiB user budget. Existing explicit custom limits remain authoritative.
Identical content reuses its snapshot. Count, age and byte-pressure retention
remove only verified, owned, unprotected copies. Manual keeps never consume
automatic count slots and are never silently unkept or removed. More than 50
manual keeps in one session is a cleanup reminder, not a hard operation cap;
the reminder follows an explicitly customized count when present. Manual keeps
still consume the shared byte budget. Unknown or changed files remain intact.

## Behavioral Changes

- Regeneration checkpoints, history editing, memory reset and pre-restore
  backup attempts share a best-effort path. Storage-full, permission, write,
  metadata and timeout failures return a warning without blocking the operation.
- Automatic attempts have a one-second foreground deadline and one in-flight
  task per user root; a hung task cannot accumulate unbounded queued buffers.
  Expired tasks cannot initiate later metadata commits or retention deletions.
  Already dispatched filesystem operations cannot be cancelled synchronously.
- New snapshot data and metadata are read back and hash-validated before old
  automatic copies are pruned. A failed or corrupted replacement does not
  authorize pruning prior backups.
- A selected restore source is temporarily retained, not permanently pinned.
  Restoration still validates its identity, digest and target revision before
  atomically replacing the chat. A missing pre-restore backup does not block
  restoration; its success response explicitly warns that the new rollback
  point is unavailable. Replayed requests retain that warning.
- The backup UI displays a cleanup alert for manual count excess or byte
  exhaustion, with counts, occupancy and instructions to unkeep before deleting.
  These alerts do not disable normal operations or management controls.
- Repeated foreground reminders are coalesced; notification failures cannot
  reject a successful operation. Regeneration retains the original reply and
  its variables in memory so an ordinary generation failure does not depend
  on a disk backup to restore the current page.
- MCP exposes sanitized capacity metadata and preserves restoration warnings.
  The existing skill reference documents this contract without adding a tool
  or duplicating instructions in the main skill router.

No swipe-control changes, ledger compression changes, user data edits, installed
configuration migration or runtime deployment are part of this source work.

## Release Gate

Run from the repository root with Node:

```sh
node --test tests/backup-safety-gate.test.mjs tests/repository-layout.test.mjs
node tooling/checks/verify-backup-safety.mjs
```

The second command runs the engine's focused backup/UI/ledger suites, builds
MCP TypeScript, then runs unit and actual stdio MCP-to-HTTP integration tests.
It also enforces the existing critical startup resource budget. Regeneration-only
rollback is loaded on demand using the existing runtime import-map protocol.
Both component publication and integrated launcher builds install the required
dependencies and run the gate before packaging. Test failure, killed workers,
compiler failure or timeouts stop the gate. Workflow contract tests check strict
shell handling and ordering, not just the presence of a test-step name.

## Evidence And Limits

The nonblocking disk-failure and manually-kept-over-budget scenarios were first
reproduced as failures against the old implementation. Isolated fixtures cover
120 changed checkpoints, 100 runtime message edits, 60 restorations and 60 real
HTTP checkpoint/lease/save cycles. Additional tests inject disk/metadata errors,
stalled storage, corrupted replacements and manual over-budget copies. They
verify that valid foreground operations succeed while stale revisions, unsafe
paths, invalid restore sources and concurrent ownership conflicts remain blocked.
The stdio integration uses the real MCP transport and Express routes, including
export, manual protection, budget-exhausted restoration, isolation and replay.
No model calls or real user data are involved.

### 2026-10-09 release preflight corrections

Windows replacement retries now yield while retaining the session lock, so
pending readers can close. Every attempt rechecks the file precondition
synchronously before atomic replacement; ledger changes await successful
canonical replacement. Eight attempts have 1,770 ms of total scheduled waiting.
Permanent denial preserves the original file. A native Windows fixture holds
a file handle without delete sharing for 600 ms; Mac runs skip that OS-specific
fixture and cannot establish its Windows outcome.

Inventory uses four read workers and 1 MiB streaming buffers. Large inventory
hashing therefore retains at most four such buffers, rather than whole snapshot
bodies. Content hashes, size limits and directory/file identity checks remain
mandatory. Small display summaries retain their existing 16 MiB per-file cap.
The two-second developer regression target uses capture P95 and the median of
three large-list samples; maximum capture time and all list samples are logged.
This avoids treating one cloud-host scheduling pause as a sustained regression.
The one-second automatic-attempt deadline and its no-late-commit tests remain
unchanged. Retention fixtures explicitly establish completed snapshots before
testing bounded optional attempts; timeout warnings never count as creation.

Final local gate: 158 engine tests passed, zero failures or skips; MCP TypeScript
compiled and all 5 backup unit/stdio integration tests passed. The 3 release-gate
contract tests and 8 repository-layout tests also passed. Webpack and generated
runtime assets built successfully. Critical runtime Brotli payload is 559,641
bytes against the unchanged 560,000-byte limit; visible shell is 25,077 bytes
against its 30,000-byte limit. Deliberately injected reminder/renderer errors
remain diagnostics rather than operation failures. A generated model reply whose
canonical save fails remains in the page for save-only retry, not rolled back.

Local runs use macOS and Node 24. Engine and MCP build checks are local only;
GitHub workflows and Windows/Intel Mac application runs have not been performed.
Browser visual acceptance, a real streaming-model failure workflow and deployed
application acceptance are not established by these tests. The UI test file has
eight pre-existing ESLint errors verified against the branch base; this work
does not claim a repository-wide clean lint result. The central localization
dictionary's 258 existing quote-style errors are unchanged; changed runtime code
and the modified dictionary pass the applicable owned-code error checks.

Changes were implemented on `codex/backup-retention-safety`. After the local
deployment, the user authorized integration into local `main`. No push or
publication is included; real-model acceptance remains outstanding.

## Authorized Local Deployment

On 2026-10-08, the user authorized replacing the currently open 18999 test
runtime. The target is
`~/Library/NoraTavern-Tests/launcher-candidate-3b1bcd4bb196-telemetry`.
The 27 affected program files and original configuration were backed up under
`cache/backup-retention-deploy-20261008`, including a SHA-256 deployment manifest.
Only its explicit `backups.chat.retention.maxPerSession` setting changed from
20 to 50; the remaining installed configuration was preserved.

The direct native CLI rejected an unsupported operation entry without changing
the runtime. Stop and start then succeeded through the installed launcher's
authorized `launcher_bridge.py` entry, restricted to `--service tavern`. The
Nora gateway was not restarted. The resulting unique 18999 listener is PID
63890, and the maintained lifecycle reports the runtime healthy.

The actual authenticated `/api/backups/chat/managed` response returned HTTP 200
with the 50 / 30-day / 512-MiB policy and manual-capacity metadata. The page,
both lazy backup helpers, and the extension's backup controller and stylesheet
returned HTTP 200; served assets matched the source SHA-256 hashes. All 27
installed program files matched the deployment manifest. The existing World
manifest and chat file remained byte-for-byte unchanged after restart.

This establishes deployment and read-only HTTP verification, not browser visual
acceptance or real-model regeneration acceptance. The user will perform those
checks in the open 18999 page. MCP and Nora skill deployment were not included
in this Tavern-process-only authorization.
