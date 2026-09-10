---
name: tavern-updater
description: Check Nora Tavern release versions and route authorized updates to the correct installer.
version: 3.2.0
author: Tavern Project
license: AGPL-3.0-only
platforms: [linux, macos, windows]
metadata:
  hermes:
    category: system
    requires_tools: [terminal]
---

# Tavern Updater

Use when the owner asks to check or update the installed version.

## Launcher-Managed Nora

First check whether HERMES_HOME contains `nora-instance.json`. For this complete
Nora installation, use its isolated Hermes Python to run
`scripts/nora-tavern-update-check.py --check-only`. Use absolute paths.

On macOS the interpreter is `hermes-agent/venv/bin/python3`; on Windows it is
`hermes-agent/venv/Scripts/python.exe`, both under HERMES_HOME.

Report current and latest versions, or the concrete check failure. A network
error does not mean "up to date". Checking never installs or changes user data.

For installation, direct the owner to the Nora launcher's version check and its
release entry. Do not run the legacy Tavern updater, curl installers, pip/uv
upgrades, or replace Hermes in this managed installation. A Tavern-only update
cannot establish that Nora's runtime, skills, hooks and configuration are complete.
Do not claim an update is installed until the launcher's installed version and
readiness checks confirm it.

## Legacy Standalone Tavern

If no Nora instance file exists, inspect the installed version and host platform
before using `scripts/update.py`. Execute only an explicitly authorized update.
The legacy installer is not a Windows or full-Nora installer. Preserve credentials,
worlds and chats; report the actual result and backup path, never infer success
from downloaded files.
