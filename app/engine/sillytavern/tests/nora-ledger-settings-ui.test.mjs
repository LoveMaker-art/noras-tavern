import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { createLedgerSettingsController } from '../../../native-extensions/nora-ui/ledger-settings-controller.js';
import { createExtensionController } from '../../../native-extensions/nora-ui/extension-controller.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
    let dom, modal, back, guard, current = true, generating = false, accepted = true, failSave = false, hold;
    let state = { enabled: true, configRevision: 0, taskPhase: 'idle', active: null, lastError: null,
        effectiveConfig: { contextLimitOverride: null, outputTokenLimit: 2048, timeoutSeconds: 300 },
        model: { name: 'local-model', contextLimit: 8192 }, expectedSignature: 'signature' };
    const requests = [], confirmations = [], toasts = [], wrappers = new WeakMap();
    const wrap = raw => {
        if (!raw) return null;
        if (wrappers.has(raw)) return wrappers.get(raw);
        const node = { raw, listeners: {}, get isConnected() { return dom.root().find('*').toArray().includes(raw); },
            addEventListener(type, fn) { this.listeners[type] = fn; },
            fire(type = 'click') { return this.listeners[type]?.({ preventDefault() {} }); },
            reportValidity() { return true; } };
        for (const attr of ['hidden', 'disabled', 'checked']) Object.defineProperty(node, attr, {
            get: () => dom(raw).attr(attr) !== undefined,
            set: value => { if (value) dom(raw).attr(attr, ''); else dom(raw).removeAttr(attr); },
        });
        Object.defineProperty(node, 'innerHTML', { get: () => dom(raw).html(), set: value => { dom(raw).html(value); } });
        Object.defineProperty(node, 'textContent', { get: () => dom(raw).text(), set: value => { dom(raw).text(value); } });
        Object.defineProperty(node, 'value', { get: () => dom(raw).val() || '', set: value => { dom(raw).val(String(value)); } });
        wrappers.set(raw, node); return node;
    };
    const select = (selector, root = modal) => wrap(dom(root.raw).find(selector).get(0));
    const dialogs = {
        version: 0,
        open(_title, html, _style, options) { this.version++; back = options?.back; dom = load(`<div id="modal">${html}</div>`); modal = wrap(dom('#modal').get(0)); return modal; },
        setCloseGuard(value) { guard = value; },
        protectForm(form, { isBusy }) {
            const snapshot = () => dom(form.raw).find('[name]').toArray().map(raw => wrap(raw).value).join('|');
            const initial = snapshot();
            const fn = async () => !isBusy() && !dom(form.raw).find('[type="submit"][disabled]').length
                && (snapshot() === initial || await this.confirm({ title: 'discard', restoreSheet: true }));
            guard = fn;
            return { async leave(action) { if (await fn()) return action(); } };
        },
        async confirm(options) { confirmations.push(options); this.version += 2; return accepted; },
        toast(value) { toasts.push(value); }, normalizeError: error => error.message,
    };
    const request = async (action, scope, patch) => {
        requests.push({ action, scope, patch });
        if (action === 'configure') {
            if (hold) await hold;
            if (failSave) throw new Error('offline');
            if (patch.expectedRevision !== state.configRevision) throw { code: 'NORA_LEDGER_CONFIGURATION_STALE' };
            const { enabled, expectedRevision, ...config } = patch;
            state = { ...state, configRevision: expectedRevision + 1, effectiveConfig: { ...state.effectiveConfig, ...config },
                ...(enabled === undefined ? {} : { enabled, taskPhase: enabled ? 'idle' : 'disabled' }) };
        }
        if (action === 'reset') state = { ...state, enabled: false, active: null, configRevision: state.configRevision + 1, taskPhase: 'disabled' };
        return structuredClone(state);
    };
    const options = { dialogs, select, escapeHtml: value => String(value).replaceAll('<', '&lt;'), request, isGenerating: () => generating };
    const controller = createLedgerSettingsController(options);
    return { ...options, controller, request, select, requests, confirmations, toasts, dialogs,
        open: () => controller.open({ worldId: 'world:test', sessionId: 'session:test' }, { name: 'Test', isCurrent: () => current, back: () => { current = false; } }),
        guard: () => guard(), back: () => back(), text: () => dom.text(), current: value => { current = value; },
        generating: value => { generating = value; }, accepted: value => { accepted = value; }, failSave: value => { failSave = value; },
        hold: value => { hold = value; }, state: () => state, changeState: patch => { state = { ...state, ...patch }; } };
}

test('default-on settings show scope, actual model configuration and the three bounded inputs without a model call', async () => {
    const f = fixture(); await f.open();
    assert.equal(f.select('[data-ledger-toggle]').checked, true);
    assert.match(f.text(), /local-model/); assert.match(f.text(), /8192 tokens/);
    assert.equal(f.select('[data-ledger-context]').value, '');
    assert.equal(f.select('[data-ledger-output]').value, '2048');
    assert.equal(f.select('[data-ledger-timeout]').value, '300');
    assert.deepEqual(f.requests.map(item => item.action), ['inspect']);
    assert.equal(await f.guard(), true, 'unchanged settings must remain dismissible');
});

test('consecutive saves read back the new revision without replacing the editor or producing stale conflicts', async () => {
    const f = fixture(); await f.open();
    const field = f.select('[data-ledger-timeout]');
    for (const value of ['400', '500']) {
        field.value = value; await f.select('[data-ledger-form]').fire('input');
        await f.select('[data-ledger-form]').fire('submit');
        assert.equal(field, f.select('[data-ledger-timeout]'));
        assert.equal(field.value, value);
        assert.equal(f.select('[data-ledger-save]').disabled, true);
        assert.equal(await f.guard(), true);
    }
    assert.deepEqual(f.requests.filter(item => item.action === 'configure').map(item => item.patch.expectedRevision), [0, 1]);
    assert.deepEqual(f.requests.map(item => item.action), ['inspect', 'configure', 'inspect', 'configure', 'inspect']);
});

test('failed saves preserve drafts; close and back honour discard cancellation', async () => {
    const f = fixture(); await f.open(); f.failSave(true);
    f.select('[data-ledger-timeout]').value = '600'; await f.select('[data-ledger-form]').fire('input');
    await f.select('[data-ledger-form]').fire('submit');
    assert.equal(f.select('[data-ledger-timeout]').value, '600');
    f.accepted(false); assert.equal(await f.guard(), false); await f.back();
    assert.equal(f.select('[data-ledger-timeout]').value, '600');
    assert.ok(f.toasts.includes('offline'));
});

test('busy saves block dismissal and duplicate writes; switched-world callbacks cannot mutate', async () => {
    const f = fixture(); await f.open();
    let release; f.hold(new Promise(resolve => { release = resolve; }));
    f.select('[data-ledger-timeout]').value = '450';
    const saving = f.select('[data-ledger-form]').fire('submit'); await tick();
    assert.equal(await f.guard(), false); assert.equal(f.select('[data-ledger-timeout]').disabled, true);
    await f.select('[data-ledger-form]').fire('submit');
    assert.equal(f.requests.filter(item => item.action === 'configure').length, 1);
    f.current(false); release(); await saving;
    await f.select('[data-ledger-reset]').fire(); await tick();
    assert.equal(f.requests.some(item => item.action === 'reset'), false);
});

test('generation blocks configuration, enable, retry and reset, but permits disabling an active ledger', async () => {
    const f = fixture(); await f.open(); f.generating(true);
    await f.select('[data-ledger-form]').fire('submit');
    await f.select('[data-ledger-reset]').fire();
    f.select('[data-ledger-toggle]').checked = false;
    await f.select('[data-ledger-toggle]').fire('change');
    assert.equal(f.state().enabled, false);
    assert.equal(f.select('[data-ledger-toggle]').checked, false);
    f.select('[data-ledger-toggle]').checked = true;
    await f.select('[data-ledger-toggle]').fire('change');
    assert.deepEqual(f.requests.filter(item => item.action !== 'inspect').map(item => item.action), ['configure']);
});

test('status polling preserves drafts and stale revisions, and stops after leaving the world', async t => {
    const originalTimeout = globalThis.setTimeout, originalWindow = globalThis.window;
    const polls = [];
    globalThis.window = {};
    globalThis.setTimeout = callback => { polls.push(callback); };
    t.after(() => {
        globalThis.setTimeout = originalTimeout;
        if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    });
    const f = fixture(); await f.open();
    f.select('[data-ledger-timeout]').value = '600';
    f.changeState({ configRevision: 1, enabled: false, taskPhase: 'disabled',
        effectiveConfig: { ...f.state().effectiveConfig, timeoutSeconds: 450 } });
    await polls.shift()();
    assert.equal(f.select('[data-ledger-timeout]').value, '600');
    assert.equal(f.select('[data-ledger-toggle]').checked, false);
    await f.select('[data-ledger-form]').fire('submit');
    assert.equal(f.requests.find(item => item.action === 'configure').patch.expectedRevision, 0);
    assert.equal(f.state().effectiveConfig.timeoutSeconds, 450);
    assert.equal(f.select('[data-ledger-timeout]').value, '600');
    f.current(false);
    const reads = f.requests.length;
    await polls.shift()();
    assert.equal(f.requests.length, reads);
    assert.equal(polls.length, 0);
});

test('extension menu retains a disabled empty ledger and stable builtin order, without triggering model or script activation', async () => {
    const f = fixture();
    const selectAll = (selector, root) => { const nodes = []; for (let i = 0; ; i++) { const node = f.select(`${selector}:nth-of-type(${i + 1})`, root); if (!node) break; nodes.push(node); } return nodes; };
    const controls = [];
    const extensions = createExtensionController({ ...f, selectAll, activeWorldModel: () => ({ id: 'world:test', name: 'Test', capabilities: { declared: [], items: {} } }),
        currentCharacter: () => ({ avatar: 'test.png' }), readState: () => ({ world: { metadata: { nora_session: { id: 'session:test' } } } }),
        executeControl: async input => { controls.push(input.action); if (input.action === 'scripts.list') throw { code: 'NORA_HELPER_NOT_READY' }; return { scripts: [] }; },
        ledgerRequest: async () => ({ enabled: false, active: null, pending: null, lastError: null, taskPhase: 'disabled' }) });
    extensions.open(); await tick();
    assert.ok(f.select('[data-extension="ledger"]'));
    assert.match(f.text(), /剧情账本/);
    assert.ok(!controls.includes('mvu.status'));
    assert.ok(controls.every(action => ['scripts.list', 'regex.list'].includes(action)));
});
