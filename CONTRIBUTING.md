# Core development

Edit authored core source in this repository. `tooling/source-layout.json` maps it to the established installed layout; generated views and installed resources are not additional author copies. The core runtime depends on a fixed shared maintenance input declared in `tooling/maintenance-input.lock.json`.

## Prepare

Use real Node.js 24 with npm, Python 3.11+ and tar. The root npm lock is for core development tools; production maintenance dependencies come from the fixed external input and are not regenerated from development dependencies.

Run from the Git repository root. Use a Python 3.11 interpreter explicitly;
the system `python3` on macOS may be an older version. These are development
dependencies, separate from Hermes' installed runtime.

macOS / Linux:

```sh
node -v
python3.11 --version
npm ci
node tooling/maintenance-input.mjs fetch
python3.11 -m venv .cache/test-venv
.cache/test-venv/bin/python -m pip install -r requirements-core-test.txt
export NORA_TEST_PYTHON="$PWD/.cache/test-venv/bin/python"
npm --prefix app/engine/sillytavern ci
npm --prefix nora-mcp ci
```

Windows PowerShell (with Python 3.11 registered in the Python launcher):

```powershell
node -v
py -3.11 --version
npm.cmd ci
node tooling/maintenance-input.mjs fetch
py -3.11 -m venv .cache/test-venv
& .\.cache\test-venv\Scripts\python.exe -m pip install -r requirements-core-test.txt
$env:NORA_TEST_PYTHON = (Resolve-Path .\.cache\test-venv\Scripts\python.exe).Path
npm.cmd --prefix app/engine/sillytavern ci
npm.cmd --prefix nora-mcp ci
```

If the Python launcher is unavailable, invoke the absolute installed Python 3.11
executable to create the same venv. Stop on a failed command before continuing;
PowerShell does not turn every native program's nonzero exit into an exception.

`NORA_TEST_PYTHON` selects the qualified interpreter. `NORA_MAINTENANCE_CACHE` may select a verified artifact cache; it must not be a source checkout. Fetching is explicit; normal source projection never discovers a latest input or falls back to another repository.

## Local run and debug

To build and run the authored Tavern checkout, use a private test data directory
and free port. The example below uses `.cache/dev-tavern-data` and port 18899;
change the port if occupied. User installation is documented separately in the
[source installation guide](docs/install-tavern.md). From the repository root:

```sh
npm --prefix app/engine/sillytavern run build:nora
npm --prefix app/engine/sillytavern start -- --dataRoot "$PWD/.cache/dev-tavern-data" --port 18899
```

Use `npm.cmd` for these commands in PowerShell. Stop with Ctrl+C. For Node
debugging, replace the start command with
`npm --prefix app/engine/sillytavern run debug -- --dataRoot "$PWD/.cache/dev-tavern-data" --port 18899`;
it starts the existing inspector entry with the same isolated data and port.
Do not start a second server against user data to debug an installed instance.
MCP has a separate stdio entry and requires explicit instance configuration;
follow [nora-mcp/README.md](nora-mcp/README.md#实例配置), not a bare server launch.

## Test and run

Choose the level needed for the change; the rows below are not a requirement to
repeat every narrower suite after the full gate has passed.

| Entry | Evidence provided | Output |
| --- | --- | --- |
| Root `npm test` | Core ownership, fixed-input and documentation contracts; not all product tests | Console result |
| `node tooling/checks/verify-core.mjs` | Deployment `.test.cjs` and `.test.mjs` plus Python consumer suites using one projected source identity | `.cache/core-source-result.json` and referenced run receipts |
| `node tooling/checks/core-source-gate.mjs` | Backup safety, fixed-input/release contracts, deployment consumers, full MCP unit/integration suites, Story Profile Python tests and Tavern workflows | `.cache/core-qualification.json` plus the source result |
| `node tooling/checks/verify-core.mjs --native` | Actual Hermes interpreter's lock/executor profile; requires its Python and read-only Hermes source | `.cache/core-native-result.json` |
| `node tooling/release/build-core.mjs --output NEW_DIRECTORY` | Committed source plus the fixed runtime and disposable native installation/model-fixture acceptance | The requested output's acceptance and native receipts |

Real model providers, account pairing, historical upgrades, interruptions and
remote entry access need their own applicable target-environment evidence.
Fixture success, source success and deployed user success are separate states.
Documentation-only edits need the relevant document/reference checks, not a
three-platform product rebuild.

Examples of the existing entries, not a mandatory sequential checklist:

```sh
npm test
node tooling/checks/verify-core.mjs
node tooling/checks/core-source-gate.mjs
node tooling/run.mjs node --test tests/deployment/core_releases.test.cjs
node tooling/run.mjs python -B -m unittest tests.deployment.test_first_install tests.deployment.test_nora_system
node tooling/run.mjs npm --prefix app/engine/sillytavern run test:nora
```

Deployment helpers run in the disposable installed-layout view generated by `tooling/run.mjs`. The actual core and tests cross the same shared execution interface. Keep unit fixtures, actual native executors, complete installations and external-account acceptance separate. Run native process-inspection suites sequentially on a host; paths alone cannot isolate their process-table observations.

For the native profile set `NORA_TEST_PYTHON` to the restored Hermes venv's actual
executable and `NORA_TEST_HERMES` to that interpreter's Hermes source directory.
Keep them different from the small development venv above, and restore the
development selection afterward. See the [acceptance navigation](tests/deployment/README-nora-acceptance.md)
for provider-specific prerequisites; missing inputs and skips do not count as passes.

For Story Profile, edit `story-profile/` and explicitly run the engine's `sync:story-profile` and `check:story-profile-source` scripts. Do not edit `app/story_profile_runtime/` independently.

## Accepted native core construction

After committing the source and passing `core-source-gate.mjs`, fetch the fixed native runtime and construct/accept the core without a desktop dependency:

```sh
node tooling/runtime/runtime-inputs.mjs fetch
node tooling/release/build-core.mjs --output "$PWD/.cache/accepted-core-new"
```

The output must be new. This entry tests a disposable installation with the real sealed interpreter, requires actual child closure, and records source/input/package digests. It does not publish and does not establish historical upgrade or external-account acceptance. Three platform outputs are assembled and published separately as documented in the release process.

In PowerShell pass an explicit new absolute output path, for example
`node tooling/release/build-core.mjs --output (Join-Path $PWD '.cache\accepted-core-new')`.
Keep one-time logs and redacted acceptance summaries under ignored `local-state/`;
do not commit caches or private runtime data to make evidence links portable.

## Build

Run the core packager from this Git checkout:

```sh
node tooling/release/package-release.mjs --candidate --components-only
node tooling/release/package-release.mjs --candidate --hermes-runtime-manifest /absolute/path/to/nora-hermes-runtime.json
```

The first command builds core archives/modules. The second also verifies and includes the selected runtime and creates `core-payload/` plus platform system metadata. Both build Tavern/MCP and preserve existing installed paths, source hashes, file allowlists and dependency receipts. The packager does not execute tests; its manifest says `packaging-only`.

Candidate mode includes unignored source and records dirty status. Stable construction requires a clean committed tree. Construction never constitutes publication permission; pushing, uploading, tagging and promotion require explicit authorization and exact accepted artifacts. Do not commit credentials, runtime homes, dependencies, logs or release outputs.

See [core maintenance](docs/core-maintenance.md), [source map](docs/REPOSITORY.md), and [release process](docs/release-process.md).
