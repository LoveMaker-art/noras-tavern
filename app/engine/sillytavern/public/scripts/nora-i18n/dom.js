import { getCurrentLocale, localeData } from './core.js';

/** Only explicitly marked system nodes; never search/replace chat text. */
export function translateElement(element) {
    for (const key of element.getAttribute('data-i18n').split(';')) {
        const attribute = key.match(/\[(\S+)\](.+)/);
        const lookup = attribute ? attribute[2] : key;
        if (!Object.hasOwn(localeData, lookup)) continue;
        if (attribute) element.setAttribute(attribute[1], localeData[lookup]);
        else element.textContent = localeData[lookup];
    }
}

export function applyNoraLocale(doc = document) {
    doc.documentElement.lang = getCurrentLocale();
    doc.querySelectorAll('[name="templatesAndPopupsWrapper"] [data-i18n]').forEach(translateElement);
    doc.querySelectorAll('[name="templatesAndPopupsWrapper"] template').forEach(template => template.content.querySelectorAll('[data-i18n]').forEach(translateElement));
}
