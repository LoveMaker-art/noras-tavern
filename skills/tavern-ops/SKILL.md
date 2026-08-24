---
name: tavern-ops
description: Configure and operate Tavern models, services, and Liveware.
version: 1.24.10
author: ClawChat Tavern
license: AGPL-3.0-only
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [tavern, liveware, model, health, i18n, operations]
    category: creative
---

# Tavern Operations

Use this skill for model configuration, runtime health, maintained restart,
provisioning, Liveware registration, naming, and localization checks. Use
`tavern-updater` for frontend/backend release changes.

## Workflow

1. Run `doctor --json` and inspect the current configuration.
2. For model changes, test the candidate before selecting or reporting success.
3. Use maintained scripts for provisioning and restart; do not reconstruct
   environment variables or kill processes manually.
4. Verify local health and the requested public behavior.

## Commands

```sh
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
CLI="$HERMES_HOME/skills/creative/tavern/scripts/tavern_cli.py"
RUNTIME="$HERMES_HOME/skills/creative/tavern/scripts/runtime.sh"
python3 "$CLI" doctor --json
python3 "$CLI" model list --json
python3 "$CLI" model test [name] --json
python3 "$CLI" model add <name> --base <url> --model <id> --key <key> --json
python3 "$CLI" model use <name> --json
python3 "$CLI" model rm <name> --json
sh "$RUNTIME" status
sh "$RUNTIME" restart
sh "$HERMES_HOME/skills/creative/tavern/scripts/provision.sh"
sh "$HERMES_HOME/skills/creative/tavern/scripts/bringup.sh"
```

Use `runtime.sh` for ordinary Hermes or standalone operation. Use
`provision.sh` and `bringup.sh` only when the ClawChat plugin and Liveware are
installed.

Load only the needed reference:

- `references/model-config.md`
- `references/liveware-ops.md`
- `references/i18n.md`

Load the shared contract before a state-changing operation.

## Guardrails

- Never display a full model or TTS key.
- Never hardcode agent names, app IDs, domains, or currently available models.
- Do not confuse frontend selection with server-side credentials.
- Do not restart the Hermes gateway for an app-only failure without evidence.
- Do not overwrite release-managed application code from this skill.

## Done When

Health is `ok`, the intended model test passes, process/registration state is
stable, and localization or naming is verified in the affected locale.
