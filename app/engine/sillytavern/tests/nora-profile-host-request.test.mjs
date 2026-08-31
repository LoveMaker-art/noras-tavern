import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('profile writes carry host CSRF and reads do not trigger extra token requests', async () => {
    const calls = [];
    const scope = { Headers, fetch: async (url, options) => {
        calls.push({ url, options });
        if (url === '/csrf-token') return { ok: true, json: async () => ({ token: 'fixture-token' }) };
        if (options.method === 'POST') assert.equal(options.headers.get('X-CSRF-Token'), 'fixture-token');
        return { ok: true };
    } };
    vm.runInNewContext(readFileSync(new URL('../public/nora-profile-request.js', import.meta.url), 'utf8'), scope);
    await scope.noraProfileRequest('/api/actor_card');
    assert.equal(calls.length, 1);
    await scope.noraProfileRequest('/api/personality', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(calls.length, 3);
    assert.equal(calls[2].options.headers.get('Content-Type'), 'application/json');
    assert.equal(calls[2].options.credentials, 'same-origin');
    const html = readFileSync(new URL('../public/actor.html', import.meta.url), 'utf8');
    assert.ok(html.indexOf('nora-profile-request.js') >= 0 && html.indexOf('nora-profile-request.js') < html.indexOf('src="actor.js"'));
    assert.match(readFileSync(new URL('../public/actor.js', import.meta.url), 'utf8'), /await globalThis\.noraProfileRequest\('\/api\/personality',/);
});
