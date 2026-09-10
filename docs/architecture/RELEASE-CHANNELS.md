# Release Delivery Paths

## Two Independent Workflows

| Change | Workflow | Output |
| --- | --- | --- |
| Tavern, MCP implementation, Nora skills/persona/greeting, standalone updater | `Publish system update (reuse environments)` | New shared modules and three complete system manifests; verified environment archives reused byte for byte |
| Desktop launcher, bundled integration code, dependency locks or environment | `Build full Nora Tavern installers` | Three platform builds, complete environments, DMG/EXE and system update assets |

Both paths use `package-release.mjs`, `writeSystemRelease`, the same release
verifier and `publish-release.mjs`. They do not introduce another client update
protocol or change users' data directories. A shared Actions concurrency group
prevents the two paths from publishing the same tag concurrently.

## Component Release

1. Commit the release version in `app/.tavern-release-version` and authored notes
   in `docs/releases/vX.Y.Z.md`. Push an annotated matching tag.
2. Run `.github/workflows/publish-component-update.yml` **on that tag**, supplying
   `baseline_tag`, for example `v2.3.0`. A branch run deliberately cannot publish.
3. One Linux build produces the common app, MCP and updater archives with
   `node tooling/release/package-release.mjs --components-only`. No Hermes
   installation, platform matrix, Electron build, DMG/EXE or launcher ZIP runs.
4. Compare the target source fingerprints against all three baseline manifests.
   Launcher files, integration files, dependency manifests/locks and runtime
   packaging inputs must match. Missing fingerprints or changed immutable inputs
   fail closed and require the full workflow. Existing helpers embedded in the
   desktop shell are intentionally guarded, even if their change seems small.
5. Reuse the baseline's platform-specific Hermes/Python/Node and dependency
   archives after SHA-256 and size validation. Keep their exact bytes; only the
   application contents and target release identities are new. This step does
   not unpack or rebuild an environment.
6. Verify all referenced assets for all three platforms, create a draft, upload
   all assets, then make it public/latest. A failure leaves a draft, not a broken
   latest release. Delete the failed draft before rerunning; do not overwrite a
   public tag or public assets.

The existing launcher's `nora-system/v1` contract requires referenced files to
exist **in the same GitHub release**. Therefore unchanged environment archives
are copied into the new release. This still uses upload/storage bandwidth, but
does not rebuild a large installer. Changing this to cross-release references
would require a separately planned client protocol migration. Do not omit those
attachments while claiming old clients can update.

The existing client reuses a bundled/cache file when its hash matches. This
avoids downloading an unchanged environment in that case, but is not a promise
that every user will never download it: missing or mismatched local files still
require a verified download.

## Installer Downloads

Launcher 0.3.4 switches installed systems to the common updater. The first full
release carrying this change requires `minimumLauncherVersion: 0.3.4`; older
shells must be replaced once, without uninstalling their data. Subsequent
component releases inherit that minimum from the verified full baseline.
Both full and component payloads include `tavern-updater-bootstrap.py`, pinned
by the target release manifest. Do not remove it from the desktop payload.

Component release notes link directly to the last real full installers and
clearly label their version. `component-release.json` retains that installer tag,
the runtime baseline tag and reused hashes. Chained component releases retain
the original installer links and check they still exist. No old installer is
renamed or presented as newly built.

README's direct download links stay pinned to the actual full installer release.
When a full installer release is intentionally built, update those links to its
verified assets. New installations use the launcher's existing latest-system
resolution; installed users continue using the existing version/update controls.

## Verification Scope

`tests/component-release.test.mjs` exercises all three manifest variants using
the unchanged launcher download/validation implementation, including reuse of
local matching archives, missing remote assets, dependency changes, corrupt
archives, full-build requirements and verification without installer binaries.
`tests/launcher-release-notes.test.cjs` checks the actual download destinations.
These are packaging/contract tests, not three-platform native installation tests.

The component workflow also runs world-preservation and rollback regression
tests. Full platform installation tests remain in the full-installer workflow.
