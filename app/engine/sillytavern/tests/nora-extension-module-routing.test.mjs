import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { init, parse } from 'es-module-lexer';
import { buildRuntimeManifest } from '../build/generate-nora-runtime-assets.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(testDirectory, '../public');
const nativeExtensionsDirectory = path.resolve(testDirectory, '../../../native-extensions');
const extensionLoader = fs.readFileSync(path.join(publicDirectory, 'scripts/extensions.js'), 'utf8');
const indexTemplate = fs.readFileSync(path.join(publicDirectory, 'index.html'), 'utf8');
const inlineManifest = await buildRuntimeManifest();

await init;

function staticImports(relativePath) {
    const source = fs.readFileSync(path.join(nativeExtensionsDirectory, relativePath), 'utf8');
    const [imports] = parse(source);
    return imports.filter(item => item.d === -1).map(item => source.slice(item.s, item.e));
}

test('extension JavaScript entries load from the immutable extension namespace', () => {
    assert.match(indexTemplate, /__NORA_EXTENSION_MODULE_URL__/);
    assert.match(extensionLoader, /normalized\.startsWith\('scripts\/extensions\/third-party\/'\)/);
    assert.match(extensionLoader, /return `nora-module\/\$\{normalized\}`/);
    assert.match(extensionLoader, /const importExtensionModule = url => import\(url\.startsWith\('nora-module\/'\)/);
});

test('only product-enabled bundled ST extensions enter the canonical module registry', () => {
    const productDisabledExtensions = new Set([
        'assets',
        'attachments',
        'connection-manager',
        'gallery',
        'memory',
        'token-counter',
    ]);
    const builtInExtensionsDirectory = path.join(publicDirectory, 'scripts/extensions');
    for (const entry of fs.readdirSync(builtInExtensionsDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(builtInExtensionsDirectory, entry.name, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!manifest.js) continue;
        const modulePath = `scripts/extensions/${entry.name}/${manifest.js}`;
        if (productDisabledExtensions.has(entry.name)) {
            assert.equal(
                inlineManifest.modules[modulePath],
                undefined,
                `product-disabled extension leaked into the inline manifest: ${modulePath}`,
            );
            continue;
        }
        assert.ok(inlineManifest.modules[modulePath], `bundled extension entry is absent from the inline manifest: ${modulePath}`);
    }
});

test('Tavern Helper shares Nora core module singletons instead of loading a second ST runtime', () => {
    const imports = staticImports('JS-Slash-Runner/dist/index.js');
    const relativeImports = imports.filter(value => value.startsWith('.'));
    const coreImports = imports.filter(value => value.startsWith('nora-module/'));

    assert.deepEqual(relativeImports.sort(), ['../lib/jsoneditor.js', '../nora-control-adapter.js']);
    assert.equal(coreImports.length, imports.length - relativeImports.length);
    assert.ok(coreImports.includes('nora-module/script.js'));
    assert.ok(coreImports.includes('nora-module/scripts/openai.js'));
    assert.ok(coreImports.includes('nora-module/scripts/nora-compat/interaction-bridge.js'));

    for (const specifier of coreImports) {
        const modulePath = specifier.slice('nora-module/'.length);
        assert.ok(
            inlineManifest.modules[modulePath] || inlineManifest.compiled?.[modulePath],
            `managed extension core dependency is absent from the inline manifest: ${modulePath}`,
        );
    }
});

test('managed MVU entry shares the Nora compatibility module singleton', () => {
    const imports = staticImports('nora-mvu/index.js');
    assert.ok(imports.includes('nora-module/scripts/nora-compat/mvu-compatibility.js'));
    assert.ok(imports.includes('./runtime.js'));
    assert.ok(imports.includes('./update-observer.js'));
});
