import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { load } from 'cheerio';
import './helpers/nora-locale-fixture.mjs';
import { createModelController } from '../../../native-extensions/nora-ui/model-controller.js';
import { createMvuModelAdapter } from '../../../native-extensions/nora-ui/mvu-model-adapter.js';
import { createStMvuSettingsAdapter } from '../public/scripts/nora-adapters/st-mvu-settings-adapter.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function domFixture() {
    let dom, modal; const wrappers = new WeakMap();
    const wrap = raw => {
        if (!raw) return null;
        if (wrappers.has(raw)) return wrappers.get(raw);
        const node = { raw, listeners: {}, dataset: {},
            get isConnected() { return dom.root().find('*').toArray().includes(raw); },
            addEventListener(type, fn) { this.listeners[type] = fn; },
            fire(type) { return this.listeners[type]?.({ preventDefault() {} }); }, focus() {} };
        for (const attr of ['hidden', 'disabled', 'checked']) Object.defineProperty(node, attr, {
            get: () => dom(raw).attr(attr) !== undefined,
            set: value => { if (value) dom(raw).attr(attr, ''); else dom(raw).removeAttr(attr); },
        });
        Object.defineProperty(node, 'innerHTML', { get: () => dom(raw).html(), set: value => { dom(raw).html(value); } });
        wrappers.set(raw, node); return node;
    };
    return {
        open(_title, html) { dom = load(`<div id="modal">${html}</div>`); modal = wrap(dom('#modal').get(0)); return modal; },
        select: (selector, root = modal) => wrap(dom(root.raw).find(selector).get(0)),
        selectAll: (selector, root = modal) => dom(root.raw).find(selector).toArray().map(wrap),
        text: () => dom.text(),
    };
}

test('MVU model settings retain the original presentation and preserve saved configuration across off/on choices', async () => {
    const ui = domFixture(), confirmations = [], notices = [];
    let approved = false, saves = 0;
    const raw = { 更新方式: '额外模型解析', 额外模型解析配置: { 启用自动请求: true, 模型来源: '自定义', 模型名称: 'saved-variable-model', 请求次数: 5 }, sentinel: 'keep' };
    const context = { extensionSettings: { mvu_settings: structuredClone(raw) }, saveSettingsDebounced: () => saves++ };
    const live = { getMvuData: () => ({ stat_data: { coins: 8 } }), reloadSettings() {} };
    const embedded = createStMvuSettingsAdapter(() => context, { readMvuRuntime: () => live });
    const api = { ...embedded, status: () => ({ ...embedded.status(), supported: true }) };
    const mvu = createMvuModelAdapter({ readApi: () => api, fetcher: async () => new Response(JSON.stringify({ model: 'saved-variable-model', has_api_key: true, base_url: 'https://provider.invalid' }), { status: 200 }) });
    const dialogs = { open: ui.open, confirm: async value => { confirmations.push(value); return approved; },
        toast: value => notices.push(value), normalizeError: error => error.message, close() {} };
    const controller = createModelController({ model: {}, settingsDomain: {}, operations: { isBusy: () => false, run: async (_key, fn) => fn() },
        readState: () => ({ model: {} }), activeWorldModel: () => null, settings: () => ({ modelProfiles: [] }),
        dialogs, select: ui.select, selectAll: ui.selectAll, escapeHtml: String, icons: {}, mvu, onChanged() {} });
    controller.open(); await tick();
    assert.match(ui.text(), /额外模型更新变量/);
    assert.doesNotMatch(ui.text(), /必要正文、变量和世界书|可能多次调用并计费|额外模型尚未启用/);
    assert.equal(ui.select('[data-mvu-enabled]').checked, false);
    assert.deepEqual(context.extensionSettings.mvu_settings, raw);
    assert.equal(confirmations.length, 0);
    ui.select('[data-mvu-enabled]').checked = true;
    await ui.select('[data-mvu-enabled]').fire('change');
    assert.equal(mvu.status().enabled, true); assert.equal(saves, 1);
    controller.open(); await tick(); assert.equal(ui.select('[data-mvu-enabled]').checked, true);
    ui.select('[data-mvu-enabled]').checked = false;
    await ui.select('[data-mvu-enabled]').fire('change');
    assert.equal(mvu.status().enabled, false); assert.equal(mvu.status().consentRequired, false);
    assert.equal(context.extensionSettings.mvu_settings.额外模型解析配置.模型名称, 'saved-variable-model');
    assert.equal(context.extensionSettings.mvu_settings.额外模型解析配置.请求次数, 5);
    assert.deepEqual(live.getMvuData(), { stat_data: { coins: 8 } });
    assert.deepEqual(notices, []);
});

test('Story Profile existing reader and preference toggle: read, reject, enable, reopen, disable and failed save', async () => {
    const nodes = new Map(), requests = [], confirmations = [];
    let enabled = true, approved = false, failSave = false;
    const node = id => {
        if (nodes.has(id)) return nodes.get(id);
        const value = { id, innerHTML: '', textContent: '', checked: false, disabled: false, value: '', listeners: {},
            classList: { add() {}, remove() {} }, setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
        nodes.set(id, value); return value;
    };
    const fetcher = async (url, options = {}) => {
        requests.push({ url, method: options.method || 'GET' });
        if (url === '/api/identity') return new Response('{}');
        if (url.startsWith('/api/actor_card')) return new Response(JSON.stringify({ name: 'Keep profile', knows: ['Keep old preference'], career: {}, intimacy: {}, timeline: [] }));
        if (url === '/api/personality') return new Response('{}', { status: 404 });
        assert.equal(url, '/api/nora-story-profile/automatic-preferences');
        if (options.method === 'POST') {
            if (failSave) return new Response('{}', { status: 503 });
            enabled = JSON.parse(options.body).enabled;
        }
        return new Response(JSON.stringify({ enabled, model: { name: 'profile-model' } }));
    };
    const context = vm.createContext({ URLSearchParams, URL, location: { search: '', href: 'https://isolated.test/actor' },
        I18N: { t: key => key, setIdentity() {}, applyStatic() {}, lang: 'zh', isChinese: true },
        TavernUI: { escapeHtml: String, safeSameOriginTarget: () => '' }, fetch: fetcher,
        document: { getElementById: node }, confirm: value => { confirmations.push(value); return approved; } });
    vm.runInContext(fs.readFileSync(new URL('../../../../story-profile/public/actor.js', import.meta.url), 'utf8'), context);
    await tick(); await tick();
    assert.match(node('acRoot').innerHTML, /Keep old preference/);
    assert.equal(node('automaticReflection').checked, true);
    assert.equal(requests.filter(item => item.method === 'POST').length, 0, 'displaying the enabled default does not write a choice');
    node('automaticReflection').checked = false;
    await node('automaticReflection').listeners.change();
    await vm.runInContext('load()', context); await tick();
    assert.equal(node('automaticReflection').checked, false);
    const savedBeforeReject = requests.filter(item => item.method === 'POST').length;
    node('automaticReflection').checked = true;
    await node('automaticReflection').listeners.change();
    assert.equal(requests.filter(item => item.method === 'POST').length, savedBeforeReject);
    assert.equal(node('automaticReflection').checked, false);
    approved = true; node('automaticReflection').checked = true;
    await node('automaticReflection').listeners.change(); assert.equal(enabled, true);
    await vm.runInContext('load()', context); await tick();
    assert.equal(node('automaticReflection').checked, true);
    node('automaticReflection').checked = false;
    await node('automaticReflection').listeners.change(); assert.equal(enabled, false);
    assert.equal(confirmations.length, 2, 'turning off needs no new model authorization');
    failSave = true; node('automaticReflection').checked = true;
    await node('automaticReflection').listeners.change();
    assert.equal(node('automaticReflection').checked, false);
    assert.equal(enabled, false); assert.equal(node('automaticReflection').disabled, false);
    assert.match(node('automaticReflectionStatus').textContent, /automaticReflectionFailed/);
    assert.match(node('acRoot').innerHTML, /Keep old preference/);
});
