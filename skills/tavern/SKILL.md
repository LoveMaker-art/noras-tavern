---
name: tavern
description: Route broad Tavern requests to one specialist workflow.
version: 1.24.5
author: ClawChat Tavern
license: AGPL-3.0-only
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [tavern, 酒馆, routing]
    category: creative
---

# Tavern Router

Use this router only when the request is ambiguous, broad, or crosses Tavern
domains. For a specific request, load the specialist directly.

## Route By Outcome

| Outcome | Skill |
| --- | --- |
| Find, import, create, localize, expand, or repair worlds, cards, worldbooks, Persona, or openings | `tavern-world` |
| Apply or remove a per-world background or visual theme | `tavern-world-visuals` |
| Recall stories or maintain durable story preferences | `tavern-story-profile` |
| Diagnose generation, compression, story ledger, runtime cast, or continuity | `tavern-continuity` |
| Configure models, health, restart, registration, naming, or localization | `tavern-ops` |
| Review, install, or roll back frontend/backend releases | `tavern-updater` |

## Routing Rules

1. Choose the primary user outcome.
2. Load exactly one specialist with `skill_view`.
3. Load another specialist only when a second ownership boundary is genuinely required.
4. Let the selected specialist choose references and commands.
5. Before any write, follow `references/shared-contract.md`.

Use the shared CLI at:

```sh
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
CLI="$HERMES_HOME/skills/creative/tavern/scripts/tavern_cli.py"
python3 "$CLI" <command>
```

When routing or availability is uncertain, run:

```sh
python3 "$CLI" doctor --json
```

Do not load every Tavern skill, duplicate specialist procedures here, or use a
creative skill to update application code.
