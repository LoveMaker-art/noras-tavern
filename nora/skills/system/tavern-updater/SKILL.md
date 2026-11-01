---
name: tavern-updater
description: Check Nora Tavern versions, perform owner-authorized updates, and inspect update results on Windows, macOS and Linux.
version: 3.5.0
author: Tavern Project
license: AGPL-3.0-only
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
Python interpreter. The discovery caller can use the standard library; the
selected candidate must load Hermes and YAML and verify its own program/home
binding. Read its JSON `python`, `hermesHome` and `managed` fields. An explicitly
known interpreter can be supplied through `NORA_PYTHON`; it is still verified.
On desktop installations the launcher's isolated Python is one possible source,
not a requirement for Windows or any other host.
If discovery fails, report the checked paths and missing module and stop.

Use the returned absolute Python path, quoted as one argument, for every later
Python command, including background jobs. Do not resolve its virtualenv symlink.
Foreground and background PATH may differ; never substitute bare `python3` after
the probe. Do not install packages into system Python to bypass a failed check.
No cloud-machine absolute path belongs in a portable command template.
In PowerShell, prefix a quoted executable with `&`.

## Commands

Use the verified interpreter to run this skill's `scripts/update.py`:

- `--check`: check versions without opening the launcher or applying updates.
- `--apply --confirm`: update only after the owner explicitly authorizes it.
- `--status`: read the last independent task and its canonical operation result.

## Submit and verify the applicable components

For a desktop installation with a verified APP, `--check` reads version metadata
in the background and returns the check result directly. It leaves existing
update requests unchanged. Once that check is settled, report its result;
`--status` reads the last update task, not a continuation of this version check.

One owner-authorized `--apply --confirm` uses the existing desktop receiver to
submit all applicable Tavern and launcher updates. Only then may it open the verified launcher and
restart it during replacement. It selects a compatible order and updates only
components with a newer applicable version. A cloud/source instance without an
APP retains the independent core updater below.

An update's initial response may be `queued`, `running` or `restarting`. Say the request
was submitted, then use `--status`; do not claim completion from submission or
an APP restart. Desktop `succeeded` requires verified `updateComplete`, actual
core and launcher versions and the associated canonical operations. When APP
discovery fails but a verified core target is compatible with the current APP,
the core update can continue. `status: partial`, `coreUpdateComplete: true` and
`updateComplete: false` mean Tavern updated while the launcher check failed;
report the actual versions and `launcherError` separately. This is settled,
not a pending task or full desktop success. Recheck before a new authorized
update; a successful core is not updated again just to retry APP discovery.
A failure inside a two-component sequence retains the successful component
and fixed sequence; an explicit retry continues that sequence.
Old APPs or readers without this protocol require
initial migration: use the original update button if it works; otherwise use a
verified data-preserving installer or repair path for that historical version.
Keep chats, characters, worlds, configuration and credentials. A missing Windows
terminal dependency requires the corresponding complete runtime; replacing only
the APP does not add it. Report the verified support boundary, never a universal
old-version guarantee or a core-only result as a complete desktop update.

Run one literal `--status` command per terminal call. If it is still running,
wait briefly and make another status call; stop as soon as `settled: true` is
returned. Do not generate shell polling loops, inline Python/Node parsers,
encoded commands or a fixed series of polls that continues after completion.
The skill already returns structured state. A terminal security rejection is
not an updater failure: report it and use the plain supported command without
changing security settings or bypassing the guard.

## Independent core updater

Nora and the desktop update button submit to the same independent updater.
An installed, open, online or recent desktop APP is not a prerequisite for a
Nora/Tavern component update. An instance marker binds directories and the port;
it does not transfer execution authority to a GUI session.

The task snapshots the verified updater closure, acquires the same native writer
lock and uses the existing update transaction and recovery records. A detached
owner continues after Nora disconnects or the caller closes. It preserves chats,
characters, worlds, model configuration and credentials. It does not upgrade the
external Hermes runtime. APP replacement belongs to the desktop path above,
using the established APP helper and recovery rules.

Before submission tell the owner that Nora may briefly disconnect. Submission
returning exit code zero means the request was handed off, not that the update
succeeded. Read the returned requestId/operationId. After reconnection run
`--status`; report success only for `status: succeeded` with a matching canonical
operation result, the expected version and `systemReady: true`.
`selecting`, `downloading`, `prepared`, `applying`, `verifying` and `recovering`
are in progress. `rolled-back` means the original program was restored, not
that the requested upgrade succeeded. Report the original failure and recovery
result. Never silently resubmit an interrupted task, delete task history or
call raw installers to bypass admission. A network error does not mean up to date.

An older installed entry cannot obtain new logic until updated. If it fails
before obtaining the independent runner, read the historical-entry procedure in
`references/release-compatibility.md`. Use the official current standalone entry
with verified original paths; do not install a desktop APP as a workaround.
Fresh entry code checks installation ownership and downloads a hash-verified
runner before transferring to the same independent task. Source-only changes
have not changed the public download until released.

Report progress before starting, when a stage changes, and during long waits.
After an error, report it before further diagnosis; distinguish dependency
failure, startup failure and rollback. Preserve credentials, worlds and chats.
Confirm the installed version and service health, then report the actual result
and backup path. Downloaded files alone do not establish a successful update.
