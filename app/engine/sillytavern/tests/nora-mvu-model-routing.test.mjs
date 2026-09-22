import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import express from 'express';
import ts from 'typescript';
import { setConfigFilePath } from '../src/util.js';
import { NoraMvuModelConfig, NORA_MVU_MODEL_PROXY_URL } from '../src/nora-mvu-model-config.js';
import { createMvuSettingsControls } from '../public/scripts/nora-compat/mvu-settings.js';

setConfigFilePath(new URL('../default/config.yaml', import.meta.url).pathname);
const { SECRET_KEYS, writeSecret } = await import('../src/endpoints/secrets.js');
const { router } = await import('../src/endpoints/backends/chat-completions.js');

// Use the shipped Helper's actual source selection and request overrides, not
// an assumed `custom` request. Recheck these bindings on a Helper upgrade.
const helper = fs.readFileSync(new URL('../../../native-extensions/JS-Slash-Runner/dist/index.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('helper.js', helper, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = ['CG', 'BG', 'HW'];
const declarations = ast.statements.filter(ts.isFunctionDeclaration).filter(node => names.includes(node.name?.text));
assert.equal(declarations.length, names.length);
const bridge = vm.createContext({});
vm.runInContext(declarations.map(node => node.getText(ast)).join('\n'), bridge);

function helperRequest({ source, apiurl, key = '', model = 'stale-browser-model', ...options }) {
    const body = {
        chat_completion_source: bridge.CG({ customSource: source, hasCustomApiUrl: Boolean(apiurl), defaultSource: 'openai' }),
        messages: [{ role: 'system', content: 'Update variables only.' }, { role: 'user', content: 'The lamp was switched on.' }],
        stream: false, max_tokens: 1000, ...options,
    };
    bridge.BG(body, { source, apiurl, key, model });
    return body;
}

async function listen(t, server) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return `http://127.0.0.1:${server.address().port}`;
}

test('independent MVU settings → shipped Helper → real backend routing', async t => {
    // No real provider can be reached, including on the failing baseline.
    const lookups = [];
    const lookup = dns.lookup;
    t.mock.method(dns, 'lookup', (hostname, options, callback) => {
        if (hostname === '127.0.0.1') return lookup(hostname, options, callback);
        lookups.push(hostname);
        const done = typeof options === 'function' ? options : callback;
        queueMicrotask(() => done(Object.assign(new Error(`Blocked test DNS: ${hostname}`), { code: 'ENOTFOUND' })));
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nora-mvu-routing-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let directories;
    const received = [];
    const provider = await listen(t, http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : null;
        received.push({ url: req.url, authorization: req.headers.authorization, body });
        if (body?.stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            return res.end('data: {"choices":[{"delta":{"content":"fixture reply"}}]}\n\ndata: [DONE]\n\n');
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.method === 'GET' ? { data: [{ id: 'fixture-mvu' }] } : {
            choices: [{ message: { role: 'assistant', content: 'fixture reply' } }],
        }));
    }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { directories, profile: { handle: 'routing-fixture' } }; next(); });
    app.use(router);
    const base = await listen(t, http.createServer(app));
    const post = (route, body) => fetch(base + route, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    function configure(name, { config = true, key = true } = {}) {
        directories = { root: path.join(root, name) };
        fs.mkdirSync(directories.root);
        if (config) new NoraMvuModelConfig(directories.root).save({ base_url: `${provider}/v1`, model: 'fixture-mvu' });
        if (key) writeSecret(directories, SECRET_KEYS.NORA_MVU, 'fixture-mvu-key');
        writeSecret(directories, SECRET_KEYS.CUSTOM, 'fixture-story-key');
    }
    let settings;
    createMvuSettingsControls(value => { settings = value; }).useIndependentModel({ model: 'browser-model' });
    const apiurl = settings.额外模型解析配置.api地址;
    assert.equal(apiurl, NORA_MVU_MODEL_PROXY_URL);
    assert.equal(settings.额外模型解析配置.密钥, '');

    const formats = [
        { name: 'chat message' },
        { name: 'tool call', tools: [{ type: 'function', function: { name: 'UpdateVariable', parameters: { type: 'object' } } }], tool_choice: 'required' },
        { name: 'structured output', json_schema: { name: 'update', value: { type: 'object', properties: {} } } },
        { name: 'v4 compatible', source: 'custom', json_schema: { name: 'update', value: { type: 'object', properties: {} } } },
    ];
    for (const [index, { name, source, ...options }] of formats.entries()) {
        for (const stream of [false, true]) {
            await t.test(`${name}, stream=${stream}: use saved endpoint, model and independent key`, async () => {
                configure(`format-${index}-${stream}`);
                const body = helperRequest({ apiurl, source, stream, ...options });
                const before = received.length;
                const res = await post('/generate', body);
                const text = await res.text();
                assert.equal(res.status, 200, text);
                assert.match(text, /fixture reply/);
                assert.equal(received.length, before + 1);
                const request = received.at(-1);
                assert.equal(request.url, '/v1/chat/completions');
                assert.equal(request.authorization, 'Bearer fixture-mvu-key');
                assert.equal(request.body.model, 'fixture-mvu');
                assert.deepEqual(request.body.messages, body.messages);
                assert.equal(request.body.max_tokens, body.max_tokens);
                if (options.tools) assert.deepEqual(request.body.tools, options.tools);
                if (options.json_schema) assert.equal(request.body.response_format.type, 'json_schema');
            });
        }
    }
    for (const source of ['openai', 'custom']) {
        await t.test(`${source}: model listing resolves the same configuration as generation`, async () => {
            configure(`status-${source}`);
            const res = await post('/status', helperRequest({ source, apiurl }));
            assert.deepEqual((await res.json()).data, [{ id: 'fixture-mvu' }]);
            assert.equal(received.at(-1).url, '/v1/models');
            assert.equal(received.at(-1).authorization, 'Bearer fixture-mvu-key');
        });
        for (const missing of ['config', 'key']) {
            await t.test(`${source}: missing ${missing} fails before contacting any provider`, async () => {
                configure(`missing-${source}-${missing}`, { [missing]: false });
                for (const route of ['/generate', '/status']) {
                    const before = received.length;
                    const res = await post(route, helperRequest({ source, apiurl }));
                    assert.equal(res.status, 400);
                    const reply = await res.json();
                    assert.equal(reply.error.code, missing === 'config' ? 'mvu_model_not_configured' : 'mvu_model_key_required');
                    assert.doesNotMatch(JSON.stringify(reply), /fixture-story-key|fixture-mvu-key/);
                    assert.equal(received.length, before);
                }
            });
        }
        await t.test(`${source}: ordinary real-URL requests do not use independent credentials`, async () => {
            configure(`ordinary-${source}`);
            const body = helperRequest({ source, apiurl: `${provider}/ordinary`, model: 'ordinary-model' });
            body.proxy_password = 'fixture-proxy-key';
            const res = await post('/generate', body);
            assert.equal(res.status, 200, await res.text());
            assert.equal(received.at(-1).url, '/ordinary/chat/completions');
            assert.equal(received.at(-1).body.model, 'ordinary-model');
            assert.equal(received.at(-1).authorization, source === 'custom' ? 'Bearer fixture-story-key' : 'Bearer fixture-proxy-key');
        });
    }
    await t.test('a protocol mismatch cannot send the reserved marker to a native provider', async () => {
        configure('wrong-protocol');
        const before = received.length;
        for (const source of ['claude', 'makersuite', 'deepseek', 'openrouter']) {
            for (const route of ['/generate', '/status']) {
                const res = await post(route, helperRequest({ source, apiurl }));
                assert.equal(res.status, 400);
                assert.equal((await res.json()).error.code, 'mvu_model_route_invalid');
            }
        }
        assert.equal(received.length, before);
    });
    await t.test('changed and per-user configurations resolve afresh, without cross-user fallback', async () => {
        configure('user-a');
        const a = directories;
        const request = helperRequest({ apiurl });
        const first = await post('/generate', request);
        assert.equal(first.status, 200, await first.text());
        configure('user-b');
        new NoraMvuModelConfig(directories.root).save({ base_url: `${provider}/b`, model: 'model-b' });
        writeSecret(directories, SECRET_KEYS.NORA_MVU, 'fixture-key-b');
        const second = await post('/generate', request);
        assert.equal(second.status, 200, await second.text());
        assert.equal(received.at(-1).url, '/b/chat/completions');
        assert.equal(received.at(-1).body.model, 'model-b');
        assert.equal(received.at(-1).authorization, 'Bearer fixture-key-b');
        directories = a;
        new NoraMvuModelConfig(a.root).save({ base_url: `${provider}/a-new`, model: 'model-a-new' });
        const third = await post('/generate', request);
        assert.equal(third.status, 200, await third.text());
        assert.equal(received.at(-1).url, '/a-new/chat/completions');
        assert.equal(received.at(-1).body.model, 'model-a-new');
        assert.equal(received.at(-1).authorization, 'Bearer fixture-mvu-key');
    });
    await t.test('corrupt or self-referencing stored configuration fails before network access', async () => {
        configure('invalid-store');
        const file = new NoraMvuModelConfig(directories.root).filePath;
        for (const content of ['{broken', JSON.stringify({ base_url: apiurl, model: 'fixture' })]) {
            fs.writeFileSync(file, content);
            const before = received.length;
            const res = await post('/generate', helperRequest({ apiurl }));
            assert.equal(res.status, 400);
            assert.equal((await res.json()).error.code, 'invalid_mvu_model_config');
            assert.equal(received.length, before);
        }
    });
    assert.deepEqual(lookups, [], 'No unresolved marker or external host may reach DNS');
});
