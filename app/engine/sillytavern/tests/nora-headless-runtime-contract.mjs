import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preservationOnly = process.argv.includes('--preservation-only');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

function assertContains(relativePath, names) {
    const source = read(relativePath);
    for (const name of names) {
        assert.match(source, new RegExp(`\\b${name}\\b`), `${relativePath} must preserve ${name}`);
    }
}

function getNamedFunction(relativePath, name) {
    const source = read(relativePath);
    const match = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`).exec(source);
    assert.ok(match, `${relativePath} must define ${name}`);
    const openBrace = source.indexOf('{', match.index);
    let depth = 0;
    for (let index = openBrace; index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}' && --depth === 0) return source.slice(match.index, index + 1);
    }
    assert.fail(`${relativePath} has an unterminated ${name}`);
}

function getNamedMethod(relativePath, name) {
    const source = read(relativePath);
    const match = new RegExp(`(?:async\\s+)?${name}\\s*\\(`).exec(source);
    assert.ok(match, `${relativePath} must define method ${name}`);
    const openBrace = source.indexOf('{', match.index);
    let depth = 0;
    for (let index = openBrace; index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}' && --depth === 0) return source.slice(match.index, index + 1);
    }
    assert.fail(`${relativePath} has an unterminated method ${name}`);
}

assertContains('public/scripts/st-context.js', [
    'eventSource',
    'eventTypes',
    'sendText',
    'regenerate',
    'stopGeneration',
    'extensionPrompts',
    'setExtensionPrompt',
    'SlashCommandParser',
    'extensionSettings',
    'powerUserSettings',
    'loadWorldInfo',
    'saveWorldInfo',
    'getWorldInfoPrompt',
    'variables',
    'swipe',
    'importCharacter',
    'saveChat',
    'updatePersonaDescription',
]);

assertContains('public/scripts/extensions.js', [
    'extension_settings',
    'discoverExtensions',
    'getManifests',
    'addExtensionScript',
    'addExtensionStyle',
    'activateExtensions',
    'loadExtensionSettings',
    'runGenerationInterceptors',
    'callExtensionHook',
]);

assertContains('public/scripts/world-info.js', [
    'getWorldInfoPrompt',
    'checkWorldInfo',
    'loadWorldInfo',
    'saveWorldInfo',
    'importEmbeddedWorldInfo',
    'checkEmbeddedWorld',
    'setWorldInfoSettings',
]);

assertContains('public/scripts/power-user.js', [
    'power_user',
    'loadPowerUserSettings',
    'collapseNewlines',
    'renderStoryString',
    'getCustomStoppingStrings',
    'generatedTextFiltered',
]);

assertContains('public/scripts/personas.js', [
    'getUserAvatars',
    'setPersonaDescription',
    'initUserAvatar',
    'setUserAvatar',
    'onPersonaLoreButtonClick',
]);

assertContains('public/scripts/backgrounds.js', [
    'background_settings',
    'getBackgrounds',
    'loadBackgroundSettings',
    'setBackground',
    'forceSetBackground',
]);

assertContains('public/scripts/bookmarks.js', [
    'branchChat',
    'createBranch',
    'updateBookmarkDisplay',
]);

if (!preservationOnly) {
    const removedFiles = [
        'public/scripts/welcome-screen.js',
        'public/scripts/bulk-edit.js',
        'public/scripts/BulkEditOverlay.js',
        'public/scripts/data-maid.js',
        'public/scripts/stats.js',
        'public/scripts/setting-search.js',
        'public/scripts/server-history.js',
        'public/css/data-maid.css',
        'public/css/extensions-panel.css',
    ];

    for (const relativePath of removedFiles) {
        assert.equal(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} must be physically deleted`);
    }
    assert.doesNotMatch(read('public/style.css'), /data-maid\.css|extensions-panel\.css/);

    const script = read('public/script.js');
    const firstLoadStart = script.indexOf('async function firstLoadInit()');
    const firstLoadEnd = script.indexOf('// MARK: App Start', firstLoadStart);
    const firstLoad = script.slice(firstLoadStart, firstLoadEnd);
    for (const initializer of ['initStats', 'initBulkEdit', 'initWelcomeScreen', 'initDataMaid', 'addDebugFunctions']) {
        assert.doesNotMatch(firstLoad, new RegExp(`\\b${initializer}\\b`), `firstLoadInit must not reference ${initializer}`);
    }
    assert.doesNotMatch(script.slice(script.indexOf('async function finishDeferredInitialization'), firstLoadStart), /doDailyExtensionUpdatesCheck/);

    const extensions = read('public/scripts/extensions.js');
    for (const productFunction of [
        'initExtensions',
        'doDailyExtensionUpdatesCheck',
        'showExtensionsDetails',
        'installExtension',
        'deleteExtension',
        'updateExtension',
        'autoUpdateExtensions',
        'moveExtension',
        'switchExtensionBranch',
    ]) {
        assert.doesNotMatch(extensions, new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${productFunction}\\b`), `extensions.js must not define ${productFunction}`);
    }
    assert.doesNotMatch(extensions, /\/api\/extensions\/(?:install|delete|update|move|checkout|branches|version)/);
    assert.match(extensions, /export async function openThirdPartyExtensionMenu\(\)/);

    const openai = read('public/scripts/openai.js');
    const loadOpenAISettings = getNamedFunction('public/scripts/openai.js', 'loadOpenAISettings');
    assert.doesNotMatch(loadOpenAISettings, /settings_preset_openai/);
    const configureCustomChatCompletion = getNamedFunction('public/scripts/openai.js', 'configureCustomChatCompletion');
    assert.doesNotMatch(configureCustomChatCompletion, /syncUi|\$\(|custom_api_url_text|custom_model_id|openai_max_context_counter/);
    assert.match(openai, /configureCustomChatCompletion[\s\S]*oai_settings\.stream_openai = true;[\s\S]*changeMainAPI\('openai'\)/);
    const clearCustomChatCompletion = getNamedFunction('public/scripts/openai.js', 'clearCustomChatCompletion');
    assert.match(clearCustomChatCompletion, /deleteSecret\(SECRET_KEYS\.CUSTOM/);
    assert.match(clearCustomChatCompletion, /oai_settings\.custom_url = ''/);
    assert.match(clearCustomChatCompletion, /oai_settings\.custom_model = ''/);
    assert.match(clearCustomChatCompletion, /setOnlineStatus\('no_connection'\)/);
    const applyOpenAIPreset = getNamedFunction('public/scripts/openai.js', 'applyOpenAIPreset');
    assert.doesNotMatch(applyOpenAIPreset, /\$\(|settings_preset_openai/);
    assert.match(applyOpenAIPreset, /oai_settings\[setting\] = preset\[key\]/);
    const setupPromptManager = getNamedFunction('public/scripts/openai.js', 'setupChatCompletionPromptManager');
    assert.match(setupPromptManager, /promptManager\.initState\(configuration, openAiSettings\)/);
    const promptManagerState = getNamedMethod('public/scripts/PromptManager.js', 'initState');
    assert.doesNotMatch(promptManagerState, /document|getElementById|\$\(/);
    assert.match(promptManagerState, /sanitizeServiceSettings\(\)/);
    assert.doesNotMatch(script, /ensureLegacySettingsUI|applyLegacySettingsUI|initializeLegacySettingsUiBindings|__NORA_ENSURE_LEGACY_SETTINGS_UI__/);
    assert.match(
        script,
        /applyLegacyUi\s*\?\s*loadActiveCompatibilitySettings\(data,\s*\{ applyLegacyUi \}\)\s*:\s*loadCompatibilitySettings\(data,\s*\{ applyLegacyUi: false \}\)/,
        'hidden Nora mode must load every model preset state required by complex-card extensions',
    );

    const presetManager = read('public/scripts/preset-manager.js');
    assert.match(presetManager, /presetManagers\[apiId\] \?\?= new PresetManager\(null, apiId\)/);
    assert.doesNotMatch(getNamedMethod('public/scripts/preset-manager.js', 'getAllPresets'), /\$\(/);
    assert.doesNotMatch(getNamedMethod('public/scripts/preset-manager.js', 'getSelectedPresetName'), /\$\(/);
    assert.doesNotMatch(getNamedMethod('public/scripts/preset-manager.js', 'selectPreset'), /\$\(|trigger\(/);

    const cfgScale = read('public/scripts/cfg-scale.js');
    assert.match(cfgScale, /global:\s*\{ \.\.\.defaultSettings\.global, \.\.\.current\.global \}/);
    assert.match(cfgScale, /if \(charaCfg && charaCfg\.guidance_scale !== 1\)/);

    const powerUser = read('public/scripts/power-user.js');
    for (const productFunction of [
        'switchMovingUI',
        'applyMovingUIPreset',
        'showDebugMenu',
        'updateTheme',
        'deleteTheme',
        'exportTheme',
        'importTheme',
        'saveTheme',
        'saveMovingUI',
        'resetMovablePanels',
        'setmovingUIPreset',
        'setAvgBG',
    ]) {
        assert.doesNotMatch(powerUser, new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${productFunction}\\b`), `power-user.js must not define ${productFunction}`);
    }
    assert.doesNotMatch(powerUser, /\/api\/(?:themes|moving-ui)\//);
    assert.match(powerUser, /export function loadMovingUIState\(\)\s*{\s*\/\/ Compatibility facade/);

    const worldInfo = read('public/scripts/world-info.js');
    assert.match(worldInfo, /export function initWorldInfo\(\)\s*{\s*\/\/ Nora owns the worldbook editor; scanning and slash commands initialize through settings\.\s*}/);
    const worldInfoSettings = getNamedFunction('public/scripts/world-info.js', 'setWorldInfoSettings');
    assert.doesNotMatch(worldInfoSettings, /\$\(|world_editor_select|chat_lorebook_button/);
    assert.match(worldInfoSettings, /Array\.isArray\(configuredWorldInfo\.globalSelect\)/);
    assert.match(worldInfoSettings, /world_info = \{ \.\.\.configuredWorldInfo, globalSelect: configuredGlobalSelect \}/);
    assert.match(worldInfoSettings, /world_info\.globalSelect = selected_world_info/);

    const personas = read('public/scripts/personas.js');
    assert.match(personas, /export async function initPersonas\(\)\s*{\s*await migrateNonPersonaUser\(\);\s*registerPersonaSlashCommands\(\);\s*eventSource\.on\(event_types\.CHAT_CHANGED, loadPersonaForCurrentChat\);\s*}/);
    assert.doesNotMatch(getNamedFunction('public/scripts/personas.js', 'setUserAvatar'), /updatePersonaUIStates/);
    assert.doesNotMatch(getNamedFunction('public/scripts/personas.js', 'loadPersonaForCurrentChat'), /updatePersonaUIStates/);
    assert.doesNotMatch(getNamedFunction('public/scripts/personas.js', 'migrateNonPersonaUser'), /getUserAvatars\(true/);
    for (const removedPersonaEditorFunction of [
        'switchPersonaGridView',
        'changeUserAvatar',
        'createDummyPersona',
        'renamePersona',
        'deleteUserAvatar',
        'onPersonaDescriptionInput',
        'onPersonaDescriptionDepthValueInput',
        'onPersonaDescriptionDepthRoleInput',
        'editPersonaTitle',
    ]) {
        assert.doesNotMatch(personas, new RegExp(`(?:async\\s+)?function\\s+${removedPersonaEditorFunction}\\b`));
    }

    const backgrounds = read('public/scripts/backgrounds.js');
    assert.match(backgrounds, /export function initBackgrounds\(\)\s*{\s*eventSource\.on\(event_types\.CHAT_CHANGED, onChatChanged\);\s*eventSource\.on\(event_types\.FORCE_SET_BACKGROUND, forceSetBackground\);\s*}/);
    assert.doesNotMatch(getNamedFunction('public/scripts/backgrounds.js', 'loadBackgroundSettings'), /\$\(|applyThumbnailColumns|highlightSelectedBackground/);
    for (const removedBackgroundManagerFunction of [
        'onLockBackgroundClick',
        'onDeleteBackgroundClick',
        'onCreateFolder',
        'onAssignToFolder',
        'uploadBackground',
        'uploadChatBackground',
        'onBackgroundFilterInput',
        'autoBackgroundCommand',
    ]) {
        assert.doesNotMatch(backgrounds, new RegExp(`(?:async\\s+)?function\\s+${removedBackgroundManagerFunction}\\b`));
    }

    const ross = read('public/scripts/RossAscends-mods.js');
    for (const removedPanelHook of [
        'OpenNavPanels',
        'RPanelPin',
        'LPanelPin',
        'WIPanelPin',
        'START MOVING UI',
    ]) {
        assert.doesNotMatch(ross, new RegExp(removedPanelHook), `RossAscends-mods.js must not contain ${removedPanelHook}`);
    }
    assert.match(ross, /export async function initMovingUI\(\)\s*{\s*\/\/ Compatibility facade/);
    for (const runtimeHook of ['sendTextArea.addEventListener', "document.addEventListener('swiped-left'", 'processHotkeys']) {
        assert.match(ross, new RegExp(runtimeHook.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `RossAscends-mods.js must preserve ${runtimeHook}`);
    }

    const index = read('public/index.html');
    for (const removedDomHook of [
        'top-settings-holder',
        'top-bar',
        'ai-config-button',
        'sys-settings-button',
        'advanced-formatting-button',
        'WI-SP-button',
        'user-settings-button',
        'backgrounds-button',
        'extensions-settings-button',
        'persona-management-button',
        'settings_preset_openai',
        'secrets_datalists',
        'option_settings',
        'settingsSearch',
        'user_stats_button',
        'rm_stats_button',
        'bulkEditButton',
        'bulkSelectedCount',
        'bulkSelectAllButton',
        'bulkDeleteButton',
        'data-server-history',
        'extensions-panel.css',
        'UI-presets-block',
        'ui_preset_',
        'ui-preset-',
        'movingUImode',
        'movingUIreset',
        'MovingUI-presets-block',
        'movingUIPresets',
        'movingui-preset',
        'debug_menu',
        'data_maid_button',
    ]) {
        assert.doesNotMatch(index, new RegExp(removedDomHook), `index.html must not contain ${removedDomHook}`);
    }
    assert.doesNotMatch(index, /id="nora-character-runtime"/);
    assert.doesNotMatch(index, /id="rightNavHolder"/);
    assert.doesNotMatch(index, /id="character_context_menu"/);
    assert.doesNotMatch(index, /id="options"/);
    assert.match(index, /id="sheld" class="nora-headless-chat-host" hidden aria-hidden="true"/);
    assert.doesNotMatch(script, /option_settings|top-settings-holder|document\.getElementById\('top-bar'\)/);
    assert.match(script, /getUserAvatars\(false, user_avatar\)/);
    assert.doesNotMatch(script, /getUserAvatars\(true, user_avatar\)/);
    assert.match(script, /readSecretState\(\{ syncUi: !isNoraProduct \}\)/);

    const secretStateLoader = getNamedFunction('public/scripts/secrets.js', 'readSecretState');
    assert.match(secretStateLoader, /const \{ syncUi = true \} = options \?\? \{\}/);
    assert.match(secretStateLoader, /if \(syncUi\)/);

    const textGenModels = read('public/scripts/textgen-models.js');
    assert.match(textGenModels, /if \(!modelCardBlock \|\| !toggleButton\)\s*{\s*return;/);

    const regex = read('public/scripts/extensions/regex/index.js');
    const regexPresetState = getNamedMethod('public/scripts/extensions/regex/index.js', 'getSelectedPresetId');
    const regexPresetSelection = getNamedMethod('public/scripts/extensions/regex/index.js', 'selectPreset');
    assert.doesNotMatch(regexPresetState, /document|presetSelect|\$\(/);
    assert.doesNotMatch(regexPresetSelection, /document|presetSelect|\$\(/);
    assert.doesNotMatch(regex, /Could not find preset select element in the DOM/);
    assert.match(regex, /callback: async \(args, name\)[\s\S]*?await this\.selectPreset\(foundId\)/);
}

console.log(`nora-headless-runtime-contract=PASS mode=${preservationOnly ? 'preservation' : 'complete'}`);
