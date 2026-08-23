---
name: model-api-manager
description: Configure model APIs for Hermes Agent or Tavern.
version: 1.0.1
author: Tavern Project
license: AGPL-3.0-only
platforms: [linux, macos]
metadata:
  hermes:
    tags: [models, providers, api, configuration, tavern]
    category: system
    related_skills: [tavern-ops]
    requires_tools: [terminal]
---

# Model API Manager

Use this skill as the single entry point for adding or switching a model API.
Hermes Agent and Tavern are separate consumers with separate configuration and
compatibility requirements.

## Resolve The Target

If the user has not already named the target, ask exactly one short question in
the user's current language:

> 这次要配置到哪里：当前 Agent、酒馆，还是两边都配置？

> Configure this model for the agent, Tavern, or both?

When this question is required, output only that question and stop. Do not ask
for the provider, URL, model ID, API key, or documentation in the same response.
Continue gathering details only after the user chooses the target.

Map the answer to `agent`, `tavern`, or `both`. Do not ask again when the user
already said the agent, Tavern/the story model, or both.

- `agent` changes the Hermes provider and default model.
- `tavern` changes Tavern's active text-generation model only.
- `both` runs both independent validations and applies one atomic transaction.

For `agent` or `both`, tell the user before applying the change, in the user's
current language, that Hermes Gateway must restart after validation, ClawChat
may disconnect briefly, and the new model becomes the global default after the
restart. This is a notice, not an additional confirmation prompt.

TTS, image, embedding, auxiliary, story-ledger, and character-state models are
outside this skill unless the user explicitly asks for one of them.

## Gather And Classify

Collect only missing values: provider name, model ID, API base URL, API key, and
provider documentation when the protocol is unclear. Never repeat a complete
key in a response.

1. Prefer an existing native Hermes provider for an official platform.
2. Use the automated path below for OpenAI-compatible Chat Completions APIs.
3. A native non-OpenAI protocol needs a Hermes Provider adapter. Do not relabel
   it as OpenAI-compatible.
4. Tavern currently requires OpenAI-compatible Chat Completions. A native-only
   endpoint may be configured for the agent but not Tavern.

Load `references/provider-protocols.md` from this skill when classification
or vendor-specific behavior is uncertain.

## Safe Workflow

Use the helper for inspection, secret storage, compatibility probes, and the
OpenAI-compatible apply path:

```sh
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
MANAGER="$HERMES_HOME/skills/system/model-api-manager/scripts/model_api_manager.py"
python3 "$MANAGER" inspect --target both
python3 "$MANAGER" store-key --env PROVIDER_API_KEY
python3 "$MANAGER" probe \
  --target both --base https://example.com/v1 --model model-id \
  --key-env PROVIDER_API_KEY
python3 "$MANAGER" apply \
  --target both --name provider-name --base https://example.com/v1 \
  --model model-id --key-env PROVIDER_API_KEY --confirm
```

`store-key` reads the secret from an interactive prompt or stdin. Never place a
key in command-line arguments, logs, documentation, plans, or chat summaries.

The helper probes before writing, preserves unrelated configuration, writes
atomically, validates both targets independently, and restores both sides if a
`both` transaction fails. Do not bypass a failed probe with manual edits.

For an official native Hermes provider, load `references/hermes-model.md` from
this skill. For Tavern behavior and its existing specialist commands, load
`references/tavern-model.md`.

## Apply Boundaries

- Agent configuration belongs to Hermes `config.yaml` and its secret `.env`.
- Tavern configuration belongs to Tavern's server-side model registry.
- Never copy Tavern credentials into Hermes config or vice versa implicitly.
- Reusing one endpoint for `both` still creates two explicit consumer records.
- Tavern's active text model is global for story generation. Its story-ledger
  compression model remains independently managed.
- Do not delete built-in or fallback models while adding a custom model.
- Do not restart Tavern for an agent-only change.
- Restart the Hermes gateway only after an agent configuration validates.

## Verification

After apply:

1. Run `hermes config check` for `agent` or `both`.
2. Restart and check the Hermes gateway for `agent` or `both`.
3. Run Tavern `model test` and `doctor --json` for `tavern` or `both`.
4. Report the two scopes separately: provider name, model ID, latency, active
   state, and a masked key suffix only.
5. For `agent` or `both`, explicitly report whether the gateway restart
   succeeded and state that subsequent messages use the new global default.
6. Never say "both succeeded" when only one target succeeded.

Load `references/security-and-rollback.md` from this skill for failures,
partial writes, credential rotation, or recovery.
