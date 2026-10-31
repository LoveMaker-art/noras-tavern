# Hermes skill installation

A full core release directly replaces these shared official directories:

| Source | Target below HERMES_HOME |
| --- | --- |
| creative/tavern | skills/creative/tavern |
| creative/tavern-ops | skills/creative/tavern-ops |
| system/tavern-updater | skills/system/tavern-updater |
| creative/nora-cardforge | skills/creative/nora-cardforge |
| creative/nora-skill-library | skills/creative/nora-skill-library |
| system/model-provider-config | skills/system/model-provider-config |

These skills are delivered to cloud and local installations. Their availability
depends on the current instance and actual tools; they do not filter hosts by OS.
The instance resolver reads existing MCP/installation bindings and explicit
`nora_tavern` paths; no desktop application or fixed venv directory is required.

The release replaces the entire `AGENTS.md` with the project document, keeping
only the previous revision in `AGENTS.md.bak`. Existing extra rules are not merged.
Identical content is a no-op; a failed transaction restores both the document and
its previous backup. This whole-file ownership is limited to `AGENTS.md`.
The release installs Nora MCP configuration while
preserving all unrelated Hermes configuration, and retires the six historical
Tavern specialist skill directories after placing them in the release backup.

Every successful installation also refreshes the program-only daily release
checker in `$HERMES_HOME/scripts` and idempotently maintains one no-agent Hermes
cron job at 09:00 local time. It only sends a ClawChat notice when the configured official release sources have a
newer stable Tavern release; it never installs updates automatically.

`ops/scripts/install-hermes-skills.py` only prepares the canonical skill trees
inside the direct updater's private staging directory. It has no review/apply
mode and is not a standalone host mutation command.

After a successful full update, follow the updater's actual reload result. An
externally supervised cloud gateway remains owned by that supervisor; a model
selection normally applies to the next session. A successful save alone does
not establish that an existing conversation has reloaded its skills or context.
