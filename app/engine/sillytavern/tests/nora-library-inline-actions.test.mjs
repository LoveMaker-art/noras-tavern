import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { createPanelController } from '../../../native-extensions/nora-ui/panel-controller.js';
import { createCharacterController } from '../../../native-extensions/nora-ui/character-controller.js';
import { createWorldbookController } from '../../../native-extensions/nora-ui/worldbook-controller.js';
import { createRegexController } from '../../../native-extensions/nora-ui/regex-controller.js';
import { createWorldController } from '../../../native-extensions/nora-ui/world-controller.js';
import { createModelController } from '../../../native-extensions/nora-ui/model-controller.js';
import { translate as tr } from '../public/scripts/nora-i18n/core.js';

function fixture() {
    let $;
    const nodes = new WeakMap();
    function wrap(el) {
        if (!el) return null;
        if (nodes.has(el)) return nodes.get(el);
        const node = {
            el, handlers: {}, classList: { toggle() {}, add() {}, remove() {} },
            get dataset() { return Object.fromEntries(Object.entries(el.attribs || {}).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value])); },
            get value() { return $(el).val(); }, set value(value) { $(el).val(value); },
            get checked() { return $(el).prop('checked'); }, set checked(value) { $(el).prop('checked', value); },
            get elements() { return { namedItem: name => select(`[name="${name}"]`, node) }; },
            get innerHTML() { return $(el).html(); }, set innerHTML(value) { $(el).html(value); },
            addEventListener(type, fn) { this.handlers[type] = fn; },
            setAttribute(name, value) { $(el).attr(name, value); },
            removeAttribute(name) { $(el).removeAttr(name); },
            querySelector(selector) { return select(selector, node); },
            insertAdjacentHTML(position, markup) {
                assert.ok(['beforeend', 'afterbegin'].includes(position));
                if (position === 'afterbegin') $(el).prepend(markup);
                else $(el).append(markup);
            },
        };
        nodes.set(el, node); return node;
    }
    const select = (selector, root) => wrap((root?.el ? $(root.el).find(selector) : $(selector))[0]);
    const selectAll = (selector, root) => (root?.el ? $(root.el).find(selector) : $(selector)).toArray().map(wrap);
    const errors = [], picked = [], world = { id: 'world:a', revision: 1 };
    const common = {
        dialogs: { version: 0, open(_title, markup) { this.version++; $ = load(`${markup.includes('id="nora-panel-body"') ? '' : '<aside id="nora-panel-body"></aside>'}<main><div class="nora-sheet-body">${markup}</div></main>`); return wrap($('main')[0]); },
            protectForm: form => { assert.ok(form); return { release() {}, leave: action => action() }; },
            toast: value => errors.push(value), close() { this.version++; }, normalizeError: error => error.message },
        select, selectAll, escapeHtml: String, icons: {}, activeWorldModel: () => world,
        operations: { isBusy: () => false, run: async (_key, fn) => fn() },
        characterField: (card, key) => card?.data?.[key] || '',
        openProfileLibrary: (...args) => picked.push(args), openLibrary: (...args) => picked.push(args),
    };
    function field(selector, inputId) {
        const action = $(selector);
        assert.equal(action.length, 1);
        const heading = action.closest('.nora-library-heading');
        assert.equal(heading.length, 1);
        assert.equal(heading.children(`label[for="${inputId}"]`).length, 1);
        assert.equal(heading.parent().children(`input#${inputId}`).length, 1);
        assert.equal(action.closest('label').length, 0, 'An action must not be nested in the input label');
        assert.equal(action.attr('type'), 'button');
    }
    function back(selector, backSelector) {
        const action = $(selector);
        assert.equal(action.length, 1);
        assert.equal(action.closest('.nora-library-heading').children(backSelector).length, 1);
    }
    return { common, select, picked, world, field, back, errors, query: selector => $(selector) };
}

test('sidebar retains capability status without a standalone regex section', () => {
    const f = fixture();
    f.common.dialogs.open('panel', '<div id="nora-panel-body"></div>');
    f.world.storyContext = { characters: [] };
    f.world.capabilities = { declared: ['regex', 'mvu'], items: { regex: { status: 'DEGRADED' }, mvu: { status: 'READY' } } };
    const rules = [{ id: 'a', scriptName: '<规则 A>', placement: [2] }, { id: 'b', scriptName: '规则 B', disabled: true }];
    const panel = createPanelController({ ...f.common,
        currentCharacter: () => ({ avatar: 'runtime-card.png', data: { extensions: { regex_scripts: rules } } }), readState: () => ({}), settings: () => ({}),
        currentWorldPersona: () => ({}), worldbookSummary: () => '', closeDrawers() {},
        escapeHtml: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    });
    panel.render();
    assert.equal(f.query('[data-view-card-regex]').length, 0);
    assert.equal(f.query('[data-retry-capability="regex"]').length, 1, 'Existing retry is retained');
    assert.equal(f.query('#nora-regex-body, .nora-regex-section, [data-edit-section="regex"]').length, 0);
    assert.equal(f.query('.nora-capability-heading > [data-action="extensions"]').length, 1);
    assert.equal(f.query('[data-action="extensions"]').attr('aria-label'), tr('管理增强能力'));
    f.world.capabilities.declared = [];
    panel.render();
    assert.equal(f.query('.nora-capability-section, [data-action="extensions"]').length, 0);
});

test('world menu retains restart and delete without a duplicate tools entry', async t => {
    const originalElement = globalThis.Element;
    class Element { closest() { return { dataset: { worldOptions: this.worldId } }; } }
    globalThis.Element = Element;
    t.after(() => { if (originalElement === undefined) delete globalThis.Element; else globalThis.Element = originalElement; });
    const f = fixture(), restarted = [];
    f.world.available = true;
    const controller = createWorldController({ ...f.common,
        store: { read: () => ({ worldModels: [f.world] }) },
        openModal: f.common.dialogs.open.bind(f.common.dialogs), closeDrawers() {},
        openRestartWorldSheet: world => restarted.push(world),
    });
    const menu = async worldId => controller.selectWorld({ target: Object.assign(new Element(), { worldId }), preventDefault() {}, stopPropagation() {} });
    await menu(f.world.id);
    assert.equal(f.query('[data-world-restart], [data-world-remove]').length, 2);
    f.select('[data-world-restart]').handlers.click(); assert.deepEqual(restarted, [f.world]);
    assert.equal(f.query('[data-world-tools]').length, 0);
});

function extensionFixture() {
    const f = fixture(), opened = [], retried = [];
    let modelOpens = 0;
    const code = '\n</textarea><script>doNotRun()</script>';
    f.world.capabilities = { declared: ['regex', 'tavern_helper', 'mvu', 'prompt_template'], items: { regex: { status: 'DEGRADED' } } };
    const panel = createPanelController({ ...f.common,
        currentCharacter: () => ({ avatar: 'a.png' }), readState: () => ({}), settings: () => ({}),
        currentWorldPersona: () => ({}), worldbookSummary: () => '', worldbookController: { open() {} }, closeDrawers() {},
        escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
        characterCapabilities: () => ({ helperScripts: [{ name: '<script name>', content: code }] }),
        openCardRegex: (...args) => opened.push(args), openModelSheet: () => modelOpens++,
        retryWorldCapability: async (...args) => { retried.push(args); await f.onRetry?.(); },
    });
    f.common.dialogs.open('panel', '<div id="nora-panel-body"></div>');
    panel.render();
    const open = () => f.select('[data-action="extensions"]').handlers.click({ stopPropagation() {} });
    return Object.assign(f, { panel, open, code, opened, retried, modelOpens: () => modelOpens });
}

test('enhancement gear includes all declared extensions without executing or authorizing scripts', () => {
    const f = extensionFixture(); f.open();
    assert.equal(f.query('[data-extension]').length, 4);
    assert.equal(f.query('script, textarea:not([readonly])').length, 0);
    assert.equal(f.query('textarea').val(), f.code);
    assert.equal(f.query('summary').text(), '<script name>');
    assert.equal(f.retried.length, 0);
    f.select('[data-extension-model]').handlers.click(); assert.equal(f.modelOpens(), 1);
    f.select('[data-extension-regex]').handlers.click();
    assert.equal(f.opened[0][0], 'a.png');
    assert.deepEqual(f.opened[0][2], { backLabel: tr('‹ 返回增强能力') });
    f.opened[0][1](); assert.equal(f.query('[data-extension]').length, 4);
    const stale = f.select('[data-extension-model]');
    f.world.id = 'other'; stale.handlers.click(); assert.equal(f.modelOpens(), 1);
});

test('enhancement retries preserve authorization path and cannot reopen a closed or switched dialog', async () => {
    for (const action of ['ready', 'close', 'switch', 'fail']) {
        const f = extensionFixture(); f.open();
        f.onRetry = async () => {
            if (action === 'fail') throw Error('retry failed');
            if (action === 'ready') f.world.capabilities.items.regex.status = 'READY';
            if (action === 'close') f.common.dialogs.close();
            if (action === 'switch') f.world.id = 'other';
        };
        const version = f.common.dialogs.version;
        const button = f.select('.nora-extension-manager [data-retry-capability="regex"]');
        await button.handlers.click({ stopPropagation() {} });
        assert.deepEqual(f.retried, [['world:a', 'regex']]);
        assert.equal(button.disabled, false);
        if (action === 'ready') assert.equal(f.query('.nora-extension-manager [data-retry-capability]').length, 0);
        else assert.equal(f.common.dialogs.version, version + (action === 'close' ? 1 : 0));
        if (action === 'fail') assert.ok(f.errors.at(-1).includes('retry failed'));
    }
});

test('model settings return to enhancements only when entered from enhancements', () => {
    const f = fixture(); let returns = 0;
    const controller = createModelController({ ...f.common, settings: () => ({ modelProfiles: [] }),
        settingsDomain: {}, model: {}, readState: () => ({ model: {} }), onChanged() {},
    });
    controller.open(() => returns++);
    assert.equal(f.query('[data-model-back]').text(), tr('‹ 返回增强能力'));
    f.select('[data-model-back]').handlers.click();
    assert.equal(returns, 1);
    controller.open();
    assert.equal(f.query('[data-model-back]').length, 0, 'Ordinary model settings do not retain an old navigation callback');
});

test('regex list separates read-only details from explicit editing and preserves return destination', async () => {
    const f = fixture(), writes = [];
    const rules = [{ scriptName: 'First', findRegex: '/a/', replaceString: 'A' }, { scriptName: 'Second', findRegex: '/b/', replaceString: 'B' }];
    const controller = createRegexController({ ...f.common, isGenerating: () => false, refresh() {},
        cards: { readCharacterRegex: async avatar => ({ avatar, scripts: rules }), saveCharacterRegex: async input => writes.push(input) } });
    await controller.open('card.png', () => {}, { backLabel: tr('‹ 返回增强能力') });
    f.select('[data-regex-rule="1"]').handlers.click();
    assert.equal(f.query('textarea:not([readonly])').length, 0);
    assert.equal(f.query('form, [type="submit"]').length, 0);
    assert.equal(f.query('h3').text(), 'Second');
    assert.equal(writes.length, 0);
    await f.select('[data-regex-close]').handlers.click();
    assert.equal(f.query('[data-regex-back]').text(), tr('‹ 返回增强能力'));
    f.select('[data-regex-edit="1"]').handlers.click();
    assert.equal(f.select('[name="scriptName"]').value, 'Second');
    f.select('[name="replaceString"]').value = 'Edited';
    await f.select('[data-regex-form]').handlers.submit({ preventDefault() {} });
    assert.equal(writes[0].index, 1);
    assert.deepEqual(writes[0].patch, { replaceString: 'Edited' });
});

test('rendered regex form round-trips code safely and saves only the requested text edit', async () => {
    const f = fixture(), saved = [];
    const source = '\n</textarea><script>untrusted()</script>\n$1 & {{match}}';
    const original = { id: 'rule', scriptName: '<unsafe>', findRegex: '/test/g', replaceString: source, placement: [2], markdownOnly: true };
    const controller = createRegexController({ ...f.common, isGenerating: () => false, refresh() {},
        escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
        cards: { readCharacterRegex: async avatar => ({ avatar, name: 'Card', scripts: [original] }), saveCharacterRegex: async value => saved.push(value) },
    });
    await controller.open('card.png');
    f.select('[data-regex-edit]').handlers.click();
    assert.equal(f.query('script').length, 0);
    assert.equal(f.select('[name="replaceString"]').value, source);
    assert.equal(f.query('[name="placement"]:checked').val(), '2');
    assert.equal(f.select('[name="markdownOnly"]').checked, true);
    f.select('[name="replaceString"]').value = 'New $1';
    await f.select('[data-regex-form]').handlers.submit({ preventDefault() {} });
    assert.deepEqual(saved[0].patch, { replaceString: 'New $1' });
    assert.equal(saved[0].avatar, 'card.png');
    assert.equal(saved[0].index, 0);
    assert.equal(f.errors.at(-1), tr('正则规则已保存。'));
});

test('persona library actions share the name label row and preserve the current-world save', async () => {
    const f = fixture();
    createPanelController({ ...f.common, currentWorldPersona: () => ({ name: 'Player', description: 'Identity' }) }).openPersona();
    f.field('[data-pick-persona]', 'nora-persona-name');
    f.field('[data-save-persona]', 'nora-persona-name');
    assert.equal(f.query('#nora-persona-form > button[type="submit"]').length, 1);
    f.select('[data-pick-persona]').handlers.click();
    assert.deepEqual(f.picked, [['persona', f.world]]);
});

test('World card library shows the summary without offering to copy the entire World as one actor', () => {
    for (const native of [true, false]) for (const hasRegex of [true, false]) {
        const f = fixture();
        const card = { name: '世界名', avatar: 'world.png', data: { description: '用户概要',
            character_book: { entries: [] },
            extensions: native ? { nora_world: { format: 'nora-world-card/2' } } : {} } };
        const openedBooks = [], openedRegex = [];
        const controller = createCharacterController({ ...f.common,
            cards: {},
            openCardWorldbook: source => openedBooks.push(source),
            openCardRegex: avatar => openedRegex.push(avatar),
            readState: () => ({ activeCharacterId: 0, characters: [card] }), settings: () => ({}),
            characterCapabilities: () => ({ regexScripts: hasRegex ? [{}] : [], helperScripts: [] }), worldbookEntries: () => [],
        });
        controller.openSheet(0, true);
        assert.equal(f.query('[data-card-regex]').length, hasRegex ? 1 : 0);
        if (hasRegex) {
            f.select('[data-card-regex]').handlers.click();
            assert.deepEqual(openedRegex, ['world.png']);
        }
        assert.equal(f.query('[data-card-create-world]').length, 1);
        assert.equal(f.query('[data-card-add-role]').length, native ? 0 : 1);
        assert.equal(f.query('[data-save-card-profile]').length, native ? 0 : 1);
        if (!native) assert.equal(f.query('.nora-library-actions').children().first().is('[data-save-card-profile]'), true);
        assert.equal(f.query('[data-card-worldbook]').length, 1);
        f.select('[data-card-worldbook]').handlers.click();
        assert.deepEqual(openedBooks, [{ kind: 'card', name: 'world.png' }]);
        assert.ok(f.query('.nora-character-detail').text().includes(tr(native ? '世界概要' : '角色介绍')));
    }
});

test('new role library actions share the name label row without moving the editor footer', () => {
    const f = fixture();
    createCharacterController({ ...f.common, readState: () => ({}), settings: () => ({}) }).openEditor('new-world-character');
    f.field('[data-pick-role]', 'nora-character-name');
    f.field('[data-save-role]', 'nora-character-name');
    assert.equal(f.query('.nora-editor-toolbar [data-cancel-character]').length, 1);
    assert.equal(f.query('.nora-editor-toolbar button[type="submit"]').length, 1);
    f.select('[data-pick-role]').handlers.click();
    assert.deepEqual(f.picked, [['character', f.world]]);
});

test('worldbook import shares the title row; whole-book and entry saves share their back rows', async () => {
    const f = fixture();
    const book = { name: 'Lore', entries: { '0': { comment: 'Rule', content: 'Content', constant: true, key: [] } } };
    const controller = createWorldbookController({ ...f.common,
        readState: () => ({ world: { metadata: { nora_world: { id: f.world.id } } } }),
        currentCharacter: () => ({ data: { extensions: { world: 'Lore' } } }),
        worldbook: { loadWorldbook: async () => book }, store: { cacheWorldbook() {}, cachedWorldbook: () => book },
    });
    controller.openAdd();
    f.field('[data-pick-book]', 'nora-setting-title');
    f.select('[data-pick-book]').handlers.click();
    assert.deepEqual(f.picked, [[f.world]]);
    await controller.openNamed('Lore');
    f.back('[data-save-whole-book]', '[data-back-world-settings]');
    await controller.openEntryEditor('embedded', '0');
    f.back('[data-save-entry-library]', '[data-back-entries]');
    assert.equal(f.query('.nora-editor-toolbar [data-delete-setting]').length, 1);
    assert.equal(f.query('.nora-editor-toolbar button[type="submit"]').length, 1);
    assert.deepEqual(f.errors, []);
});
