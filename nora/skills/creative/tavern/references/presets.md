# Prompt presets

Use the installed `nora.control.catalog`, `clients`, `read`, `execute` and
`operation` workflow from SKILL.md. These actions require an online Tavern page.
An unavailable page is a pending operation, not permission to edit runtime files.
The file-import tool below is server-side and does not require an online page.

## Author or import a JSON file

1. Load this reference before choosing tools. Discover `nora.preset.import` and
   `nora.config_locations`; use the returned upload directory, not a fixed path.
2. For authoring, write a complete ST chat-completion JSON in that staging directory.
   Preserve `prompts` identifiers, dynamic markers and `prompt_order` (including
   the `character_id: 100001` group). Use an inspected working template or the
   user's supplied JSON as the base. File creation is staging, not a runtime edit.
3. For an uploaded file, stage its JSON intact. Maximum UTF-8 file size is
   10 MB (10,485,760 bytes). Call `nora.preset.import` with filePath, name and
   confirm after authorization. Pass the path, not file contents in control params.
4. Check saved, revision and warnings. Import preserves all fields in the library,
   but does not select a global preset, apply to a World or enable scripts.
   Same name/content reuses; conflicting content requires another name, never an
   automatic overwrite. After an uncertain response, retry the same name/file.
5. A parameter warning means saved but not ready to apply. Explain the exact
   unsupported parameter and obtain agreement before adjusting it; file size
   and model context limits are unrelated. Apply separately using the flow below.
   Refresh an already-open library to show the imported template.

Large `preset.inspect` replies may return contentOmitted with revision and count
instead of full text. This omits only the tool response, never file content.
Use the source JSON for complete authoring; do not reconstruct from that summary.
The 256,000-character control-parameter limit still applies to incremental edits,
not file import. Splitting edits is not equivalent to preserving a complete file.

## Select the scope

- Library template: reusable configuration; saving does not apply it to any World.
- World preset: an independent copy; editing or applying changes only that World.
- Ask which scope when the request is ambiguous. Confirm the target page/World;
  library operations can use a page with no active World, with its actual empty IDs.

## Read, write, verify

1. Discover the `preset.*` catalog entries. `preset.list` lists template names.
   `preset.inspect` reads a named `library` template or the current `world` copy
   (`name: ""` for world scope). Preserve the returned revision.
2. For a new template, choose and inspect an existing base, then call
   `preset.create` with `source: {name, revision}`, a new name and `edits`.
   Base it on a working preset so dynamic chat/character/worldbook slots remain.
3. For changes, use `preset.edit` with scope, name, expectedRevision and edits.
   Prompt edits address stable IDs: `{operation: "update", id, patch: {content}}`.
   Create requires a unique ID and content; delete requires an existing ordinary
   prompt ID. New prompts are appended enabled; set order explicitly when needed.
   `order` is the complete intended identifier/enabled list: retain existing
   entries unless removal was requested. Dynamic marker entries are protected.
   Role and insertion fields, and allowed generation parameters, are in the catalog.
4. Applying is separate: inspect the library source and target World, then use
   `preset.apply` with sourceRevision and the World's expectedRevision. To save
   a World copy back into the library, use `preset.save-as` with a new name and
   the World revision. Same-name conflicts require explicit resolution, not retries.
5. Query the operation receipt and re-inspect the same scope. For World changes,
   check both saved and runtimeApplied. A saved-but-unapplied result needs recovery
   by reopening the World, not another template creation. Re-read stale revisions.

Preset authoring changes instructions and their order, not model connections,
credentials, character-card fields or Worldbook entries. It makes no story model
call. Library edits preserve existing executable extensions, but neither saving
nor applying a World preset authorizes their execution. Script work is a separate
request handled by the plugin reference. Wait for ongoing generation/MVU work
before applying changes; do not stop the user's generation automatically.
