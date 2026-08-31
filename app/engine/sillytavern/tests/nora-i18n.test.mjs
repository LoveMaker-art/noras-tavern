import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import { english } from '../public/scripts/nora-i18n/strings.js';
import { resolveNoraLocale, resolveExtensionLocale } from '../public/scripts/nora-i18n/locale.js';
import { renderNoraIndex } from '../src/nora-static-assets.js';
import { renderLocaleBootstrap } from '../src/nora-locale-bootstrap.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { parse } = require('acorn');

function runPage(locale, code) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `globalThis.__NORA_LOCALE__ = ${JSON.stringify(locale)};\n${code}`], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

test('page lang takes precedence; browser fallback is deterministic without storage', () => {
    assert.equal(resolveNoraLocale('?lang=en-US', 'zh-CN'), 'en');
    assert.equal(resolveNoraLocale('?lang=zh_Hant', 'en'), 'zh-cn');
    assert.equal(resolveNoraLocale('', 'zh-CN'), 'zh-cn');
    assert.equal(resolveNoraLocale('?lang=ja', 'zh-CN'), 'en');
    assert.equal(resolveNoraLocale('?lang=', 'en-GB'), 'en');
});

test('extension locale uses exact matches before valid base-language aliases', () => {
    assert.equal(resolveExtensionLocale({ en: 'en.json' }, 'en-US'), 'en');
    assert.equal(resolveExtensionLocale({ en: 'base', 'en-US': 'exact' }, 'en-US'), 'en-US');
    assert.equal(resolveExtensionLocale({ 'zh-CN': 'zh.json' }, 'zh-Hans'), 'zh-CN');
    assert.equal(resolveExtensionLocale({ en: 'en.json' }, 'zh-cn'), undefined);
});

test('catalog keeps every indexed parameter intact', () => {
    const parameters = s => [...s.matchAll(/\$\{(\d+)\}/g)].map(m=>m[1]).sort();
    for (const [source, translated] of Object.entries(english)) {
        assert.deepEqual(parameters(translated), parameters(source), source);
        assert.ok(translated.trim(), source);
    }
});

test('all explicit Nora translation calls and templates have English entries', () => {
    const directory = path.resolve(root, '../../native-extensions/nora-ui');
    let calls = 0;
    for (const file of fs.readdirSync(directory).filter(f=>f.endsWith('.js'))) {
        const source = fs.readFileSync(path.join(directory,file),'utf8');
        const visit = (node) => {
            if (!node || typeof node !== 'object') return;
            let key;
            if (node.type === 'CallExpression' && node.callee.name === 'tr') key = node.arguments[0]?.value;
            if (node.type === 'TaggedTemplateExpression' && node.tag.name === 't') key = node.quasi.quasis.map((q,i)=>q.value.cooked+(i<node.quasi.expressions.length?'${'+i+'}':'')).join('');
            if (key !== undefined) { calls++; assert.ok(Object.hasOwn(english,key), `${file}: ${key}`); }
            for (const [k,v] of Object.entries(node)) if (!['start','end'].includes(k)) {
                if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === 'object') visit(v);
            }
        };
        visit(parse(source,{ecmaVersion:'latest',sourceType:'module'}));
    }
    assert.ok(calls > 300);
});

test('early shell and module use the same language, no unresolved bootstrap token', () => {
    const template = fs.readFileSync(path.join(root,'public/index.html'),'utf8');
    assert.ok(!renderNoraIndex(template,'0123456789abcdef').includes('{{NORA_LOCALE_BOOTSTRAP}}'));
    for (const [lang, browser, expected] of [['en','zh-CN','Your story is about to begin'],['zh','en-US','故事即将开始']]) {
        const context = { URLSearchParams, location:{search:'?lang='+lang}, navigator:{language:browser}, document:{documentElement:{}} };
        vm.runInNewContext(renderLocaleBootstrap(template),context);
        assert.equal(context.__NORA_TRANSLATE_EARLY__('故事即将开始'),expected);
        assert.equal(context.document.documentElement.lang,resolveNoraLocale('?lang='+lang,browser));
    }
});

test('ST and bundled Nora share registry; plugins cannot override reserved labels', () => {
    const result = runPage('en', `
        const a = await import('./public/scripts/nora-i18n/core.js');
        const b = await import('./public/scripts/nora-i18n/core.js?second-module-identity');
        a.addLocaleData('en', {'插件提示':'Plugin notice', '发送':'Wrong'});
        a.addLocaleData('zh-cn', {'插件提示':'Wrong locale'});
        console.log(JSON.stringify({same:a.localeData===b.localeData, label:b.translate('发送'), plugin:b.translate('插件提示'), message:a.t(['删除“','”？'], '中文角色'), raw:a.translate('用户自己的中文')}));
    `);
    assert.deepEqual(result,{same:true,label:'Send',plugin:'Plugin notice',message:'Delete “中文角色”?',raw:'用户自己的中文'});
});

test('MVU source selection is unchanged by language and preserves provider names', () => {
    for (const lang of ['zh-cn','en']) {
        const result = runPage(lang, `
            const {renderMvuModelSection} = await import('../../native-extensions/nora-ui/model-controller.js');
            const {projectTextModelDisplay} = await import('../../native-extensions/nora-ui/model-display.js');
            const html = renderMvuModelSection({supported:true,enabled:true,initialized:true,variableModel:'自定义',variableModelName:'中文模型'}, String);
            console.log(JSON.stringify({html,empty:projectTextModelDisplay().label}));
        `);
        assert.match(result.html,/class="active" data-mvu-source="independent"/);
        assert.match(result.html,/>中文模型</);
        assert.equal(result.empty, lang==='en'?'No model configured':'尚未配置模型');
    }
});

test('message format markers and card/user content remain unchanged', () => {
    const code = `
        const {getFormatEdit} = await import('../../native-extensions/nora-ui/composer-format-controller.js');
        console.log(JSON.stringify(['dialogue','action','emphasis'].map(mode=>getFormatEdit('中文对白',0,4,mode))));
    `;
    assert.deepEqual(runPage('en',code),runPage('zh-cn',code));
});

test('entry registration translates retained ST popup defaults even after prelude initialization', () => {
    const result = runPage('zh-cn', `
        const fs = await import('node:fs');
        const {setLocaleData} = await import('./public/scripts/nora-i18n/core.js');
        const {applyNoraLocale} = await import('./public/scripts/nora-i18n/dom.js');
        const attrs = {'data-i18n':'[popup-button-save]popup-button-save','popup-button-save':'Save'};
        const node = {getAttribute:key=>attrs[key],setAttribute:(key,value)=>attrs[key]=value};
        const queries=[];
        const doc={documentElement:{},querySelectorAll:selector=>{queries.push(selector);return selector.endsWith('template')?[]:[node];}};
        applyNoraLocale(doc);
        const before=attrs['popup-button-save'];
        setLocaleData(JSON.parse(fs.readFileSync('public/locales/zh-cn.json','utf8')));
        applyNoraLocale(doc);
        console.log(JSON.stringify({before,after:attrs['popup-button-save'],queries,lang:doc.documentElement.lang}));
    `);
    assert.equal(result.before,'Save');
    assert.equal(result.after,'保存');
    assert.equal(result.lang,'zh-cn');
    assert.ok(result.queries.every(selector=>selector.startsWith('[name="templatesAndPopupsWrapper"]')));
});

test('ST template interpolation preserves undefined handling and does not reinterpret values', () => {
    const result = runPage('en', `
        const {t} = await import('./public/scripts/nora-i18n/core.js');
        console.log(JSON.stringify([t(['A','B'],undefined),t(['X','Y'],null),t(['Value: ',''],'$&') ]));
    `);
    assert.deepEqual(result,['AB','XnullY','Value: $&']);
});
