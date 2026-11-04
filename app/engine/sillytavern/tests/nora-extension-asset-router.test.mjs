import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';

import {
    computeBrowserAssetManifest,
    computeExtensionAssetManifest,
    createVersionedExtensionRouteHandler,
    materializeBrowserAssetManifest,
} from '../src/nora-static-assets.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(path.resolve('default/config.yaml'));
const {
    createExtensionAssetRedirectHandler,
    createVersionedExtensionsRouter,
    router: workspaceRouter,
} = await import('../src/workspace.js');
const { router: extensionsRouter } = await import('../src/endpoints/extensions.js');

function responseFixture() {
    return {
        status: 0,
        sentFile: '',
        options: null,
        headers: {},
        redirectStatus: 0,
        redirectTarget: '',
        sendStatus(value) {
            this.status = value;
            return this;
        },
        sendFile(value, options) {
            this.sentFile = value;
            this.options = options;
            return this;
        },
        setHeader(name, value) {
            this.headers[name] = value;
        },
        type(value) {
            this.headers['Content-Type'] = value;
        },
        redirect(status, target) {
            this.redirectStatus = status;
            this.redirectTarget = target;
            return this;
        },
    };
}

test('versioned extension routes serve only the package and release recorded at startup', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-extension-router-'));
    const userDirectory = path.join(fixture, 'user');
    const globalDirectory = path.join(fixture, 'global');
    const cacheDirectory = path.join(fixture, 'cache');
    const extensionDirectory = path.join(userDirectory, 'nora-mvu');
    fs.mkdirSync(extensionDirectory, { recursive: true });
    fs.writeFileSync(path.join(extensionDirectory, 'index.js'), 'export default {};');
    const manifest = computeExtensionAssetManifest({ userDirectory, globalDirectory });
    const release = manifest.extensions['third-party/nora-mvu'].groups.runtime.release;
    materializeBrowserAssetManifest({
        manifest: { namespaces: {}, extensions: manifest.extensions },
        cacheDirectory,
    });
    const handler = createVersionedExtensionRouteHandler(cacheDirectory);

    try {
        const success = responseFixture();
        await handler({ params: { release, extension: 'nora-mvu', 0: 'index.js' } }, success);
        assert.equal(fs.readFileSync(success.sentFile, 'utf8'), 'export default {};');
        assert.equal(success.options.headers['Cache-Control'], 'public, max-age=31536000, immutable');

        const wrongRelease = responseFixture();
        await handler({ params: { release: '0000000000000000', extension: 'nora-mvu', 0: 'index.js' } }, wrongRelease);
        assert.equal(wrongRelease.status, 404);

        const wrongPackage = responseFixture();
        await handler({ params: { release, extension: 'other-extension', 0: 'index.js' } }, wrongPackage);
        assert.equal(wrongPackage.status, 404);

        const unrecordedFile = responseFixture();
        await handler({ params: { release, extension: 'nora-mvu', 0: '../secret.txt' } }, unrecordedFile);
        assert.equal(unrecordedFile.status, 404);
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('legacy extension asset paths redirect to the matching package release', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-extension-redirect-'));
    const userDirectory = path.join(fixture, 'user');
    const globalDirectory = path.join(fixture, 'global');
    const extensionDirectory = path.join(userDirectory, 'nora-mvu');
    fs.mkdirSync(path.join(extensionDirectory, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(extensionDirectory, 'vendor', 'bundle.js'), 'export default {};');
    const manifest = computeExtensionAssetManifest({ userDirectory, globalDirectory });
    const release = manifest.extensions['third-party/nora-mvu'].groups.vendor.release;
    const handler = createExtensionAssetRedirectHandler(manifest);

    try {
        const response = responseFixture();
        let nextCalled = false;
        handler({
            params: { extension: 'nora-mvu', 0: 'vendor/bundle.js' },
            originalUrl: '/scripts/extensions/third-party/nora-mvu/vendor/bundle.js?v=10',
        }, response, () => { nextCalled = true; });
        assert.equal(nextCalled, false);
        assert.equal(response.redirectStatus, 302);
        assert.equal(
            response.redirectTarget,
            `/extension-assets/${release}/scripts/extensions/third-party/nora-mvu/vendor/bundle.js?v=10`,
        );
        assert.equal(response.headers['Cache-Control'], 'no-cache, must-revalidate');

        const missing = responseFixture();
        handler({
            params: { extension: 'nora-mvu', 0: 'vendor/missing.js' },
            originalUrl: '/scripts/extensions/third-party/nora-mvu/vendor/missing.js',
        }, missing, () => { nextCalled = true; });
        assert.equal(nextCalled, true);
        assert.equal(missing.redirectStatus, 0);
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('runtime uses the bundled program for managed extensions without changing old copies', async t => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-bundled-extension-router-'));
    let server;
    t.after(async () => {
        if (server?.listening) {
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
        fs.rmSync(fixture, { recursive: true, force: true });
    });
    const userDirectory = path.join(fixture, 'extensions');
    const bundledDirectory = new URL('../../../native-extensions/', import.meta.url);
    const write = (name, script) => {
        const directory = path.join(userDirectory, name);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ display_name: name }));
        fs.writeFileSync(path.join(directory, 'index.js'), script);
    };
    write('nora-ledger', 'old managed copy');
    write('nora-shell', 'retired managed copy');
    write('LocalFixture', 'user extension');
    fs.writeFileSync(path.join(userDirectory, 'nora-ledger', 'old-only.js'), 'must not shadow the bundle');
    const publicDirectory = path.join(fixture, 'public');
    const bundledLibPath = path.join(fixture, 'lib.js');
    const noraAssets = path.join(publicDirectory, 'dist', 'nora');
    fs.mkdirSync(noraAssets, { recursive: true });
    fs.writeFileSync(path.join(noraAssets, 'inline-modules.js'), '{"modules":[]}');
    fs.writeFileSync(bundledLibPath, 'export default {};');
    const manifest = computeBrowserAssetManifest({
        publicDirectory,
        bundledLibPath,
        userExtensionDirectory: userDirectory,
        globalExtensionDirectory: path.join(fixture, 'global'),
        bundledExtensionDirectory: fileURLToPath(bundledDirectory),
    });
    const ledgerAsset = manifest.extensions['third-party/nora-ledger'];
    const cacheDirectory = path.join(fixture, 'cache');
    materializeBrowserAssetManifest({
        manifest: { namespaces: {}, extensions: { 'third-party/nora-ledger': ledgerAsset } },
        cacheDirectory,
    });

    const app = express();
    app.use((request, _response, next) => {
        request.user = { profile: { handle: 'default-user' }, directories: { extensions: userDirectory } };
        next();
    });
    app.use('/extensions', extensionsRouter);
    app.use('/extension-assets', createVersionedExtensionsRouter(cacheDirectory));
    app.use(workspaceRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => server.once('listening', resolve).once('error', reject));
    const fetchPath = route => fetch(`http://127.0.0.1:${server.address().port}${route}`);
    const asset = name => fetchPath(`/scripts/extensions/third-party/${name}/index.js`);
    const bundledScript = fs.readFileSync(new URL('nora-ledger/index.js', bundledDirectory), 'utf8');

    assert.equal(await (await asset('nora-ledger')).text(), bundledScript);
    const immutable = await fetchPath(`/extension-assets/${ledgerAsset.release}/scripts/extensions/third-party/nora-ledger/index.js`);
    assert.equal(await immutable.text(), bundledScript);
    assert.equal(immutable.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await fetchPath('/scripts/extensions/third-party/nora-ledger/old-only.js')).status, 404);
    assert.equal(await (await asset('LocalFixture')).text(), 'user extension');
    assert.equal((await asset('nora-shell')).status, 404);
    const discovered = await (await fetchPath('/extensions/discover')).json();
    assert.equal(discovered.filter(item => item.name === 'third-party/nora-ledger').length, 1);
    assert.ok(discovered.some(item => item.name === 'third-party/nora-ui'), 'bundle works without a per-user copy');
    assert.ok(discovered.some(item => item.name === 'third-party/LocalFixture' && item.type === 'local'));
    assert.ok(!discovered.some(item => item.name === 'third-party/nora-shell'));
    const library = await (await fetchPath('/extensions/library')).json();
    assert.equal(library.items.find(item => item.name === 'third-party/nora-ledger').displayName, 'Story Ledger');
    assert.equal(fs.readFileSync(path.join(userDirectory, 'nora-ledger/index.js'), 'utf8'), 'old managed copy');
    assert.equal(fs.readFileSync(path.join(userDirectory, 'nora-shell/index.js'), 'utf8'), 'retired managed copy');
});
