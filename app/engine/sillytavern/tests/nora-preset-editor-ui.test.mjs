import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { createLibraryController } from '../../../native-extensions/nora-ui/library-controller.js';
import { translate as tr } from '../public/scripts/nora-i18n/core.js';
import { createWorldPreset } from '../public/scripts/nora-worlds/world-preset.js';

// Parse the real controller markup; only DOM event delivery and storage are fakes.
function fixture(worldMode = true) {
    let dom, modal, guard, confirmed = true, fail = null, importFailure = null, focused;
    let opens = 0, closes = 0;
    const wrappers = new WeakMap(), writes = [], notices = [], imports = [], deletions = [], confirmations = [];
    const deletedNames = new Set();
    const preset = { temperature: 0.5, top_p: 0.9, openai_max_tokens: 2048, openai_max_context: 32768,
        prompts: [{ identifier: 'a', name: 'A', content: '<unsafe>' }, { identifier: 'b', name: 'B', content: 'B' },
        { identifier: 'c', content: 'C' }, { identifier: 'locked', marker: true }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: false }, { identifier: 'locked', enabled: true }] }] };
    let world = { id: 'a', name: 'World A', revision: 1, preset: createWorldPreset('Test', preset) };
    let currentId = 'a';
    const snapshot = (name = 'Test') => ({ name, current: false, preset: structuredClone(name === 'Other' ? { ...preset, temperature: 0.9 } : preset), revision: '1', runtimeRevision: '1', toggleable: ['a', 'b', 'c'] });
    const wrap = raw => {
        if (!raw) return null;
        if (wrappers.has(raw)) return wrappers.get(raw);
        const node = { raw, handlers: {}, scrollTop: 0,
            dataset: Object.fromEntries(Object.entries(raw.attribs || {}).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value])),
            addEventListener(type, fn) { this.handlers[type] = fn; },
            async fire(type, extra = {}) { return this.handlers[type]?.({ currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra }); },
            insertBefore() {}, focus() { focused = this; },
            setAttribute(key, value) { dom(raw).attr(key, value); },
            getAttribute(key) { return dom(raw).attr(key); },
            classList: { toggle: (name, on) => dom(raw).toggleClass(name, on) },
        };
        for (const key of ['hidden', 'disabled', 'checked', 'open']) Object.defineProperty(node, key, {
            get: () => dom(raw).attr(key) !== undefined,
            set: value => value ? dom(raw).attr(key, '') : dom(raw).removeAttr(key),
        });
        Object.defineProperty(node, 'innerHTML', { get: () => dom(raw).html(), set: value => dom(raw).html(value) });
        Object.defineProperty(node, 'textContent', { get: () => dom(raw).text(), set: value => dom(raw).text(value) });
        Object.defineProperty(node, 'value', { get: () => dom(raw).attr('value') || '', set: value => dom(raw).attr('value', value) });
        Object.defineProperty(node, 'elements', { get: () => Object.fromEntries(dom(raw).find('[name]').toArray().map(el => [el.attribs.name, wrap(el)])) });
        wrappers.set(raw, node); return node;
    };
    const select = (selector, root = modal) => wrap(dom(root.raw).find(selector).get(0));
    const selectAll = (selector, root = modal) => dom(root.raw).find(selector).toArray().map(wrap);
    const controller = createLibraryController({
        worlds: { ensureReady: async () => structuredClone(world), list: () => [structuredClone(world)],
            updateActive: async (patch, options) => {
                writes.push({ patch, options });
                if (options.expectedRevision !== world.revision) throw new Error('revision conflict');
                if (!fail || fail.saved) world = { ...world, ...structuredClone(patch), revision: world.revision + 1 };
                if (fail) throw fail;
                return { world: structuredClone(world), runtimeApplied: true };
            } }, presets: { listPresets: () => ({ items: [{ name: 'Test', preset }, { name: 'Other', preset }].filter(item => !deletedNames.has(item.name)), selected: 'Test' }),
            deletePreset: async snapshot => { if (fail) throw fail; deletions.push(snapshot.name); deletedNames.add(snapshot.name); },
            toggleablePresetEntries: () => ['a', 'b', 'c'],
            importPreset: async (...args) => { if (importFailure) throw importFailure; imports.push(args); },
            readPreset: snapshot, savePresetEntries: async (_snapshot, changes, options) => {
                writes.push({ changes, options }); if (fail) throw fail;
                for (const change of changes) {
                    const order = preset.prompt_order[0].order, entry = order.find(item => item.identifier === change.identifier);
                    if (entry) entry.enabled = change.enabled; else order.push({ identifier: change.identifier, enabled: change.enabled });
                }
            } },
        dialogs: {
            open: (_title, content) => {
                opens++;
                dom = load('<div id="modal"><div class="nora-sheet"><header><button class="nora-modal-close"></button></header><div class="nora-sheet-body">' + content + '</div></div></div>');
                modal = wrap(dom('#modal').get(0)); return modal;
            }, async close() { if (!guard || await guard()) closes++; }, setCloseGuard: fn => { guard = fn; }, confirm: async options => { confirmations.push(options); return confirmed; },
            toast: message => notices.push(message), normalizeError: error => error.message,
        },
        operations: { isBusy: () => false, run: async (_scope, fn) => fn() }, isGenerating: () => false,
        activeWorldModel: () => ({ ...structuredClone(world), id: currentId }), select, selectAll, escapeHtml: value => String(value).replaceAll('<', '&lt;'), refresh() {},
    });
    return { controller, select, selectAll, writes, notices, imports, deletions, confirmations, worldMode, changeWorld: id => { currentId = id; },
        world: () => structuredClone(world), template: () => structuredClone(preset),
        canLeave: () => guard(), confirm: value => { confirmed = value; }, fail: error => { fail = error; },
        failImport: error => { importFailure = error; }, opens: () => opens, closes: () => closes, focused: () => focused };
}

async function open(f) {
    if (f.worldMode) return f.controller.openWorldPreset();
    await f.controller.openPresets();
    await f.select('[data-preset]').fire('click');
}

test('delete is library-only, requires confirmation and preserves every World field', async () => {
    const current = fixture(); await open(current);
    assert.equal(current.select('[data-delete-preset]'), null);
    const f = fixture(false); await open(f);
    const world = f.world();
    f.confirm(false);
    await f.select('[data-delete-preset]').fire('click');
    assert.deepEqual(f.deletions, []);
    assert.ok(f.select('[data-delete-preset]'));
    f.confirm(true);
    await f.select('[data-delete-preset]').fire('click');
    assert.deepEqual(f.deletions, ['Test']);
    assert.deepEqual(f.world(), world);
    assert.deepEqual(f.writes, []);
    assert.match(f.confirmations.at(-1).body, /Test/);
    assert.ok(f.confirmations.at(-1).body.includes(tr('仅删除预设库中的模板，已应用到各个世界的独立副本不受影响。')));
    assert.deepEqual(f.selectAll('[data-preset] strong').map(node => node.textContent), ['Other']);
});

test('failed deletion keeps the template editor and unsaved draft for retry', async () => {
    const f = fixture(false); await open(f);
    const toggle = f.select('[data-prompt-toggle="0"]'); toggle.checked = false; await toggle.fire('change');
    f.fail(new Error('delete unavailable'));
    await f.select('[data-delete-preset]').fire('click');
    assert.deepEqual(f.deletions, []);
    assert.equal(f.select('[data-prompt-toggle="0"]').checked, false);
    assert.equal(f.select('[data-delete-preset]').disabled, false);
    assert.ok(f.confirmations.at(-1).body.includes(tr('本次未保存的修改也会丢弃。')));
    assert.match(f.notices.at(-1), /delete unavailable/);
    f.fail(null);
    await f.select('[data-delete-preset]').fire('click');
    assert.deepEqual(f.deletions, ['Test']);
});

test('real detail markup exposes separate toggles, unlisted add action, and engine lock', async () => {
    const f = fixture(); await open(f);
    assert.equal(f.selectAll('input[role="switch"]').length, 3);
    assert.equal(f.select('[data-prompt-toggle="0"]').checked, true);
    assert.equal(f.select('[data-prompt-toggle="1"]').checked, false);
    assert.equal(f.select('[data-prompt-toggle="3"]').hidden, true);
    assert.equal(f.select('[data-prompt-add="3"]').hidden, false);
    assert.equal(f.selectAll('.nora-preset-locked').length, 1);
    assert.equal(f.selectAll('summary input, summary button').length, 0, 'Expanding text is independent of toggling');
    assert.equal(f.selectAll('unsafe').length, 0, 'Prompt content is escaped');
    assert.equal(f.select('[data-save]'), null, 'World editor has one apply action');
    assert.ok(f.select('[data-change-preset]'));
    assert.ok(f.select('[data-save-as]'));
});

test('toggle edits remain drafts, can be reversed, and are applied in one save', async () => {
    const f = fixture(); await open(f);
    const input = f.select('[data-prompt-toggle="0"]');
    input.checked = false; await input.fire('change');
    assert.equal(f.writes.length, 0);
    assert.equal(f.select('[data-preset-state]').textContent, tr('未保存'));
    assert.equal(f.select('[data-apply]').textContent, tr('保存'));
    input.checked = true; await input.fire('change');
    assert.equal(f.select('[data-apply]').disabled, true);
    input.checked = false; await input.fire('change');
    f.select('.nora-preset-prompts').open = true;
    f.select('[data-prompt-row="0"] details').open = true;
    f.select('.nora-preset-detail-scroll').scrollTop = 140;
    await f.select('[data-apply]').fire('click');
    assert.equal(f.writes[0].options.expectedRevision, 1);
    assert.equal(f.writes[0].patch.preset.preset.prompt_order[0].order[0].enabled, false);
    assert.equal(f.template().prompt_order[0].order[0].enabled, true, 'World edit never writes the template');
    assert.equal(f.select('[data-prompt-toggle="0"]').checked, false);
    assert.equal(f.select('[data-prompt-row="0"] details').open, true);
    assert.equal(f.select('.nora-preset-detail-scroll').scrollTop, 140);
});

test('library edits save only a template, and leaving a draft requires consent', async () => {
    const f = fixture(false); await open(f);
    const input = f.select('[data-prompt-toggle="1"]'); input.checked = true; await input.fire('change');
    f.confirm(false); assert.equal(await f.canLeave(), false);
    await f.select('[data-back]').fire('click');
    assert.notEqual(f.select('[data-prompt-toggle="1"]'), null);
    await f.select('[data-apply]').fire('click');
    assert.equal(f.writes[0].options.apply, false);
    assert.equal(f.select('[data-prompt-toggle="1"]').checked, true);
    assert.equal(f.select('[data-apply]').textContent, tr('保存模板'));
    assert.equal(f.world().preset.preset.prompt_order[0].order[1].enabled, false);
});

test('explicitly adding an unlisted prompt remains a change even if then disabled', async () => {
    const f = fixture(false); await open(f);
    await f.select('[data-prompt-add="3"]').fire('click');
    const input = f.select('[data-prompt-toggle="3"]'); input.checked = false; await input.fire('change');
    await f.select('[data-apply]').fire('click');
    assert.deepEqual(f.writes[0].changes, [{ identifier: 'c', enabled: false, add: true }]);
});

test('failed writes retain draft controls; partial application is explicitly reported', async () => {
    for (const saved of [false, true]) {
        const f = fixture(); await open(f);
        const input = f.select('[data-prompt-toggle="0"]'); input.checked = false; await input.fire('change');
        f.fail(Object.assign(new Error('failure'), { saved }));
        await f.select('[data-apply]').fire('click');
        assert.equal(input.checked, false); assert.equal(input.disabled, false);
        assert.equal(f.select('[data-apply]').disabled, false);
        assert.equal(f.select('[data-preset-state]').textContent, tr(saved ? '已保存，待应用' : '未保存'));
        assert.deepEqual(f.notices, ['failure']);
    }
});

test('an unchanged template has no apply action that can change a World', async () => {
    const f = fixture(false); await open(f);
    f.fail(new Error('apply failure'));
    await f.select('[data-apply]').fire('click');
    assert.equal(f.select('[data-apply]').disabled, true);
    assert.equal(f.writes.length, 0);
});

test('editing back to the original value after partial save still persists the correction', async () => {
    const f = fixture(); await open(f);
    const input = f.select('[data-prompt-toggle="0"]'); input.checked = false; await input.fire('change');
    f.fail(Object.assign(new Error('apply failure'), { saved: true }));
    await f.select('[data-apply]').fire('click');
    f.confirm(false); assert.equal(await f.canLeave(), false);
    f.fail(null); input.checked = true; await input.fire('change');
    await f.select('[data-apply]').fire('click');
    assert.equal(f.writes[1].patch.preset.preset.prompt_order[0].order[0].enabled, true);
    assert.equal(f.writes[1].options.expectedRevision, 2);
});

test('choosing a template previews in the editor and only changes the World after Save', async () => {
    const f = fixture(); await open(f);
    await f.select('[data-change-preset]').fire('click');
    await f.select('[data-choice="1"]').fire('click');
    assert.equal(f.writes.length, 0);
    assert.equal(f.select('[data-use]'), null, 'No extra confirmation page');
    assert.equal(f.select('[data-preset-chooser]').hidden, true);
    assert.equal(f.select('[data-current-preset]').textContent, 'Other');
    assert.equal(f.opens(), 1, 'Selection does not navigate to another modal view');
    assert.equal(f.writes.length, 0);
    assert.equal(f.world().preset.name, 'Test');
    assert.equal(f.select('[data-apply]').disabled, false);
    await f.select('[data-apply]').fire('click');
    assert.equal(f.world().preset.name, 'Other');
    assert.equal(f.world().preset.preset.temperature, 0.9);
    assert.equal(f.world().preset.modified, false);
});

test('closing the template chooser preserves the World draft', async () => {
    const f = fixture(); await open(f);
    const input = f.select('[data-prompt-toggle="0"]'); input.checked = false; await input.fire('change');
    await f.select('[data-change-preset]').fire('click');
    assert.equal(await f.canLeave(), false);
    assert.equal(f.select('[data-prompt-toggle="0"]').checked, false);
    assert.equal(f.select('[data-apply]').disabled, false);
    assert.equal(f.writes.length, 0);
});

test('save as creates a template without applying the World draft', async () => {
    const f = fixture(); await open(f);
    const input = f.select('[data-prompt-toggle="0"]'); input.checked = false; await input.fire('change');
    await f.select('[data-save-as]').fire('click');
    f.select('[name="name"]').value = 'My template';
    await f.select('form').fire('submit');
    assert.equal(f.imports[0][0], 'My template');
    assert.equal(f.imports[0][1].prompt_order[0].order[0].enabled, false);
    assert.equal(f.writes.length, 0);
    assert.equal(f.world().preset.preset.prompt_order[0].order[0].enabled, true);
    assert.equal(f.select('[data-prompt-toggle="0"]').checked, false);
});

test('stale World editor cannot apply to a newly selected World', async () => {
    const f = fixture(); await open(f);
    const input = f.select('[data-prompt-toggle="0"]'); input.checked = false; await input.fire('change');
    f.changeWorld('b');
    await f.select('[data-apply]').fire('click');
    assert.equal(f.writes.length, 0);
    assert.deepEqual(f.notices, [tr('当前世界已改变，请重新打开编辑。')]);
});

test('World parameters edit as one draft, link sliders, and save without changing the template', async () => {
    const f = fixture(); await open(f);
    assert.equal(f.selectAll('[data-preset-parameter]').length, 4);
    assert.equal(f.select('[data-advanced-parameters]').open, false);
    const set = async (key, value, range = false) => {
        const input = f.select(`[data-preset-${range ? 'range' : 'parameter'}="${key}"]`);
        input.value = String(value); await input.fire('input');
    };
    await set('temperature', 0, true);
    assert.equal(f.select('[data-preset-parameter="temperature"]').value, '0');
    await set('top_p', 0.8);
    assert.equal(f.select('[data-preset-range="top_p"]').value, '0.8');
    await set('openai_max_tokens', 4096); await set('openai_max_context', 65536);
    assert.equal(f.writes.length, 0);
    f.confirm(false); assert.equal(await f.canLeave(), false);
    f.select('[data-advanced-parameters]').open = true;
    await f.select('[data-apply]').fire('click');
    for (const [key, value] of Object.entries({ temperature: 0, top_p: 0.8, openai_max_tokens: 4096, openai_max_context: 65536 })) {
        assert.equal(f.world().preset.preset[key], value);
        assert.equal(f.select(`[data-preset-parameter="${key}"]`).value, String(value));
    }
    assert.equal(f.template().temperature, 0.5);
    assert.equal(f.template().openai_max_context, 32768);
    assert.equal(f.select('[data-advanced-parameters]').open, true);
    assert.equal(f.select('[data-apply]').disabled, true);
});

test('invalid generation parameters cannot apply or save as a template', async () => {
    for (const [key, value] of [['temperature', ''], ['top_p', '1.5'], ['openai_max_tokens', '1.1'], ['openai_max_context', '1024']]) {
        const f = fixture(); await open(f);
        const input = f.select(`[data-preset-parameter="${key}"]`); input.value = value; await input.fire('input');
        assert.equal(f.select('[data-parameter-error]').hidden, false);
        assert.equal(f.select('[data-apply]').disabled, true);
        assert.equal(f.select('[data-save-as]').disabled, true);
        await f.select('[data-apply]').fire('click');
        await f.select('[data-save-as]').fire('click');
        assert.equal(f.writes.length, 0); assert.equal(f.imports.length, 0);
    }
});

test('World parameter drafts survive chooser navigation and recover after failed saving', async () => {
    const f = fixture(); await open(f);
    const input = f.select('[data-preset-parameter="openai_max_tokens"]'); input.value = '4000'; await input.fire('input');
    await f.select('[data-change-preset]').fire('click'); await f.canLeave();
    assert.equal(f.select('[data-preset-parameter="openai_max_tokens"]').value, '4000');
    f.fail(new Error('write failed')); await f.select('[data-apply]').fire('click');
    assert.equal(f.select('[data-preset-parameter="openai_max_tokens"]').value, '4000');
    assert.equal(f.select('[data-preset-parameter="openai_max_tokens"]').disabled, false);
    f.fail(null); await f.select('[data-apply]').fire('click');
    assert.equal(f.world().preset.preset.openai_max_tokens, 4000);
});

test('footer has one primary command per mode; copying expands in the same sheet', async () => {
    const f = fixture(); await open(f);
    assert.deepEqual(f.selectAll('[data-editor-actions] button').map(node => node.textContent), [tr('另存到预设库'), tr('取消'), tr('保存')]);
    assert.equal(f.selectAll('[data-editor-actions] .nora-primary').length, 1);
    assert.equal(f.select('[data-save-preset-form]').hidden, true);
    await f.select('[data-save-as]').fire('click');
    assert.equal(f.select('[data-editor-actions]').hidden, true);
    assert.equal(f.select('[data-save-preset-form]').hidden, false);
    assert.equal(f.opens(), 1);
    await f.select('[data-copy-cancel]').fire('click');
    assert.equal(f.select('[data-editor-actions]').hidden, false);
    assert.equal(f.select('[data-save-preset-form]').hidden, true);
    assert.equal(f.focused(), f.select('[data-save-as]'));
    assert.equal(f.writes.length + f.imports.length, 0);
});

test('inline chooser searches, marks the current choice and never resets it on reselection', async () => {
    const f = fixture(); await open(f);
    const input = f.select('[data-preset-parameter="temperature"]'); input.value = '0.2'; await input.fire('input');
    await f.select('[data-change-preset]').fire('click');
    assert.equal(f.select('[data-change-preset]').getAttribute('aria-expanded'), 'true');
    assert.equal(f.select('[data-choice="0"]').getAttribute('aria-current'), 'true');
    const search = f.select('[data-search]'); search.value = ' oTHer '; await search.fire('input');
    assert.equal(f.selectAll('[data-choice]').length, 1);
    assert.ok(f.select('[data-choice="1"]'));
    search.value = 'missing'; await search.fire('input');
    assert.equal(f.selectAll('[data-choice]').length, 0);
    assert.equal(f.select('[data-results]').textContent, tr('没有匹配的预设'));
    search.value = ''; await search.fire('input');
    await f.select('[data-choice="0"]').fire('click');
    assert.equal(f.select('[data-preset-parameter="temperature"]'), input, 'Keep the same draft controls');
    assert.equal(input.value, '0.2');
    assert.equal(f.select('[data-change-preset]').getAttribute('aria-expanded'), 'false');
    assert.equal(f.opens(), 1);
});

test('Escape closes only the inline panel, retaining draft values, expanded prompts and focus', async () => {
    const f = fixture(); await open(f);
    const input = f.select('[data-prompt-toggle="0"]'); input.checked = false; await input.fire('change');
    f.select('[data-prompt-row="0"] details').open = true;
    for (const [trigger, panel] of [['data-change-preset', 'data-preset-chooser'], ['data-save-as', 'data-save-preset-form']]) {
        await f.select(`[${trigger}]`).fire('click');
        let stopped = false;
        await f.select(`[${panel}]`).fire('keydown', { key: 'Escape', stopPropagation() { stopped = true; } });
        assert.equal(stopped, true);
        assert.equal(f.select(`[${panel}]`).hidden, true);
        assert.equal(f.focused(), f.select(`[${trigger}]`));
        assert.equal(f.select('[data-prompt-toggle="0"]'), input);
        assert.equal(input.checked, false);
        assert.equal(f.select('[data-prompt-row="0"] details').open, true);
    }
    assert.equal(f.closes(), 0);
    assert.equal(f.opens(), 1);
});

test('Cancel confirms draft discard and never writes to the World or template', async () => {
    const f = fixture(); await open(f);
    const input = f.select('[data-prompt-toggle="0"]'); input.checked = false; await input.fire('change');
    f.confirm(false); await f.select('[data-editor-cancel]').fire('click');
    assert.equal(f.closes(), 0); assert.equal(input.checked, false);
    f.confirm(true); await f.select('[data-editor-cancel]').fire('click');
    assert.equal(f.closes(), 1);
    assert.equal(f.writes.length + f.imports.length, 0);
});

test('copy errors keep the name and draft in place; retry stores only the library copy', async () => {
    const f = fixture(); await open(f);
    await f.select('[data-change-preset]').fire('click'); await f.select('[data-choice="1"]').fire('click');
    const input = f.select('[data-preset-parameter="openai_max_tokens"]'); input.value = '4000'; await input.fire('input');
    await f.select('[data-save-as]').fire('click');
    f.select('[name="name"]').value = 'Taken'; f.failImport(new Error('Name already exists'));
    await f.select('[data-save-preset-form]').fire('submit');
    assert.equal(f.select('[data-copy-error]').hidden, false);
    assert.equal(f.select('[data-copy-error]').textContent, 'Name already exists');
    assert.equal(f.select('[name="name"]').value, 'Taken');
    assert.equal(f.select('[data-save-preset-form]').hidden, false);
    assert.equal(input.value, '4000');
    f.failImport(null); f.select('[name="name"]').value = 'New copy';
    await f.select('[data-save-preset-form]').fire('submit');
    assert.equal(f.imports[0][1].openai_max_tokens, 4000);
    assert.equal(f.imports[0][1].temperature, 0.9);
    assert.equal(f.select('[data-current-preset]').textContent, 'Other');
    assert.equal(f.world().preset.name, 'Test');
    assert.equal(f.opens(), 1); assert.equal(f.writes.length, 0);
    await f.select('[data-apply]').fire('click');
    assert.equal(f.world().preset.name, 'Other');
    assert.equal(f.world().preset.modified, true);
    assert.equal(f.world().preset.preset.openai_max_tokens, 4000);
});

test('choosing after a partially applied save preserves the updated revision', async () => {
    const f = fixture(); await open(f);
    const input = f.select('[data-prompt-toggle="0"]'); input.checked = false; await input.fire('change');
    f.fail(Object.assign(new Error('apply failed'), { saved: true }));
    await f.select('[data-apply]').fire('click');
    f.fail(null);
    await f.select('[data-change-preset]').fire('click'); await f.select('[data-choice="1"]').fire('click');
    await f.select('[data-apply]').fire('click');
    assert.equal(f.writes[1].options.expectedRevision, 2);
    assert.equal(f.world().preset.name, 'Other');
});
