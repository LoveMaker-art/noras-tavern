---
name: tavern-updater
description: Review, upgrade and roll back verified Tavern releases.
version: 2.1.0-rc.1
author: Tavern Project
license: AGPL-3.0-only
platforms: [linux, macos]
metadata:
  hermes:
    category: system
    tags: [tavern, 更新, 发布, 回滚]
    revision: python-to-node-rehearsal-20260831
    requires_tools: [terminal]
---

# Tavern Updater

Update Node Tavern as one reviewed release: Tavern (including Story Profile),
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
[isolated clean transactions](references/isolated-rehearsal.md). This experimental
path cannot target the live installation and is not the default update mode.
Its conversion is Python productions → Node Worlds, not Node-version migration.

## How to Run

Use Hermes `terminal` and this skill's `scripts/update.py`. Inspect its `--help`.
An old Python-era updater is not this implementation; use the reviewed repository's
`ops/updater/update.py` once to adopt it. A GitHub branch is source, not a published
release asset. If a tag has no full bundle, report that missing input.

## Quick Reference

| Operation | Required evidence |
| --- | --- |
| `fetch` | Explicit approved tag; downloads only from the project GitHub release |
| `review` | Pinned manifest SHA-256; returns transaction and plan digest; live files unchanged |
| `apply` | Owner approval, same transaction and expected plan digest, `--confirm` |
| `rollback` | Matching transaction, original plan digest, owner approval and `--confirm` |

## Procedure

1. Resolve the exact Hermes home and app/MCP versions. The engine schema-2 marker
   does not prove user-data compatibility. The updater checks for Python data,
   World v1 remnants and unknown World schemas; stop on these findings and report
   the required migration/reconciliation. These guards do not perform migration.
2. Fetch the approved tag or use a verified local bundle. Run `review` with its
   directory and manifest SHA-256. Candidate bundles require explicit test
   authorization and `--allow-candidate`; never present them as stable releases.
3. Summarize versions, changed files, downtime, preserved data and recovery path.
   Pause chats before authorized apply. Reuse the returned transaction and digest;
   if preconditions changed, review again instead of overwriting new local work.
4. Read the receipt. `installed-awaiting-hermes-reload` means installed files and
   a fresh MCP probe passed, not that the gateway switched its existing MCP process.
5. Have the owner run Hermes `/reload-mcp`, including its confirmation. Verify
   tools through the actual gateway. Use a fresh session for changed skills and
   AGENTS context; preserve history. Report these activation checks separately.

## Pitfalls

Review creates private staging but leaves active files unchanged. Apply prepares
npm dependencies before stopping Tavern, backs up managed files, then installs
and checks health. Failures restore the prior release; inspect any recovery error.
Concurrent modifications block rollback instead of overwriting them.

The preflight reserves space for managed-file backups/replacements and an
estimated 1 GiB for dependency preparation. It checks again before stopping the
service. This is not a guarantee against disk exhaustion or a full data backup.
The default file updater retains unknown old code and has no complete user-state rollback;
do not use it as a clean-install or universal old-data migration tool.

Worlds, chats, keys, custom skills and instructions outside the managed AGENTS
block are preserved. The updater does not re-register Liveware, replace the whole
Hermes home or migrate Python data in default mode. The isolated Python converter
does not enable production migration. Recovery contains private configuration: keep
it on the host outside skills discovery.

## Verification

Require the receipt, matching installed hashes, new Tavern process health,
Story Profile route and fresh read-only MCP discovery. Then verify Hermes' reloaded
MCP and four unique skills (`tavern`, `tavern-ops`, `tavern-updater`, `nora-cardforge`)
in the gateway. Pending reload or failed recovery is not completion.
