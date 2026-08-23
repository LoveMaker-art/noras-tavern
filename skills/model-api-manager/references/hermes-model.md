# Hermes Agent Model Configuration

Hermes model configuration and Tavern model configuration are independent.

## Native Providers

Prefer Hermes' native provider and `hermes model` for official services. Native
providers own OAuth, credential refresh, request dialects, and provider-specific
streaming. Use `hermes config check` after a change.

## Named OpenAI-Compatible Providers

The helper writes the current keyed `providers` schema:

```yaml
providers:
  provider-name:
    name: Provider Name
    api: https://example.com/v1
    key_env: PROVIDER_NAME_API_KEY
    default_model: model-id
    transport: chat_completions
    models:
      model-id: {}

model:
  provider: provider-name
  default: model-id
  base_url: https://example.com/v1
```

The secret belongs in the Hermes `.env`, referenced by `key_env`. Do not put a
new secret directly in `config.yaml`.

## Compatibility Gate

The agent probe checks a normal response and an explicit tool call. A model that
can chat but cannot produce a tool call is unsuitable as the main Hermes model.
Do not weaken this gate merely because the same endpoint works in Tavern.

After a validated write, restart the gateway and verify its status. The response
that initiated the change may still come from the old model; subsequent
messages use the new global model.
