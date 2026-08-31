# Tavern Index Coverage

## Same-repository release audit — 2026-08-31

The current candidate is `release/nora-refactor-20260831`, based on GitHub main
`aaa1afceb2e40512cdd52b91e6db4924387c2db9`. It includes `story-profile/` as
ordinary source, not a submodule. See [the current audit](MONOREPO-RELEASE-20260831.md).
The dated sections below are historical evidence, not the current deployment state.

Codebase MCP project `nora-release-20260831` was rebuilt in full mode against the
full-delivery candidate: 248582 nodes / 334721 edges at the code refresh. It now
includes same-repository Nora MCP, CardForge and the full-release updater. Generated
bundles, installed dependencies and the managed Helper/MVU vendor trees remain
excluded. Graph totals include third-party code and do not prove semantic coverage
of every file or arbitrary card script. Exact source searches supplement the graph.

The retired `ops/scripts/tavern_cli.py` and `native_tavern.py` definitions are absent
from the refreshed graph and filesystem; negative tests still name them intentionally.
`project-index.json` is regenerated for the candidate and now classifies canonical
Story Profile, MCP, Hermes skills and updater source separately. The
snapshot manifest remains authoritative for generated Actor UI files.


## Current audit baseline — 2026-08-30

Repository: `nora-tavern/tavern`.
Implementation baseline: `main@9f0ba72634e1fbbd93bb915d4a9c61cd25b50ab5`.
The worktree was clean at the original audit start. The subsequent release
hardening turn **changes product code, tests, packaging and the dependency lock**.
HEAD remains the baseline; the current implementation includes uncommitted changes.
Read [the hardening record](RELEASE-HARDENING-2026-08-30.md) for that overlay.

See [the release audit](TAVERN-RELEASE-AUDIT-2026-08-30.md) and its
[machine-readable evidence](TAVERN-RELEASE-AUDIT-2026-08-30.json).
Index coverage is not proof of product correctness or release approval.

## Latest convergence refresh — 2026-08-30

The current local implementation additionally retires Nora-only card preparation,
creation/import bypasses and the unused pre-import duplicate scanner, and restores
the missing capability-rerender projection. See the final section of
[the hardening record](RELEASE-HARDENING-2026-08-30.md). The previous packaged
candidate does **not** include this overlay.

Full MCP refresh after these source/test/build changes: 246318 nodes,
325554 edges, 838 File nodes. The comparison excludes the now-deleted tracked
test instead of counting it as a coverage gap: 1135 existing project paths,
487 code paths, 469 represented code paths. The same 18 generated/vendor/Actor/
shell-wrapper gaps listed below remain; their existence is not semantic coverage.
The removed `prepareCharacterRuntime`, `waitForCharacterRuntime`, `findDuplicate`
and `sourceFingerprint` definitions have zero matches in the relevant Nora graph
scope, confirmed against source and the rebuilt JS. Original ST import APIs remain.

The current graph path list is saved in ignored
`local-state/release-hardening/convergence-mcp-files.json`. Documentation refreshes
can change graph totals. `project-index.json` records exact current content hashes
and retains the deleted test as `kind: missing, status: deleted` until commit;
this is deletion tracking, not shipped code or an unindexed source file.

## Release-hardening refresh — 2026-08-30

The full graph was rebuilt after the implementation changes, with persistence:
246326 nodes / 325587 edges / 839 File nodes at the implementation refresh.
The independent file comparison includes tracked plus non-ignored new files:
1136 paths, 488 code paths, 470 code paths represented in the main graph.
Later documentation/index refreshes can change graph totals without changing
the runtime; the tool result and content manifest record the corresponding scope.

18 code paths lack File nodes: Actor JS, eight Nora compiled JS files, Helper
compiled JS, six iframe vendor scripts, the MVU vendor bundle and the four-line
`package-release.sh` wrapper. The wrapper was read directly and passed `sh -n`;
its actual logic is in the indexed `package-release.mjs`.
Actor/Helper were re-parsed with TypeScript: 11/2004 named function/class
declarations, zero syntax diagnostics. This is still a syntax supplement,
not a claim that those files have full semantic MCP coverage. MVU's unchanged
supplementary index remains the original audit provider.

Current gap hashes and path comparison are in ignored
`local-state/release-hardening/index-coverage.json`; shipped file hashes are
also present in `project-index.json` and the candidate artifact manifest.

## Current index providers

### 1. Codebase Memory MCP

A full index was built with `index_repository`, project name `tavern`,
persistence enabled. The compressed artifact is
`.codebase-memory/graph.db.zst`, intentionally Git-ignored.

The initial clean-code baseline contained:

- 826 File nodes, 246121 total nodes, 325222 edges.
- Branch HEAD verified through the graph: `9f0ba72634e1fbbd93bb915d4a9c61cd25b50ab5`.
- 1121 tracked paths, 71974585 tracked bytes; 476 code paths by JS/MJS/CJS/TS/TSX/Python/shell extension.
- 459 of those code paths represented in the main graph.
- All 98 non-test authored paths selected by the audit's Nora/ops naming rule
  were present. This rule does not include every direct patch to upstream ST.
- No indexed private/untracked runtime paths in that baseline.

These are baseline counts, not a claim that every graph node is authored code.
The final refresh also reads the new audit documents. Third-party minified
libraries generate many Variable nodes; use path scopes and inspect source
before interpreting complexity, recursion, similarity or unused-symbol signals.

The tool's `skipped_count: 0` did not imply that every tracked source file had
a File node. Coverage was independently compared with `git ls-files`.

### 2. Explicit gap handling

The main graph excludes generated distributions and several vendor directories.
Most have authoritative source elsewhere in the same repository and should not
be counted as a second implementation.

Two exceptions required additional verification:

- `app/native-extensions/nora-mvu/vendor/bundle.js`: indexed directly as
  `tavern-mvu-runtime` (2099 nodes, 9108 edges, one File node).
- `app/native-extensions/JS-Slash-Runner/dist/index.js`: the attempted
  `tavern-helper-runtime` project contains only `index.css`, not the JS file.
  Do not claim that this supplementary MCP index resolves Helper execution.

The main graph also lacks a File node for `app/engine/sillytavern/public/actor.js`
(some symbol-level search results exist; they do not establish full coverage).
Actor and Helper JS were parsed separately using the installed TypeScript AST
parser and hashed without modifying their source. There were no syntax
diagnostics; 11 and 2004 function/class declarations were found respectively.
The audit JSON records their hashes and the Helper public-method bindings.
Detailed declaration inventories live in ignored audit material.

This AST inventory supplements coverage; it is **not** a substitute for a
Codebase MCP semantic call graph. Dynamic iframe/global/event dispatch still
needs call-site inspection and runtime verification.

### 3. Content-addressed manifest

`docs/architecture/project-index.json` records actual paths, hashes, sizes,
roles, exclusions, HEAD and worktree overlay. It was regenerated for this audit;
its own `counts` field is the source of current totals.

Unlike the MCP graph, it includes the Helper JS, Actor JS, MVU bundle and
shipped build outputs. It excludes itself (to avoid recursive hashing), mutable
state, installed dependencies, release copies and the iframe vendor tree.

The role/generated classifier is heuristic. In particular, some Story Profile
snapshot paths are classified as other source/configuration rather than
generated output. Source ownership remains the sibling Story Profile project,
as documented by its snapshot manifest; do not treat that classification as
permission to edit the runtime copy independently.

## Historical structural index

The sibling `../st-mcp/docs/nora-tavern-index.json` and Markdown projection are
a separate historical provider, previously generated from
`406aa0e59466adbf222d40a29026b54b7f2e5403` plus an overlay on 2026-08-29.
Its 1063-file / 429-module / 2776-dependency / 224-route figures are not current
Codebase MCP statistics.

This audit did not alter the sibling project or regenerate its historical
index. Use the current graph and content manifest above for this candidate,
rather than combining incompatible counts from the two providers.

## Refresh and verification

From the Tavern root:

```sh
node ops/scripts/index-project.mjs
```

Through Codebase MCP:

```json
{
  "repo_path": "/absolute/path/to/nora-tavern/tavern",
  "name": "tavern",
  "mode": "full",
  "persistence": true
}
```

If the managed MVU bundle changes, refresh its supplementary project separately.
For future Codebase tool versions, retry and independently verify the known
Actor/Helper File-node gaps; do not infer success from the status field alone.

An index is fit for this audit only when:

1. Its baseline HEAD and overlay are identified.
2. Graph File paths are reconciled with actual tracked source paths.
3. Missing files and heuristic exclusions are named.
4. Content hashes match an independent calculation.
5. Caller/dependency conclusions are checked against the actual Interface,
   including dynamic dispatch that static graph extraction cannot resolve.

Neither successful indexing nor valid syntax establishes that all third-party
cards, model providers, browser branches, target-host permissions or Liveware
cache states work.
