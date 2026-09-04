import assert from 'node:assert/strict';
import fs from 'node:fs';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';

import { buildRuntimeManifest } from '../build/generate-nora-runtime-assets.mjs';

const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const manifest = await buildRuntimeManifest();
const manifestBrotliSize = brotliCompressSync(Buffer.from(`${JSON.stringify(manifest)}\n`), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
}).length;
const shellHtmlBrotliSize = brotliCompressSync(Buffer.from(index), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
}).length;

assert.ok(manifestBrotliSize <= 550_000, `critical module manifest exceeds 550 KB Brotli budget: ${manifestBrotliSize}`);
assert.ok(shellHtmlBrotliSize <= 24_000, `visible shell HTML exceeds 24 KB Brotli budget: ${shellHtmlBrotliSize}`);
assert.equal(manifest.legacy, 'dist/nora/legacy.js', 'legacy libraries must use their immutable standalone asset');
assert.equal(manifest.compiled?.['lib-core.js'], 'dist/nora/lib-core.js', 'compiled core libraries must use their immutable standalone module');
assert.ok(!Object.hasOwn(manifest.modules || {}, 'lib-core.js'), 'compiled core libraries must not be duplicated as base64');
assert.doesNotMatch(index, /\bcaches\.|indexedDB|nora-static-assets/, 'startup must not coordinate duplicate application cache authorities');
assert.match(index, /fetch\(globalThis\.__NORA_INLINE_MANIFEST_URL__,\s*\{[\s\S]*?cache: 'force-cache',[\s\S]*?priority: 'low'/);
assert.match(index, /__NORA_EXTENSION_ASSET_BASE__/);
assert.match(index, /<script src="\{\{NORA_ASSET_BASE\}\}\/dist\/nora\/legacy\.js" fetchpriority="low"><\/script>/);
assert.match(index, /<link rel="modulepreload" href="\{\{NORA_ASSET_BASE\}\}\/dist\/nora\/lib-core\.js" fetchpriority="low">/);
for (const stylesheet of ['fontawesome.min.css', 'solid.min.css', 'toastr.min.css']) {
    assert.match(index, new RegExp(`<link href="\\{\\{NORA_ASSET_BASE\\}\\}/css/${stylesheet.replace('.', '\\.')}" rel="stylesheet" media="print" onload="this\\.media='all'">`), `${stylesheet} must not block the visible shell`);
}

console.log(`nora-startup-asset-budget-contract=PASS shell_br=${shellHtmlBrotliSize} manifest_br=${manifestBrotliSize}`);
