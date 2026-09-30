import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeControls } from '../public/scripts/nora-controls/runtime.js';
import { createStoryActionDispatcher } from '../../../native-extensions/nora-ui/story-action-dispatcher.js';
import { createPluginLibraryActions } from '../public/scripts/nora-controls/plugin-library-actions.js';
import { contentRevision } from '../public/scripts/nora-controls/revision.js';
import { createPresetActions } from '../public/scripts/nora-controls/preset-actions.js';
import { patchExistingConfiguration } from '../public/scripts/nora-controls/config-patch.js';
import { createPageControls } from '../../../native-extensions/nora-ui/page-controls.js';

test('page navigation keeps editor/draft guards, waits for close outcome and rechecks asynchronous World switches', async () => {
    let opened = true; let draft = ''; const calls = [];
    const dialogs = { protected: true, version: 1, close: async () => {} };
    const shell = { drawerState: () => ({}), closeDrawers: () => {}, setDrawer: (...args) => calls.push(args) };
    let onLoad = () => {};
    const page = createPageControls({ ready: () => true, dialogs, shell, draft: () => draft, setDraft: text => { draft = text; },
        modalOpen: () => opened, loadWorlds: async () => onLoad(), openWorld: async id => calls.push(id),
        openPanel: async panel => calls.push(panel), openLibrary: async kind => calls.push(kind) });
    await assert.rejects(page.execute('page.library', { kind: 'worldbooks' }), { code: 'NORA_CONTROL_EDITOR_OPEN' });
    assert.equal((await page.execute('page.close', {})).applied, false, 'User declined to close');
    dialogs.protected = false;
    await page.execute('page.library', { kind: 'worldbooks' });
    assert.deepEqual(calls, ['worldbooks']);
    opened = false;
    await page.execute('page.draft', { text: 'Unsent' });
    await assert.rejects(page.execute('page.world', { targetWorldId: 'another' }), { code: 'NORA_CONTROL_DRAFT_PRESENT' });
    draft = '';
    onLoad = () => { dialogs.version++; };
    await assert.rejects(page.execute('page.world', { targetWorldId: 'another' }), { code: 'NORA_CONTROL_EDIT_STALE' });
    onLoad = () => {};
    await page.execute('page.world', { targetWorldId: 'another' });
    await page.execute('page.sidebar', { which: 'rail', expanded: false });
    assert.deepEqual(calls, ['worldbooks', 'another', ['rail', false]]);
});

test('nested plugin configuration preserves untouched fields and rejects secrets, new fields, types and array resizing', () => {
    const source = { options: { groups: [{ title: 'One', enabled: true }], api_key: 'private', count: 1 } };
    const next = patchExistingConfiguration(source, { 'options.groups.0': { title: 'Two' } });
    assert.equal(next.options.groups[0].title, 'Two');
    assert.equal(next.options.groups[0].enabled, true);
    assert.equal(next.options.api_key, 'private');
    assert.equal(source.options.groups[0].title, 'One');
    for (const updates of [{ 'options.api_key': 'changed' }, { 'options.new': 1 }, { 'options.count': 'one' },
        { 'options.groups': [] }, { 'options.groups.length': 4 }, { options: { constructor: {} } }, { 'options.groups.0.title': null }]) {
        assert.throws(() => patchExistingConfiguration(source, updates), { code: 'NORA_CONTROL_FIELD_DENIED' });
    }
});

function fixture() {
    const context = { chatMetadata: { nora_world: { id: 'w' }, nora_session: { id: 's' } }, characterId: 0,
        characters: [{ avatar: 'runtime.png' }], chat: [{ is_user: true, mes: 'Hi' },
            { is_user: false, mes: 'One', swipe_id: 0, swipes: ['One', 'Two'] }, { is_user: true, mes: 'Keep later' }],
        saveSettingsStrict: async () => {}, extensionSettings: {} };
    const calls = [];
    const messages = { isGenerating: () => false,
        editMessage: async (id, text) => { calls.push('edit'); context.chat[id].mes = text; },
        editAndRegenerate: async () => { calls.push('regenerate'); },
        swipe: async (id, direction) => { calls.push('swipe'); context.chat[id].swipe_id += direction === 'right' ? 1 : -1; },
    };
    const dispatcher = createStoryActionDispatcher({ messages, getSessionKey: () => context.chatMetadata.nora_session.id });
    const settings = { modelProfiles: [], activeModel: '' };
    const story = { messages, settings: { uiSettings: () => settings }, model: { configureModel: async (_profile, key) => {
        calls.push(['configure', key]); return { secretId: 'secret-reference' };
    } } };
    let page = { ready: true, draft: '', modalOpen: false };
    const controls = createRuntimeControls({ getContext: () => context, story, dispatch: () => dispatcher,
        assertIdle: () => {}, globalRef: { NoraUI: { pageControlState: () => page, controlPage: async (action, params) => {
            calls.push(action); page = { ...page, draft: params.text }; return { applied: true };
        } } } });
    const execute = (action, params = {}, extra = {}) => controls.execute({ action, params, worldId: 'w', sessionId: 's',
        confirm: true, allowModelCall: true, allowScriptExecution: true, ...extra });
    return { context, execute, calls, settings };
}

test('ordinary assistant edit uses dispatcher without truncation; stale and wrong-role writes fail', async () => {
    const f = fixture();
    const before = await f.execute('story.message', { id: 1 });
    await f.execute('story.edit', { id: 1, text: 'Changed', expectedRevision: before.revision });
    assert.deepEqual(f.calls, ['edit']);
    assert.equal(f.context.chat.length, 3);
    assert.equal(f.context.chat[2].mes, 'Keep later');
    await assert.rejects(f.execute('story.edit', { id: 1, text: 'Stale', expectedRevision: before.revision }), { code: 'NORA_CONTROL_EDIT_STALE' });
    const user = await f.execute('story.message', { id: 0 });
    await assert.rejects(f.execute('story.edit', { id: 0, text: 'Wrong', expectedRevision: user.revision }), { code: 'NORA_CONTROL_INVALID' });
});

test('candidate selection never requests a new swipe; model consent cannot be bypassed', async () => {
    const f = fixture();
    let before = await f.execute('story.message', { id: 1 });
    await assert.rejects(f.execute('story.swipe', { id: 1, direction: 'right', expectedRevision: before.revision }, { allowModelCall: false }), { code: 'NORA_MODEL_CALL_NOT_AUTHORIZED' });
    await f.execute('story.swipe', { id: 1, direction: 'right', expectedRevision: before.revision });
    before = await f.execute('story.message', { id: 1 });
    await assert.rejects(f.execute('story.swipe', { id: 1, direction: 'right', expectedRevision: before.revision }), { code: 'NORA_CONTROL_INVALID' });
    assert.deepEqual(f.calls, ['swipe']);
});

test('custom model creation reuses shared model service without returning or storing raw key in UI settings', async () => {
    const f = fixture();
    const before = await f.execute('models.list');
    const params = { profile: { id: 'test', name: 'Test', base: 'https://model.example/v1', model: 'fixture' }, apiKey: 'private-key', expectedRevision: before.revision };
    await assert.rejects(f.execute('models.create', params, { allowModelCall: false }), { code: 'NORA_MODEL_CALL_NOT_AUTHORIZED' });
    const result = await f.execute('models.create', params);
    assert.equal(result.saved, true);
    assert.equal(result.activeId, 'test');
    assert.deepEqual(f.calls, [['configure', 'private-key']]);
    assert.equal(JSON.stringify(result).includes('private-key'), false);
    assert.equal(JSON.stringify(result).includes('secret-reference'), false);
    assert.equal(JSON.stringify(f.settings).includes('private-key'), false);
    await assert.rejects(f.execute('models.create', params), { code: 'NORA_CONTROL_EDIT_STALE' });
});

test('page draft changes require a current revision and never invoke generation', async () => {
    const f = fixture();
    const page = await f.execute('page.inspect');
    await f.execute('page.draft', { text: 'Not sent', expectedRevision: page.revision });
    await assert.rejects(f.execute('page.draft', { text: 'Stale', expectedRevision: page.revision }), { code: 'NORA_CONTROL_EDIT_STALE' });
    assert.deepEqual(f.calls, ['page.draft']);
});

test('plugin catalog follows library state; installs disabled and rejects protected/stale lifecycle changes', async () => {
    const calls = [];
    const items = [{ name: 'third-party/custom', editable: true, repository: true, libraryEnabled: false },
        { name: 'third-party/core', builtin: { key: 'tavern_helper' }, editable: false }];
    const api = createPluginLibraryActions({ request: async (route, body) => {
        calls.push([route, body]); return route.endsWith('/library') ? { items } : { isUpToDate: false };
    }, loadExtensions: async () => ({ getExtensionLibraryRuntime: () => ({ 'third-party/custom': { loaded: true, enabled: true } }) }),
    getContext: () => ({ extensionSettings: {}, getActiveExtensionNames: () => [] }) });
    const list = await api.list();
    assert.equal(list[0].enabled, false);
    assert.equal(list[0].active, true);
    await api.execute('plugins.install', { url: 'https://github.com/author/plugin' });
    assert.deepEqual(calls.at(-1)[1], { url: 'https://github.com/author/plugin', global: false, disabled: true });
    await assert.rejects(api.execute('plugins.install', { url: 'https://key@github.com/a/b' }));
    await assert.rejects(api.execute('plugins.uninstall', { name: items[0].name, expectedRevision: 'old' }), { code: 'NORA_CONTROL_EDIT_STALE' });
    await assert.rejects(api.execute('plugins.uninstall', { name: items[1].name, expectedRevision: await contentRevision(list) }), { code: 'NORA_CONTROL_PROTECTED' });
    const result = await api.execute('plugins.uninstall', { name: items[0].name, expectedRevision: await contentRevision(list) });
    assert.equal(result.reloadRequired, true);
    assert.deepEqual(calls.at(-1), ['/api/extensions/delete', { extensionName: 'custom', global: false }]);
});

test('preset deletion compares disk revision and UI snapshot before native deletion; never applies a preset', async () => {
    const stored = { prompts: [{ identifier: 'main', content: 'safe' }] };
    const calls = [];
    const apply = createPresetActions({ getContext: () => ({ chatMetadata: {} }), request: async () => ({ revision: 'disk', storedPreset: stored }),
        story: { presets: { readPreset: name => ({ name, revision: JSON.stringify(stored) }), deletePreset: async snapshot => calls.push(snapshot.name) } } });
    await assert.rejects(apply('preset.delete', { name: 'Template', expectedRevision: 'old' }), { code: 'NORA_CONTROL_EDIT_STALE' });
    await apply('preset.delete', { name: 'Template', expectedRevision: 'disk' });
    assert.deepEqual(calls, ['Template']);
});

test('preset chunks reassemble the inspected data and refuse stale or invalid ranges', async () => {
    const preset = { prompts: [{ identifier: 'main', content: 'long text '.repeat(4000) }] };
    const apply = createPresetActions({ getContext: () => ({ chatMetadata: {} }),
        request: async () => ({ revision: 'r1', preset }), story: {} });
    let offset = 0;
    let text = '';
    do {
        const chunk = await apply('preset.read-chunk', { scope: 'library', name: 'Large', expectedRevision: 'r1', offset, limit: 16000 });
        text += chunk.text;
        offset = chunk.nextOffset;
    } while (offset !== null);
    assert.deepEqual(JSON.parse(text), preset);
    await assert.rejects(apply('preset.read-chunk', { scope: 'library', name: 'Large', expectedRevision: 'old', offset: 0, limit: 1 }), { code: 'NORA_CONTROL_EDIT_STALE' });
    await assert.rejects(apply('preset.read-chunk', { scope: 'library', name: 'Large', expectedRevision: 'r1', offset: -1, limit: 1 }), { code: 'NORA_CONTROL_INVALID' });
});

test('library regex targets an original only and forwards the inspected rules for conditional save', async () => {
    const scripts = [{ id: 'r1', disabled: true, findRegex: 'a', replaceString: 'b' }];
    const saves = [];
    const context = { chatMetadata: {}, getRequestHeaders: () => ({}) };
    const controls = createRuntimeControls({ getContext: () => context, assertIdle: () => {},
        fetcher: async () => ({ ok: true, json: async () => ({ items: [
            { avatar: 'original.png' }, { avatar: 'legacy.png', legacy: true },
        ] }) }),
        story: { messages: { isGenerating: () => false }, cards: {
            readCharacterRegex: async () => ({ scripts }), saveCharacterRegex: async value => saves.push(value),
        } },
    });
    const execute = (action, params) => controls.execute({ action, params, worldId: '', sessionId: '', confirm: true, allowScriptExecution: true });
    await assert.rejects(execute('library.card-regex', { avatar: 'legacy.png' }), { code: 'NORA_CONTROL_RESOURCE_SCOPE' });
    await assert.rejects(execute('library.card-regex', { avatar: 'runtime.png' }), { code: 'NORA_CONTROL_RESOURCE_SCOPE' });
    const inspected = await execute('library.card-regex', { avatar: 'original.png' });
    const params = { avatar: 'original.png', index: 0, patch: { disabled: false }, expectedRevision: inspected.revision };
    await assert.rejects(execute('library.card-regex-update', { ...params, expectedRevision: 'old' }), { code: 'NORA_CONTROL_EDIT_STALE' });
    await execute('library.card-regex-update', params);
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0].expectedScripts, scripts);
    assert.equal(saves[0].avatar, 'original.png');
});
