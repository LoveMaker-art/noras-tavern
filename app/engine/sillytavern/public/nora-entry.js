import { startNoraRuntime } from './scripts/nora-runtime/index.js';
import chineseLocale from './locales/zh-cn.json';
import { getCurrentLocale, setLocaleData } from './scripts/nora-i18n/core.js';
import { applyNoraLocale } from './scripts/nora-i18n/dom.js';

// Reuse ST's maintained dictionary through the existing entry bundle, not a
// new language request on the startup critical path.
if (getCurrentLocale() === 'zh-cn') setLocaleData(chineseLocale);
// The compatibility prelude may have evaluated ST before this bundle. Apply
// retained templates after its dictionary is registered, before showing Nora.
applyNoraLocale();

globalThis.__NORA_ENTRY_ACTIVE__ = true;

const metrics = globalThis.__NORA_BOOT_METRICS__;
metrics?.milestones?.push({
    name: 'nora-entry-evaluating',
    at: Math.round((performance.now() - metrics.startedAt) * 10) / 10,
});

globalThis.__NORA_RUNTIME_PROMISE__ = startNoraRuntime().catch((error) => {
    document.body.classList.add('nora-runtime-failed');
    metrics?.milestones?.push({
        name: 'nora-entry-failed',
        at: Math.round((performance.now() - metrics.startedAt) * 10) / 10,
        message: String(error?.message || error),
    });
    console.error('[Nora Runtime] Startup failed', error);
    throw error;
});
