---
name: tavern-story-profile
description: Recall stories and maintain durable Tavern preferences.
version: 1.24.6
author: ClawChat Tavern
license: AGPL-3.0-only
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [tavern, memory, reflection, preference, 故事档案, 偏好]
    category: creative
---

# Tavern Story Profile

## Scope

Use this skill when the user refers to a previous world, asks what the curator
remembers, gives a durable play preference, requests reflection, or asks why a
recommendation fits their taste.

Do not store one-off plot facts, current role state, bugs, tool activity, or
formatting corrections as user preference.

## Workflow

1. `recall --json` before discussing a named world's events.
2. `learn --json` only for an explicit durable preference.
3. Use `reflect-preview` when evidence is uncertain; run `reflect` only when the
   result is reusable preference rather than plot summary.
4. Use `card --json` or `profile-audit --json` for memory or recommendation questions.
5. Use `profile_memory.py` for projection audit, preview, refresh, confirmation,
   editing, or locking. Never append Tavern text directly to `USER.md` or `MEMORY.md`.

## Commands

```sh
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
CLI="$HERMES_HOME/skills/creative/tavern/scripts/tavern_cli.py"
PROFILE="$HERMES_HOME/skills/creative/tavern-story-profile/scripts/profile_memory.py"
python3 "$CLI" recall <world> --last <N> --json
python3 "$CLI" learn "preference" --reason "evidence" --json
python3 "$CLI" reflect-preview <world>
python3 "$CLI" reflect <world>
python3 "$CLI" card --json
python3 "$CLI" profile-audit --json
python3 "$PROFILE" audit
python3 "$PROFILE" memory-preview
python3 "$PROFILE" memory-sync
python3 "$PROFILE" refresh
python3 "$PROFILE" confirm <preference-id>
python3 "$PROFILE" reject <preference-id>
python3 "$PROFILE" edit <preference-id> "new text" [--scope tavern|agent_chat|both]
python3 "$PROFILE" lock <preference-id> [--off]
```

Load `references/actor-memory.md` for storage and projection boundaries. Load
the shared contract before any write.

## Guardrails

- `story_profile.json` is canonical; `actor_self.md` is only a compatibility view.
- `USER.md` receives bounded taste and response adaptations.
- `MEMORY.md` receives bounded, explicitly fictional story memories.
- Preserve content outside managed marker blocks.
- Story preferences may shape recommendations and tone, but are not evidence of
  the user's real-life personality.
