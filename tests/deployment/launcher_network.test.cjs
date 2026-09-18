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

test('installation and version checks explicitly inject the desktop network transport', () => {
  const source = fs.readFileSync(path.join(desktop, 'main.js'), 'utf8');
  assert.match(source, /releases\.prepare\(\{\s*fetcher: releaseNetwork\.fetch/);
  assert.match(source, /releases\.check\(\{\s*fetcher: releaseNetwork\.fetch/);
  assert.match(source, /await releaseNetwork\.compare/);
  const metadata = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json')));
  assert.ok(metadata.build.files.includes('release-network.js'));
});
