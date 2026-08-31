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
