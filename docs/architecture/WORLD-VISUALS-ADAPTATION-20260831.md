# World Visuals adaptation (2026-08-31)

## Accepted scope

Restore the former skill's per-world background images, font presets, palette,
reading width and reading surface on current Tavern. Preserve default appearance,
existing controls, story data, model behavior and card-owned iframe internals.
No MVU display widgets, arbitrary HTML/JS/CSS entry point or alternative state store.

## One implementation path

- `world-theme.js`: shared version-1 `ui: {theme, assets}` validation and projection.
- World Core owns `ui`, revision checks and atomic persistence. Open plans and
  existing World list projection expose it. No world-data migration is required.
- `world-theme-controller.js` applies scoped properties to the existing stage and
  right panel; clears/restores owned overrides on world changes. No polling,
  model calls or message render rewriting. Left navigation stays neutral.
- Existing MCP control broker exposes `theme.catalog/backgrounds/inspect/apply/clear`.
  Same page/session guards, confirmation, revision and execution receipts apply.
- `nora.background.import` accepts approved files within MCP uploadRoot, at most
  12 MiB PNG/JPEG/WebP. Storage reuses ST backgrounds; content hashes and atomic
  publication deduplicate imports. Import alone never applies a World theme.
- Images at HTTPS URLs are browser-loaded, not fetched by the backend validator.
  Imported local assets are checked before saving; no arbitrary filesystem paths.
- Tavern skill routes visuals to one reference. Installer retires exactly the
  old Python `world_theme.py` and its old schema reference, retaining user images.

## Local evidence

- 68 targeted tests passed (World Core/client/routes, controls, Story Core,
  panel controls and 8 visual tests). Includes persistence/reopen, old revision,
  world separation, default restoration, safe schema, failed refresh, explicit
  clear, asset path restrictions and concurrent import deduplication.
- 18 skill installer tests passed, including precise visual-code retirement.
- Actual stdio MCP → authenticated HTTP → control broker → World Core integration
  passed with isolated temporary data, including theme apply/clear and image import.
- UI shell structure check passed (`nodes=15`); used an existing local Cheerio
  test dependency through NODE_PATH, without changing production dependencies.
- TypeScript, Nora Webpack and inline/compressed resource generation passed.
  Existing bundle-size warnings remain; no startup-speed claim is made.
- No browser or real user world was changed for testing. Visual acceptance and
  real external-image availability are not established by these technical tests.

## Remote scope and evidence

- Deployed only this change's scoped diff, preserving earlier remote release
  differences. The unrelated locally implemented panel-control changes were NOT
  bundled into this deployment.
- Rebuilt remote assets; reran all 8 visual tests against remote source: passed.
- Tavern restarted through its maintained lifecycle. World list, entry asset and
  theme module respond successfully; actual catalog lists all 5 theme controls.
- 5 existing Worlds remain; none acquired a theme configuration during deployment.
- Fresh `hermes mcp test nora` connected in 322 ms and discovered 46 tools,
  including `nora.background.import`. The existing Gateway-owned MCP process was
  not restarted; its cached tool schema needs the supported `/reload-mcp` command
  before the newly added top-level image import tool is visible in that session.
  Existing generic control tools can discover the new theme actions dynamically.
- Removed the two obsolete visual files and their empty parent directories.
- Scoped recovery archive remains at
  `/opt/data/tavern-state/native-runtime/deploy-staging/world-visuals.sOSgXP/before.tgz`.
- Existing open tabs require refresh for new frontend code. Other open tabs do
  not live-sync appearance edits; reopening uses authoritative stored config.
- MCP connection/tool discovery and autonomous 若棠 usage are separate checks;
  presence of a tool in a fresh discovery does not prove a cached agent session
  has refreshed its schema or demonstrated the requested visual result.
