import { english } from '../public/scripts/nora-i18n/strings.js';
import { resolveNoraLocale } from '../public/scripts/nora-i18n/locale.js';

/** Small first-paint subset, generated from the same maintained catalog. */
export function renderLocaleBootstrap(template) {
    const shell = template.slice(template.indexOf('<body'), template.indexOf('<div id="bg1">'));
    const keys = new Set(['正在读取世界…', '加载失败，请检查网络后重试']);
    for (const match of shell.matchAll(/data-i18n="([^"]+)"/g)) {
        for (const key of match[1].split(';')) keys.add(key.replace(/^\[[^\]]+\]/, ''));
    }
    const catalog = Object.fromEntries([...keys].map(key => [key, english[key]]));
    if (Object.values(catalog).some(value => typeof value !== 'string')) throw new Error('Missing first-paint translation');
    const encoded = JSON.stringify(catalog).replace(/</g, '\\u003c');
    return `(() => {
        const resolve = ${resolveNoraLocale.toString()};
        const locale = globalThis.__NORA_LOCALE__ = resolve(location.search, navigator.language);
        document.documentElement.lang = locale;
        const english = ${encoded};
        globalThis.__NORA_TRANSLATE_EARLY__ = text => locale === 'en' ? (english[text] ?? text) : text;
    })();`;
}
