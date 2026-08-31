# Hermes skill installation

This is the canonical source of three skills, not a directory to unpack beneath
an already installed `tavern` skill. Hermes recursively discovers `SKILL.md`;
hidden backup directories and nested specialists can create ambiguous names.

| Source | Target under the resolved HERMES_HOME |
| --- | --- |
| creative/tavern | skills/creative/tavern |
| creative/tavern-ops | skills/creative/tavern-ops |
| system/tavern-updater | skills/system/tavern-updater |
| agents-tavern.md | managed Tavern block in AGENTS.md |
| ../scripts/profile_memory.py | skills/creative/tavern/scripts/profile_memory.py |

The existing Tavern/MCP application, updater implementation, platform/custom
skills and user data stay in place. The offline profile maintenance helper is
relocated to one canonical script; daily agent operations still use MCP. This
does not install a fresh application. Old updater compatibility remains gated
in its skill.

## Inspect, then explicitly apply

On the target host, stage `ops/skills` and `ops/scripts/profile_memory.py` with
their sibling layout outside every active skill discovery root.
Resolve HERMES_HOME and the gateway's **logical** working directory first; do not
infer AGENTS lookup from the process cwd. On the inspected installation those
are both `/opt/data`; its cwd-only AGENTS behavior differs from current web docs.
If a higher-priority context file overrides AGENTS, stop and resolve that with
the owner rather than installing an unread file or overwriting that context.

Through the host's terminal, run the installer from the source checkout:

```sh
python3 ops/scripts/install-hermes-skills.py --hermes-home /opt/data
```

This is a read-only plan with paths and a digest. After authorization of those
changes, use the same command with `--apply --expected-plan <returned-digest>`.
Re-plan if any source or target has changed. A custom AGENTS location can be
selected with `--agents-path`, after confirming the installed loader reads it.

The installer replaces only its explicit instruction files and recognized
legacy Tavern sections. It retires the six old specialist entry points, the
nested Story Profile entry and known `.tavern-pre-*` duplicate entries. The two
old `profile_memory.py` copies under the retired Story Profile skill directories
are removed only when byte-identical to the canonical helper; a customized copy
stops the migration. Other runtime scripts are preserved; only the exact obsolete
specialist-copy block is removed from the installed `provision.sh`. Unknown
duplicate names, symlinks and modified/unrecognized legacy AGENTS sections also
stop the migration.

Each actual change is backed up below `HERMES_HOME/tavern-skill-backups` as
non-discoverable `.bak` files with a manifest. On an apply error the installer
restores prior file contents; it does not restart a service. Reapplying an
unchanged installation is a no-op. Do not replace whole skill folders.

## Verify the installed host, not just Markdown

1. Use the installed Hermes frontmatter validator on the three main documents.
2. Check `skills_list` and `skill_view`: each of the three names resolves once,
   old entry names are absent, and each referenced file loads successfully.
3. Inspect context loading at the resolved gateway cwd: the Tavern managed block
   must appear and unrelated instructions must remain. Do not dump identity or
   secret-bearing context into the report.
4. Check the existing Tavern service and MCP identity without model calls.

File discovery does not refresh a cached system prompt in an ongoing agent
session. Validate routing in a fresh owner-authorized session; do not clear chat
history or restart the gateway to force it. `/reload-mcp` is not an AGENTS reload.
A successful document load is technical validation, not an end-to-end guarantee
that a model will follow every workflow. Record that remaining validation level.
