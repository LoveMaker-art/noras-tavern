const extensionStyleResources = Object.freeze({
    regex: Object.freeze([
        '/css/animations.css',
        '/css/popup.css',
        '/css/jquery-ui.min.css',
    ]),
    'third-party/JS-Slash-Runner': Object.freeze([
        '/css/animations.css',
        '/css/popup.css',
        '/css/jquery-ui.min.css',
        '/css/bright.min.css',
    ]),
});

const pendingStyles = new Map();

function resolveStyleHref(path) {
    return globalThis.__NORA_ASSET_URL__?.(path) ?? path;
}

function findStyleLink(href, documentRef, locationRef) {
    const absoluteHref = new URL(href, locationRef.href).href;
    return [...documentRef.querySelectorAll('link[rel="stylesheet"]')].find((link) => {
        const configuredHref = link.getAttribute('href') || link.dataset.noraDeferredHref || '';
        return configuredHref && new URL(configuredHref, locationRef.href).href === absoluteHref;
    });
}

function loadStyle(path, { documentRef = document, locationRef = location } = {}) {
    const href = resolveStyleHref(path);
    const key = new URL(href, locationRef.href).href;
    if (pendingStyles.has(key)) return pendingStyles.get(key);

    const existing = findStyleLink(href, documentRef, locationRef);
    if (existing?.sheet) return Promise.resolve();

    const promise = new Promise((resolve, reject) => {
        const link = existing || documentRef.createElement('link');
        link.addEventListener('load', resolve, { once: true });
        link.addEventListener('error', () => reject(new Error(`Failed to load Nora style resource: ${path}`)), { once: true });
        link.rel = 'stylesheet';
        link.href = href;
        link.media = 'all';
        delete link.dataset.noraDeferredHref;
        if (!existing) documentRef.head.append(link);
    }).catch((error) => {
        pendingStyles.delete(key);
        throw error;
    });

    pendingStyles.set(key, promise);
    return promise;
}

export function getExtensionStyleResources(name) {
    return extensionStyleResources[String(name || '').trim()] || Object.freeze([]);
}

export function ensureStylePaths(paths, options) {
    return Promise.all((paths || []).map(path => loadStyle(path, options))).then(() => undefined);
}

export function ensureExtensionStyleResources(name, options) {
    return ensureStylePaths(getExtensionStyleResources(name), options);
}
