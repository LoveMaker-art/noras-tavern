import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { createRuntimePluginLibrary } from '../../../native-extensions/nora-ui/plugin-library-controller.js';
import { translate as tr } from '../public/scripts/nora-i18n/core.js';
import { builtinPlugins } from '../src/nora-extension-library.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ onlyBuiltins = false, shared = false } = {}) {
    let dom, modal, back, version = 0, guard, accepted = true, generating = false, error = false, reloads = 0, hold, runtimeReads = 0, runtimeError = false, managementOpens = 0;
    const requests = [], confirmations = [], toasts = [], nodes = new WeakMap();
    const builtinChanges = [], activations = [];
    const runtime = { 'third-party/nora-mvu': { loaded: true, enabled: true }, 'third-party/JS-Slash-Runner': { loaded: true, enabled: true } };
    const builtins = [
        ...['memory', 'gallery', 'regex', 'token-counter', 'connection-manager', 'attachments', 'assets'].map(name => ({ name, type: 'system' })),
        ...['JS-Slash-Runner', 'nora-mvu', 'nora-ui', 'nora-ledger', 'ST-Prompt-Template'].map(name => ({ name: `third-party/${name}`, type: 'local', managed: true })),
    ].map(item => ({ ...item, builtin: builtinPlugins[item.name], displayName: item.name, editable: false }));
    const items = [
        ...onlyBuiltins ? [] : [{ name: 'third-party/test', displayName: '<img src=x onerror=bad()>', source: 'https://example.org/test', type: shared ? 'global' : 'local', editable: !shared, libraryEnabled: false, repository: true }],
        ...builtins,
    ];
    const wrap = raw => {
        if (!raw) return null;
        if (nodes.has(raw)) return nodes.get(raw);
        const node = { raw, listeners: {}, dataset: Object.fromEntries(Object.entries(raw.attribs || {}).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value])),
            get isConnected() { return dom.root().find('*').toArray().includes(raw); },
            addEventListener(type, fn) { this.listeners[type] = fn; },
            fire(type = 'click') { return this.listeners[type]?.({ preventDefault() {} }); },
        };
        for (const attr of ['hidden', 'disabled']) Object.defineProperty(node, attr, { get: () => dom(raw).attr(attr) !== undefined, set: value => { if (value) dom(raw).attr(attr, ''); else dom(raw).removeAttr(attr); } });
        Object.defineProperty(node, 'innerHTML', { get: () => dom(raw).html(), set: value => { dom(raw).html(value); } });
        Object.defineProperty(node, 'textContent', { get: () => dom(raw).text(), set: value => { dom(raw).text(value); } });
        Object.defineProperty(node, 'value', { get: () => dom(raw).val(), set: value => { dom(raw).val(value); } });
        nodes.set(raw, node); return node;
    };
    const select = (selector, root = modal) => wrap(dom(root.raw).find(selector).get(0));
    const selectAll = (selector, root = modal) => dom(root.raw).find(selector).toArray().map(wrap);
    const dialogs = {
        get version() { return version; },
        open(_title, html, _style, options) { version++; back = options.back; dom = load(`<div id="modal">${html}</div>`); modal = wrap(dom('#modal').get(0)); return modal; },
        setCloseGuard(fn) { guard = fn; },
        async confirm(options) { confirmations.push(options); version += 2; return accepted; },
        toast(message) { toasts.push(message); },
    };
    const controller = createRuntimePluginLibrary({ dialogs, select, selectAll,
        escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
        headers: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
        isGenerating: () => generating, reload: () => { reloads++; },
        openExtensions: () => { managementOpens++; },
        state: { whenReady: async () => { if (runtimeError) throw new Error('runtime unavailable'); } },
        loadModule: async path => {
            assert.equal(path, '/scripts/extensions.js');
            return {
                enableExtension: async name => { builtinChanges.push({ name, enabled: true }); runtime[name].enabled = true; },
                disableExtension: async name => { builtinChanges.push({ name, enabled: false }); runtime[name].enabled = false; },
                activateExtensionNames: async names => { activations.push(...names); for (const name of names) runtime[name].loaded = true; return names; },
                getExtensionLibraryRuntime: () => { runtimeReads++; return runtime; },
            };
        },
        fetchImpl: async (url, options) => {
            const body = options?.body ? JSON.parse(options.body) : null;
            requests.push({ url, body, headers: options?.headers });
            if (hold) await hold;
            if (error) return { ok: false, status: 500, text: async () => 'simulated failure' };
            if (url.endsWith('/library/state')) items[0].libraryEnabled = body.enabled;
            if (url.endsWith('/delete')) items.shift();
            return { ok: true, text: async () => JSON.stringify(url.endsWith('/library') ? { items } : { folderName: 'test' }) };
        },
    });
    return { controller, select, selectAll, requests, confirmations, toasts, items, builtinChanges, runtime, activations, runtimeReads: () => runtimeReads, runtimeError: value => { runtimeError = value; }, managementOpens: () => managementOpens,
        back: () => back(), accepted: value => { accepted = value; },
        generating: value => { generating = value; }, error: value => { error = value; }, hold: promise => { hold = promise; },
        reloads: () => reloads, guard: () => guard(), close: () => { version++; }, text: () => dom.text() };
}

test('library lists five feature plugins, hides infrastructure, and provides install management only', async () => {
    const f = fixture(); await f.controller.open();
    assert.equal(f.selectAll('img').length, 0);
    assert.ok(f.text().includes(tr('本页已加载')));
    assert.equal(f.selectAll('[data-plugin]').length, 6);
    assert.equal(f.selectAll('.nora-plugin-builtins').length, 0);
    assert.equal(f.select('[data-plugin="third-party/nora-ui"]'), null);
    assert.ok(f.select('[data-plugin="third-party/nora-mvu"]'));
    await f.select('[data-plugin="third-party/test"]').fire();
    assert.equal(f.selectAll('[data-plugin-action]').length, 2);
    assert.equal(f.select('[data-plugin-action="state"]'), null);
    assert.ok(f.text().includes(tr('页面加载状态')));
    await f.select('[data-plugin-management]').fire();
    assert.equal(f.managementOpens(), 1);
    await f.back(); await tick();
    assert.ok(f.select('[data-plugin-install]'));
    assert.equal(f.requests.filter(item => item.body).length, 0);
    assert.equal(f.runtimeReads(), 2);
});

test('builtins remain visible without user installs, have no uninstall or toggle actions', async () => {
    const f = fixture({ onlyBuiltins: true }); await f.controller.open();
    assert.equal(f.selectAll('[data-plugin]').length, 5);
    assert.ok(f.text().includes(tr('尚未安装第三方插件')));
    assert.ok(f.select('[data-plugin-install]'));
    await f.select('[data-plugin="third-party/nora-ledger"]').fire();
    assert.equal(f.selectAll('[data-plugin-action]').length, 0);
    assert.ok(f.text().includes(tr('内置插件随诺拉更新，不能单独卸载。')));
    assert.equal(f.requests.filter(item => item.body).length, 0);
});

test('inventory readers publish the same runtime snapshot to summaries without additional activation or writes', async () => {
    const f = fixture(), snapshots = [];
    const unsubscribe = f.controller.subscribeInventory(items => snapshots.push(items));
    const first = await f.controller.inventory();
    assert.equal(snapshots[0], first);
    assert.equal(first.find(item => item.builtin?.key === 'mvu').status, '本页已加载');
    f.runtime['third-party/nora-mvu'].loaded = false;
    await f.controller.inventory();
    assert.equal(snapshots[1].find(item => item.builtin?.key === 'mvu').runtime.loaded, false);
    unsubscribe();
    await f.controller.inventory();
    assert.equal(snapshots.length, 2);
    assert.equal(f.requests.filter(item => item.body).length, 0);
    assert.deepEqual(f.activations, []);
});

test('shared third-party extensions remain visible without local mutation controls', async () => {
    const f = fixture({ shared: true }); await f.controller.open();
    await f.select('[data-plugin="third-party/test"]').fire();
    assert.ok(f.text().includes(tr('管理员共享安装，请联系管理员管理。')));
    assert.equal(f.selectAll('[data-plugin-action]').length, 0);
});

test('install validates URL, requires confirmation, sends disabled=true, never auto-enables or reloads', async () => {
    const f = fixture(); await f.controller.open(); await f.select('[data-plugin-install]').fire();
    f.select('[name="url"]').value = 'https://secret@example.org/test';
    await f.select('[data-plugin-form]').fire('submit');
    assert.equal(f.confirmations.length, 0);
    assert.equal(f.select('[data-plugin-error]').hidden, false);
    f.select('[name="url"]').value = 'https://example.org/test'; f.accepted(false);
    await f.select('[data-plugin-form]').fire('submit');
    assert.equal(f.requests.filter(item => item.body).length, 0);
    f.accepted(true); await f.select('[data-plugin-form]').fire('submit'); await tick();
    const writes = f.requests.filter(item => item.body);
    assert.deepEqual(writes.map(item => item.body), [{ url: 'https://example.org/test', global: false, disabled: true }]);
    assert.equal(writes[0].headers['X-CSRF-Token'], 'test');
    assert.equal(f.reloads(), 0);
});

test('failed install retains the form and explains failure; retry is possible', async () => {
    const f = fixture(); await f.controller.open(); await f.select('[data-plugin-install]').fire();
    f.select('[name="url"]').value = 'https://example.org/test'; f.error(true);
    await f.select('[data-plugin-form]').fire('submit');
    assert.equal(f.select('[type="submit"]').disabled, false);
    assert.match(f.select('[data-plugin-error]').textContent, /simulated failure/);
    assert.equal(f.select('[name="url"]').value, 'https://example.org/test');
});

test('enable needs separate consent; in-flight actions are guarded and reload is explicit', async () => {
    const f = fixture(); await f.controller.manage(f.items[0], { back: f.controller.open });
    assert.equal(f.selectAll('[data-plugin-action]').length, 1);
    assert.equal(f.select('[data-plugin-action="update"]'), null);
    f.accepted(false); await f.select('[data-plugin-action="state"]').fire();
    assert.equal(f.requests.filter(item => item.body).length, 0);
    f.accepted(true);
    let release; f.hold(new Promise(resolve => { release = resolve; }));
    const action = f.select('[data-plugin-action="state"]'); const pending = action.fire(); await tick();
    assert.equal(f.guard(), false);
    await action.fire(); assert.equal(f.requests.filter(item => item.body).length, 1);
    f.hold(null); release(); await pending; await tick();
    assert.ok(f.text().includes(tr('已更改，待刷新')));
    assert.equal(f.reloads(), 0);
    f.generating(true); await f.select('[data-plugin-reload]').fire(); assert.equal(f.reloads(), 0);
    f.generating(false); await f.select('[data-plugin-reload]').fire(); assert.equal(f.reloads(), 1);
});

test('read failure offers retry and stale requests cannot overwrite a closed/replaced dialog', async () => {
    const f = fixture(); f.error(true); await f.controller.open();
    assert.match(f.text(), /simulated failure/);
    f.error(false); await f.select('[data-plugin-retry]').fire();
    assert.ok(f.select('[data-plugin-install]'));
    let release; f.hold(new Promise(resolve => { release = resolve; }));
    const reading = f.controller.open(); f.close(); release(); await reading;
    assert.equal(f.select('[data-plugin-install]'), null);
});

test('built-in loading is controlled only in extension management, separately from feature settings', async () => {
    const f = fixture();
    const helper = f.items.find(item => item.builtin?.key === 'tavern_helper');
    let settings = 0;
    await f.controller.manage(helper, { openSettings: () => { settings++; } });
    assert.equal(f.selectAll('[data-plugin-action]').length, 1);
    assert.equal(f.select('[data-plugin-action="delete"]'), null);
    await f.select('[data-plugin-settings]').fire();
    assert.equal(settings, 1);
    assert.deepEqual(f.builtinChanges, []);
    await f.select('[data-plugin-action="state"]').fire(); await tick();
    assert.deepEqual(f.builtinChanges, [{ name: helper.name, enabled: false }]);
    assert.ok(f.text().includes(tr('已更改，待刷新')));
    assert.equal(f.select('[data-plugin-settings]').disabled, true);
    assert.equal(f.requests.filter(item => item.body).length, 0, 'Must not use third-party storage for bundled plugin controls');
});

test('unloaded Helper asks before activation; reading either list never activates it', async () => {
    const f = fixture();
    const helper = f.items.find(item => item.builtin?.key === 'tavern_helper');
    f.runtime[helper.name].loaded = false;
    let settings = 0;
    await f.controller.open();
    await f.controller.manage(helper, { openSettings: () => { settings++; } });
    assert.deepEqual(f.activations, []);
    f.accepted(false); await f.select('[data-plugin-settings]').fire();
    assert.deepEqual(f.activations, []);
    f.accepted(true); await f.select('[data-plugin-settings]').fire();
    assert.deepEqual(f.activations, [helper.name]);
    assert.equal(settings, 1);
    assert.deepEqual(f.builtinChanges, [], 'Opening settings must not change stored consent');
});

test('specialised builtin settings never get a generic module switch', async () => {
    const f = fixture();
    for (const key of ['ledger', 'mvu', 'regex']) {
        await f.controller.manage(f.items.find(item => item.builtin?.key === key), { openSettings() {} });
        assert.equal(f.select('[data-plugin-action="state"]'), null);
        assert.ok(f.select('[data-plugin-settings]'));
    }
});

test('runtime read failure is retryable; library inventory never depends on it', async () => {
    const f = fixture(); f.runtimeError(true);
    await f.controller.open();
    assert.ok(f.select('[data-plugin-install]'));
    await f.controller.manage(f.items[0]);
    assert.match(f.text(), /runtime unavailable/);
    assert.equal(f.select('[data-plugin-action="state"]'), null);
    f.runtimeError(false); await f.select('[data-plugin-retry]').fire();
    await tick();
    assert.ok(f.select('[data-plugin-action="state"]'));
});

test('replaced sheets and changed world cannot apply a stale loading switch', async () => {
    const f = fixture();
    let current = true;
    await f.controller.manage(f.items[0], { isCurrent: () => current });
    const old = f.select('[data-plugin-action="state"]');
    current = false; await old.fire();
    assert.equal(f.confirmations.length, 0);
    current = true; await f.controller.open(); await old.fire();
    assert.equal(f.requests.filter(item => item.body).length, 0);
});
