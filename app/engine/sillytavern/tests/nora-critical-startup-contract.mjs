import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fs.readFileSync(path.join(root, 'public/script.js'), 'utf8');
const systemMessages = fs.readFileSync(path.join(root, 'public/scripts/system-messages.js'), 'utf8');
const i18n = fs.readFileSync(path.join(root, 'public/scripts/i18n.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const bootEndpoint = fs.readFileSync(path.join(root, 'src/endpoints/nora-boot.js'), 'utf8');
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
assert.doesNotMatch(
    index,
    /<link\s+rel="preload"\s+as="style"[^>]+nora-ui\/style\.css/,
    'Nora UI CSS must not be transferred once as a preload and again as a stylesheet',
);
assert.doesNotMatch(index, /<link\s+rel="manifest"/, 'the PWA manifest must not compete with the interactive startup path');
assert.match(index, /<script\s+src="\{\{NORA_ASSET_BASE\}\}\/dist\/nora\/legacy\.js"/, 'legacy libraries must load once from their immutable standalone asset');
assert.match(index, /manifest\.legacy/, 'startup metrics must identify the standalone legacy asset');
assert.match(index, /id="third-party_nora-ui-css"/, 'the Nora UI stylesheet must share the extension loader identity and load once');
assert.match(extensions, /if \(existingStyle\.length > 0\)\s*\{\s*return Promise\.resolve\(\);/, 'an existing extension stylesheet must resolve without injecting a duplicate or hanging');
const headBootstrapStart = index.indexOf("globalThis.__NORA_SHELL_BOOTSTRAP_PROMISE__ = fetch('/api/nora-boot/bootstrap?max=250&metadata=true'");
const manifestNetworkYield = index.indexOf('await globalThis.__NORA_SHELL_BOOTSTRAP_PROMISE__.catch(() => undefined)');
const manifestNetworkStart = index.indexOf('globalThis.__NORA_INLINE_MANIFEST_PROMISE__ = fetch(globalThis.__NORA_INLINE_MANIFEST_URL__');
const bodyBootstrapReuse = index.indexOf('const bootstrapPromise = globalThis.__NORA_SHELL_BOOTSTRAP_PROMISE__');
assert.notEqual(headBootstrapStart, -1, 'the aggregate bootstrap request must start from the head before large runtime assets');
assert.equal(manifestNetworkYield, -1, 'a cold runtime manifest must not create a second network wave behind bootstrap');
assert.notEqual(manifestNetworkStart, -1, 'the module manifest must retain its network fallback');
assert.notEqual(bodyBootstrapReuse, -1, 'the early shell must reuse the head bootstrap request');
assert.ok(headBootstrapStart < manifestNetworkStart, 'bootstrap must start before the parallel runtime manifest request');
assert.ok(manifestNetworkStart < bodyBootstrapReuse, 'the body must reuse the already-started shell bootstrap request');
assert.match(
    index.slice(headBootstrapStart, manifestNetworkStart),
    /credentials:\s*'same-origin'[\s\S]*priority:\s*'high'/,
    'the shell bootstrap must be an authenticated high-priority request',
);
assert.match(
    index.slice(manifestNetworkStart, bodyBootstrapReuse),
    /priority:\s*'high'/,
    'the parallel runtime manifest is a critical high-priority request',
);
assert.doesNotMatch(
    index.slice(bodyBootstrapReuse),
    /fetch\('\/api\/nora-boot\/bootstrap\?max=250&metadata=true'/,
    'the body must not issue a duplicate aggregate bootstrap request',
);
assert.match(worldController, /settingsDomain\.uiSettings\(\)\.lastWorldId/, 'World v2 must restore the saved World through its authoritative controller');
assert.doesNotMatch(index, /dataset\.noraInteractiveMs\s*\|\|=/, 'metadata arrival must not masquerade as an interactive application');
assert.doesNotMatch(index, /__NORA_CHAT_PROMISES__|data\.initialWorld|data\.startup|worldCoreV2/, 'the early shell must not reconstruct a legacy World from bootstrap projections');
assert.doesNotMatch(firstLoad, /nora-deferred-core|__NORA_DEFERRED_CORE_PROMISE__/, 'Nora must not retain a legacy UI hydration phase');
assert.doesNotMatch(firstLoad, /noraRuntimeReadyPromise\.then\(\(\) => timedBootStep\('(?:locales|system-messages|user-avatars|personas)'/, 'Nora must not initialize removed ST UI after becoming usable');
assert.match(firstLoad, /waitForNoraRuntimeReady\(\)[\s\S]*?activateCritical/, 'extension activation must start after the Nora UI is initialized, including empty workspaces');
assert.doesNotMatch(index, /characters\.slice\(0, 3\)/, 'startup must not download arbitrary full character cards');
assert.doesNotMatch(index, /recentAvatars/, 'startup must not prefetch every recent World card');
assert.doesNotMatch(script, /globalThis\.__NORA_(?:CHAT|CHARACTER)_PROMISES__/, 'ST loading must not retain dead legacy bootstrap prefetch branches');
for (const retiredStartupRequest of [
    'fetch(' + singleQuote + '/csrf-token' + singleQuote + ')',
    'fetch(' + singleQuote + '/api/characters/all' + singleQuote,
    'fetch(' + singleQuote + '/api/chats/recent' + singleQuote,
]) {
    assert.doesNotMatch(index, new RegExp(retiredStartupRequest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `early startup must not issue ${retiredStartupRequest}`);
}
assert.match(bootEndpoint, /router\.get\('\/bootstrap'/, 'backend must expose one read-only Nora bootstrap route');

console.log('nora-critical-startup-contract=PASS');
