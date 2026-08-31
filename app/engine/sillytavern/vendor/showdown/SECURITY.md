# Showdown 2.1.0-tavern.1

This is a source-controlled security backport, not an upstream upgrade to 3.x.
The package name and Converter/extension interfaces are retained. The lockfile
resolves `showdown` to this directory, so the chat renderer and ST library export
use the same implementation. There is no install-time or per-message patch.

## Provenance

- Upstream: https://github.com/showdownjs/showdown
- Original npm version: 2.1.0, `dist/showdown.js` (line endings normalized;
  renamed to `index.cjs`, obsolete source-map reference removed).
- Original npm tarball integrity:
  `sha512-/6NVYu4U819R2pUIk79n67SYgJHWCce0a5xTP979WbNp0FL9MN1I1QK662IDU1b6JzKTvmhgI7T7JYIxBi3kMQ==`
- Original MIT license is included unchanged.

## Changes

- GHSA-rmmh-p597-ppvv / CVE-2024-1899: replace the three anchor-label regex
  searches with a precomputed label-end scan implementing the existing 2.x
  grammar. Match destination/title suffixes at those endpoints and retain the
  existing anchor writer and before/after extension events. This removes the
  repeated unbounded bracket scan without truncating messages or disabling links.
- GHSA-cr32-g25g-vxjj: escape angle brackets in metadata before document-head
  interpolation, backporting the relevant behavior from upstream commit
  https://github.com/showdownjs/showdown/commit/184a3e4
  without adopting its broader 3.x parser changes.
- GHSA-22g5-r2x5-97cx: escape table-header ID attribute delimiters. Preserve both
  `tablesHeaderId` and the legacy `tableHeaderId` option.

DOMPurify, ST's existing unhashHTMLSpans behavior, Markdown extensions, user
configuration and HTML-card handling are unchanged. Showdown is still a Markdown
renderer, not a sanitizer: arbitrary raw HTML must still pass through the host's
appropriate sanitization policy. Unused upstream CLI/commander are not shipped.

## Verification and maintenance

`tests/nora-dependency-security.test.mjs` covers the known attack samples, actual
dependency resolution, extension registration/removal, and 69 saved original
2.1.0 outputs including ST's current underscore/unhash extensions. Those samples
are code-level compatibility evidence, not a claim about every third-party card.
The release's mandatory `test:nora` includes these tests.

Registry audit does not audit local source forks. A zero registry finding count
does not establish safety of these modifications; regression tests and source
review remain necessary. Future upstream adoption must explicitly compare the
fixed algorithms and all existing extension contracts. Do not silently replace
this directory with an unpatched 2.1.0 tarball.
