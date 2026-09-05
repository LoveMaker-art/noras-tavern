import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const extensionRoot = path.join(root, 'native-extensions/nora-mvu');
const read = relative => fs.readFileSync(path.join(extensionRoot, relative), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const runtime = read('runtime.js');
const bundle = read('vendor/bundle.js');
const noraPatch = read('upstream/nora.patch');
const slashRunnerPatch = read('upstream/slash-runner.patch');
const vendorBuilder = read('build-vendor.sh');
const zodRuntime = read('vendor/zod.iife.js');
const schemaRuntime = read('mvu-zod.js');
const upstream = read('UPSTREAM.md');
const lifecycle = fs.readFileSync(path.join(root, 'native_lifecycle.py'), 'utf8');
const script = fs.readFileSync(path.join(root, 'engine/sillytavern/public/script.js'), 'utf8');
const extensions = fs.readFileSync(path.join(root, 'engine/sillytavern/public/scripts/extensions.js'), 'utf8');
const cardAdapter = fs.readFileSync(path.join(root, 'engine/sillytavern/public/scripts/nora-adapters/st-card-adapter.js'), 'utf8');
const mvuCompatibility = fs.readFileSync(path.join(root, 'engine/sillytavern/public/scripts/nora-compat/mvu-compatibility.js'), 'utf8');
const mvuWorldInfoPolicy = fs.readFileSync(path.join(root, 'engine/sillytavern/public/scripts/nora-compat/mvu-world-info-policy.js'), 'utf8');
const worldInfo = fs.readFileSync(path.join(root, 'engine/sillytavern/public/scripts/world-info.js'), 'utf8');
const worldController = fs.readFileSync(path.join(root, 'native-extensions/nora-ui/world-controller.js'), 'utf8');
const worldCoreRuntime = fs.readFileSync(path.join(root, 'engine/sillytavern/public/scripts/nora-worlds/world-core-runtime.js'), 'utf8');
const helperRoot = path.join(root, 'native-extensions/JS-Slash-Runner');
const helperBundle = fs.readFileSync(path.join(helperRoot, 'dist/index.js'), 'utf8');
const helperManifest = JSON.parse(fs.readFileSync(path.join(helperRoot, 'manifest.json'), 'utf8'));
const helperTailwind = path.join(helperRoot, 'lib/tailwindcss.min.js');
const iframeVendorRoot = path.join(helperRoot, 'vendor/iframe');
const modelController = fs.readFileSync(path.join(root, 'native-extensions/nora-ui/model-controller.js'), 'utf8');
const modelAdapter = fs.readFileSync(path.join(root, 'native-extensions/nora-ui/mvu-model-adapter.js'), 'utf8');
const uiEntry = fs.readFileSync(path.join(root, 'native-extensions/nora-ui/index.js'), 'utf8');
const mvuModelEndpoint = fs.readFileSync(path.join(root, 'engine/sillytavern/src/endpoints/nora-mvu-model.js'), 'utf8');
const mvuModelConfig = fs.readFileSync(path.join(root, 'engine/sillytavern/src/nora-mvu-model-config.js'), 'utf8');
const mvuDiagnosticsEndpoint = fs.readFileSync(path.join(root, 'engine/sillytavern/src/endpoints/nora-mvu-diagnostics.js'), 'utf8');
const mvuUpdateObserver = fs.readFileSync(path.join(root, 'native-extensions/nora-mvu/update-observer.js'), 'utf8');

assert.deepEqual(manifest.dependencies, ['third-party/JS-Slash-Runner']);
assert.equal(
    manifest.loading_order < helperManifest.loading_order,
    true,
    'MVU must prepare its managed script and local dependencies before Helper executes the script tree',
);
assert.equal(manifest.css, undefined, 'headless MVU must not add a settings stylesheet');
assert.doesNotMatch(bundle, /extensions_settings2|initPanel\(/, 'vendored runtime must not mount the ST settings panel');
assert.match(
    bundle,
    /null==SillyTavern\.getCurrentChatId\(\)\|\|0===SillyTavern\.chat\.length\)return/,
    'headless MVU must treat an empty startup as a waiting state',
);
assert.doesNotMatch(
    bundle,
    /0===SillyTavern\.chat\.length\)return console\.error\([^;]+toastr\.error/,
    'headless MVU must not report an empty startup as an initialization failure',
);
assert.doesNotMatch(bundle, /https:\/\/testingcf\.jsdelivr\.net|module-import\s+https?:\/\//, 'MVU runtime dependencies must be bundled locally');
assert.match(runtime, /new URL\('\$\{MVU_BUNDLE_URL\}', window\.parent\.location\.href\)/, 'Nora MVU must resolve its local bundle against the parent page from an about:srcdoc iframe');
assert.match(runtime, /NORA_MVU_BUNDLE_REVISION/, 'Nora MVU bundle changes must own an independent cache revision');
assert.match(runtime, /await import\(mvuBundleUrl\)/, 'Nora MVU must execute inside a managed Helper script iframe');
assert.match(runtime, /vendor\/zod\.iife\.js\?v=4\.1\.11/, 'Nora MVU must load its pinned Zod runtime locally');
assert.doesNotMatch(runtime, /testingcf\.jsdelivr\.net|cdn\.jsdelivr\.net/, 'Nora MVU bootstrap must not load dependencies from the network');
assert.match(zodRuntime, /var Zod=/, 'the local Zod runtime must expose its browser namespace');
assert.match(zodRuntime, /looseObject/, 'the local Zod runtime must provide the Zod 4 API required by MVU');
assert.doesNotMatch(runtime, /loadBundle\s*=|import\(resolveMvuBundleUrl/, 'Nora MVU must not execute its Helper-only bundle in the parent page');
assert.match(schemaRuntime, /export function registerMvuSchema/);
assert.doesNotMatch(schemaRuntime, /https?:\/\/|^\s*import\b/m, 'MVU schema runtime must not fetch or import external code');
assert.match(bundle, /reloadSettings/, 'vendored runtime must expose the headless settings reload bridge');
assert.match(bundle, /MVU_COMMAND_VALIDATION_FAILED/, 'vendored runtime must classify update validation failures');
assert.match(bundle, /MVU_EXTRA_MODEL_TIMEOUT/, 'vendored runtime must classify bounded request timeouts');
assert.match(bundle, /nora-mvu\/1/, 'vendored runtime must contain Nora MVU protocol v1');
assert.match(noraPatch, /const EXTRA_MODEL_ATTEMPT_TIMEOUT_MS = 120_000;/, 'each MVU model attempt must receive the full observed provider budget');
assert.doesNotMatch(noraPatch, /PRIMARY_ATTEMPT_BUDGET_MS|TRANSACTION_BUDGET_MS/, 'MVU must not split one request budget into guaranteed-short retries');
assert.match(noraPatch, /if \(!\['parsing', 'validation'\]\.includes\(failure\.stage\)\) break;/, 'MVU transport failures must not trigger an overlapping paid retry');
assert.match(noraPatch, /let task = decoded_extra_model_task;/, 'extra-model MVU must preserve the card/upstream variable update dialect');
assert.match(noraPatch, /NORA_MVU_PROTOCOL\s*=\s*'nora-mvu\/1'/, 'the source patch must define one versioned Nora MVU protocol');
assert.match(noraPatch, /NORA_MVU_RESPONSE_SCHEMA/, 'the source patch must provide a request-time schema for Nora MVU v1');
assert.match(noraPatch, /use_nora_protocol \? NORA_MVU_TOOL_DEFINITION : MVU_TOOL_DEFINITION/, 'tool calling must select the Nora schema only for declared v1 cards');
assert.match(noraPatch, /nora_extraction\.matched[\s\S]{0,120}nora_extraction\.commands[\s\S]{0,120}extractCommands/, 'Nora v1 and legacy extraction must remain separate compatible paths');
assert.match(noraPatch, /Object\.assign\(variables, klona\(variables_before_update\)\)/, 'any rejected command batch must restore the complete previous variable snapshot');
assert.doesNotMatch(
    noraPatch,
    /You are a deterministic state-transition processor|Return exactly one block in this structure|Never omit the <JSONPatch> wrapper/,
    'Nora must not force a JSONPatch-only contract onto every extra-model request',
);
assert.match(noraPatch, /const explicit_noop = \/<JSONPatch>/, 'an empty JSONPatch can still be accepted when a card emits JSONPatch');
assert.match(noraPatch, /replaceUnresolvedStateBlocks/, 'the source patch must replace unresolved card state templates at the MVU prompt boundary');
assert.match(noraPatch, /<status_current_variables>/, 'the MVU request must carry an authoritative current-state block');
assert.match(noraPatch, /getLastValidVariable/, 'the authoritative prompt state must come from the same snapshot store used for commit');
assert.match(noraPatch, /模型来源 === '自定义'[\s\S]{0,100}关闭thinking/, 'follow-text MVU requests must inherit the active text model thinking behavior');
assert.doesNotMatch(noraPatch, /generation_id,[\s\S]{0,120}max_tokens:/, 'story-model MVU requests must inherit the active text-model output limit');
assert.match(noraPatch, /config\.custom_api = \{[\s\S]{0,120}\+\s*max_context:/, 'MVU must pass its independent context limit into the custom model request');
assert.match(slashRunnerPatch, /config\.custom_api\?\.max_context[\s\S]{0,160}config\.custom_api\?\.max_tokens/, 'independent MVU models must retain their own context and output limits');
assert.match(slashRunnerPatch, /chatCompletion\.setTokenBudget\(maxContext, maxOutput\)/, 'the pinned Slash Runner must apply independent MVU token limits');
assert.match(slashRunnerPatch, /authorNoteOverride[\s\S]{0,160}\?\? ''/, 'the pinned Slash Runner must normalize a missing headless author note to an empty string');
for (const promptField of ['persona_description', 'char_description', 'world_info_before', 'world_info_after', 'chat_history']) {
    assert.match(bundle, new RegExp(promptField), `Nora MVU bundle must preserve the ${promptField} prompt field`);
}
assert.doesNotMatch(helperBundle, /p=wt\.new_chat_prompt,m=await yt\.createAsync\(`system`,Re\(p\),`newMainChat`\);n\.reserveBudget\(m\),f\.add\(m\)/, 'the shipped Helper runtime must not inject a missing new-chat prompt');
assert.match(helperBundle, /typeof wt\.new_chat_prompt==`string`[\s\S]{0,180}newMainChat[\s\S]{0,100}m&&\(n\.reserveBudget\(m\),f\.add\(m\)\)/, 'the shipped Helper runtime must guard its optional new-chat prompt');
assert.doesNotMatch(helperBundle, /e\?\.overrides\?\.author_note\?\?\$\(`#extension_floating_prompt`\)\.val\(\);/, 'the shipped Helper runtime must not pass an absent author note into ST prompt aggregation');
assert.match(vendorBuilder, /bundle\.js\.LICENSE\.txt/, 'the reproducible build must preserve the generated third-party license companion');
assert.doesNotMatch(bundle, /sourceMappingURL=bundle\.js\.map/, 'the release bundle must not reference an omitted source map');
assert.equal(fs.existsSync(path.join(extensionRoot, 'vendor/bundle.js.LICENSE.txt')), true, 'the generated third-party license companion must ship with the bundle');
assert.match(upstream, /7fe9ae7cfe01f13d606f7a2e533a458431fe318c/);
assert.match(upstream, /MIT/);
assert.match(upstream, /dependencies are bundled locally/i);
assert.match(lifecycle, /MANAGED_EXTENSIONS\s*=\s*\([\s\S]*?["']nora-mvu["']/);
assert.match(script, /criticalExtensionNames\s*=\s*\[['"]regex['"]\]/);
assert.doesNotMatch(script, /timedBootStep\(['"]mvu-runtime['"]/, 'MVU must not block ordinary-card startup');
assert.match(extensions, /NORA_PRODUCT_DEFERRED_EXTENSIONS[\s\S]*third-party\/JS-Slash-Runner[\s\S]*third-party\/nora-mvu/);
assert.match(cardAdapter, /inspectCharacterRuntime/);
assert.match(cardAdapter, /inspectMvuCompatibility/);
assert.match(mvuCompatibility, /INIT_COMMENT_MARKER\s*=\s*\/\\\[initvar\\\]\/i/);
assert.match(mvuCompatibility, /UPDATE_COMMENT_MARKER\s*=\s*\/\\\[mvu_update\\\]\/i/);
assert.match(mvuCompatibility, /PLOT_COMMENT_MARKER\s*=\s*\/\\\[mvu_plot\\\]\/i/);
assert.match(mvuCompatibility, /NORA_V1_COMMENT_MARKER/);
assert.match(mvuCompatibility, /MagicalAstrogy\\\/MagVarUpdate/);
assert.match(mvuWorldInfoPolicy, /NORA_MVU_V1_PROMPT/);
assert.match(mvuWorldInfoPolicy, /projectNoraMvuUpdateContent/);
assert.match(worldInfo, /projectNoraMvuUpdateContent\(entry, entry\.content\)/, 'Nora v1 instructions must be projected into active world-info prompts without mutating the card');
assert.match(schemaRuntime, /let candidate = clone\(variables\.stat_data\)/, 'Zod updates must execute against one batch candidate');
assert.match(schemaRuntime, /schema\.safeParse\(candidate[\s\S]{0,160}if \(parsed\.success\)[\s\S]{0,120}variables\.stat_data = parsed\.data/, 'Zod updates must commit only after the whole batch validates');
assert.match(cardAdapter, /__NORA_ENSURE_MVU_READY__/);
assert.match(
    worldCoreRuntime,
    /executeSnapshot\(snapshot, runtime, \{ measure \}\)[\s\S]*ensureCapabilities/,
    'World Core Runtime must keep base activation separate from capability readiness',
);
assert.match(
    worldController,
    /worldRuntime\.activate\(current\.id\)[\s\S]*scheduleSupportingContent\(current, current\.interactionId\)/,
    'an explicitly selected World must activate its base runtime before loading MVU and other supporting capabilities',
);
assert.doesNotMatch(worldController, /async function openInitial\(/, 'MVU readiness must not force an automatic World activation during Tavern startup');
assert.doesNotMatch(worldController, /runtime\.(?:prepareCharacterRuntime|waitForCharacterRuntime|ensureCharacterRuntime)/);
assert.equal(fs.existsSync(helperTailwind), true, 'the managed card runtime must include its Tailwind browser asset');
assert.equal(
    createHash('sha256').update(fs.readFileSync(helperTailwind)).digest('hex'),
    '3573a896869009f2ab0ea9870ba0279cb8bda0dd45d710a83950367d19ee7ea9',
    'the Tailwind browser asset must match JS-Slash-Runner 4.9.3',
);
assert.equal(fs.existsSync(path.join(helperRoot, 'lib/tailwindcss.LICENSE')), true, 'the Tailwind browser license must ship with the asset');
assert.equal(helperManifest.auto_update, false, 'the managed helper must not overwrite Nora local dependency redirects');
assert.match(
    helperBundle,
    /synchronizeHelperRuntimeReadiness\(MF\(\)\)/,
    'late-loaded TavernHelper must initialize its script host from Nora application readiness',
);
assert.doesNotMatch(
    helperBundle,
    /https:\/\/testingcf\.jsdelivr\.net\/(?:npm\/(?:vue|vue-router|jquery(?:-ui)?(?:-touch-punch)?|@fortawesome\/fontawesome-free)|gh\/N0VI028\/JS-Slash-Runner\/src\/iframe\/node_modules\/log\.js)/,
    'the managed script host must not depend on the CDN for its framework-owned iframe runtime',
);
for (const dependency of [
    'vue.runtime.global.prod.min.js',
    'vue-router.global.prod.min.js',
    'log.js',
    'jquery-3.5.1.min.js',
    'jquery-ui/jquery-ui-1.13.2.min.js',
    'jquery-ui/jquery-ui-1.13.2.min.css',
    'jquery-ui-touch-punch-1.0.9.min.js',
    'fontawesome/css/all.min.css',
]) {
    assert.equal(fs.existsSync(path.join(iframeVendorRoot, dependency)), true, `missing local iframe dependency: ${dependency}`);
    assert.match(helperBundle, new RegExp(`/scripts/extensions/third-party/JS-Slash-Runner/vendor/iframe/${dependency.replaceAll('.', '\\.')}`));
}
for (const dependency of [
    'jquery.LICENSE',
    'jquery-ui/LICENSE.txt',
    'fontawesome/LICENSE.txt',
    ...['444444', '555555', '777620', '777777', 'cc0000', 'ffffff']
        .map(color => `jquery-ui/images/ui-icons_${color}_256x240.png`),
    ...['brands-400', 'regular-400', 'solid-900', 'v4compatibility']
        .flatMap(name => [`fontawesome/webfonts/fa-${name}.ttf`, `fontawesome/webfonts/fa-${name}.woff2`]),
]) {
    assert.equal(fs.existsSync(path.join(iframeVendorRoot, dependency)), true, `missing iframe dependency asset: ${dependency}`);
}

assert.match(modelController, /MVU 变量模型/);
assert.match(modelController, /data-mvu-model-slot/);
assert.match(modelController, /data-mvu-enabled/);
assert.match(modelController, /data-mvu-source="independent"/);
assert.match(modelController, /activeWorldModel\(\)\?\.capabilities/, 'MVU model UI must read capabilities from the active World Read Model');
assert.doesNotMatch(modelController, /readState\(\)\.activeWorld/, 'the ST runtime snapshot does not own active World capabilities');
assert.match(uiEntry, /createModelController\(\{[\s\S]*?activeWorldModel,[\s\S]*?mvu:/, 'the Nora UI composition root must inject the active World Read Model');
assert.match(uiEntry, /controlApi:\s*mvu/, 'the Nora UI must receive MVU settings commands through the named Story domain');
assert.match(modelAdapter, /inspectCurrentCard/);
assert.match(modelAdapter, /\/api\/nora-mvu-model\/\$\{path\}/);
assert.match(mvuModelEndpoint, /SECRET_KEYS\.NORA_MVU/);
assert.doesNotMatch(mvuModelConfig, /api_key\s*:/, 'the non-secret MVU config file must never own an API key');
assert.match(mvuDiagnosticsEndpoint, /mvuDiagnosticStore\.append/);
assert.match(mvuUpdateObserver, /reportMvuDiagnostic|report\(diagnostic\)/);
assert.match(mvuUpdateObserver, /const stateChanged = detail\.diagnostics\?\.modified \?\? committedCommandCount > 0/, 'committed updates must derive their state-change result from MVU diagnostics');
assert.match(mvuUpdateObserver, /updatePhase: stateChanged \? 'completed' : 'no-change'/, 'committed no-op updates must not be reported as completed state changes');
assert.match(mvuUpdateObserver, /lastUpdateCode: stateChanged \? null : 'MVU_NO_STATE_CHANGE'/, 'committed no-op updates must expose a stable diagnostic code');

console.log('nora-mvu-headless-contract=PASS');
