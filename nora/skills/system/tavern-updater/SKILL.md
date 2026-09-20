---
name: tavern-updater
description: Check Nora Tavern versions, perform owner-authorized updates, and inspect update results on Windows, macOS and Linux.
version: 3.3.0
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
In PowerShell, prefix a quoted executable with `&`.

## Commands

Use the verified interpreter to run this skill's `scripts/update.py`:

- `--check`: check versions without applying updates.
- `--apply --confirm`: update only after the owner explicitly authorizes it.
- `--status`: inspect the last launcher task; on standalone installations,
  check the installed and published versions.

## Launcher-Managed Nora

Keep the matching launcher open. The script hands the task to it, so stopping
Nora does not stop the update worker. The launcher uses its existing download,
validation, update and service-restoration flow. If it is closed or too old,
explain the error and ask the owner to open or upgrade it. Do not bypass this
with a standalone installer or replace Hermes.

`queued` and `running` mean accepted or in progress, not successful. Tell the
owner before submission that Nora may briefly disconnect. After reconnection,
use `--status`. Report success only when the matching task reports `success`
and its update result has the expected version and `systemReady: true`.
A successful `check` task only means the version check completed. Report
`error` or `interrupted` before retrying; never silently resubmit an interrupted
update. A network error does not mean "up to date".

## Standalone Tavern

The same skill script runs the installed `bootstrap.py` using the verified
interpreter. That updater owns target resolution, release download, verification
and execution of the target updater. Do not manually assemble release archives,
invent an installation path, or call raw `update.py` with guessed flags.
This updates an existing installation; it does not install Hermes.

Report progress before starting, when a stage changes, and during long waits.
After an error, report it before further diagnosis; distinguish dependency
failure, startup failure and rollback. Preserve credentials, worlds and chats.
Confirm the installed version and service health, then report the actual result
and backup path. Downloaded files alone do not establish a successful update.
