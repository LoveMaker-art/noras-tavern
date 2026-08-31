# Phase 0 Runtime Baseline

> Status: remote log baseline captured and accepted for Phase 0
> Date: 2026-08-28

## Evidence Already Available

Historical user-visible observations establish the regression range but were not captured with a common clock:

| Workflow | Observation | Evidence quality |
| --- | --- | --- |
| Liveware start/open | Runs ranged from about 3–5 seconds to about 40 seconds | User outcome; phases unknown |
| Repeated refresh | A later refresh was sometimes slower than the first | User outcome; cache and World stages unknown |
| Character import | Complex-card import blocked for a long time without useful progress | User outcome; import stages unknown |
| World open | MVU readiness timeout blocked the open flow | Runtime error plus source confirmation |

These numbers must not be mixed into one startup average. A new baseline is required after instrumentation because delivery, process startup, browser boot, World opening, and capability readiness have different owners.

## Accepted Remote Log Baseline

The user accepted the existing remote `[NORA_BOOT_METRICS]` logs as the Phase 0 standard. The source runtime was ST 1.18.0 at compatibility commit `51ad27fb86d39a3daca3adaa970375c9670c12df`. Aggregation was executed in remote memory and returned only timings and counts; raw logs, user content, request bodies, and authentication data were not copied into this repository.

### Liveware log

Sample window: 2026-08-27 19:54:57 through 2026-08-28 05:40:32 UTC.

| Metric | Samples | Min | P50 | P90 | P95 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| App ready | 10 | 2.02s | 2.72s | 3.77s | 3.77s | 4.28s |
| Initial World ready | 10 | 2.45s | 3.27s | 4.74s | 4.74s | 5.60s |
| Nora usable | 10 | 2.51s | 3.33s | 4.79s | 4.79s | 5.65s |
| Navigation TTFB | 10 | 0ms | 393ms | 907ms | 907ms | 1.05s |
| Inline modules | 10 | 697ms | 1.23s | 1.69s | 1.69s | 2.39s |
| `lib-core.js` | 15 | 227ms | 276ms | 1.45s | 1.48s | 2.39s |
| Bootstrap request | 10 | 487ms | 900ms | 1.19s | 1.19s | 1.29s |

This is the primary Phase 0 startup baseline because all ten Liveware sessions include a complete usable milestone. It demonstrates a normal 3–5 second path, but it is an observed log cohort rather than a controlled delivery-cache experiment.

### Production mixed-history log

Sample window: 2026-08-27 07:23:31 through 2026-08-28 13:22:36 UTC.

| Metric | Samples | P50 | P90 | P95 | Max |
| --- | ---: | ---: | ---: | ---: | ---: |
| App ready | 97 | 7.71s | 29.02s | 37.06s | 64.39s |
| Initial World ready | 89 | 8.98s | 31.94s | 39.02s | 31m 18s outlier |
| Nora usable | 77 | 7.91s | 24.93s | 31.32s | 42.38s |
| World list request | 124 | 415ms | 918ms | 1.28s | 10.46s |

This file spans deployments, long-lived tabs and incomplete sessions. Twenty of 97 sessions never emitted `nora-usable`, and one initial-World sample remained open for more than 31 minutes. It is retained as a regression/failure distribution, not used as the current-version startup target.

### World open and import

| Metric | Samples | Min | P50 | P90 | P95 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial lifecycle open | 5 | 3.36s | 4.32s | 5.75s | 5.75s | 13.15s |
| Manual World lifecycle open | 28 | 1.26s | 2.67s | 4.55s | 4.60s | 4.95s |
| Character import request | 10 | 1.45s | 3.99s | 11.20s | 11.20s | 11.23s |
| Import start to World claim | 6 | 10.43s | 14.08s | 21.80s | 21.80s | 24.64s |

One of 33 measured World lifecycle opens failed. Four of ten character imports had no later World claim in the same measured workflow window. This is the strongest Phase 0 evidence for separating card import, World commit and browser capability activation into a durable operation.

### Capability settlement

Capability timing is sparse in the existing logs. In the production cohort, the measured delay from `nora-usable` to critical-extension readiness had P50 0s, P90 5.29s, P95 6.51s and a 49.01s maximum. Only two Liveware sessions had a post-usable critical-extension sample, at 2.67s and 10.85s. These values justify separate base-World and Capability Set readiness but are not sufficient for an extension-specific performance promise.

## Canonical Timeline

Every measurement run has a `runId`, `mode` (`cold` or `warm`), source version, and the following independent phases:

| Owner | Phase | Start | End |
| --- | --- | --- | --- |
| Liveware host | `delivery.version-resolve` | app/version lookup begins | version selected |
| Liveware host | `delivery.download` | package transfer begins | package bytes complete |
| Liveware host | `delivery.unpack` | extraction begins | runtime tree ready |
| Liveware host | `delivery.register` | registration begins | app URL available |
| Native lifecycle | `native.verify` | source/dependency verification begins | verification complete |
| Native lifecycle | `native.sync-assets` | managed extension sync begins | config/assets ready |
| Native lifecycle | `native.spawn-to-health` | Node spawn begins | health endpoint succeeds |
| Browser | `browser.shell` | document navigation begins | Nora shell rendered |
| Browser | `browser.bootstrap` | shell rendered | bootstrap data available |
| Browser | `world.base-open` | Activation Plan requested | composer usable for base World |
| Browser | `world.capabilities` | base World ready | all declared capabilities settled |
| Import | `import.upload` | import command accepted | bytes staged and hashed |
| Import | `import.parse` | parser begins | normalized card and preflight ready |
| Import | `import.materialize-card` | card resource work begins | Runtime Card binding ready |
| Import | `import.materialize-knowledge` | knowledge work begins | resource bindings ready |
| Import | `import.create-session` | session work begins | initial Story Session durable |
| Import | `import.commit-world` | manifest commit begins | authoritative World READY |

## Event Format

Non-browser owners emit one JSON object per line after `[NORA_RUNTIME_PHASE]`:

```text
[NORA_RUNTIME_PHASE] {"runId":"cold-001","mode":"cold","phase":"delivery.download","durationMs":2100,"status":"ok"}
```

Browser timings continue to use `[NORA_BOOT_METRICS]` and `ops/scripts/analyze-boot-metrics.mjs`. Runtime and import events use `ops/scripts/analyze-runtime-phases.mjs`.

## Cold And Warm Definitions

- **Cold**: new Liveware version or cleared delivery cache, no running Node process, new browser navigation, no in-memory World index.
- **Warm**: package and dependencies present, Node already healthy or restarted from prepared assets, normal browser navigation.
- A version bump is not automatically cold if the host reuses identical package layers; the event stream must show whether download/unpack occurred.
- Browser refresh is not a process cold start and must be labeled separately.

## Required Sample Set

For each release candidate collect at least:

- 5 true cold Liveware runs.
- 10 warm navigations.
- 5 base opens of a simple card.
- 5 base opens of an MVU card.
- 3 imports for each certified complex-card fixture.

Report P50 and P95 when sample size allows. Averages alone are not accepted.

## Phase 0 Interpretation

- The accepted user baseline is the ten-session Liveware log cohort: usable P50 3.33s and P95 4.79s.
- The mixed production cohort proves the slow failure distribution: usable P95 31.32s and max 42.38s among completed samples.
- Import is not represented by the request duration alone. The current full path has a 14.08s P50 to claim and a 40% no-claim rate in measured imports.
- Existing logs do not contain Liveware delivery download/unpack events and therefore cannot prove a true package-cold budget. Future releases retain the canonical phase contract above.
