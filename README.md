# Nora Tavern

Nora's product layer and deployment runtime for complex Tavern cards.

## Layout

- `app/`: the Node compatibility engine, Nora runtime adapters, Nora UI, model configuration, lifecycle code, and tests.
- `ops/`: maintained lifecycle, Liveware registration, provisioning, and deployment scripts from the remote instance.
- `local-state/`: private, Git-ignored runtime snapshot used to reproduce the current worlds and installed extensions locally.
- `release/`: generated, Git-ignored production archives and their integrity manifest.
- `story-profile/`: authoritative Story Profile source synchronized into the Tavern release snapshot; included in this repository, not a submodule.
- `../st-mcp/`: independent MCP control and indexing project for the embedded SillyTavern engine.

## Development Rules

1. Treat `app/engine/sillytavern`, `app/native-extensions`, `app/native_lifecycle.py`, and `app/native_model_config.py` as the Tavern production source. Treat `story-profile` as the Story Profile source.
2. Do not edit the remote runtime directly. Implement and verify changes here first.
3. Do not commit `local-state`, API keys, cookies, tokens, logs, caches, or generated dependency directories.
4. Build the Nora bundle from `app/engine/sillytavern/webpack.nora.config.mjs`; do not hand-edit `public/dist/nora/entry.js`.
5. A deployment must back up affected remote files, upload only the verified delta, restart through the maintained lifecycle scripts, and run health plus user-workflow verification.

## Install

```sh
cd app/engine/sillytavern
npm ci
```

The production dependency lock requires Node.js 20 or newer.
Node.js 22.22.3 is the runtime used by the current local release checks.
Tavern is a single-user/Agent workspace: deploy a separate instance and data
directory for each trust boundary, not one shared public multi-tenant service.

Story Profile is embedded as a checksum-verified snapshot. One checkout contains
both projects. After intentionally changing `story-profile/`, update its snapshot:

```sh
npm run sync:story-profile
npm run check:story-profile-source
```

Ordinary builds only verify the embedded snapshot; they do not silently pull
new source changes. Release checks enforce source/snapshot parity. The host adapter preserves the original UI and adds CSRF
headers to its mutation requests.

The snapshot revision is a content digest of its input files, not Git HEAD, so
committing or exporting the repository does not invalidate the snapshot. An
explicit `NORA_STORY_PROFILE_SOURCE` override is available for development.

## Verification

```sh
cd app/engine/sillytavern
npm run test:nora
npm run lint
npm run build:nora
```

From the repository root, create a local candidate for further verification:

```sh
sh ops/scripts/package-release.sh --candidate
```

Use `--offline` only after the locked dependencies are available in npm's local
cache. Candidate mode snapshots tracked and non-ignored new source files,
records the dirty state and source digest, and is **not release approval**.

Stable packaging requires committed, clean source and current target-environment
workflow evidence (see `ops/scripts/verify-product-workflows.mjs`):

```sh
sh ops/scripts/package-release.sh --browser-report /absolute/path/to/report.json
```

It exports that commit to an isolated directory, installs locked dependencies,
checks production dependency advisories, runs tests/lint/build/contracts and the
workflow gate, then archives explicit file lists. A nonzero security audit blocks
stable packaging; unresolved advisories are not silently accepted.

Each uniquely named directory under `release/` contains app/ops archives, a
source/artifact manifest and SHA-256 checksums. Runtime data, ignored private
files, installed dependencies and tests are not packaged. Path/content checks
reject common secret formats; they are not a guarantee against every possible
credential representation. Licensing and necessary runtime metadata remain.

Current findings and outstanding release gates:
[Release hardening record](docs/architecture/RELEASE-HARDENING-2026-08-30.md).

Runtime data and model credentials are intentionally separate from source.
Set `TAVERN_APP_DIR` to the installed `app` directory and `TAVERN_STATE_DIR` to
a persistent directory outside it; lifecycle commands are provided by
`app/native_lifecycle.py`. Never distribute an author's live state directory.
