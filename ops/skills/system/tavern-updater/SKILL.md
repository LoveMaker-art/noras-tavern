---
name: tavern-updater
description: Review, upgrade, activate and roll back Tavern releases.
version: 2.1.0-rc.2
author: Tavern Project
license: AGPL-3.0-only
platforms: [linux, macos]
metadata:
  hermes:
    category: system
    tags: [tavern, 更新, 发布, 回滚]
    revision: full-directory-python-upgrade-20260831
    requires_tools: [terminal]
---

# Tavern Updater

Update Python or current Node Tavern as one reviewed release: Tavern (including Story Profile),
Nora MCP, operational scripts, four skills and the managed Tavern AGENTS block.
Use `tavern-ops` for restoring the current version without upgrading.

## When to Use

Use for requested release review, upgrade or rollback. Version inspection alone
does not authorize installation, a restart or executing downloaded code.

## Prerequisites

For an owner-supplied, explicitly approved project updater command, follow
**Execute and report** below. The script performs its own environment/release
checks; a routine execution request is not a request to investigate the codebase.
When choosing a release or planning an upgrade, read
[release compatibility](references/release-compatibility.md) to resolve the
installed layout, trusted source, first updater adoption and activation steps.
Use Hermes' Python environment, Node 20+ and npm. Preserve the existing MCP
permission mode and tool allowlist.
For explicitly authorized isolated migration rehearsals, first read
[isolated clean transactions](references/isolated-rehearsal.md). Rehearsals use the
same transaction on a marked temporary home and separate port. Conversion is
Python productions → Node Worlds; existing Node data is validated, not migrated.

## How to Run

Use Hermes `terminal` and this skill's `scripts/update.py`. Inspect its `--help`
only when constructing a command, not before executing an approved exact command.
For first adoption, use the verified Bootstrap described in release compatibility.
It stages the updater privately. Review leaves all active skills, app, MCP,
data and AGENTS unchanged; they switch together only during approved apply.
A GitHub branch is source, not a release asset. A tag without the full bundle and
Bootstrap assets is not an available upgrade.

## Execute and report

For an approved exact update command, send only a brief start announcement and
one final summary. Keep automatic progress in terminal output, not chat messages.
Answer a user-requested status question or a required authorization prompt when
needed; otherwise wait for the result without intermediate narration.

1. Say "开始更新。" (or its equivalent in the user's language), then execute
   the approved command once with `terminal`. The script performs the update
   without model calls.
2. If the terminal returns a running session, wait/poll that same session for its
   exit code and new output. Read `[tavern-updater]` progress internally and retain
   it in terminal logs. Silence alone is not a failure and never authorizes a
   second update command.
3. When the command exits, send one concise final summary and end the turn:
   - Success: installed version/status and the script's owner `/restart` instruction.
     Installation does not mean the current gateway has reloaded.
   - Failure: failed phase, concrete `error`, `status`/`recovery`, and transaction
     or error-log path. `rolled-back` is recovery, not a successful upgrade.
     Unknown/partial recovery, including `integration-pending`, must be stated as unconfirmed.
   - Older scripts without a useful error: say the script failed and the cause
     is not yet known; ask whether the owner wants diagnosis.
4. Diagnosis or another attempt starts only after separate owner approval. A
   routine update request does not authorize reading successive logs/source files,
   repairing process supervision, killing processes or retrying after failure.
   The updater's own transaction recovery remains automatic; wait for it to finish.

Use the command's structured result directly. Do not perform extra log/receipt
reads merely to repeat evidence already in that result. If a timeout/disconnect
leaves execution state unknown, report that uncertainty and retain the session ID;
do not claim failure, success or rollback without evidence.

## Quick Reference

| Operation | Required evidence |
| --- | --- |
| `fetch` | Explicit approved tag; downloads only from the project GitHub release |
| `review` | Pinned manifest SHA-256; returns transaction and plan digest; live files unchanged |
| `status` | Requested read-only inspection; separates receipt-time results from current local runtime |
| `apply` | Owner approval, same transaction and expected plan digest, `--confirm` |
| `rollback` | Matching transaction, original plan digest, owner approval and `--confirm` |

## Procedure

Use this procedure when choosing a release or planning an upgrade. An approved
exact command follows **Execute and report**, without an extra planning narrative.

1. Resolve the exact Hermes home and source runtime. Python namespaces are converted
   on a private state copy, retaining Worlds, cast, messages, ledger, Profile and
   credentials. Current Node data is validated only. Mixed data, unknown schemas,
   missing references/assets and modified legacy AGENTS require reconciliation;
   report them rather than deleting records or weakening validation.
2. Fetch the approved tag or use a verified local bundle. Run `review` with its
   directory and manifest SHA-256. Candidate bundles require explicit test
   authorization and `--allow-candidate`; never present them as stable releases.
3. Summarize versions, migration, code leaving active paths, preserved plugins,
   downtime and recovery. Require a maintenance window with chats/external writers
   paused; busy Python jobs block maintenance. Reuse the transaction and digest;
   if preconditions changed, review again instead of overwriting new local work.
4. Read the receipt. `installed-awaiting-hermes-reload` means installed files and
   a fresh MCP probe passed, not that the gateway switched its existing MCP process.
5. Follow [owner activation](references/activation.md). After successful installation,
   tell the owner to send `/restart` in their ClawChat conversation and wait for
   Hermes' restart notification. This is a chat command, not a terminal command;
   the updater/agent must not execute it on the owner's behalf. Do not default
   to the older “确定” activation-bridge flow. Isolated rehearsals require no
   restart of the live gateway.

## Pitfalls

Review leaves active files unchanged, including the updater skill itself.
The installed skill invokes installed ops; historical global Bootstrap pointers
are not used. Apply/recovery verify and run the engine pinned in that transaction.
Apply prepares dependencies, verifies/stops the owned process, copies and converts
state, then switches reviewed code/state trees and host files. Durable intent
precedes every rename. Failure recovery restores original trees and the prior
running/offline condition; report any recovery error immediately.
New updates use only directory transactions. The legacy file-level adapter can
recover existing receipts but cannot review or apply a new release.

Preflight budgets complete state/code copies plus estimated dependency space and
requires one filesystem for directory switching. Unknown code leaves active paths
but remains in recovery; custom plugin locations are explicit overlays. Later
rollback refuses newer conversations/edits rather than erasing them. External
writers must honor the maintenance window.

Worlds, chats, keys, custom skills and instructions outside the managed AGENTS
block are preserved. USER.md/MEMORY.md participate in recovery. The updater does
not create/delete Liveware Apps, replace the whole Hermes home or restore executable
card scripts discarded by the Python importer. It reconciles the two existing
App IDs, checks their local entry metadata/icons and corrects launcher registrations.
`binding-acknowledged` means the CLI accepted the bind, not that the external
ClawChat entry was observed. The current CLI cannot query a tunnel's original
local target: after an uncertain bind, recovery reports `integration-pending`
instead of guessing the old target or claiming complete recovery. Recovery contains private
configuration: keep it on the host outside skills discovery.

## Verification

The script verifies the receipt, matching installed hashes, new Tavern process
health, Story Profile route and fresh read-only MCP discovery; report its evidence
without rerunning the same checks. After a separately requested activation check,
verify Hermes' reloaded
MCP and four unique skills (`tavern`, `tavern-ops`, `tavern-updater`, `nora-cardforge`)
in the gateway. Pending reload or failed recovery is not completion.
