# Development And Release

Start with [repository navigation](docs/REPOSITORY.md). Change authored source, not installed runtime files or generated copies. `nora/AGENTS.md` is delivered to Hermes; it is not instructions for repository contributors.

## Requirements

- Node.js 24 and npm with committed lockfiles for the release pipeline.
- Hermes' managed Python with PyYAML for deployment tests. Set `NORA_PYTHON` to its executable; otherwise the runner uses `python3` on macOS or `python` on Windows.
- Native macOS arm64, macOS x64, and Windows x64 builders for their respective Hermes runtime bundles. A Mac build does not establish Windows compatibility.

Install development dependencies where they are authored:

```sh
npm ci --prefix launcher/desktop
npm ci --prefix app/engine/sillytavern
npm ci --prefix nora-mcp
```

## Source And Delivery Layouts

Source is grouped by ownership. Existing installations still consume the `ops/` delivery layout. `tooling/source-layout.json` is the only path mapping; builds project source into an isolated directory without rewriting its contents.

Deployment modules retain their delivery-relative imports. **Do not execute moved internals directly.** Use `tooling/run.mjs`, which exports current source, maps source arguments, links local dependencies, runs the command, then removes its own temporary directory. Use absolute paths for output directories and external installations.

The runner does not make destructive commands safe. Use isolated test homes and fixtures during development.

The repository index is another source-facing command: `node tooling/checks/index-project.mjs`. It writes the current source inventory to ignored `.codebase-memory/project-index.json`, not over the historical architecture snapshot.

## Tests

Layout tests run directly against authored source:

```sh
node --test tests/repository-layout.test.mjs
```

Deployment tests run against the layout users install:

```sh
node tooling/run.mjs node --test tests/deployment/launcher_releases.test.cjs tests/deployment/launcher_system_update.test.cjs tests/deployment/launcher_uninstall.test.cjs
node tooling/run.mjs python -B -m unittest tests.deployment.test_first_install tests.deployment.test_managed_context tests.deployment.test_incremental_update
```

Tavern tests that import deployment helpers also use the export:

```sh
node tooling/run.mjs node --test app/engine/sillytavern/tests/nora-release-source.test.mjs app/engine/sillytavern/tests/nora-launcher-model.test.mjs
```

Run the engine's npm scripts in the projected tree:

```sh
node tooling/run.mjs npm --prefix app/engine/sillytavern run test:nora
node tooling/run.mjs npm --prefix app/engine/sillytavern run lint:owned
```

Choose focused tests before repository-wide suites. Tests establish only the workflows they exercise, not visual or real-device acceptance.

## Launcher Development

The production page is `launcher/ui/index.html`. `launcher/previews/` contains design experiments, not the desktop entrypoint. Test UI and clicks without repackaging:

```sh
node tooling/run.mjs --watch node launcher/desktop/node_modules/electron/cli.js launcher/desktop --nora-mock=uninstalled --nora-watch
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

The packager exports source, checks Story Profile parity, builds Tavern/MCP, validates the delivery allowlist and hashes, and emits `release/`. It **does not run the test suite**; the manifest records `verification.mode=packaging-only` and `testsExecutedByPackager=false`. There is no separate guaranteed `--fast-after-test` mode.

Verify the payload separately:

```sh
node tooling/run.mjs node tests/deployment/launcher_bundle_smoke.cjs /absolute/path/to/release/nora-tavern-launcher/payload
```

This smoke test uses its own installation directory and no real model key or pairing. External routing, model-provider behavior, and desktop acceptance need additional target-environment tests.

The three-platform pipeline is `.github/workflows/build-integrated-launcher.yml`. It verifies runtime, tests deployment, creates the payload, tests fresh installation, builds the desktop shell, and checks packaged icons/content. Publication requires all platform outputs to agree on version and commit.

## Release Rules

1. Never commit credentials, runtime homes, logs, installed dependencies, or generated release assets.
2. Keep source identity, Story Profile snapshot, delivery hashes, and platform manifests consistent.
3. Commit/push, tag, publish, and deploy are separate explicitly authorized operations.
4. Back up runtime files before authorized deployment and verify the actual target afterwards.
5. Do not report publication or user acceptance based only on a build or health check.

The [update guide](docs/update-nora-tavern.md) distinguishes complete-system updates from standalone Tavern updates. Existing upstream license and security notices remain in their component directories.
