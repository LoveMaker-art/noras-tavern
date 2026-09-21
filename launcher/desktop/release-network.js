const { setTimeout: delay } = require('node:timers/promises');

function createReleaseNetwork({ app, net, diagnostics }) {
  async function fetchRelease(url, options = {}) {
    await app.whenReady();
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('发布资源必须使用 HTTPS。');
    const fields = { engine: 'chromium', url: parsed.origin + parsed.pathname };
    const readOnly = ['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase()) && options.body == null;
    const backoff = [500, 1000];
    for (let attempt = 1; ; attempt++) {
      options.signal?.throwIfAborted();
      const started = Date.now();
      const attemptFields = { ...fields, attempt };
      diagnostics.write('network.start', attemptFields);
      try {
        const response = await net.fetch(url, { ...options,
          credentials: 'omit', cache: 'no-store', bypassCustomProtocolHandlers: true });
        diagnostics.write('network.response', { ...attemptFields, status: response.status, durationMs: Date.now() - started });
        return response;
      } catch (error) {
        // Retry only before a response is exposed; never replay a partially consumed download.
        const retry = readOnly && !options.signal?.aborted && attempt <= backoff.length
          && error.message === 'net::ERR_NETWORK_CHANGED';
        const details = { ...attemptFields, durationMs: Date.now() - started };
        if (!retry) {
          diagnostics.error('network.failed', error, details);
          throw error;
        }
        diagnostics.error('network.retry', error, { ...details, nextAttempt: attempt + 1, delayMs: backoff[attempt - 1] });
        try { await delay(backoff[attempt - 1], undefined, { signal: options.signal }); }
        catch (cancelled) {
          diagnostics.error('network.cancelled', cancelled, attemptFields);
          throw cancelled;
        }
      }
    }
  }

  // The caller uses the same bounded release query for both engines. Node is
  // diagnostic only, never a fallback that bypasses Chromium certificate errors.
  async function compare(probe, nodeFetch = globalThis.fetch) {
    let chromiumError;
    for (const [engine, fetcher] of [['chromium', fetchRelease], ['node', nodeFetch]]) {
      const started = Date.now();
      try {
        await probe(fetcher);
        diagnostics.write('network.probe.complete', { engine, durationMs: Date.now() - started });
      } catch (error) {
        diagnostics.error('network.probe.failed', error, { engine, durationMs: Date.now() - started });
        if (engine === 'chromium') chromiumError = error;
      }
    }
    if (chromiumError) throw chromiumError;
  }
  return { fetch: fetchRelease, compare };
}

module.exports = { createReleaseNetwork };
