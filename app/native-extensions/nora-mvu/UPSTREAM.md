# MagVarUpdate Runtime

The runtime bundle is built from [MagVarUpdate](https://github.com/MagicalAstrogy/MagVarUpdate)
at commit `7fe9ae7cfe01f13d606f7a2e533a458431fe318c` with Slash Runner commit
`c1d0953bf1a5ca4ff28eea513fc1362eef81b80c`, and remains under the MIT license.

Nora's build removes settings-panel and script-button initialization, defaults new installs
to the independent model path with silent notifications, and exposes a retry method through
the runtime API. The retry entry point reuses the upstream button's rollback behavior, so it
removes the old update block and restores the previous variable snapshot before requesting a
replacement. It also restores the original message and variables when the replacement request
fails. Nora now wraps the upstream parser and persistence logic in one bounded transaction: one
primary model attempt, at most one targeted parsing/validation repair, a 120-second deadline per
attempt, validation on a cloned snapshot, a stale-chat guard, and one atomic commit. An invalid
or late result never replaces the previous valid snapshot. Cards that explicitly declare
`[nora_mvu/1]` use Nora's strict operation envelope with array paths and unambiguous operations;
legacy `_.set` and JSONPatch cards remain compatibility inputs. Formatted-output and tool-call
modes use the Nora schema only for declared v1 cards, while text mode receives the same protocol
instruction through its update entry. Invalid command batches are rolled back as a whole. An
explicit empty `JSONPatch` or empty Nora operation list commits as a successful no-op without
rewriting the story message. Independent-model context and output
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

Runtime dependencies are bundled locally in `vendor/bundle.js`; the MVU execution path does
not fetch JavaScript modules from a CDN. The source build uses
`NORA_BUNDLE_DEPENDENCIES=1 yarn build` against the pinned upstream checkout. Run
`./build-vendor.sh` to clone the exact revisions, apply `upstream/nora.patch` and
`upstream/slash-runner.patch`, rebuild the artifact, preserve its generated license companion,
remove the unshipped source-map reference, and verify its syntax.
The browser bootstrap also carries Zod 4.1.11 under its MIT license because MVU and card schemas
expect the global `z` namespace even when Tavern Helper's settings panel is not mounted.
