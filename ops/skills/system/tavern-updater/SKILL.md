---
name: tavern-updater
description: Review, upgrade, activate and roll back Tavern releases.
version: 2.1.0-rc.1
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

Read [release compatibility](references/release-compatibility.md) to resolve the
installed layout, trusted source, first updater adoption and activation steps.
Use Hermes' Python environment, Node 20+ and npm. Preserve the existing MCP
permission mode and tool allowlist.
For explicitly authorized isolated migration rehearsals, first read
[isolated clean transactions](references/isolated-rehearsal.md). Rehearsals use the
same transaction on a marked temporary home and separate port. Conversion is
Python productions → Node Worlds; existing Node data is validated, not migrated.

## How to Run

Use Hermes `terminal` and this skill's `scripts/update.py`. Inspect its `--help`.
For first adoption, use the verified Bootstrap described in release compatibility.
It refreshes only the updater before review; app/data/AGENTS remain unchanged.
A GitHub branch is source, not a release asset. A tag without the full bundle and
Bootstrap assets is not an available upgrade.

## Quick Reference

| Operation | Required evidence |
| --- | --- |
| `fetch` | Explicit approved tag; downloads only from the project GitHub release |
| `review` | Pinned manifest SHA-256; returns transaction and plan digest; live files unchanged |
| `apply` | Owner approval, same transaction and expected plan digest, `--confirm` |
| `rollback` | Matching transaction, original plan digest, owner approval and `--confirm` |

## Procedure

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
5. Read [owner activation](references/activation.md), then request activation in
   the owner's ClawChat conversation. The loaded gateway bridge sends the consent
   prompt and handles the owner's next “确定”; the agent cannot confirm it.
   First bridge installation or a changed bridge implementation requires owner
   gateway activation once. Report that prerequisite instead of claiming success.

## Pitfalls

Review leaves active files unchanged (Bootstrap separately refreshes the updater).
Apply prepares dependencies, verifies/stops the owned process, copies and converts
state, then switches reviewed code/state trees and host files. Durable intent
precedes every rename. Failure recovery restores original trees and the prior
running/offline condition; inspect any recovery error.

Preflight budgets complete state/code copies plus estimated dependency space and
requires one filesystem for directory switching. Unknown code leaves active paths
but remains in recovery; custom plugin locations are explicit overlays. Later
rollback refuses newer conversations/edits rather than erasing them. External
writers must honor the maintenance window.

Worlds, chats, keys, custom skills and instructions outside the managed AGENTS
block are preserved. USER.md/MEMORY.md participate in recovery. The updater does
not re-register Liveware, replace the whole Hermes home or restore executable
card scripts discarded by the Python importer. Recovery contains private
configuration: keep it on the host outside skills discovery.

## Verification

Require the receipt, matching installed hashes, new Tavern process health,
Story Profile route and fresh read-only MCP discovery. Then verify Hermes' reloaded
MCP and four unique skills (`tavern`, `tavern-ops`, `tavern-updater`, `nora-cardforge`)
in the gateway. Pending reload or failed recovery is not completion.
