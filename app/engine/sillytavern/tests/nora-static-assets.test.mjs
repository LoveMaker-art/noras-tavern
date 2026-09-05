import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    computeCompositeAssetRelease,
    computeStaticAssetRelease,
    createAssetAllowlistMiddleware,
    createPrecompressedAssetMiddleware,
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
        assert.match(initial, /^[a-f0-9]{16}$/);

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

test('a precompressed representation participates in its immutable release identity', () => {
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
        fs.writeFileSync(sourcePath, 'export const ready = true;');
        fs.writeFileSync(brotliPath, 'brotli-v1');
        const initial = computeStaticAssetRelease(options);
        fs.writeFileSync(brotliPath, 'brotli-v2');
        assert.notEqual(computeStaticAssetRelease(options), initial);
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('index rendering injects separate content-addressed core and extension namespaces', () => {
    const release = '0123456789abcdef';
    const coreRelease = '1111111111111111';
    const extensionRelease = '2222222222222222';
    const rendered = renderNoraIndex(
        '{{NORA_INLINE_MANIFEST_URL}}\n{{NORA_EXTENSION_ASSET_BASE}}\n{{NORA_VENDOR_ASSET_BASE}}\n<script src="{{NORA_ASSET_BASE}}/entry.js">{{NORA_ASSET_RELEASE}}</script>',
        release,
        coreRelease,
        extensionRelease,
        '3333333333333333',
    );

    assert.equal(rendered, [
        `/assets/${coreRelease}/dist/nora/inline-modules.js`,
        `/extension-assets/${extensionRelease}`,
        '/vendor-assets/3333333333333333',
        `<script src="/assets/${coreRelease}/entry.js">${release}</script>`,
    ].join('\n'));
    assert.throws(() => renderNoraIndex('x', 'manual-version'), /content hash/i);
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
