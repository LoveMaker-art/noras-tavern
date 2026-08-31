# Phase 3 Execution Review

Completed: 2026-08-29

Plan source: `docs/architecture/NORA-TAVERN-WORLD-CORE-REFACTOR-PLAN.md`

## Outcome

Phase 3 implements the feature-gated vertical slice “import one card -> one authoritative World -> base open”. The backend now owns upload staging, idempotent operation creation, ST resource materialization, schema-v2 World commit, authoritative listing, and Activation Plan creation. The browser sends one command, persists the pending operation across refresh, polls its result, and executes only the returned plan.

The slice is implemented, built, and technically verified locally. The default flag remains off. No remote deployment or target-environment user workflow was performed in this phase.

## Plan Comparison

| Planned Phase 3 item | Implementation evidence | Verification |
| --- | --- | --- |
| v2 import API | `src/endpoints/nora-worlds-v2.js` | Feature guard and sanitized response contract pass |
| Durable operation API | `NoraWorldCore.submitWorld()` and operation route | Receipt is persisted before background work; restart resumes RUNNING work |
| Authoritative v2 list | `GET /api/nora-worlds-v2/worlds` | Browser v2 runtime ignores its recent-chat argument |
| Open-plan API | `prepareOpen()` and `activation-plan.js` | Plan references one committed card, default Session and Knowledge set |
| One browser command | `world-core-client.js` | Multipart upload retries reuse the exact idempotency key |
| Refresh recovery | pending import in `sessionStorage` | A new client instance derives the same operation ID, tolerates a transient registration 404, and resumes polling |
| Browser executes only the plan | `executeStActivationPlan()` | No browser-side World, Session or Resource identity allocation |
| Verify World/Session/Card | active chat metadata plus avatar/chat checks | Mismatched World, Session, Runtime Card or chat rejects base activation |
| Base open independent from MVU | `world-core-runtime.js` and v2 branch in `world-controller.js` | Supporting Worldbook/capability work is scheduled after base activation |
| Old paths remain readable | existing v1 routers remain mounted | v2 composition does not call the legacy registry when the flag is on |
| New path writes only v2 | v2 runtime rejects unimplemented legacy create/edit/delete actions | Local-card import writes exclusively through the v2 backend command |

## Idempotency And Cleanup

- One idempotency key deterministically maps to one operation ID.
- Concurrent submission and transport retry join the same operation.
- The browser stores the pending key before upload; a page refresh recovers the accepted operation even when the response was lost.
- Completion clears the pending key, so an explicit later import receives a new key and may intentionally create a second World.
- The uploaded card is released only after `MATERIALIZED` is durable in the operation journal. Closing the page therefore does not accumulate successful staged uploads and does not weaken crash recovery.
- Public operation responses omit the durable command, idempotency hash, and local staging path.

## Real-Card Evidence

The Phase 2 smoke runner was upgraded to exercise the Phase 3 submission and open-plan path. Two existing MVU V3 PNG cards completed concurrent duplicate submission, operation polling, authoritative World lookup, Activation Plan generation, ST binding verification, and staged-upload release:

| Card | Result | Capabilities |
| --- | --- | --- |
| 废土机娘 MVUZOD 3.7 lite | one READY World, message opening, Worldbook bound | MVU, Regex, Tavern Helper |
| 电锯人 V3 MVU | one READY World, message opening, Worldbook bound | MVU, Regex, Tavern Helper |

The card binaries remain outside Git.

## Test Evidence

- Full Nora suite: 216/216 passed.
- Repository contracts: 23/23 passed after the final browser build.
- Targeted Phase 1–3 core/client/endpoint/materializer suite: 31/31 passed.
- Real-card v2 vertical smoke: 2/2 passed.
- Nora browser production build completed; `entry.js` and compressed companions were regenerated.
- Changed source lint: zero errors; warnings are the existing Playwright plugin not recognizing Node `assert` tests.
- `git diff --check`: passed.

## Exit-Criteria Comparison

| Phase 3 exit condition | Local technical result | Target-environment result |
| --- | --- | --- |
| Double click creates one World | Met by concurrent submit test | Not yet demonstrated remotely |
| Page refresh creates one World | Met by persisted pending-operation recovery test | Not yet demonstrated remotely |
| Network retry creates one World | Met by same-key transport retry test | Not yet demonstrated remotely |
| Explicit create-again creates a second World | Met by new-key/same-source core test | Not yet demonstrated remotely |
| Refresh list comes immediately from v2 | Met; v2 controller does not request or project recent chats | Not yet demonstrated remotely |
| Base open does not wait for MVU | Met; base binding verification completes before capability work | Not yet demonstrated remotely |

## Explicit Limits And Deferrals

- The flag `nora.worldCoreV2.enabled` defaults to `false`.
- Manual blank-World creation, creation from the existing card library, v2 edit, and v2 delete are not implemented in this vertical slice; under the flag they fail explicitly instead of writing through v1.
- Capability READY/DEGRADED persistence, timings, and per-capability retry are Phase 4.
- Full UI owner cleanup and removal of legacy recent-chat/registry code are Phase 5–6.
- Existing v1 data is not migrated into the v2 list in this phase.
- There is no remote deployment, browser visual acceptance, or user-outcome verification yet.

## Evidence Level

- Analyzed: yes.
- Implemented: yes.
- Technically verified locally: yes.
- User-outcome verified in the target environment: no.
- Deployed: no.
