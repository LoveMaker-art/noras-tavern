function createReleaseNetwork({ app, net, diagnostics }) {
  async function fetchRelease(url, options = {}) {
    await app.whenReady();
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('发布资源必须使用 HTTPS。');
    const fields = { engine: 'chromium', url: parsed.origin + parsed.pathname };
    const started = Date.now();
    diagnostics.write('network.start', fields);
    try {
      const response = await net.fetch(url, { ...options,
        credentials: 'omit', cache: 'no-store', bypassCustomProtocolHandlers: true });
      diagnostics.write('network.response', { ...fields, status: response.status, durationMs: Date.now() - started });
      return response;
    } catch (error) {
      diagnostics.error('network.failed', error, { ...fields, durationMs: Date.now() - started });
      throw error;
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
