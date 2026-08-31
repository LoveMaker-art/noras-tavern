import test from 'node:test';
import assert from 'node:assert/strict';
import { NoraHttpClient } from '../dist/http.js';
import { StHttpClient } from '../dist/st/http.js';

test('Nora/ST share implementation; concurrent cold POSTs send newly issued cookie on their first attempt', async () => {
    assert.equal(StHttpClient, NoraHttpClient);
    const original = globalThis.fetch; const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push([url, options]);
        if (url.endsWith('/csrf-token')) return new Response('{"token":"fixture"}', { headers: { 'set-cookie': 'session=fixture; Path=/' } });
        assert.equal(options.headers.get('Cookie'), 'session=fixture');
        assert.equal(options.headers.get('X-CSRF-Token'), 'fixture');
        return new Response('{}');
    };
    try {
        const client = new NoraHttpClient('http://127.0.0.1', 1000);
        await Promise.all([client.post('/a'), client.post('/b')]);
        assert.equal(calls.length, 3);
        assert.equal(calls.filter(([url]) => url.endsWith('/csrf-token')).length, 1);
    } finally { globalThis.fetch = original; }
});

test('CSRF rejection is retried once; transport and 5xx writes are not retried or exposed verbatim', async () => {
    const original = globalThis.fetch; let tokens = 0; let posts = 0;
    globalThis.fetch = async url => {
        if (url.endsWith('/csrf-token')) return new Response(JSON.stringify({ token: 't' + ++tokens }));
        posts++;
        return posts === 1 ? new Response('Invalid CSRF token', { status: 403 }) : new Response('{}');
    };
    try {
        await new NoraHttpClient('http://127.0.0.1', 1000).post('/a');
        assert.equal(tokens, 2); assert.equal(posts, 2);
        const client = new NoraHttpClient('http://127.0.0.1', 1000);
        await client.csrf(); posts = 0;
        globalThis.fetch = async () => { posts++; return new Response('{"error":"private-provider-secret"}', { status: 502 }); };
        await assert.rejects(client.post('/a'), error => error.outcome === 'unknown' && !error.message.includes('private-provider-secret'));
        assert.equal(posts, 1);
        globalThis.fetch = async () => { posts++; throw new Error('private-network-secret'); };
        await assert.rejects(client.post('/a'), error => error.code === 'NORA_TRANSPORT_FAILED' && error.outcome === 'unknown' && !error.message.includes('private-network-secret'));
        assert.equal(posts, 2);
        globalThis.fetch = async () => new Response('<html>gateway failed</html>', { status: 502 });
        await assert.rejects(client.post('/a'), { code: 'NORA_INVALID_RESPONSE', outcome: 'unknown' });
    } finally { globalThis.fetch = original; }
});

test('deadline covers response and multipart preserves boundary; unexpected success HTML is not success', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        if (url.endsWith('/csrf-token')) return new Response('{"token":"t"}');
        assert.ok(options.body instanceof FormData);
        assert.equal(options.headers.has('Content-Type'), false);
        return new Response('<html>login</html>');
    };
    try {
        const client = new NoraHttpClient('http://127.0.0.1', 1000);
        await assert.rejects(client.post('/upload', new FormData()), { code: 'NORA_INVALID_RESPONSE', outcome: 'unknown' });
        globalThis.fetch = async (_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
        await assert.rejects(client.post('/slow', {}, { timeoutMs: 10 }), { code: 'NORA_REQUEST_TIMEOUT', outcome: 'unknown' });
    } finally { globalThis.fetch = original; }
});
