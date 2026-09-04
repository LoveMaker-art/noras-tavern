import { startNoraRuntime } from './scripts/nora-runtime/index.js';
import { applyNoraLocale } from './scripts/nora-i18n/dom.js';
import { loadCompatibilityLocale } from './scripts/nora-i18n/compatibility-locale.js';

// Nora-owned strings are synchronous. The larger ST dictionary is only needed
// by retained compatibility dialogs and is loaded after the product is usable.
applyNoraLocale();

globalThis.__NORA_ENTRY_ACTIVE__ = true;

const metrics = globalThis.__NORA_BOOT_METRICS__;
metrics?.milestones?.push({
    name: 'nora-entry-evaluating',
    at: Math.round((performance.now() - metrics.startedAt) * 10) / 10,
});

globalThis.__NORA_RUNTIME_PROMISE__ = startNoraRuntime().then((runtime) => {
    globalThis.__NORA_COMPATIBILITY_LOCALE_PROMISE__ = loadCompatibilityLocale().catch((error) => {
        console.warn('[Nora i18n] Compatibility locale did not load:', error);
        return false;
    });
    return runtime;
}).catch((error) => {
    document.body.classList.add('nora-runtime-failed');
    metrics?.milestones?.push({
        name: 'nora-entry-failed',
        at: Math.round((performance.now() - metrics.startedAt) * 10) / 10,
        message: String(error?.message || error),
    });
    console.error('[Nora Runtime] Startup failed', error);
    throw error;
});
