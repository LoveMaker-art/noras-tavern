import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.env.NORA_REGRESSION_SOURCE_ROOT || defaultRoot);
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const script = read('public/script.js');
const extensions = read('public/scripts/extensions.js');
const personas = read('public/scripts/personas.js');
const startupController = fs.readFileSync(
    path.resolve(root, '../../native-extensions/nora-ui/startup-controller.js'),
    'utf8',
);
const worldController = fs.readFileSync(
    path.resolve(root, '../../native-extensions/nora-ui/world-controller.js'),
    'utf8',
);
const characterController = fs.readFileSync(
    path.resolve(root, '../../native-extensions/nora-ui/character-controller.js'),
    'utf8',
);

const firstLoadStart = script.indexOf('async function firstLoadInit()');
const firstLoadEnd = script.indexOf('async function fixViewport()', firstLoadStart);
const firstLoad = script.slice(firstLoadStart, firstLoadEnd);
const generateStart = script.indexOf('export async function Generate(');
const generateEnd = script.indexOf('\n/**', generateStart + 1);
const generate = script.slice(generateStart, generateEnd === -1 ? undefined : generateEnd);

assert.match(
    extensions,
    /const extensionActivationTasks = new Map\(\)/,
    'extension activation needs one in-flight task registry',
);
assert.match(
    extensions,
    /const existingActivation = extensionActivationTasks\.get\(name\)[\s\S]*activationBatch\.push\(existingActivation\)/,
    'concurrent activation paths must reuse the existing extension task',
);
assert.match(
    extensions,
    /extensionActivationTasks\.set\(name, activation\)/,
    'the extension task registry must own every activation',
);
assert.match(
    extensions,
    /extensionActivationTasks\.delete\(name\)/,
    'the extension task registry must release settled activations',
);

assert.match(firstLoad, /const tokenCacheInitialization = isNoraProduct\s*\? noraRuntimeReadyPromise\.then/);
assert.match(firstLoad, /const criticalExtensionActivation = extensionActivationPlan[\s\S]*\? noraRuntimeReadyPromise\.then/);
assert.match(
    firstLoad,
    /__NORA_GENERATION_PREREQUISITES_PROMISE__ = Promise\.all\(\[\s*tokenCacheInitialization,\s*criticalExtensionActivation,?\s*\]\)/,
    'generation must wait only for its token and extension prerequisites',
);
assert.match(generate, /await globalThis\.__NORA_GENERATION_PREREQUISITES_PROMISE__/);
assert.doesNotMatch(
    firstLoad,
    /nora-deferred-core|__NORA_DEFERRED_CORE_PROMISE__/,
    'removed ST UI initializers must not survive as background work',
);
assert.doesNotMatch(
    generate,
    /await globalThis\.__NORA_DEFERRED_CORE_PROMISE__/,
    'first generation must not wait for locales, templates, avatars, or persona UI hydration',
);

assert.doesNotMatch(
    startupController,
    /scheduleWorldReload/,
    'a World activation event must not trigger a second authoritative World list request',
);
assert.doesNotMatch(
    worldController,
    /scheduleReload|reloadTimer/,
    'the retired delayed World-list refresh path must not remain as dead architecture',
);
assert.doesNotMatch(
    characterController,
    /for \(let index = 0; index < characters\.length; index \+= 1\)/,
    'opening the character library must not expand every full Runtime Card',
);
assert.match(
    characterController,
    /character\?\.shallow[\s\S]*resolveCharacter\(characterId\)/,
    'a character detail may expand only the selected shallow Runtime Card',
);
assert.match(
    startupController,
    /worldChanged:\s*\(\) => \{[\s\S]*setTimeout\(updateActiveWorldSummary, 0\)/,
    'World activation should refresh only the local active-World projection',
);

assert.match(
    personas,
    /updatePersonaDescription\(value, \{ syncUi = true \} = \{\}\)/,
    'the compatibility persona API must expose a headless update path',
);
assert.match(
    personas,
    /if \(syncUi\) countPersonaDescriptionTokens/,
    'headless World activation must not tokenize an invisible persona editor',
);

console.log('nora-liveware-blocking-contract=PASS');
