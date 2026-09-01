---
name: tavern-updater
description: Install a published Tavern release with one direct backup-and-replace command.
version: 3.0.0
author: Tavern Project
license: AGPL-3.0-only
platforms: [linux, macos]
metadata:
  hermes:
    category: system
    tags: [tavern, 更新, 发布, 回滚]
    revision: direct-update-20260901
    requires_tools: [terminal]
---

# Tavern Updater

Use this skill when the owner explicitly asks to run the Tavern update command.
The updater is a script; do not analyze, narrate or retry it through model calls.

## Execute

1. Reply only `开始更新。`
2. Run the exact owner-approved command once and wait for its exit.
3. Return one final summary containing installed version or the concrete error,
   backup path, recovery result and the `/restart` instruction when successful.
4. Never retry, diagnose, publish or edit files unless the owner separately asks.

The installed entrypoint is `scripts/update.py`. Normal user installation uses:

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh | sh -s -- --apply --confirm
```

## Contract

The direct updater performs one flow:

1. download and checksum the published archives;
2. prepare Node dependencies before downtime;
3. back up the current app, MCP, official skills, AGENTS, configuration and
   Python-era state when applicable;
4. stop the current Tavern without comparing it to a previously recorded PID;
5. replace Tavern, Story Profile, MCP, operations and official skills;
6. preserve native Worlds, chats, model configuration and Story Profile data,
   and configure the official Nora MCP in operator mode;
7. convert compatible Python data and archive incompatible records;
8. start Tavern and refresh the two existing Liveware bindings;
9. ask the owner to send `/restart` so Hermes reloads MCP and skills.

Archive checksums and safe extraction remain release integrity requirements.
If the new Tavern cannot actually start, the updater restores the backup.

Read [release compatibility](references/release-compatibility.md) only when
building or diagnosing a release, not for routine execution.
