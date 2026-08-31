# MagVarUpdate Runtime

The runtime bundle is built from [MagVarUpdate](https://github.com/MagicalAstrogy/MagVarUpdate)
at commit `0a730cd4a9b99689d1135a49b542c780b977c24c` and remains under the MIT license.

Nora's build removes settings-panel and script-button initialization, defaults new installs
to the independent model path with silent notifications, and exposes a retry method through
the runtime API. The retry entry point reuses the upstream button's rollback behavior, so it
removes the old update block and restores the previous variable snapshot before requesting a
replacement. It also restores the original message and variables when the replacement request
fails, making the headless retry transactional. A small `reloadSettings` bridge lets Nora's headless API refresh the live MVU
store after configuration changes. Variable initialization, prompt filtering, model requests,
response parsing, persistence, cleanup, and chat transitions remain upstream implementations.
Nora supplies configuration through the headless `NoraMvu` API.

The headless build also replaces the upstream empty-chat UI check with a current-chat/data
guard. Nora starts without ST's `.welcomePanel`, so an empty startup is a normal waiting state;
the existing `CHAT_CHANGED` listener initializes variables after a world is loaded.

Runtime dependencies are bundled locally in `vendor/bundle.js`; the MVU execution path does
not fetch JavaScript modules from a CDN. The source build uses
`NORA_BUNDLE_DEPENDENCIES=1 npm run build` against the pinned upstream checkout.
