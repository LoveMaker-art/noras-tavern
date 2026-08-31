---
name: tavern-ops
description: Diagnose and restore Tavern, MCP and Liveware services.
version: 1.25.1
author: ClawChat Tavern
license: AGPL-3.0-only
platforms: [linux, macos]
metadata:
  hermes:
    category: creative
    tags: [tavern, 运维, 诊断, mcp, liveware]
    revision: mcp-workflows-20260830
    requires_tools: [terminal]
---

# Tavern Operations Skill

Diagnose and restore the CURRENT installation. For daily world/chat/plugin/profile
actions use `tavern`; for changing application versions use `tavern-updater`.
An application bug report does not itself authorize a restart or source change.

## When to Use

Use for service outages, local/public connection failures, missing MCP tools,
logs and explicitly requested environment restoration. Specific world or plugin
operations remain in `tavern` unless evidence points to an environment failure.

## Prerequisites

Use Hermes `terminal`, `read_file` and `search_files` on the host owning the
installation. Resolve the active HERMES_HOME and existing lifecycle scripts.
Nora MCP is optional for this skill: connection diagnosis must work when it is
down. Liveware work additionally needs the installed `clawchat-liveware` skill
and its setup requirements; preserve the platform-managed skills/configuration.

## How to Run

Load with `skill_view(name="tavern-ops")` or `/tavern-ops <request>`. Inspect files
through `read_file`/`search_files`; invoke the maintained lifecycle through
`terminal`. For example, after resolving HERMES_HOME, the read-only command is
`sh "$HERMES_HOME/skills/creative/tavern/scripts/runtime.sh" status`.

## Quick Reference

| Need | Read before acting |
| --- | --- |
| Process, HTTP, MCP, log or public-delivery diagnosis | [diagnostics](references/diagnostics.md) |
| Authorized restart, setup, binding or configuration recovery | [service operations](references/service-operations.md) |

## Procedure

1. Identify the failing layer: product operation, local Tavern process, Hermes
   MCP connection, or public Liveware delivery. Inspect the smallest relevant
   evidence using [diagnostics](references/diagnostics.md). This skill must remain
   usable when Nora MCP is unavailable; use the existing host tools then.
2. State what the evidence establishes and what is still unknown. A live process
   is not proof that a particular card or public URL works.
3. For a requested repair, identify the precise instance and proposed change.
   Preserve worlds, chats, profile data, credentials, identity and other services.
   Back up affected configuration before an authorized configuration change.
4. For service start/restart or Liveware setup, read
   service operations above. Use maintained
   lifecycle/platform operations only for the approved effect. Do not turn
   diagnosis into provision, dependency installation or gateway restart.
5. Recheck the failed layer using the verification below.

## Pitfalls

Main-chat/Hermes model configuration is not the independent MVU model. For MVU
use `tavern`; for host model changes first establish a currently supported
configuration tool and exact scope. Existing source scripts are not a promise of
an available model-management command. Never output secrets or whole config files.

## Verification

Invoke the existing lifecycle `status` through `terminal` to verify process/run
identity, then check the layer that originally failed. Local health is not
evidence of public reachability, model correctness or a rendered card. Report
those as unverified unless actually tested; do not run a paid model test implicitly.
