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
