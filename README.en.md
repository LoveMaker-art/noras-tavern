# Tavern

[中文](README.md)

Tavern is a World-centered role-playing runtime for a single-user Hermes / ClawChat workspace. It reuses SillyTavern compatibility for character cards, lorebooks, scripts, and extensions while Nora World Core owns Worlds, sessions, resources, and persistent state.

Current stable release: [v2.0.13](https://github.com/LoveMaker-art/noras-tavern/releases/tag/v2.0.13)

## What it provides

- Import PNG, WebP, JSON, or CHARX cards as independent Worlds.
- Use compatible SillyTavern cards, lorebooks, Regex scripts, Tavern Helper, and MVU features.
- Send, stop, edit, regenerate, and request smart replies in a session.
- Compress every 15 completed rounds through the Story Ledger instead of always injecting the full conversation.
- Generate and view preference, timeline, and projection data through Story Profile.
- Read and operate Tavern through Nora MCP and four managed Hermes skills.

The ST compatibility engine remains because complex cards depend on it. World identity, session binding, resource references, and durable operations belong to Nora World Core; Tavern is not merely a renamed ST page.

## Check your installation first

| Current environment | Stable updater support | Outcome |
| --- | --- | --- |
| An existing Python-era Tavern | Supported | Recognized cards, lorebooks, Worlds, chats, and Story Profile data are migrated before switching to Node Tavern |
| An existing current Node Tavern | Supported | Managed program directories are replaced while target-host data and model configuration are preserved |
| A blank Hermes installation with no Tavern | Not yet supported | The published command is an updater and migration tool, not a fresh-install bootstrap |

Do not present the update command below as a fresh installation command. A blank installation still needs program provisioning and explicit creation of the two Liveware Apps; that flow has not been released as a stable one-command installer.

## Update or migrate

### 1. Before the update

- Confirm that Hermes / ClawChat and Liveware are available on the target host.
- Pause active Tavern generations and other writers.
- The target needs Node.js 20+, npm, curl, and Hermes' Python environment.
- Do not manually remove the old Tavern, Worlds, chats, model configuration, or Story Profile data.

### 2. Run the stable updater

Run this on the target host, or ask Hermes to execute it exactly:

```sh
curl -fsSL https://github.com/LoveMaker-art/noras-tavern/releases/latest/download/install-tavern-updater.sh | sh -s -- --apply --confirm
```

The command selects the latest stable GitHub Release. It verifies the release manifest and checksums, prepares dependencies, backs up the installed version, and directly updates Tavern, Story Profile, Nora MCP, the managed skills, and AGENTS.

### 3. Reload Hermes

After the terminal reports `installed`, send this in the **ClawChat conversation**:

```text
/restart
```

This is a ClawChat command, not a shell command. It reloads MCP, skills, and AGENTS. The updater does not restart the parent Hermes process that is executing it.

### 4. Verify the outcome

- The two existing Liveware entries remain **Tavern** and **Story Profile**; no duplicate Apps are created.
- Both entries open successfully.
- The target host's model configuration and credentials remain in place. Release assets contain no developer models or secrets.
- Compatible Worlds, cards, lorebooks, chats, and Story Profile data remain usable.
- Nora MCP and the four managed skills load in the new session.

## Data behavior

Program installation and legacy Python data import have separate outcomes:

- Existing Tavern state is backed up before the switch.
- Records that can be converted safely are imported into Node Tavern.
- An incompatible individual record is archived with a pending-conversion report instead of blocking the program update.
- A World with missing dependencies is not activated as a partial World.
- An invalid Story Ledger never replaces valid raw chat history.
- Valid Story Profile data and the target host's model configuration are preserved.

The complete backup is stored under `tavern-backups/<time>-<version>-<id>` in the target Hermes directory. Keep it until the new runtime and data have been accepted.

## If an update stops

- A `partial` data-import result means the program installed successfully while some legacy records still need conversion. It is not, by itself, a rollback reason.
- If the new Tavern genuinely cannot start, the updater directly restores the backup and reports whether recovery succeeded.
- Local health checks do not prove that public Liveware routing, every complex card, or every model provider has passed browser acceptance.

See the [full release and recovery contract](ops/skills/system/tavern-updater/references/release-compatibility.md) for operational details.

## Repository layout

| Path | Purpose |
| --- | --- |
| `app/` | Node Tavern, the ST compatibility engine, Nora World Core, Nora UI, model and lifecycle code |
| `story-profile/` | Story Profile core, original UI, Nora adapter, and tests |
| `nora-mcp/` | Nora MCP source, tool contracts, and tests |
| `ops/skills/` | Four managed Hermes skills and the managed Tavern AGENTS block |
| `ops/updater/` | Release download, backup, migration, direct directory replacement, and startup recovery |
| `docs/` | Architecture decisions, compatibility evidence, execution records, and release notes |

Runtime state, model credentials, logs, caches, and installed dependencies are not release source or release payloads. Tavern is intended for one user/Agent trust boundary per instance, not as one shared public multi-tenant service.

## Development and release work

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, verification, Story Profile synchronization, and release packaging.

Additional references:

- [v2.0.13 release notes](docs/releases/2.0.13.md)
- [Complex-card compatibility matrix](docs/architecture/COMPLEX-CARD-COMPATIBILITY-MATRIX.md)
- [Nora MCP capabilities and boundaries](nora-mcp/README.md)
- [Story Profile source project](story-profile/README.md)
- [Architecture decision records](docs/adr/)
