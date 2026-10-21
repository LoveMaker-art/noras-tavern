# Story Profile

Story Profile is the independent source project for Nora's preference profile,
growth timeline, reflection logic, and original actor-facing interface.

## Project interface

- `core/` owns the canonical profile and reflection implementation.
- `public/` owns the original Story Profile UI assets.
- `adapters/nora/` adapts the module to Nora Tavern.

Nora Tavern consumes this project through its Story Profile synchronization
script. Both projects live in the same Git repository, but the profile module
retains its own core, adapters, UI and tests. Production releases contain a
verified snapshot, so a deployed Tavern does not need a second source checkout
or a second web server. Edit this directory, then run `npm run sync:story-profile`
from `app/engine/sillytavern`; do not hand-edit `app/story_profile_runtime`.

Run offline projection tests from the repository root:

```sh
python3 -m unittest discover -s story-profile/tests
```

## Reflection execution contract

Automatic reflection defaults on when no setting exists, without fabricating a recorded user choice. Existing boolean choices, including explicit off and choices from older notice versions, are preserved; unreadable settings report an error rather than falling back to on. Its control and content/cost notice are in Tavern's existing curator side-panel section, not below the archive timeline. The archive keeps its original display and personality editor. Reads do not dispatch a model call; automatic dispatch still requires the existing story-progress eligibility. Explicit manual reflection through the existing handoff/API/MCP remains available while automatic reflection is off and does not change the switch.

The USER.md projection follows Hermes' configured `memory.user_char_limit`, counts the entire resulting file including unmanaged content and markers, and reserves103 characters for one100-character memory plus its delimiter. Nora installation/normal update migrates missing settings or the previous1375/1875 defaults to2000 once and preserves other custom limits. Hermes' own1375 fallback is respected before that config migration. Reading a present Hermes YAML config requires the existing Hermes PyYAML runtime. The compact `taste_profile_v2` has four groups: story tastes4, narrative habits3, co-creation3, boundaries4; each value is at most100 Unicode characters (1400 total). Old eight-field summaries and source preferences remain intact. An over-limit or stale summary is not silently cut; the user target reports pending while the memory target can still succeed. This change does not redesign preference retirement.

The archive yearbook formats the existing validated ledger directly: story name, scene/player status, the last three saved events and the first two unresolved matters. Earlier events and remaining matters stay available in a read-only disclosure with complete source sentences. No generated reader-prose protocol, extra model call, recap-field dependency or legacy-data migration is required. The page shows three most recently played stories by default, with a read-only expansion for the rest, and hides machine identifiers and runtime state. The archive yearbook reads validated plot progress per World/Session, independently of preference-learning history. Saved prepared summaries can be displayed and projected before they are activated for a generation; these states remain distinct. Plot is no longer written into persistent MEMORY.md. A verified legacy Tavern plot block is backed up and removed while unrelated Hermes memory remains intact; no block means no file creation. USER preference synchronization and legacy-block cleanup report independently. World/Session ledgers and archive history remain the source for bounded on-demand reads, without an extra summarization model. Nora's read-only `nora.story.progress` tool can additionally return a bounded recent narrative window when a summary is missing, disabled, stale or incomplete, with coverage and omitted history explicit. Pure reads never enable compression, repair storage or write memories.

Reflection processes a bounded recent or incremental source window, with exact World/Session/revision coverage. It sends compact active preferences rather than the entire Markdown archive. Output follows the saved Tavern text-model budget. The full prompt is also bounded by a conservative UTF-8 byte estimate with room reserved for output; over-budget source messages are not silently marked reviewed.

The extraction response must be explicit `NONE` or validated JSON with user-message evidence. Empty/truncated replies are failures. Preferences/events use recoverable commits and durable source receipts; a failed derived summary resumes independently. Similar wording does not authorize overwriting an existing or locked preference.

The native host supplies the actual per-target proxy route. The Python client never reads ambient OS proxy settings. Direct and HTTP(S) proxy routes are supported; SOCKS/PAC routes return an explicit unsupported error. Credentials and proxy passwords stay inside the adapter input, never status or diagnostics.

Runtime snapshots are generated from this project. Native Mac/Windows source acceptance and live model tests do not establish installer or rollout acceptance. See the [reflection acceptance record](../docs/verification/story-profile-reliability-20261021.json) and the [compact preferences and plot-memory flow acceptance](../docs/verification/story-profile-plot-memory-flow-20261021.json).
