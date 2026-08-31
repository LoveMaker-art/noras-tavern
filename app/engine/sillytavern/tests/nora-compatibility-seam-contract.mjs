import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiPath = path.resolve(engineRoot, '..', '..', 'native-extensions', 'nora-ui', 'index.js');
const ui = fs.readFileSync(uiPath, 'utf8');
const runtime = fs.readFileSync(path.join(engineRoot, 'public', 'scripts', 'nora-runtime', 'index.js'), 'utf8');
const worldRuntime = fs.readFileSync(path.join(engineRoot, 'public', 'scripts', 'nora-worlds', 'world-core-runtime.js'), 'utf8');
const worldClient = fs.readFileSync(path.join(engineRoot, 'public', 'scripts', 'nora-worlds', 'world-core-client.js'), 'utf8');
const adaptersRoot = path.join(engineRoot, 'public', 'scripts', 'nora-adapters');

for (const [file, factory] of [
    ['st-message-adapter.js', 'createStMessageAdapter'],
    ['st-card-adapter.js', 'createStCardAdapter'],
    ['st-worldbook-adapter.js', 'createStWorldbookAdapter'],
    ['st-model-adapter.js', 'createStModelAdapter'],
    ['st-mvu-settings-adapter.js', 'createStMvuSettingsAdapter'],
    ['st-settings-adapter.js', 'createStSettingsAdapter'],
]) {
    const modulePath = path.join(adaptersRoot, file);
    assert.equal(fs.existsSync(modulePath), true, `${file} must own its ST compatibility responsibility`);
    const source = fs.readFileSync(modulePath, 'utf8');
    assert.match(source, new RegExp(`export function ${factory}\\b`), `${file} must expose ${factory}`);
    assert.match(
        fs.readFileSync(path.join(adaptersRoot, 'st-runtime-adapter.js'), 'utf8'),
        new RegExp(`import \\{ ${factory} \\} from './${file.replace('.', '\\.')}';`),
        `the runtime adapter must compose ${factory}`,
    );
}

assert.doesNotMatch(ui, /\bgetContext\b|\bcurrentContext\b|\bcontextProvider\b/, 'Nora UI must not receive the raw ST context');
assert.doesNotMatch(ui, /\.eventSource\b|\.eventTypes\b/, 'Nora UI lifecycle events must cross the runtime adapter');
assert.doesNotMatch(
    ui,
    /\.(?:getRequestHeaders|loadWorldInfo|saveWorldInfo|updateWorldInfoList|convertCharacterBook|unshallowCharacter|updateMessageBlock|setExtensionPrompt|saveSettingsDebounced)\b/,
    'Nora UI must not call ST compatibility methods directly',
);
assert.match(ui, /function mount\(\{ story \}\)/, 'Nora UI must mount through the named story domain interfaces only');
assert.doesNotMatch(ui, /story\.runtime|function mount\(\{\s*runtime/, 'Nora UI must not accept the flat Runtime bridge');

assert.doesNotMatch(runtime, /getCompatibilityContext/, 'Nora Runtime must not expose a raw ST compatibility escape hatch');
const mountArguments = [...runtime.matchAll(/ui\.mount\(([\s\S]*?)\);/g)].map(match => match[1].replace(/\s/g, ''));
assert.deepEqual(mountArguments, ['{story}'], 'Only the named Story surface may be passed to UI; inspect the mount call, not subsequent control setup');
assert.match(runtime, /whenAppReady:\s*story\.state\.whenReady/, 'the public ready lifecycle must resolve through the story state domain');

assert.doesNotMatch(worldRuntime, /\bgetContext\b|\brequireContext\b|SillyTavern/, 'World runtime must depend on the World adapter interface');
assert.match(worldRuntime, /export function createWorldCoreRuntime\(runtime,/, 'World runtime must receive the World adapter interface');
assert.doesNotMatch(worldClient, /\bgetContext\b|\brequireContext\b|SillyTavern/, 'World client must receive request headers through the transport interface');

console.log('nora-compatibility-seam-contract=PASS');
