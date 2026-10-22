# Development And Release

Before planning or editing, read the [product design overview](docs/product/README.md) and every affected module design listed there. Together these four documents are the project's authoritative product requirements. Follow the [change-control protocol](docs/product/README.md#change-control), record applicable PB/PR rules, intended outcomes and preserved behavior, and compare actual changes before delivery. Confirm changes to accepted product behavior before implementation; routine fixes within existing authorization do not need repeated product approval. Technical plans and historical records do not independently change product rules.

Start with [repository navigation](docs/REPOSITORY.md). Change authored source, not installed runtime files or generated copies. `nora/AGENTS.md` is delivered to Hermes; it is not instructions for repository contributors.

## Requirements

- Node.js 24 and npm with committed lockfiles for the release pipeline. The repository `.nvmrc` selects the same major version as CI; with nvm, run `nvm install` and `nvm use` from this directory before launcher commands.
- The desktop launcher uses npm and `launcher/desktop/package-lock.json` as its only dependency lockfile. Additional package-manager locks make Electron Builder fall back to environment-dependent manager detection.
- Python 3.11 or later with psutil and PyYAML for source deployment tests. Set `NORA_TEST_PYTHON` to its actual executable; it takes precedence over `NORA_PYTHON`. Source CI pins psutil 7.0.0 and PyYAML 6.0.2.
- Native Hermes integration requires its actual checkout (`NORA_TEST_HERMES`), matching venv (`NORA_TEST_PYTHON`) and managed base (`NORA_TEST_MANAGED_PYTHON_ROOT`). An independent source-test venv does not establish that the Hermes runtime is complete.
- Native macOS arm64, macOS x64, and Windows x64 builders for their respective Hermes runtime bundles. A Mac build does not establish Windows compatibility.

Install development dependencies where they are authored:

```sh
npm ci --prefix launcher/desktop
npm ci --prefix app/engine/sillytavern
npm ci --prefix nora-mcp
```

Dependencies belong in `launcher/desktop/node_modules`; do not link them to a
temporary build export or reuse the retired `ops/installer/desktop/node_modules`.

## Source And Delivery Layouts

Source is grouped by ownership. Existing installations still consume the `ops/` delivery layout. `tooling/source-layout.json` is the only path mapping; builds project source into an isolated directory without rewriting its contents.

Deployment modules retain their delivery-relative imports. **Do not execute moved internals directly.** Use `tooling/run.mjs`, which exports current source, maps source arguments, links local dependencies, runs the command, then removes its own temporary directory. Use absolute paths for output directories and external installations.

The runner does not make destructive commands safe. Use isolated test homes and fixtures during development.

The repository index is another source-facing command: `node tooling/checks/index-project.mjs`. It writes the current source inventory to ignored `.codebase-memory/project-index.json`, not over the historical architecture snapshot.

## Tests

For complete launcher source regression, run the matching prerequisite profile directly from the authored repository:

```sh
node "$PWD/tooling/checks/launcher-test-environment.mjs" source
node "$PWD/tooling/checks/verify-launcher-stability.mjs"
```

For a release, select regression against the accepted baseline and the exact clean,
committed checkout before executing tests:

```sh
node tooling/checks/launcher-test-impact.mjs --base <accepted-stable-tag> --head HEAD --output /absolute/path/to/new-test-impact.json
```

The selector does not build or publish. It rejects a different HEAD or tracked
working changes. A `full=true` result requires the complete gate above;
`full=false` permits `--run-focused` with the same baseline and commit. That
command recomputes the selection instead of trusting an editable JSON file.
Focused checks retain installation, update, uninstall and data-protection tests;
the workflows add affected UI/content/frontend groups and keep final native
product acceptance separate. `--force-full true` only broadens coverage. Pure
verification changes need their own checks, not a product build. See the
[selection and reuse rules](docs/release-process.md#test-impact-selection) for
the mandatory platform checks and limits of prior evidence.

Use a real Node.js 24 executable for these commands. A Bun `node` compatibility shim, an explicitly missing interpreter, wrong native binding, or unavailable file/directory symlink capability is a test-environment failure (exit 2), checked before test processes run. The runner uses absolute Node script entries, forwards the selected Node to Python fixtures, waits for actual child close, and cleans its own export after close. Failed test assertions remain failures and need evidence before being attributed to product code.

Use the `native` prerequisite profile for complete Hermes actor tests. Use `chromium` after installing the lockfile-matching Electron binary for local TLS/proxy fixtures. Receiver/Worker/D1 integration requires `NORA_LANDING_ROOT` and the `receiver` profile; its source must match the launcher protocol and migrations. Without receiver input, source UI tests do not establish receiver acceptance. Platform-specific skips and unavailable final APP inputs are recorded separately from passed checks.

Layout tests run directly against authored source:

```sh
node --test tests/repository-layout.test.mjs
```

Deployment tests run against the layout users install:

```sh
node "$PWD/tooling/run.mjs" node --test tests/deployment/launcher_releases.test.cjs tests/deployment/launcher_system_update.test.cjs tests/deployment/launcher_uninstall.test.cjs
node "$PWD/tooling/run.mjs" python -B -m unittest tests.deployment.test_first_install tests.deployment.test_managed_context tests.deployment.test_incremental_update
```

Tavern tests that import deployment helpers also use the export:

```sh
node "$PWD/tooling/run.mjs" node --test app/engine/sillytavern/tests/nora-release-source.test.mjs app/engine/sillytavern/tests/nora-launcher-model.test.mjs
```

Run the engine's npm scripts in the projected tree:

```sh
node "$PWD/tooling/run.mjs" npm --prefix app/engine/sillytavern run test:nora
node "$PWD/tooling/run.mjs" npm --prefix app/engine/sillytavern run lint:owned
```

`test:nora` compiles the canonical public library from current source before
checking its artifact contract. The projected runner keeps this test output in
its disposable tree; a clean checkout does not need a previous installer build.
The release backup gate is a source-facing entry: invoke
`node tooling/checks/verify-backup-safety.mjs` directly from this checkout.

Choose focused tests before repository-wide suites. Tests establish only the workflows they exercise, not visual or real-device acceptance.

## Launcher Development

The active launcher reliability scope, acceptance gates, and phase reports live in [one delivery plan](docs/launcher-reliability-plan.md). Keep unique regression tests and necessary evidence; delete obsolete one-off drivers, duplicate snapshots and outdated plans. Commands are indexed in [deployment test navigation](tests/deployment/README-nora-acceptance.md). Do not maintain a second mutable progress plan or start another test instance before the current one has closed.

The production page is `launcher/ui/index.html`. Retired design experiments remain available in Git history. Test the current UI and clicks without repackaging:

```sh
node "$PWD/tooling/run.mjs" --watch node launcher/desktop/node_modules/electron/cli.js launcher/desktop --nora-mock=uninstalled --nora-watch
```

Use `--nora-mock=installed` for the installed state. For real installation testing omit `--nora-mock` and use the launcher's existing isolated test configuration. The runner mirrors UI/desktop source edits; Electron's existing watcher reloads them. Restart the dev command after deployment-module or dependency changes.

## Story Profile

Edit `story-profile/`, then explicitly regenerate and verify its embedded snapshot:

```sh
npm --prefix app/engine/sillytavern run sync:story-profile
npm --prefix app/engine/sillytavern run check:story-profile-source
python3 -m unittest discover -s story-profile/tests
```

Ordinary packaging checks parity but does not silently refresh authored changes. Do not edit `app/story_profile_runtime/` by hand.

## Packaging

Run the source-facing packager directly, not through the delivery runner:

```sh
node tooling/release/package-release.mjs --candidate --hermes-runtime-manifest /absolute/path/to/nora-hermes-runtime.json
```

`--candidate` includes tracked and unignored new source, records dirty state, and creates a local candidate. `--offline` requires all locked npm packages already cached. Omitting `--candidate` requires a clean committed tree. A complete launcher system requires a verified platform-specific Hermes runtime manifest; Tavern-only archives do not establish a complete Nora installation.

Candidate builds disable uploads by default. Add `--candidate-telemetry` alongside `--candidate` only for an explicitly authorized receiver test. That build uses a separate isolated installation directory and sends basic operation statistics to the production receiver. Detailed diagnostics default to enabled for a new diagnostic choice; users can turn them off in the launcher, and an existing explicit opt-out is preserved. Candidate payload verification and the online-update restriction remain in force.

The packager exports source, checks Story Profile parity, builds Tavern/MCP, validates the delivery allowlist and hashes, and emits `release/`. It **does not run the test suite**; the manifest records `verification.mode=packaging-only` and `testsExecutedByPackager=false`. There is no separate guaranteed `--fast-after-test` mode.

Verify the payload separately:

```sh
node "$PWD/tooling/run.mjs" node tests/deployment/launcher_product_refactor_smoke.cjs --payload /absolute/path/to/release/nora-tavern-launcher/payload
```

The guarded product harness uses the actual native writer lease and acknowledged child actors in its own installation directory and no real model key or pairing. External routing, model-provider behavior, and desktop acceptance need additional target-environment tests. For an isolated Electron source test using a separately installed exact dependency closure, set `NORA_TEST_DESKTOP_NODE_MODULES` to that complete `node_modules` directory; the source checkout and user installation are unchanged.

The three-platform pipeline is `.github/workflows/build-integrated-launcher.yml`. It verifies runtime, tests deployment, creates the payload, tests fresh installation, builds the desktop shell, and checks packaged icons/content. Publication requires all platform outputs to agree on version and commit.

## Release Rules

Before release work, complete the [design execution cross-check](docs/product/README.md#change-control) and [delivery requirements](docs/product/README.md#delivery) in the existing task or release record. Record the plan before the relevant action and compare it with actual results before reporting completion; a statement that the process was followed is not the record.

Full and component publication share the release channel lock. Select destinations in the sealed plan; the domestic-primary configuration uses GitHub and JihuLab (`github-jihulab`). Configure the project-scoped `JIHULAB_PRIVATE_TOKEN` secret for JihuLab. SourceForge credentials are required only when SourceForge is selected: repository variable `SOURCEFORGE_USERNAME` and secrets `SOURCEFORGE_SSH_PRIVATE_KEY` / `SOURCEFORGE_KNOWN_HOSTS`. Keep private credentials outside Git and public artifacts. Preparation creates immutable resources and a GitHub draft; promoting the official channel requires separate authorization. See [the release process](docs/release-process.md).

1. Never commit credentials, runtime homes, logs, installed dependencies, or generated release assets.
2. Keep source identity, Story Profile snapshot, delivery hashes, and platform manifests consistent.
3. Commit/push, tag, publish, and deploy are separate explicitly authorized operations.
4. Back up runtime files before authorized deployment and verify the actual target afterwards.
5. Do not report publication or user acceptance based only on a build or health check.

The [update guide](docs/update-nora-tavern.md) distinguishes complete-system updates from standalone Tavern updates. Existing upstream license and security notices remain in their component directories.
