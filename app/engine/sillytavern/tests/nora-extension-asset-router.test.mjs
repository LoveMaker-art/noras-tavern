import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    computeExtensionAssetManifest,
    createVersionedExtensionRouteHandler,
    materializeBrowserAssetManifest,
} from '../src/nora-static-assets.js';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(path.resolve('default/config.yaml'));
const {
    createExtensionAssetRedirectHandler,
} = await import('../src/workspace.js');

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
