# Plugins, scripts, Regex and MVU

## Inspect before choosing a control

Use `st.extension.registry`, `st.plugin.registry`, `st.regex.registry`,
`st.mvu.settings.get` / `st.mvu.entries` for relevant stored inventory.
An installed extension or stored variable is not proof of current page execution.
Use the live-page protocol in SKILL.md for running state and all controls below.
Inspect only the category relevant to the request, not every plugin by default.

`nora.control.catalog` is authoritative for action fields and permissions.
The following are action families, not standalone MCP tool names:

| Need | Live actions | Important distinction |
| --- | --- | --- |
| Installed frontend extensions | plugins.list/config/enabled/configure | Library inventory and supported settings; often reload required |
| Plugin lifecycle | plugins.install/update/uninstall | Explicit repository or inspected local plugin; install starts disabled, protected components are excluded |
| Helper script trees | scripts.list/inspect/create/enabled/update/delete | global/character/preset scope, stable ID and current revision |
| Script buttons | scripts.buttons/button | Only buttons actually exposed; callback completion may not mean work completed |
| Regex | regex.list/create/permission/enabled/update/delete | Scope permission and individual enabled state differ |
| Library-original Regex | library.card-regex/card-regex-update | Explicit non-legacy library avatar; does not edit existing World copies |
| Helper settings/permissions | helper.settings/configure/permissions | Permission may affect an entire scope; not a single-script toggle |
| MVU | mvu.status/settings/data/configure/enabled/model/runtime/retry | See the distinct switches below |

Use actual action IDs from the catalog when invoking read/execute. Creation of
a script/regex starts disabled; enabling is a separate authorized action.
Use the revision returned by the matching scope read, and preserve unrelated
items. A preset/character ownership change invalidates the old target/revision.
For `plugins.configure`, first read `plugins.config` and pass its revision.
Updates may address existing nested objects or array fields (for example
`groups.0.enabled`). Types and array lengths must stay unchanged; secret fields,
new keys and prototype paths are rejected. Partial objects preserve siblings.
This is the agreed generic configuration boundary, not a plugin-specific schema
editor or support for every third-party page/button. New fields require a dedicated
supported adapter. A reload-required receipt is not proof of runtime adoption.
For update/uninstall, read `plugins.list` and pass its revision. Installation requires
the user's selected trusted repository and script authorization; do not automatically
enable it. Report reloadRequired separately from installation success.

## Resolve “enable MVU” correctly

Inspect `mvu.status` and relevant script state first:

- `mvu.enabled` toggles EXTRA MODEL automatic parsing, a global setting. It is
  not the switch for the whole MVU runtime.
- `mvu.runtime` persistently toggles Nora-managed MVU, also with global impact
  and reload required. It does not disable every embedded card script.
- Card-embedded MVU is controlled with the identified `scripts.enabled` action
  for that script/scope. Use runtime controls, not direct stat_data writes.

When the request is ambiguous, explain these choices briefly and resolve it
before a write. Do not disable a global component merely because one card fails.

`mvu.data` reads latest stored variables; `mvu.status` answers running/readiness
questions. A missing page cannot be replaced by a fabricated successful status.
`mvu.retry` retries the latest variable update through the runtime and may call
a paid model. Diagnose the reported error before retrying.

## Independent MVU model

Read `nora.mvu_model.get`; use `nora.mvu_model.configure` only to change the
requested connection fields. Configure secrets without echoing them in answers.
The optional context/maxTokens fields update only the supplied limits; omitted fields
remain unchanged. Use `nora.mvu.diagnostics` for recent error metadata. It reuses the
per-user rotating history and excludes raw error prose/model output; empty history
does not establish that MVU succeeded. It is not an unlimited audit archive.
Report these as recorded errors, not an overall failure rate: the history does
not provide all attempts as a denominator. Shared model configuration alone
does not establish resource contention or a failure cause; separate observed
error codes from hypotheses that still need request-level evidence.
Then use live `mvu.model` with source story/independent to select the intended
mode. Connection saved, mode selected and a successful real model call are
three different claims. A paid test/retry requires authorization.
This is MVU model configuration, not general Hermes or main-chat model management.

## Card button problems

Inspect current Helper/Regex permissions and relevant script/button state;
attribute failures to the actual card action when evidence permits. The catalog
can trigger exposed Helper buttons; it is not a universal DOM-click operation for
every card iframe. A missing button mapping is a capability limit, not permission
to inject JavaScript, rewrite card scripts or automatically regenerate a reply.

## Other plugin types

Story ledger controls use `nora.ledger.*`: read chat-ledger.md for compression
and edit-lock semantics. Story Profile uses `nora.story.*`, not generic plugin
configuration. Quick Reply inventory alone does not establish frontend execution
support. Use only installed catalog actions for plugin lifecycle; infrastructure
components remain protected from uninstall/disable.
