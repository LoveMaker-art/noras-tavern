import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const uiRoot = path.join(root, 'native-extensions/nora-ui');
const index = fs.readFileSync(path.join(uiRoot, 'index.js'), 'utf8');
const gatewaySource = fs.readFileSync(path.join(uiRoot, 'card-action-gateway.js'), 'utf8');
const messageControllerSource = fs.readFileSync(path.join(uiRoot, 'message-controller.js'), 'utf8');
const worldControllerSource = fs.readFileSync(path.join(uiRoot, 'world-controller.js'), 'utf8');
const singleQuote = String.fromCharCode(39);

if (!index.includes('function mount({ story })')
    || !index.includes('const { state, messages, cards, worldbook, model, mvu, settings: settingsDomain, transport, worlds } = story || {};')) {
    throw new Error('Nora UI mount must consume the named story domain interfaces.');
}
if (/function mount\(\{\s*runtime|\bruntime:\s*story\.runtime|story\.runtime/.test(index)) {
    throw new Error('Nora UI entry must not recreate or accept the flat Runtime bridge.');
}

const controllerDomains = new Map([
    ['ui-store.js', ['state', 'settingsDomain']],
    ['story-action-dispatcher.js', ['messages']],
    ['card-action-gateway.js', ['storyActions']],
    ['message-controller.js', ['messages', 'model']],
    ['card-capability-controller.js', ['cards']],
    ['character-controller.js', ['cards']],
    ['worldbook-controller.js', ['worldbook']],
    ['model-controller.js', ['model', 'mvu', 'settingsDomain']],
    ['world-controller.js', ['settingsDomain']],
    ['panel-controller.js', ['settingsDomain']],
    ['startup-controller.js', ['state']],
]);

for (const [file, domains] of controllerDomains) {
    const source = fs.readFileSync(path.join(uiRoot, file), 'utf8');
    if (/\bruntime\./.test(source)) throw new Error(`${file} must not depend on the flat Runtime interface.`);
    for (const domain of domains) {
        if (!new RegExp(`\\b${domain}\\b`).test(source)) {
            throw new Error(`${file} must consume the ${domain} domain interface.`);
        }
    }
}

const modules = new Map([
    ['ui-store.js', 'createUiStore'],
    ['story-action-dispatcher.js', 'createStoryActionDispatcher'],
    ['card-action-gateway.js', 'createCardActionGateway'],
    ['ui-operation-registry.js', 'createUiOperationRegistry'],
    ['dialog-controller.js', 'createDialogController'],
    ['model-controller.js', 'createModelController'],
    ['character-controller.js', 'createCharacterController'],
    ['worldbook-controller.js', 'createWorldbookController'],
    ['smart-reply-controller.js', 'createSmartReplyController'],
    ['story-scroller.js', 'createStoryScroller'],
    ['st-message-view-adapter.js', 'createStMessageViewAdapter'],
    ['message-controller.js', 'createMessageController'],
    ['world-controller.js', 'createWorldController'],
    ['card-capability-controller.js', 'createCardCapabilityController'],
    ['world-creation-controller.js', 'createWorldCreationController'],
    ['panel-controller.js', 'createPanelController'],
    ['shell-controller.js', 'createShellController'],
    ['startup-controller.js', 'createStartupController'],
]);

const managementModules = new Set([
    'model-controller.js',
    'character-controller.js',
    'world-creation-controller.js',
]);

for (const [file, factory] of modules) {
    const source = fs.readFileSync(path.join(uiRoot, file), 'utf8');
    if (!source.includes(`export function ${factory}`)) {
        throw new Error(`${file} must expose the ${factory} interface.`);
    }
    const staticImport = `import { ${factory} } from './${file}'`;
    const dynamicImport = `import('./${file}')`;
    if (managementModules.has(file)) {
        if (!index.includes(dynamicImport) || index.includes(staticImport)) {
            throw new Error(`Nora UI management module must load on demand: ${file}`);
        }
    } else if (!index.includes(staticImport)) {
        throw new Error(`Nora UI entry must compose ${factory}.`);
    }
}

if (!index.includes('import(' + singleQuote + './mvu-model-adapter.js' + singleQuote + ')')) {
    throw new Error('MVU model management must load with the model sheet, not during startup.');
}

for (const removedDefinition of [
    'function openModal(',
    'function openModelConfigSheet(',
    'function openCharacterLibrary(',
    'function editWorldbookEntry(',
    'async function sendMessage(',
    'async function queueWorldSelection(',
    'function openNewWorldSheet(',
    'function renderPanel(',
    'async function hydrateUi(',
    'function createLayout(',
]) {
    if (index.includes(removedDefinition)) {
        throw new Error(`Nora UI entry still owns module implementation: ${removedDefinition}`);
    }
}

for (const signal of [
    'storyActions = createStoryActionDispatcher({',
    'cardActionGateway = createCardActionGateway({',
    'cardActionGateway.start();',
    "await storyActions.execute({ type: 'story.send', text });",
    "await storyActions.execute({ type: 'story.regenerate' });",
    "storyActions.execute({ type: 'story.edit-and-regenerate'",
    "storyActions.execute({ type: 'story.retry'",
    'operations.run(' + singleQuote + 'world' + singleQuote,
    'current.degraded = error;',
    'refreshWorldsAfterCommit(',
]) {
    if (!(index + messageControllerSource + worldControllerSource).includes(signal)) {
        throw new Error(`Nora UI must route generation through StoryActionDispatcher: ${signal}`);
    }
}

const smartReplyController = fs.readFileSync(path.join(uiRoot, 'smart-reply-controller.js'), 'utf8');
if (!smartReplyController.includes("await storyActions.execute({ type: 'sidecar.suggest-replies' });")) {
    throw new Error('Smart Reply must route model work through StoryActionDispatcher.');
}

for (const signal of [
    "const CARD_COMPLETION_REQUEST = 'request_chat_completion';",
    "storyActions.execute({ type: 'story.send', text, origin: 'card.post-message' })",
    'isEmbeddedSource(event.source)',
    'consumeLegacyInput(event)',
    "error.code = 'NORA_UNSUPPORTED_CARD_ACTION';",
]) {
    if (!gatewaySource.includes(signal)) throw new Error(`Card actions must cross the canonical Gateway: ${signal}`);
}
if (/send_but|send_textarea|mes_stop/.test(gatewaySource)) {
    throw new Error('CardActionGateway must not restore or simulate removed ST composer controls.');
}

for (const file of ['model-controller.js', 'character-controller.js', 'worldbook-controller.js']) {
    const source = fs.readFileSync(path.join(uiRoot, file), 'utf8');
    if (!source.includes('operations.run(') || !source.includes('operations.isBusy(')) {
        throw new Error(`${file} must use UiOperationRegistry for non-model mutations.`);
    }
}

const lineCount = index.split('\n').length;
if (lineCount > 500) throw new Error(`Nora UI entry is still too broad: ${lineCount} lines.`);

for (const file of fs.readdirSync(uiRoot).filter(name => name.endsWith('.js') && name !== 'st-message-view-adapter.js')) {
    const source = fs.readFileSync(path.join(uiRoot, file), 'utf8');
    if (/(?:#chat\b|#sheld\b|\.mes_text\b|\.mes_block\b|#chat \.mes\b)/.test(source)) {
        throw new Error(`${file} must not know the ST message DOM contract.`);
    }
}

console.log(`nora-ui-modules-contract=PASS entry_lines=${lineCount} modules=${modules.size}`);
