/** Display language only. Never reads or writes chat/model/world settings. */
export function resolveNoraLocale(search = '', browserLanguage = 'en') {
    let requested = '';
    try { requested = new URLSearchParams(search).get('lang')?.trim() || ''; } catch { /* Browser fallback. */ }
    const language = String(requested || browserLanguage || 'en').replace(/_/g, '-').toLowerCase();
    return language === 'zh' || language.startsWith('zh-') ? 'zh-cn' : 'en';
}

export function resolveExtensionLocale(locales, locale) {
    const keys = Object.keys(locales || {});
    const normalized = String(locale || '').replace(/_/g, '-').toLowerCase();
    const candidates = [normalized];
    if (normalized === 'zh-cn' || normalized === 'zh-hans') candidates.push('zh-hans', 'zh-cn', 'zh');
    else candidates.push(normalized.split('-')[0]);
    return candidates.map(candidate => keys.find(key => key.toLowerCase().replace(/_/g, '-') === candidate)).find(Boolean);
}
