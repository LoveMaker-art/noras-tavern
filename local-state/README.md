# Local Runtime State

This directory contains a private snapshot of the active Tavern state for local compatibility and workflow testing.

Included:

- Worlds, characters, chats, settings, and installed frontend extensions from the active `default-user` data root.
- Dependency and non-secret model metadata.

Excluded:

- `secrets.json` and historical secret copies.
- `cookie-secret.txt`.
- Logs, PID files, Python bytecode, and caches that are not required to reproduce behavior.

Everything in this directory except this file is ignored by Git.
