import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import {
    NORA_ASSET_NAMESPACE,
    computeBrowserAssetManifest,
    computeCompositeAssetRelease,
    computeExtensionAssetManifest,
    computeStaticAssetRelease,
    createAssetAllowlistMiddleware,
    createPrecompressedAssetMiddleware,
    createVersionedAssetRouteHandler,
    materializeBrowserAssetManifest,
    renderNoraIndex,
} from '../src/nora-static-assets.js';

function makeFixture() {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-static-assets-'));
    const publicDirectory = path.join(fixture, 'public');
    const extensionsDirectory = path.join(fixture, 'extensions');
    fs.mkdirSync(path.join(publicDirectory, 'scripts'), { recursive: true });
    fs.mkdirSync(extensionsDirectory, { recursive: true });
    fs.writeFileSync(path.join(publicDirectory, 'script.js'), 'export const version = 1;');
    fs.writeFileSync(path.join(publicDirectory, 'scripts', 'runtime.js'), 'export const ready = true;');
    fs.writeFileSync(path.join(extensionsDirectory, 'index.js'), 'export default {};');
    return { fixture, publicDirectory, extensionsDirectory };
}

test('static release is stable for identical content and changes with executable content', () => {
    const { fixture, publicDirectory, extensionsDirectory } = makeFixture();
    const options = {
        roots: [
            { label: 'public', path: publicDirectory },
            { label: 'extensions', path: extensionsDirectory },
        ],
    };

    try {
        const initial = computeStaticAssetRelease(options);
        const unchanged = computeStaticAssetRelease(options);
        assert.equal(initial, unchanged);
        assert.match(initial, /^[a-f0-9]{32}$/);

        fs.writeFileSync(path.join(extensionsDirectory, 'index.js'), 'export default { changed: true };');
        assert.notEqual(computeStaticAssetRelease(options), initial);
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('excluded mutable files do not invalidate the static release', () => {
    const { fixture, publicDirectory } = makeFixture();
    const mutableFile = path.join(publicDirectory, 'user.css');
    fs.writeFileSync(mutableFile, 'body { color: red; }');
    const options = {
        roots: [{ label: 'public', path: publicDirectory }],
        excludedPaths: ['public/user.css'],
    };

    try {
        const initial = computeStaticAssetRelease(options);
        fs.writeFileSync(mutableFile, 'body { color: blue; }');
        assert.equal(computeStaticAssetRelease(options), initial);
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('excluded directories do not invalidate the static release', () => {
    const { fixture, publicDirectory } = makeFixture();
    const extensionDirectory = path.join(publicDirectory, 'scripts', 'extensions', 'third-party');
    fs.mkdirSync(extensionDirectory, { recursive: true });
    fs.writeFileSync(path.join(extensionDirectory, 'extension.js'), 'export const version = 1;');
    const options = {
        roots: [{ label: 'public', path: publicDirectory }],
        excludedPaths: ['public/scripts/extensions/third-party'],
    };

    try {
        const initial = computeStaticAssetRelease(options);
        fs.writeFileSync(path.join(extensionDirectory, 'extension.js'), 'export const version = 2;');
        assert.equal(computeStaticAssetRelease(options), initial);
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('composite release changes only when one namespace changes', () => {
    const initial = computeCompositeAssetRelease(['0123456789abcdef', 'fedcba9876543210']);
    assert.equal(initial, computeCompositeAssetRelease(['0123456789abcdef', 'fedcba9876543210']));
    assert.notEqual(initial, computeCompositeAssetRelease(['1123456789abcdef', 'fedcba9876543210']));
    assert.throws(() => computeCompositeAssetRelease(['not-a-hash']), /hexadecimal content hashes/i);
});

test('extension releases change independently and follow the effective user-over-global files', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-extension-assets-'));
    const userDirectory = path.join(fixture, 'user');
    const globalDirectory = path.join(fixture, 'global');
    const globalMvu = path.join(globalDirectory, 'nora-mvu');
    const globalHelper = path.join(globalDirectory, 'JS-Slash-Runner');
    const userMvu = path.join(userDirectory, 'nora-mvu');

    try {
        fs.mkdirSync(globalMvu, { recursive: true });
        fs.mkdirSync(globalHelper, { recursive: true });
        fs.mkdirSync(userMvu, { recursive: true });
        fs.writeFileSync(path.join(globalMvu, 'index.js'), 'export const source = "global";');
        fs.writeFileSync(path.join(globalMvu, 'runtime.js'), 'export const runtime = 1;');
        fs.mkdirSync(path.join(globalMvu, 'vendor'), { recursive: true });
        fs.writeFileSync(path.join(globalMvu, 'vendor', 'zod.js'), 'export const zod = 1;');
        fs.writeFileSync(path.join(userMvu, 'index.js'), 'export const source = "user";');
        fs.writeFileSync(path.join(globalHelper, 'index.js'), 'export const helper = 1;');

        const initial = computeExtensionAssetManifest({ userDirectory, globalDirectory });
        const mvuRelease = initial.extensions['third-party/nora-mvu'].release;
        const mvuVendorRelease = initial.extensions['third-party/nora-mvu'].groups.vendor.release;
        const helperRelease = initial.extensions['third-party/JS-Slash-Runner'].release;
        assert.equal(
            initial.extensions['third-party/nora-mvu'].files['index.js'].source,
            path.join(userMvu, 'index.js'),
        );
        assert.equal(
            initial.extensions['third-party/nora-mvu'].files['runtime.js'].source,
            path.join(globalMvu, 'runtime.js'),
        );

        fs.writeFileSync(path.join(globalMvu, 'index.js'), 'export const source = "shadowed-global-change";');
        const shadowedChange = computeExtensionAssetManifest({ userDirectory, globalDirectory });
        assert.equal(shadowedChange.extensions['third-party/nora-mvu'].release, mvuRelease);
        assert.equal(shadowedChange.release, initial.release);

        fs.writeFileSync(path.join(userMvu, 'index.js'), 'export const source = "user-v2";');
        const mvuChange = computeExtensionAssetManifest({ userDirectory, globalDirectory });
        assert.notEqual(mvuChange.extensions['third-party/nora-mvu'].release, mvuRelease);
        assert.equal(mvuChange.extensions['third-party/nora-mvu'].groups.vendor.release, mvuVendorRelease);
        assert.equal(mvuChange.extensions['third-party/JS-Slash-Runner'].release, helperRelease);
        assert.notEqual(mvuChange.release, initial.release);

        fs.writeFileSync(path.join(globalMvu, 'vendor', 'zod.js'), 'export const zod = 2;');
        const vendorChange = computeExtensionAssetManifest({ userDirectory, globalDirectory });
        assert.equal(vendorChange.extensions['third-party/nora-mvu'].release, mvuChange.extensions['third-party/nora-mvu'].release);
        assert.notEqual(vendorChange.extensions['third-party/nora-mvu'].groups.vendor.release, mvuVendorRelease);
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('managed MVU documentation and build files do not invalidate browser assets', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-mvu-non-browser-'));
    const userDirectory = path.join(fixture, 'user');
    const globalDirectory = path.join(fixture, 'global');
    const extensionDirectory = path.join(globalDirectory, 'nora-mvu');

    try {
        fs.mkdirSync(path.join(extensionDirectory, 'vendor'), { recursive: true });
        fs.mkdirSync(path.join(extensionDirectory, 'upstream'), { recursive: true });
        fs.mkdirSync(userDirectory, { recursive: true });
        fs.writeFileSync(path.join(extensionDirectory, 'runtime.js'), 'runtime-v1');
        fs.writeFileSync(path.join(extensionDirectory, 'vendor', 'zod.iife.js'), 'zod-v1');
        fs.writeFileSync(path.join(extensionDirectory, 'UPSTREAM.md'), 'documentation-v1');
        fs.writeFileSync(path.join(extensionDirectory, 'build-vendor.sh'), 'build-v1');
        fs.writeFileSync(path.join(extensionDirectory, 'upstream', 'nora.patch'), 'patch-v1');
        fs.writeFileSync(path.join(extensionDirectory, 'vendor', 'ZOD.LICENSE'), 'license-v1');

        const initial = computeExtensionAssetManifest({ userDirectory, globalDirectory });
        const extension = initial.extensions['third-party/nora-mvu'];
        assert.deepEqual(Object.keys(extension.groups.runtime.files), ['runtime.js']);
        assert.deepEqual(Object.keys(extension.groups.vendor.files), ['vendor/zod.iife.js']);

        fs.writeFileSync(path.join(extensionDirectory, 'UPSTREAM.md'), 'documentation-v2');
        fs.writeFileSync(path.join(extensionDirectory, 'build-vendor.sh'), 'build-v2');
        fs.writeFileSync(path.join(extensionDirectory, 'upstream', 'nora.patch'), 'patch-v2');
        fs.writeFileSync(path.join(extensionDirectory, 'vendor', 'ZOD.LICENSE'), 'license-v2');
        const changed = computeExtensionAssetManifest({ userDirectory, globalDirectory });
        assert.equal(changed.extensions['third-party/nora-mvu'].release, extension.release);
        assert.equal(changed.extensions['third-party/nora-mvu'].groups.vendor.release, extension.groups.vendor.release);
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('asset identity follows canonical bytes and verifies compressed companions', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-static-vendor-'));
    const sourcePath = path.join(fixture, 'runtime.js');
    const brotliPath = `${sourcePath}.br`;
    const options = {
        roots: [],
        files: [
            { label: 'runtime.js', path: sourcePath },
            { label: 'runtime.js.br', path: brotliPath },
        ],
    };

    try {
        const source = Buffer.from('export const ready = true;');
        fs.writeFileSync(sourcePath, source);
        fs.writeFileSync(brotliPath, zlib.brotliCompressSync(source, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
        }));
        const initial = computeStaticAssetRelease(options);
        fs.writeFileSync(brotliPath, zlib.brotliCompressSync(source, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 8 },
        }));
        assert.equal(computeStaticAssetRelease(options), initial);

        fs.writeFileSync(brotliPath, zlib.brotliCompressSync(Buffer.from('different')));
        assert.throws(() => computeStaticAssetRelease(options), /does not match runtime\.js/i);
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('index rendering injects independently addressable asset namespaces', () => {
    const namespace = name => ({ name, release: '1'.repeat(32), fullDigest: '1'.repeat(64), files: {} });
    const namespaces = Object.fromEntries(Object.values(NORA_ASSET_NAMESPACE).map(name => [name, namespace(name)]));
    namespaces[NORA_ASSET_NAMESPACE.noraEntry] = namespace(NORA_ASSET_NAMESPACE.noraEntry);
    namespaces[NORA_ASSET_NAMESPACE.shell] = { ...namespace(NORA_ASSET_NAMESPACE.shell), release: '2'.repeat(32) };
    namespaces[NORA_ASSET_NAMESPACE.vendorCore] = { ...namespace(NORA_ASSET_NAMESPACE.vendorCore), release: '3'.repeat(32) };
    namespaces[NORA_ASSET_NAMESPACE.vendorLegacy] = { ...namespace(NORA_ASSET_NAMESPACE.vendorLegacy), release: '4'.repeat(32) };
    const manifest = {
        schemaVersion: 3,
        release: '0'.repeat(32),
        namespaces,
        extensions: {
            'third-party/nora-ui': { release: '5'.repeat(32) },
            'third-party/nora-mvu': { release: '6'.repeat(32) },
        },
    };
    const rendered = renderNoraIndex(
        '{{NORA_INLINE_MANIFEST_URL}}\n{{NORA_ASSET_BASES}}\n{{NORA_SHELL_ASSET_BASE}}\n{{NORA_EXTENSION_ASSET_BASE}}\n{{NORA_EXTENSION_ASSET_RELEASES}}\n{{NORA_EXTENSION_ASSET_GROUP_RELEASES}}\n{{NORA_VENDOR_ASSET_BASE}}\n{{NORA_LEGACY_ASSET_BASE}}\n{{NORA_ASSET_RELEASE}}',
        manifest,
    );

    assert.match(rendered, /^\/asset-files\/compat-runtime\/1{32}\/dist\/nora\/inline-modules\.js/m);
    assert.match(rendered, /\/asset-files\/nora-shell\/2{32}/);
    assert.match(rendered, /\/extension-assets\/5{32}/);
    assert.match(rendered, /\/asset-files\/vendor-core\/3{32}/);
    assert.match(rendered, /\/asset-files\/vendor-legacy\/4{32}/);
    assert.match(rendered, new RegExp(`^${'0'.repeat(32)}$`, 'm'));
    assert.throws(() => renderNoraIndex('x', { schemaVersion: 3, release: 'manual-version' }), /valid Nora browser asset manifest/i);
});

function makeBrowserManifestFixture() {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-browser-manifest-'));
    const publicDirectory = path.join(fixture, 'public');
    const userExtensionDirectory = path.join(fixture, 'user-extensions');
    const globalExtensionDirectory = path.join(fixture, 'global-extensions');
    const bundledLibPath = path.join(fixture, 'lib.js');
    const files = {
        entry: path.join(publicDirectory, 'dist', 'nora', 'entry.js'),
        chunk: path.join(publicDirectory, 'dist', 'nora', '333.js'),
        compatibility: path.join(publicDirectory, 'dist', 'nora', 'inline-modules.js'),
        vendorCore: path.join(publicDirectory, 'dist', 'nora', 'lib-core.js'),
        vendorLegacy: path.join(publicDirectory, 'dist', 'nora', 'legacy.js'),
        shell: path.join(publicDirectory, 'css', 'nora-runtime-contract.css'),
        stStatic: path.join(publicDirectory, 'scripts', 'group-chats.js'),
    };
    for (const [name, filePath] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${name}-v1`);
    }
    fs.mkdirSync(userExtensionDirectory, { recursive: true });
    fs.mkdirSync(path.join(globalExtensionDirectory, 'nora-mvu', 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(globalExtensionDirectory, 'nora-mvu', 'runtime.js'), 'mvu-v1');
    fs.writeFileSync(path.join(globalExtensionDirectory, 'nora-mvu', 'vendor', 'zod.js'), 'zod-v1');
    fs.writeFileSync(bundledLibPath, 'lib-v1');
    const options = { publicDirectory, bundledLibPath, userExtensionDirectory, globalExtensionDirectory };
    return { fixture, files, options };
}

test('browser manifest invalidates only the namespace whose final bytes changed', () => {
    const { fixture, files, options } = makeBrowserManifestFixture();
    try {
        const initial = computeBrowserAssetManifest(options);
        assert.match(initial.release, /^[a-f0-9]{32}$/);
        fs.writeFileSync(files.entry, 'entry-v2');
        const entryChange = computeBrowserAssetManifest(options);
        assert.notEqual(entryChange.namespaces[NORA_ASSET_NAMESPACE.noraEntry].release, initial.namespaces[NORA_ASSET_NAMESPACE.noraEntry].release);
        for (const name of Object.values(NORA_ASSET_NAMESPACE).filter(name => name !== NORA_ASSET_NAMESPACE.noraEntry)) {
            assert.equal(entryChange.namespaces[name].release, initial.namespaces[name].release, `${name} should keep its cache key`);
        }
        assert.equal(entryChange.extensions['third-party/nora-mvu'].release, initial.extensions['third-party/nora-mvu'].release);

        fs.writeFileSync(files.stStatic, 'st-static-v2');
        const stChange = computeBrowserAssetManifest(options);
        assert.notEqual(stChange.namespaces[NORA_ASSET_NAMESPACE.stStatic].release, entryChange.namespaces[NORA_ASSET_NAMESPACE.stStatic].release);
        for (const name of Object.values(NORA_ASSET_NAMESPACE).filter(name => name !== NORA_ASSET_NAMESPACE.stStatic)) {
            assert.equal(stChange.namespaces[name].release, entryChange.namespaces[name].release, `${name} should survive an ST-only update`);
        }

        fs.writeFileSync(path.join(options.globalExtensionDirectory, 'nora-mvu', 'runtime.js'), 'mvu-v2');
        const mvuChange = computeBrowserAssetManifest(options);
        assert.notEqual(mvuChange.extensions['third-party/nora-mvu'].release, entryChange.extensions['third-party/nora-mvu'].release);
        assert.equal(
            mvuChange.extensions['third-party/nora-mvu'].groups.vendor.release,
            entryChange.extensions['third-party/nora-mvu'].groups.vendor.release,
        );
        for (const name of Object.values(NORA_ASSET_NAMESPACE)) {
            assert.equal(mvuChange.namespaces[name].release, stChange.namespaces[name].release, `${name} should survive an MVU-only update`);
        }

        const ttsDirectory = path.join(options.globalExtensionDirectory, 'nora-tts');
        fs.mkdirSync(ttsDirectory, { recursive: true });
        fs.writeFileSync(path.join(ttsDirectory, 'index.js'), 'tts-v1');
        const ttsAddition = computeBrowserAssetManifest(options);
        assert.ok(ttsAddition.extensions['third-party/nora-tts']);
        assert.equal(ttsAddition.extensions['third-party/nora-mvu'].release, mvuChange.extensions['third-party/nora-mvu'].release);
        for (const name of Object.values(NORA_ASSET_NAMESPACE)) {
            assert.equal(ttsAddition.namespaces[name].release, mvuChange.namespaces[name].release, `${name} should survive a TTS-only addition`);
        }
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('materialized snapshots keep the previous generation byte-for-byte addressable', () => {
    const { fixture, files, options } = makeBrowserManifestFixture();
    const cacheDirectory = path.join(fixture, 'cache');
    try {
        const first = computeBrowserAssetManifest(options);
        materializeBrowserAssetManifest({ manifest: first, cacheDirectory });
        const oldRelease = first.namespaces[NORA_ASSET_NAMESPACE.noraEntry].release;
        fs.writeFileSync(files.entry, 'entry-v2');
        const second = computeBrowserAssetManifest(options);
        materializeBrowserAssetManifest({ manifest: second, cacheDirectory });

        const handler = createVersionedAssetRouteHandler(cacheDirectory);
        const sent = [];
        const response = {
            type() {},
            setHeader() {},
            sendStatus(status) { sent.push({ status }); },
            sendFile(filePath) { sent.push({ filePath, bytes: fs.readFileSync(filePath, 'utf8') }); },
        };
        handler({ params: { namespace: NORA_ASSET_NAMESPACE.noraEntry, release: oldRelease, 0: 'dist/nora/entry.js' } }, response);
        handler({ params: { namespace: NORA_ASSET_NAMESPACE.noraEntry, release: second.namespaces[NORA_ASSET_NAMESPACE.noraEntry].release, 0: 'dist/nora/entry.js' } }, response);
        handler({ params: { namespace: NORA_ASSET_NAMESPACE.noraEntry, release: 'f'.repeat(32), 0: 'dist/nora/entry.js' } }, response);

        assert.equal(sent[0].bytes, 'entry-v1');
        assert.equal(sent[1].bytes, 'entry-v2');
        assert.equal(sent[2].status, 404);
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('versioned assets prefer a precompressed representation', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-precompressed-assets-'));
    const sourcePath = path.join(fixture, 'runtime.js');
    fs.writeFileSync(sourcePath, 'export const ready = true;');
    fs.writeFileSync(`${sourcePath}.br`, 'brotli-payload');
    const headers = new Map();
    let sentFile = '';
    const middleware = createPrecompressedAssetMiddleware(fixture);

    try {
        middleware({
            method: 'GET',
            path: '/runtime.js',
            acceptsEncodings: (...encodings) => encodings.includes('br') ? 'br' : false,
        }, {
            type: value => headers.set('Content-Type', value),
            setHeader: (name, value) => headers.set(name, value),
            vary: value => headers.set('Vary', value),
            sendFile: value => {
                sentFile = value;
            },
        }, () => assert.fail('precompressed asset should be handled'));

        assert.equal(sentFile, `${sourcePath}.br`);
        assert.equal(headers.get('Content-Encoding'), 'br');
        assert.equal(headers.get('Vary'), 'Accept-Encoding');
        assert.equal(headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('an independently hashed asset namespace serves only files included in its release', () => {
    const middleware = createAssetAllowlistMiddleware([
        'dist/nora/lib-core.js',
        'dist/nora/legacy.js',
    ]);
    let continued = false;
    let status = 0;
    const response = { sendStatus: value => { status = value; } };

    middleware({ path: '/dist/nora/lib-core.js' }, response, () => { continued = true; });
    assert.equal(continued, true);
    assert.equal(status, 0);

    continued = false;
    middleware({ path: '/locales/zh-cn.json' }, response, () => { continued = true; });
    assert.equal(continued, false);
    assert.equal(status, 404);
});
