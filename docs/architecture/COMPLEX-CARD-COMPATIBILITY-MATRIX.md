# Nora Tavern Complex Card Compatibility Matrix

> Status: Workstream D backend matrix verified locally; target-browser certification pending
> Date: 2026-08-29
> Scope: current `nora-tavern/tavern` only

## Purpose

Nora preserves ST compatibility through explicit contracts. “Supports ST extensions” means a format or capability has a named owner, an activation contract, fixtures, and an observable result; it does not mean every third-party DOM mutation is implicitly supported.

## Support Levels

| Level | Meaning | Release rule |
| --- | --- | --- |
| Certified | End-to-end fixture verifies import, open, use, refresh, and restart | May be advertised as supported |
| Adapter | Stable Nora adapter exists; representative fixtures pass | Supported with documented limits |
| Matrix | Requires per-extension verification because it depends on ST globals or DOM | Never advertised generically |
| Unsupported | Outside the accepted product boundary or unsafe | Import reports the limitation before activation |

## Card Containers

| Format | Current evidence | Target level | Phase 0 gap | Certification gate |
| --- | --- | --- | --- | --- |
| V2 PNG | Desensitized V2 PNG passes decode, materialization, Core restart/repair and deletion lifecycle | Certified | Browser open/send/refresh remains pending | Import once, reopen after restart, preserve card fields |
| V3 PNG | Desensitized V3 PNG and seven real V3 cards pass backend materialization and lifecycle | Certified | Browser capability activation and visual workflow remain pending | Preserve embedded extensions, Worldbook and greetings |
| JSON | Canonical V2/V3 fixtures pass codec, materialization, Core restart/repair and deletion lifecycle | Certified | Browser open/send/refresh remains pending; flattened V1-shaped JSON is explicitly unsupported | Same read model as PNG after import |
| CHARX | Desensitized no-auxiliary-asset CHARX passes backend lifecycle; auxiliary assets are explicitly rejected | Adapter | Auxiliary assets lack authoritative Resource identities | Parse, materialize resources, reject unsupported assets clearly |
| Corrupt/unknown | ST may reject at parser boundary | Certified rejection | Error currently leaks through mixed paths | Stable `NORA_CARD_INVALID`, no orphan resources |

## Story Content

| Capability | Current evidence | Target level | Required observable result |
| --- | --- | --- | --- |
| First message | ST inserts it only when non-empty | Certified | First message appears exactly once |
| Alternate greetings | ST maps them to swipes | Certified | Greeting selection/swipe survives refresh |
| Empty opening | Backend materializer creates a canonical header-only Session | Certified | Nora displays explicit empty-story state |
| Message edit | ST message adapter retained | Adapter | Edit persists in the active Story Session |
| Regenerate/swipe | ST generation runtime retained | Adapter | Operates on the active World only |
| Large history | ST chat storage retained | Adapter | World listing/opening does not scan all message bodies |

## Knowledge Resources

| Capability | Current evidence | Target level | Required observable result |
| --- | --- | --- | --- |
| No Worldbook | Normal ST card | Certified | World opens without creating a book |
| Embedded Worldbook | Phase 2 materializer converts and binds by content digest | Certified | Stable resource ID maps to collision-safe engine name |
| External Worldbook reference | ST binding by name | Adapter | Marked external and never deleted by World cleanup |
| Shared Worldbook | Explicit same-source recreation and deletion preserve shared backend Worldbook | Certified | Deleting one World preserves remaining references |
| Same-name different content | Desensitized fixture verifies deterministic collision-safe names | Certified | Distinct content never aliases silently |
| Large/multi-entry Worldbook | Seven real cards, including large embedded books, stay inside backend open budget | Certified | Import reports entry count and open stays inside budget |

## Enhanced Capabilities

| Capability | Dependency style | Current behaviour | Target level | Readiness contract |
| --- | --- | --- | --- | --- |
| Character Regex | ST data/event runtime | v2 verifies active extension, script count and per-card authorization; attempt is persisted | Adapter | Per-card enablement, applied output, status persisted |
| Tavern Helper scripts | ST global context | v2 activates only JS-Slash-Runner, verifies script inventory and authorization, and persists evidence | Adapter | Script inventory, activation result, isolated error |
| Managed MVU | Nora-managed browser extension | v2 base open completes first; managed loader must expose `getMvuData` before READY | Adapter pending target-browser verification | World opens first; MVU reports READY/DEGRADED separately |
| Embedded MVU | Card script exposes `globalThis.Mvu` | v2 timeout settles only the MVU attempt as DEGRADED; the user can retry that item | Matrix pending real-browser certification | Explicit readiness probe, timeout degradation, retry |
| EJS/macros | ST prompt/runtime behaviour | Preserved by engine | Adapter | Representative prompt output test |
| DOM-coupled third-party UI | Raw ST DOM selectors | Unbounded and unstable | Matrix | Per-extension adapter and visual/E2E verification |
| Arbitrary remote script | Security and lifecycle vary | Not safely certifiable | Unsupported by default | Explicit user opt-in and sandbox policy required |

## Phase 4 Readiness Evidence

Every declared v2 capability now has one persisted attempt record with status, attempt count, start/update timestamps, duration, a stable Nora error code, and readiness evidence. `READY` is invalid without non-empty evidence. A stale browser attempt cannot overwrite a newer retry.

| Capability | Required READY evidence | DEGRADED examples | Retry scope |
| --- | --- | --- | --- |
| Regex | `extension=regex`, extension active, script count, character authorized | runtime unavailable, declaration missing, authorization missing | Regex only |
| Tavern Helper | JS-Slash-Runner active, script count, character authorized | Runner unavailable or authorization missing | Tavern Helper only |
| MVU | runtime source, Helper dependency active, `getMvuData` API visible | timeout, readiness contract missing, public API missing | MVU only |

Capability execution is ordered `tavern_helper -> regex -> mvu` so dependencies are deterministic, but each item starts and settles independently. Checking Tavern Helper does not start managed MVU; checking Regex does not start either script runtime.

## DOM-Coupling Matrix And Adapter Strategy

| Surface | DOM/global coupling | Nora strategy | Current support claim |
| --- | --- | --- | --- |
| Character Regex transform | Uses ST message/prompt events; does not require Nora product DOM | Keep behind the ST card adapter; verify authorization and output in fixtures | Adapter |
| JS-Slash-Runner execution | Owns an ST-compatible hidden runtime and may create isolated iframe content | Activate through the adapter; do not expose its settings UI as Nora UI | Adapter for script execution, not arbitrary UI |
| Managed MVU | Uses the Nora-managed Runner script and public `Mvu` interface | Verify the public data interface; never infer readiness from a hidden panel or DOM node | Adapter pending browser certification |
| Embedded MVU | Card-owned script exposes a global runtime after Runner execution | Poll only inside the adapter, persist timeout as DEGRADED, allow MVU-only retry | Matrix |
| Card script targeting ST selectors | Depends on raw ST DOM that Nora deliberately hides | Require a named per-extension adapter and visual regression before support | Matrix, not generically supported |
| Card script injecting top-level controls/modals | Can collide with Nora layout and interaction ownership | Keep hidden by default; explicitly port accepted behavior into Nora UI | Unsupported without a product decision |
| Remote arbitrary module | Network, lifecycle and security are unbounded | No implicit activation or compatibility promise | Unsupported by default |

The adapter seam may use ST globals and events. Nora UI controllers may not. A present DOM node, a swallowed exception, or an installed extension name alone never constitutes READY evidence.

## Interaction Compatibility Boundary

The machine-readable source of truth is `ST-COMPATIBILITY-INTERFACE-MANIFEST.json`. It separates product interaction ownership from compatibility execution:

| Input surface | Canonical route | Support boundary |
| --- | --- | --- |
| Nora send, stop, regenerate, edit/regenerate and swipe | `StoryActionDispatcher` | Adapter |
| Trusted embedded-card `request_chat_completion` / `request_chat_stop` | `CardActionGateway` -> `StoryActionDispatcher` | Adapter |
| TavernHelper `generate` / `generateRaw` and their stop APIs | `TavernHelperActionAdapter` -> isolated sidecar task in `StoryActionDispatcher` | Adapter |
| TavernHelper variables and Worldbook APIs | Native TavernHelper data contract | Adapter; they do not own Nora UI or model-task state |
| TavernHelper Slash pipelines | Native Slash parser | Matrix; `/gen` and `/genraw` can start generation inside ST and require per-command certification |
| Scripts targeting removed `#send_but`, `#mes_stop` or `#options_button` | No generic fallback | Matrix; port through a named adapter instead of recreating hidden ST controls |

`StoryActionDispatcher` owns model-task state, cancellation, deduplication, retry semantics and timing. `UiOperationRegistry` owns only non-model UI mutations such as model configuration, Worldbook edits and imports. This separation prevents an imported card from creating a second generation lifecycle while keeping management operations independent.

## Required Regression Scenarios

The following observed cards/workflows must be represented by distributable fixtures or sanitized equivalents before certification:

| Scenario | Historical observation | Fixture requirement |
| --- | --- | --- |
| Complex import duplicate | “作为机娘生活吧” produced two Worlds | Same operation retry and explicit second creation |
| Empty visible story | “新风尚” produced a header-only chat | Empty `first_mes` and no alternate greetings |
| MVU open failure | New cards reported MVU readiness timeout | Managed and embedded MVU variants |
| Resource projection loss | Imported World lost right-side character/Worldbook | Delayed character/chat snapshots must not hide World |
| Same-source duplication | “维多利亚时代” shared a source SHA across two World records | Source identity must remain distinct from operation identity |

Proprietary card binaries do not need to enter Git. A sanitized fixture must preserve the structural fields, extension declarations and resource shape responsible for the behaviour.

## Certification Workflow

1. Parse and normalize the fixture without creating persistent resources.
2. Record declared capabilities and compatibility warnings.
3. Import through one idempotent Import Operation.
4. Verify one authoritative World and one default Story Session.
5. Open the base World without waiting for enhanced capabilities.
6. Verify each declared capability independently.
7. Refresh the page and restart the Node process.
8. Verify resource ownership and deletion behaviour.
9. Record cold and warm timings.

No row moves to Certified based only on a successful ST parser call, a present DOM node, or a hidden error.
