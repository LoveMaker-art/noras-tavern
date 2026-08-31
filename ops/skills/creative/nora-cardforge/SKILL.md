---
name: nora-cardforge
description: Create, revise and export Tavern cards; import via MCP.
metadata:
  hermes:
    category: creative
    tags: [角色卡, 制卡, 世界书, MVU, Regex, TavernHelper]
    related_skills: [tavern]
    revision: hermes-mcp-20260831
---

# Nora CardForge

Create and maintain SillyTavern-compatible character-card projects without a
UI. The agent (若棠 on Hermes) owns requirement analysis and authored content;
the bundled CLI owns deterministic parsing, diagnostics and V2/V3 packaging.
The configured Nora MCP alone owns live Tavern imports. This is the 0.3.0
authoring engine with the Hermes MCP adapter, not a new Tavern backend.

## When to Use

- Create an original character card from a user brief.
- Inspect, decompile, repair, translate, or revise an existing PNG or JSON card.
- Build worldbook, Regex, MVU, TavernHelper, or status-bar structures.
- Explain a card's plugins, variables, macros, configuration, or update rules.
- Export V2 JSON and a V2/V3 dual-metadata PNG.
- Install a reviewed artifact when the user explicitly requests the write.

Do not use this skill for changing Tavern application code, editing live story
history, fabricating missing user choices, or treating successful storage as
proof that executable extensions activated.

## Prerequisites

- Node.js 18 or newer and Python 3.9 or newer.
- Resolve the skill directory from the loaded Skill path. The CLI is
  `scripts/nora-cardforge.js` relative to this file.
- Use actual attachment paths supplied by the user or platform. Never guess a
  path or silently substitute another card.
- Live import requires the configured Hermes MCP server `nora`, in operator mode.
  Local creation, inspection, repair and export need neither MCP nor Tavern.
- Keep editable projects in a user-selected directory or a unique directory under
  the Hermes home `cardforge-projects/`. Keep them outside the installed skill,
  Tavern's live data directories and the MCP upload staging directory.

## How to Run

On Hermes load with `skill_view(name="nora-cardforge")` (or `/nora-cardforge`).
Use its returned path to resolve the script; run it with the `terminal` tool.
Read a linked reference with `skill_view(name="nora-cardforge", file_path="references/<file>.md")`.
Other hosts use their available shell tool. From the actual skill directory:

```bash
node scripts/nora-cardforge.js <command> ...
```

Every command emits JSON. Treat `ok`, `manifest`, `quality`, `compatible`,
`stage`, hashes, and read-back fields as evidence. Do not infer success from
decorative command output.

## Quick Reference

```text
init --project <dir> --name <name> [--slug <ascii-slug>]
ingest --input <card.png|card.json> --project <dir>
project-inspect --project <dir>
build --project <dir> [--profile release|release-strict]
inspect --input <card.png|card.json>
diagnose --input <card.png|card.json>
prepare-import --project <dir> --upload-root <dir> --idempotency-key <key> --dry-run
prepare-import --project <dir> --upload-root <dir> --idempotency-key <same-key>
```

## Procedure

1. Classify the request as explain, create, ingest, revise, inspect, export, or import.
   For questions only, follow Explanation Mode below and stop after answering.
   Identify the source artifact and requested destination before writing.
2. For original creation or substantial prose revision, read
   `references/card-authoring.md`. Run `init`, then author `card.md`. Preserve
   user decisions and leave genuinely unknown choices open.
3. For an existing card, run `inspect` before `ingest`. Account for its format,
   card name, worldbook entries, unknown fields, and executable extensions.
4. Preserve imported technical content. Edit `card.md` for prose and declared
   lore; keep `source/passthrough.json` as the round-trip base. Read
   `references/card-project-format.md` before changing project configuration.
5. For MVU, Regex, TavernHelper, or status UI, read
   `references/advanced-cards.md`. Every status-bar variable path must resolve
   to a declared MVU field.
6. Run `build --profile release`. If a quality gate fails, read
   `reports/quality.json` and `references/quality-gates.md`, repair the failed
   category, and rebuild.
7. Inspect every generated artifact. A PNG build must select `ccv3`, expose both
   `chara` and `ccv3`, and match the manifest card name and hashes.
8. For export, deliver the actual artifact to the requesting conversation. Hermes
   supports `MEDIA:<absolute-file-path>` and `[[as_document]]` for document delivery;
   send character-card PNGs as documents, not compressed photo previews, to retain
   embedded metadata. Use real paths and the installed delivery tool's schema.
   A server-local path alone is not a downloadable attachment in ClawChat.
   Stop there unless the user requested a live import. For import read
   `references/import-install.md`: preview, stage, then invoke the existing MCP
   tool and read its operation. Preparing a file does not import it.
9. Report build, storage, and runtime activation as separate evidence levels.
   Complex-card activation requires a compatible World/chat and runtime check.

## Explanation Mode

- For plugin responsibilities, generated scripts, Regex settings, or macros,
  read [feature-explanations.md](references/feature-explanations.md).
- For a variable's meaning, value, scope, constraints, update conditions, or
  modification impact, read [variable-reference.md](references/variable-reference.md).
- For build settings or lorebook directives, read
  [card-project-format.md](references/card-project-format.md).
- Answer general questions directly from the relevant reference. For a specific
  card, inspect its actual definitions using the read-only evidence procedure in
  the feature reference; summary counts alone cannot explain individual items.
- Explain in the user's language: plain meaning first, actual path and evidence
  second. Distinguish authored intent, generated enforcement, and observed state.
- For an all-items request, account for every discovered plugin/script and
  variable, including disabled, unused, conflicting, and unknown items. Mark
  incomplete discovery explicitly; never substitute this glossary for an audit.
- Questions do not authorize builds, imports, live variable writes, resets, or
  script execution. Finish when each requested item is explained with evidence
  or a specific missing-evidence note.

## Pitfalls

- `card.md` is authored content; files under `build/` are generated.
- A normal PNG without `chara` or `ccv3` metadata is not a character card.
- `nora.world.import` creates a new World. It does not merely add to the library
  or replace a current World. If the user requests only library storage or live
  card replacement, consult `tavern` for the actual supported operation; do not
  silently create another World. The old CLI `install` command is retired.
- `release` reports writing-score weaknesses without blocking.
  `release-strict` blocks scores below 75.
- Preserve provenance and unknown extension data when revising third-party
  cards. Do not relabel public material as original work.
- Do not install, attach a World, restart a service, or modify remote state
  merely because the user requested a local build or preview.

## Verification

- For explanation-only requests, verify source coverage and unknowns as above;
  the following build/install checks apply only to those requested operations.
- `project-inspect` reports the intended card and project files.
- `build` returns `quality.passed: true` and hashes for generated artifacts.
- V2 JSON reopens as `chara_card_v2`.
- PNG reopens as `chara_card_v3` with both metadata keywords.
- Ingest-and-rebuild retains unknown extensions through the passthrough base.
- `prepare-import` verifies the manifest hash and stages identical bytes. MCP
  import needs a `COMPLETED` operation and matching world read-back; see the import reference.
- Do not claim Regex, MVU, TavernHelper, or status-bar execution until the
  target runtime verifies activation.
