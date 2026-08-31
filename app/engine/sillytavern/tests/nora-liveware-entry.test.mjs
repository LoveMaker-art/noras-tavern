import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import express from 'express';
import { csrfSync } from 'csrf-sync';
import { createLivewareEntryMiddleware, createLivewareIndexHandler, STORY_PROFILE_UPSTREAM_PATH } from '../src/nora-liveware-entry.js';

test('separate Liveware roots identify the correct app without relying on forwarded Host', async (t) => {
    const app = express();
    app.use(createLivewareEntryMiddleware());
    app.use(express.json());
    const csrf = csrfSync({ getTokenFromState: () => 'test-token' });
    app.use(csrf.csrfSynchronisedProtection);
    app.get('/', createLivewareIndexHandler({
        tavernHtml: readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'),
        storyProfileHtml: readFileSync(new URL('../public/actor.html', import.meta.url), 'utf8'),
    }));
    app.get('/actor', (_req, res) => res.redirect(307, '/actor.html'));
    app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url))));
    app.post('/api/probe', (req, res) => res.json({
        url: req.url, method: req.method, body: req.body, cookie: req.headers.cookie,
    }));
    app.use((err, _req, res, _next) => res.status(err.statusCode || 500).end());
    const server = http.createServer(app).listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [route, title, icon] of [
        ['/', 'tavern', '/favicon.ico'],
        [STORY_PROFILE_UPSTREAM_PATH, 'story profile', '/story-profile-icon-v2.png'],
        [`${STORY_PROFILE_UPSTREAM_PATH}/?launch=1`, 'story profile', '/story-profile-icon-v2.png'],
    ]) {
        const response = await fetch(base + route);
        assert.equal(response.status, 200, route);
        assert.equal(response.redirected, false, route);
        const html = await response.text();
        assert.ok(html.includes(`<title>${title}</title>`), route);
        assert.match(html, new RegExp(`<link[^>]*rel="icon"[^>]*${icon.replaceAll('.', '\\.')}[^>]*>`));
        if (title === 'story profile') assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    for (const prefix of ['', STORY_PROFILE_UPSTREAM_PATH]) {
        const legacy = await fetch(base + prefix + '/actor', { redirect: 'manual' });
        assert.equal(legacy.status, 307);
        assert.equal(legacy.headers.get('location'), '/actor.html');
        for (const asset of ['actor.html', 'actor.js', 'story-profile-icon-v2.png', 'favicon.ico']) {
            const response = await fetch(`${base}${prefix}/${asset}`);
            assert.equal(response.status, 200, asset);
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(new URL(`../public/${asset}`, import.meta.url)));
        }
        const url = base + prefix + '/api/probe?world=a%2Fb';
        const options = { method: 'POST', body: '{"message":"unchanged"}', headers: { 'content-type': 'application/json', cookie: 'fixture=1' } };
        assert.equal((await fetch(url, options)).status, 403, 'entry must not bypass CSRF');
        options.headers['x-csrf-token'] = 'test-token';
        const response = await fetch(url, options);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { url: '/api/probe?world=a%2Fb', method: 'POST', body: { message: 'unchanged' }, cookie: 'fixture=1' });
    }
    assert.equal((await fetch(base + STORY_PROFILE_UPSTREAM_PATH + '-other/')).status, 404, 'prefix must match a whole path segment');
});

test('production entry routing precedes shared security and the binding selects the profile entry', () => {
    const server = readFileSync(new URL('../src/server-main.js', import.meta.url), 'utf8');
    assert.ok(server.indexOf('app.use(createLivewareEntryMiddleware())') > 0);
    assert.ok(server.indexOf('app.use(createLivewareEntryMiddleware())') < server.indexOf('app.use(helmet('));
    assert.match(server, /createLivewareIndexHandler\(\{[\s\S]*tavernHtml: indexHtml,[\s\S]*storyProfileHtml:/);
    const bringup = readFileSync(new URL('../../../../ops/scripts/bringup-native.sh', import.meta.url), 'utf8');
    assert.ok(bringup.includes(`"$ACTOR_APP_ID" "http://127.0.0.1:$NATIVE_PORT${STORY_PROFILE_UPSTREAM_PATH}"`));
    const provision = readFileSync(new URL('../../../../ops/scripts/provision.sh', import.meta.url), 'utf8');
    assert.ok(provision.includes('url = "https://%s/" % e["domain"]'));
});
