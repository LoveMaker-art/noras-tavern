# Tavern development and release guide

The root [README](README.md) is the product and update entrypoint. This document is for developers and release maintainers.

## Source boundaries

- `app/engine/sillytavern`, `app/native-extensions`, `app/native_lifecycle.py`, and `app/native_model_config.py` are the Tavern production source.
- `story-profile/` is the authoritative Story Profile source. `app/story_profile_runtime/` is its generated release snapshot and must not be edited by hand.
- `nora-mcp/` is the MCP source.
- `ops/` owns lifecycle, Liveware integration, skills, updater, packaging, and deployment operations.
- `local-state/`, `release/`, runtime data, credentials, logs, caches, `node_modules`, and installed extension copies are not authored source.

Do not edit a remote runtime as the source of a change. Implement and verify the change in this repository, then deploy an explicitly reviewed delta or release.

## Requirements

- Node.js 20 or newer. Current release verification uses Node.js 22.22.3.
- npm with the committed lockfiles.
- Python 3.9 or newer for lifecycle, updater, and Story Profile tooling. Updater execution uses Hermes' Python environment with PyYAML.

## Local setup

```sh
cd app/engine/sillytavern
npm ci
```

Do not hand-edit `public/dist/nora/entry.js`. Build the Nora bundle from `webpack.nora.config.mjs` through the maintained npm scripts.

## Story Profile changes

One checkout contains both Tavern and the authoritative Story Profile source. After intentionally changing `story-profile/`, refresh and verify the embedded snapshot:

```sh
cd app/engine/sillytavern
npm run sync:story-profile
npm run check:story-profile-source
```

The snapshot revision is derived from source content, not Git HEAD. Ordinary builds verify the snapshot but do not silently synchronize changed Story Profile source.

Run Story Profile's offline projection tests from the repository root:

```sh
python3 -m unittest discover -s story-profile/tests
```

## Tavern verification

From `app/engine/sillytavern`:

```sh
npm run test:nora
npm run lint
npm run build:nora
```

Run focused tests appropriate to the changed behavior before broad release checks. A successful build, process health check, or DOM presence check is technical evidence only; it does not prove the target user workflow or Liveware deployment outcome.

## Candidate packaging

From the repository root:

```sh
sh ops/scripts/package-release.sh --candidate
```

Candidate mode can snapshot tracked source and non-ignored new source while recording the dirty state and source digest. It is intended for further verification and is not stable release approval. Use `--offline` only when every locked dependency is already available in npm's local cache.

## Stable packaging

Stable packaging requires committed, clean source and all mandatory automated checks:

```sh
sh ops/scripts/package-release.sh
```

The packager exports the commit into an isolated directory, installs locked dependencies, runs the dependency audit, tests, lint, builds, contracts, and workflow gates, and then archives explicit file lists. Browser acceptance is not a packaging prerequisite and must not be inferred from automated verification.

Each uniquely named directory under `release/` contains the app, ops, and Nora MCP archives, the release manifest, and SHA-256 checksums. Runtime data, user models, credentials, ignored private files, installed dependencies, and tests are excluded from release payloads.

## Fast packaging after targeted tests

Small fixes do not need to repeat the complete repository gate during the
publishing phase. First run the tests that exercise the changed behavior and
its directly affected module. After those tests pass, commit the change and use:

```sh
sh ops/scripts/package-release.sh --fast-after-test
```

This mode still requires a clean committed tree, installs locked build
dependencies, checks Story Profile source parity, rebuilds required Tavern and
MCP artifacts, rejects private/runtime files, and emits the same full archives,
manifest, Bootstrap files, and SHA-256 checksums as a normal release. It does
not rerun dependency audits, repository-wide tests, lint, architecture
contracts, or product workflow tests.

The manifest records `verification.mode=fast-after-external-test` and does not
claim that the packager executed tests. Use normal stable packaging for broad,
cross-module, dependency, migration, or architecture changes. Packaging never
pushes a branch, creates a tag, publishes a GitHub Release, or updates a host;
those remain separately authorized actions.

The pinned `image-size` and `showdown` security backports live under `app/engine/sillytavern/vendor/`. Their `SECURITY.md` files record upstream provenance, changes, licenses, and limitations.

## Release and deployment rules

1. Keep source, generated Story Profile snapshot, build output, package manifest, and release commit consistent.
2. Do not commit API keys, cookies, tokens, live model configuration, user state, logs, caches, or generated dependency directories.
3. Publishing a branch does not publish a GitHub Release, and publishing a Release does not update any installed host.
4. A deployment must back up affected target files, upload only the reviewed artifact or delta, restart through the maintained lifecycle, and perform health plus requested user-workflow verification.
5. Do not describe a change as deployed or user-verified until it has been demonstrated in the target environment.

The updater source lives in `ops/updater/`. Its compatibility, transaction, migration, recovery, and activation contract is documented in [release-compatibility.md](ops/skills/system/tavern-updater/references/release-compatibility.md).
