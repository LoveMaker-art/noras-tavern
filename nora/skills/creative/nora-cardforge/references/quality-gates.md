# Quality Gates

Read this reference when `build` fails or reports publication issues.

## Hard Gates

The build stops for missing required card fields, empty or dead worldbook entries,
overly generic trigger keys, invalid Regex, missing MVU paths, unsafe status HTML,
invalid project paths, malformed PNG metadata, or failed round-trip parsing.

Repair the owning source:

- Prose and declared lore: `card.md`.
- MVU declarations: `features/mvu.json`.
- Status template: `features/statusbar.html`.
- Imported unknown extensions: preserve `source/passthrough.json` unless the user
  specifically requested a technical migration.

## Writing Score

The bundled deterministic scorer reports eight dimensions: completeness,
opening structure, lived-in behavior, audience tags, presentation and commands,
lorebook, image prompt, and anti-AI-flavor signals.

`release` records the score and issues but blocks only structural and safety
errors. `release-strict` also requires a score of at least 75. A low score can be
valid for a deliberately minimal card; explain the tradeoff instead of padding
text solely to increase a number.

## Evidence Files

- `reports/quality.json`: complete gate decisions and diagnostics.
- `reports/build-manifest.json`: artifact paths, card summary, selected profile,
  writing score, and SHA-256 hashes.

Run a new build after every repair. Completion requires the latest report to
describe the latest source files.
