# Local Main Integration Verification

## Scope

Integrate local `main` at `551b28c384df669a7374154a318b7f15da7abe02`
with repository organization at `ff7fbdb0afd58d031a34cb5f6ae75cde4b36f6ed`.
The organization branch includes upstream main at
`9f19d7d999aa86a91c5d3b9b20f3b306b8abcd3f`.
This is local integration, not a GitHub publication or desktop deployment.

## Conflict Resolution

Upstream commit `7ad4ad83c0235f44a84d37188ed362afb50da1a6` reverted
independent character settings introduced by `175717a`.
Local commit `551b28c` built preset and guarded setting controls on that
feature. Its merge conflicted with upstream even before directory changes.

With explicit approval to retain the local features, commit `1031841`
restored the reverted feature on the organization branch. Merging `551b28c`
then required no manual source conflict resolution. Generated frontend
assets were rebuilt from the combined sources instead of choosing one
side's old bundle.

Preserved behavior:

- Independent character settings and stable character references.
- Explicit preset import/application, character and Worldbook switches,
  guarded setting deletion, and startup resume ordering.
- Upstream model configuration and locale-aware Tavern welcome behavior.
- Current launcher, Nora files, deployment logic and source directory layout.

No second implementation was added. Launcher, deployment, Nora and tooling
sources match the organization branch. Uncommitted experimental library
work remains outside this integration.

## Verification

- Repository layout and delivery projection: 8 tests passed.
- Character, preset, setting, World isolation and startup behavior:
  100 focused tests passed.
- Launcher release, update, location, model, uninstall and release-source
  contracts: 90 tests passed.
- Tavern welcome initialization and language selection: 7 tests passed.
- Managed context, initial install, incremental update, shared launcher
  logic, refinement and Windows path unit tests: 70 tests run,
  68 passed and 2 skipped.
- `npm --prefix app/engine/sillytavern run build:nora`: passed, with
  webpack asset-size warnings.
- Offline candidate packaging, including Tavern and MCP builds: passed.
- Isolated macOS arm64 bundle smoke: passed. It exercised actual Hermes
  and Tavern, source/package/installed persona parity, skill and Hook
  loading, MCP instance access, locale-aware welcome creation, optional
  sample import idempotency and cron execution against a local fixture.
  The test service was stopped and its temporary home cleaned up.
- Original working tree: hashes and path sets of all 58 modified/untracked
  files matched the pre-integration snapshot.

The first launcher test attempt lacked desktop dependencies in the new
worktree; installing locked dependencies resolved it. The welcome test
must run from `app/engine/sillytavern`, as its codec resolves the default
image relative to the engine working directory. It passed from that
directory. Neither issue required changing product code.

## Limits

No Windows or Intel Mac runtime test, interactive UI acceptance, real API
request, real ClawChat pairing, GitHub push or public release was performed.
The local smoke did not use personal credentials and leaves setup pending.
The candidate is a verification artifact, not a replacement installed app.
