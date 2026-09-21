const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const desktop = fs.existsSync(path.join(__dirname, '../../launcher/desktop/main.js'))
  ? path.join(__dirname, '../../launcher/desktop') : path.join(__dirname, '../installer/desktop');
const { createReleaseNetwork } = require(path.join(desktop, 'release-network'));

function fixture(fetcher) {
  const events = [];
  const network = createReleaseNetwork({
    app: { whenReady: async () => {} }, net: { fetch: fetcher },
    diagnostics: { write: (event, fields) => events.push({ event, ...fields }),
      error: (event, error, fields) => events.push({ event, error, ...fields }) },
  });
  return { network, events };
}

test('release requests use Chromium and preserve streaming, cancellation and headers', async () => {
  let options;
  const response = new Response('payload');
  const f = fixture(async (_url, init) => { options = init; return response; });
  const signal = new AbortController().signal;
  const headers = { Accept: 'application/json' };
  assert.equal(await f.network.fetch('https://api.github.com/releases?secret=hidden', { signal, headers }), response);
  assert.equal(await response.text(), 'payload');
  assert.equal(options.signal, signal);
  assert.equal(options.headers, headers);
  assert.equal(options.credentials, 'omit');
  assert.equal(options.bypassCustomProtocolHandlers, true);
  assert.ok(!JSON.stringify(f.events).includes('hidden'));
});

test('certificate errors are logged and propagated, never accepted or retried insecurely', async () => {
  const error = new Error('net::ERR_CERT_AUTHORITY_INVALID');
  let calls = 0;
  const f = fixture(async () => { calls++; throw error; });
  await assert.rejects(f.network.fetch('https://api.github.com/releases'), value => value === error);
  assert.equal(calls, 1);
  assert.equal(f.events.at(-1).event, 'network.failed');
  assert.equal(f.events.at(-1).error, error);
});

test('a transient network change retries the same read request and recovers', async () => {
  const calls = [];
  const response = new Response('release');
  const f = fixture(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) throw new Error('net::ERR_NETWORK_CHANGED');
    return response;
  });
  const signal = new AbortController().signal;
  const url = 'https://github.com/release-manifest.json?secret=hidden';
  assert.equal(await f.network.fetch(url, { signal }), response);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url === url && call.options.signal === signal));
  assert.equal(f.events.filter(e => e.event === 'network.retry').length, 1);
  assert.equal(f.events.at(-1).attempt, 2);
  assert.ok(!JSON.stringify(f.events).includes('hidden'));
});

test('persistent network changes stop after three attempts', async () => {
  const error = new Error('net::ERR_NETWORK_CHANGED');
  let calls = 0;
  const f = fixture(async () => { calls++; throw error; });
  await assert.rejects(f.network.fetch('https://github.com/manifest'), value => value === error);
  assert.equal(calls, 3);
  assert.equal(f.events.filter(e => e.event === 'network.retry').length, 2);
  assert.equal(f.events.at(-1).event, 'network.failed');
});

test('cancellation during retry backoff prevents any further request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    setTimeout(() => controller.abort(), 20);
    throw new Error('net::ERR_NETWORK_CHANGED');
  });
  await assert.rejects(f.network.fetch('https://github.com/manifest', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('already cancelled requests never contact the server', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return new Response(''); });
  await assert.rejects(f.network.fetch('https://github.com/manifest', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('writes, request bodies and other failures are never automatically replayed', async () => {
  for (const options of [{ method: 'POST' }, { method: 'GET', body: 'data' }]) {
    let calls = 0;
    const f = fixture(async () => { calls++; throw new Error('net::ERR_NETWORK_CHANGED'); });
    await assert.rejects(f.network.fetch('https://github.com/manifest', options), /ERR_NETWORK_CHANGED/);
    assert.equal(calls, 1);
  }
  for (const message of ['net::ERR_ABORTED', 'net::ERR_CERT_DATE_INVALID', 'net::ERR_NAME_NOT_RESOLVED']) {
    let calls = 0;
    const f = fixture(async () => { calls++; throw new Error(message); });
    await assert.rejects(f.network.fetch('https://github.com/manifest'), e => e.message === message);
    assert.equal(calls, 1);
  }
});

test('HTTP errors remain caller-owned and response body failures do not replay a stream', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return new Response('unavailable', { status: 503 }); });
  assert.equal((await f.network.fetch('https://github.com/manifest')).status, 503);
  assert.equal(calls, 1);
  const broken = fixture(async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error('net::ERR_NETWORK_CHANGED')); } }));
  });
  const response = await broken.network.fetch('https://github.com/archive');
  await assert.rejects(response.text(), /ERR_NETWORK_CHANGED/);
  assert.equal(calls, 2);
});

test('comparison records Node failure separately from successful Chromium verification', async () => {
  const f = fixture(async () => new Response('{}'));
  await f.network.compare(async fetcher => { const response = await fetcher('https://api.github.com/releases'); await response.text(); },
    async () => { throw new Error('UNABLE_TO_VERIFY_LEAF_SIGNATURE'); });
  assert.equal(f.events.some(item => item.event === 'network.probe.failed' && item.engine === 'node'), true);
  assert.equal(f.events.some(item => item.event === 'network.probe.complete' && item.engine === 'chromium'), true);
});

test('comparison fails when Chromium fails even if Node succeeds', async () => {
  const f = fixture(async () => { throw new Error('net::ERR_CERT_AUTHORITY_INVALID'); });
  await assert.rejects(f.network.compare(fetcher => fetcher('https://api.github.com/releases'), async () => new Response('{}')),
    /ERR_CERT_AUTHORITY_INVALID/);
});

test('online updates and version checks explicitly inject the desktop network transport', () => {
  const source = fs.readFileSync(path.join(desktop, 'main.js'), 'utf8');
  assert.match(source, /releases\.prepareUpdate\(\{\s*fetcher: updateFetch/);
  assert.match(source, /releases\.check\(\{\s*fetcher: updateFetch/);
  assert.match(source, /createLocalRelease\(localReleaseDirectory\) : releaseNetwork\.fetch/);
  assert.doesNotMatch(source, /await releaseNetwork\.compare/);
  const metadata = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json')));
  assert.ok(metadata.build.files.includes('release-network.js'));
});
