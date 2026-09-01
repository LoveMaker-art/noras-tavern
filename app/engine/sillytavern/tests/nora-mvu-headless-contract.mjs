import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const extensionRoot = path.join(root, 'native-extensions/nora-mvu');
const read = relative => fs.readFileSync(path.join(extensionRoot, relative), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const bundle = read('vendor/bundle.js');
const upstream = read('UPSTREAM.md');
const lifecycle = fs.readFileSync(path.join(root, 'native_lifecycle.py'), 'utf8');
const script = fs.readFileSync(path.join(root, 'engine/sillytavern/public/script.js'), 'utf8');
const extensions = fs.readFileSync(path.join(root, 'engine/sillytavern/public/scripts/extensions.js'), 'utf8');
const cardAdapter = fs.readFileSync(path.join(root, 'engine/sillytavern/public/scripts/nora-adapters/st-card-adapter.js'), 'utf8');
const mvuCompatibility = fs.readFileSync(path.join(root, 'engine/sillytavern/public/scripts/nora-compat/mvu-compatibility.js'), 'utf8');
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

assert.equal(
    manifest.loading_order < helperManifest.loading_order,
    true,
    'MVU must register its managed script before TavernHelper executes the script tree',
);
assert.deepEqual(manifest.dependencies, ['third-party/JS-Slash-Runner']);
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
assert.match(bundle, /reloadSettings/, 'vendored runtime must expose the headless settings reload bridge');
assert.match(upstream, /0a730cd4a9b99689d1135a49b542c780b977c24c/);
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
assert.match(mvuCompatibility, /MagicalAstrogy\\\/MagVarUpdate/);
assert.match(cardAdapter, /__NORA_ENSURE_MVU_READY__/);
assert.match(
    worldCoreRuntime,
    /executeSnapshot\(snapshot, runtime, \{ measure \}\)[\s\S]*ensureCapabilities/,
    'World Core Runtime must keep base activation separate from capability readiness',
);
assert.match(
    worldController,
    /if \(initialWorld\.active\)[\s\S]*worldRuntime\.ensureReady\(initialWorld\.id\)[\s\S]*return;/,
    'restoring an already-active World must delegate readiness to World Runtime',
);
assert.doesNotMatch(worldController, /runtime\.(?:prepareCharacterRuntime|waitForCharacterRuntime|ensureCharacterRuntime)/);
assert.equal(fs.existsSync(helperTailwind), true, 'the managed card runtime must include its Tailwind browser asset');
assert.equal(
    createHash('sha256').update(fs.readFileSync(helperTailwind)).digest('hex'),
    '3573a896869009f2ab0ea9870ba0279cb8bda0dd45d710a83950367d19ee7ea9',
    'the Tailwind browser asset must match JS-Slash-Runner 4.9.3',
);
assert.equal(fs.existsSync(path.join(helperRoot, 'lib/tailwindcss.LICENSE')), true, 'the Tailwind browser license must ship with the asset');
assert.equal(helperManifest.auto_update, false, 'the managed helper must not overwrite Nora local dependency redirects');
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

console.log('nora-mvu-headless-contract=PASS');
