# Phase 5 Execution Review

Completed: 2026-08-29

Plan source: `docs/architecture/NORA-TAVERN-WORLD-CORE-REFACTOR-PLAN.md`

## Outcome

Phase 5 switches the feature-gated World Core v2 UI and startup path to Nora product semantics. The v2 World list now comes only from authoritative manifests, the browser DOM carries only `worldId`, and the v2 World read model no longer exposes ST character indexes, avatar filenames, chat filenames, or raw manifests. World selection is the sole UI owner of base activation and supporting-content scheduling; capability execution remains the deep responsibility of the World Runtime.

Pending import recovery no longer blocks the authoritative World list. Durable progress is restored from the persisted operation pointer and backend journal, a failed operation has a visible retry path, an unavailable Runtime Card leaves its World visible in a repair state, and an empty Story Session renders a normal “story has not started” state.

The implementation is built and technically verified locally. The v2 feature flag remains off by default. No remote deployment, target-browser visual observation, or target-environment cold/hot timing was performed.

## UI Scope Lock

Preserved:

- World rail, new-World/import entry, chat, composer, right panel and responsive drawers;
- My Character, resident character, Worldbook, character library, curator, Story Profile and model controls;
- Nora message edit/regenerate/smart-reply interactions;
- existing v1 behaviour while the feature flag is disabled.

Changed only for World Core v2:

- World list source and read model;
- World selection DOM identity;
- import/open/capability ownership;
- import progress/retry, capability degradation/retry, Runtime Card repair, and empty-session presentation;
- startup prefetch policy and critical first-paint masking.

Deferred:

- v2 manual blank creation, library creation, edit and delete;
- v1 data migration and old-path deletion (Phase 6);
- remote timing, browser extension certification and rollout (Phase 7).

## Plan Comparison

| Planned Phase 5 item | Implementation evidence | Verification |
| --- | --- | --- |
| Delete registry + recent chats + provisional merge from the v2 list | `ui-store.js`, v2 branch in `world-controller.js`, conditional bootstrap | v2 store invokes `worlds.list()` with zero recent-chat arguments; v2 bootstrap does not read recent chats or build `initialWorld` |
| Unify startup/open/capability owner | `world-controller.js`, `startup-controller.js`, `world-creation-controller.js` | Startup contains no capability loader; import returns a World ID to `openById()`; source contract rejects duplicate owners |
| Persistent progress/degradation/repair/empty scene | `world-core-client.js`, `world-core-runtime.js`, rail/panel/message UI | refresh-recovery test, persisted capability tests, repair-state read-model test, empty-session read-model test |
| DOM interaction carries only World ID | rail rendering and event delegation | contract rejects `data-character` and `data-chat`; v2 Runtime resolves ST bindings internally |
| Delay noncritical work | v2 bootstrap, dynamic panel controllers, asynchronous supporting-content scheduling | bootstrap skips recent-chat/initial-chat prefetch; base selection resolves before Worldbook/capability completion |
| Prevent native first-paint leakage | critical inline CSS in `public/index.html` | shell contract requires undecorated reasoning, native edit and message controls to be hidden before deferred CSS |

## Interface Deepening

The browser-facing World interface now accepts World identity and returns a Nora read model:

- `list()` returns stable World identity and product status only;
- `activate(worldId)` and `ensureReady(worldId)` resolve the Activation Plan internally;
- `ensureCapabilities(worldId)` and `retryCapability(worldId, capability)` resolve Runtime Card bindings internally;
- `repair(worldId)` revalidates resources without recreating the World;
- `status()` and `subscribe()` expose operation progress without exposing storage or ST bindings;
- `usesRuntimeCard(character)` protects the existing character library without making the World rail depend on recent chats.

This is a deeper module than the Phase 4 surface: UI supplies one stable identity and the implementation hides manifest lookup, avatar matching, chat activation, pending-operation recovery and capability inputs.

## Startup And Recovery Behaviour

### Cold or hot list

`refresh()` first fetches and publishes the authoritative manifest list. If a persisted import exists, recovery starts in the background. Existing Worlds are therefore visible independently of operation polling, character request order, or chat request order.

### Import

The import controller submits one backend command and receives one World read model. It does not activate the Runtime Card or start capabilities. It passes only the returned World ID to the shared World Controller, which opens the World and schedules supporting content.

### Failure and repair

- A recoverable failed import remains durable and renders one retry action.
- A missing Runtime Card does not filter or delete the authoritative World; it renders “需要修复”.
- “重新检查” refreshes Runtime Cards and manifests. If the binding is still unavailable, the UI reports that the original card must be restored.
- Capability degradation remains independent and uses the Phase 4 per-item retry path.

### Empty Story Session

The read model exposes `openingState: empty`. With an active World and no visible messages, Nora displays “故事尚未开始” and invites the user to send the first message. It is not classified as an import or open failure.

## First-Paint Stability

Critical inline CSS now hides native ST message buttons, edit controls and reasoning details before the deferred Nora stylesheet is available. Reasoning becomes eligible for display only after the Nora message adapter marks it ready. Combined with the booting shell overlay, this prevents the known source-level race where a native thinking/edit state could be painted before Nora decoration.

This is technically verified by DOM/CSS contracts, not visually observed in a target browser; user-outcome verification remains open.

## Performance Evidence And Remaining Bottleneck

Code-level critical waits removed in Phase 5:

- v2 bootstrap no longer lists recent chats or builds the legacy initial-chat projection;
- World list no longer waits for pending import recovery;
- base World activation does not wait for Worldbook, Regex, Helper or MVU readiness;
- noncritical controllers and styles remain deferred.

The synthetic recovery contract proves list resolution while the recovery promise is still unsettled. Existing timing instrumentation separately records `app-ready`, `worlds.v2-list`, base activation, supporting Worldbook/capability steps, `nora-runtime-ready`, and `nora:usable`.

The remaining measurable cold-start bottleneck is the compatibility asset/evaluation chain, not World reconstruction:

| Critical artifact | Brotli bytes |
| --- | ---: |
| inline module manifest | 505,807 |
| legacy compatibility bundle | 112,679 |
| compiled core library | 203,337 |
| Nora entry | 32,552 |
| Total before runtime evaluation | 854,375 |

The repository budget contract passes (`inline-modules.json.br <= 550 KB`), but a real 5-second cold/hot claim cannot be made without Phase 7 target measurements. If the target still exceeds budget, the single remaining optimization seam is this compatibility bootstrap asset/evaluation chain, measured by the existing parser/manifest/legacy/module/app-ready milestones.

## Verification Evidence

- Production Nora build: passed; Story Profile runtime unchanged (`changed=0`).
- Full Nora test suite: 231/231 passed.
- Repository contracts: 24/24 passed.
- Phase 5 boundary tests: authoritative list before recovery completion; unavailable World retention; private ST binding fields; single owner; v2 store receives no recent chats.
- Changed engine and native UI source static checks: zero errors.
- Startup asset budget: passed with 505,807-byte Brotli inline manifest.
- `git diff --check`: recorded after index/report refresh.

## Exit-Criteria Comparison

| Phase 5 exit condition | Local technical result | Target-environment result |
| --- | --- | --- |
| UI does not lose Worlds because character/chat requests resolve in another order | Met: manifest list is authoritative and unavailable resources produce repair state | Not yet demonstrated remotely |
| Refresh does not expose native thinking/edit/error state | Critical CSS and message-adapter contracts pass | Visual refresh observation not yet performed |
| Cold/hot startup meets budget or has one measurable remaining bottleneck | World/recovery/capability waits removed; compatibility bootstrap chain isolated and milestone-instrumented | Actual 5-second cold/hot timing not yet measured |

## Evidence Level

- Analyzed: yes.
- Implemented: yes.
- Technically verified locally: yes.
- User-outcome verified in the target environment: no.
- Deployed: no.
