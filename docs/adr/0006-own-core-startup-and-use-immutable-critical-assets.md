# ADR 0006: Own Core Startup and Use Immutable Critical Assets

- Status: Accepted
- Date: 2026-08-28

## Context

An optimization overlay removed the compatibility kernel's explicit
`/script.js` import and made HTML announce core readiness after loading only
helper modules. No execution edge remained to create
`globalThis.SillyTavern.getContext`, so the kernel could only reach its
ten-second timeout. The same overlay duplicated standalone legacy and compiled
library assets as base64 inside a 4.09 MB manifest and coordinated CacheStorage,
IndexedDB, and the HTTP cache during startup.

## Decision

`nora-compat/st-kernel.js` is the sole owner of compatibility-core execution. It
imports `/script.js`, verifies the global API created by evaluation, and exposes
that API through Nora adapters. HTML may load prerequisites and create the
import map, but it cannot claim compatibility-core readiness.

The content-addressed HTTP asset namespace is the sole persistent browser cache
authority. The native ESM graph may remain in the manifest where its cycle
semantics require it, but already-built legacy and `lib-core` assets remain
standalone and immutable. The critical manifest is high priority and has a
550 KB Brotli contract budget.

`nora:usable` is an outcome signal. It is emitted only when the active World,
message view, and composer are usable.

## Consequences

- The startup dependency graph has one explicit execution edge and no readiness
  timeout standing in for initialization.
- Legacy and compiled libraries can transfer and compile in parallel with the
  manifest without base64 duplication or main-thread legacy decoding.
- Refresh behavior relies on standard immutable HTTP caching instead of two
  application databases with separate invalidation paths.
- Native ESM cycles remain preserved; a future core bundle requires separate
  browser compatibility evidence.
- Static contracts can establish ownership and asset budgets, but deployment
  and real-browser workflow verification remain separate evidence levels.
