# Card Project Format

Read this reference before changing `card.project.json` or decompiled project
files.

## Layout

```text
card.md                    Authored prose and lore
card.project.json          Build policy and relative feature paths
assets/cover.png           Optional cover for PNG output
features/mvu.json          Optional authored MVU variable specification
features/statusbar.html    Optional authored fixed status template
source/original.*          Immutable imported artifact
source/passthrough.json    Imported card used as the round-trip base
source/extracted-*         Read-only advanced-feature summaries
build/                     Generated artifacts
reports/                   Quality and build evidence
```

The program rejects project paths that escape the project root. `init` and
`ingest` require an empty destination directory.

## Configuration

`format` must remain `nora-card-project/v1`. `slug` is lowercase ASCII letters,
digits, and hyphens. Feature paths are relative to the project root.

```json
{
  "format": "nora-card-project/v1",
  "slug": "example-card",
  "source": {
    "type": "new",
    "original": null,
    "passthrough": null
  },
  "build": {
    "profile": "release",
    "target": "v2-json+v3-png",
    "cover": "assets/cover.png"
  },
  "features": {
    "mvu": "features/mvu.json",
    "statusbar": "features/statusbar.html"
  }
}
```

Feature settings have distinct meanings:

| Setting | Actual build behavior |
| --- | --- |
| Relative path string | Read that feature file if it exists. A missing file is currently skipped, not necessarily an error. |
| Object with `path` | Read the specified relative file unless `enabled` is false. |
| `false` or `{ "enabled": false }` | Disable compiling this authored feature. Does not delete an imported script or live state. |
| `null`, omitted, or object without `path` | Auto-discover `features/mvu.json` or `features/statusbar.html` if present. Not an explicit disable switch. |

Ingested advanced features remain in the passthrough card by default; extracted
summaries are not automatically recompiled because recompilation would change
third-party technical content.

Other configuration fields:

| Field | Meaning and boundary |
| --- | --- |
| `source.type` | Provenance label such as `new` or `imported`, not a live runtime mode. |
| `source.original` | Original artifact path; an imported PNG can also supply a cover. |
| `source.passthrough` | Base JSON for rebuilding with imported fields. Not a chat-variable snapshot. |
| `build.profile` | `release` reports writing weaknesses; `release-strict` also gates writing score. CLI `--profile` takes precedence. |
| `build.target` | Current generated label `v2-json+v3-png`; the builder does not branch on this field. Changing the string does not select another exporter. |
| `build.cover` | Cover path. Without an available cover or original PNG, the build emits JSON only. |
| `mvu.keepFloors` | Defaults to 3; emits a prompt-filter Regex with `minDepth = keepFloors * 2`. It is not a stored-state retention policy. |
| `mvu.injectMode` | Default config contains `single`, but the MVU compiler currently ignores this option. No alternate injection mode is implemented here. |
| `statusbar.mode` | `mvu` (default) targets a placeholder; `text` targets `<StatusData>`. Other values currently fall into the MVU branch, not validation errors. See the feature reference. |

Use a nonnegative integer JSON number for `keepFloors`; the compiler itself only
tests whether it is a finite number, not whether it is a sensible message count.
`project-inspect` parses the prose and passthrough base without compiling feature
files. Its summary is not the final build's feature inventory.

## Lorebook Directives

These belong to worldbook entry headers in `card.md`, not to MVU state. Example:

```markdown
### 雨夜车站 | keys: 车站, 末班车 | secondary: 下雨 | logic: and_any | order: 100 | prob: 100
车站已关闭，仅剩值班人员。
```

| Directive | Meaning / emitted field |
| --- | --- |
| `keys` | Comma-separated primary triggers -> `keys`. The parser promotes entries without keys to `constant`. |
| `secondary` | Additional keyword filter -> `secondary_keys`; nonempty filters set `selective`. |
| `constant` | Keyword-independent activation, still subject to runtime enablement/budget/other applicable filters. |
| `order` | Insertion order -> `insertion_order`, default 100; not narrative importance or a stat. |
| `position` | `before_char` / `after_char`: placement around character definitions. |
| `depth` | Sets `extensions.depth` and depth-placement code `extensions.position = 4`; not keyword scan depth. |
| `role` | Depth-message role `system`, `user`, `assistant` -> codes 0, 1, 2; not character identity. |
| `logic` | Secondary-filter rule: `and_any` any present, `and_all` all present, `not_any` none present, `not_all` not all present. Emitted codes 0, 3, 2, 1 respectively. |
| `prob` | Activation probability 0..100 -> `probability` with `useProbability`; not a percentage chance of a story outcome. |
| `sticky` | Duration to remain active after triggering -> `extensions.sticky`. |
| `cooldown` | Duration before reactivation -> `extensions.cooldown`. |
| `recursion: exclude` | Set `exclude_recursion`: avoid activation by other entries. |
| `recursion: prevent` | Set `prevent_recursion`: avoid triggering further entries from this entry. |
| `group` | Inclusion-group name -> `extensions.group`; unrelated to MVU `group`. |
| `weight` | Relative selection weight -> `group_weight`; not a percentage or guaranteed winner. |
| `regex` | Emit `use_regex` for trigger matching; not a replacement script. |

Runtime meanings follow [SillyTavern World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/),
not a promise about Nora's runtime. Sticky/cooldown use messages, not dialogue
pairs; zero disables the timed effect. Budget, global settings, and target version
can affect activation. This Markdown parser accepts only the directives above;
unknown directives are ignored, not implemented. Numeric validation is incomplete
outside `prob`; do not interpret an accepted integer as a meaningful runtime value.

Unknown card fields are preserved by the passthrough base.
V2/V3 exports remove the six deprecated top-level V1 narrative aliases (name,
description, personality, scenario, first_mes, mes_example); their canonical
values stay in `data`. This avoids ST's V1-first validator misclassifying JSON.
Other unknown root and extension metadata remains preserved. Authored standard
fields and a present Lorebook section override their corresponding imported
fields; omitted advanced extensions remain untouched. The Markdown lorebook is
not a lossless editor for every third-party entry attribute: inspect reconstructed
entries before claiming a full round trip.

Source: [project engine](../src/project/project-engine.js),
[Markdown parser](../src/card-md/card-md.js). Plugin parameter explanations are in
[feature-explanations.md](feature-explanations.md); state-variable parameters are
in [variable-reference.md](variable-reference.md).
