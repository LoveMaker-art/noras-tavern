# Phase 7 Preflight Review

Prepared locally: 2026-08-29

Plan source: `docs/architecture/NORA-TAVERN-WORLD-CORE-REFACTOR-PLAN.md`

## Outcome

The missing preconditions for a defensible remote grey rollout are now implemented locally. World delete and repair are durable backend commands rather than UI patches. The Store owns reference and ownership decisions, the ST adapter owns physical inspection/deletion, and browser callers carry only `worldId` plus an idempotency key.

The local production build and full Nora suite pass. On 2026-08-29 the Phase 7 source was deployed directly to the test remote after a full runtime/state backup and three isolated candidate revisions. Production remains on the legacy read path: real v2 data was not migrated and `nora.worldCoreV2.enabled` remains `false`.

## Deep Module Interface

The `NoraWorldCore` module adds only two caller-visible operations:

- `deleteWorld(worldId, { idempotencyKey })`
- `repairWorld(worldId, { idempotencyKey })`

The implementation hides journal stages, locks, tombstones, reference lookup, binding validation, filesystem paths and retry compensation. This follows the codebase-design depth criterion: removing the module would force that complexity back into the route, Runtime and UI callers.

## Delete Semantics

- A durable `DELETE_WORLD` operation records `RECEIVED`, `WORLD_MARKED_DELETING`, `RESOURCES_RELEASED` and `COMPLETED`.
- A failed adapter call leaves the operation retryable at its last durable stage.
- Completion writes a `DELETED` tombstone; the authoritative list filters it out.
- Story Sessions are released only when their binding belongs solely to the target World.
- Runtime Card and Knowledge Resources are physically deleted only when ownership is `owned` and no other active World references the resource.
- Shared and external resources are never physically deleted.
- Missing files during retry count as already released; symlinks and non-regular files are refused.

## Repair Semantics

- A durable `REPAIR_WORLD` operation checks Runtime Card existence, Story Session JSONL identity projection, Knowledge Resource JSON validity and duplicate bindings.
- `READY` is restored only when all evidence passes.
- Remaining defects persist `FAILED` plus `NORA_WORLD_NEEDS_REPAIR`; the same operation can be retried after the underlying resource is restored.
- Repair never invents a World, changes a binding, reimports a card or deletes data.

## Caller Changes

- HTTP exposes `POST /worlds/:worldId/repair` and `DELETE /worlds/:worldId` behind the existing v2 feature flag.
- Operation errors expose only stable operation and World identities, not paths or private bindings.
- Browser client and Runtime execute the backend commands and refresh the authoritative list.
- Nora UI provides a compact delete control with Nora confirmation and uses the backend repair command for “重新检查”.

## Local Verification

- Production Nora build: passed; Story Profile sync changed zero files.
- Full Nora behaviour tests: 205/205 passed.
- Repository architecture/product contracts: 24/24 passed.
- Real ST materializer lifecycle test: repair evidence passed; owned Runtime Card and Session were deleted; shared Worldbook survived.
- Failed delete retry: resumed from `WORLD_MARKED_DELETING` and completed without recreating the World.
- Failed repair retry: persisted `NORA_WORLD_NEEDS_REPAIR`, then restored `READY` through the same operation.
- Backend and browser World Core ESLint: zero errors.
- Native World UI ESLint: zero errors.

## Remote Grey-Rollout Gate

The next authorized target-environment sequence is:

1. establish a current SSH connection and inspect the managed updater/runtime paths;
2. create a timestamped release and persistent-data backup;
3. deploy through the managed Tavern updater while preserving the previous release;
4. run migration analysis only and review every category plus reconciliation;
5. apply migration only with an explicit backup root and zero unexplained differences;
6. enable `nora.worldCoreV2.enabled`, restart separately and verify health;
7. test cold import, duplicate import, refresh, open, delete, restart and capability degradation with real complex cards;
8. record P50/P95 milestones and rehearse read-path rollback without deleting v2 data.

## Evidence Level

- Analyzed: yes.
- Implemented: yes.
- Technically verified locally: yes.
- Target-environment user outcome verified: no.
- Deployed: no.

The source deployment is active on the test remote and the previous runtime remains available for rollback. The isolated copy verified migration reconciliation, durable repair recovery, open planning, deletion, restart persistence and idempotent complex-card import. Real-data migration, production flag enablement and user-visible browser acceptance remain pending explicit authorization.
