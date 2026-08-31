import { english } from './strings.js';
import { resolveNoraLocale } from './locale.js';

// Both ST and Nora import this module. It has no dependency on the engine or UI.
const isNora = Boolean(globalThis.__NORA_LOCALE__ || globalThis.document?.body?.classList.contains('nora-product'));
let savedLanguage;
if (!isNora) {
    try { savedLanguage = globalThis.localStorage?.getItem('language'); } catch { /* Storage may be disabled. */ }
}
const browserLanguage = globalThis.navigator?.language || 'en';
const initialLocale = isNora
    ? globalThis.__NORA_LOCALE__ || resolveNoraLocale(globalThis.location?.search, browserLanguage)
    : String(savedLanguage || browserLanguage).toLowerCase();

// Webpack entry and ST's import-map modules must share one page registry.
const registry = globalThis[Symbol.for('tavern.i18n')] ??= {
    locale: initialLocale,
    data: Object.assign(Object.create(null), initialLocale.startsWith('en') ? english : Object.fromEntries(Object.keys(english).map(key => [key, key]))),
};
export const getCurrentLocale = () => registry.locale;
export const localeData = registry.data;

/** Base dictionaries take precedence over extension contributions. */
export function setLocaleData(data) {
    for (const key of Object.keys(localeData)) delete localeData[key];
    Object.assign(localeData, data, getCurrentLocale().startsWith('en') ? english : Object.fromEntries(Object.keys(english).map(key => [key, key])));
}

export function addLocaleData(localeId, data) {
    if (String(localeId).toLowerCase() !== getCurrentLocale() || !data || typeof data !== 'object') return;
    for (const [key, value] of Object.entries(data)) {
        if (!Object.hasOwn(localeData, key) && typeof value === 'string') localeData[key] = value;
    }
}

export function translate(text, key = null) {
    const lookup = key ?? text;
    return Object.hasOwn(localeData, lookup) ? localeData[lookup] : text ?? '';
}

/** Same indexed template contract as ST: `Hello ${0}`. */
export function t(strings, ...values) {
    const key = strings.reduce((result, part, index) => result + part + (values[index] !== undefined ? '${' + index + '}' : ''), '');
    return translate(key).replace(/\$\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
}
