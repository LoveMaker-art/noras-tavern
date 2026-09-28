import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFakerLoader } from '../../../native-extensions/ST-Prompt-Template/deferred-faker.js';
import { transformDeferredFaker } from '../../../native-extensions/ST-Prompt-Template/apply-deferred-faker.mjs';

test('faker is lazy, shares concurrent loads and returns the original synchronous namespace', async () => {
    let calls = 0;
    const namespace = { en: { person: { firstName: () => 'Example' } } };
    const load = createFakerLoader(async () => { calls++; return namespace; });
    assert.equal(calls, 0);
    const [first, second] = await Promise.all([load(), load()]);
    assert.equal(calls, 1);
    assert.equal(first, namespace);
    assert.equal(second.en.person.firstName(), 'Example');
});

test('a failed faker dependency is not converted to an undefined template variable', async () => {
    let calls = 0;
    const load = createFakerLoader(async () => { if (++calls === 1) throw new Error('offline'); return {}; });
    await assert.rejects(load(), /offline/);
    assert.deepEqual(await load(), {});
});

test('pinned template transform awaits faker before constructing any public context', () => {
    const source = fs.readFileSync(new URL('../../../native-extensions/ST-Prompt-Template/dist/index.js', import.meta.url), 'utf8');
    const transformed = transformDeferredFaker(source);
    assert.equal(transformDeferredFaker(transformed), transformed);
    assert.ok(!transformed.includes('from"../libs/faker.mjs"'));
    assert.ok(!transformed.includes('2395:e=>'));
    assert.match(transformed, /async function Hf\(e\)\{Gm.faker=await noraLoadFaker\(\);/);
    assert.match(transformed, /faker:Gm.faker/);
    assert.throws(() => transformDeferredFaker('unknown bundle'), /anchors/);
});
