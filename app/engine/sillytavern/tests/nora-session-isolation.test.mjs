import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import cookieSession from 'cookie-session';
import { csrfSync } from 'csrf-sync';
import express from 'express';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(path.resolve('default/config.yaml'));
const { getCookieSecret, getCookieSessionName } = await import('../src/workspace.js');
const { router: presetRouter } = await import('../src/endpoints/presets.js');

async function instance(t, root) {
    const presets = path.join(root, 'OpenAI Settings');
    await fs.mkdir(presets, { recursive: true });
    const name = getCookieSessionName(root);
    const app = express();
    app.use(express.json());
    app.use(cookieSession({ name, secret: getCookieSecret(root), sameSite: 'lax', httpOnly: true }));
    const csrf = csrfSync();
    app.get('/csrf-token', (req, res) => res.json({ token: csrf.generateToken(req) }));
    app.use(csrf.csrfSynchronisedProtection);
    app.use((req, _res, next) => { req.user = { directories: { openAI_Settings: presets } }; next(); });
    app.use('/api/presets', presetRouter);
    app.use((error, _req, res, _next) => res.sendStatus(error.statusCode || 500));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const stop = async () => {
        if (server.listening) await new Promise(resolve => server.close(resolve));
    };
    t.after(stop);
    return { base: `http://127.0.0.1:${server.address().port}`, name, presets, stop };
}

function cookieClient() {
    // Browser cookies are shared by hostname, not port. Both instances use this jar.
    const jar = new Map();
    async function request(server, route, init = {}) {
        const response = await fetch(server.base + route, {
            ...init, headers: { Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), ...init.headers },
        });
        for (const cookie of response.headers.getSetCookie()) {
            const pair = cookie.split(';')[0];
            const separator = pair.indexOf('=');
            const name = pair.slice(0, separator), value = pair.slice(separator + 1);
            if (!value) jar.delete(name);
            else jar.set(name, value);
        }
        return response;
    }
    const token = async server => (await (await request(server, '/csrf-token')).json()).token;
    const save = (server, csrfToken, name = 'Saved copy') => request(server, '/api/presets/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ name, apiId: 'openai', preset: {
            openai_max_context: 30000, openai_max_tokens: 4000, prompts: [], prompt_order: [],
        } }),
    });
    return { jar, token, save };
}

async function fixtureRoot(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nora-session-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

test('cookie names are stable for one data root and isolated between data roots', () => {
    const root = path.resolve('test-data-a');
    assert.equal(getCookieSessionName(root), getCookieSessionName(path.join(root, 'child', '..')));
    assert.notEqual(getCookieSessionName(root), getCookieSessionName(path.resolve('test-data-b')));
    assert.match(getCookieSessionName(root), /^session-[a-f0-9]+$/);
    assert.ok(!getCookieSessionName(root).includes('test-data'));
});

test('alternating between local instances preserves both sessions and saves both presets', async t => {
    const root = await fixtureRoot(t);
    const a = await instance(t, path.join(root, 'installed'));
    const b = await instance(t, path.join(root, 'preview'));
    const client = cookieClient();
    const aToken = await client.token(a);
    const bToken = await client.token(b);
    assert.equal((await client.save(a, aToken)).status, 200, 'Opening the preview must not invalidate the installed instance');
    assert.equal((await client.save(b, bToken)).status, 200, 'Saving in the installed instance must not invalidate the preview');
    for (const server of [a, b]) {
        const saved = JSON.parse(await fs.readFile(path.join(server.presets, 'Saved copy.json'), 'utf8'));
        assert.equal(saved.openai_max_context, 30000);
        assert.equal(saved.openai_max_tokens, 4000);
        assert.ok(client.jar.has(`${server.name}.sig`));
    }
});

test('restarting the same data root preserves the signed session', async t => {
    const root = await fixtureRoot(t);
    const first = await instance(t, root);
    const client = cookieClient();
    const token = await client.token(first);
    await first.stop();
    const restarted = await instance(t, root);
    assert.equal(restarted.name, first.name);
    assert.equal((await client.save(restarted, token)).status, 200);
});

test('missing signature and incorrect CSRF token remain rejected without writing', async t => {
    const root = await fixtureRoot(t);
    const server = await instance(t, root);
    const client = cookieClient();
    const token = await client.token(server);
    assert.equal((await client.save(server, 'incorrect-token')).status, 403);
    client.jar.delete(`${server.name}.sig`);
    assert.equal((await client.save(server, token)).status, 403);
    assert.deepEqual(await fs.readdir(server.presets), []);
    const renewed = await client.token(server);
    assert.equal((await client.save(server, renewed)).status, 200);
});
