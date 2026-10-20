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

## Automatic preference reflection

The Tavern integration defaults automatic preference reflection to on when no choice is stored. The existing Story Profile page provides the per-user “Automatically organize story preferences” switch. Saved on/off choices survive reopening and upgrades, including older choices without notice metadata; unreadable or malformed existing settings do not authorize new automatic calls. The original turn checkpoints and saved cursors remain. Manual reflection and profile reading do not change this choice. Disabling prevents new automatic requests (including a later derived-summary request), while an already sent request may complete and be billed. If learning is saved but its derived summary fails, the response and checkpoint retain that partial result instead of repeating learning.

The authenticated integration exposes `GET/POST /api/nora-story-profile/automatic-preferences`; only the boolean `enabled` is written there, and no credential is returned. Host CSRF transport is reused. Runtime choices live under the current Tavern user root, separate from the canonical profile and World cursors. Product policy remains in [N-Q01](../docs/product/nora.md#automatic-reflection-policy); implementation and isolated acceptance are recorded in the [task report](../docs/reports/20261020-tavern-design-coverage.md#import-model-consent-fix).
