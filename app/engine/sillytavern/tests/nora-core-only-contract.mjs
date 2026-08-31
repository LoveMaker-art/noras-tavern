import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = relative => fs.readFileSync(path.join(engineRoot, relative), 'utf8');
const exists = relative => fs.existsSync(path.join(engineRoot, relative));

const startup = source('src/server-startup.js');
const serverMain = source('src/server-main.js');
const constants = source('src/constants.js');
const workspace = source('src/workspace.js');
const settingsRuntime = source('src/settings-runtime.js');
const settingsEndpoint = source('src/endpoints/settings.js');
const contentManager = source('src/endpoints/content-manager.js');
const extensions = source('public/scripts/extensions.js');
const packageJson = JSON.parse(source('package.json'));

for (const removed of ['quick-replies', 'stats', 'vectors', 'speech']) {
    assert.doesNotMatch(startup, new RegExp(removed, 'i'), `${removed} route must be removed`);
    assert.equal(exists(`src/endpoints/${removed}.js`), false, `${removed} endpoint source must be removed`);
}

assert.doesNotMatch(serverMain, /statsInit|statsOnExit/);
assert.doesNotMatch(constants, /quickreplies|vectors/i);
assert.doesNotMatch(workspace, /quickreplies|vectors|stats\.json/i);
assert.doesNotMatch(settingsRuntime, /quick-reply/i);
assert.doesNotMatch(settingsEndpoint, /quickReplyPresets|quickreplies/i);
assert.doesNotMatch(contentManager, /QUICK_REPLIES/);
assert.doesNotMatch(extensions, /^\s*(tts|quickReply|speech_recognition|rvc|vectors):/m);

for (const removedPath of [
    'src/vectors',
    'public/scripts/extensions/quick-reply',
    'public/scripts/extensions/tts',
    'public/scripts/extensions/vectors',
]) {
    assert.equal(exists(removedPath), false, `${removedPath} must be removed`);
}

assert.equal(packageJson.dependencies.vectra, undefined);
assert.equal(packageJson.dependencies.wavefile, undefined);
assert.equal(packageJson.overrides.vectra, undefined);

for (const providerRouter of [
    'openAiRouter',
    'googleRouter',
    'anthropicRouter',
    'novelAiRouter',
    'openRouterRouter',
    'nanogptRouter',
    'chatCompletionsRouter',
    'textCompletionsRouter',
    'azureRouter',
    'volcengineRouter',
    'minimaxRouter',
]) {
    assert.match(startup, new RegExp(`\\b${providerRouter}\\b`), `${providerRouter} must be preserved`);
}

console.log('nora-core-only-contract=PASS');
