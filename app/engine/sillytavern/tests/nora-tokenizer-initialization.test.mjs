import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Execute the shipped classes with only their filesystem/library dependencies
// replaced. This catches concurrent callers and partially initialized instances.
function classes({ resolveModel, web, sentence }) {
    const source = readFileSync(new URL('../src/endpoints/tokenizers.js', import.meta.url), 'utf8');
    const start = source.indexOf('class SentencePieceTokenizer {');
    const implementation = source.slice(start, source.indexOf('const spp_llama', start));
    return new Function('getPathToTokenizer', 'fs', 'Tokenizer', 'SentencePieceProcessor', 'path', 'console',
        `${implementation};return { WebTokenizer, SentencePieceTokenizer };`)(resolveModel,
        { promises: { readFile: async () => Buffer.from('{}') } }, { fromJSON: web }, sentence,
        { parse: () => ({ name: 'fixture' }) }, { info() {}, error() {} });
}

test('concurrent cold WebTokenizer callers initialize once, warm callers reuse it', async () => {
    let paths = 0;
    let created = 0;
    const instance = {};
    const { WebTokenizer } = classes({ resolveModel: async () => { paths++; return 'fixture'; }, web: async () => { created++; return instance; } });
    const tokenizer = new WebTokenizer('fixture');
    const values = await Promise.all(Array.from({ length: 8 }, () => tokenizer.get()));
    assert.equal(paths, 1);
    assert.equal(created, 1);
    assert.ok(values.every(value => value === instance));
    assert.equal(await tokenizer.get(), instance);
    assert.equal(created, 1);
});

test('SentencePiece failure never publishes a partial instance and can retry', async () => {
    let fail = true;
    let created = 0;
    class Processor {
        constructor() { created++; }
        async load() { if (fail) throw new Error('invalid model'); this.ready = true; }
    }
    const { SentencePieceTokenizer } = classes({ resolveModel: async () => 'fixture', sentence: Processor });
    const tokenizer = new SentencePieceTokenizer('fixture');
    assert.deepEqual(await Promise.all([tokenizer.get(), tokenizer.get()]), [null, null]);
    assert.equal(created, 1);
    fail = false;
    assert.equal((await tokenizer.get()).ready, true);
    assert.equal(created, 2);
});
