# Advanced Cards

Read this reference only for MVU, Regex, TavernHelper, or status-bar work.
For user questions, read [feature-explanations.md](feature-explanations.md).
Before authoring variable types or constraints, read
[variable-reference.md](variable-reference.md) for their implemented limits.

## MVU Variables

Declare intent as data in `features/mvu.json`; the compiler generates the Zod
schema, initialization entry, update rules, output contract, helper scripts,
Regex transforms, and placeholder.

```json
{
  "variables": [
    {
      "group": "角色状态",
      "field": "信任",
      "type": "number",
      "default": 0,
      "min": 0,
      "max": 100,
      "clamp": true,
      "description": "Only change after observable trust-building or betrayal."
    },
    {
      "group": "场景",
      "field": "地点",
      "type": "string",
      "default": "未知"
    }
  ]
}
```

Supported types are `string`, `number`, `boolean`, `array`, `record`, and `enum`.
Nested fields use dots, for example `关系.阶段`. A leading `_` is an instruction
convention: the generator omits its update-rule prose and asks the model not to
write it. It does not generate a read-only permission check or a derived formula.

## Status Bar

Write a complete fixed template in `features/statusbar.html`. It may reference
MVU fields as `stat_data.角色状态.信任`. Every referenced path must exist.

The validator statically rejects recognized patterns for network access,
external scripts, persistence, cookies, and unresolved tab targets. This is not
a JavaScript sandbox or a full security audit. Prefer fixed HTML/CSS and local
variable rendering. The template is never executed by the build process.
Generated MVU helper scripts separately contain remote module imports; a local
build does not prove those modules are available in the target runtime.

## Imported Complex Cards

`ingest` preserves original Regex and TavernHelper structures in
`source/passthrough.json`. It may also extract readable MVU and status summaries.
Keep those source files unchanged unless the user explicitly asks to replace the
technical implementation.

Rebuilding an imported card without enabled authored feature files preserves its
omitted technical blocks. A null feature setting still auto-discovers the default
file; use false to disable feature compilation, as defined in the project reference.
Adding `features/mvu.json` or `features/statusbar.html` deliberately upserts the
Nora-managed implementation and should be described as a migration.

## Runtime Evidence

The build checks supported structure, recognized variable paths, and packaging.
It does not execute arbitrary script syntax, prove native storage, or verify
browser lifecycle behavior. Storage requires a separate authorized installation
and read-back through Nora MCP. When runtime verification is requested, use the
`tavern` skill's current MCP plugin/MVU controls and World snapshot for the exact
World/Session. Report stored structure and observed activation separately.
