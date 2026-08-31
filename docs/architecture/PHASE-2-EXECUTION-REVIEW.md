# Phase 2 Execution Review

Date: 2026-08-28

Plan source: `docs/architecture/NORA-TAVERN-WORLD-CORE-REFACTOR-PLAN.md`

## Outcome

Phase 2 implements a browser-independent ST backend materializer behind the Phase 1 `NoraWorldCore` materializer seam. It can decode a staged character card, preflight complex-card capabilities, create a deterministic Runtime Card, materialize an embedded Worldbook with collision-safe semantics, create a canonical initial Story Session, and return stable ST bindings for the authoritative schema-v2 World manifest.

The implementation is locally implemented and technically verified. Existing HTTP routes and browser import/open flows do not call it yet; that vertical integration is Phase 3.

## Deep-Module Interface

The external interface is one method:

```js
materialize(command, identities) -> MaterializationResult
```

Callers do not choose ST filenames, serialize chats, convert Worldbooks, detect MVU, decide ownership, coordinate collision handling, or run compensation. Those decisions remain local to `st-backend-materializer.js` and `st-card-codec.js`.

## Plan Comparison

| Planned Phase 2 item | Implementation evidence | Verification |
| --- | --- | --- |
| Encapsulate canonical character parsing | `st-card-codec.js` | Real V3 PNG cards decoded through the existing ST parser |
| Canonical Runtime Card materialization | `st-backend-materializer.js` | Runtime PNG exists and is readable by the canonical parser |
| Canonical initial chat serialization | `st-backend-materializer.js` | Header, World/Session metadata, first message and swipes verified |
| Explicit empty opening | `st-backend-materializer.js` | Empty card creates one header line and `opening_state: empty` |
| Worldbook conversion and binding | `convertEmbeddedBook()` | Twenty-entry real-card books persist with stable ST names |
| Collision-safe Worldbook naming | content SHA plus deterministic suffix | Same name/different content produces two files, never silent aliasing |
| Capability preflight | `inspectStCard()` | Regex, Tavern Helper and embedded/managed MVU declarations are separated |
| Resource ownership | materialization result and Nora resource marker | Runtime Card is owned; Nora books shared; unmarked books external |
| Safe compensation | guarded content hashes | Owned card/session files are removed; external/shared books are preserved |
| No browser requirement | Core seam contract | No DOM, browser globals, jQuery or public runtime imports |

## Real-Card Evidence

The reusable smoke runner `ops/scripts/smoke-st-world-materializer.mjs` completed full backend World creation for five existing V3 PNG cards without a browser:

| Card | Opening | Worldbook | Preflight |
| --- | --- | --- | --- |
| 维多利亚时代 | message | 新生活风尚, 20 entries | baseline |
| 新风尚 | empty | 1新风尚, 20 entries | baseline |
| 作为机娘生活吧 2.0 MVU | message | 作为机娘生活吧 2.0 | MVU, Regex, Tavern Helper |
| 噬血狂袭 夜之帝国 | message | 噬血狂袭 夜之帝国 | MVU, Regex, Tavern Helper |
| 废土机娘 MVUZOD 3.7 lite | message | 废土机娘 3.7 | MVU, Regex, Tavern Helper |

The proprietary binaries remain outside Git. The committed sanitized fixture preserves the complex extension and Worldbook structures needed for repeatable automated tests.

## Test Evidence

- Full Nora test suite: 206/206 passed.
- Repository static contracts: 23/23 passed.
- Targeted Phase 1–2 core suite: 25/25 passed.
- Phase 2 module tests: 12/12 passed.
- New source lint: zero errors; the test plugin reports only its existing Node-assert detection warnings.
- Real-card backend smoke: 5/5 passed.

The generated local `config.yaml` used by the full contract runner was removed after verification.

## Exit-Criteria Comparison

| Phase 2 exit condition | Result |
| --- | --- |
| Materialize Runtime Card without opening a browser | Met |
| Materialize embedded Worldbook without opening a browser | Met |
| Create legal initial Story Session without opening a browser | Met |
| Empty first message produces explicit empty opening | Met |
| Same-name unrelated Worldbooks never silently reuse | Met |
| Compensation never deletes external/shared resources | Met |

## Explicit Limits And Deferrals

- HTTP route/composition-root integration is Phase 3.
- Existing legacy registry/import/browser paths still exist and were not switched in Phase 2.
- Browser capability activation and READY/DEGRADED reporting are Phase 3–4.
- CHARX cards with auxiliary assets are rejected with `NORA_CARD_UNSUPPORTED_ASSETS` until those assets have authoritative Resource identities.
- V1 JSON requires canonical ST conversion and is explicitly rejected by this adapter; V2/V3 JSON is supported by the codec but was not promoted to certified status in this phase.
- Shared-resource deletion/garbage collection is not implemented; failure compensation deliberately preserves shared resources.
- No remote deployment or target-environment user workflow was performed.

## Evidence Level

- Analyzed: yes.
- Implemented: yes.
- Technically verified locally: yes.
- User-outcome verified in the integrated Tavern workflow: no; Phase 3 has not switched callers.
- Deployed: no.
