# ST Prompt Template Runtime

Nora bundles [ST-Prompt-Template](https://github.com/zonde306/ST-Prompt-Template)
from commit `191ba3bbe0cf47771c3fd2632a9e45730ef92121` (version `1.16.3.0`) under
the AGPL-3.0 license.

This extension provides the EJS (`<% ... %>`) prompt preprocessing and
`getvar`/`setvar` APIs used by complex SillyTavern cards and World Info. It is
shipped as a managed local extension so card execution never depends on a
runtime GitHub download. Auto-update is disabled; version changes are applied
through Nora's release process after compatibility review.

The release contains only the browser runtime, worker, required libraries,
locales, settings template, manifest, license, and this provenance record. It
does not ship source maps, development dependencies, tests, or repository
metadata.
