import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

const adapter = new URL('../src/image-dimensions.js', import.meta.url);

test('image metadata rejects unsupported magic bytes before a synchronous decoder can hang', () => {
    const source = fs.existsSync(adapter) ? adapter.href : 'image-size';
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { imageSize } from ${JSON.stringify(source)};
        const payload = Buffer.alloc(16);
        payload.write('icns'); payload.writeUInt32BE(16, 4); payload.write('icp4', 8);
        try { imageSize(payload); process.exitCode = 2; }
        catch (error) { if (!/Unsupported image format/.test(error.message)) throw error; }
    `], { cwd: new URL('..', import.meta.url), timeout: 1000, encoding: 'utf8' });
    assert.equal(result.error, undefined, 'untrusted dimensions parsing must not block the event loop');
    assert.equal(result.status, 0, result.stderr);
});

test('dimension adapter keeps ordinary PNG and GIF dimensions', async () => {
    const { imageSize } = await import(adapter);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9AAAAABJRU5ErkJggg==', 'base64');
    assert.equal(imageSize(png).width, 1);
    const gif = Buffer.from('GIF89a\x02\x00\x03\x00', 'binary');
    assert.equal(imageSize(gif).height, 3);
});
