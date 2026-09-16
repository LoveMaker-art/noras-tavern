# Nora Tavern Card Forge

No-UI World-card creation, assessment, prose polishing and authorized import for Hermes
and Codex. The folder is both a skill and a Node.js CLI package; its writing
scorer uses Python. Workflow instructions live in [SKILL.md](SKILL.md).

## Scope

- New cards: author a project, compile optional MVU, status UI and interactions, validate,
  export V2 JSON / dual-metadata PNG, then stage and import when requested.
- `card.project.json → world` owns the player and cast array. The compiler emits
  World Core data without fallback biographies. Whole-card Description is a reader
  summary, not a prompt. Import readback checks the actual persona
  and actors. Default builds do not run the optional `--score-writing` scorer.
- Existing cards: inspect and explain the original data, then hand the unchanged
  file to Tavern when import is requested. Authorized prose polishing writes a new
  copy with exact, hash-bound text edits, preserving technical data. There is no
  protocol-conversion workflow. See [prose-polishing.md](references/prose-polishing.md).
- New authored MVU carries an upstream baseline and opts into Nora enhancements
  with `[nora_mvu/1]`. The managed runtime replaces only the marked baseline format
  in requests. Existing cards keep their own protocol and need not have Zod.
- New MVU fields use one typed `nora-mvu-fields/v1` source for initial values,
  generated Zod and update rules. Literal UI bindings are checked against the same
  paths; custom scripts and interactive UI are preserved and require runtime
  acceptance. See [field standard](references/variable-reference.md).

The CLI does not configure keys or call models. Its former `apply`, `mvu-plan`
and `statusbar-plan` commands have been removed. The internal compiler still
shares an operation engine for assembling new cards. Project ingestion and
round-trip support remain for existing project tooling and regression checks;
they are not prerequisites for original-file imports.

## Local use

```bash
node scripts/nora-cardforge.js --help
node scripts/nora-cardforge.js init --project /tmp/my-card --name "世界名" --slug my-card
# Author card.md and optional feature files, then:
node scripts/nora-cardforge.js build --project /tmp/my-card
node scripts/nora-cardforge.js inspect --input fixtures/empty-v2.json
node scripts/nora-cardforge.js diagnose --input fixtures/empty-v2.json
```

For new-card staging and MCP handoff, use
[import-install.md](references/import-install.md). Preparing an artifact does not
import it; a completed import does not prove browser scripts or MVU activated.

## Tests

```bash
npm install
npm test
# In a repository checkout containing the matching Nora runtime:
npm run test:runtime
# With a pinned patched upstream checkout and a downloaded, hash-checked helper:
NORA_MVU_SOURCE_DIR=/path/to/source NORA_UPSTREAM_ZOD_PATH=/path/to/mvu_zod.js npm run test:portable
```

Zod, YAML and lodash are development-only test dependencies; the CLI adds no
production package dependency. Runtime integration can target another matching
checkout with `NORA_TAVERN_ROOT` pointing to its repository root.

Tests cover typed defaults, generated Zod, rejected paths/types, display bindings,
read-only inspection, metadata round trips and source/artifact-bound staging.
The optional integration test executes generated registration against the actual
Nora MVU helper with controlled host services. Neither test group calls a model,
operates a browser or establishes full runtime playability.

The portable integration builds one PNG from `fixtures/portable-world`, reads
untouched upstream modules via `git show 7fe9ae7:...`, and compares accepted
updates with Nora's actual executor/helper. Host storage/events and model output
remain controlled substitutes. The helper download SHA is checked by the test;
its pinned URL is in the MVU compiler. Set `NORA_PORTABLE_ARTIFACT_DIR` to a new
directory to retain the test project and PNG for authorized browser acceptance.
