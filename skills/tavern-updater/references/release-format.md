# Release Format

The updater reads the latest stable GitHub Release from `LoveMaker-art/noras-tavern`.

Required assets:

- `manifest.json`
- `tavern-release.tar.gz`
- `skill-manifest.json`
- `tavern-skill.tar.gz`

Legacy-instance bootstrap assets:

- `tavern-updater-bootstrap.py`
- `install-tavern-updater.sh`
- `bootstrap-manifest.json`

The updater ignores the bootstrap assets. They exist only to install this
updater skill on older instances that predate it.

Manifest schema:

```json
{
  "schema": 4,
  "scope": "tavern-system",
  "version": "<VERSION>",
  "archive": "tavern-release.tar.gz",
  "sha256": "<archive SHA256>",
  "managed_files": ["runtime/server.py"],
  "files": {
    "runtime/server.py": "<file SHA256>"
  }
}
```

The system archive contains backend application code, managed system skills,
and the updater itself:

```text
runtime/
  actor.py
  actor_self.md
  background_jobs.py
  card_import.py
  card_preparation.py
  continuity_model.py
  generation_service.py
  memory_cache.py
  message_segments.py
  model_registry.py
  model_retry.py
  personality_service.py
  production_views.py
  reply_format.py
  request_security.py
  runtime_cast_service.py
  runtime_http.py
  server.py
  state_store.py
  story_ledger.py
  story_profile.py
  story_state_service.py
  tts_service.py
  qwen_audio_voices.json
  .tavern-release-version
  assets/
    fixtures/
      starter/
        index.json
        *.png
  web/
    actor.html
    actor.js
    app.js
    bridge.js
    console.css
    i18n.js
    index.html
    security.js
updater/
  SKILL.md
  scripts/
  references/
  agents/
system-skills/
  model-api-manager/
```

The separately verified creative-skill archive contains the router and five specialist workflows:

```text
skills/
  tavern/
    plugins/
      tavern-soul-reload/
  tavern-world/
  tavern-story-profile/
  tavern-continuity/
  tavern-ops/
  tavern-world-visuals/
```

The skill manifest declares `install_mode: exact-directories`, the complete
official directory set, and the complete file/hash set. The updater backs up
every declared official directory and replaces those directories completely.
Every undeclared skill directory is untouched. The updater also takes the
canonical `AGENTS.md` from the verified updater archive, backs up the installed
file, and replaces `$HERMES_HOME/AGENTS.md` completely.

The official `model-api-manager` directory is managed with the same exact-directory
policy under `$HERMES_HOME/skills/system`. Other system-skill directories are outside
the release boundary. Source files live under `integrations/`; the build injects
ClawChat lifecycle scripts, the shared CLI, Hook files, and canonical `AGENTS.md`
into their installed Hermes paths so each file has one repository source.

Legacy versions without their own GitHub Release may be represented by two additional assets on the latest stable Release: `baseline-v<VERSION>-manifest.json` and `tavern-baseline-v<VERSION>.tar.gz`. The archive contains only the exact allowlisted runtime tree. Its schema-1 manifest binds the version, archive SHA256, complete file list, every file hash, and embedded `.tavern-release-version` marker. It is used only to distinguish official starter fixtures from local starter customization; it is never installed directly and never contains skills, updater code, credentials, identity state, or Tavern user data.

Every release review starts through the verified Bootstrap, which installs the
target release's updater before it reviews or applies the current manifests.
This avoids coupling manifest compatibility to the previously installed updater.
Historical comparison material uses only the tagged Release's verified system
manifest and archive. Creative skills are replaced from the target Release and
do not participate in legacy starter detection.

Only the manifest-listed runtime and frontend code files and the exact contents
of the declared creative-skill directories are release assets. Developer smoke
tools and host-side installers are not skill assets.
`runtime/actor_self.md` is the sole identity-adjacent exception: it is a neutral
seed template used only when runtime state is absent.
`$TAVERN_STATE_DIR/actor_self.md`, `SOUL.md`, other identity/persona files,
frontend backups, user uploads and images, runtime state, credentials, and
nonofficial skill directories are never release assets. Bundled starter
fixtures are official release assets. Legacy local starter additions, edits,
assets, and deletions are migrated into `$TAVERN_STATE_DIR/starter`, which is
loaded as a protected overlay over the official catalog.
Every regular archive file must appear in its archive's `managed_files` and
`files`. Build with `scripts/build_release.py`, then attach all generated assets
to a stable GitHub Release tagged `v<version>`.

Every published version intended to support future legacy starter extraction
should retain these verified assets. During review, the updater resolves the
installed version's tagged Release and compares only the starter catalog and
referenced assets. Release-managed runtime, frontend, updater, official skills,
and `AGENTS.md` are backed up and replaced exactly from the reviewed target.
After a successful update, the unmodified target Release is cached with version
and hash metadata. The target skill manifest must exactly match the current
official allowlist.
