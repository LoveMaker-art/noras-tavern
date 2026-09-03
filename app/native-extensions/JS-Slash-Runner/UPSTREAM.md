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

Nora's control adapter is connected in the readable prefix of `dist/index.js`.
`nora-control-adapter.js` wraps the existing global/character/preset reactive
stores and their native persistence functions. It does not replace the script
runner. On upstream upgrades this binding must be checked against the new
store symbols; a changed vendor bundle must not be published without this check.
