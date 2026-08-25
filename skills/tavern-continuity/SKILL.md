---
name: tavern-continuity
description: Diagnose Tavern generation, memory, and continuity problems.
version: 1.24.11
author: ClawChat Tavern
license: AGPL-3.0-only
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [tavern, continuity, ledger, compression, diagnostics, 连续性]
    category: creative
---

# Tavern Continuity

## Scope

Use this skill to diagnose generation failures, slow or empty replies, context
compression, story-ledger errors, stale runtime cast, role confusion, and
continuity drift.

- `story_state` owns confirmed plot facts, timeline, objects, secrets, and open threads.
- `runtime_cast` owns world-local effective character/user profiles and relationships.
- Runtime output protocol owns language and formatting.

Reusable card edits and lore design belong to `tavern-world`; model and process
health belong to `tavern-ops`.

## Workflow

1. Read the target world and latest messages before proposing a cause.
2. Run `diagnose --json`; use `recall --json` and `lore-audit --json` only when
   their evidence is relevant.
3. Identify the failing owner and distinguish symptom, cause, and impact.
4. Prefer the smallest supported fix. For ledger or cast repair, generate a
   plan first and show it to the user.
5. Apply only after explicit confirmation, then diagnose again.

## Commands

```sh
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
CLI="$HERMES_HOME/skills/creative/tavern/scripts/tavern_cli.py"
REPAIR="$HERMES_HOME/skills/creative/tavern-continuity/scripts/tavern_repair.py"
python3 "$CLI" diagnose <world> --json
python3 "$CLI" recall <world> --last 12 --json
python3 "$CLI" lore-audit <world> --json
python3 "$REPAIR" story-fix <world> "correction" --plan
python3 "$REPAIR" cast-fix <world> "correction" --plan
python3 "$REPAIR" story-fix <world> "correction" --apply --confirm
python3 "$REPAIR" cast-fix <world> "correction" --apply --confirm
```

Load `references/diagnostics.md` for runtime evidence and
`references/state-repair.md` before a write. Also load the shared contract.

## Guardrails

- Never rewrite story messages as a state repair.
- Never edit `origin_profile` or reusable library cards here.
- Never place preferences, formatting rules, or hidden corrective prompts into
  `story_state` or `runtime_cast`.
- Never apply an ambiguous or low-confidence repair.
