# ADR 0002: Single Node Runtime

- Status: Accepted
- Date: 2026-08-26

## Context

Nora Tavern previously shipped both the current Node compatibility engine and a
legacy Python web/runtime stack. The duplicate entry points created ambiguous
process ownership, state ownership, deployment modes, and rollback behavior.

## Decision

Nora Tavern has one serving process: the repository-owned Node engine under
`app/engine/sillytavern`.

Python remains only for the deterministic lifecycle and model configuration
tools in `app/native_lifecycle.py` and `app/native_model_config.py`. It does not
serve application requests. Provisioning creates one Tavern Liveware app, and
bringup binds that app to the single Node process.

Model-provider qualification routes and the Nora compatibility runtime remain
part of the Node application. Optional product capabilities removed with the
legacy Python stack may return later only as explicit plugins.

## Consequences

- Runtime mode files, Python serving entry points, sidecars, and in-place
  legacy cutover are removed.
- State and request ownership are no longer split between Python and Node.
- Deployment and restart remain explicit operations.
- Rollback restores the previous release instead of switching runtime modes.
