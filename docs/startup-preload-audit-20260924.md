# Startup preload handoff audit

## Baseline and scope

Based on local main `9668d67`. Reviewed the colleague's 2026-09-24 supplement,
`HANDOFF.md`, `startup-preload.patch`, and verification harness. The attachment
describes one deployed HTML change, not a completed extension-loading redesign.
Its production timings are colleague-reported evidence, not measurements of this
branch. In particular, the controlled slow-network comparison was approximately
10.55 versus 10.46 seconds total; shifting waiting between stages is not a large
overall speedup.

## Source comparison

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

## Implemented

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

## Verification and limits

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
