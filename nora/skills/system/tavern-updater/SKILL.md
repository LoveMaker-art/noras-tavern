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

## Resolve the execution environment

Resolve the active HERMES_HOME and this skill's absolute directory first.
Run `scripts/update.py --check-environment` from this skill with an available
Python interpreter. This read-only probe uses only the standard library to
discover and validate Hermes Python. Read its JSON `python`, `hermesHome` and
`managed` fields. On Windows use the launcher's isolated Python to run the probe.
If discovery fails, report the checked paths and missing module and stop.

Use the returned absolute Python path, quoted as one argument, for every later
Python command, including background jobs. Do not resolve its virtualenv symlink.
Foreground and background PATH may differ; never substitute bare `python3` after
the probe. Do not install packages into system Python to bypass a failed check.
No cloud-machine absolute path belongs in a portable command template.

## Launcher-Managed Nora

If `managed` is true, use the verified interpreter to run
`<HERMES_HOME>/scripts/nora-tavern-update-check.py --check-only`.
The managed interpreter is under HERMES_HOME: `hermes-agent/venv/bin/python3`
on macOS, or `hermes-agent/venv/Scripts/python.exe` on Windows.

Report current and latest versions, or the concrete check failure. A network
error does not mean "up to date". Checking never installs or changes user data.
For installation, direct the owner to the Nora launcher's version check and its
release entry. Do not run the standalone updater, curl installers, pip/uv
upgrades, or replace Hermes in this managed installation. Do not claim success
until the launcher's installed version and readiness checks confirm it.

## Standalone Tavern

If `managed` is false, inspect the installed version and host platform.
Use the verified interpreter with
`<HERMES_HOME>/apps/tavern-ops/scripts/nora-tavern-update-check.py --check-only`.
For an explicitly authorized update on a supported standalone host, use that
same interpreter with
`<HERMES_HOME>/apps/tavern-ops/updater/bootstrap.py --hermes-home <HERMES_HOME> --apply --confirm`.
Replace placeholders with discovered absolute paths; quote each path separately.
The existing bootstrap owns target resolution, release download, verification
and execution of the target updater using the same interpreter. Do not manually
assemble release archives or call the installed update.py with guessed flags.
This is not a Windows or full-Nora installer.

Report progress before starting, when a stage changes, and during long waits.
After an error, report it before further diagnosis; distinguish dependency
failure, startup failure and rollback. Preserve credentials, worlds and chats.
Confirm the installed version and service health, then report the actual result
and backup path. Downloaded files alone do not establish a successful update.
