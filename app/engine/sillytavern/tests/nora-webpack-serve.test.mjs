import assert from 'node:assert/strict';
import test from 'node:test';

import getWebpackServeMiddleware from '../src/middleware/webpack-serve.js';

function makeConfig(root) {
    return { output: { path: root, filename: 'lib.js' } };
}

test('bundled public libraries are served without invoking the runtime compiler', async () => {
    const calls = [];
    const middleware = getWebpackServeMiddleware('/assets/release', {
        getPublicLibConfig: options => {
            calls.push(options);
            return options.bundled ? makeConfig('/release') : makeConfig('/runtime');
        },
        fileExists: file => file === '/release/lib.js',
        webpack: () => assert.fail('runtime compiler must not run for a bundled release'),
    });
    let sent;

    middleware({ method: 'GET', path: '/assets/release/lib.js' }, {
        sendFile: (file, options) => {
            sent = { file, options };
        },
    }, () => assert.fail('bundled library request should be handled'));
    await middleware.runWebpackCompiler({ pruneCache: true });

    assert.deepEqual(sent, {
        file: 'lib.js',
        options: {
            root: '/release',
            etag: true,
            lastModified: true,
            headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
        },
    });
    assert.deepEqual(calls, [{ bundled: true }]);
});

test('missing bundled libraries fall back to the data-root cache', async () => {
    const calls = [];
    const middleware = getWebpackServeMiddleware('', {
        getPublicLibConfig: options => {
            calls.push(options);
            return options.bundled ? makeConfig('/release') : makeConfig('/runtime');
        },
        fileExists: file => file === '/runtime/lib.js',
        webpack: () => assert.fail('existing runtime cache must not be recompiled'),
    });

    await middleware.runWebpackCompiler({ pruneCache: true });

    assert.deepEqual(calls, [
        { bundled: true },
        { forceDist: false, pruneCache: true },
    ]);
});
