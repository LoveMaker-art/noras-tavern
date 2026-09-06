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
    assert.match(source, /getChat\(\{ preloadedData: snapshot\.chat, strict: true, beforeRender \}\)/);
    assert.doesNotMatch(source, /scheduleNoraWorldSnapshotLifecycle|setTimeout/);
    assert.match(script, /await getChatResult\(\{ snapshot: Boolean\(preloadedData\), beforeRender \}\)/);
    const lifecycleStart = script.indexOf('async function getChatResult');
    const lifecycleEnd = script.indexOf('\nfunction getFirstMessage', lifecycleStart);
    const lifecycle = script.slice(lifecycleStart, lifecycleEnd);
    const prepare = lifecycle.indexOf("snapshotStep('display-capabilities', beforeRender)");
    const regex = lifecycle.indexOf("snapshotStep('event.chat-pre-render'");
    const render = lifecycle.indexOf("snapshotStep('dom-render', printMessages)");
    assert.ok(prepare >= 0 && regex > prepare && render > regex, 'display capabilities and Regex rules must finish before the only first render');
    assert.match(script, /snapshotStep\('background\.event\.chat-loaded', emitChatLoaded\)/);
    assert.doesNotMatch(source, /await snapshotStep\('background\.event\.chat-loaded'/);
});
