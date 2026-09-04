import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fs.readFileSync(path.join(root, 'public/script.js'), 'utf8');
const systemMessages = fs.readFileSync(path.join(root, 'public/scripts/system-messages.js'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'public/scripts/i18n.js'), 'utf8');
const noraEntry = fs.readFileSync(path.join(root, 'public/nora-entry.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const bootEndpoint = fs.readFileSync(path.join(root, 'src/endpoints/nora-boot.js'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'src/nora-bootstrap.js'), 'utf8');
const extensions = fs.readFileSync(path.join(root, 'public/scripts/extensions.js'), 'utf8');
const worldController = fs.readFileSync(path.resolve(root, '../../native-extensions/nora-ui/world-controller.js'), 'utf8');
const singleQuote = String.fromCharCode(39);

assert.match(
    script,
    /from ['"]\.\/scripts\/extensions\.js['"];/,
    'ST core must use the canonical extensions module URL shared by card runtimes',
);
assert.doesNotMatch(
    script,
    /from ['"]\.\/scripts\/extensions\.js\?v=/,
    'a versioned extensions import creates a second settings module for complex-card runtimes',
);

const firstLoadStart = script.indexOf('async function firstLoadInit()');
const firstLoadEnd = script.indexOf('async function fixViewport()', firstLoadStart);

assert.notEqual(firstLoadStart, -1, 'script.js must define firstLoadInit');
assert.notEqual(firstLoadEnd, -1, 'script.js must retain a boundary after firstLoadInit');

const firstLoad = script.slice(firstLoadStart, firstLoadEnd);
const criticalReady = firstLoad.indexOf('await criticalExtensionActivation;');
const criticalMountYield = firstLoad.indexOf('await new Promise(resolve => setTimeout(resolve, 0));');
const appReady = firstLoad.indexOf('eventSource.emit(event_types.APP_READY)');
const deferredStart = firstLoad.indexOf('finishDeferredInitialization(criticalExtensionActivation)');

assert.match(firstLoad, /if \(!isNoraProduct\)\s*\{\s*await criticalExtensionActivation;\s*\}/, 'upstream ST must still wait for baseline extensions');
assert.ok(criticalReady < criticalMountYield, 'the upstream-only extension gate must remain before the final mount yield');
assert.ok(criticalMountYield < appReady, 'APP_READY must not race ahead of baseline extension mounting');
assert.ok(appReady < deferredStart, 'non-critical extensions must remain deferred until after APP_READY');
assert.match(firstLoad, /const metadataTasks = \[[^]*timedBootStep\('client-version'[^]*timedBootStep\('secrets-state'[^]*await Promise\.all\(metadataTasks\)/, 'bundled bootstrap metadata must apply concurrently');
assert.match(firstLoad, /if \(!isNoraProduct\) metadataTasks\.push\(timedBootStep\('locales'/, 'only the upstream UI may block on localization');
assert.match(firstLoad, /const settingsTasks = \[timedBootStep\('settings-core'[^]*if \(!isNoraProduct\) settingsTasks\.push\(timedBootStep\('system-messages'/, 'Nora must not block settings on system templates');
assert.doesNotMatch(firstLoad, /__NORA_LOAD_DEFERRED_STYLES__/, 'noncritical styles must not start on the core ready path');
assert.match(script, /criticalExtensionNames\s*=\s*\[['"]regex['"]\]/, 'ordinary startup must load only the baseline regex runtime');
assert.doesNotMatch(firstLoad, /mvu-runtime|JS-Slash-Runner/, 'complex-card runtimes must not block ordinary startup');
assert.match(
    extensions,
    /NORA_PRODUCT_DEFERRED_EXTENSIONS[\s\S]*third-party\/JS-Slash-Runner[\s\S]*third-party\/nora-mvu/,
    'complex-card runtimes must be explicitly deferred',
);
assert.match(
    extensions,
    /Object\.keys\(manifests\)\.filter\(name => !noraProduct \|\| !NORA_PRODUCT_DEFERRED_EXTENSIONS\.includes\(name\)\)/,
    'deferred startup activation must not accidentally activate complex-card runtimes',
);

assert.match(
    firstLoad,
    /if \(!isNoraProduct\)\s*\{[^}]*coreDataTasks\.push\(timedBootStep\('backgrounds', getBackgrounds\)\);/,
    'Nora startup must not wait for the removed background library UI',
);
assert.match(
    systemMessages,
    /Promise\.all\(\[\s*renderTemplateAsync\('help'\),[\s\S]*renderTemplateAsync\('assistantNote'\),?\s*\]\)/,
    'system message templates must load concurrently instead of adding serial network latency',
);
assert.match(firstLoad, /timedBootSyncStep\('bootstrap-dom'[\s\S]*initSystemMessageCore\(\)/, 'the headless system-message interface must be available synchronously');
assert.match(systemMessages, /export function initSystemMessageCore\(\)/, 'Nora needs a template-free system-message implementation');
assert.match(systemMessages, /system_messages\[type\] \?\?= structuredClone\(defaultMessage\)/, 'every compatibility message type needs a headless fallback');
assert.match(systemMessages, /const systemMessage = system_messages\[type\] \?\? system_messages\.generic/, 'unknown compatibility messages must degrade to a valid generic message');
assert.match(systemMessages, /export function getSafetyChat\(\)[\s\S]*initSystemMessageCore\(\)/, 'chat reset must use the headless system-message interface');
assert.match(i18n, /export \{ getCurrentLocale, addLocaleData, t \} from '.\/nora-i18n\/core.js'/, 'ST and extensions must share Nora translation data without the legacy locale UI');
assert.doesNotMatch(noraEntry, /from ['"]\.\/locales\/zh-cn\.json['"]/, 'the full ST locale must not be compiled into the critical Nora entry bundle');
assert.match(noraEntry, /startNoraRuntime\(\)\.then\([\s\S]*loadCompatibilityLocale\(\)/, 'the full ST locale must load only after the Nora runtime is usable');
assert.doesNotMatch(
    index,
    /<link\s+rel="preload"\s+as="style"[^>]+nora-ui\/style\.css/,
    'Nora UI CSS must not be transferred once as a preload and again as a stylesheet',
);
assert.doesNotMatch(index, /<link\s+rel="manifest"/, 'the PWA manifest must not compete with the interactive startup path');
assert.match(index, /legacy\.src = `\$\{globalThis\.__NORA_VENDOR_ASSET_BASE__\}\/dist\/nora\/legacy\.js`/, 'legacy libraries must load once from their independently versioned immutable asset');
assert.match(index, /manifest\.legacy/, 'startup metrics must identify the standalone legacy asset');
assert.match(index, /id="third-party_nora-ui-css"/, 'the Nora UI stylesheet must share the extension loader identity and load once');
assert.match(extensions, /if \(existingStyle\.length > 0\)\s*\{\s*return Promise\.resolve\(\);/, 'an existing extension stylesheet must resolve without injecting a duplicate or hanging');
const headShellStart = index.indexOf(
    'const shellNetworkPromise = fetch(' + singleQuote + '/api/nora-boot/shell' + singleQuote,
);
const headBootstrapStart = index.indexOf(
    'const runtimeBootstrapNetworkPromise = fetch(' + singleQuote + '/api/nora-boot/bootstrap' + singleQuote,
);
const manifestNetworkYield = index.indexOf('await globalThis.__NORA_SHELL_BOOTSTRAP_PROMISE__.catch(() => undefined)');
const runtimeAssetGate = index.indexOf('globalThis.__NORA_START_RUNTIME_ASSETS__ =');
const manifestNetworkStart = index.indexOf('return fetch(globalThis.__NORA_INLINE_MANIFEST_URL__');
const bodyBootstrapReuse = index.indexOf('const bootstrapPromise = globalThis.__NORA_SHELL_BOOTSTRAP_PROMISE__');
const bodyShellReuse = index.indexOf('const shellPromise = globalThis.__NORA_SHELL_DATA_PROMISE__');
assert.notEqual(headShellStart, -1, 'the compact World summary request must start from the head');
assert.notEqual(headBootstrapStart, -1, 'the aggregate runtime bootstrap request must still start from the head');
assert.notEqual(runtimeAssetGate, -1, 'large runtime assets must have one explicit start gate');
assert.equal(manifestNetworkYield, -1, 'a cold runtime manifest must not create a second network wave behind bootstrap');
assert.notEqual(manifestNetworkStart, -1, 'the module manifest must retain its network fallback');
assert.notEqual(bodyShellReuse, -1, 'the early shell must reuse the head World summary request');
assert.notEqual(bodyBootstrapReuse, -1, 'the early shell must reuse the head bootstrap request');
assert.ok(headShellStart < headBootstrapStart, 'the compact visible-shell request must be scheduled first');
assert.ok(headBootstrapStart < runtimeAssetGate, 'runtime bootstrap must be scheduled before the gated runtime assets');
assert.ok(manifestNetworkStart < bodyBootstrapReuse, 'the body must reuse the already-started shell bootstrap request');
assert.match(index, /globalThis\.__NORA_RELEASE_GUARD_PROMISE__\s*=\s*shellNetworkPromise\.then/, 'the compact shell response must enforce shell/backend release coherence');
assert.match(index, /globalThis\.__NORA_SHELL_DATA_PROMISE__\s*=\s*globalThis\.__NORA_RELEASE_GUARD_PROMISE__/, 'visible shell data must wait for the release guard');
assert.match(index, /globalThis\.__NORA_SHELL_BOOTSTRAP_PROMISE__\s*=\s*Promise\.all/, 'runtime bootstrap must retain the release guard without blocking the visible shell');
assert.match(index, /target\.searchParams\.set\('release', currentRelease\)[\s\S]*location\.replace\(target\.href\)/, 'a stale shell must navigate once to the current release URL');
assert.doesNotMatch(
    index.slice(manifestNetworkStart, bodyBootstrapReuse),
    /__NORA_RELEASE_GUARD_PROMISE__|bootstrapNetworkPromise|Promise\.all/,
    'release validation must not serialize immutable manifest parsing behind bootstrap',
);
assert.match(
    index.slice(headShellStart, headBootstrapStart),
    /credentials:\s*'same-origin'[\s\S]*priority:\s*'high'/,
    'the compact visible-shell request must be authenticated and high priority',
);
assert.match(index.slice(headBootstrapStart, manifestNetworkStart), /priority:\s*'low'/, 'the larger runtime bootstrap must not outrank visible World summaries');
assert.match(
    index.slice(manifestNetworkStart, bodyBootstrapReuse),
    /priority:\s*'low'/,
    'the large runtime manifest must not compete with the compact visible-shell request',
);
assert.doesNotMatch(
    index.slice(bodyBootstrapReuse),
    /fetch\('\/api\/nora-boot\/bootstrap'/,
    'the body must not issue a duplicate aggregate bootstrap request',
);
assert.match(index, /shellPromise\.then\(\(shell\) => \{[\s\S]*render\(shell\)[\s\S]*reveal\(\)/, 'authoritative World summaries must reveal the existing shell before runtime hydration');
assert.doesNotMatch(index, /shell-deadline|__NORA_START_RUNTIME_ASSETS__\('shell-visible'\)/, 'the visible World list must not automatically release the full ST runtime');
assert.match(index, /const queueAction = \(name,[\s\S]*requestRuntime\(name\)/, 'a World or product action must release the full runtime on explicit user intent');
assert.match(index, /Promise\.all\(\[shellPromise, dataPromise\]\)[\s\S]*world\.id === lastWorldId && world\.lifecycleStatus === 'READY'[\s\S]*queueWorld\(resumeWorld, target, 'resume'\)/, 'returning users must resume only the persisted last World after validating it against the authoritative shell list');
assert.match(index, /requestRuntime\('send'\)/, 'an early send must release the full runtime');
assert.doesNotMatch(worldController, /async function openInitial\(/, 'the World controller must not infer a first World or own a second startup path');
assert.doesNotMatch(index, /dataset\.noraInteractiveMs\s*\|\|=/, 'metadata arrival must not masquerade as an interactive application');
assert.doesNotMatch(index, /__NORA_CHAT_PROMISES__|data\.initialWorld|data\.startup|worldCoreV2/, 'the early shell must not reconstruct a legacy World from bootstrap projections');
assert.doesNotMatch(firstLoad, /nora-deferred-core|__NORA_DEFERRED_CORE_PROMISE__/, 'Nora must not retain a legacy UI hydration phase');
assert.doesNotMatch(firstLoad, /noraRuntimeReadyPromise\.then\(\(\) => timedBootStep\('(?:locales|system-messages|user-avatars|personas)'/, 'Nora must not initialize removed ST UI after becoming usable');
assert.match(firstLoad, /waitForNoraRuntimeReady\(\)[\s\S]*?activateCritical/, 'extension activation must start after the Nora UI is initialized, including empty workspaces');
assert.doesNotMatch(index, /characters\.slice\(0, 3\)/, 'startup must not download arbitrary full character cards');
assert.doesNotMatch(index, /recentAvatars/, 'startup must not prefetch every recent World card');
assert.doesNotMatch(script, /globalThis\.__NORA_(?:CHAT|CHARACTER)_PROMISES__/, 'ST loading must not retain dead legacy bootstrap prefetch branches');
assert.doesNotMatch(index, /__NORA_CHARACTERS_PROMISE__/, 'the shell must not expose a hidden full-card bootstrap dependency');
assert.doesNotMatch(bootstrap, /listCharactersFn|characters:/, 'the runtime bootstrap must not scan or serialize the card library');
assert.match(firstLoad, /if \(!isNoraProduct\)\s*\{\s*coreDataTasks\.push\(timedBootStep\('characters', getCharacters\)\)/, 'only upstream ST may block APP_READY on a full card-library scan');
for (const retiredStartupRequest of [
    'fetch(' + singleQuote + '/csrf-token' + singleQuote + ')',
    'fetch(' + singleQuote + '/api/characters/all' + singleQuote,
    'fetch(' + singleQuote + '/api/chats/recent' + singleQuote,
]) {
    assert.doesNotMatch(index, new RegExp(retiredStartupRequest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `early startup must not issue ${retiredStartupRequest}`);
}
assert.match(bootEndpoint, /router\.get\('\/shell'/, 'backend must expose one compact visible-shell route');
assert.match(bootEndpoint, /router\.get\('\/bootstrap'/, 'backend must retain the aggregate runtime bootstrap route');

console.log('nora-critical-startup-contract=PASS');
