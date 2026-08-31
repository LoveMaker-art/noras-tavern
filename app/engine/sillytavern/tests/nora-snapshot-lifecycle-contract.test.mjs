import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const script = fs.readFileSync(path.join(root, 'public/script.js'), 'utf8');

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
