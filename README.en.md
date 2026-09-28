# Nora Tavern

[中文](README.md)

## About

Nora Tavern is an open-source, World-centered AI role-playing application that can be managed by an Agent. Built on SillyTavern, it retains compatibility with complex character cards, lorebooks, scripts, and extensions while organizing stories around persistent Worlds.

Nora runs in Hermes Agent and uses Nora MCP to read and manage Tavern with the user's authorization.

## Features

- **Agent management:** Nora can work with Worlds, sessions, characters, memory, Story Profile, and application state.
- **World-centered stories:** characters, chats, resources, and persistent story state belong to a World.
- **SillyTavern compatibility:** support for the existing card, lorebook, Regex, script, and extension ecosystem.
- **Long-running role-play:** Story Ledger and Story Profile organize story context and preferences.
- **Local deployment:** installation, updates, backups, and migration separate application code from user data.

## Installation

- **Full edition, Nora + Tavern:** use the integrated desktop launcher to install Hermes and the Nora system. Platform builds cover macOS Apple silicon, macOS Intel, and Windows x64. [Installation guide (Chinese)](docs/install-nora-tavern.md).
- **Light edition, Tavern only:** play locally without Nora's Agent management. [Installation guide (Chinese)](docs/install-tavern.md).

For an existing installation, follow the [update guide](docs/update-nora-tavern.md). Launcher-managed installations use the launcher's complete-system updater, not the standalone Tavern update command. Desktop launcher upgrades and installed-system upgrades are separate operations.

## Repository

| Directory | Responsibility |
| --- | --- |
| `app/` | Tavern, SillyTavern compatibility engine, Nora UI, World Core, model and lifecycle code |
| `story-profile/` | Authoritative Story Profile source; `app/story_profile_runtime/` is its generated snapshot |
| `nora-mcp/` | Hermes-to-Tavern MCP integration |
| `nora/` | SOUL.md, AGENTS.md, localized greeting, skills, and Hook |
| `launcher/` | Desktop shell, production UI, artwork, and previews |
| `deployment/` | Installation, updates, uninstall, and shared runtime/configuration logic |
| `tooling/` | Build, release verification, and source-to-delivery layout mapping |
| `tests/deployment/` | Deployment and launcher regression tests |
| `docs/` | User guides, architecture, decisions, and historical records |

The release's `ops/` directory is generated for compatibility with existing installers. It is not a second editable implementation. Keys, chats, installed dependencies, and runtime data do not belong in source control or release assets.

See [repository navigation](docs/REPOSITORY.md) and [CONTRIBUTING.md](CONTRIBUTING.md) for source ownership, development, testing, and packaging.
