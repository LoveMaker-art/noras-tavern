import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { mountJSONEditor } from '../../../native-extensions/JS-Slash-Runner/deferred-json-editor.js';
import { transformDeferredEditor } from '../../../native-extensions/JS-Slash-Runner/apply-deferred-json-editor.mjs';

function target() {
    const attributes = new Map();
    return { textContent: '', attributes, setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k) };
}

test('editor waits for its dependency and uses latest state at initialization', async () => {
    let release;
    let content = 'old';
    let actual;
    const element = target();
    const pending = mountJSONEditor({ target: element, disposed: () => false,
        load: () => new Promise(resolve => { release = resolve; }), initialize: () => { actual = content; } });
    assert.equal(actual, undefined);
    assert.equal(element.attributes.get('aria-busy'), 'true');
    content = 'new';
    release({});
    await pending;
    assert.equal(actual, 'new');
    assert.equal(element.attributes.size, 0);
});

test('closing during download never creates an editor on the detached target', async () => {
    let release;
    let closed = false;
    let initialized = false;
    const pending = mountJSONEditor({ target: target(), disposed: () => closed,
        load: () => new Promise(resolve => { release = resolve; }), initialize: () => { initialized = true; } });
    closed = true;
    release({});
    await pending;
    assert.equal(initialized, false);
});

test('failed editor loading clears busy state without initializing or changing variables', async context => {
    context.mock.method(console, 'error', () => {});
    const element = target();
    let initialized = false;
    await mountJSONEditor({ target: element, disposed: () => false,
        load: async () => { throw new Error('offline'); }, initialize: () => { initialized = true; } });
    assert.equal(initialized, false);
    assert.equal(element.attributes.size, 0);
    assert.match(element.textContent, /could not be loaded/);
});

test('managed transform is guarded, idempotent and removes the eager dependency', () => {
    const source = fs.readFileSync(new URL('../../../native-extensions/JS-Slash-Runner/dist/index.js', import.meta.url), 'utf8');
    const transformed = transformDeferredEditor(source);
    assert.equal(transformDeferredEditor(transformed), transformed);
    assert.ok(!transformed.includes('from"../lib/jsoneditor.js"'));
    assert.match(transformed, /noraStopEditorWatch\?\.\(\)/);
    assert.throws(() => transformDeferredEditor('unknown bundle'), /anchors/);
});

test('shipped component initializes current variables and disposes its asynchronous watcher', async () => {
    const source = fs.readFileSync(new URL('../../../native-extensions/JS-Slash-Runner/dist/index.js', import.meta.url), 'utf8');
    const start = source.indexOf('H4=L({__name:`JsonEditor`') + 3;
    const end = source.indexOf(',U4=', start);
    assert.ok(start > 3 && end > start);
    let mounted, unmount, release;
    let watched = 0, stopped = 0, destroyed = 0, cancelled = 0;
    let options;
    const content = { value: { value: 'old' } };
    const element = target();
    const component = vm.runInNewContext(source.slice(start, end), {
        L: value => value, Es: Object.assign, js: () => content, Go: () => ({ value: element }),
        _: { debounce: fn => Object.assign(fn, { cancel: () => cancelled++ }) },
        is: fn => { mounted = fn; }, as: fn => { unmount = fn; },
        I: () => { watched++; return () => stopped++; },
        noraMountJSONEditor: args => mountJSONEditor({ ...args, load: () => new Promise(resolve => { release = resolve; }) }),
        document: { documentElement: { style: { setProperty() {} } } },
        V4: 1000, B4: JSON.parse, f: () => 'en', setTimeout,
    });
    component.setup({}, { expose() {} });
    const pending = mounted();
    content.value = { value: 'latest' };
    release({ Mode: { tree: 'tree', text: 'text' }, ValidationSeverity: { error: 'error' },
        createJSONEditor: value => { options = value; return { destroy: () => destroyed++ }; } });
    await pending;
    assert.equal(options.props.content.json, content.value);
    assert.equal(watched, 1);
    unmount();
    assert.equal(stopped, 1);
    assert.equal(destroyed, 1);
    assert.equal(cancelled, 1);
});
