import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { createPanelController } from '../../../native-extensions/nora-ui/panel-controller.js';
import { createLedgerRequest } from '../../../native-extensions/nora-ui/extension-controller.js';
import { createCharacterController } from '../../../native-extensions/nora-ui/character-controller.js';
import { createWorldbookController } from '../../../native-extensions/nora-ui/worldbook-controller.js';
import { createRegexController } from '../../../native-extensions/nora-ui/regex-controller.js';
import { createWorldController } from '../../../native-extensions/nora-ui/world-controller.js';
import { createModelController } from '../../../native-extensions/nora-ui/model-controller.js';
import { translate as tr, t } from '../public/scripts/nora-i18n/core.js';
import { validateControl } from '../public/scripts/nora-controls/contract.js';
import { builtinPlugins } from '../src/nora-extension-library.js';

test('ledger transport limits actions, preserves authoritative scope and surfaces server errors', async () => {
    const requests = [];
    let ok = true;
    const request = createLedgerRequest({
        requestHeaders: () => ({ 'x-fixture': 'yes' }),
        fetchImpl: async (url, options) => {
            requests.push({ url, ...options });
            return { ok, json: async () => ok ? { enabled: true } : { error: 'denied', code: 'CONFLICT' } };
        },
    });
    await assert.rejects(request('delete', {}), /Unsupported ledger action/);
    assert.equal(requests.length, 0);
    assert.deepEqual(await request('configure', { worldId: 'current' }, { worldId: 'wrong', enabled: true }), { enabled: true });
    assert.equal(requests[0].url, '/api/nora-story-ledger/configure');
    assert.equal(JSON.parse(requests[0].body).worldId, 'current');
    assert.equal(requests[0].headers['x-fixture'], 'yes');
    ok = false;
    await assert.rejects(request('inspect', {}), { message: 'denied', code: 'CONFLICT' });
});

function fixture() {
    let $;
    const nodes = new WeakMap();
    function wrap(el) {
        if (!el) return null;
        if (nodes.has(el)) return nodes.get(el);
        const node = {
            el, handlers: {}, classList: { toggle() {}, add() {}, remove() {} },
            get isConnected() { return $.root().find('*').toArray().includes(el); },
            get dataset() { return Object.fromEntries(Object.entries(el.attribs || {}).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value])); },
            get value() { return $(el).val(); }, set value(value) { $(el).val(value); },
            get checked() { return $(el).prop('checked'); }, set checked(value) { $(el).prop('checked', value); },
            get elements() { return { namedItem: name => select(`[name="${name}"]`, node) }; },
            get innerHTML() { return $(el).html(); }, set innerHTML(value) { $(el).html(value); },
            get textContent() { return $(el).text(); }, set textContent(value) { $(el).text(value); },
            click() { this.clicks = (this.clicks || 0) + 1; this.handlers.click?.(); },
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
        dialogs: { version: 0, open(_title, markup, _className, { back, backLabel = tr('返回') } = {}) { this.version++; $ = load(`${markup.includes('id="nora-panel-body"') ? '' : '<aside id="nora-panel-body"></aside>'}<main><header>${back ? '<button type="button" data-sheet-back></button>' : ''}</header><div class="nora-sheet-body">${markup}</div></main>`); if (back) { select('[data-sheet-back]').textContent = backLabel; select('[data-sheet-back]').addEventListener('click', back); } return wrap($('main')[0]); },
            setCloseGuard() {},
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
    assert.equal(f.query('[data-action="extensions"]').attr('aria-label'), tr('扩展管理'));
    f.world.capabilities.declared = [];
    panel.render();
    assert.equal(f.query('[data-action="extensions"]').length, 1, 'Ordinary worlds retain the script import entry');
});

test('sidebar opens chat backups through its own data entry without replacing library or extension controls', () => {
    const f = fixture(), opened = [];
    f.common.dialogs.open('panel', '<div id="nora-panel-body"></div>');
    f.world.storyContext = { characters: [] };
    const panel = createPanelController({ ...f.common,
        currentCharacter: () => ({}), readState: () => ({}), settings: () => ({}),
        currentWorldPersona: () => ({}), worldbookSummary: () => '', closeDrawers() {},
        openBackups: () => opened.push('backups'),
        worldbookController: { open() {} },
    });
    panel.render();
    assert.equal(f.query('[data-action="backups"]').length, 1);
    assert.equal(f.query('[data-action="library"]').length, 1);
    assert.equal(f.query('[data-action="extensions"]').length, 1);
    f.select('[data-action="backups"]').handlers.click({ stopPropagation() {} });
    assert.deepEqual(opened, ['backups']);
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

function extensionFixture(options = {}) {
    const f = fixture(), opened = [], retried = [], commands = [];
    f.world.name = '法特利亚大陆';
    let modelOpens = 0, modelArgs;
    const code = '\n</textarea><script>doNotRun()</script>';
    f.world.capabilities = { declared: ['regex', 'tavern_helper', 'mvu', 'prompt_template'], items: { regex: { status: 'DEGRADED' } } };
    const panel = createPanelController({ ...f.common,
        currentCharacter: () => ({ avatar: 'a.png' }), readState: () => ({}), settings: () => ({}),
        currentWorldPersona: () => ({}), worldbookSummary: () => '', worldbookController: { open() {} }, closeDrawers() {},
        escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
        executeControl: async command => {
            validateControl(command);
            commands.push(command);
            if (f.execute) return f.execute(command);
            if (command.action === 'regex.list') return { scripts: [{ disabled: false }, { disabled: true }] };
            if (command.action === 'mvu.status') return { managedRuntimeEnabled: true, runtimeAvailable: true };
            if (command.action === 'scripts.inspect') return { script: { type: 'script', name: '<script name>', content: code } };
            if (command.params.scope === 'global') return { trees: [{ id: 'nora-mvu-headless-runtime', name: 'Managed MVU', enabled: true }], revision: 'global-r1', source: 'global', enabled: true };
            return { trees: [{ id: 'one', type: 'script', name: '<script name>', enabled: false },
                { id: 'nora-mvu-headless-runtime', name: 'Managed MVU', enabled: true }], revision: 'r1', source: 'Card', enabled: true };
        },
        openCardRegex: (...args) => opened.push(args), openModelSheet: (...args) => { modelArgs = args; modelOpens++; },
        retryWorldCapability: async (...args) => { retried.push(args); await f.onRetry?.(); },
        ...options,
    });
    f.common.dialogs.open('panel', '<div id="nora-panel-body"></div>');
    panel.render();
    const open = () => f.select('[data-action="extensions"]').handlers.click({ stopPropagation() {} });
    return Object.assign(f, { panel, open, code, opened, retried, commands, modelOpens: () => modelOpens, modelArgs: () => modelArgs });
}

test('extension gear presents uniform navigation, with isolated read-only script details', async () => {
    const f = extensionFixture(); f.open();
    assert.equal(f.query('[data-extension]').length, 5);
    assert.deepEqual(f.query('[data-extension] strong').toArray().map(el => f.query(el).text().trim()), Object.values(builtinPlugins).map(item => tr(item.title)));
    assert.equal(f.query('.nora-extension-world').length, 1);
    assert.equal(f.query('.nora-extension-icon, [data-extension] small').length, 15);
    assert.equal(f.query('.nora-extension-entry-state, [data-all-scripts], [data-add-script], footer').length, 0, 'No duplicate script entry, import button or disclaimer in populated overview');
    assert.equal(f.query('[data-extension] > .fa-chevron-right').length, 5);
    assert.equal(f.query('script, textarea').length, 0);
    f.select('[data-extension="mvu"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-mvu-runtime-toggle]').length, 1);
    f.select('[data-mvu-model-settings]').handlers.click(); assert.equal(f.modelOpens(), 1);
    assert.equal(f.modelArgs()[1].backLabel, tr('返回 MVU 设置'));
    f.select('[data-sheet-back]').handlers.click();
    f.select('[data-extension="regex"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    f.select('[data-regex-scope="character"]').handlers.click();
    assert.equal(f.opened[0][0], 'a.png');
    assert.equal(f.opened[0][2].backLabel, tr('返回正则规则'));
    f.opened[0][1]();
    await new Promise(resolve => setImmediate(resolve));
    f.select('[data-sheet-back]').handlers.click();
    f.select('[data-extension="tavern_helper"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-script-toggle="nora-mvu-headless-runtime"]').length, 0);
    await f.select('[data-script-inspect="one"]').handlers.click();
    assert.equal(f.query('script, textarea:not([readonly])').length, 0);
    assert.equal(f.query('textarea').val(), f.code);
    assert.equal(f.query('h3').text(), '<script name>');
    assert.ok(f.commands.every(command => command.confirm === false));
    f.select('[data-sheet-back]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    const oldInspect = f.select('[data-script-inspect="one"]');
    const count = f.commands.length;
    f.world.id = 'other'; await oldInspect.handlers.click();
    assert.equal(f.commands.length, count, 'Stale dialog cannot read or mutate the next world');
});

function pluginFixture() {
    const items = Object.entries(builtinPlugins).map(([name, builtin]) => ({ name, builtin, managed: true }));
    items.push({ name: 'third-party/example', displayName: 'Example', editable: true });
    const opened = [];
    return { items, opened, catalog: async () => items, manage: (item, options) => { opened.push({ item, options }); } };
}

test('extension management separates world-related features from other installed plugins without duplicating them', async () => {
    const plugins = pluginFixture();
    const calls = [];
    const f = extensionFixture({ plugins, ledgerRequest: async (action, scope) => {
        calls.push({ action, scope }); return { enabled: true, active: { coveredTurns: 5 } };
    } });
    f.open(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-extension]').length, 5);
    assert.equal(f.query('[data-installed-plugin]').length, 1);
    assert.equal(f.query('[data-installed-plugin="third-party/example"]').length, 1);
    assert.deepEqual(calls.map(call => call.action), ['inspect']);
    f.select('[data-extension="tavern_helper"]').handlers.click();
    assert.equal(plugins.opened[0].item.builtin.key, 'tavern_helper');
    assert.equal(typeof plugins.opened[0].options.openSettings, 'function');
    f.world.id = 'new-world';
    assert.equal(plugins.opened[0].options.isCurrent(), false);
    plugins.opened[0].options.openSettings();
    assert.equal(f.query('[data-script-content]').length, 0, 'A stale feature shortcut cannot change another world');
});

test('an ordinary world keeps the same builtin entries and a separate third-party list', async () => {
    const plugins = pluginFixture();
    const f = extensionFixture({ plugins, ledgerRequest: async () => ({ enabled: false, active: null }) });
    f.world.capabilities = { declared: [], items: {} };
    f.execute = async command => {
        if (command.action === 'scripts.list') throw Object.assign(new Error('not loaded'), { code: 'NORA_HELPER_NOT_READY' });
        if (command.action === 'regex.list') return { scripts: [], allowed: false };
        throw new Error('Unexpected control');
    };
    f.open(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-extension]').length, 5);
    assert.equal(f.query('[data-installed-plugin]').length, 1);
    assert.ok(f.commands.every(command => !command.confirm));
    f.select('[data-installed-plugin="third-party/example"]').handlers.click();
    assert.equal(plugins.opened[0].item.name, 'third-party/example');
    f.select('[data-extension="tavern_helper"]').handlers.click();
    assert.equal(plugins.opened[1].item.builtin.key, 'tavern_helper', 'Import must use the same explicit Helper loading gate');
});

test('without a world, extension management permits global management without world-bound requests', async () => {
    const plugins = pluginFixture();
    const f = extensionFixture({ plugins, activeWorldModel: () => null, ledgerRequest: () => { throw new Error('No world'); } });
    f.panel.openExtensions(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-extension]').length, 5);
    assert.equal(f.query('[data-installed-plugin]').length, 1);
    assert.equal(f.commands.length, 0);
    f.select('[data-installed-plugin="third-party/example"]').handlers.click();
    assert.equal(plugins.opened[0].item.name, 'third-party/example');
});

test('ledger settings inspect only, confirm changes scoped to the same session, preserve specialised controls', async () => {
    const calls = [];
    let enabled = true;
    const f = extensionFixture({ plugins: pluginFixture(), readState: () => ({ world: { metadata: { nora_session: { id: 'session:a' } } } }),
        ledgerRequest: async (action, scope, params) => {
            calls.push({ action, scope, params });
            if (action === 'configure') enabled = params.enabled;
            return { enabled, configRevision: 0, effectiveConfig: { contextLimitOverride: null, outputTokenLimit: 2048, timeoutSeconds: 300 }, active: { coveredTurns: 5 } };
        } });
    f.open(); await new Promise(resolve => setImmediate(resolve));
    f.select('[data-extension="ledger"]').handlers.click(); await new Promise(resolve => setImmediate(resolve));
    assert.ok(calls.every(call => call.action === 'inspect'));
    assert.equal(f.query('[data-mvu-runtime-toggle]').length, 0);
    assert.equal(f.query('[data-ledger-toggle]').length, 1);
    assert.equal(f.query('.nora-ledger-enabled [data-ledger-toggle]').length, 1);
    assert.equal(f.query('[data-ledger-metric]').length, 1);
    assert.equal(f.query('[data-ledger-toggle]').attr('type'), 'checkbox');
    f.common.dialogs.confirm = async () => true;
    f.select('[data-ledger-toggle]').checked = false;
    await f.select('[data-ledger-toggle]').handlers.change();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.find(call => call.action === 'configure'), { action: 'configure', scope: { worldId: 'world:a', sessionId: 'session:a' }, params: { enabled: false, expectedRevision: 0 } });
    assert.ok(f.query('[data-ledger-content]').text().includes(tr('自动整理')));
    const before = calls.length;
    f.common.dialogs.confirm = async () => { f.world.id = 'other'; return true; };
    f.select('[data-ledger-toggle]').checked = true;
    await f.select('[data-ledger-toggle]').handlers.change();
    assert.equal(calls.length, before, 'Switching world during confirmation must not mutate either session');
});

test('ledger read errors allow retry and a late result cannot overwrite another sheet', async () => {
    let fail = true, resolve;
    const f = extensionFixture({ plugins: pluginFixture(), ledgerRequest: async () => {
        if (fail) throw new Error('ledger unavailable');
        return new Promise(done => { resolve = done; });
    } });
    f.open(); await new Promise(resolve => setImmediate(resolve));
    f.select('[data-extension="ledger"]').handlers.click(); await new Promise(resolve => setImmediate(resolve));
    assert.match(f.query('[role="alert"]').text(), /ledger unavailable/);
    fail = false;
    f.select('[data-ledger-retry]').handlers.click();
    f.common.dialogs.open('another', '<div id="different"></div>');
    resolve({ enabled: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('#different').length, 1);
    assert.equal(f.query('[data-ledger-toggle]').length, 0);
});

test('overview summaries use real counts and update mode without rebuilding focused entry nodes', async () => {
    const f = extensionFixture();
    f.world.capabilities = { declared: ['regex', 'tavern_helper', 'mvu'], items: {} };
    f.execute = async command => {
        if (command.action === 'regex.list') return { scripts: command.params.scope === 'character' ? [{ disabled: false }, { disabled: true }, { disabled: false }] : [], allowed: true };
        if (command.action === 'mvu.status') return { managedRuntimeEnabled: true, runtimeAvailable: true, enabled: true };
        return { trees: command.params.scope === 'character' ? [{ type: 'folder', scripts: [{ id: 'a' }, { id: 'b' }] }] : [{ id: 'nora-mvu-headless-runtime' }, { id: 'user-global' }], enabled: true };
    };
    f.open();
    const originalButton = f.select('[data-extension="regex"]');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.select('[data-extension="regex"]'), originalButton);
    assert.equal(f.query('[data-extension-summary="regex"]').text(), t`${3} 条规则 · 启用 ${2} 条`);
    assert.equal(f.query('[data-extension-summary="tavern_helper"]').text(), `${t`${tr('本世界')}：${2} 个，启用 ${2} 个`} · ${t`${tr('全局')}：${1} 个，启用 ${1} 个`}`);
    assert.equal(f.query('[data-extension-summary="mvu"]').text(), tr('程序已加载 · 额外模型更新'));
    assert.equal(f.query('[data-extension]').length, 5);
    assert.equal(f.query('footer, [data-add-script], [data-all-scripts], .nora-extension-entry-state').length, 0);
});

test('failed overview reads remain actionable instead of showing zero or ready', async () => {
    const f = extensionFixture();
    f.execute = async () => { throw new Error('offline'); };
    f.open();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-extension-summary="regex"]').text(), tr('规则读取失败，点击查看'));
    assert.equal(f.query('[data-extension-summary="tavern_helper"]').text(), tr('脚本读取失败，点击重试'));
    assert.equal(f.query('[data-extension-summary="mvu"]').text(), tr('状态读取失败，点击查看'));
    assert.equal(f.query('[data-extension]').length, 5);
    assert.equal(f.commands.some(command => command.confirm), false);
});

test('ordinary worlds keep all builtins visible without duplicate script import actions', async () => {
    const f = extensionFixture();
    f.world.capabilities = { declared: [], items: { prompt_template: { status: 'READY' } } };
    f.execute = async () => ({ trees: [{ id: 'nora-mvu-headless-runtime', enabled: true }], enabled: true });
    f.open();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-extension]').length, 5);
    assert.equal(f.query('[data-found-scripts], [data-add-script]').length, 0);
    assert.equal(f.query('[data-all-scripts]').length, 0);
    f.select('[data-extension="tavern_helper"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    f.select('[data-script-import]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-script-destination]').val(), 'character');
});

test('a never-loaded Helper is not a broken or enabled capability of a plain world', async () => {
    const f = extensionFixture();
    f.world.capabilities = { declared: [], items: {} };
    f.execute = async command => {
        if (command.action === 'scripts.list') throw Object.assign(new Error('not active'), { code: 'NORA_HELPER_NOT_READY' });
        return { scripts: [], allowed: false };
    };
    f.open();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-extension]').length, 5);
    assert.equal(f.query('[data-add-script]').length, 0);
    assert.ok(!f.query('[data-extension-summary="tavern_helper"]').text().includes(tr('脚本读取失败，点击重试')));
    assert.equal(f.commands.some(command => command.confirm || !command.action.endsWith('.list')), false);
});

test('scoped menu distinguishes configured scripts from enabled usage and respects regex permission', async () => {
    const f = extensionFixture();
    f.world.capabilities = { declared: [], items: {} };
    f.world.preset = { preset: { extensions: { tavern_helper: { scripts: [] } } } };
    f.execute = async command => {
        const scope = command.params.scope;
        if (command.action === 'regex.list') return { scripts: scope === 'global' ? [{}] : [], allowed: scope === 'global' };
        return { trees: scope === 'character' ? [] : [{ type: 'script', id: 'user', enabled: true }], enabled: scope === 'global' };
    };
    f.open(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-extension-summary="tavern_helper"]').text(), `${t`${tr('当前预设')}：${1} 个，启用 ${0} 个`} · ${t`${tr('全局')}：${1} 个，启用 ${1} 个`}`);
    assert.equal(f.query('[data-extension-summary="regex"]').text(), t`${1} 条规则 · 启用 ${1} 条`);
    assert.equal(f.commands.some(command => command.confirm), false);
});

test('switching to a plain world cannot retain the previous world Helper declaration or resident managed MVU', async () => {
    const f = extensionFixture();
    f.open(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-extension="tavern_helper"]').length, 1);
    f.world.id = 'plain-world';
    f.world.capabilities = { declared: [], items: { tavern_helper: { status: 'READY' }, mvu: { status: 'READY' } } };
    f.execute = async command => command.action === 'regex.list' ? { scripts: [], allowed: true }
        : { trees: [{ id: 'nora-mvu-headless-runtime', enabled: true }], enabled: true };
    f.panel.openExtensions(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-extension]').length, 5);
    assert.equal(f.query('[data-add-script]').length, 0);
    assert.equal(f.query('[data-extension-summary="mvu"]').text(), tr('当前世界未声明使用'));
});

test('declared failed templates stay visible with a failure state rather than hiding installed components', () => {
    const f = extensionFixture();
    f.world.capabilities = { declared: ['prompt_template'], items: { prompt_template: { status: 'DEGRADED' } } };
    f.open();
    assert.equal(f.query('[data-extension]').length, 5);
    assert.ok(f.query('[data-extension="prompt_template"]').text().includes(tr('世界能力未就绪')));
    f.select('[data-extension="prompt_template"]').handlers.click();
    assert.equal(f.query('[data-template-retry]').length, 1);
});

test('global user scripts are discoverable without a card declaration; late probes cannot replace detail pages', async () => {
    const f = extensionFixture();
    f.world.capabilities = { declared: [], items: {} };
    f.execute = async command => ({ trees: command.params.scope === 'global' ? [{ id: 'user-script', enabled: false }] : [] });
    f.open();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-extension="tavern_helper"]').length, 1);
    assert.equal(f.query('[data-extension-empty]').text(), '');
    const pending = [];
    f.execute = () => new Promise(resolve => pending.push(resolve));
    f.panel.render();
    f.open();
    f.common.dialogs.open('Other', '<div id="other"></div>');
    pending.forEach(resolve => resolve({ trees: [{ id: 'late' }] }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('#other').length, 1);
    assert.equal(f.query('[data-extension="tavern_helper"]').length, 0);
});

test('MVU runtime switching uses its own confirmed command, requires reload and never toggles the extra model', async () => {
    const f = extensionFixture(); let enabled = true, prompt;
    f.execute = async command => {
        if (command.action === 'mvu.status') return { managedRuntimeEnabled: enabled, runtimeAvailable: true };
        if (command.action === 'mvu.runtime') { enabled = command.params.enabled; return { reloadRequired: true }; }
        throw new Error('Unexpected command');
    };
    f.common.dialogs.confirm = async input => { prompt = input; return true; };
    f.open(); f.select('[data-extension="mvu"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-mvu-enabled]').length, 0);
    await f.select('[data-mvu-runtime-toggle]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prompt.body, tr('此操作影响所有世界。停用后依赖内置 MVU 的卡片无法正常更新变量。更改后需要刷新页面；不会自动发送消息或修改卡片。'));
    assert.deepEqual(f.commands.filter(command => command.confirm).map(command => [command.action, command.params]), [['mvu.runtime', { enabled: false }]]);
    assert.ok(f.query('[data-mvu-runtime-content]').text().includes(tr('设置已保存，请刷新页面后继续使用。')));
    assert.equal(f.query('[data-mvu-model-settings][disabled]').length, 1);
    f.select('[data-sheet-back]').handlers.click();
    f.select('[data-extension="mvu"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-mvu-model-settings][disabled]').length, 1, 'Reload requirement persists after navigating back');
});

test('MVU read failure exposes retry; cancelled or stale confirmation cannot change runtime', async () => {
    const f = extensionFixture();
    f.execute = async () => { throw new Error('offline'); };
    f.open(); f.select('[data-extension="mvu"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-mvu-runtime-toggle]').length, 0);
    assert.equal(f.query('[data-mvu-runtime-retry]').length, 1);
    f.execute = null;
    f.select('[data-mvu-runtime-retry]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    f.common.dialogs.confirm = async () => false;
    await f.select('[data-mvu-runtime-toggle]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    f.common.dialogs.confirm = async () => { f.world.id = 'other'; return true; };
    await f.select('[data-mvu-runtime-toggle]').handlers.click();
    assert.equal(f.commands.filter(command => command.confirm).length, 0);
});

test('script manager explains taken-over cores, preserves schemas, namesakes and active conflicts', async () => {
    const f = extensionFixture(); f.open();
    f.execute = async () => ({ trees: [
        { id: 'nora-mvu-headless-runtime', name: 'Managed MVU', enabled: true },
        { id: 'hidden-core', name: 'Old MVU', enabled: false, managedByNora: true },
        { id: 'schema', name: 'MVU–Zod', enabled: true },
        { id: 'namesake', name: 'MVU', enabled: false },
        { id: 'active-core', name: 'Already running core', enabled: true, managedByNora: true },
    ], enabled: true, revision: 'r' });
    f.select('[data-extension="tavern_helper"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-script-inspect="hidden-core"]').length, 2);
    assert.equal(f.query('[data-script-toggle="hidden-core"]').length, 0);
    assert.equal(f.query('[data-managed-mvu]').length, 0, 'MVU settings belong to the extension overview, not scripts');
    assert.ok(f.query('.nora-script-list').text().includes(tr('内置接管')));
    assert.ok(!f.query('.nora-script-list').text().includes(tr('由内置 MVU 提供；原脚本保留')));
    for (const id of ['schema', 'namesake', 'active-core']) assert.equal(f.query(`[data-script-inspect="${id}"]`).length, 2, 'Same IDs from different sources remain separate');
    f.execute = async () => ({ script: { name: 'Old MVU', content: '// Original code' } });
    await f.select('[data-script-inspect="hidden-core"]').handlers.click();
    assert.ok(f.query('.nora-sheet-body').text().includes(tr('由内置 MVU 提供；原脚本保留')));
    assert.equal(f.query('textarea[readonly]').length, 1);
});

test('script groups show provenance once, hide empty scopes and retain a single empty-state import', async () => {
    const f = extensionFixture(); f.open();
    f.select('[data-extension="tavern_helper"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('.nora-script-group').length, 1);
    assert.equal(f.query('.nora-script-group h3').text(), tr('本世界脚本'));
    assert.equal(f.query('.nora-script-name small, .nora-script-builtin').length, 0);
    assert.equal(f.query('footer button').length, 1);
    assert.equal(f.query('footer [data-script-import]').length, 1);
    f.select('[data-sheet-back]').handlers.click();
    f.execute = async command => ({ trees: command.params.scope === 'global' ? [{ id: 'global', name: 'Global helper' }] : [], enabled: true, revision: 'r' });
    f.select('[data-extension="tavern_helper"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('.nora-script-group h3').text(), tr('全局脚本'));
    assert.equal(f.query('[data-script-key="global:global"]').length, 2);
    f.select('[data-sheet-back]').handlers.click();
    f.execute = async () => ({ trees: [], enabled: true, revision: 'r' });
    f.select('[data-extension="tavern_helper"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('.nora-script-group').length, 0);
    assert.equal(f.query('[data-script-import]').length, 1);
    assert.equal(f.query('.nora-script-list').text(), tr('当前没有可管理的脚本'));
});

test('embedded preset scripts appear as a separate source and permission targets that source only', async () => {
    const f = extensionFixture();
    f.world.preset = { name: 'R', preset: { extensions: { tavern_helper: { scripts: [] } } } };
    f.execute = async command => command.action === 'scripts.list'
        ? { trees: command.params.scope === 'preset' ? [{ id: 'preset-one', name: 'Control', enabled: true }] : [], revision: 'p1', enabled: false, source: 'R' }
        : { saved: true };
    let confirmation;
    f.common.dialogs.confirm = async value => { confirmation = value; return true; };
    f.open(); f.select('[data-extension="tavern_helper"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('.nora-script-group h3').text(), tr('当前预设脚本'));
    f.select('[data-script-activate="preset:preset-one"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(confirmation.details, ['Control']);
    const writes = f.commands.filter(command => command.confirm);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].params, { scope: 'preset', expectedRevision: 'p1', id: 'preset-one' });
});

test('preset-only regex is discoverable without a card declaration and has an explicit permission action', async () => {
    const f = extensionFixture();
    f.world.capabilities = { declared: [], items: {} };
    f.world.preset = { preset: { extensions: { regex_scripts: [{ id: 'r' }] } } };
    f.execute = async command => command.action === 'regex.list'
        ? { scripts: command.params.scope === 'preset' ? [{ id: 'r' }] : [], allowed: false }
        : { trees: [] };
    f.open();
    f.select('[data-extension="regex"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-regex-scope]').length, 1);
    assert.equal(f.query('.nora-extension-setting-head [data-regex-scope].is-primary').length, 1);
    assert.equal(f.query('.nora-extension-setting-actions [data-regex-permission]').length, 1);
    assert.equal(f.query('.nora-extension-setting-actions button:not([type="button"])').length, 0);
    assert.equal(f.query('[data-regex-permission="preset"]').text(), tr('启用此组'));
    f.select('[data-regex-scope="preset"]').handlers.click();
    await f.opened[0][2].write({ revision: 'p', scripts: [{ id: 'r' }] }, 0, { disabled: true });
    assert.deepEqual(f.commands.at(-1).params, { scope: 'preset', id: 'r', expectedRevision: 'p', patch: { disabled: true } });
});

test('MVU settings remain reachable from overview after removing the script-page shortcut', async () => {
    const f = extensionFixture(); f.open();
    f.select('[data-extension="tavern_helper"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-managed-mvu]').length, 0);
    f.select('[data-sheet-back]').handlers.click();
    f.select('[data-extension="mvu"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    f.select('[data-mvu-model-settings]').handlers.click();
    assert.equal(f.modelArgs()[1].backLabel, tr('返回 MVU 设置'));
    await f.modelArgs()[0]();
    f.select('[data-sheet-back]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-script-import]').length, 0);
    assert.equal(f.query('[data-extension="mvu"]').length, 1);
});

test('script manager keeps navigation in the header and uses explicit view and import buttons', async () => {
    const f = extensionFixture(); f.open();
    f.select('[data-extension="tavern_helper"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('header [data-sheet-back]').length, 1);
    assert.equal(f.query('.nora-sheet-body [data-sheet-back], .nora-sheet-back').length, 0);
    assert.equal(f.query('.nora-sheet-body').text().split('法特利亚大陆').length - 1, 1);
    assert.equal(f.query('button[data-script-inspect="one"]').text(), tr('查看'));
    assert.equal(f.query('button[data-script-import]').length, 1);
    assert.equal(f.query('[data-script-file], details').length, 0, 'File input and options belong to the dedicated import page');
    assert.equal(f.query('label[data-script-import], label:has([data-script-file])').length, 0);
    f.select('[data-script-import]').handlers.click();
    assert.equal(f.query('[data-script-file][hidden]').length, 1);
    f.select('[data-choose-script]').handlers.click();
    assert.equal(f.select('[data-script-file]').clicks, 1);
});

test('merged script list confirms group permission and routes same IDs to their exact source', async () => {
    const f = extensionFixture(); f.open();
    f.execute = async () => ({ trees: [{ id: 'one', type: 'script', name: 'Map', enabled: false }], revision: 'r2', source: 'Preset', enabled: false });
    f.select('[data-extension="tavern_helper"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.commands.filter(command => command.action === 'scripts.list').slice(-2).map(command => command.params.scope), ['character', 'global']);
    assert.equal(f.query('[data-script-scope], [data-script-authorize]').length, 0);
    for (const approved of [false, true]) {
        f.common.dialogs.confirm = async () => approved;
        const before = f.commands.filter(command => command.confirm).length;
        f.select('[data-script-toggle][data-script-key="character:one"]').handlers.click();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.commands.filter(command => command.confirm).length, before + Number(approved));
    }
    f.select('[data-script-toggle][data-script-key="global:one"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    const writes = f.commands.filter(command => command.confirm);
    assert.deepEqual(writes.map(command => command.action), ['scripts.activate', 'scripts.activate']);
    assert.deepEqual(writes.map(command => command.params.scope), ['character', 'global']);
    assert.ok(writes.every(command => command.worldId === 'world:a' && command.params.expectedRevision === 'r2'));
    f.select('[data-sheet-back]').handlers.click();
    assert.equal(f.query('[data-extension]').length, 5);
});

test('permission preview lists actual enabled siblings, excludes disabled folders and makes global impact explicit', async () => {
    const f = extensionFixture(); f.open(); let prompt;
    f.execute = async command => ({ trees: command.params.scope === 'character' ? [] : [
        { id: 'target', name: 'Target', enabled: false }, { id: 'sibling', name: 'Sibling', enabled: true },
        { id: 'folder', name: 'Folder', type: 'folder', enabled: false, scripts: [{ id: 'child', name: 'Child', enabled: true }] },
    ], revision: 'r', enabled: false });
    f.common.dialogs.confirm = async value => { prompt = value; return false; };
    f.select('[data-extension="tavern_helper"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.query('[data-script-key="global:child"]').closest('.nora-script-line').text().includes(tr('父文件夹已停用')));
    f.select('[data-script-toggle="target"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(prompt.details, ['Target', 'Sibling']);
    assert.ok(prompt.body.includes(tr('此操作会影响所有世界。')));
    assert.equal(f.commands.filter(command => command.confirm).length, 0);
});

test('global import is opt-in and remains disabled without granting scope permission', async () => {
    const f = extensionFixture(); f.open();
    f.common.dialogs.confirm = async () => true;
    f.select('[data-extension="tavern_helper"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    f.select('[data-script-import]').handlers.click();
    assert.equal(f.select('[data-script-destination]').value, 'character');
    f.select('[data-script-destination]').value = 'global';
    await f.select('[data-script-file]').handlers.change({ target: { files: [{ name: 'x.json', size: 40, text: async () => JSON.stringify({ type: 'script', content: 'x' }) }] } });
    const writes = f.commands.filter(command => command.confirm);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].action, 'scripts.import');
    assert.equal(writes[0].params.scope, 'global');
    assert.equal(writes[0].params.expectedRevision, 'global-r1');
    assert.equal(writes[0].params.tree.enabled, false);
});

test('failed script list shows retry without enabling imports against missing revisions', async () => {
    const f = extensionFixture(); f.open();
    f.execute = async () => { throw new Error('offline'); };
    f.select('[data-extension="tavern_helper"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.query('[data-script-content]').text().includes('offline'));
    assert.equal(f.query('[data-script-file], [data-script-toggle]').length, 0);
    f.execute = null;
    f.select('[data-script-reload]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('[data-script-import]').length, 1);
});

test('late script list response cannot replace a different extension detail', async () => {
    const f = extensionFixture(); f.open();
    let resolve;
    f.execute = () => new Promise(done => { resolve = done; });
    f.select('[data-extension="tavern_helper"]').handlers.click();
    f.select('[data-sheet-back]').handlers.click();
    f.select('[data-extension="prompt_template"]').handlers.click();
    resolve({ trees: [], revision: 'r', enabled: true });
    await new Promise(done => setImmediate(done));
    assert.equal(f.query('[data-script-content]').length, 0);
});

test('dismissed confirmation cannot reopen scripts over another sheet', async () => {
    const f = extensionFixture(); f.open();
    f.select('[data-extension="tavern_helper"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    f.common.dialogs.confirm = async () => { f.common.dialogs.open('Elsewhere', '<div id="elsewhere"></div>'); return false; };
    await f.select('[data-script-toggle="one"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('#elsewhere').length, 1);
    assert.equal(f.commands.filter(command => command.confirm).length, 0);
});

test('script import previews data, stays disabled and needs explicit confirmation', async () => {
    for (const approved of [false, true]) {
        const f = extensionFixture(); f.open();
        let prompt;
        f.common.dialogs.confirm = async input => { prompt = input; return approved; };
        f.select('[data-extension="tavern_helper"]').handlers.click();
        await new Promise(resolve => setImmediate(resolve));
        f.select('[data-script-import]').handlers.click();
        const input = f.select('[data-script-file]');
        const tree = { type: 'script', name: 'Map', content: 'doNotExecute()', enabled: true, button: { enabled: true, buttons: [{ name: 'Go', visible: true }] }, data: { map: 1 } };
        await input.handlers.change({ target: { value: 'map.json', files: [{ name: 'map.json', size: 200, text: async () => JSON.stringify(tree) }] } });
        assert.ok(prompt.body.includes('Map'));
        const writes = f.commands.filter(command => command.confirm);
        assert.equal(writes.length, approved ? 1 : 0);
        if (approved) {
            assert.equal(writes[0].action, 'scripts.import');
            assert.equal(writes[0].params.tree.enabled, false);
            assert.deepEqual(writes[0].params.tree.data, { map: 1 });
            assert.equal(writes[0].params.expectedRevision, 'r1');
            assert.equal(writes[0].worldId, 'world:a');
        }
    }
});

test('script import rejects invalid JSON and discards a file read after world switch', async () => {
    const f = extensionFixture(); f.open();
    f.select('[data-extension="tavern_helper"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    f.select('[data-script-import]').handlers.click();
    const input = f.select('[data-script-file]');
    await input.handlers.change({ target: { files: [{ size: 5, text: async () => '{bad' }] } });
    assert.equal(f.errors.length, 1);
    await input.handlers.change({ target: { files: [{ size: 20, text: async () => { f.world.id = 'other'; return JSON.stringify({ type: 'script', content: 'x' }); } }] } });
    assert.equal(f.commands.filter(command => command.confirm).length, 0);
});

test('cancelled import remains usable after confirmation changes the dialog version', async () => {
    const f = extensionFixture(); f.open();
    f.select('[data-extension="tavern_helper"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    f.select('[data-script-import]').handlers.click();
    let confirms = 0;
    f.common.dialogs.confirm = async () => { f.common.dialogs.version += 2; return ++confirms > 1; };
    const input = f.select('[data-script-file]');
    const event = () => ({ target: { files: [{ name: 'test.json', size: 80, text: async () => JSON.stringify({ type: 'script', name: 'Test', content: 'noop()' }) }] } });
    await input.handlers.change(event());
    assert.equal(f.commands.filter(command => command.confirm).length, 0);
    await input.handlers.change(event());
    assert.equal(confirms, 2);
    assert.equal(f.commands.filter(command => command.confirm).length, 1);
});

test('import confirmation cannot write after replacement of its actual form', async () => {
    const f = extensionFixture(); f.open();
    f.select('[data-extension="tavern_helper"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    f.select('[data-script-import]').handlers.click();
    f.common.dialogs.confirm = async () => { f.common.dialogs.open('Elsewhere', '<p>Other page</p>'); return true; };
    await f.select('[data-script-file]').handlers.change({ target: { files: [{ size: 80, text: async () => JSON.stringify({ type: 'script', content: 'noop()' }) }] } });
    assert.equal(f.commands.filter(command => command.confirm).length, 0);
});

test('template retry preserves readiness workflow without reopening a closed sheet', async () => {
    const f = extensionFixture();
    f.world.capabilities.items.prompt_template = { status: 'DEGRADED' };
    f.open(); f.select('[data-extension="prompt_template"]').handlers.click();
    f.onRetry = () => f.common.dialogs.close();
    await f.select('[data-template-retry]').handlers.click();
    assert.deepEqual(f.retried, [['world:a', 'prompt_template']]);
});

test('model settings use the caller return label and reset navigation between entries', () => {
    const f = fixture(); let returns = 0;
    const controller = createModelController({ ...f.common, settings: () => ({ modelProfiles: [] }),
        settingsDomain: {}, model: {}, readState: () => ({ model: {} }), onChanged() {},
    });
    controller.open(() => returns++);
    assert.equal(f.query('[data-sheet-back]').text(), tr('返回'));
    f.select('[data-sheet-back]').handlers.click();
    assert.equal(returns, 1);
    controller.open();
    assert.equal(f.query('[data-sheet-back]').length, 0, 'Ordinary model settings do not retain an old navigation callback');
    controller.open(() => returns++, { mvuOnly: true, backLabel: tr('返回 MVU 设置') });
    assert.equal(f.query('[data-sheet-back]').text(), tr('返回 MVU 设置'));
    f.select('[data-sheet-back]').handlers.click();
    assert.equal(returns, 2);
    assert.equal(f.query('[data-model-add], [data-model-choice]').length, 0, 'MVU navigation does not open unrelated text-model management');
    assert.ok(f.query('[data-mvu-model-slot]').text().includes(tr('当前世界未使用 MVU。')));
});

test('MVU settings show inspection failure and support retry without leaving the sheet', async () => {
    const f = fixture(); let fails = true;
    const controller = createModelController({ ...f.common, settings: () => ({ modelProfiles: [] }),
        settingsDomain: {}, model: {}, readState: () => ({ model: {} }), onChanged() {},
        mvu: { inspect: async () => { if (fails) throw new Error('offline'); return { supported: false }; } },
    });
    controller.open(() => {}, { mvuOnly: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.query('[data-mvu-model-slot]').text().includes('offline'));
    assert.equal(f.query('[data-mvu-retry]').length, 1);
    fails = false;
    await f.select('[data-mvu-retry]').handlers.click();
    assert.equal(f.query('[data-mvu-retry]').length, 0);
    assert.ok(f.query('[data-mvu-model-slot]').text().includes(tr('当前世界未使用 MVU。')));
});

test('MVU configuration read failure offers retry instead of silently assuming an empty configuration', async () => {
    const f = fixture();
    const controller = createModelController({ ...f.common, settings: () => ({ modelProfiles: [] }),
        settingsDomain: {}, model: {}, readState: () => ({ model: {} }), onChanged() {},
        mvu: { inspect: async () => ({ supported: true }), config: async () => { throw new Error('config unavailable'); } },
    });
    controller.open(() => {}, { mvuOnly: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.query('[data-mvu-model-slot]').text().includes('config unavailable'));
    assert.equal(f.query('[data-mvu-retry]').length, 1);
    assert.equal(f.query('[data-mvu-source], [data-mvu-config]').length, 0);
});

test('MVU settings discard delayed inspection after navigating to another sheet', async () => {
    const f = fixture(); let finish;
    const controller = createModelController({ ...f.common, settings: () => ({ modelProfiles: [] }),
        settingsDomain: {}, model: {}, readState: () => ({ model: {} }), onChanged() {},
        mvu: { inspect: () => new Promise(resolve => { finish = resolve; }) },
    });
    controller.open(() => {}, { mvuOnly: true });
    f.common.dialogs.open('Other', '<div id="other"></div>');
    finish({ supported: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.query('#other').length, 1);
    assert.equal(f.errors.length, 0);
});

test('regex list separates read-only details from explicit editing and preserves return destination', async () => {
    const f = fixture(), writes = [];
    const rules = [{ scriptName: 'First', findRegex: '/a/', replaceString: 'A' }, { scriptName: 'Second', findRegex: '/b/', replaceString: 'B' }];
    const controller = createRegexController({ ...f.common, isGenerating: () => false, refresh() {},
        cards: { readCharacterRegex: async avatar => ({ avatar, scripts: rules }), saveCharacterRegex: async input => writes.push(input) } });
    await controller.open('card.png', () => {}, { backLabel: tr('‹ 返回扩展管理') });
    f.select('[data-regex-rule="1"]').handlers.click();
    assert.equal(f.query('textarea:not([readonly])').length, 0);
    assert.equal(f.query('form, [type="submit"]').length, 0);
    assert.equal(f.query('h3').text(), 'Second');
    assert.equal(writes.length, 0);
    assert.equal(f.query('[data-regex-close], footer').length, 0, 'Read-only detail uses only the header return');
    assert.equal(f.query('[data-sheet-back]').text(), tr('返回列表'));
    await f.select('[data-sheet-back]').handlers.click();
    assert.equal(f.query('[data-sheet-back]').text(), tr('‹ 返回扩展管理'));
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
