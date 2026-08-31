# Tavern

World-centered Tavern runtime for complex cards, with Story Profile, MCP,
Hermes skills and the full-bundle updater maintained together on `main`.

## Version 2.0.0

`main` contains the reconstructed Node project, replacing the former Python
application source. Python-to-Node data migration remains part of the updater;
the legacy online application is not a second runtime in this source tree.

The source version is `2.0.0`. **The stable GitHub Release is not yet published:**
the release bundle has not yet been published. The two dependency security
backports are documented below; publishing still requires the complete checks.
Until that publication, GitHub `releases/latest` still selects the old release.
Do not use the commands below expecting a 2.0.0 update before the release exists.
See [2.0.0 release status](docs/releases/v2.0.0.md).

## Layout

- `app/`: the Node compatibility engine, Nora runtime adapters, Nora UI, model configuration, lifecycle code, and tests.
- `ops/`: maintained lifecycle, Liveware registration, provisioning, and deployment scripts from the remote instance.
- `local-state/`: private, Git-ignored runtime snapshot used to reproduce the current worlds and installed extensions locally.
- `release/`: generated, Git-ignored production archives and their integrity manifest.
- `story-profile/`: authoritative Story Profile source synchronized into the Tavern release snapshot; included in this repository, not a submodule.
- `nora-mcp/`: the Hermes-facing MCP source, locked dependencies and integration tests; no sibling repository required.
- `ops/skills/`: four canonical Hermes skills, CardForge source, and the managed Tavern AGENTS block.
- `ops/updater/`: pinned full-bundle review, installation, recovery and MCP discovery checks.

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

Stable packaging requires committed, clean source and passing automated checks:

```sh
sh ops/scripts/package-release.sh
```

It exports that commit to an isolated directory, installs locked dependencies,
checks production dependency advisories, runs tests/lint/build/contracts and the
workflow gate, then archives explicit file lists. A nonzero security audit blocks
stable packaging; unresolved advisories are not silently accepted.

`image-size` and `showdown` resolve to pinned, MIT-licensed security backports in
`app/engine/sillytavern/vendor/`. Their `SECURITY.md` files record upstream source,
changes and limitations. The mandatory dependency regression tests complement
registry audit, which does not inspect local fork source. These are not claimed
to be new upstream releases or proof that all vulnerabilities have been removed.

Browser acceptance is not a packaging prerequisite. No browser report,
commit-matched UI evidence or browser timing thresholds are required. The five
automated workflow groups and architecture contracts remain required; their
report explicitly distinguishes technical verification from browser acceptance.

Each uniquely named directory under `release/` contains app/ops/nora-mcp archives, a
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

## Full updates

The updater's canonical source is `ops/updater/` on `main`; it is not maintained
on a separate updater or release branch. After the 2.0.0 stable Release is
published, the main-branch entrypoint is:

```sh
curl -fsSL https://raw.githubusercontent.com/LoveMaker-art/noras-tavern/main/ops/updater/install.sh | sh -s -- --apply --confirm
```

The published-asset entrypoint is equivalent for the matching release:

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh | sh -s -- --apply --confirm
```

Both select the latest **stable published bundle**, not an arbitrary checkout
of main. They do not require an RC tag or `--allow-candidate`. The main script
selects Hermes' existing Python environment and verifies the downloaded
Bootstrap; the Bootstrap pins the release manifest and archive checksums.
Pushing source to main does not update an installed machine.

`tavern-release/v2` binds all three archives and five delivery concerns to one
source commit/digest: Tavern, Story Profile, MCP, skills and managed AGENTS.
Use Hermes' Python interpreter (PyYAML is required), Node 20+ and npm:

```sh
python3 ops/updater/update.py --hermes-home /opt/data review --release-dir /path/to/bundle --manifest-sha256 <sha256>
python3 ops/updater/update.py --hermes-home /opt/data apply --transaction <review-path> --expected-plan <digest> --confirm
```

Review is required before apply. Candidate bundles require explicitly authorized
testing and `--allow-candidate`. Backups/receipts are private and remain on the
installation host. Worlds, chats, keys and unrelated host configuration are not
release payloads. The default updater replaces whole reviewed program directories
and project state. Python productions are converted on a private copy; current
Node data is validated without a version migration. Incompatible Python records
are preserved with a pending-conversion report, not a veto on program installation.
A World imports only with valid dependencies and history. Backup/checksum failures,
unsafe paths, ambiguous installations and unknown process ownership still stop apply.

A successful install reports `installed-awaiting-hermes-reload`: the owner sends
`/restart` in ClawChat, then verifies the MCP and skill/AGENTS context after
Hermes restarts. The updater does not restart its own parent Hermes. It retains
the two existing Liveware App IDs and updates their binding/launcher metadata;
an update does not create a second Tavern or Story Profile App.
See [compatibility and recovery](ops/skills/system/tavern-updater/references/release-compatibility.md).

Pushing this branch does not publish a GitHub Release. Packaging also emits the
installer and Bootstrap assets used by the original Python updater skill. Publish
them with the full bundle to enable first adoption. Bootstrap refreshes only the
updater before review; an approved apply switches app, MCP, skills, state and
managed AGENTS together. Keep a maintenance window and recovery until acceptance.
