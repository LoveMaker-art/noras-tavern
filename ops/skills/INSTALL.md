# Hermes skill installation

A full release directly replaces these four official directories:

| Source | Target below HERMES_HOME |
| --- | --- |
| creative/tavern | skills/creative/tavern |
| creative/tavern-ops | skills/creative/tavern-ops |
| system/tavern-updater | skills/system/tavern-updater |
| creative/nora-cardforge | skills/creative/nora-cardforge |

The release also replaces the managed Tavern block in `AGENTS.md`, installs Nora MCP configuration while
preserving all unrelated Hermes configuration, and retires the six historical
Tavern specialist skill directories after placing them in the release backup.

`ops/scripts/install-hermes-skills.py` only prepares the canonical skill trees
inside the direct updater's private staging directory. It has no review/apply
mode and is not a standalone host mutation command.

After a successful full update, the owner sends `/restart` in ClawChat so the
gateway reloads the new skills, MCP process, and AGENTS context.
