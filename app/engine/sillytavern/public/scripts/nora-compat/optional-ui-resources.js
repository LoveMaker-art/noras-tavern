import { ensureStylePaths } from './style-resources.js';

const resources = Object.freeze({
    cropper: {
        styles: ['/css/cropper.min.css'],
        scripts: ['/lib/cropper.min.js', '/lib/jquery-cropper.min.js'],
        ready: () => typeof globalThis.jQuery?.fn?.cropper === 'function',
    },
    colorPicker: {
        scripts: ['/lib/toolcool-color-picker.js'],
        ready: () => Boolean(globalThis.customElements?.get('toolcool-color-picker')),
    },
    avatarZoom: {
        scripts: ['/lib/jquery.izoomify.js'],
        ready: () => typeof globalThis.jQuery?.fn?.izoomify === 'function',
    },
});

const pending = new Map();

function loadScript(src) {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
        return existing.dataset.noraLoaded === 'true'
            ? Promise.resolve()
            : new Promise((resolve, reject) => {
                existing.addEventListener('load', resolve, { once: true });
                existing.addEventListener('error', reject, { once: true });
            });
    }
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.addEventListener('load', () => {
            script.dataset.noraLoaded = 'true';
            resolve();
        }, { once: true });
        script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
        document.head.append(script);
    });
}

export function ensureOptionalUiResource(name) {
    const resource = resources[name];
    if (!resource) return Promise.reject(new Error(`Unknown Nora UI resource: ${name}`));
    if (resource.ready()) return Promise.resolve();
    if (pending.has(name)) return pending.get(name);

    const metrics = globalThis.__NORA_BOOT_METRICS__;
    const startedAt = performance.now();
    const promise = ensureStylePaths(resource.styles).then(() => resource.scripts.reduce(
        (chain, src) => chain.then(() => loadScript(src)),
        Promise.resolve(),
    )).then(() => {
        if (!resource.ready()) throw new Error(`Nora UI resource did not initialize: ${name}`);
        if (metrics) {
            metrics.optionalResources ??= [];
            metrics.optionalResources.push({
                name,
                at: Math.round((performance.now() - metrics.startedAt) * 10) / 10,
                duration: Math.round((performance.now() - startedAt) * 10) / 10,
            });
        }
    }).catch((error) => {
        pending.delete(name);
        throw error;
    });
    pending.set(name, promise);
    return promise;
}

export function installOptionalUiResources() {
    globalThis.__NORA_ENSURE_OPTIONAL_UI__ = ensureOptionalUiResource;
    document.addEventListener('pointerdown', async (event) => {
        const picker = event.target instanceof Element && event.target.closest('toolcool-color-picker');
        if (!picker || customElements.get('toolcool-color-picker')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        await ensureOptionalUiResource('colorPicker');
        picker.click();
    }, true);
}
