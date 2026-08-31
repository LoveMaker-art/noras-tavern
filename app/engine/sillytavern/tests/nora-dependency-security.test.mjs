import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { addShowdownPatch } from '../public/scripts/util/showdown-patch.js';
import { markdownUnderscoreExt } from '../public/scripts/showdown-underscore.js';

const require = createRequire(import.meta.url);
const imagePath = fileURLToPath(new URL('../vendor/image-size/index.cjs', import.meta.url));
const showdownPath = fileURLToPath(new URL('../vendor/showdown/index.cjs', import.meta.url));
const showdown = require(showdownPath);
addShowdownPatch(showdown);

test('production dependency names resolve to the reviewed implementations', async () => {
    assert.equal(require('showdown'), showdown);
    assert.equal(require('image-size'), require(imagePath));
    const imageModule = await import('image-size');
    assert.equal(imageModule.default, require(imagePath).imageSize);
    assert.equal(imageModule.imageSize, require(imagePath).imageSize);
});

function isolated(source) {
    const result = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 2000 });
    assert.equal(result.error, undefined, 'Dependency must finish without blocking on malformed input');
    assert.equal(result.status, 0, result.stderr);
}

function box(name, payload = Buffer.alloc(0), size = payload.length + 8) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(size);
    header.write(name, 4);
    return Buffer.concat([header, payload]);
}

const badIcns = box('icns', box('icp4', Buffer.alloc(0), 0));
// A zero-sized matching box previously made the caller repeat the same offset.
const badHeif = Buffer.concat([
    box('ftyp', Buffer.from('heic0000')),
    box('meta', Buffer.concat([Buffer.alloc(4), box('iprp', box('ipco', box('ispe', Buffer.alloc(12), 0)))])),
]);
const badJxl = Buffer.concat([
    box('JXL ', Buffer.from([13, 10, 135, 10])),
    box('ftyp', Buffer.from('jxl 0000')),
    box('jxlp', Buffer.alloc(4), 0),
]);

for (const [name, payload] of [['ICNS', badIcns], ['HEIF', badHeif], ['JXL', badJxl]]) {
    test(`image-size rejects malformed ${name} without looping, including direct dependency calls`, () => {
        isolated(`const assert=require('node:assert/strict');const {imageSize}=require(${JSON.stringify(imagePath)});
            assert.throws(()=>imageSize(Buffer.from(${JSON.stringify(payload.toString('base64'))},'base64')));`);
    });
}

test('Showdown processes unmatched bracket input without catastrophic rescanning', () => {
    isolated(`const assert=require('node:assert/strict');const showdown=require(${JSON.stringify(showdownPath)});
        const text='['.repeat(90000);const output=new showdown.Converter().makeHtml(text);
        assert.equal(output,'<p>'+text+'</p>');`);
});

test('Showdown escapes metadata title markup in complete HTML documents', () => {
    const converter = new showdown.Converter({ metadata: true, completeHTMLDocument: true });
    const html = converter.makeHtml('---\ntitle: </title><script>alert(1)</script>\n---\nhello');
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;/title&gt;&lt;script&gt;'));
});

test('Showdown escapes table header ID attributes under both supported option names', () => {
    for (const key of ['tablesHeaderId', 'tableHeaderId']) {
        const html = new showdown.Converter({ tables: true, [key]: true })
            .makeHtml('a" onclick="alert(1) | b\n--- | ---\nc | d');
        assert.ok(html.includes('<th id="a&quot;_onclick=&quot;alert(1)">'), html);
    }
});

test('Showdown keeps original ST Markdown, HTML cards and extension output', () => {
    const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/showdown-2-compatibility.json', import.meta.url)));
    for (const { text, options, html } of fixture.cases) {
        const converter = new showdown.Converter({ ...options, extensions: [markdownUnderscoreExt()] });
        assert.equal(converter.makeHtml(text), html, `Changed formatting: ${JSON.stringify({ text, options })}`);
    }
    const converter = new showdown.Converter();
    const extension = { type: 'output', filter: html => html.replace('hello', '世界') };
    converter.addExtension(extension, 'tavern-test');
    assert.equal(converter.makeHtml('hello'), '<p>世界</p>');
    converter.removeExtension(extension);
    assert.equal(converter.makeHtml('hello'), '<p>hello</p>');
});

test('image adapter preserves every currently supported format and sliced buffers', async () => {
    const { imageSize } = await import('../src/image-dimensions.js');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9AAAAABJRU5ErkJggg==', 'base64');
    const gif = Buffer.from('GIF89a\x02\x00\x03\x00', 'binary');
    const bmp = Buffer.alloc(54);
    bmp.write('BM'); bmp.writeUInt32LE(54, 2); bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(2, 18); bmp.writeInt32LE(-3, 22);
    const jpeg = Buffer.from([255, 216, 255, 224, 0, 2, 255, 192, 0, 17, 8, 0, 3, 0, 2, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1]);
    const webp = Buffer.alloc(30);
    webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8);
    webp.writeUInt32LE(10, 16); webp.writeUIntLE(1, 24, 3); webp.writeUIntLE(2, 27, 3);
    const tiff = Buffer.alloc(38);
    tiff.write('II'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4); tiff.writeUInt16LE(2, 8);
    for (const [offset, tag, value] of [[10, 256, 2], [22, 257, 3]]) {
        tiff.writeUInt16LE(tag, offset); tiff.writeUInt16LE(3, offset + 2);
        tiff.writeUInt32LE(1, offset + 4); tiff.writeUInt16LE(value, offset + 8);
    }
    for (const [type, bytes, width, height] of [
        ['png', png, 1, 1], ['gif', gif, 2, 3], ['bmp', bmp, 2, 3],
        ['jpg', jpeg, 2, 3], ['webp', webp, 2, 3], ['tiff', tiff, 2, 3],
    ]) {
        const result = imageSize(bytes);
        assert.deepEqual([result.type, result.width, result.height], [type, width, height]);
        const padded = Buffer.concat([Buffer.alloc(17), bytes, Buffer.alloc(9)]);
        assert.deepEqual(imageSize(padded.subarray(17, 17 + bytes.length)), result);
    }
    assert.throws(() => imageSize(bmp.subarray(0, 12)), 'Do not read past a truncated slice into its backing buffer');
});
