import assert from 'node:assert/strict';
import fs from 'node:fs';

const config = fs.readFileSync(new URL('../webpack.nora.config.mjs', import.meta.url), 'utf8');
const kernel = fs.readFileSync(new URL('../public/scripts/nora-compat/st-kernel.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const coreSource = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const extensions = fs.readFileSync(new URL('../public/scripts/extensions.js', import.meta.url), 'utf8');
const runtimeAssetBuilder = fs.readFileSync(new URL('../build/generate-nora-runtime-assets.mjs', import.meta.url), 'utf8');
const duplicatePublicLibBundle = new URL('../public/dist/nora/lib.js', import.meta.url);
const canonicalPublicLibBundle = new URL('../dist/_webpack/output/lib.js', import.meta.url);

assert.match(config, /entry:\s*'\.\/public\/nora-entry\.js'/);
assert.match(config, /'lib-core':\s*'\.\/public\/lib-core\.js'/);
assert.doesNotMatch(
    config,
    /^\s*lib:\s*'\.\/public\/lib\.js'/m,
    'the standalone /lib.js runtime must not also be emitted into public/dist/nora',
);
assert.match(config, /filename:\s*'\[name\]\.js'/);
assert.doesNotMatch(config, /core:\s*'\.\/public\/script\.js'/);
assert.doesNotMatch(kernel, /dist\/nora\/core\.js/);
assert.match(kernel, /__NORA_LOAD_MODULE__/);
assert.match(kernel, /loadModule\(['"]\/script\.js['"]\)/);
assert.match(index, /<script type="importmap">\{\{NORA_IMPORT_MAP\}\}<\/script>/);
assert.doesNotMatch(index, /__NORA_INLINE_MANIFEST_PROMISE__/);
assert.match(index, /module-shims\.js/, 'older WebViews need the locally bundled compatibility loader');
assert.match(index, /normalized === 'dist\/nora\/module-shims\.js'.*namespace = 'compat-runtime'/, 'the compatibility loader must use the compat-runtime hash namespace');
assert.match(index, /HTMLScriptElement\.supports\('importmap'\)/, 'native static import maps must bypass the compatibility parser');
assert.match(index, /globalThis\.importShim\.addImportMap\(importMap\)/, 'unsupported WebViews must receive the same static import map');
assert.match(index, /return specifier => import\(specifier\)/, 'native WebViews must use the browser module loader');
assert.match(index, /resolve\(specifier => globalThis\.importShim\(specifier\)\)/, 'unsupported WebViews must retain the compatibility loader');
assert.match(index, /legacy\.src = `\$\{globalThis\.__NORA_LEGACY_ASSET_BASE__\}\/dist\/nora\/legacy\.js`/);
assert.match(index, /'nora-module\/scripts\/i18n\.js'/);
const compatibilityPreludeLoad = index.indexOf('for (const specifier of compatibilityPreludeModules)');
const runtimeEntryLoad = index.indexOf('await globalThis.__NORA_LOAD_MODULE__(entryUrl)', compatibilityPreludeLoad);
assert.notEqual(compatibilityPreludeLoad, -1, 'startup must await compatibility prelude evaluation');
assert.notEqual(runtimeEntryLoad, -1, 'startup must await runtime entry evaluation');
assert.ok(compatibilityPreludeLoad < runtimeEntryLoad, 'the ST runtime entry must not race the compatibility prelude module graph');
assert.doesNotMatch(index, /src="{{NORA_ASSET_BASE}}\/scripts\/i18n\.js"/);
assert.doesNotMatch(coreSource, /dispatchEvent\(new Event\('nora:st-core-ready'\)\)/);
assert.doesNotMatch(index, /__NORA_ST_CORE_READY__|nora:st-core-ready/);
assert.match(coreSource, /await new Promise\(\(resolve\) => \{[\s\S]*?DOMContentLoaded/);
assert.match(runtimeAssetBuilder, /collectManagedExtensionCoreBridges/);
assert.match(runtimeAssetBuilder, /attachExtensionCoreBridges/);
assert.match(runtimeAssetBuilder, /['"]\/scripts\/extensions\/regex\/index\.js['"]/, 'the critical regex runtime must ship in the initial module package');
assert.match(runtimeAssetBuilder, /buildLegacyBundle/);
assert.match(runtimeAssetBuilder, /attachLegacyAsset/);
assert.match(runtimeAssetBuilder, /export async function buildRuntimeManifest/);
assert.match(runtimeAssetBuilder, /attachCompiledModule\(manifest, 'lib-core\.js'/);
assert.doesNotMatch(
    runtimeAssetBuilder,
    /const bundleNames = \[[^\]]*['"]lib\.js['"]/,
    'runtime asset generation must not recreate the duplicate dist/nora/lib.js bundle',
);
assert.equal(fs.existsSync(duplicatePublicLibBundle), false, 'the duplicate dist/nora/lib.js artifact must not ship');
assert.equal(fs.existsSync(canonicalPublicLibBundle), true, 'the canonical /lib.js runtime artifact must still ship');
assert.match(runtimeAssetBuilder, /CORE_LIBRARY_URL = '\/lib-core\.js'/);
assert.match(index, /dist\/nora\/lib-core\.js/);
assert.match(extensions, /normalized\.startsWith\('scripts\/extensions\/third-party\/'\)/);
assert.match(extensions, /return `nora-module\/\$\{normalized\}`/);
assert.match(extensions, /import\(url\.startsWith\('nora-module\/'\) \? url : new URL\(url, location\.origin\)\.href\)/);
assert.doesNotMatch(extensions, /script\.src = url/, 'extension modules must reuse import-map packaged runtimes');
assert.doesNotMatch(index, /\bcaches\.|indexedDB|nora-static-assets/, 'content-addressed immutable assets must have one browser cache authority');
assert.doesNotMatch(index, /fetch\(globalThis\.__NORA_INLINE_MANIFEST_URL__/, 'module routing must be present before startup instead of fetched as a second wave');
assert.match(index, /globalThis\.__NORA_VENDOR_ASSET_BASE__[\s\S]*'dist\/nora\/lib-core\.js'/);
assert.doesNotMatch(index, /<link\s+rel="modulepreload"[^>]+dist\/nora\//);

console.log('nora-production-bundle-contract=PASS');
