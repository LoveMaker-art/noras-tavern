import { applyNoraLocale } from './dom.js';
import { getCurrentLocale, setLocaleData } from './core.js';

/**
 * Loads the maintained ST dictionary after Nora is usable. Nora-owned product
 * strings remain available synchronously from strings.js; this dictionary is
 * only needed by compatibility dialogs and retained ST templates.
 */
export async function loadCompatibilityLocale({ fetchImpl = globalThis.fetch } = {}) {
    if (getCurrentLocale() !== 'zh-cn') return false;
    if (typeof fetchImpl !== 'function') throw new TypeError('A locale fetch implementation is required.');

    const assetUrl = globalThis.__NORA_ASSET_URL__?.('locales/zh-cn.json') ?? '/locales/zh-cn.json';
    const response = await fetchImpl(assetUrl, {
        cache: 'force-cache',
        credentials: 'same-origin',
        priority: 'low',
    });
    if (!response.ok) throw new Error(`Compatibility locale request failed (${response.status}).`);

    setLocaleData(await response.json());
    applyNoraLocale();
    return true;
}
