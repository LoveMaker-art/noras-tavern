import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const script = fs.readFileSync(path.join(root, 'public/script.js'), 'utf8');
const worldInfo = fs.readFileSync(path.join(root, 'public/scripts/world-info.js'), 'utf8');

test('aggregate snapshots replace transport only and retain the native synchronous chat lifecycle', () => {
    const start = script.indexOf('export async function activateNoraWorldSnapshot');
    const end = script.indexOf('\n////////// OPTIMZED MAIN API CHANGE FUNCTION', start);
    assert.ok(start >= 0 && end > start);
    const source = script.slice(start, end);
    assert.match(source, /primeWorldInfoSnapshot/);
    assert.match(source, /getChat\(\{ preloadedData: snapshot\.chat, strict: true \}\)/);
    assert.doesNotMatch(source, /scheduleNoraWorldSnapshotLifecycle|setTimeout/);
    assert.match(script, /await getChatResult\(\{ snapshot: Boolean\(preloadedData\) \}\)/);
    assert.match(script, /snapshotStep\('background\.event\.chat-loaded', emitChatLoaded\)/);
    assert.doesNotMatch(source, /await snapshotStep\('background\.event\.chat-loaded'/);
});

test('priming an imported Worldbook makes its name immediately visible to extension runtimes', () => {
    const start = worldInfo.indexOf('export function primeWorldInfoSnapshot');
    const end = worldInfo.indexOf('\n}\n', start) + 2;
    assert.ok(start >= 0 && end > start);

    const cache = new Map();
    const context = vm.createContext({ worldInfoCache: cache, world_names: ['existing-book'] });
    const source = worldInfo.slice(start, end).replace('export function', 'function');
    vm.runInContext(`${source}\nprimeWorldInfoSnapshot('imported-book', { entries: {} });\nprimeWorldInfoSnapshot('imported-book', { entries: {} });`, context);

    assert.deepEqual([...context.world_names], ['existing-book', 'imported-book']);
    assert.equal(typeof cache.get('imported-book')?.entries, 'object');
});
