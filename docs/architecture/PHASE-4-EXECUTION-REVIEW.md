# Phase 4 Execution Review

Completed: 2026-08-29

Plan source: `docs/architecture/NORA-TAVERN-WORLD-CORE-REFACTOR-PLAN.md`

## Outcome

Phase 4 implements feature-gated asynchronous capability readiness for World Core v2. Base World activation completes before Regex, Tavern Helper, or MVU readiness. Each capability owns a durable attempt with timing, stable error data, and positive readiness evidence. A failed capability degrades only the Capability Set and never changes a READY World lifecycle.

The implementation is built and technically verified locally. The v2 feature flag remains off by default. No remote deployment, target-browser extension execution, or user acceptance was performed.

## Scope Lock

All existing right-panel controls and interaction paths were preserved: My Character, resident characters, Worldbook, character library, curator links, and model settings. Phase 4 adds only a small v2-only “Enhanced Capabilities” status section and a retry button for each DEGRADED item. It does not perform the broader Phase 5 UI/startup cleanup.

## Plan Comparison

| Planned Phase 4 item | Implementation evidence | Verification |
| --- | --- | --- |
| One capability loading owner | `world-capability-controller.js`, composed only by `world-core-runtime.js` | Contract forbids Nora UI controllers from calling the ST readiness adapter directly |
| Regex readiness | `ensureCharacterCapability(character, 'regex')` | Requires active Regex extension, non-empty script inventory and character authorization |
| Tavern Helper readiness | `ensureCharacterCapability(character, 'tavern_helper')` | Activates only JS-Slash-Runner and proves script inventory/authorization |
| Managed/embedded MVU readiness | MVU adapter branch | Requires declared source, Helper dependency and visible `getMvuData` interface |
| Per-item status, time and error code | World manifest capability attempt fields | Core transition test verifies duration, attempts, error code and evidence |
| DOM-coupling compatibility matrix | `COMPLEX-CARD-COMPATIBILITY-MATRIX.md` | Explicit Adapter/Matrix/Unsupported policy recorded |
| Single-item retry | v2 Core routes/client/controller and right-panel retry button | MVU-only retry reaches READY without base activation or other capability reruns |

## Durable Capability State

`beginCapabilityAttempt()` atomically assigns a new attempt identity, increments attempts and sets only that item to PENDING. `settleCapabilityAttempt()` accepts READY or DEGRADED only for the current attempt. A stale cross-tab or earlier-browser result receives `NORA_CAPABILITY_ATTEMPT_CONFLICT` and cannot overwrite a newer retry.

Each item records:

- `status`, `attempts`, and `attempt_id`;
- `started_at`, `updated_at`, and `duration_ms`;
- stable `error.code`, safe message, and retryability;
- positive `evidence` for READY or failure diagnostics for DEGRADED.

The aggregate is derived from item states. `World.lifecycle` remains READY throughout capability timeout, degradation, and retry.

## Loading Ownership And Ordering

The v2 browser controller authorizes the Runtime Card once and checks capabilities in deterministic dependency order:

1. Tavern Helper / JS-Slash-Runner.
2. Regex.
3. MVU.

The ST adapter separates capability inspection from extension activation. Regex starts neither script runtime; Helper starts no managed MVU; MVU starts its own declared runtime and proves the public variable-data interface. Startup, World selection, and imported-World paths all delegate v2 loading to this controller.

## User-Visible Behaviour

- World base activation and interaction resolve before capability work settles.
- A PENDING World shows that enhanced capabilities are loading.
- A DEGRADED World remains open and usable.
- The existing right panel shows each declared capability as loading, ready, or unavailable.
- Only a DEGRADED item receives a retry control; retry does not reopen or recreate the World.
- UI wording maps stable Nora error codes and does not display raw ST globals or polling exceptions.

## Verification Evidence

- Full Nora suite: 227/227 passed.
- Repository contracts after final production build: 24/24 passed.
- Capability controller: dependency order, one authorization, failure settlement and one-item retry pass.
- ST readiness adapters: Regex, Tavern Helper, embedded MVU, authorization error, and isolated dependency activation pass.
- Vertical capability integration: base plan -> three capability attempts -> MVU DEGRADED -> MVU-only retry -> aggregate READY passes.
- v2 selection timing test proves base activation resolves while capability work is still pending.
- Real-card backend vertical smoke: 2/2 existing MVU V3 cards still materialize one World, one Session, Worldbook bindings, and all three declarations.
- Changed engine source lint: zero errors; warnings are the existing Playwright plugin not recognizing Node `assert` tests.
- Native UI module syntax and UI contracts pass.
- Production Nora bundle rebuilt; startup asset budget contract passes.

## Exit-Criteria Comparison

| Phase 4 exit condition | Local technical result | Target-environment result |
| --- | --- | --- |
| MVU timeout only degrades capabilities | Met by Core/controller vertical integration; World remains READY | Not yet demonstrated remotely |
| MVU loaded/not-loaded is explicit | READY requires visible `getMvuData` evidence; timeout persists `NORA_MVU_TIMEOUT` | Not yet demonstrated in a real target browser |
| Regex, script, Worldbook and MVU have end-to-end assertions | Met by vertical integration plus ST adapter and real-card materialization smoke | Real extension behaviour still requires Phase 7 browser certification |
| User can retry one capability | Minimal v2 status/retry control and MVU-only retry path implemented | Not yet user-accepted remotely |

## Explicit Limits And Deferrals

- `nora.worldCoreV2.enabled` remains `false` by default.
- Old v1 World paths still contain browser transactions, recent-chat projection, and blocking readiness; they remain only for the migration window and are not claimed fixed by Phase 4.
- Real browser execution of proprietary embedded scripts and arbitrary DOM-coupled extensions is not certified by headless tests.
- Generic ST DOM-targeting scripts and top-level injected controls are not implicitly supported.
- Full progress/repair UI, startup owner cleanup, lazy loading, and visual regression are Phase 5.
- v1/v2 migration and old-path removal are Phase 6.
- Remote rollout, timing collection and user verification are Phase 7.

## Evidence Level

- Analyzed: yes.
- Implemented: yes.
- Technically verified locally: yes.
- User-outcome verified in the target environment: no.
- Deployed: no.
