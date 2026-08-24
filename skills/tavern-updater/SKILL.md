---
name: tavern-updater
description: Review, install, and roll back verified Tavern releases.
version: 1.24.10
author: Tavern Project
license: AGPL-3.0-only
platforms: [linux, macos]
metadata:
  hermes:
    tags: [tavern, update, release, rollback, verification]
    category: system
    requires_tools: [terminal]
---

# Tavern Updater

Use this skill for Tavern release checks, code comparison, update review,
installation, and rollback. Do not improvise `git pull`, overwrite state, or run
release code from an unverified branch.

## Review

Every check, review, or update request must begin with the verified Bootstrap in
review mode:

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh | sh
```

Bootstrap refreshes only the updater, verifies the latest stable Release, and
uses that Release's own rules to produce `check`, `review`, and `report`. It does
not install Tavern runtime, frontend, creative or system skills, `AGENTS.md`, or user data
during review.

Summarize only the installed and target releases, category counts, validation,
preserved data, and real conflicts. Keep per-file details out of model context
unless a real conflict requires diagnosis. Then stop and wait for a new explicit
user approval. The original request to inspect or update does not authorize apply.

## Apply And Rollback

After approval, apply only the reported, unchanged plan:

```sh
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
UPDATER="$HERMES_HOME/skills/system/tavern-updater/scripts/update.py"
python3 "$UPDATER" apply --plan <PLAN_ID> --confirm
```

Rollback uses:

```sh
python3 "$UPDATER" rollback --confirm
```

If the user directly runs the documented Bootstrap command with both `--apply`
and `--confirm`, that command authorizes one verified review-and-apply
transaction. Conflicts still stop the update, and failed validation, restart,
health, or skill-registration checks still trigger automatic rollback.

## Managed Scope

- Trust only a stable GitHub Release and its verified manifests and archives.
- Use the target Release's declared runtime, frontend, official-skill, updater,
  and `AGENTS.md` file sets. Do not maintain a second file list in prose.
- Replace official creative and system skill directories exactly after backup;
  never merge local files into them or replace either skill root.
- Preserve custom skills and every path outside the release-managed scope.
- Back up and replace release-managed runtime, frontend, updater, official
  skills, and `AGENTS.md` exactly. Do not merge instance patches into official
  code; customization belongs in protected state, configuration, or custom
  skill directories.
- Preserve `$TAVERN_STATE_DIR`, `$HERMES_HOME/config.yaml`, identity and
  persona files, assets, credentials, sessions, logs, ClawChat databases, and
  every unowned path.
- Before replacing a legacy runtime, compare its starter catalog with a
  hash-verified historical Release when available. Move local starter additions,
  edits, assets, and deletions into `$TAVERN_STATE_DIR/starter`; if no baseline
  exists, preserve the entire installed starter catalog there.
- Load the official starter catalog and protected user overlay together at
  runtime. Official updates therefore cannot overwrite user starter content.
- Validate managed Python, Shell, and JavaScript before installation, then
  verify skill registration, process health, identity, model, console, and
  story-profile surfaces before committing the transaction.
- Restrict automatic state migration to the legacy starter extraction above;
  it is previewed in the review plan, backed up, atomic, and rolled back with
  the rest of the transaction. Never rewrite worlds, characters, stories, or
  model configuration during an update.
- Serialize review, report, apply, and rollback with the updater lock.

Load `references/release-format.md` only for release-format or manifest work.
