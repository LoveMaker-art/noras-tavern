# Phase 6 Execution Review

Completed locally: 2026-08-29

Plan source: `docs/architecture/NORA-TAVERN-WORLD-CORE-REFACTOR-PLAN.md`

## Outcome

Phase 6 establishes World manifest v2 as the only World write owner in source. The old registry remains available only through explicit read-only adapters during the rollback window. Browser code no longer creates World identities, claims a World during open, reconstructs Worlds from recent chats, writes chat metadata as a creation transaction, or submits to the old import journal.

The migration is intentionally non-destructive. Analysis is the default; apply requires an explicit backup root. Normal legacy records are converted additively, conflicts are preserved as `needs_repair`, existing v2 manifests are never overwritten, and no v1 file is deleted.

This is implemented and technically verified locally. No remote runtime data was migrated, the v2 feature flag remains off by default, and no deployment or target-environment user workflow was performed.

## Scope Lock

Preserved:

- all ST character cards, chats and Worldbooks;
- intentional multiple Worlds created from the same source card;
- v1 read access for a bounded rollback window;
- the Phase 3–5 v2 import, authoritative list, open and capability paths;
- Story Profile behaviour, now reading v2 World identity by default.

Changed:

- legacy data inspection and v1/v2 reconciliation;
- World write ownership;
- Story Profile World resolution;
- CLI import/status/doctor paths;
- obsolete tests and source contracts that required deleted v1 mutation behaviour.

Deferred:

- applying migration to target runtime data;
- v2 edit/delete and destructive resource reclamation;
- remote flag enablement, complex-card acceptance, performance measurement and rollback rehearsal (Phase 7).

## Migration And Reconciliation

`legacy-migration.js` reads three evidence sets: v1 registry records, chat-header Nora metadata and physical ST resources. It reports:

- normal World candidates;
- duplicate Runtime Card/Story Session bindings;
- intentional same-source multiple Worlds;
- orphan cards and orphan chats;
- missing Worldbooks;
- empty chats;
- corrupt registry or chat records;
- v1/v2 binding or source-digest disagreement.

Same-source Worlds are informational and remain separate. Binding collisions, missing required resources and identity disagreements become `needs_repair`; they are not guessed, merged or deleted. A second apply is idempotent, and an existing v2 World wins without being overwritten.

The report's reconciliation section classifies matched, repair-required, missing-from-v2, v2-only, binding-mismatch and unexplained identities. The fixture-based apply test reaches zero unexplained differences.

## Old-Path Retirement

Removed authored mutation systems:

- `src/nora-world-registry.js` and its claim/upsert/delete behaviour;
- `src/nora-import-registry.js` and `/api/nora-imports`;
- browser registry client and browser create/claim/save-metadata transaction;
- provisional/recent-chat World synthesis;
- old native import and reconciliation scripts;
- server-side legacy Worldbook materialization endpoint.

The remaining `/api/nora-worlds` and `world-runtime.js` surfaces are strictly read-only. Mutation methods either do not exist or fail with `NORA_WORLD_V1_READ_ONLY`. The UI contains no inactive legacy delete control.

## CLI And Story Profile

`native_tavern.py` now submits card imports to `/api/nora-worlds-v2/imports`, polls the durable operation and uses the v2 list/open-plan for diagnostics. It accepts an idempotency key rather than a caller-created World ID.

Story Profile resolves the shared `NoraWorldCore` instance and loads the authoritative v2 World by default. Its old reader is an explicit compatibility fallback only; it cannot mutate World state.

## Plan Comparison

| Planned Phase 6 item | Implementation evidence | Local verification |
| --- | --- | --- |
| Scan old registry and chat metadata | `legacy-migration.js` and migration CLI | classifier fixture covers registry, chat and physical resources |
| Classify all named legacy states | migration report categories and repair issues | category assertions pass |
| Convert normal data; preserve conflicts | additive Store writes and `NORA_WORLD_NEEDS_REPAIR` lifecycle | idempotency and no-overwrite tests pass |
| Temporary v1/v2 comparison | reconciliation report plus read-only v1 adapters | fixture reconciliation has no unexplained differences |
| All new writes only v2 | v1 mutation modules/routes removed; v2 import is the only create command | Phase 6 boundary contract passes |
| Delete provisional/claim/import/browser transactions | deleted source and UI recent-chat state | source-boundary search contract passes |

## Verification Evidence

- Full Nora behaviour tests: 198/198 passed.
- Repository architecture and product contracts: 24/24 passed.
- Phase 6 migration tests: classification, additive/idempotent apply and existing-v2 conflict preservation passed.
- Phase 6 boundary tests: one writer, no recent-chat World synthesis, v2 Story Profile default and read-only fallback passed.
- Changed backend source ESLint: zero errors; test files retain only the repository Playwright assertion-detector false-positive warnings for Node `assert` tests.
- Changed native UI source ESLint with browser/module environment: zero errors.
- Python CLI bytecode compilation: passed.
- `git diff --check`: passed before final build/index refresh and is rerun afterward.

## Exit-Criteria Comparison

| Phase 6 exit condition | Local technical result | Target-runtime result |
| --- | --- | --- |
| v1/v2 reconciliation has no unexplained differences | Met for deterministic migration fixtures; conflicts are explicitly classified | Target data not yet scanned or applied |
| Only one World write owner | Met in authored runtime source: World Core v2 | Not yet activated remotely because flag remains off |
| No UI-generated World ID or recent-chat pseudo World | Met by implementation and source contract | Not yet demonstrated in target browser |

## Evidence Level

- Analyzed: yes.
- Implemented: yes.
- Technically verified locally: yes.
- User-outcome verified in the target environment: no.
- Deployed: no.

Phase 7 must not be described as complete until the target data is backed up and scanned, v2 is enabled in grey rollout, missing v2 delete/repair command semantics are implemented, and the real import/open/refresh/restart/performance workflows are demonstrated.
