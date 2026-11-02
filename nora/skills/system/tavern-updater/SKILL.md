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

- `--check`: check core versions without querying or opening the APP, or applying updates.
- `--apply --confirm`: submit a core update only after the owner explicitly authorizes it in this Nora conversation.
- `--status`: read the last independent task and its canonical operation result.

## Keep core and APP updates separate

On desktop and cloud/source installations, `--check` uses the independent core
entry and returns the version result directly. It does not inspect APP capability,
query APP updates, submit an update or change an existing request. Report that
result without polling `--status`; status reads an update task, not a version check.

An owner-authorized `--apply --confirm` submits only the Nora/Tavern core to the
existing independent task. It never submits to the desktop receiver, opens the
APP, replaces it or adds an APP update. Missing, closed, damaged or old APPs do
not remove core update eligibility. Verify the actual core instance, interpreter,
resources, dependencies and competing writers. A concrete compatibility problem
must identify its affected capability; do not make an APP version a blanket core
admission condition or silently update another component.

APP updates belong to the launcher's own update action. If the user asks Nora
to update the APP, explain that entry rather than submitting or opening it.
Report core and APP results separately; core success never means the APP updated.

`--status` prefers the independent core task, including failures, recovery and
unconfirmed states. Only when a trusted core reader confirms there is no core
task may it return a historical desktop result. That fallback is read-only:
report its scope, actual versions and original failure; never resume its old
two-component plan or interpret it as a newly submitted core task. A new core
attempt requires explicit owner authorization; an APP attempt uses its own entry.

Run one literal `--status` command per terminal call. If it is still running,
wait briefly and make another status call; stop as soon as `settled: true` is
returned. Do not generate shell polling loops, inline Python/Node parsers,
encoded commands or a fixed series of polls that continues after completion.
The skill already returns structured state. A terminal security rejection is
not an updater failure: report it and use the plain supported command without
changing security settings or bypassing the guard.

## Independent core updater

Nora submits the core update to the existing independent updater.
An installed, open, online or recent desktop APP is not a prerequisite for a
Nora/Tavern component update. An instance marker binds directories and the port;
it does not transfer execution authority to a GUI session.

The task snapshots the verified updater closure, acquires the same native writer
lock and uses the existing update transaction and recovery records. A detached
owner continues after Nora disconnects or the caller closes. It preserves chats,
characters, worlds, model configuration and credentials. It does not upgrade the
external Hermes runtime. APP replacement remains a separate task initiated in
the launcher, using its established helper and recovery rules. Both tasks still
respect the same installation writer lock and actual unfinished program effects.

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
