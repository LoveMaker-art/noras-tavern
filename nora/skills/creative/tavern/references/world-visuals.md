# World visuals

## Page appearance

For whole-page light/dark/system switching, target the connected local page and
read `appearance.inspect` through the live-page controls. If `controllable:true`,
submit `appearance.set` with `{mode,expectedRevision}` using its revision, then
read the receipt and inspect again. Modes are `light`, `dark`, `system`.
The setting persists across refresh/restart and covers navigation and dialogs.
World palette overrides remain separate and are preserved. `effectiveMode`
reports the selected page palette, not visual verification of card-owned content.
Non-local Liveware pages follow their browser/WebView preference; when
`controllable:false`, explain that boundary. This does not prove the host app
forwards its manually selected theme. Other open tabs see changes on reload.
Use this operation for appearance, including requests for "global dark mode".
If it is absent from the current catalog or the page is not ready, report that
capability gap. A previous conversation's CSS workaround is not an alternative
operation; leave settings and files unchanged.

For background images, palette, font presets and reading surfaces, use the current
Nora MCP theme controls. These are the original World Visuals options adapted to
World Core; they style existing elements without adding controls or status widgets.
Story background/scenario text is a different operation in the worlds reference.

## Global defaults or one World

For backgrounds, palette, fonts or reading surfaces shared by all Worlds, use
`theme.global.inspect`, `theme.global.apply` and `theme.global.clear` through the
live-page controls. "Global" describes the scope of those World visuals, not
whole-page light/dark/system mode.
Global means this Tavern user's Worlds, not every server user. Keep single-World
requests on the existing `theme.inspect/apply/clear` actions. Resolve ambiguity
before writing; never loop over Worlds to imitate a global default.

Read the global `ui` and `revision`, preserve unrequested fields, then submit
`theme.global.apply` with `{ui,expectedRevision}` and an authorized `confirm`.
Use the same page targeting and stable idempotency key as other controls. An
active World is not required, but a connected Nora page is. Colors and image
fields are the same catalog described below; local backgrounds must exist.
Read back the receipt and global configuration. A save changes only the global
theme field, never model settings or individual World files. The active page
reapplies styles without reopening the World or initializing MVU. Other open
pages read the saved default after reloading; do not claim live cross-tab sync.

Effective theme = global defaults overridden by explicitly set World fields.
A World's own image set replaces the global image set, including device fallback.
`theme.inspect` returns `ui` (World overrides), `globalUi` and `effectiveUi`.
Modify `ui`, not `effectiveUi`, when editing one World; copying the latter would
freeze inherited defaults. `theme.clear` makes that World follow global defaults.
`theme.global.clear` clears only global overrides and keeps World themes and
images. Neither operation changes the rail, card internals, layout or story data.
On invalid global data, the renderer uses built-in defaults; inspect reports
`invalid:true` so the operator can correct or explicitly clear it.

## Inspect, change, verify

1. Obtain `nora.control.clients` and select the user's exact page/World/Session.
   Read the action schema via `nora.control.catalog`. Use `nora.control.read` for
   `theme.catalog`, `theme.inspect`, and `theme.backgrounds`, then read each receipt
   with `nora.control.operation`.
2. Start from the returned `ui`. Change only requested fields; `theme.apply`
   replaces the full object. Preserve all unrequested theme and asset fields.
   Omitted fields inherit global defaults, then built-in Tavern styling. Options:
   - Colors (hex 3/4/6/8 digits): accent, background, surface, text, secondary_text,
     muted, border, user_message, overlay. Overlay colors the local glass reading surface.
   - `font` and `narration_font`: default, literary, modern, classic, typewriter.
     These use system fonts; do not download web fonts. Narration follows ST emphasis
     markup; do not rewrite role-card output or invent a narration classifier.
   - `content_width`: 360–760 px; rich-card iframe widths stay card-owned.
   - `background_fit` / `background_fit_mobile`: cover or contain.
   - `background_position` / `background_position_mobile`: use catalog values.
   - `reading_surface`: plain, glass or solid, behind ordinary text only.
   - `assets.background_desktop`, `background_mobile`, or fallback `background`:
     an imported `/backgrounds/...` URL or a user-approved HTTPS image URL.
3. Submit `nora.control.execute` with `action="theme.apply"`, params `{ui,
   expectedRevision}` from inspect, exact target and a stable idempotencyKey.
   `confirm=true` requires the user's requested change. No model or script
   authorization is needed. On stale revision reread, then reapply the intended edit.
4. Inspect the receipt and repeat `theme.inspect`. Saved config and matching
   renderer World prove persistence/application, not image download or visual quality.
   `reopenRequired` means the live World list refresh failed. Offline tabs receive
   the persisted theme when reopened; other already-open tabs are not live-synchronized.
5. Follow global defaults with `theme.clear` and the latest expectedRevision. It clears
   this World's visual overrides, not reusable images, messages, or card content.

## Images

Prefer `theme.backgrounds` for existing images. For a supplied local file, call
`nora.background.import(filePath, confirm=true)`: the file must be in the MCP's
configured upload directory, PNG/JPEG/WebP, at most 12 MiB. Importing returns an
immutable content-addressed URL and does not modify a World. Apply that URL separately.
For a supplied HTTPS link, either use it as an external background (the user's
browser contacts that host), or download the approved image into the upload
directory using the installed file/network tools, then import. Never download
unrequested resources or bypass path checks. Re-importing identical bytes reuses
the same asset. Mobile and desktop images may differ.

Keep the left world list and navigation neutral. The current implementation styles
the story stage and right panel; iframe internals, arbitrary CSS/HTML/JS, changing
button handlers, and reactive MVU widgets are outside these operations.
The retired `world_theme.py`, `/api/productions` and `/api/event` are not valid paths.

## Font size, line height and paragraph spacing

Use the same exact online client/World/Session and generic `nora.control.*`
tools. Read `reading.catalog` for current numeric fields, units, steps and limits;
fonts remain `theme.catalog` presets (body and narration separately). No arbitrary
CSS, web font downloads, message rewrites, model calls or user-script execution.

1. Read `reading.inspect` with `{scope:"global"}` or `{scope:"world"}`.
   World scope targets that client's active World. Global means this authenticated
   Tavern user's defaults, including when no World is open.
2. Execute `reading.apply` with `{scope,values,expectedRevision}`, authorized
   `confirm:true` and a stable idempotency key. `values` is a partial numeric patch:
   e.g. `{font_size:18,line_height:1.8,paragraph_spacing:12}`. Preserve other fields;
   zero paragraph spacing is valid. Do not copy inherited effective values into
   World overrides. `null` removes one override.
3. Alternatively `reading.reset` with `{scope,field,expectedRevision}` removes
   one named field or `field:"all"`. World reset inherits global, then built-in
   defaults. Reset global preserves all World overrides. These operations do not
   reset theme fonts, colors, images, user messages or ordinary settings.
4. Read the receipt and inspect again. `saved:true` and `applied:true` describe
   separate results; `appliedRevision` names what this page rendered. When
   `superseded:true`, reread rather than claim the earlier revision is current.
   `saved:true,applied:false` means the save succeeded but rendering/refresh did
   not: report both results, use `reading.refresh` to retry application without
   another save. Other open tabs read on reload; no cross-tab live-sync promise.
   A conflict requires rereading the latest revision before a new edit. A request
   whose outcome is unknown must be inspected rather than blindly retried.

Only ordinary story body and user messages are controlled; card-owned widgets,
iframes, navigation and message-to-message spacing stay unchanged. Built-in
paragraph spacing is 10px for both story and user text; story text retains
15.5px/1.68 and user text 14px/1.6. Existing explicit preferences take precedence;
reset removes overrides and inherits these defaults without rewriting other Worlds.
Numeric reading preferences live in an independent user file for older-version
compatibility; use the interface, never hand-edit settings or World manifests.
Malformed/unreadable preferences are reported without deleting them or blocking
World startup. Saved/application receipts do not establish visual verification.
For a request involving both font presets and numeric settings, execute their
respective operations and report partial success honestly.
