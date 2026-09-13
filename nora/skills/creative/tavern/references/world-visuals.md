# World visuals

For background images, palette, font presets and reading surfaces, use the current
Nora MCP theme controls. These are the original World Visuals options adapted to
World Core; they style existing elements without adding controls or status widgets.
Story background/scenario text is a different operation in the worlds reference.

## Global defaults or one World

For "global", "all worlds" or "set once", use `theme.global.inspect`,
`theme.global.apply` and `theme.global.clear` through the live-page controls.
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
