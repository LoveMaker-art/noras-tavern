import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    computeStaticAssetRelease,
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

test('index rendering injects one content-addressed asset namespace', () => {
    const release = '0123456789abcdef';
    const rendered = renderNoraIndex(
        '{{NORA_INLINE_MANIFEST_URL}}\n<script src="{{NORA_ASSET_BASE}}/entry.js">{{NORA_ASSET_RELEASE}}</script>',
        release,
    );

    assert.equal(rendered, [
        `/assets/${release}/dist/nora/inline-modules.json`,
        `<script src="/assets/${release}/entry.js">${release}</script>`,
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
