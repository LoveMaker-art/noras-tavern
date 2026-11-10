# Nora Tavern

[中文](README.md)

## About

Nora Tavern is an open-source, World-centered AI role-playing application that can be managed by an Agent. Built on SillyTavern, it retains compatibility with complex character cards, lorebooks, scripts, and extensions while organizing stories around persistent Worlds.

Nora runs in Hermes Agent and uses Nora MCP to read and manage Tavern with the user's authorization.

## Features

- **Agent management:** Nora can work with Worlds, sessions, characters, memory, Story Profile, and application state.
- **World-centered stories:** characters, chats, resources, and persistent story state belong to a World.
- **SillyTavern compatibility:** support for the existing card, lorebook, Regex, script, and extension ecosystem, within the documented [compatibility boundaries (Chinese)](docs/product/tavern.md#plugins).
- **Long-running role-play:** Story Ledger and Story Profile organize story context and preferences.
- **Local deployment:** installation, updates, backups, and migration separate application code from user data.

## Installation

- **Full edition, Nora + Tavern:** deploy Tavern, Nora in Hermes Agent, and Nora MCP. Prepare the required environment and instance directories, configure a model, and connect a supported IM platform. [Core installation guide (Chinese)](docs/install-nora-tavern.md).
- **Light edition, Tavern only:** play locally without Nora's Agent management. [Source installation guide (Chinese)](docs/install-tavern.md).

Bring your own model API key. External model calls follow your provider's pricing and data-handling rules; local deployment does not mean fully offline operation. Local services must remain running for remote conversation and application access.

For an existing installation, follow the [core update and recovery guide](docs/update-nora-tavern.md). Authorize Nora/Tavern core updates in a Nora conversation, or use the appropriate explicit maintenance entry. Preserve instance configuration, Worlds, and sessions; do not delete user data to work around an uncertain maintenance state.

## Repository

| Directory | Responsibility |
| --- | --- |
| `app/` | Tavern, SillyTavern compatibility engine, Nora UI, World Core, model and lifecycle code |
| `story-profile/` | Authoritative Story Profile source; `app/story_profile_runtime/` is its generated snapshot |
| `nora-mcp/` | Hermes-to-Tavern MCP integration |
| `nora/` | SOUL.md, AGENTS.md, localized greeting, skills, and Hook |
| `deployment/` | Core installation, updates, recovery, and runtime/configuration logic |
| `tooling/` | Build, release verification, and source-to-delivery layout mapping |
| `tests/` | Core business, deployment, data protection, and shared execution contract tests |
| `docs/` | User guides, architecture, decisions, and historical records |

The release's `ops/` directory is generated for compatibility with the established installed layout. It is not a second editable implementation. Shared maintenance execution is consumed through a version- and digest-pinned external input, without requiring an adjacent repository. Keys, chats, installed dependencies, and runtime data do not belong in source control or release assets.

See [repository navigation](docs/REPOSITORY.md) and [CONTRIBUTING.md](CONTRIBUTING.md) for source ownership, development, testing, and packaging.

## Community and licensing

[Report an issue](https://github.com/LoveMaker-art/noras-tavern/issues) · [Contribute](CONTRIBUTING.md) · [Discord](https://discord.gg/2fxP9uYvpV2) · QQ group: 904830926

Include your operating system, version, and reproduction steps in feedback, and redact API keys, pairing codes, and other private information.

Nora Tavern is built on SillyTavern, and Nora runs in Hermes Agent. Preserve the licenses and attribution of the relevant components, including [SillyTavern's AGPL-3.0 license](app/engine/sillytavern/LICENSE).
