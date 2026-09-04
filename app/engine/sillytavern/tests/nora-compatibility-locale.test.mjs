import assert from 'node:assert/strict';
import test from 'node:test';

function installDom() {
    globalThis.document = {
        body: { classList: { contains: () => true } },
        documentElement: { lang: '' },
        querySelectorAll: () => [],
    };
    globalThis.location = { search: '' };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'zh-CN' } });
    globalThis.__NORA_LOCALE__ = 'zh-cn';
}

test('loads the full ST dictionary as a low-priority compatibility resource', async () => {
    installDom();
    const requests = [];
    globalThis.__NORA_ASSET_URL__ = path => `/assets/release/${path}`;
    const { loadCompatibilityLocale } = await import(`../public/scripts/nora-i18n/compatibility-locale.js?test=${Date.now()}`);

    const loaded = await loadCompatibilityLocale({
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, json: async () => ({ Save: '保存' }) };
        },
    });

    assert.equal(loaded, true);
    assert.deepEqual(requests, [{
        url: '/assets/release/locales/zh-cn.json',
        options: { cache: 'force-cache', credentials: 'same-origin', priority: 'low' },
    }]);
});
