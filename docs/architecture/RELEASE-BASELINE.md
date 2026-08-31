# Nora Tavern Local Release Baseline

> Latest local working-tree hardening: [2026-08-30 execution record](RELEASE-HARDENING-2026-08-30.md).
> That candidate has not been committed or deployed and is not a stable release.

> Historical release evidence, not approval of `main@9f0ba72`.
> The [2026-08-30 audit](TAVERN-RELEASE-AUDIT-2026-08-30.md) found current failing
> checks and release blockers. Do not reuse earlier green results for a new candidate.

> Prepared: 2026-08-29
> Scope: current `nora-tavern/tavern` repository only
> Runtime implementation commit: `63b80dd` (`refactor: remove legacy UI hydration from Nora startup`)

## Outcome

The authoritative World Core v2 baseline and the Workstream F Liveware critical-path fixes are captured in Git. Runtime data, credentials, dependencies, caches and release archives are excluded by `.gitignore`; tracked Nora build artifacts are rebuilt from committed source.

The `63b80dd` runtime files are deployed on the 2026-08-29 target test remote and verified by source/build hashes, the content-addressed Brotli response, process health, World v2 status, persistent-data counts and post-start log inspection. Browser user-outcome and cold/warm P95 acceptance are still pending.

## Verification

- `npm run build:nora`: passed.
- Story Profile runtime synchronization: `changed=0`.
- Nora behaviour suite: 239/239 passed.
- Repository contracts: 25/25 passed.
- Five technical workflow gates: passed; browser strict mode remains intentionally unsatisfied without a browser report.
- Startup asset budget: passed with a 506,663-byte Brotli inline manifest.
- Staged diff whitespace check: passed before commit.
- Changed and untracked source scan found no committed credential material.

## Release Identity Rules

Every later release must record:

1. one Git commit and, for a deployed candidate, one annotated release tag;
2. a clean worktree before packaging;
3. successful Nora build, behaviour suite and repository contracts;
4. the target environment and deployed commit/tag;
5. whether persistent data was migrated, retained or restored;
6. the highest evidence level actually reached: built, technically verified, deployed or user-outcome verified.

Generated archives under `release/`, runtime state under `local-state/`, dependencies, logs and secrets are never release identity. A remote directory without a matching commit or tag is not a reproducible release.
