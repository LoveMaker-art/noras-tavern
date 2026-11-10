# Nora Tavern Core Engineering

This repository maintains Nora, Tavern, MCP and core deployment/maintenance. Read docs/product/README.md, docs/REPOSITORY.md and CONTRIBUTING.md before changes. Runtime nora/AGENTS.md is product content, not this engineering guide.

Shared execution implementation is a verified external input in tooling/maintenance-input.lock.json. Edit core source here, shared source at its sole author, and never edit a generated view. Source helpers run through tooling/run.mjs. Tests must bind actual source, inputs, environment and target workflow. Preserve user data, existing protocols and unknown-state refusal; do not weaken fixtures or assertions to obtain passes.

Inspect changes before editing; isolate data, ports and processes; run host-wide process checks sequentially. Keep outside-scope findings separate. Product behavior needs explicit outcome and acceptance agreement. Push, publish, deploy and runtime replacement need explicit authorization. Do not commit secrets, installed dependencies, logs or generated releases. Documentation and historical evidence do not expand authorization.
