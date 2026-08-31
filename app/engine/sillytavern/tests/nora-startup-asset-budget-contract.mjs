import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../public/dist/nora/inline-modules.json', import.meta.url), 'utf8'));
const manifestBrotliSize = fs.statSync(new URL('../public/dist/nora/inline-modules.json.br', import.meta.url)).size;

assert.ok(manifestBrotliSize <= 550_000, `critical module manifest exceeds 550 KB Brotli budget: ${manifestBrotliSize}`);
assert.equal(manifest.legacy, 'dist/nora/legacy.js', 'legacy libraries must use their immutable standalone asset');
assert.equal(manifest.compiled?.['lib-core.js'], 'dist/nora/lib-core.js', 'compiled core libraries must use their immutable standalone module');
assert.ok(!Object.hasOwn(manifest.modules || {}, 'lib-core.js'), 'compiled core libraries must not be duplicated as base64');
assert.doesNotMatch(index, /\bcaches\.|indexedDB|nora-static-assets/, 'startup must not coordinate duplicate application cache authorities');
assert.match(index, /fetch\(globalThis\.__NORA_INLINE_MANIFEST_URL__,\s*\{[\s\S]*?cache: 'force-cache',[\s\S]*?priority: 'high'/);
assert.match(index, /<script src="\{\{NORA_ASSET_BASE\}\}\/dist\/nora\/legacy\.js"><\/script>/);
assert.match(index, /<link rel="modulepreload" href="\{\{NORA_ASSET_BASE\}\}\/dist\/nora\/lib-core\.js">/);

console.log(`nora-startup-asset-budget-contract=PASS manifest_br=${manifestBrotliSize}`);
