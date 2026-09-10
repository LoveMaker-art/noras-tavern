import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { characterReference, resolveCharacterReferences } from '../public/scripts/nora-worlds/character-references.js';
import { createStoryContext, editStoryCharacter, renderStoryContext } from '../public/scripts/nora-worlds/story-context.js';
import { setWorldCharacterContext, resolveWorldCharacterReference, validateWorldCharacterReferences, getWorldCharacterEntries } from '../public/scripts/nora-worlds/character-activation.js';
import { createPanelController } from '../../../native-extensions/nora-ui/panel-controller.js';

function context() {
    let value = createStoryContext({ name: 'Player' });
    value = editStoryCharacter(value, { operation: 'create', id: 'character:a', patch: { name: '莉娜', description: '{{char}}信任{{char::character:b}}。' } });
    return editStoryCharacter(value, { operation: 'create', id: 'character:b', patch: {
        name: '白羽', description: '保密背景', activation: { mode: 'triggered', keys: ['医务室'] },
    } });
}

test('stable references survive reorder, rename and serialization without rewriting source', () => {
    let value = context();
    const reference = characterReference('character:b');
    assert.equal(reference, '{{char::character:b}}');
    assert.equal(resolveCharacterReferences(reference, value.characters), '白羽');
    value.characters.reverse();
    value = editStoryCharacter(value, { id: 'character:b', patch: { name: '新名字' } });
    value = JSON.parse(JSON.stringify(value));
    assert.equal(resolveCharacterReferences(reference, value.characters), '新名字');
    assert.equal(resolveCharacterReferences('{{char}}/{{user}}', value.characters), '{{char}}/{{user}}');
    assert.match(value.characters[1].profile.identity.description, /\{\{char::character:b\}\}/);
    assert.throws(() => characterReference('a}}bad'), /Invalid/);
});

test('deleted, missing and out-of-world references are explicit; never array lookup or auto-activation', () => {
    const value = context();
    const saved = structuredClone(value);
    setWorldCharacterContext(value, 'world:a');
    const prompt = renderStoryContext(value);
    assert.match(prompt, /莉娜信任白羽/);
    assert.doesNotMatch(prompt, /保密背景/);
    assert.deepEqual(value, saved);
    assert.equal(getWorldCharacterEntries()[0].constant, false);
    assert.match(getWorldCharacterEntries()[0].content, /保密背景/);
    assert.throws(() => validateWorldCharacterReferences('{{char::0}}'), /无效人物引用/);
    setWorldCharacterContext(editStoryCharacter(value, { operation: 'delete', id: 'character:b' }), 'world:a');
    assert.match(resolveWorldCharacterReference('character:b'), /无效人物引用/);
    setWorldCharacterContext(createStoryContext(), 'world:b');
    assert.match(resolveWorldCharacterReference('character:a'), /无效人物引用/);
    setWorldCharacterContext(null);
    assert.match(resolveWorldCharacterReference('character:a'), /无效人物引用/);
});

test('legacy ST macro evaluator resolves ID references and preserves ordinary char/user', () => {
    setWorldCharacterContext(context());
    const source = fs.readFileSync(new URL('../public/scripts/macros.js', import.meta.url), 'utf8');
    const start = source.indexOf('export function evaluateMacros(');
    const fn = source.slice(start, source.indexOf('\n}', start) + 2).replace('export ', '');
    const noMacro = () => ({ regex: /NEVER_MATCH_THIS_TEST/g, replace: () => '' });
    const sandbox = { resolveWorldCharacterReference, console,
        MacrosParser: { populateEnv() {}, sanitizeMacroValue: String }, uuidv4: () => 'nonce',
        escapeRegex: value => value, getDiceRollMacro: noMacro, getInstructMacros: () => [], getVariableMacros: () => [],
        getTimeDiffMacro: noMacro, getBannedWordsMacro: noMacro, getRandomReplaceMacro: noMacro, getPickReplaceMacro: noMacro,
    };
    vm.createContext(sandbox);
    vm.runInContext(fn, sandbox);
    assert.equal(sandbox.evaluateMacros('{{char}}/{{user}}/{{char::character:b}}', { char: 'World Card', user: 'Player' }), 'World Card/Player/白羽');
    assert.equal(sandbox.evaluateMacros('{{char::character:b}}', {}, value => `<${value}>`), '<白羽>');
    assert.match(sandbox.evaluateMacros('{{char::missing}}', {}), /无效人物引用/);
    setWorldCharacterContext(null);
});

test('new ST macro registry accepts an optional stable ID, keeping zero-argument char unchanged', () => {
    setWorldCharacterContext(context());
    const source = fs.readFileSync(new URL('../public/scripts/macros/engine/MacroRegistry.js', import.meta.url), 'utf8');
    const registrySource = source.replace(/^import .*;\n/gm, '').replace(/^export \{.*\};\n/gm, '').replace(/^export /gm, '');
    const sandbox = { console, resolveWorldCharacterReference,
        MACRO_IDENTIFIER_PATTERN: /^[a-zA-Z][a-zA-Z0-9_]*$/,
        isFalseBoolean: value => value === 'false', isTrueBoolean: value => value === 'true',
        MacroEngine: { normalizeMacroResult: value => String(value ?? ''), trimScopedContent: value => value },
        createMacroRuntimeError: ({ message }) => new Error(message),
        logMacroRegisterError: error => { throw new Error(JSON.stringify(error)); }, logMacroRegisterWarning() {}, logMacroRuntimeWarning() {},
    };
    vm.createContext(sandbox);
    vm.runInContext(registrySource + '\nglobalThis.registry = instance;', sandbox);
    const definitions = fs.readFileSync(new URL('../public/scripts/macros/definitions/env-macros.js', import.meta.url), 'utf8');
    const start = definitions.indexOf("    MacroRegistry.registerMacro('char',");
    const registration = definitions.slice(start, definitions.indexOf('\n    });', start) + 8).replace('MacroRegistry.registerMacro', 'registry.registerMacro');
    vm.runInContext(registration, sandbox);
    const call = args => sandbox.registry.executeMacro({ name: 'char', args, env: { names: { char: 'World Card' } } });
    assert.equal(call([]), 'World Card');
    assert.equal(call(['character:b']), '白羽');
    assert.match(call(['missing']), /无效人物引用/);
    assert.match(call(['']), /空 ID/);
    setWorldCharacterContext(null);
});

test('panel copies the exact stable reference, does not open the profile, and exposes a clipboard fallback', async t => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    t.after(() => original ? Object.defineProperty(globalThis, 'navigator', original) : delete globalThis.navigator);
    let copied = ''; let toast = ''; let fallback = ''; let stopped = 0; let opened = 0;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => { copied = value; } } } });
    const body = { innerHTML: '' };
    const edit = { addEventListener(_type, handler) { this.click = handler; } };
    const button = { dataset: { copyCharacter: '{{char::character:b}}' }, addEventListener(_type, handler) { this.click = handler; } };
    const card = { dataset: { castCharacter: 'world-character:character:b' }, handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; } };
    let world = { id: 'world:a', storyContext: context() };
    const controller = createPanelController({
        dialogs: { toast: value => { toast = value; }, open: (_title, value) => { fallback = value; } },
        select: () => body, selectAll: query => query === '[data-edit-section="cast"]' ? [edit] : query === '[data-copy-character]' ? [button] : query === '[data-cast-character]' ? [card] : [],
        escapeHtml: value => String(value ?? '').replaceAll('"', '&quot;'), icons: {},
        readState: () => ({ activeCharacterId: 0, model: {} }), settings: () => ({}),
        characterField: (character, key) => character.data?.[key] || '', currentCharacter: () => ({ name: 'Legacy', data: { description: 'Original' } }),
        activeWorldModel: () => world, currentWorldPersona: () => null,
        worldbookSummary: () => '', closeDrawers() {}, openCharacterSheet: () => opened++,
    });
    controller.render();
    assert.doesNotMatch(body.innerHTML, /data-cast-toggle/);
    assert.doesNotMatch(body.innerHTML, /data-cast-delete/);
    assert.doesNotMatch(body.innerHTML, /data-action="add-character"/);
    edit.click({ stopPropagation() {} });
    assert.equal((body.innerHTML.match(/data-cast-toggle=/g) || []).length, 3);
    assert.match(body.innerHTML, /nora-lore-dot/);
    assert.match(body.innerHTML, /data-cast-toggle="card-profile"/);
    assert.doesNotMatch(body.innerHTML, /data-cast-delete/);
    assert.match(body.innerHTML, /data-action="add-character"/);
    edit.click({ stopPropagation() {} });
    assert.doesNotMatch(body.innerHTML, /data-cast-toggle/);
    assert.doesNotMatch(body.innerHTML, /data-action="add-character"/);
    assert.match(body.innerHTML, /castProfileCard loreItem loreSummaryItem/);
    assert.doesNotMatch(body.innerHTML, /class="cdesc"|class="ctags"|原卡基础字段/);
    assert.match(body.innerHTML, /class="loreTitle">Legacy/);
    assert.match(body.innerHTML, /fa-regular fa-copy/);
    assert.equal((body.innerHTML.match(/data-copy-character=/g) || []).length, 2, 'legacy card gets no false reference');
    assert.match(body.innerHTML, /\{\{char::character:b\}\}/);
    await button.click({ stopPropagation: () => stopped++ });
    assert.equal(copied, '{{char::character:b}}');
    assert.equal(stopped, 1);
    assert.match(toast, /已复制/);
    card.handlers.keydown({ target: button, key: 'Enter' });
    assert.equal(opened, 0);
    card.handlers.click();
    assert.equal(opened, 1, 'Compact rows still open character details');
    navigator.clipboard.writeText = async () => { throw new Error('Denied'); };
    await button.click({ stopPropagation() {} });
    assert.match(fallback, /readonly/);
    assert.match(fallback, /\{\{char::character:b\}\}/);
    world = { id: 'world:a' };
    edit.click({ stopPropagation() {} });
    assert.equal((body.innerHTML.match(/data-cast-toggle=/g) || []).length, 1, 'an imported card with no independent cast still has a toggle');
    assert.match(body.innerHTML, /data-cast-toggle="card-profile"[^>]*aria-pressed="true"/);
    world.storyContext = { ...createStoryContext(), card_profile_enabled: false };
    controller.render();
    assert.match(body.innerHTML, /data-cast-toggle="card-profile"[^>]*aria-pressed="false"/);
    assert.match(body.innerHTML, /loreSummaryItem is-disabled/);
    assert.match(body.innerHTML, /class="nora-lore-status">[^<]+/);
    world.storyContext.removed_card_fields = ['description', 'personality', 'scenario'];
    controller.render();
    assert.doesNotMatch(body.innerHTML, /data-cast-character="0"|data-cast-edit="0"|data-cast-delete="card-profile"/);
});
