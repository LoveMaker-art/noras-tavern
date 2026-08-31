# image-size 2.0.2-tavern.1

This is a source-controlled security backport, not a new upstream release.
The package name is retained. The production lockfile resolves `image-size` to
this directory; no install-time patch or remote fork is required.

## Provenance

- Upstream: https://github.com/image-size/image-size
- Original npm version: 2.0.2, `dist/index.cjs` (line endings normalized).
- Original npm tarball integrity:
  `sha512-IRqXKlaXwgSMAMtpNzZa1ZAe8m+Sa1770Dhk8VkSsP9LS+iHD62Zd8FQKs8fbPiagBE7BzoFX23cxFnwshpV6w==`
- Original MIT license is included unchanged.

## Changes

- GHSA-w3rx-r6r6-pgpr: ICNS entry sizes must advance by at least the header
  length and stay inside the declared file/buffer boundary.
- GHSA-5p2g-fcmc-qvqq: validate ISO box headers and normalize zero-sized boxes
  to the remaining buffer. Matching HEIF/JXL boxes can no longer cause callers
  to reuse the same offset indefinitely.
- DataView reads respect the supplied Uint8Array slice, not its larger backing
  allocation. TIFF IFD scans honor the declared entry count rather than reading
  the next-IFD pointer or image pixels as additional directory entries.
- Reject non-finite or non-positive output dimensions.

The product continues to use `imageSize` through `src/image-dimensions.js`.
PNG, JPEG, GIF, WebP, BMP and TIFF remain supported by that adapter. This package
contains the buffer API (`imageSize`, `disableTypes`, `types`); unused upstream
CLI, filesystem entrypoints and development tooling are not shipped.

## Verification and maintenance

`tests/nora-dependency-security.test.mjs` exercises the dependency directly for
ICNS/HEIF/JXL samples, plus all six product formats and sliced buffers.
`tests/nora-image-dimensions.test.mjs` exercises the product's format boundary.
Both run inside the mandatory `test:nora` release check.

Registry audit does not audit local source forks. A clean audit is not evidence
that this code is vulnerability-free. Any update must preserve these regression
checks and review the source delta against the pinned upstream version.
