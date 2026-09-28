# Managed JS-Slash-Runner assets

Nora bundles JS-Slash-Runner `4.9.3` from commit
`9403f47774962792ae6ac8c08ad9740a723ea872`.

`lib/tailwindcss.min.js` is copied unchanged from that release. Its header
identifies `@tailwindcss/browser` `4.1.12`; the corresponding MIT license is
stored beside it as `lib/tailwindcss.LICENSE`.

The files under `vendor/iframe` replace fixed CDN bootstrap dependencies used
by the managed script iframe. See `vendor/iframe/UPSTREAM.md` for their exact
versions and licenses.

This managed build has extension auto-update disabled so upstream updates
cannot overwrite Nora's audited local dependency redirects. Updates are applied
through Nora's managed-extension release process instead.

Nora's headless runtime may omit ST's optional `new_chat_prompt` and author-note
input. The managed bundle normalizes both missing values before handing them to
ST's prompt collector, so neither can become a literal `undefined` message. All
ordinary character, World Info, and chat-history prompt processing remains
upstream-compatible.

The managed `generateRaw` dispatcher forwards `custom_api` to prompt collection.
When a custom request supplies numeric `max_context` / `max_tokens`, the prompt
collector uses those budgets; omitted values retain the active preset defaults.
This does not mutate the active preset or change the request's prompt content.
The reproducible vendor transformation is `node apply-generation-budget.mjs`
from this directory. It checks the pinned bundle bindings and refuses unknown
versions. The separate patch under `nora-mvu/upstream/slash-runner.patch` alone
does not update this loaded extension: MVU calls the runtime helper API.
`tests/nora-mvu-shipped-budget.test.mjs` in the engine executes the shipped
dispatcher, collector and output override paths to guard this distinction.

Nora's control adapter is connected in the readable prefix of `dist/index.js`.
`nora-control-adapter.js` wraps the existing global/character/preset reactive
stores and their native persistence functions. It does not replace the script
runner. On upstream upgrades this binding must be checked against the new
store symbols; a changed vendor bundle must not be published without this check.

`node apply-world-preset.mjs` reproducibly connects the preset store to Nora's
active World snapshot. The native script executor is unchanged. The projection
keeps library templates read-only, persists `in_use` edits to the owning World,
and exposes only explicitly permitted scripts. World switches refresh the native
reactive store; clearing the World empties that scope. The transformation fails
closed if the pinned upstream bindings no longer match.

The JSON editor library loads on editor mount, not extension startup.
`node apply-deferred-json-editor.mjs` reproduces the guarded bundle transform.
The async mount checks disposal before initialization; unmount also stops its
explicit watcher and cancels debounced edits. Nora's other adaptations are kept.

`node apply-character-persistence.mjs` routes the shared extension-field save
function through the existing control adapter. It uses the actual avatar binding,
propagates failed saves, and guards the target across asynchronous boundaries.
All three transforms are idempotent and must coexist; do not replace the bundle
with one branch's copy when combining changes. Run the Helper transform and
persistence regressions after upgrading the pinned upstream bundle.
