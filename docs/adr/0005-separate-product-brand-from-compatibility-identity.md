# ADR 0005: Separate Product Brand from Compatibility Identity

## Status

Accepted

## Context

Nora Tavern uses the SillyTavern runtime to preserve complex-card behavior, but Nora is the product users operate. Previous source changes replaced the main shell while leaving several SillyTavern-branded first-run, fallback, error, log, link, and icon surfaces reachable.

Renaming every SillyTavern identifier would break or obscure the compatibility boundary. Leaving branded product surfaces in place would make Nora appear to be a styled copy of the upstream interface.

## Decision

User-facing and operator-facing surfaces use the Nora Tavern identity:

- page title, manifest, favicon, application logo, first-run prompt, fallback welcome content;
- errors emitted across Nora adapters;
- server window title, startup banner, listener message, and port-conflict message;
- links and assets reachable from shipped HTML.

Compatibility identifiers remain explicit inside the runtime boundary:

- `globalThis.SillyTavern` and its context contract;
- `st-*` adapter and compatibility module names;
- package metadata, license, upstream repository, protocol user agents, and card fields;
- dormant localization and runtime strings not exposed by Nora product flows.

The visible-brand contract tests this boundary. It must not be broadened into a repository-wide ban on the word `SillyTavern`.

## Consequences

Nora presents a consistent identity without disguising or destabilizing its upstream compatibility engine. Future visible surfaces must use Nora naming, while changes to compatibility identifiers require a separate migration with complex-card regression coverage.
