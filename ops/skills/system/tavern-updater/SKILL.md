---
name: tavern-updater
description: Install a published Tavern release with one direct backup-and-replace command.
version: 3.1.0
author: Tavern Project
license: AGPL-3.0-only
platforms: [linux, macos]
metadata:
  hermes:
    category: system
    tags: [tavern, 更新, 发布, 回滚]
    revision: incremental-update-20260904
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

The direct updater exposes one command and selects the delivery path itself:

1. download and checksum release metadata;
2. use full archives for Python-era installs, or download only changed modules
   for an existing native 2.x install;
3. reuse Node dependencies when their lock files are unchanged, otherwise
   prepare them before downtime;
4. back up the current app, MCP, official skills, AGENTS, configuration and
   Python-era state when applicable;
5. stop Tavern only when its runtime or migrated state will change;
6. replace only changed managed roots and official skills;
7. preserve native Worlds, chats, model configuration and Story Profile data,
   and configure the official Nora MCP in operator mode;
8. convert compatible Python data and archive incompatible records;
9. restart Tavern and refresh Liveware only when its application changed;
10. ask the owner to send `/restart` only when MCP, skills, AGENTS or Hermes
    configuration changed.

Archive checksums and safe extraction remain release integrity requirements.
If the new Tavern cannot actually start, the updater restores the backup.

Read [release compatibility](references/release-compatibility.md) only when
building or diagnosing a release, not for routine execution.
