import assert from 'node:assert/strict';
import test from 'node:test';
import { createCharacterController } from '../../../native-extensions/nora-ui/character-controller.js';

test('new-character editor submits a real World array mutation with distinct keyword lines', async (t) => {
    const OriginalFormData = globalThis.FormData;
    globalThis.FormData = class { constructor(form) { this.values = form.values; } get(key) { return this.values[key] ?? null; } };
    t.after(() => { globalThis.FormData = OriginalFormData; });
    const controls = new Map();
    const element = (key) => {
        if (!controls.has(key)) controls.set(key, { value: 'triggered', handlers: {},
            addEventListener(event, handler) { this.handlers[event] = handler; }, querySelector: element });
        return controls.get(key);
    };
    const form = element('form');
    const modes = ['constant', 'triggered'].map(mode => Object.assign(element(`mode:${mode}`), {
        dataset: { characterMode: mode }, classList: { toggle() {} },
    }));
    form.querySelector = key => key === '[data-delete-character]' ? null : element(key);
    form.values = { name: '商人', description: '维修机械', personality: '谨慎', activationMode: 'triggered',
        activationKeys: '机械商店\r\n商人', secondaryKeys: '进入\n交谈', selectiveLogic: '0', scanDepth: '4', sticky: '2', cooldown: '0', delay: '0' };
    const commands = [];
    let html = '';
    let refreshed = 0;
    let world = { id: 'world:test', revision: 7 };
    const controller = createCharacterController({
        cards: { updateCharacter() { throw new Error('Must not overwrite a legacy card'); } },
        operations: { isBusy: () => false, run: async (_key, fn) => fn() },
        dialogs: { open: (_title, content) => { html = content; return {}; }, close() {}, toast() {}, normalizeError: error => error.message },
        readState: () => ({}), settings: () => ({}),
        characterField: (character, key) => character.data?.[key] || '',
        select: () => form, selectAll: selector => selector === '[data-character-mode]' ? modes : [], escapeHtml: value => String(value ?? ''), icons: {},
        reloadWorlds: async () => {}, refresh: () => refreshed++, activeWorldModel: () => world,
        updateWorld: async (...args) => { commands.push(args); },
    });
    controller.openEditor('new-world-character');
    assert.match(html, /activationMode/);
    assert.match(html, /triggered/);
    assert.match(html, /nora-mode-switch/);
    assert.match(html, /nora-form-actions/);
    assert.match(html, /data-cancel-character/);
    modes[0].handlers.click();
    assert.equal(element('[data-character-trigger]').hidden, true);
    modes[1].handlers.click();
    assert.equal(element('[data-character-trigger]').hidden, false);
    assert.equal(element('[name="activationMode"]').value, 'triggered');
    await form.handlers.submit({ preventDefault() {}, currentTarget: form });
    assert.equal(commands.length, 1);
    const [command, options] = commands[0];
    assert.equal(command.character.operation, 'create');
    assert.match(command.character.id, /^character:/);
    assert.deepEqual(command.character.patch.activation.keys, ['机械商店', '商人']);
    assert.deepEqual(command.character.patch.activation.secondaryKeys, ['进入', '交谈']);
    assert.equal(command.character.patch.activation.scanDepth, 4);
    assert.equal(options.expectedRevision, 7);
    assert.equal(refreshed, 1);
    controller.openEditor('new-world-character');
    world = { id: 'world:other', revision: 1 };
    await form.handlers.submit({ preventDefault() {}, currentTarget: form });
    assert.equal(commands.length, 1, 'stale editor cannot mutate another World');
    world = { id: 'world:test', revision: 7 };
    controller.openEditor('new-world-character');
    form.values.description = '{{char::missing}}';
    await form.handlers.submit({ preventDefault() {}, currentTarget: form });
    assert.equal(commands.length, 1, 'unresolved references cannot be silently saved through the editor');
});
