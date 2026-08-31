# Isolated clean-update rehearsal

Use only for explicit approval to test migration on a disposable copy. The
default updater and all live services stay unchanged. `--isolated-test-port`
selects the clean transaction implementation; both the marked temporary home and
a separate port are required. Ports 8799/8809 and non-temporary homes are refused.

The repository harness `ops/tests/verify_clean_release.py` creates its own marked
temporary home. Pass an approved local candidate bundle and an explicit historical
Node commit with `--release-dir` and `--old-ref`. It installs dependencies, starts
the historical instance, stops it, creates sanitized legacy data, upgrades, checks
the running World snapshots and then restores the old code and state. It performs
no generation/model call. Its source fixtures and harness are development tools,
not part of the runtime archive.

## Transaction contract

- Review still verifies pinned archives, installer output, AGENTS merge and MCP
  configuration. It also identifies inactive old code and preserved custom plugins.
- All writers must be stopped before apply. Offline checks are not graceful
  draining: production writer coordination remains a separate release gate.
- Prepare copies complete program directories and project state. Migration runs
  only on that state copy; checks cover World manifests, bindings, conversation
  contents, existing identities and recognized Profile formats. Broken or unknown
  records fail instead of being silently discarded or regenerated.
- Switch app/ops/MCP, managed skill directories, state and reviewed host files
  with recorded rename intents. Old trees remain outside active discovery paths.
  Third-party frontend extensions retain their existing directories. Custom
  server-plugin files are preserved in the reviewed plugin location. Unknown
  files elsewhere in owned code directories remain in recovery, not active code.
- State recovery includes `tavern-state` and exactly `memories/USER.md` and
  `memories/MEMORY.md`, plus reviewed host configuration. It is not a backup of
  the entire Hermes home. PID/log files are recreated, not treated as story data.
- Interrupted or failed activation restores prior trees. A later rollback refuses
  changes made after acceptance, including new dialogue and shared memory edits;
  it must never erase newer activity to make an older version start.

## Evidence and limits

`isolated-installed` means the isolated transaction passed its checks. It is not
`installed-awaiting-hermes-reload` and does not request a real gateway reload or
Liveware re-registration. Read `migration.json`, the receipt and the harness result.

Supported migration: validated Node World v1 → v2; existing valid v2 Worlds retain
their identities, and existing Profile schema-1 files retain their bytes. Repeated
migration must not duplicate Worlds. Full Python production/runtime_cast/ledger
migration is not implemented and is explicitly refused. A schema marker alone is
not migration evidence. Custom plugin files being retained does not prove plugin
behavior in every historical environment.

After rehearsal, report the tested old commit, data scope and recovery result.
Live deployment, production maintenance/draining, Python conversion and stable
release approval remain separate work. Keep failed rehearsal artifacts private;
never upload copied user data in a release bundle or create markers to bypass the
temporary-home restriction.
