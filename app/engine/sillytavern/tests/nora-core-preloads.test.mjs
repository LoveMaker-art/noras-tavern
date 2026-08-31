import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    attachCompiledModule,
    attachLegacyAsset,
    buildInlineModuleManifest,
    buildLegacyBundle,
    collectStaticModuleGraph,
    writePrecompressedAsset,
} from '../build/generate-nora-runtime-assets.mjs';

test('packs the static core graph and rewrites local static and dynamic imports', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-core-preloads-'));
    fs.mkdirSync(path.join(fixture, 'modules'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'script.js'), [
        "import libs from './lib.js';",
        "import './modules/a.js';",
        "import('/modules/deferred.js');",
        'export { libs };',
    ].join('\n'));
    fs.writeFileSync(path.join(fixture, 'modules', 'a.js'), [
        "import '/modules/b.mjs?v=1';",
        "export const a = true;",
    ].join('\n'));
    fs.writeFileSync(path.join(fixture, 'modules', 'b.mjs'), [
        "import '/script.js';",
        "export const b = true;",
    ].join('\n'));
    fs.writeFileSync(path.join(fixture, 'modules', 'deferred.js'), 'export default true;');

    try {
        assert.deepEqual(await collectStaticModuleGraph('/script.js', fixture), [
            'modules/a.js',
            'modules/b.mjs?v=1',
            'script.js',
        ]);
        const packed = await buildInlineModuleManifest('/script.js', fixture);
        const decodedEntry = Buffer.from(packed.modules['script.js'].split(',')[1], 'base64').toString('utf8');
        assert.match(decodedEntry, /import\s*(?:["']|\(["'])nora-module\/modules\/a\.js/);
        assert.match(decodedEntry, /nora-module\/lib-core\.js/);
        assert.match(decodedEntry, /import\("nora-module\/modules\/deferred\.js"\)/);
        assert.match(decodedEntry, /sourceURL=nora-inline:\/script\.js/);
        const decodedAlias = Buffer.from(packed.aliases['script.js'].split(',')[1], 'base64').toString('utf8');
        assert.equal(decodedAlias, 'export * from "nora-module/script.js";\n');
        assert.deepEqual(packed.network, ['lib-core.js', 'modules/deferred.js']);
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('writes Brotli and Gzip companions without changing source bytes', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-precompressed-build-'));
    const target = path.join(fixture, 'asset.js');
    const content = 'export const value = "compressible";'.repeat(50);

    try {
        await writePrecompressedAsset(target, content);
        assert.equal(fs.readFileSync(target, 'utf8'), content);
        assert.ok(fs.statSync(`${target}.br`).size < Buffer.byteLength(content));
        assert.ok(fs.statSync(`${target}.gz`).size < Buffer.byteLength(content));
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('builds the ordered legacy compatibility bundle', async () => {
    const bundle = await buildLegacyBundle();
    assert.ok(bundle.indexOf('lib/jquery-3.5.1.min.js') < bundle.indexOf('lib/jquery-ui.min.js'));
    assert.ok(bundle.indexOf('lib/jquery-ui.min.js') < bundle.indexOf('lib/toastr.min.js'));
    assert.doesNotMatch(bundle, /sourceMappingURL=/);
});

test('references blocking compiled and legacy runtimes as immutable assets', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-compiled-preload-'));
    const compiledPath = path.join(fixture, 'lib-core.js');
    fs.writeFileSync(compiledPath, 'export const compiled = true;');
    const manifest = { modules: {}, aliases: {}, network: ['lib-core.js', 'lib/lazy.js'] };

    try {
        attachCompiledModule(manifest, 'lib-core.js', 'dist/nora/lib-core.js');
        attachLegacyAsset(manifest, 'dist/nora/legacy.js');
        assert.equal(manifest.compiled['lib-core.js'], 'dist/nora/lib-core.js');
        assert.equal(manifest.legacy, 'dist/nora/legacy.js');
        assert.equal(Object.hasOwn(manifest.modules, 'lib-core.js'), false);
        assert.equal(Object.hasOwn(manifest.aliases, 'lib-core.js'), false);
        assert.deepEqual(manifest.network, ['lib/lazy.js']);
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});
