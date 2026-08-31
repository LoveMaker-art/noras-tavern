# Nora Tavern Card Forge

No-UI SillyTavern card forge for 若棠/Hermes and Codex. This is the 0.3.0 authoring
engine with adapter revision `hermes-mcp-20260831`. The same folder is a skill and
a Node.js CLI package with no npm dependencies (the writing scorer uses Python).

Nora writes content and decides intent. This CLI performs deterministic card operations:

- read `.json` and `.png` SillyTavern character cards
- create and decompile human-readable `card.md` projects
- preserve imported unknown extensions during round trips
- generate and apply machine-readable patches
- run static diagnostics
- compile MVU variable packs from Nora-provided variable specs
- validate and apply Nora-provided status bar HTML
- export V2 JSON and dual-metadata V2/V3 PNG artifacts
- prepare hash-verified artifacts for the configured Nora MCP's World import

The CLI does not save API keys, call models by itself, or overwrite the input file.

## Commands

```bash
node scripts/nora-cardforge.js init --project /tmp/my-card --name "角色名" --slug my-card
node scripts/nora-cardforge.js build --project /tmp/my-card
node scripts/nora-cardforge.js ingest --input character.png --project /tmp/imported-card
node scripts/nora-cardforge.js prepare-import --project /tmp/my-card --upload-root /actual/mcp/uploads --idempotency-key my-request --dry-run
node scripts/nora-cardforge.js prepare-import --project /tmp/my-card --upload-root /actual/mcp/uploads --idempotency-key my-request

node scripts/nora-cardforge.js inspect --input fixtures/empty-v2.json
node scripts/nora-cardforge.js diagnose --input fixtures/empty-v2.json --profile nora
node scripts/nora-cardforge.js mvu-plan --input fixtures/empty-v2.json --vars fixtures/mvu-vars.json --output /tmp/mvu.patch.json
node scripts/nora-cardforge.js apply --input fixtures/empty-v2.json --patch /tmp/mvu.patch.json --output /tmp/card.mvu.json
node scripts/nora-cardforge.js statusbar-plan --input /tmp/card.mvu.json --html fixtures/statusbar.html --output /tmp/statusbar.plan.json
node scripts/nora-cardforge.js apply --input /tmp/card.mvu.json --patch /tmp/statusbar.plan.json --output /tmp/card.final.json
```

Hermes and Codex load [SKILL.md](SKILL.md). Branch-specific instructions live under
`references/`; the deterministic writing scorer is vendored under `scripts/`.

Preparation does not import anything. After explicit authorization the agent calls
the existing `nora.world.import` MCP tool and verifies its operation/read-back.
That action creates a new World, not library-only storage. No additional MCP tools,
model credentials or Tavern backend changes are required. The old Python-backed
`install` command has been removed; see `references/import-install.md`.

## Nora Split

Nora should provide creative content:

- role/world text
- worldbook entries
- MVU variable intent
- status bar HTML
- repaired field text

The CLI should handle structure:

- card field placement
- worldbook/regex/tavern helper updates
- MVU schema and rule compilation
- status bar path validation
- PNG/JSON export

## Patch Format

Every mutation is represented as a patch before application:

```json
{
  "format": "nora-cardforge-patch/v1",
  "operations": [
    {
      "type": "upsertWorldEntry",
      "comment": "变量列表",
      "entry": {
        "content": "---\n<status_current_variables>\n{{format_message_variable::stat_data}}\n</status_current_variables>"
      }
    }
  ]
}
```

`apply` also accepts wrapped plan output:

```json
{
  "patch": { "operations": [] },
  "validation": { "passed": true }
}
```

## Test

```bash
npm test
```
