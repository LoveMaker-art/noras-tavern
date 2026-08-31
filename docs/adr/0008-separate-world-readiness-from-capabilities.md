# Separate World Readiness From Capability Readiness

- Status: Accepted
- Date: 2026-08-28

A World is basically ready when its authoritative record, default Story Session, Runtime Card Resource, and required bindings are valid. Regex, helper scripts, MVU, and other enhanced capabilities have a separate readiness status and may become ready or degraded after the World opens. This prevents an optional browser extension timeout from being reported as a missing or failed World.

## Considered Options

- Treat every declared extension as part of World activation: rejected because optional browser readiness is variable and creates long, non-atomic open transactions.
- Ignore extension failure: rejected because users must know whether complex-card behaviour is truly active.
- Separate basic readiness and Capability Set readiness: accepted because it preserves truthful compatibility status without blocking the story.

## Consequences

- A degraded capability cannot roll back an already ready World.
- Each capability reports its own status, duration, error code, and retry result.
- Capability evidence distinguishes execution-runtime readiness from Story Session data readiness; neither is inferred from the other.
- The UI must distinguish “World failed” from “World available with degraded capabilities.”
