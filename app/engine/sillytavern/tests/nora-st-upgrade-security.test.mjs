import test from 'node:test';
import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
import express from 'express';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import initPrivateRequestFilter, { getUntrustedRequestAgent } from '../src/private-request-filter.js';
import { setConfigFilePath } from '../src/util.js';
setConfigFilePath(new URL('../default/config.yaml', import.meta.url).pathname);
const requests = [];
globalThis[Symbol.for('nora.test.search.fetch')] = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, headers: { get: () => 'text/html' }, text: async () => '<p>fixture</p>' };
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === 'node-fetch') return { url: 'data:text/javascript,export default globalThis[Symbol.for("nora.test.search.fetch")]', shortCircuit: true };
    return nextResolve(specifier, context);
} });
const { router } = await import('../src/endpoints/search.js');
hooks.deregister();

test('web visits reject private literal and localhost targets before making an outbound request', async t => {
    const app = express(); app.use(express.json()); app.use('/search', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    for (const url of ['http://localhost/', 'https://sub.localhost/', 'http://[::1]/', 'http://127.0.0.1/', 'file:///etc/passwd']) {
        const result = await fetch(`http://127.0.0.1:${server.address().port}/search/visit`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }),
        });
        assert.equal(result.status, 400, url);
    }
    assert.equal(requests.length, 0);
    const result = await fetch(`http://127.0.0.1:${server.address().port}/search/visit`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/', html: true }),
    });
    assert.equal(await result.text(), '<p>fixture</p>');
    assert.ok(requests[0].options.agent, 'public URLs must still guard DNS resolution and redirects');
});

test('untrusted requests check every connection target and preserve explicitly configured proxy routing', async t => {
    const originalHttp = http.globalAgent, originalHttps = https.globalAgent;
    t.after(() => {
        http.globalAgent = originalHttp; https.globalAgent = originalHttps;
        initPrivateRequestFilter({ enabled: false, requestProxyEnabled: false });
    });
    let address = '93.184.216.34';
    t.mock.method(dns.promises, 'lookup', async () => ({ address }));
    const sockets = [];
    t.mock.method(net, 'connect', options => { sockets.push(options); return {}; });
    t.mock.method(tls, 'connect', options => { sockets.push(options); return {}; });
    initPrivateRequestFilter({ enabled: false, requestProxyEnabled: false });
    const agent = getUntrustedRequestAgent();
    await agent.connect({}, { host: 'public.example', secureEndpoint: false });
    assert.equal(sockets[0].host, '93.184.216.34', 'connect to the checked address, do not resolve it again');
    for (address of ['127.0.0.1', '192.168.1.2', '169.254.169.254', '::1', 'fd00::1']) {
        await assert.rejects(agent.connect({}, { host: 'redirect.example', secureEndpoint: true }), /Blocked request/);
    }
    assert.equal(sockets.length, 1, 'private redirect targets never open a socket');
    initPrivateRequestFilter({ enabled: false, requestProxyEnabled: true });
    assert.equal(getUntrustedRequestAgent(), undefined, 'do not silently bypass the configured global proxy');
    assert.equal(http.globalAgent, originalHttp);
    initPrivateRequestFilter({ enabled: true, privateAddressWhitelist: ['127.0.0.0/8'], logBlocked: false, logAllowed: false });
    assert.equal(getUntrustedRequestAgent(), undefined);
    await http.globalAgent.connect({}, { host: '127.0.0.1', secureEndpoint: false });
    assert.equal(sockets.at(-1).host, '127.0.0.1', 'explicit trusted model endpoints remain usable');
    await assert.rejects(http.globalAgent.connect({}, { host: '192.168.1.2', secureEndpoint: false }), /Blocked request/);
});
