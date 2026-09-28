import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import Handlebars from 'handlebars';

const powerSource = readFileSync(new URL('../public/scripts/power-user.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
// Execute the real renderer, validator and Generate call site without starting
// the DOM-heavy ST module. No model requests or user data are involved.
const renderer = powerSource.slice(powerSource.indexOf('export function renderStoryString('), powerSource.indexOf('const sortFunc ='))
    .replace('export function', 'function');
const callSite = mainSource.match(/const storyString = renderStoryString\(storyStringParams[\s\S]*?\);/)?.[0];
assert.ok(callSite, 'Generate must expose its story-string rendering call');

function harness(template = '{{description}}') {
    const warnings = [], errors = [], logs = [], cache = new Map();
    const context = vm.createContext({
        Handlebars, structuredClone,
        power_user: { instruct: { enabled: false }, context: { story_string: template } },
        extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1 },
        substituteParams: value => value,
        accountStorage: { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value) },
        storage_keys: { storyStringValidationCache: 'validation' },
        getStringHash: value => value,
        console: { warn: (...args) => logs.push(args), error: () => {} },
        toastr: { warning: (body, title) => warnings.push({ body, title }), error: (...args) => errors.push(args) },
        storyStringParams: { description: 'Setting', wiBefore: 'Shared world fact', wiAfter: 'Another fact' },
    });
    vm.runInContext(renderer, context);
    return {
        context, warnings, errors, logs, cache,
        generate(api) {
            context.main_api = api;
            return vm.runInContext(`(() => { ${callSite} return storyString; })()`, context);
        },
    };
}

test('chat completion does not warn or cache missing fields in the unused story template', () => {
    const h = harness();
    assert.equal(h.generate('openai'), 'Setting\n');
    assert.equal(h.warnings.length, 0);
    assert.equal(h.logs.length, 0);
    assert.equal(h.cache.size, 0);
});

for (const api of ['textgenerationwebui', 'kobold', 'novel']) {
    test(`${api} retains missing-worldbook warnings and warn-once caching`, () => {
        const h = harness();
        assert.equal(h.generate(api), 'Setting\n');
        assert.equal(h.warnings.length, 1);
        assert.match(h.warnings[0].body, /\{\{wiBefore\}\}, \{\{wiAfter\}\}/);
        assert.equal(h.warnings[0].title, 'Story String Validation');
        h.generate(api);
        assert.equal(h.warnings.length, 1);
    });
}

test('switching from chat completion to a template-based API still warns', () => {
    const h = harness();
    h.generate('openai');
    assert.equal(h.warnings.length, 0);
    h.generate('textgenerationwebui');
    assert.equal(h.warnings.length, 1);
});

test('explicit renderer callers keep validation even when the selected API is chat completion', () => {
    const h = harness();
    h.context.main_api = 'openai';
    vm.runInContext('renderStoryString(storyStringParams)', h.context);
    assert.equal(h.warnings.length, 1);
});

test('complete templates render the same content in both modes', () => {
    const h = harness('{{wiBefore}}\n{{description}}\n{{wiAfter}}');
    assert.equal(h.generate('openai'), 'Shared world fact\nSetting\nAnother fact\n');
    assert.equal(h.generate('textgenerationwebui'), 'Shared world fact\nSetting\nAnother fact\n');
    assert.equal(h.warnings.length, 0);
});

test('template syntax errors are not swallowed in chat completion', () => {
    const h = harness('{{#if description}}');
    assert.throws(() => h.generate('openai'));
    assert.equal(h.errors.length, 1);
});
