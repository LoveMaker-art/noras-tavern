import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { load } from 'cheerio';
import { parse } from '@adobe/css-tools';

const css = fs.readFileSync(new URL('../../../native-extensions/nora-ui/style.css', import.meta.url), 'utf8');
const rules = parse(css).stylesheet.rules.filter(rule => rule.type === 'rule');

function declarations($, id, pseudo = '') {
    const result = {};
    for (const rule of rules) {
        const matches = rule.selectors.some(selector => {
            if (!/(?:^|[ >])q(?=[\s:.#>]|$)/.test(selector)) return false;
            const suffix = selector.match(/::(before|after)$/)?.[0] || '';
            if (suffix !== pseudo) return false;
            if (!suffix && /::/.test(selector)) return false;
            return $(id).is(suffix ? selector.slice(0, -suffix.length) : selector);
        });
        if (matches) for (const declaration of rule.declarations) {
            if (declaration.type === 'declaration') result[declaration.property] = declaration.value;
        }
    }
    return result;
}

for (const rich of [false, true]) {
    test(`dialogue retains literal quotes without generated quotes; rich=${rich}`, () => {
        const $ = load(`<div id="nora-chat"><div class="mes ${rich ? 'nora-rich-message' : ''}"><div class="mes_text">
            <q id="direct">“Hello.”</q><p><q id="paragraph">“Hello.”</q></p>
            <ul><li><q id="list">“Hello.”</q></li></ul>
            <blockquote><p><q id="quoted">“Hello.”</q></p></blockquote>
            ${rich ? '<div class="status"><q id="custom">Custom quotation</q></div><iframe></iframe>' : ''}
            </div></div></div>`);
        for (const id of ['#direct', '#paragraph', '#list', '#quoted']) {
            assert.equal(declarations($, id).color, 'var(--nora-brand-ink)');
            assert.equal(declarations($, id).quotes, 'none');
            for (const pseudo of ['::before', '::after']) assert.equal(declarations($, id, pseudo).content, 'none');
            assert.equal($(id).text(), '“Hello.”');
        }
        if (rich) {
            assert.equal(declarations($, '#custom').color, undefined);
            assert.equal(declarations($, '#custom', '::before').content, undefined);
        }
    });
}

test('format menu keeps its intentional quotation marks', () => {
    const $ = load('<div class="nora-format-menu"><q id="preview">Dialogue</q></div>');
    assert.equal(declarations($, '#preview', '::before').content, "'“'");
    assert.equal(declarations($, '#preview', '::after').content, "'”'");
});
