---
name: tavern-world-visuals
description: Manage safe per-world Tavern themes and backgrounds.
version: 1.24.7
author: ClawChat Tavern
license: AGPL-3.0-only
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [tavern, world, visual-design, theme, 世界视觉, 主题]
    category: creative
---

# Tavern World Visuals

Use this skill for one world's background, palette, typography, reading surface,
title bar, and right-side panel. It must not change story data, prompts, cards,
worldbooks, controls, or shared navigation.

## Workflow

1. Load the shared contract and inspect the exact world.
2. Load `references/theme-schema.md` before writing theme JSON.
3. Import supplied images through the helper. Keep desktop and mobile artwork
   separate when their aspect ratios differ.
4. Validate the theme and background URL.
5. Apply only after confirmation, then inspect the saved result.

```sh
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
THEME="$HERMES_HOME/skills/creative/tavern-world-visuals/scripts/world_theme.py"
python3 "$THEME" inspect --world <world>
python3 "$THEME" import-background --world <world> --source <file-or-https-url> --target desktop --apply --confirm
python3 "$THEME" import-background --world <world> --source <file-or-https-url> --target mobile --apply --confirm
python3 "$THEME" validate --json /tmp/world-theme.json
python3 "$THEME" apply --world <world> --json /tmp/world-theme.json --confirm
python3 "$THEME" clear --world <world> --confirm
```

## Guardrails

- Store imported art under `$TAVERN_STATE_DIR/world-assets`, never runtime code.
- Use only supported theme fields. Do not store raw CSS, HTML, JavaScript, font
  URLs, data URLs, widgets, animations, or executable content.
- Keep the left world rail neutral and controls structurally unchanged.
- Use a readable local text surface instead of a full-stage mask.
- Clearing a theme must not delete story data or reusable source material.
