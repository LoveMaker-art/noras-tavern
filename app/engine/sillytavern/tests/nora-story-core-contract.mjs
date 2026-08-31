import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const core = read('public/scripts/nora-story-core/index.js');
const runtime = read('public/scripts/nora-runtime/index.js');

for (const domain of ['state', 'messages', 'cards', 'worldbook', 'model', 'mvu', 'settings', 'transport']) {
    assert.match(core, new RegExp(`\\b${domain}:`), `story core must expose the ${domain} domain`);
}
assert.match(core, /createNoraStoryCore/);
assert.doesNotMatch(core, /document\.|querySelector|NoraUI/, 'the story core must not depend on the product UI');
assert.match(runtime, /createNoraStoryCore\(\)/);
assert.doesNotMatch(runtime, /createStRuntimeAdapter|createStWorldAdapter|createWorldRegistryClient|createWorldRuntime/);
assert.match(runtime, /whenAppReady:\s*story\.state\.whenReady/);
assert.match(runtime, /ui\.mount\(\{ story \}\)/);
assert.doesNotMatch(runtime, /story\.runtime|\bactions:/, 'runtime entry must not recreate the flat Runtime bridge');
assert.doesNotMatch(core, /\bruntime,\s*\n\s*whenReady:|\bwhenReady:\s*domains\.state\.whenReady/, 'story surface must expose readiness through the state domain only');

console.log('nora-story-core-contract=PASS');
