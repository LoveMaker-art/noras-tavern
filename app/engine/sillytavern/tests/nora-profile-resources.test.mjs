import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { parse } = require('@adobe/css-tools');
const read = name => fs.readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/nora-profile-ui-baseline.json', import.meta.url), 'utf8'));
const html = read('actor.html');
const actor = read('actor.js');
const i18n = read('i18n.js');
const style = read('console.css');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');

function normalizeRules(rules) {
    return rules.filter(r => r.type !== 'comment').map(r => r.type === 'rule'
        ? { selectors: r.selectors, declarations: r.declarations.filter(d => d.type === 'declaration').map(d => [d.property, d.value]) }
        : { media: r.media, rules: normalizeRules(r.rules) });
}

function locale({ query = '', session = '', browser = 'en', blocked = false, document = {} } = {}) {
    const stored = new Map(session ? [['cc_lang', session]] : []);
    const scope = {
        URLSearchParams, location: { search: query }, navigator: { language: browser }, document,
        sessionStorage: {
            getItem: key => { if (blocked) throw new Error('storage blocked'); return stored.get(key); },
            setItem: (key, value) => { if (blocked) throw new Error('storage blocked'); stored.set(key, value); },
        },
    };
    vm.runInNewContext(i18n + ';globalThis.result = I18N;', scope);
    return scope.result;
}

test('profile keeps the original CSS declarations, cascade, dark theme and mobile rules', () => {
    const rules = normalizeRules(parse(style).stylesheet.rules);
    assert.equal(sha(JSON.stringify(rules)), baseline.cssDigest);
    assert.ok(rules.some(r => r.media === '(prefers-color-scheme: dark)'));
    assert.ok(rules.some(r => r.media === '(max-width:760px)'));
    assert.match(style, /\.hidden\s*\{\s*display: none!important/);
    assert.doesNotMatch(style, /\.composer\b|\.prodList\b|\.modelSheet\b|--world-/);
    assert.ok(Buffer.byteLength(style) < 10000);
});

test('every static and dynamic profile label remains in the translation contract', () => {
    const keys = [...new Set([
        ...[...actor.matchAll(/\bt\('([^']+)'/g)].map(m => m[1]),
        ...[...html.matchAll(/data-(?:i18n(?:-aria|-placeholder|-title)?|doc-title)="([^"]+)"/g)].map(m => m[1]),
    ])].sort();
    assert.deepEqual(keys, baseline.uiKeys);
    assert.doesNotMatch(i18n, /newWorld:|modelSheetTitle:|worldbookLibrary:|function renderName/);
    assert.ok(Buffer.byteLength(i18n) < 11000);
});

test('profile resources have stable content-versioned URLs after deployment', () => {
    for (const asset of ['console.css', 'i18n.js']) {
        assert.ok(html.includes(`"${asset}?v=${sha(read(asset)).slice(0, 16)}"`), asset);
        assert.ok(!html.includes(`"${asset}"`), 'unversioned reference: ' + asset);
    }
});

for (const [language, digests] of Object.entries(baseline.translationDigests)) {
    test(`profile preserves all ${language} labels and identity overrides`, () => {
        const identities = [null, {}, { persona_name: '若棠', persona_name_en: 'Ruotang', actor_name: '档案', actor_name_en: 'Archive' }];
        identities.forEach((identity, index) => {
            const labels = locale({ query: '?lang=' + language });
            if (identity) labels.setIdentity(identity);
            const values = baseline.uiKeys.map(key => [key, labels.t(key, { n: 12, m: 3, next: 'NEXT', err: 'ERR' })]);
            assert.ok(values.every(([key, value]) => key !== value));
            assert.equal(sha(JSON.stringify(values)), digests[index]);
        });
    });
}

test('ClawChat URL locale wins; session and browser fallbacks still work', () => {
    for (const [options, expected] of [
        [{ query: '?lang=en-US', session: 'zh', browser: 'zh-TW' }, 'en'],
        [{ session: 'zh-TW', browser: 'en' }, 'zh-Hant'],
        [{ browser: 'zh-CN' }, 'zh'],
        [{ browser: 'ja' }, 'en'],
        [{ query: '?lang=zh-TW', blocked: true, browser: 'en' }, 'zh-Hant'],
        [{ blocked: true, browser: 'zh' }, 'zh'],
    ]) assert.equal(locale(options).lang, expected);
});

test('static title, back-button accessibility and labels still follow the locale', () => {
    const text = { dataset: { i18n: 'personalitySave' } };
    const aria = { dataset: { i18nAria: 'ariaBack' }, setAttribute(key, value) { this[key] = value; } };
    const document = {
        documentElement: {}, body: { dataset: { docTitle: 'appWindowTitleActor' } },
        querySelectorAll: selector => ({ '[data-i18n]': [text], '[data-i18n-aria]': [aria] })[selector] || [],
    };
    const labels = locale({ query: '?lang=en', document });
    labels.setIdentity({ actor_name_en: 'My Archive' });
    labels.applyStatic();
    assert.equal(document.title, 'My Archive');
    assert.equal(document.documentElement.lang, 'en');
    assert.equal(text.textContent, labels.t('personalitySave'));
    assert.equal(aria['aria-label'], labels.t('ariaBack'));
});
