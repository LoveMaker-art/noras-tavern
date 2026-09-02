import assert from 'node:assert/strict';
import fs from 'node:fs';

const config = fs.readFileSync(new URL('../webpack.nora.config.mjs', import.meta.url), 'utf8');
const kernel = fs.readFileSync(new URL('../public/scripts/nora-compat/st-kernel.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const coreSource = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const extensions = fs.readFileSync(new URL('../public/scripts/extensions.js', import.meta.url), 'utf8');
const runtimeAssetBuilder = fs.readFileSync(new URL('../build/generate-nora-runtime-assets.mjs', import.meta.url), 'utf8');

assert.match(config, /entry:\s*'\.\/public\/nora-entry\.js'/);
assert.match(config, /'lib-core':\s*'\.\/public\/lib-core\.js'/);
assert.match(config, /filename:\s*'\[name\]\.js'/);
assert.doesNotMatch(config, /core:\s*'\.\/public\/script\.js'/);
assert.doesNotMatch(kernel, /dist\/nora\/core\.js/);
assert.match(kernel, /import\([^\n]*['"]\/script\.js['"]\)/);
assert.match(index, /{{NORA_INLINE_MANIFEST_URL}}/);
assert.match(index, /__NORA_INLINE_MANIFEST_PROMISE__/);
assert.match(index, /document\.createElement\('script'\)[\s\S]*?importMap\.type = 'importmap'/);
assert.match(index, /manifest\.legacy/);
assert.match(index, /<script[^>]+dist\/nora\/legacy\.js/);
assert.match(index, /import 'nora-module\/scripts\/i18n\.js'/);
assert.match(index, /manifest\.extensionCoreBridges/);
assert.match(index, /imports\[`\$\{extensionAssetBase\}\/\$\{modulePath\}`\] = canonicalUrl/);
const compatibilityPreludeAppend = index.indexOf('document.body.append(compatibilityPrelude)');
const compatibilityPreludeReady = index.indexOf('await compatibilityPreludeReady', compatibilityPreludeAppend);
const runtimeEntryAppend = index.indexOf('document.body.append(entry)', compatibilityPreludeAppend);
assert.notEqual(compatibilityPreludeAppend, -1, 'the compatibility prelude must be attached');
assert.notEqual(compatibilityPreludeReady, -1, 'startup must wait for the compatibility prelude to finish evaluating');
assert.ok(
    compatibilityPreludeAppend < compatibilityPreludeReady && compatibilityPreludeReady < runtimeEntryAppend,
    'the ST runtime entry must not race the compatibility prelude module graph',
);
assert.doesNotMatch(index, /src="{{NORA_ASSET_BASE}}\/scripts\/i18n\.js"/);
assert.doesNotMatch(coreSource, /dispatchEvent\(new Event\('nora:st-core-ready'\)\)/);
assert.doesNotMatch(index, /__NORA_ST_CORE_READY__|nora:st-core-ready/);
assert.match(coreSource, /await new Promise\(\(resolve\) => \{[\s\S]*?DOMContentLoaded/);
assert.match(runtimeAssetBuilder, /collectManagedExtensionCoreBridges/);
assert.match(runtimeAssetBuilder, /attachExtensionCoreBridges/);
assert.match(runtimeAssetBuilder, /['"]\/scripts\/extensions\/regex\/index\.js['"]/, 'the critical regex runtime must ship in the initial module package');
assert.match(runtimeAssetBuilder, /buildLegacyBundle/);
assert.match(runtimeAssetBuilder, /attachLegacyAsset/);
assert.match(runtimeAssetBuilder, /attachCompiledModule\(inlineManifest, 'lib-core\.js'/);
assert.match(runtimeAssetBuilder, /CORE_LIBRARY_URL = '\/lib-core\.js'/);
assert.match(index, /dist\/nora\/lib-core\.js/);
assert.match(extensions, /normalized\.startsWith\('scripts\/extensions\/third-party\/'\)/);
assert.match(extensions, /return `nora-module\/\$\{normalized\}`/);
assert.match(extensions, /import\(url\.startsWith\('nora-module\/'\) \? url : new URL\(url, location\.origin\)\.href\)/);
assert.doesNotMatch(extensions, /script\.src = url/, 'extension modules must reuse import-map packaged runtimes');
assert.doesNotMatch(index, /\bcaches\.|indexedDB|nora-static-assets/, 'content-addressed immutable assets must have one browser cache authority');
assert.match(index, /cache:\s*'force-cache'[\s\S]*priority:\s*'high'/, 'the critical manifest must use the immutable HTTP cache at high priority');
assert.match(index, /<link\s+rel="modulepreload"[^>]+dist\/nora\/lib-core\.js/);
assert.match(index, /<link\s+rel="modulepreload"[^>]+dist\/nora\/entry\.js/);

console.log('nora-production-bundle-contract=PASS');
