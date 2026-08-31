# Release compatibility before execution

The existing `scripts/update.py` is a retained legacy implementation, not a
guarantee that this Node-era installation can use its apply/rollback commands.
Inspect it without invoking commands that download, stage, stop or replace files.

At the 2026-08-30 skill migration, the concrete mismatches were:

- The updater expected manifest.json + tavern-release.tar.gz and
  skill-manifest.json + tavern-skill.tar.gz. The current repository packager
  produces release-manifest.json + nora-tavern-app.tar.gz + nora-tavern-ops.tar.gz.
- Its target set did not include the independently installed nora-mcp package.
- Its old official-skill set and AGENTS template described retired specialist
  workflows. Applying them would undo the three-skill routing.
- Previous instructions disagreed on the GitHub repository. A legacy default
  is not owner confirmation of the right channel.
- Its local_version fallback reads tavern/SKILL.md when the runtime marker is
  missing. Keep that skill version separate from evidence about application code.

These are observable compatibility checks, not a permanent ban on updates.
Before lifting the gate, establish all of the following from the actual target:

1. Owner-approved source and a verified manifest/artifact format accepted by
   the installed updater; file hashes alone do not establish a trusted source.
2. Coherent Tavern/MCP versions and a recovery plan covering both when required.
3. The current three-skill installation map, with no retired duplicate SKILL.md
   files, and an AGENTS update preserving unrelated owner instructions.
4. User data and platform skills excluded from replacement; approved scope only.
5. Applicable backup, lifecycle and health/identity validation demonstrated for
   this layout. A backup for a Python-era deployment is not automatically valid.

Until these checks pass, provide inspection findings and the missing prerequisite.
Do not invent a working latest version or treat a successful --help as validation.
