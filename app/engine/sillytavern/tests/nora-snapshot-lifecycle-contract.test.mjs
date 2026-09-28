import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as storyContext from '../public/scripts/nora-worlds/story-context.js';

const root = path.resolve(import.meta.dirname, '..');
const script = fs.readFileSync(path.join(root, 'public/script.js'), 'utf8');
const noraUi = fs.readFileSync(path.join(root, '../../native-extensions/nora-ui/index.js'), 'utf8');
const personas = fs.readFileSync(path.join(root, 'public/scripts/personas.js'), 'utf8');
const worldInfo = fs.readFileSync(path.join(root, 'public/scripts/world-info.js'), 'utf8');

test('World personas do not load from or write back to the global persona library', async () => {
    const scope = {
        chat_metadata: { nora_world: { version: 2 } },
        power_user: { personas: { avatar: 'Global' }, persona_descriptions: { avatar: { description: 'Global description' } }, persona_description: 'old' }, user_avatar: 'avatar',
        name1: '本世界玩家', console,
        setUserName: name => { scope.name1 = name; }, setPersonaDescription() {},
        persona_description_positions: { IN_PROMPT: 0 }, DEFAULT_DEPTH: 2, DEFAULT_ROLE: 0,
        getCurrentChatId: () => 'new-world', personaLastLoadedChatId: '',
        getUserAvatars: () => { throw new Error('global persona loading must not run'); },
        getOrCreatePersonaDescriptor: () => { throw new Error('global persona must not be edited'); },
        saveSettingsDebounced() {},
    };
    vm.createContext(scope);
    for (const [startMarker, endMarker] of [
        ['async function loadPersonaForCurrentChat', '\n/**'],
        ['async function selectCurrentPersona', '\n/**'],
        ['export async function updatePersonaDescription', '\n/**'],
    ]) {
        const start = personas.indexOf(startMarker);
        const end = personas.indexOf(endMarker, start);
        const source = personas.slice(start, end).replace('export ', '');
        vm.runInContext(source, scope);
    }
    await scope.loadPersonaForCurrentChat();
    await scope.selectCurrentPersona();
    assert.equal(scope.name1, '本世界玩家');
    assert.equal(scope.power_user.persona_description, 'old');
    await scope.updatePersonaDescription('本世界新身份', { syncUi: false });
    assert.equal(scope.power_user.persona_description, '本世界新身份');
    scope.chat_metadata = {};
    await scope.selectCurrentPersona();
    assert.equal(scope.name1, 'Global', 'legacy ST selection must remain available outside Worlds');
    assert.equal(scope.power_user.persona_description, 'Global description');
});

test('snapshot installs each World persona before chat rendering and first-message hooks', async () => {
    const start = script.indexOf('export async function activateNoraWorldSnapshot');
    const end = script.indexOf('\n////////// OPTIMZED MAIN API CHANGE FUNCTION', start);
    const observations = [];
    const scope = {
        ...storyContext, structuredClone,
        characters: [{ avatar: 'old.png' }, { avatar: 'new.png' }],
        this_chid: 0, name1: '魂东', power_user: { persona_description: '上一世界的身份' },
        chat_metadata: {}, this_edit_mes_id: null, selected_button: '',
        DOMPurify: { sanitize: value => value },
        isChatPersistenceBusy: () => false,
        timedBootStep: async (_name, run) => run(), timedBootSyncStep: (_name, run) => run(),
        world_names: ['Existing book'], worldInfoCache: new Map(), cancelTtsPlay() {},
        clearChat: async () => {}, setCharacterName() {},
        setCharacterId: value => { scope.this_chid = value; },
        getChat: async ({ strict }) => {
            assert.equal(strict, true);
            assert.ok(scope.world_names.includes('Imported book'), 'helpers must discover the book before chat hooks run');
            assert.ok(scope.worldInfoCache.has('Imported book'));
            observations.push({ name: scope.name1, description: scope.power_user.persona_description });
        },
    };
    vm.createContext(scope);
    const primeStart = worldInfo.indexOf('export function primeWorldInfoSnapshot');
    vm.runInContext(worldInfo.slice(primeStart, worldInfo.indexOf('\n/**', primeStart)).replace('export ', ''), scope);
    vm.runInContext(script.slice(start, end).replace('export async function', 'async function'), scope);
    const activate = persona => scope.activateNoraWorldSnapshot(1, {
        character: { avatar: 'new.png', name: 'New World' },
        plan: { persona, session: { binding: { chat_id: 'new-chat' } } },
        chat: { messages: [{ mes: '{{user}}进入新世界' }] }, worldbooks: [{ name: 'Imported book', data: { entries: {} } }],
    });
    await activate({ name: '', description: '' });
    assert.deepEqual(observations.at(-1), { name: '玩家', description: '' });
    await activate({ name: '墨量', description: '本世界的身份' });
    assert.deepEqual(observations.at(-1), { name: '墨量', description: '本世界的身份' });
    await activate({ name: '', description: '' });
    assert.deepEqual(observations.at(-1), { name: '玩家', description: '' });
    scope.isChatPersistenceBusy = () => true;
    await assert.rejects(activate({ name: '不应生效', description: '' }), /still being saved/);
    assert.equal(scope.name1, '玩家');
});

test('aggregate snapshots replace transport only and retain the native synchronous chat lifecycle', () => {
    const start = script.indexOf('export async function activateNoraWorldSnapshot');
    const end = script.indexOf('\n////////// OPTIMZED MAIN API CHANGE FUNCTION', start);
    assert.ok(start >= 0 && end > start);
    const source = script.slice(start, end);
    assert.match(source, /primeWorldInfoSnapshot/);
    assert.match(source, /getChat\(\{ preloadedData: snapshot\.chat, strict: true \}\)/);
    assert.doesNotMatch(source, /scheduleNoraWorldSnapshotLifecycle|setTimeout/);
    assert.match(script, /await getChatResult\(\{ snapshot: Boolean\(preloadedData\) \}\)/);
    const lifecycleStart = script.indexOf('async function getChatResult');
    const lifecycleEnd = script.indexOf('\nfunction getFirstMessage', lifecycleStart);
    const lifecycle = script.slice(lifecycleStart, lifecycleEnd);
    const prepare = lifecycle.indexOf("snapshotStep('display-capabilities', () => prepareWorldRender");
    const regex = lifecycle.indexOf("snapshotStep('event.chat-pre-render'");
    const render = lifecycle.indexOf("snapshotStep('dom-render', printMessages)");
    assert.ok(prepare >= 0 && regex > prepare && render > regex, 'display capabilities and Regex rules must finish before the only first render');
    assert.match(noraUi, /registerWorldRenderReadiness\(\(\{ worldId \}\) => prepareWorldCapabilities\(worldId\)\)/);
    assert.doesNotMatch(source, /beforeRender/);
    assert.match(script, /snapshotStep\('background\.event\.chat-loaded', emitChatLoaded\)/);
    assert.doesNotMatch(source, /await snapshotStep\('background\.event\.chat-loaded'/);
});
