# MagVarUpdate Runtime

The runtime bundle is built from [MagVarUpdate](https://github.com/MagicalAstrogy/MagVarUpdate)
at commit `7fe9ae7cfe01f13d606f7a2e533a458431fe318c` with Slash Runner commit
`c1d0953bf1a5ca4ff28eea513fc1362eef81b80c`, and remains under the MIT license.

Nora's build removes settings-panel and script-button initialization, defaults new installs
to the independent model path with silent notifications, and exposes a retry method through
the runtime API. A retry evaluates from the previous snapshot and only replaces the old update
block after the candidate is accepted; request/validation failure retains the old message.
Nora wraps the upstream parser and persistence logic in one bounded transaction: one
primary model attempt, at most one targeted parsing/validation repair, a 120-second deadline per
attempt, validation on a cloned snapshot and stale-chat guards. Text and variable writes are
**not** one atomic database operation. Nora awaits an explicit server-save acknowledgement before
reporting success; an uncertain save is reported without automatically replaying commands. Invalid
Nora-protocol batches are rejected; legacy updates in both modes retain accepted partial changes,
report partial failure and never automatically replay the accepted deltas.
Cards without an explicit protocol declaration preserve the upstream/card dialect and prompt chain.
Their formatted-output mode keeps the upstream JSON Schema response and
conversion path. An explicit empty `JSONPatch` commits as
a successful no-op without rewriting the story message. Independent-model context and output
limits are passed into the pinned Slash Runner prompt budget instead of being display-only fields.
A model configured to follow the active Tavern text model now inherits that model's thinking
behavior as well as its provider, credentials, model name, and output limit. The MVU-only
`关闭thinking` override is applied only when the user selects an independent custom MVU model.
A small `reloadSettings` bridge lets Nora's headless API
refresh the live MVU store after configuration changes. The runtime also exposes an idempotent
`ensureCurrentChatInitialized` operation so Nora cannot declare a World ready merely because the
MVU API object exists. Nora supplies configuration through the headless `NoraMvu` API.

The headless build also replaces the upstream empty-chat UI check with a current-chat/data
guard. Nora starts without ST's `.welcomePanel`, so an empty startup is a normal waiting state;
the existing `CHAT_CHANGED` listener initializes variables after a world is loaded.

Nora bundle revision 11 introduced command acceptance before Zod consumes the command array.
An accepted same-value update is successful without a repair request. Final state comparison
runs after schema/end hooks. Inline and extra-model paths emit the same transaction result;
the observer no longer invents failures from raw upstream end events (which precede persistence).
Zod rejection diagnostics do not depend on toast settings. Third-party consumers that do not
report command acceptance are unverified, not automatically assumed successful. Cancellation and
stale results do not produce red failure notifications. Existing two-attempt and timeout limits,
model settings and user card files were unchanged by that stage.

Revision 12 adds explicit `[nora_mvu/1]` routing from active comments in the bound primary
worldbook. No declaration means legacy, with or without Zod. Unknown/conflicting versions
fail explicitly. Nora text, formatted and tool responses share one wire definition in the
host's `mvu-protocol.js`, then feed the existing MVU command executor and Zod callbacks.
Inline mode is one story-plus-update request; extra mode uses a separate request. Nora parsing
never falls back to executing legacy command strings in its values. All six operations are
supported; move is limited to object properties, while arrays use insert/delete. Validation
and candidate state do not make arbitrary card callbacks rollback-safe.

New CardForge projects declare the Nora protocol and carry an upstream baseline.
Revision 13 filters only `[nora_mvu_fallback/1]` format entries from request-time
lore when the bound primary book declares Nora v1, before inline/extra routing.
The existing runtime adapter suppresses their pinned external MVU loader and
localizes the Zod helper, leaving the delivered PNG unchanged. In upstream ST
the same card uses its baseline loader/format and rendered-message notification
instead of Nora's commit event. This is command-level verified, not browser or
provider acceptance; older Nora builds without this filter are not a supported
portable-card target. Importing legacy cards does not convert them.
The managed Zod helper now answers a lifecycle-bound schema query: no Zod remains valid;
declared-but-unregistered Zod is a preparation error. Only representable field constraints
are projected, capped at 12,000 characters, without claiming to translate arbitrary transforms.
Old local helper imports are refreshed during runtime adaptation. Request-time card/protocol/settings
identity rejects stale writes; duplicate message events share one in-flight update.
Mixed lore is no longer auto-tagged based on command substrings. Unmarked books retain normal
keyword/budget behavior instead of disappearing wholesale during variable requests.

Revision 14 waits for a declared card schema to register during first preparation
instead of failing at the first empty query. It subscribes before querying and
waits at most 15 seconds for the helper's registration signal, then queries the
live listeners again and checks card/chat/settings identity. Timeout stays an
explicit preparation error; switching World prevents any request or write from
that preparation. The temporary listener/timer is removed on success and failure.
No-Zod legacy cards keep the immediate path. Wire format, correction budget and
model settings are unchanged. Registration, delayed readiness and stale/timeout
paths are source-level tested; this does not claim provider/browser acceptance.

The Nora extra-model task now explicitly maps `past_observe` to the observed story
and `status_current_variables` to the pre-turn snapshot, restoring the upstream
stop-roleplay / analyze-changes task semantics when substituting the Nora wire
format. Inline instructions, legacy tasks, preset ordering, response parsing and
retry limits are unchanged. Request-assembly tests cover both the initial and
repair requests; these tests do not establish a provider's compliance or success rate.

Revision 15: for declared Nora cards, the built-in extra-model template omits upstream creative
head/tail prompts and random Gemini prefixes. It keeps the existing context slots,
one variable task and its final user instruction. Legacy built-in requests retain
their original framing; inline and explicitly selected presets are unchanged.
New CardForge lore uses existing `[mvu_plot]` comments for pure narration demands,
generated `[mvu_update]` entries for variable rules, and unmarked shared facts.
No runtime content heuristic rewrites mixed entries or user cards. The markers do
not sanitize arbitrary presets or script-injected instructions.

The opt-in `SillyTavern.saveChat({ requireConfirmation: true })` acknowledgement is a Nora host
extension, not an upstream Tavern Helper guarantee. Matching host/runtime builds must be shipped
together. Older hosts that ignore the option return no acknowledgement and are reported as
persistence-unknown rather than successful. This does not claim process-crash atomicity or
support for concurrent MVU requests.

Revision 16 preserves a message's existing valid snapshot when an extra-model replacement
fails. Previous-turn inheritance only fills messages that still have no valid MVU data;
successful retries continue evaluating from the previous turn, not the current result.
Legacy/Nora and with/without Zod share this rule. Source tests cover failed replacement,
successful non-accumulating replacement and initial-failure inheritance. Protocol, prompts,
attempt limits and uncertain-save handling are unchanged.

Runtime dependencies are bundled locally in `vendor/bundle.js`; the MVU execution path does
not fetch JavaScript modules from a CDN. The source build uses
`NORA_BUNDLE_DEPENDENCIES=1 yarn build` against the pinned upstream checkout. Run
`./build-vendor.sh` to clone the exact revisions, apply `upstream/nora.patch` and
`upstream/slash-runner.patch`, rebuild the artifact, preserve its generated license companion,
remove the unshipped source-map reference, and verify its syntax.
The browser bootstrap also carries Zod 4.1.11 under its MIT license because MVU and card schemas
expect the global `z` namespace even when Tavern Helper's settings panel is not mounted.
