# Startup follow-up audit

Base: local main `6741abc`. Branch: `codex/startup-followup`.

## Implemented

- Coalesce synchronous state notifications into one scheduled UI refresh.
  Worldbook invalidation still runs for every notification before rendering.
- Remove the duplicate rail render before the world subscription's refresh.
- Preserve rail DOM when its generated markup and target container are unchanged.
- Preserve panel DOM and event listeners when markup, container and World identity
  are unchanged. A World switch always rebuilds the panel even if it looks identical.

These UI changes reduce redundant DOM replacement. They do not change card
content or storage behavior.

- Start a one-shot World-list read from release-validated bootstrap while the
  compatibility kernel loads. Consume it only once; expire it after the request
  deadline, fall back after failure, and invalidate it on non-GET client requests.
  Invalidation is also checked after an in-flight read completes.
- Load JSON editor dynamically on mount. Read current variables after loading,
  avoid mounting after disposal, stop the async watcher, and cancel debounced edits.
- Defer faker until async template context preparation. Await the original namespace
  before constructing the context so template calls remain synchronous.

## Verification

Targeted tests cover startup, World clients, shipped editor lifecycle, dependency
routing, static namespaces, existing MVU budgets and panel behavior.
New coverage exercises notification coalescing, individual invalidations, unchanged
markup, operation changes, character summary changes, World switches and edit mode.
No browser performance measurement or visual acceptance has been performed.
This branch has not been deployed to the local launcher.

## Dependency compatibility

### JSON editor

`app/native-extensions/JS-Slash-Runner/dist/index.js` statically imports
`../lib/jsoneditor.js`. The matching upstream revision is
`9403f47774962792ae6ac8c08ad9740a723ea872`; its
`src/panel/component/JsonEditor.vue` initializes the editor in `onMounted`.
The guarded `apply-deferred-json-editor.mjs` transformation preserves Nora's
existing bundle adaptations. Lifecycle tests execute the shipped setup function,
including current values, watcher cleanup and debounce cancellation.

### Faker

`app/native-extensions/ST-Prompt-Template/dist/index.js` has a static dependency
on `../libs/faker.mjs`. Templates consume the faker object synchronously.
`apply-deferred-faker.mjs` replaces the eager import and timer with awaited loading
inside async context preparation. It removes the obsolete webpack external entry.
Unknown vendor anchors fail closed; transformations are idempotent. This delays
download until context preparation, not necessarily until a generation request:
World preparation may also need a template context.

### Initial World list prefetch

`public/scripts/nora-story-core/index.js` now creates the World client from validated
bootstrap before the kernel resolves. After runtime creation its headers come from
the existing runtime adapter. Environments without bootstrap retain the old path.
This is page-local one-shot prefetch, not persistent caching. Changes from other
clients can still occur between any read and rendering, as with the existing API;
this is not a cross-client consistency protocol.

### Existing capability deferral

The materializer declares card capabilities and the capability controller intersects
requested capabilities with those declarations. Do not introduce a parallel
capability-loading system. This does not imply that every global extension resource
is deferred: global startup behavior must be assessed separately.

---

本节保留同日预加载交接审计的原始记录，基线为9668d67；前文后续审计的基线为6741abc。这里只并列归集两项审计，不推定两个提交的严格先后或依赖关系，也不将各自结果合计为一次验收。

<a id="startup-preload-audit-20260924"></a>
## Startup preload handoff audit

<a id="preload-baseline-and-scope"></a>
### Baseline and scope

Based on local main `9668d67`. Reviewed the colleague's 2026-09-24 supplement,
`HANDOFF.md`, `startup-preload.patch`, and verification harness. The attachment
describes one deployed HTML change, not a completed extension-loading redesign.
Its production timings are colleague-reported evidence, not measurements of this
branch. In particular, the controlled slow-network comparison was approximately
10.55 versus 10.46 seconds total; shifting waiting between stages is not a large
overall speedup.

<a id="preload-source-comparison"></a>
### Source comparison

- Main unconditionally imports the structured-clone shim before the other three
  prelude modules. Its static dependencies are discovered progressively.
- Main only preloads the compiled core and entry at runtime start. The remaining
  core graph is discovered during imports, and legacy has low fetch priority.
- The runtime already has versioned asset namespaces and compressed artifacts.
  No cache-authority, CDN, or compression replacement is needed for this change.
- World and panel rendering still assign `innerHTML` during refresh. The handoff's
  redundant-refresh finding remains relevant but is a separate UI lifecycle fix.
- World restoration still waits for display capabilities. Delaying those
  extensions without a per-card dependency audit risks incorrect first rendering.

<a id="preload-implemented"></a>
### Implemented

1. Keep one prelude asset list for prefetching and ordered evaluation. Omit the
   structured-clone shim only when the browser already provides the function.
2. Preload the prelude at the existing runtime-start boundary. Explicitly preload
   its known structured-clone dependency chain when the shim is needed.
3. Raise legacy fetch priority. Only after its load event, preload versioned
   `nora-module/` import-map URLs at low priority, deduplicated against existing
   modulepreloads. Do not bulk-preload in the import-map shim branch.
4. Keep the legacy/prelude/entry evaluation order and release validation intact.
5. Harden the handoff: ignore non-string import-map targets; failure in optional
   graph preloading cannot prevent the legacy promise from resolving. Actual
   legacy or module import failures still use existing error handling.

No world/chat/model data, extension activation order, UI readiness semantics,
updater, remote instance, or running local launcher is changed.

<a id="preload-verification-and-limits"></a>
### Verification and limits

The VM harness executes the real HTML startup sections for native/shim import maps
and native/missing structuredClone. It checks no early scheduling, repeated-start
idempotence, aliases, external URL exclusion, ordered evaluation, delayed graph
preloading, legacy failure, and optional-preload failure. All seven inline scripts
are syntax-checked. Existing startup and asset-budget contracts are also exercised.

These are code-level tests, not browser or performance acceptance. Native old
Safari, cache-on refresh, cold-cache slow links, and existing/empty World startup
still require target-browser testing before claiming a user-visible speed gain.
The import map includes a broad known core set, so speculative downloads can still
compete with subsequent work. This patch does not reduce those bytes or guarantee
faster startup. A precise build-generated critical graph is deferred.

No supplied instance rollback or authenticated browser script was executed.
