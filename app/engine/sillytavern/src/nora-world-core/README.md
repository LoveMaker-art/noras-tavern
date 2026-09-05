# NoraWorldCore

`NoraWorldCore` is the authoritative backend module for Nora World identity and creation state. It deliberately has no browser, ST DOM, route, or UI dependency.

## Interface

Callers import `createNoraWorldCore()` from `index.js` and receive twelve operations:

- `submitWorld(command, { idempotencyKey })`
- `createWorld(command, { idempotencyKey })`
- `retryOperation(operationId)`
- `getOperation(operationId)`
- `getWorld(worldId)`
- `listWorlds()`
- `prepareOpen(worldId)`
- `deleteWorld(worldId, { idempotencyKey })`
- `repairWorld(worldId, { idempotencyKey })`
- `beginCapabilityAttempt(worldId, capability)`
- `settleCapabilityAttempt(worldId, capability, attemptId, result)`
- `inspectWorld(worldId)`

Callers do not coordinate manifest files, revisions, locks, resource references, or journal stages.

## Materializer Seam

The composition root supplies a materializer with:

```js
materialize(command, identities) -> MaterializationResult
releaseStagedInput(command) -> void // optional, after the input is durably unnecessary
inspect(world) -> RepairEvidence
deleteResources(world, deletionPlan) -> DeletionResult
```

The production ST backend adapter is Phase 2. Phase 1 tests use a local in-memory adapter. Materialization must be idempotent for the supplied `operationId`; a process can stop after the compatibility engine creates a resource but before the journal advances. World Core calls `releaseStagedInput()` only after the materialization result is durable or after a non-retryable failure is durable. The journal records `input_released_at`; startup retries any unfinished release, so staged uploads do not accumulate and crash recovery remains possible.

The command `payload` is persisted for retry. It may contain durable non-secret staging references, but never raw card bytes, provider credentials, authentication headers, or ephemeral browser objects.

## ST Backend Materializer

Phase 2 provides `createStBackendMaterializer()` in `st-backend-materializer.js`. Its external interface remains the single `materialize(command, identities)` method required by World Core. It hides:

- canonical PNG/JSON/CHARX card decoding through `st-card-codec.js`;
- source digest and staging-root verification;
- Regex, Tavern Helper and MVU structural preflight;
- deterministic Runtime Card and Story Session bindings;
- canonical header/first-message JSONL serialization;
- embedded Worldbook conversion, content-addressed reuse and collision-safe naming;
- owned-resource compensation without deleting external or shared resources.

The durable command payload shape is:

```json
{
  "staged_card": {
    "path": "/absolute/path/below/the/configured/staging/root/card.png",
    "format": "png"
  }
}
```

The materializer resolves both paths through the filesystem before reading, rejects symlink escapes, verifies the binary SHA-256 against `command.source.sha256`, and requires the staged format to match the command format.

Worldbook reuse is based on canonical content SHA-256, never name alone. Nora-created embedded Worldbooks are marked shared. Existing unmarked matching books are external. Failure compensation deletes only unchanged Runtime Card and Session files created by the failing operation; shared and external Worldbooks are preserved.

## Persistence

```text
root/
  worlds/                 authoritative schema v2 manifests
  operations/             durable create-operation journals
  mutations/              durable delete/repair-operation journals
  quarantine/worlds/      invalid World manifests
  quarantine/operations/  invalid operation journals
  quarantine/mutations/   invalid mutation journals
```

Writes use same-directory temporary files, file sync, atomic rename, and best-effort directory sync. The Store scans once during initialization and serves reads from memory afterward.

## Invariants

- A World ID, Story Session ID, and Resource ID are Nora identities, not ST bindings.
- The same idempotency key and command resolve to one operation and one World.
- Reusing an idempotency key with another command is a conflict.
- A new idempotency key may intentionally create another World from the same source SHA.
- Owned resources receive operation-scoped IDs; shared and external resources receive binding-derived IDs.
- One resource ID cannot point to conflicting engine bindings.
- `READY` means the base World is durable; declared capabilities begin independently as `PENDING`.
- A committed manifest is sufficient to complete an interrupted journal without materializing again.
- The manifest stores its import operation identity and command digest together, so a missing or quarantined journal can be rebuilt without weakening idempotency.
- Delete and repair are backend commands with durable stages, stable idempotency and retry through the same operation interface.
- Deleted Worlds remain as tombstones for operation recovery but are absent from the authoritative list.
- Physical deletion plans are computed from backend reference state; callers cannot supply ownership or paths.
- Shared and external resources are never physically deleted by World deletion.

## Phase 3 HTTP And Activation Boundary

`/api/nora-worlds-v2` exposes feature-gated import, operation, authoritative list, and open-plan routes. API operation projections never expose the durable command or local staging path. The browser v2 client persists one pending import key across page refresh, polls the durable operation, and executes only the returned Activation Plan.

Base activation verifies World ID, Story Session ID, Runtime Card avatar, and chat ID from the active ST chat. Capability preparation is explicitly outside that base transaction and cannot turn MVU delay into a World-open failure.

## Phase 4 Capability Boundary

The browser `world-capability-controller.js` is the single v2 loading owner. It authorizes once, then evaluates declared capabilities in dependency order (`tavern_helper`, `regex`, `mvu`). Each capability starts and settles its own durable attempt through World Core.

Capability items persist attempt count and identity, timestamps, duration, stable error data, and readiness evidence. `READY` requires evidence. A stale attempt cannot overwrite a newer retry. Aggregate status is derived from items, while `World.lifecycle` remains `READY` when a capability becomes `DEGRADED`.

The ST card adapter provides separate readiness contracts:

- Regex: active extension, script inventory, and per-card authorization.
- Tavern Helper: JS-Slash-Runner activation, script inventory, and per-card authorization.
- MVU: declared runtime source, Helper dependency, and visible `getMvuData` interface.

## Phase 6 Migration Boundary

`legacy-migration.js` scans the v1 registry, chat metadata and ST resources into an auditable report before any v2 write. It distinguishes normal data, duplicate bindings, intentional same-source Worlds, orphan cards/chats, missing Worldbooks, empty chats and corrupt records. Normal candidates receive additive v2 manifests; conflicts receive a durable `NORA_WORLD_NEEDS_REPAIR` lifecycle error and are never silently merged or deleted.

`ops/scripts/migrate-nora-worlds-v2.mjs` defaults to analysis only. Applying manifests requires both `--apply` and an explicit backup root. It copies the affected legacy and v2 data before writing and never deletes v1 data. Apply also atomically projects the derived Story Session ID into a bound legacy chat when that projection is absent; a conflicting projection is a repair failure rather than an identity claim in the browser.

The legacy server and browser readers are now read-only. The provisional World, claim-on-open, old import journal and browser-side creation transactions have been removed. Story Profile resolves authoritative v2 Worlds by default and retains only an explicit read-only v1 fallback for the rollback window.

## Phase 7 Mutation Boundary

World deletion and repair now cross the same deep `NoraWorldCore` interface as import and open. `DELETE_WORLD` persists `RECEIVED -> WORLD_MARKED_DELETING -> RESOURCES_RELEASED -> COMPLETED`; a crash or adapter failure resumes from its durable stage. The Store computes the deletion plan from current references and ownership. The ST adapter deletes only regular, binding-derived owned files and treats a missing file during retry as already released.

`REPAIR_WORLD` performs a non-destructive inspection of Runtime Card, Story Session metadata, Knowledge Resources and binding conflicts. A World returns to `READY` only with positive filesystem and identity evidence. Otherwise the operation remains failed and retryable with `NORA_WORLD_NEEDS_REPAIR`.

V2 edit commands, target-browser certification and remote rollout remain later work.
