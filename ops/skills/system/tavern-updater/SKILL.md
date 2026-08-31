---
name: tavern-updater
description: Review, upgrade and roll back verified Tavern releases.
version: 1.24.11
author: Tavern Project
license: AGPL-3.0-only
platforms: [linux, macos]
metadata:
  hermes:
    category: system
    tags: [tavern, 更新, 发布, 回滚]
    revision: mcp-workflows-20260830
    requires_tools: [terminal]
---

# Tavern Updater Skill

Handle version review, authorized upgrades and release rollback. For restoration
of the current running installation use `tavern-ops`. For daily product operations
use `tavern`. Checking a version does not authorize updating this skill or executing
a downloaded bootstrap.

## When to Use

Use for requested version checks, release review, upgrade or release rollback,
not for ordinary plugin toggles or restarting the current version.

## Prerequisites

Read [release compatibility](references/release-compatibility.md) before any
updater command. The installed legacy updater is not yet verified against the
current Node Tavern + independent Nora MCP release layout. Keep its code and
recovery records, but do not run apply/rollback on this installation merely
because those subcommands exist. Report the concrete mismatch as blocked.

Use the existing Hermes `read_file`, `search_files` and `terminal` tools and the
installed updater, not an invented MCP deployment tool. An owner-approved
release source and compatible artifacts are prerequisites to applying a version.

## How to Run

Load with `skill_view(name="tavern-updater")` or `/tavern-updater <request>`.
Inspect the installed updater and release metadata through `read_file` and
`search_files`. After compatibility is established, invoke supported updater
commands through `terminal`. Until then, perform inspection only; neither
`check` nor `review` is a harmless --help equivalent: both download artifacts.

## Quick Reference

| Request | Required result before proceeding |
| --- | --- |
| Check/review | Trusted source, distinct installed versions and compatible release format |
| Apply | Reviewed unchanged target plus explicit authorization and usable recovery |
| Roll back | Backup matching this installation and all affected components |

## Procedure

1. Identify the installed application, MCP and skill revisions separately;
   a skill frontmatter version is not evidence of the application's version.
2. Establish the owner-approved release source and verify the target manifest,
   artifacts, checksums and current/target format compatibility. If sources
   conflict or coverage is incomplete, stop before running release code.
3. With a compatible updater, use its existing review/report procedure. Summarize
   versions, affected components, conflicts, data preservation and recovery path.
   Review may download artifacts/create staging; disclose that if relevant.
4. Wait for explicit approval of the actual version-changing operation. Reuse
   only the reviewed, unchanged target and installation state.

5. For approved apply/rollback, follow the transaction and verification below.

## Pitfalls

Once compatibility and authorization are established, use the verified updater's
native transaction: targeted backup, installation, health/identity checks and
its defined recovery. A failed recovery must be reported, not called successful.
Rollback must match the actual installed version and backup scope; it cannot
restore only Tavern while leaving an incompatible MCP or older skill routing.

Preserve user data, identity, credentials, unrelated skills and host configuration.
No git pull, downloaded shell pipeline or generic filesystem replacement is a
fallback for an unsupported release format. Adapting the release machinery is
separate engineering work, not an implicit step of checking for updates.

## Verification

Read the installed updater's receipt and verify the actual application/MCP
versions, health, instance identity and three-skill loading after a compatible
transaction. A help command or successful download proves none of those effects.
When the compatibility gate fails, report that no update was applied and the
specific unmet check; do not claim this skill makes the old updater compatible.
