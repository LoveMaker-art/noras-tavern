# Existing-Instance Update Safety

## Incident And Cause

The v2.2.11 bootstrap adopted desktop first-install defaults in commit
`c2280ab`. With `HERMES_HOME=/opt/data`, a different `HOME`, and no explicit
installation root, v2.2.8/v2.2.9 selected `/opt/data`; v2.2.11/v2.3.0 selected
`$HOME/.local/share/nora-tavern/tavern`. The bootstrap then passed that new root
explicitly to the update runner. The runner rewrote the existing Hermes MCP
binding to that root, allowing an empty instance to appear in place of existing
worlds. Existing files were not necessarily deleted.

The current runner's legacy default had already been restored, but that did not
correct the bootstrap's explicit wrong-root argument. Two independent defaults
were the compatibility defect.

## Decision

- `deployment/update/bootstrap.py:resolve_update_target` owns update target
  resolution. Both downloaded bootstrap and direct runner use it. It remains
  self-contained in the checksummed bootstrap; no extra unverified download is
  required.
- Updates resolve existing installations, not first-install destinations. The
  resolver reconciles explicit arguments, `TAVERN_DATA_ROOT`, MCP path fields,
  and installation evidence. Inconsistent paths, damaged configuration,
  incomplete installations, and unsupported state-directory symlinks fail before
  program/configuration changes. No recursive home-directory search is used.
- Existing colocated deployments and separate standalone Tavern directories are
  supported. Old `--data-root` commands remain accepted. First installation
  remains the installer's responsibility.
- Launcher-managed systems still use the launcher's existing transaction and
  instance record. The standalone updater refuses them before its same-version
  shortcut. The launcher UI and installation defaults are unchanged.
- Version notifications use the existing runtime instance reader for configured
  installations. An unbound legacy checker looks in Hermes home, not an invented
  sibling Tavern directory.

## Native World Protection

For native runtime replacement, stop the old runtime, snapshot `tavern-state`,
and record hashes of existing world manifests, chats, worldbooks and characters.
Use the old and candidate app's **existing WorldStore** to verify readable worlds
and their session identities. The verifier substitutes read-only filesystem
operations, so invalid manifests fail validation instead of being quarantined.

After startup, check the installation binding again, compare original file
hashes, and load worlds again before recording success or pruning old backups.
Missing/changed original resources or unreadable original worlds fail the
transaction. Rollback restores program files, Hermes configuration and the state
snapshot; failed new state is retained in the transaction's `failed-new` area.
Version receipts are also restored if committing the new receipt fails. If the
new process cannot be stopped, rollback refuses to replace live data and reports
the retained backup instead of falsely reporting successful recovery.
The installed receipt records `worldVerification` counts without story content.

This guard does not redesign legacy Python-to-native data migration. Existing
migration behavior and the desktop system transaction remain separate, unchanged
paths. It also does not establish that every gameplay feature works after an
upgrade, or diagnose gateway shutdown behavior.

## Verification

- `tests/deployment/test_update_target.py`: default-root regression, separate
  installation, conflicting evidence, empty destinations, managed-system refusal,
  legacy CLI compatibility, successful preservation and failure rollback.
- `tests/deployment/updater_worlds.test.mjs`: actual product WorldStore, session
  identities, all accounts, and incompatible manifests without quarantine.
- Existing incremental-update, update-check, first-install, instance ownership,
  process detection, lifecycle locking and launcher transaction tests were run.
  Platform-specific skips remain skips, not platform acceptance.
- On the provided remote machine, the fixed resolver was executed in memory and
  selected `/opt/data` without path arguments. The current release's WorldStore
  also read all 14 remote manifests in memory: one active world, 13 pre-existing
  deleted records. No story content or credentials were written to the repo.

## Authorized Real Update

On 2026-09-10, after explicit authorization, built a local v2.3.0 candidate from
the fixed working tree and updated the provided Linux machine from v2.2.8.
This is not a newly published GitHub release. Candidate source digest:
`e407143276208b84c12281b6a4df9fca4f3b9f702d0b4fd4e2841c08684055a6`.

- The bootstrap used a local checksummed release with `--allow-candidate`; no
  installation-root argument was supplied. It selected the original `/opt/data`.
  Candidate acceptance requires an explicit local release directory and does not
  disable checksum verification or change normal release acceptance.
- Before replacement, stopped Tavern and created an independently retained
  recovery archive of affected runtime, state and Hermes configuration files at
  `/opt/data/tavern-manual-recovery/root-fix-20260910/before-update.tar.gz`.
  The archive was fully read back. This is not a full backup of unrelated live
  Hermes databases.
- Actual update exited successfully in 50.9 seconds. The installed receipt
  explicitly records `candidate: true` and the source digest.
- Before and after reloading `hermes-agent`, real HTTP world-list, snapshot and
  open-plan requests passed. The original active world and session identities
  remained available; all 34 protected file hashes were unchanged. The 13
  pre-existing deleted manifests were not counted as active worlds.
- The runtime still reads `/opt/data/tavern-state/native/default-user`; MCP still
  binds `/opt/data/tavern-state`. Supervisor reloaded Hermes successfully and a
  new MCP process started. SSH, manager and tunnel processes were not restarted.
- The installed version checker returned installed/latest `2.3.0` with no update
  available. Its version comparison does not distinguish this candidate from the
  existing same-numbered public release; the installation receipt does.
- Evidence is retained in that remote recovery directory: `baseline.json`,
  `update.log`, `update-result.json`, `after-update.json`, `gateway-reload.json`
  and `after-gateway-reload.json`. No story content or credentials were added to
  this repository.

**Not performed:** Windows/macOS deployment acceptance, manual gameplay through
the client, GitHub push or publication of the fixed release. The real-update
result applies to this remote Linux installation, not every deployment variant.

## Return To User-Test Baseline

Later on 2026-09-10, the user requested restoration of the original version and
removal of this test's backup files before testing the public update personally.
Restored v2.2.8, restarted Tavern and Hermes, and verified the original world and
all 34 protected file hashes again. Only after those checks, removed this test's
`root-fix-20260910` recovery directory, including its archive, candidate payload
and temporary replacement files. The evidence filenames above describe the
completed test; those remote files are no longer retained. Unrelated pre-existing
backups were not included in this cleanup.
