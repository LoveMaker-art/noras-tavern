import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const [htmlPath, noraUiPath] = process.argv.slice(2);
if (!htmlPath || !noraUiPath) {
    throw new Error('Usage: node nora-ui-shell-contract.mjs <index.html> <nora-ui-index.js>');
}

const stRoot = process.env.ST_ROOT || path.resolve(path.dirname(htmlPath), '..');
const require = createRequire(path.join(stRoot, 'package.json'));
const { load } = require('cheerio');
const html = fs.readFileSync(htmlPath, 'utf8');
const noraUi = fs.readFileSync(noraUiPath, 'utf8');
const noraUiRoot = path.dirname(noraUiPath);
const noraCss = fs.readFileSync(path.join(noraUiRoot, 'style.css'), 'utf8');
const dialogController = fs.readFileSync(path.join(noraUiRoot, 'dialog-controller.js'), 'utf8');
const modelController = fs.readFileSync(path.join(noraUiRoot, 'model-controller.js'), 'utf8');
const characterController = fs.readFileSync(path.join(noraUiRoot, 'character-controller.js'), 'utf8');
const worldbookController = fs.readFileSync(path.join(noraUiRoot, 'worldbook-controller.js'), 'utf8');
const activationLifecycle = fs.readFileSync(path.join(noraUiRoot, 'activation-lifecycle.js'), 'utf8');
const messageViewAdapter = fs.readFileSync(path.join(noraUiRoot, 'st-message-view-adapter.js'), 'utf8');
const messageController = fs.readFileSync(path.join(noraUiRoot, 'message-controller.js'), 'utf8');
const worldController = fs.readFileSync(path.join(noraUiRoot, 'world-controller.js'), 'utf8');
const capabilityController = fs.readFileSync(path.join(noraUiRoot, 'card-capability-controller.js'), 'utf8');
const worldCreationController = fs.readFileSync(path.join(noraUiRoot, 'world-creation-controller.js'), 'utf8');
const panelController = fs.readFileSync(path.join(noraUiRoot, 'panel-controller.js'), 'utf8');
const shellController = fs.readFileSync(path.join(noraUiRoot, 'shell-controller.js'), 'utf8');
const startupController = fs.readFileSync(path.join(noraUiRoot, 'startup-controller.js'), 'utf8');
const runtimeAdapter = fs.readFileSync(path.join(stRoot, 'public/scripts/nora-adapters/st-runtime-adapter.js'), 'utf8');
const messageAdapter = fs.readFileSync(path.join(stRoot, 'public/scripts/nora-adapters/st-message-adapter.js'), 'utf8');
const cardAdapter = fs.readFileSync(path.join(stRoot, 'public/scripts/nora-adapters/st-card-adapter.js'), 'utf8');
const worldbookAdapter = fs.readFileSync(path.join(stRoot, 'public/scripts/nora-adapters/st-worldbook-adapter.js'), 'utf8');
const modelAdapter = fs.readFileSync(path.join(stRoot, 'public/scripts/nora-adapters/st-model-adapter.js'), 'utf8');
const worldRuntime = fs.readFileSync(path.join(stRoot, 'public/scripts/nora-worlds/world-core-runtime.js'), 'utf8');
const noraEntry = fs.readFileSync(path.join(stRoot, 'public/nora-entry.js'), 'utf8');
const noraRuntime = fs.readFileSync(path.join(stRoot, 'public/scripts/nora-runtime/index.js'), 'utf8');
const noraManifest = JSON.parse(fs.readFileSync(path.join(noraUiRoot, 'manifest.json'), 'utf8'));
const $ = load(html);

if (!/#nora-panel-toggle\s*\{[^}]*margin-left:\s*auto;[^}]*\}/s.test(noraCss)) {
    throw new Error('The responsive right-panel toggle must stay anchored to the right when the left toggle is hidden.');
}
if (!/#nora-panel-toggle\s*\{[^}]*margin-left:\s*auto;[^}]*\}/s.test(html)) {
    throw new Error('The early shell must keep the right-panel toggle anchored before the full Nora stylesheet loads.');
}

for (const manualVersionedAsset of [
    '/dist/nora/entry.js?v=',
    '/scripts/extensions/third-party/nora-ui/index.js?v=',
    '/scripts/extensions/third-party/nora-ui/style.css?v=',
]) {
    if (html.includes(manualVersionedAsset)) throw new Error(`Nora assets must rely on no-store delivery instead of manual cache versions: ${manualVersionedAsset}`);
}
if (/nora-runtime\/index\.js\?v=/.test(noraEntry) || /NORA_UI_URL\s*=\s*[^;]+\?v=/.test(noraRuntime) || [noraManifest.js, noraManifest.css].some((value) => String(value).includes('?v='))) {
    throw new Error('Nora runtime and extension assets must not require manual cache-version edits.');
}

function getNamedFunction(source, name) {
    const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\b`).exec(source);
    if (!match) throw new Error(`Nora UI must define ${name}.`);
    const openBrace = source.indexOf('{', match.index);
    let depth = 0;
    for (let index = openBrace; index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}' && --depth === 0) return source.slice(match.index, index + 1);
    }
    throw new Error(`Nora UI has an unterminated ${name}.`);
}

const bodyClasses = new Set(($('body').attr('class') || '').split(/\s+/).filter(Boolean));
if (!bodyClasses.has('nora-booting')) {
    throw new Error('Nora must suppress incomplete UI during the initial paint.');
}

for (const criticalSignal of [
    'body.nora-booting #nora-layout > *',
    'body.nora-booting #nora-boot-buffer',
    'body.nora-world-opening #nora-world-buffer',
    'body.nora-world-opening #nora-empty',
    '@media (prefers-reduced-motion: reduce)',
    '.nora-empty.hidden',
    'body.nora-product > #sheld',
]) {
    if (!html.includes(criticalSignal)) {
        throw new Error(`Nora critical CSS must prevent first-paint UI leakage: ${criticalSignal}`);
    }
}

const prepareShell = getNamedFunction(shellController, 'prepareShell');
if (prepareShell.includes('finishBootScreen()')) {
    throw new Error('Preparing the early shell must not reveal it before World activation.');
}

const finishBootScreen = getNamedFunction(noraUi, 'finishBootScreen');
if (!finishBootScreen.includes("classList.remove('nora-booting')")) {
    throw new Error('The completed World activation must reveal the Nora UI.');
}

const failEarlyShell = getNamedFunction(html, 'failEarlyShell');
for (const signal of ["classList.add('nora-boot-failed')", 'retry.hidden = false', "name: 'shell-bootstrap-failed'"]) {
    if (!failEarlyShell.includes(signal)) throw new Error(`A failed bootstrap must expose a recoverable error: ${signal}`);
}
if ($('#nora-boot-retry').length !== 1 || !$('#nora-boot-retry').prop('hidden')) {
    throw new Error('The boot buffer must contain one initially hidden retry control.');
}
if (html.includes('revealEarlyShell(data)')) {
    throw new Error('Fresh World metadata must not expose a shell that is not yet genuinely usable.');
}

const finalizeUi = getNamedFunction(startupController, 'finalizeUi');
if (!finalizeUi.includes('finishBootScreen()') || !finalizeUi.includes("classList.add('nora-app-ready')") || finalizeUi.includes('nora-runtime-ready')) {
    throw new Error('Nora must reveal the application shell without claiming that World-dependent runtime work is ready.');
}
const markRuntimeReady = getNamedFunction(startupController, 'markRuntimeReady');
if (!markRuntimeReady.includes("classList.add('nora-runtime-ready')") || !markRuntimeReady.includes("new Event('nora:runtime-ready')")) {
    throw new Error('Nora must retain one explicit runtime-ready transition for compatibility extensions.');
}
const reportWorldUsable = getNamedFunction(startupController, 'reportWorldUsable');
if (!/if \(activeWorld && messagesReady && composerEnabled\) \{[\s\S]*dispatchEvent\(new Event\('nora:usable'\)\)[\s\S]*\} else \{/.test(reportWorldUsable)) {
    throw new Error('Nora must emit its usable event only after the active World, messages, and composer are usable.');
}
if (!finishBootScreen.includes("name: 'shell-visible'")) {
    throw new Error('The shell-visible metric must represent the genuinely hydrated UI.');
}
if (!/attempt = runHydration\(\)[\s\S]*transition\('finalizing'\)[\s\S]*return finalize\(\)/.test(activationLifecycle)) {
    throw new Error('Final runtime activation must wait for the shared UI hydration run.');
}
if (!activationLifecycle.includes('mount: runMount') || !activationLifecycle.includes("state: () => currentState")) {
    throw new Error('Nora startup must expose one explicit, observable mount-to-ready lifecycle.');
}
if (startupController.includes('setInterval(') || startupController.includes('readinessTimer')) {
    throw new Error('Nora startup must be driven by runtime readiness instead of polling character state.');
}
const startUi = getNamedFunction(startupController, 'start');
if (startUi.indexOf('activation.mount()') > startUi.indexOf('state.whenReady()')) {
    throw new Error('Nora must bind its shell before waiting for the compatibility runtime to become ready.');
}

const requiredShellIds = [
    'nora-boot-buffer',
    'nora-world-buffer',
    'nora-world-buffer-title',
    'nora-rail-toggle',
    'nora-panel-toggle',
    'nora-scrim',
    'nora-new-world',
    'nora-composer',
    'nora-composer-notice',
    'nora-toast',
    'nora-input',
    'nora-action',
    'nora-character-import',
    'nora-chat',
    'nora-world-list',
];

const missing = requiredShellIds.filter((id) => $(`#${id}`).length !== 1);
if (missing.length) {
    throw new Error(`Nora early shell is missing required event nodes: ${missing.join(', ')}`);
}

const bootBuffer = $('#nora-boot-buffer');
const worldBuffer = $('#nora-world-buffer');
if (bootBuffer.find('img').length || worldBuffer.find('img').length) {
    throw new Error('Nora buffers must use the typographic mark without image assets.');
}
if (!bootBuffer.text().includes('tavern') || !bootBuffer.text().includes('故事即将开始') || !worldBuffer.text().includes('正在进入这个世界')) {
    throw new Error('Initial and World buffers must expose the shared Nora loading language.');
}
if (!html.includes('animation: nora-buffer-reveal 1ms linear 120ms forwards')) {
    throw new Error('World buffer must wait 120ms before appearing to avoid short-operation flashes.');
}
const queueWorldSelection = getNamedFunction(worldController, 'queueSelection');
for (const signal of ['current.name || tr("正在进入世界")', 'current.showBuffer !== false', "setAttribute('aria-hidden', 'false')", "setAttribute('aria-hidden', 'true')", 'void stopFollowingLatest()']) {
    if (!queueWorldSelection.includes(signal)) throw new Error(`World buffer lifecycle is incomplete: ${signal}`);
}
if (queueWorldSelection.includes('.critical-extensions') || queueWorldSelection.includes('__NORA_CRITICAL_EXTENSIONS_PROMISE__')) {
    throw new Error('World activation must not wait for compatibility extensions before exposing the real chat.');
}
if (queueWorldSelection.includes('await stopFollowingLatest()')) {
    throw new Error('World switching must not keep the loading buffer open while rich-card layout observers settle.');
}
const openInitialWorld = getNamedFunction(worldController, 'openInitial');
if (!openInitialWorld.includes('showBuffer: true')) {
    throw new Error('Initial World restoration must expose the World loading state after the application shell becomes ready.');
}

const headlessExtensionHost = $('#extensions_settings');
if (headlessExtensionHost.length !== 1 || !headlessExtensionHost.prop('hidden') || !headlessExtensionHost.hasClass('nora-headless-extension-host')) {
    throw new Error('Nora must preserve one hidden extension host for compatibility runtimes without restoring the ST settings UI.');
}

for (const removedLegacySurface of ['#character_context_menu', '#nora-character-runtime', '#rightNavHolder', '#options', '#options_button', '#send_but', '#mes_stop']) {
    if ($(removedLegacySurface).length) {
        throw new Error(`Nora must physically remove the legacy ST surface: ${removedLegacySurface}`);
    }
}

const headlessChatHost = $('#sheld.nora-headless-chat-host');
if (headlessChatHost.length !== 1 || !headlessChatHost.prop('hidden') || $('#chat', headlessChatHost).length !== 1 || $('#send_textarea', headlessChatHost).length !== 1) {
    throw new Error('Nora must preserve only the minimal hidden ST chat runtime required by generation and complex-card macros.');
}

if (!$('#nora-send').prop('disabled')) {
    throw new Error('The empty early-shell send button must be disabled.');
}

if (!/function ensureLayoutContract\(layout\)/.test(shellController)) {
    throw new Error('Nora UI must repair an existing early shell before binding events.');
}

const bindLayoutEvents = getNamedFunction(shellController, 'bindLayoutEvents');
if (!bindLayoutEvents.includes("select('#nora-chat').addEventListener('click', handlers.handleMessageAction, { capture: true })")) {
    throw new Error('Nora message actions must be captured before the hidden ST chat runtime can stop click propagation.');
}

if (/recentChats|messageCount\s*<\s*2/.test(worldRuntime)) {
    throw new Error('The World runtime must not infer product Worlds from recent-chat heuristics.');
}

if (!/worldRuntime\.activate\(current\.id\)/.test(worldController)) {
    throw new Error('Nora UI must activate Worlds through the transactional World runtime.');
}

for (const privateBinding of ['data-character=', 'data-chat=']) {
    if (worldController.includes(privateBinding)) throw new Error(`World DOM must not expose an ST binding: ${privateBinding}`);
}
if (!html.includes('#nora-chat .mes:not([data-nora-reasoning-ready="true"]) .mes_reasoning_details')) {
    throw new Error('Critical CSS must suppress undecorated native reasoning before the Nora message view is ready.');
}
if (!html.includes('#nora-chat .mes_buttons') || !html.includes('#nora-chat .mes_edit_buttons')) {
    throw new Error('Critical CSS must suppress native message controls before the deferred Nora stylesheet loads.');
}

for (const signal of ['const showToast = (message, options) => dialogs.toast(message, options);', 'const confirmAction = (options) => dialogs.confirm(options);', '__NORA_CONFIRM_CHARACTER_REGEX__']) {
    if (!noraUi.includes(signal)) throw new Error(`Nora must own the product message surface: ${signal}`);
}
for (const signal of ['dialogs.notice({', 'function showSendError(']) {
    if (!messageController.includes(signal)) throw new Error(`The message controller must own composer errors: ${signal}`);
}
for (const signal of ['function toast(', 'function notice(', 'function confirm(']) {
    if (!dialogController.includes(signal)) throw new Error(`The Nora dialog controller must implement the product message surface: ${signal}`);
}

for (const signal of ['data-delete-world', 'async function deleteWorld(', 'worldRuntime.remove(worldId)', 'confirmAction({', "tone: 'danger'"]) {
    if (!worldController.includes(signal)) throw new Error(`World deletion must use the v2 World Runtime command: ${signal}`);
}

for (const signal of [
    'function capabilities(',
    'async function prompt(',
    'promptPromises',
    '角色卡增强',
    '界面显示、变量更新和剧情运行',
]) {
    if (!capabilityController.includes(signal)) throw new Error(`Complex-card capabilities must use Nora authorization: ${signal}`);
}
for (const signal of ['__NORA_CONFIRM_CHARACTER_CAPABILITIES__', '__NORA_CONFIRM_CHARACTER_REGEX__']) {
    if (!noraUi.includes(signal)) throw new Error(`Nora must expose complex-card authorization to compatibility runtimes: ${signal}`);
}

for (const signal of [
    'helper.enabled.characters',
    'current.regex?.allowCharacter?.(character)',
    'markCharacterCapabilitiesPrompted',
    'enableCharacterCapabilities',
]) {
    if (!cardAdapter.includes(signal)) throw new Error(`The ST card adapter must preserve complex-card authorization: ${signal}`);
}

if (!html.includes('<title>Tavern</title>') || !html.includes('{{NORA_ASSET_BASE}}/tavern-icon-dbf4ecbd54ec.png')) {
    throw new Error('The Nora shell must own the page title and content-addressed application icon.');
}

for (const signal of [
    'async function openInitial()',
    'function rememberLastWorld(worldId)',
    'settings.lastWorldId = worldId;',
    'rememberLastWorld(current.id);',
    'const lastWorldId = settingsDomain.uiSettings().lastWorldId;',
    'const lastWorld = worlds.find(world => world.id === lastWorldId);',
    'const activeWorld = worlds.find(world => world.active);',
    'const initialWorld = lastWorld || activeWorld || worlds[0];',
    'if (!lastWorld) rememberLastWorld(initialWorld.id);',
    "interactionId: 'initial-world'",
    'await queueSelection(selection);',
]) {
    if (!worldController.includes(signal)) {
        throw new Error(`Nora UI must restore the last active World and fall back safely on initial load: ${signal}`);
    }
}
const hydrateUi = getNamedFunction(startupController, 'hydrateUi');
const restoreInitialWorld = getNamedFunction(startupController, 'restoreInitialWorld');
if (hydrateUi.includes('openInitialWorld')) {
    throw new Error('Nora shell hydration must not wait for initial World activation.');
}
if (!restoreInitialWorld.includes('await openInitialWorld();')) {
    throw new Error('Nora must restore the initial World after the application shell becomes ready.');
}
if (!restoreInitialWorld.includes('markRuntimeReady();')) {
    throw new Error('Initial World settlement must release runtime prerequisites even when restoration fails.');
}
if (!/activation\.finalize\(\)[\s\S]*restoreInitialWorld\(\)/.test(getNamedFunction(startupController, 'start'))) {
    throw new Error('Initial World restoration must start only after application finalization releases the shell.');
}

const earlyActions = ['profile', 'worldbook', 'model', 'archive'];
const missingEarlyActions = earlyActions.filter((action) => $(`[data-early-action="${action}"]`).length !== 1);
if (missingEarlyActions.length) {
    throw new Error(`Nora early shell has unqueued panel actions: ${missingEarlyActions.join(', ')}`);
}

if (html.includes('声音与 TTS')) {
    throw new Error('Disabled TTS must not appear as a dead early-shell button.');
}

for (const signal of ['pendingAction: null', 'pendingSend: false', "target?.closest('#nora-new-world')", 'state.pendingSend = true']) {
    if (!html.includes(signal)) throw new Error(`Nora early shell is missing interaction queue signal: ${signal}`);
}
if ($('#nora-action').attr('disabled') === undefined || $('#nora-action').attr('aria-haspopup') !== 'menu') {
    throw new Error('The format menu must stay disabled until its real handler is mounted.');
}

for (const signal of ['function consumeEarlyIntent()', 'await consumeEarlyIntent()', "button.disabled = !generating", 'Failed to open world', 'Failed to import a World through World Core v2']) {
    if (!(noraUi + messageController + worldController + worldCreationController + startupController).includes(signal)) throw new Error(`Nora UI is missing click recovery signal: ${signal}`);
}

const newWorldSheet = getNamedFunction(worldCreationController, 'openNewWorldSheet');
for (const signal of ['data-world-kind="blank"', 'data-world-source="local"', 'World Core', 'nora-character-import']) {
    if (!newWorldSheet.includes(signal)) throw new Error(`New World entry is missing its World Core v2 import binding: ${signal}`);
}
for (const removedSignal of ['data-world-source="library"', 'openWorldLibrarySheet', 'activateCreatedWorld', 'worldRuntime.create(']) {
    if (worldCreationController.includes(removedSignal)) throw new Error(`The browser must not retain the legacy World creation transaction: ${removedSignal}`);
}
for (const signal of ['openBlankWorldSheet', 'worldRuntime.createBlank', 'refreshWorldsAfterCommit']) {
    if (!worldCreationController.includes(signal)) throw new Error(`Blank World creation must use the World Core v2 command: ${signal}`);
}

const committedWorldRefresh = getNamedFunction(worldCreationController, 'refreshWorldsAfterCommit');
for (const signal of ['loadWorlds({ force: true })', 'refresh()', '页面刷新失败，请重新载入']) {
    if (!committedWorldRefresh.includes(signal)) throw new Error(`Committed World changes need truthful refresh recovery: ${signal}`);
}

const characterImport = getNamedFunction(worldCreationController, 'handleCharacterImport');
for (const signal of ['worldRuntime.importCard', 'idempotencyKey', 'rememberLastWorld(world.id)', 'refreshWorldsAfterCommit(tr("角色卡已导入"))', 'openWorldById(importedWorldId']) {
    if (!characterImport.includes(signal)) throw new Error(`Character import must use the one World Core v2 transaction: ${signal}`);
}
for (const obsoleteSignal of ['runtime.importCharacter', 'characterController.findDuplicate', 'activateCreatedWorld', 'capabilities.prepare(', 'capabilities.wait(']) {
    if (characterImport.includes(obsoleteSignal)) {
        throw new Error(`Character import UI must delegate Runtime Card readiness to World Runtime: ${obsoleteSignal}`);
    }
}

const characterLibrary = getNamedFunction(characterController, 'openLibrary');
for (const signal of ['角色卡库', 'groups()', 'nora-card-waterfall', '/thumbnail?type=avatar', 'nora-card-library-delete', 'data-library-delete', 'character?.shallow', 'resolveCharacter(characterId)', 'openSheet(characterId, true)', 'deleteGroup']) {
    if (!characterLibrary.includes(signal)) throw new Error(`The character-card library must use imported card artwork: ${signal}`);
}
for (const blockingSignal of ['cards.resolveCharacter', 'for (let index = 0; index < characters.length', 'Promise.all']) {
    if (characterLibrary.includes(blockingSignal)) {
        throw new Error(`Opening the character-card library must not hydrate the complete collection: ${blockingSignal}`);
    }
}
if (characterLibrary.includes('worldRuntime.create')) {
    throw new Error('Browsing the character library must not create a World.');
}

if (((noraUi + characterController + modelController + worldController).match(/nora-delete-button/g) || []).length < 3) {
    throw new Error('All Nora trash-icon actions must share the fixed-size delete-button contract.');
}

const characterSheet = getNamedFunction(characterController, 'openSheet');
for (const signal of ["characterField(character, 'first_mes')", 'worldbookCount', 'nora-character-overview', 'data-back-character-library', 'openLibrary']) {
    if (!characterSheet.includes(signal)) throw new Error(`Character-card details must expose meaningful complex-card information: ${signal}`);
}

const personaSheet = getNamedFunction(panelController, 'openPersona');
if (!personaSheet.includes('worldRuntime.updateActive')) {
    throw new Error('Editing My Character must update the active World Persona.');
}

const characterEditor = getNamedFunction(characterController, 'openEditor');
for (const signal of ['nora-character-form', 'name="name"', 'name="description"', 'name="personality"', 'cards.updateCharacter', 'reloadWorlds()']) {
    if (!characterEditor.includes(signal)) throw new Error(`Resident-character editing must use an editable Nora form: ${signal}`);
}
for (const signal of ['class="nora-form" autocomplete="off"', 'name="name"', 'autocomplete="off"', 'autocorrect="off"', 'spellcheck="false"']) {
    if (!personaSheet.includes(signal)) throw new Error(`My Character must suppress browser test-value suggestions: ${signal}`);
}

const renderPanel = getNamedFunction(panelController, 'render');
for (const signal of ['常驻角色', '世界书', 'worldbookSummary(character, worldbookEditing)', '角色卡库', 'class="pSection', 'pHeadFold', 'pFoldBody', 'librarySupport', 'data-edit-section="cast"', 'data-cast-edit', 'openCharacterEditor', 'data-edit-section="worldbook"', 'data-worldbook-kind', 'data-worldbook-edit-kind', 'openWorldbookEntryEditor', 'castEditing', 'worldbookEditing', 'castFolded', 'worldSettingsFolded', 'emptyEditRow', '文本模型', '切换 / 管理']) {
    if (!renderPanel.includes(signal)) throw new Error(`The Nora panel must expose World Settings using Python Tavern semantics: ${signal}`);
}
for (const removedSignal of ['世界书库', 'data-edit-section="settings"', 'worldSettingsEditing']) {
    if (renderPanel.includes(removedSignal)) throw new Error(`The Nora panel must remove obsolete edit/library UI: ${removedSignal}`);
}
for (const removedSignal of ['nora-panel-section', 'nora-section-head', 'nora-cast-card', '<span>角色卡</span>', '<span>登场角色</span>', '<span>世界设定</span>']) {
    if (renderPanel.includes(removedSignal)) throw new Error(`The Nora panel must not retain the replaced ST-style panel shell: ${removedSignal}`);
}
if (renderPanel.includes('导入登场角色')) {
    throw new Error('Importing a character must only appear inside New World creation, not in the right panel.');
}
for (const signal of ['常驻设定', '触发设定']) {
    if (!worldbookController.includes(signal)) throw new Error(`World Settings must use the accepted Nora terminology: ${signal}`);
}

const worldScenario = getNamedFunction(worldbookController, 'scenario');
for (const signal of ['world.metadata?.scenario', "characterField(character, 'scenario')"]) {
    if (!worldScenario.includes(signal)) throw new Error(`World background must preserve ST Scenario fallback behavior: ${signal}`);
}

const currentCast = getNamedFunction(panelController, 'currentCast');
if (!currentCast.includes('hasCharacterProfile(character)')) {
    throw new Error('The resident-character panel must not classify an empty Runtime Card as a resident character.');
}
for (const signal of ['currentCharacter()', 'readState().activeCharacterId']) {
    if (!currentCast.includes(signal)) throw new Error(`Resident-character editing must resolve through active runtime state: ${signal}`);
}
for (const leakedBinding of ['world.character', 'world.characterId', 'world.chatId']) {
    if (currentCast.includes(leakedBinding)) throw new Error(`The product World model must not leak an ST binding into the panel: ${leakedBinding}`);
}

const hasCharacterProfile = getNamedFunction(panelController, 'hasCharacterProfile');
if (!hasCharacterProfile.includes("characterField(character, 'personality')")) {
    throw new Error('A Runtime Card may appear as a resident character only when its personality field is non-empty.');
}
if (hasCharacterProfile.includes("characterField(character, 'description')")) {
    throw new Error('A description alone must not classify a Runtime Card as a resident character.');
}

const worldbookSummary = getNamedFunction(worldbookController, 'summary');
for (const signal of ['data-worldbook-kind="scenario"', 'data-worldbook-edit-kind="scenario"', "panelItems(alwaysOn, 'always', editing)", "panelItems(triggered, 'triggered', editing)", 'is-always', 'is-triggered', 'class="loreTitle"']) {
    if (!worldbookSummary.includes(signal)) throw new Error(`The Worldbook panel must render compact drill-down summaries: ${signal}`);
}
if (worldbookSummary.includes('loreSummary(') || worldbookSummary.includes('entry.content')) {
    throw new Error('Compact Worldbook rows must display titles only.');
}
for (const removedSignal of ['namedBindings', 'namedHtml', 'data-worldbook-kind="library"']) {
    if (worldbookSummary.includes(removedSignal)) throw new Error(`Worldbook summaries must not append binding names as entries: ${removedSignal}`);
}

const panelLoreItems = getNamedFunction(worldbookController, 'panelItems');
for (const signal of ['entryTitle(entry)', 'class="loreTitle"', 'data-worldbook-edit-kind="embedded"', 'icons.edit']) {
    if (!panelLoreItems.includes(signal)) throw new Error(`Compact Worldbook entries must derive their visible title consistently: ${signal}`);
}
for (const removedSignal of ['entry.content', 'worldbookEntryKeys(entry)', 'loreSummary(']) {
    if (panelLoreItems.includes(removedSignal)) throw new Error(`Compact Worldbook entries must not expose content previews: ${removedSignal}`);
}

const worldbookDetail = getNamedFunction(worldbookController, 'openEntryDetail');
for (const signal of ['进入方式', '完整内容', 'entryKeys(entry)', 'isAlwaysOn(entry)']) {
    if (!worldbookDetail.includes(signal)) throw new Error(`Worldbook detail must preserve insertion semantics: ${signal}`);
}
if (worldbookDetail.includes("kind === 'library'")) {
    throw new Error('Worldbook details must not retain the removed library routing branch.');
}

const worldbookSheet = getNamedFunction(worldbookController, 'open');
for (const signal of ['世界书', '世界背景', '世界书内容', '常驻设定', '触发设定', 'data-edit-scenario', 'data-embedded-book', 'data-worldbook']) {
    if (!worldbookSheet.includes(signal)) throw new Error(`World Settings must preserve the ST binding while using Nora semantics: ${signal}`);
}
for (const removedSignal of ['世界书库', 'nora-chat-worldbook', 'getWorldInfoNames', 'chatMetadata.world_info']) {
    if (worldbookSheet.includes(removedSignal)) throw new Error(`The visible Worldbook library must be removed: ${removedSignal}`);
}

const scenarioEditor = getNamedFunction(worldbookController, 'editScenario');
for (const signal of ['worldbook.saveWorldScenario', 'onChanged()']) {
    if (!scenarioEditor.includes(signal)) throw new Error(`World background editing must persist through ST chat metadata: ${signal}`);
}
for (const signal of ['current.chatMetadata.scenario', 'delete current.chatMetadata.scenario', 'current.saveMetadata()']) {
    if (!worldbookAdapter.includes(signal)) throw new Error(`The Worldbook adapter must preserve ST Scenario persistence: ${signal}`);
}

const entryEditor = getNamedFunction(worldbookController, 'editEntry');
for (const signal of ["mode === 'constant'", "mode === 'trigger'", '!nextKeys.length', 'entry.constant', 'worldbook.saveWorldbook(name, book)']) {
    if (!entryEditor.includes(signal)) throw new Error(`Worldbook editing must preserve ST entry semantics: ${signal}`);
}

const bookEntries = getNamedFunction(worldbookController, 'renderEntries');
for (const signal of ['entryTitle(entry)', '[tr("常驻设定"), \'always\'', '[tr("触发设定"), \'triggered\'', 'data-view-entry', 'renderEntryDetail']) {
    if (!bookEntries.includes(signal)) throw new Error(`Worldbook lists must be title-only drill-down rows: ${signal}`);
}
if (bookEntries.includes('entry.content')) {
    throw new Error('The Worldbook entry list must not render full content before opening details.');
}

const bookEntryDetail = getNamedFunction(worldbookController, 'renderEntryDetail');
for (const signal of ['进入方式', '完整内容', 'entry.content', 'data-back-entries']) {
    if (!bookEntryDetail.includes(signal)) throw new Error(`Worldbook details must retain complete entry information: ${signal}`);
}

const modelSheet = getNamedFunction(modelController, 'open');
for (const signal of [
    'clamp(native.openai_max_context, 32768, 512, 1000000)',
    'clamp(native.openai_max_tokens, 2048, 1, 128000)',
    'nora-model-group-head',
    'data-model-add',
    'openConfig',
]) {
    if (!modelSheet.includes(signal)) {
        throw new Error(`Model configuration must normalize persisted values before rendering: ${signal}`);
    }
}

getNamedFunction(modelController, 'openConfig');
for (const signal of ['data-model-provider', 'DeepSeek', 'OpenAI', 'OpenRouter', '全自定义']) {
    if (!modelController.includes(signal)) throw new Error(`Model setup must offer provider templates and a custom path: ${signal}`);
}

if (!/data-message-action="edit"[\s\S]*data-message-action="suggest"[\s\S]*data-message-action="regenerate"/.test(messageViewAdapter)) {
    throw new Error('Smart Reply must appear between Edit and Regenerate on the latest assistant message.');
}

if (!/await storyScroller\.toLatest\(\)/.test(noraUi + worldController + startupController)) {
    throw new Error('World activation must settle at the latest visible message.');
}

for (const signal of [
    '.nora-message-controls button {',
    'font-size: 9px;',
    '.nora-card-waterfall { display: grid;',
    'grid-template-columns: repeat(var(--nora-library-columns), 120px);',
    '.nora-card-library-item { position: relative; display: flex; width: 120px; height: 224px;',
    '.nora-card-library-open > span {',
    '.nora-card-library-open > span::before {',
    'grid-template-columns: repeat(var(--nora-library-mobile-columns), 104px);',
    'grid-template-rows: 180px minmax(0, 1fr);',
    '.nora-library-pager {',
]) {
    if (!noraCss.includes(signal)) throw new Error(`Nora UX sizing/layout contract is missing: ${signal}`);
}

if (noraCss.includes('.nora-card-library-item::after')) {
    throw new Error('Character library must not restore the detached faux pedestal treatment.');
}

for (const signal of ['#nora-new-world { border-radius: 999px;', 'border-radius: 50% !important;', '.nora-modal.nora-plain-sheet .nora-dialog-kicker { display: none;', '.nora-model-item.active', '.loreSummaryItem.is-triggered .loreTitle', 'article.is-triggered strong', '.loreTitle', '.nora-entry-summary', 'text-overflow: ellipsis;', '.nora-lore-detail', '.nora-card-waterfall', '.modelUnitHead']) {
    if (!noraCss.includes(signal)) throw new Error(`Nora visual contract is missing: ${signal}`);
}

if (!messageViewAdapter.includes("const lastMessage = [...messages].reverse().find(message => message.getAttribute('is_system') !== 'true');")) {
    throw new Error('Swipe and regenerate must target the actual final non-system message.');
}

if (!/const isLastAssistant = message === lastMessage && message\.getAttribute\('is_user'\) !== 'true';/.test(messageViewAdapter)) {
    throw new Error('Swipe and regenerate must be hidden while the final message belongs to the user.');
}

if (!/regenerate:\s*async\s*\(\{ signal \} = \{\}\)\s*=>\s*\{[\s\S]*ensureBackendReady\(\)/.test(messageAdapter)) {
    throw new Error('Regenerate must prepare the model backend before dispatch.');
}

for (const signal of ['ensureCustomBackendAuth(current)', 'settings.custom_url', 'settings.custom_model', '文本模型配置缺失']) {
    if (!modelAdapter.includes(signal)) {
        throw new Error(`Custom model dispatch must fail before ST generation when endpoint configuration is missing: ${signal}`);
    }
}

if (!/async function swipe\(id, direction\)/.test(messageAdapter)) {
    throw new Error('Swipe must expose an async result instead of silently returning.');
}

console.log(`nora-ui-shell-contract=PASS nodes=${requiredShellIds.length}`);
