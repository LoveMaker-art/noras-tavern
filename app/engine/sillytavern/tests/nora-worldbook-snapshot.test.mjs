import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/scripts/world-info.js', import.meta.url), 'utf8');

function runtime(names) {
    const scope = vm.createContext({
        world_names: names,
        worldInfoCache: new Map(),
        fetch() { throw new Error('Snapshot reads must not need a network refresh'); },
        getRequestHeaders: () => ({}),
    });
    for (const [start, end] of [
        ['export function primeWorldInfoSnapshot', '\n/**'],
        ['export async function loadWorldInfo', '\nexport async function updateWorldInfoList'],
    ]) {
        const offset = source.indexOf(start);
        assert.ok(offset >= 0);
        const stop = source.indexOf(end, offset);
        assert.ok(stop > offset);
        vm.runInContext(source.slice(offset, stop).replace('export ', ''), scope);
    }
    return scope;
}

test('a newly imported snapshot is discoverable by name and immediately readable without refresh', async () => {
    const names = ['Existing Worldbook'];
    const scope = runtime(names);
    const book = { entries: { 0: { content: 'Test variable rule' } } };
    scope.primeWorldInfoSnapshot('New Worldbook', book);
    assert.ok(scope.world_names.includes('New Worldbook'), 'TavernHelper rejects names missing from world_names');
    assert.equal(await scope.loadWorldInfo('New Worldbook'), book);
    assert.equal(scope.world_names, names, 'preserve existing list references and indices');
    assert.deepEqual(names, ['Existing Worldbook', 'New Worldbook']);
});

test('reopening or updating a snapshot does not duplicate names or lose other books', async () => {
    const scope = runtime(['Existing Worldbook', 'New Worldbook']);
    scope.primeWorldInfoSnapshot('New Worldbook', { entries: {} });
    const updated = { entries: { 1: { content: 'Updated rule' } } };
    scope.primeWorldInfoSnapshot('New Worldbook', updated);
    assert.deepEqual(scope.world_names, ['Existing Worldbook', 'New Worldbook']);
    assert.equal(await scope.loadWorldInfo('New Worldbook'), updated);
});

test('snapshot priming tolerates an uninitialized index and ignores missing payloads', () => {
    const scope = runtime(undefined);
    scope.primeWorldInfoSnapshot('', { entries: {} });
    scope.primeWorldInfoSnapshot('Missing', null);
    assert.equal(scope.world_names, undefined);
    assert.equal(scope.worldInfoCache.size, 0);
    scope.primeWorldInfoSnapshot(' First ', { entries: {} });
    assert.equal(JSON.stringify(scope.world_names), '["First"]');
    assert.ok(scope.worldInfoCache.has('First'));
});
