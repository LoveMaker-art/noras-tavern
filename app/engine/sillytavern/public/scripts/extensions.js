import { eventSource, event_types, saveSettings, getRequestHeaders, CLIENT_VERSION } from '../script.js';
import { renderTemplate, renderTemplateAsync } from './templates.js';
import { delay, deleteValueByPath, equalsIgnoreCaseAndAccents, isSubsetOf, sanitizeSelector, setValueByPath, versionCompare } from './utils.js';
import { getContext } from './st-context.js';
import { addLocaleData, getCurrentLocale, t } from './i18n.js';
import { resolveExtensionLocale } from './nora-i18n/locale.js';
import { debounce_timeout } from './constants.js';
import { SimpleMutex } from './util/SimpleMutex.js';
import { ensureExtensionStyleResources } from './nora-compat/style-resources.js';

export {
    getContext,
    getApiUrl,
    SimpleMutex as ModuleWorkerWrapper,
};

/** @type {string[]} */
export let extensionNames = [];

/**
 * Holds the type of each extension.
 * @type {Record<string, string>}
 */
export let extensionTypes = {};

/**
 * A list of active modules provided by the Extras API.
 * @type {string[]}
 */
export let modules = [];

/**
 * A set of active extensions.
 * @type {Set<string>}
 */
const activeExtensions = new Set();

/**
 * Errors that occurred while loading extensions.
 * @type {Set<string>}
 */
const extensionLoadErrors = new Set();

const getApiUrl = () => extension_settings.apiUrl;
const sortManifestsByOrder = (a, b) => parseInt(a.loading_order) - parseInt(b.loading_order) || String(a.display_name).localeCompare(String(b.display_name));
const getStaticAssetUrl = path => globalThis.__NORA_ASSET_URL__?.(path) ?? path;

/**
 * Holds manifest data for each extension.
 * @type {Record<string, object>}
 */
let manifests = {};

/**
 * Default URL for the Extras API.
 */
const defaultUrl = 'http://localhost:5100';

/**
 * Checks if the extension is officially supported by its URL pattern.
 * @param {string} url URL to check
 * @returns {boolean} True if the URL matches the pattern, false otherwise (or not a valid URL)
 */
export const isOfficialExtension = (url) => {
    try {
        return /^https:\/\/github\.com\/SillyTavern\/(.+)$/i.test(new URL(url).href);
    } catch (e) {
        return false;
    }
};

let saveMetadataTimeout = null;

export function cancelDebouncedMetadataSave() {
    if (saveMetadataTimeout) {
        console.debug('Debounced metadata save cancelled');
        clearTimeout(saveMetadataTimeout);
        saveMetadataTimeout = null;
    }
}

export function saveMetadataDebounced() {
    const context = getContext();
    const groupId = context.groupId;
    const characterId = context.characterId;

    cancelDebouncedMetadataSave();

    saveMetadataTimeout = setTimeout(async () => {
        const newContext = getContext();

        if (groupId !== newContext.groupId) {
            console.warn('Group changed, not saving metadata');
            return;
        }

        if (characterId !== newContext.characterId) {
            console.warn('Character changed, not saving metadata');
            return;
        }

        console.debug('Saving metadata...');
        await newContext.saveMetadata();
        console.debug('Saved metadata...');
    }, debounce_timeout.relaxed);
}

/**
 * Provides an ability for extensions to render HTML templates synchronously.
 * Templates sanitation and localization is forced.
 * @param {string} extensionName Extension name
 * @param {string} templateId Template ID
 * @param {object} templateData Additional data to pass to the template
 * @returns {string} Rendered HTML
 *
 * @deprecated Use renderExtensionTemplateAsync instead.
 */
export function renderExtensionTemplate(extensionName, templateId, templateData = {}, sanitize = true, localize = true) {
    return renderTemplate(`scripts/extensions/${extensionName}/${templateId}.html`, templateData, sanitize, localize, true);
}

/**
 * Provides an ability for extensions to render HTML templates asynchronously.
 * Templates sanitation and localization is forced.
 * @param {string} extensionName Extension name
 * @param {string} templateId Template ID
 * @param {object} templateData Additional data to pass to the template
 * @returns {Promise<string>} Rendered HTML
 */
export function renderExtensionTemplateAsync(extensionName, templateId, templateData = {}, sanitize = true, localize = true) {
    return renderTemplateAsync(`scripts/extensions/${extensionName}/${templateId}.html`, templateData, sanitize, localize, true);
}

export const extension_settings = {
    apiUrl: defaultUrl,
    apiKey: '',
    autoConnect: false,
    notifyUpdates: false,
    disabledExtensions: [],
    expressionOverrides: [],
    memory: {},
    note: {
        default: '',
        chara: [],
        wiAddition: [],
    },
    caption: {
        refine_mode: false,
    },
    expressions: {
        /** @type {number} see `EXPRESSION_API` */
        api: undefined,
        /** @type {string[]} */
        custom: [],
        showDefault: false,
        translate: false,
        /** @type {string} */
        fallback_expression: undefined,
        /** @type {string} */
        llmPrompt: undefined,
        allowMultiple: true,
        rerollIfSame: false,
        promptType: 'raw',
    },
    connectionManager: {
        selectedProfile: '',
        /** @type {import('./extensions/connection-manager/index.js').ConnectionProfile[]} */
        profiles: [],
    },
    dice: {},
    /** @type {import('./char-data.js').RegexScriptData[]} */
    regex: [],
    /** @type {import('./extensions/regex/index.js').RegexPreset[]} */
    regex_presets: [],
    /** @type {string[]} */
    character_allowed_regex: [],
    /** @type {Record<string, string[]>} */
    preset_allowed_regex: {},
    sd: {
        prompts: {},
        character_prompts: {},
        character_negative_prompts: {},
    },
    chromadb: {},
    translate: {},
    objective: {},
    randomizer: {
        controls: [],
        fluctuation: 0.1,
        enabled: false,
    },
    hypebot: {},
    variables: {
        global: {},
    },
    /**
     * @type {import('./chats.js').FileAttachment[]}
     */
    attachments: [],
    /**
     * @type {Record<string, import('./chats.js').FileAttachment[]>}
     */
    character_attachments: {},
    /**
     * @type {string[]}
     */
    disabled_attachments: [],
    gallery: {
        /** @type {{[characterKey: string]: string}} */
        folders: {},
        /** @type {string} */
        sort: 'dateAsc',
    },
};

const NORA_PRODUCT_DISABLED_EXTENSIONS = Object.freeze([
    'assets',
    'attachments',
    'connection-manager',
    'gallery',
    'memory',
    'token-counter',
]);
const NORA_PRODUCT_DEFERRED_EXTENSIONS = Object.freeze([
    'third-party/JS-Slash-Runner',
    'third-party/nora-mvu',
]);
let prepareExtensionsForActivation = null;
const extensionActivationTasks = new Map();

function applyNoraProductExtensionPolicy() {
    const configured = Array.isArray(extension_settings.disabledExtensions)
        ? extension_settings.disabledExtensions
        : [];
    extension_settings.disabledExtensions = [...new Set([...configured, ...NORA_PRODUCT_DISABLED_EXTENSIONS])];
}

function isExtensionDisabled(name) {
    return extension_settings.disabledExtensions.includes(name);
}

/**
 * Performs a fetch of the Extras API.
 * @param {string|URL} endpoint Extras API endpoint
 * @param {RequestInit} args Request arguments
 * @returns {Promise<Response>} Response from the fetch
 */
export async function doExtrasFetch(endpoint, args = {}) {
    if (!args) {
        args = {};
    }

    if (!args.method) {
        Object.assign(args, { method: 'GET' });
    }

    if (!args.headers) {
        args.headers = {};
    }

    if (extension_settings.apiKey) {
        Object.assign(args.headers, {
            'Authorization': `Bearer ${extension_settings.apiKey}`,
        });
    }

    return await fetch(endpoint, args);
}

/**
 * Discovers extensions from the API.
 * @returns {Promise<{name: string, type: string}[]>}
 */
async function discoverExtensions() {
    try {
        const response = await fetch('/api/extensions/discover');

        if (response.ok) {
            const extensions = await response.json();
            return extensions;
        } else {
            return [];
        }
    } catch (err) {
        console.error(err);
        return [];
    }
}

/**
 * Calls a manifest hook for an extension.
 * Hooks are optional function names exported from the extension's JS entry point module.
 * The hook function can optionally return a Promise that will be awaited.
 * @param {string} name Extension name
 * @param {'install' | 'update' | 'delete' | 'clean' | 'enable' | 'disable' | 'activate'} hookName The hook to call
 * @returns {Promise<void>}
 */
async function callExtensionHook(name, hookName) {
    const manifest = manifests[name];

    if (!manifest) {
        console.debug(`callExtensionHook: Extension "${name}" has no manifest, skipping hook "${hookName}"`);
        return;
    }

    if (!manifest.hooks || typeof manifest.hooks !== 'object') {
        return;
    }

    if (!Object.hasOwn(manifest.hooks, hookName)) {
        return;
    }

    const hookFunctionName = manifest.hooks[hookName];

    if (typeof hookFunctionName !== 'string' || !hookFunctionName) {
        console.warn(`callExtensionHook: Extension "${name}" hook "${hookName}" is not a valid string`);
        return;
    }

    if (!manifest.js) {
        console.warn(`callExtensionHook: Extension "${name}" has hook "${hookName}" but no JS entry point defined in manifest`);
        return;
    }

    const url = getStaticAssetUrl(`/scripts/extensions/${name}/${manifest.js}`);
    console.debug(`callExtensionHook: Calling hook "${hookName}" (function "${hookFunctionName}") for extension "${name}"`);

    try {
        // Inline core modules have a data: base URL, so runtime-computed root paths
        // must be resolved against the document origin before dynamic import.
        const module = await import(new URL(url, location.origin).href);

        if (typeof module[hookFunctionName] !== 'function') {
            console.warn(`callExtensionHook: Extension "${name}" hook "${hookName}" references "${hookFunctionName}" which is not an exported function`);
            return;
        }

        const hookCallResult = module[hookFunctionName]();

        const HOOK_TIMEOUT = 5000;
        const HOOK_RESULT = {
            OK: 'ok',
            TIMEOUT: 'timeout',
        };

        const result = await Promise.race([
            (hookCallResult instanceof Promise ? hookCallResult : Promise.resolve(hookCallResult)).then(() => HOOK_RESULT.OK),
            delay(HOOK_TIMEOUT).then(() => HOOK_RESULT.TIMEOUT),
        ]);

        if (result === HOOK_RESULT.TIMEOUT) {
            console.warn(`callExtensionHook: Hook "${hookName}" for extension "${name}" timed out after ${HOOK_TIMEOUT}ms`);
        } else {
            console.debug(`callExtensionHook: Hook "${hookName}" completed for extension "${name}"`);
        }
    } catch (error) {
        console.error(`callExtensionHook: Error calling hook "${hookName}" for extension "${name}":`, error);
    }
}

/**
 * Enables an extension by name.
 * @param {string} name Extension name
 * @param {boolean} [reload=true] If true, reload the page after enabling the extension
 */
export async function enableExtension(name, reload = true) {
    await callExtensionHook(name, 'enable');
    extension_settings.disabledExtensions = extension_settings.disabledExtensions.filter(x => x !== name);
    await saveSettings();
    if (reload) {
        location.reload();
    }
}

/**
 * Disables an extension by name.
 * @param {string} name Extension name
 * @param {boolean} [reload=true] If true, reload the page after disabling the extension
 */
export async function disableExtension(name, reload = true) {
    await callExtensionHook(name, 'disable');
    extension_settings.disabledExtensions.push(name);
    await saveSettings();
    if (reload) {
        location.reload();
    }
}

/**
 * Finds an extension by name, allowing omission of the "third-party/" prefix.
 *
 * @param {string} name - The name of the extension to find
 * @returns {{name: string, enabled: boolean}|null} Object with name and enabled properties, or null if not found
 */
export function findExtension(name) {
    const internalExtensionName = extensionNames.find(extName => {
        return equalsIgnoreCaseAndAccents(extName, name) || equalsIgnoreCaseAndAccents(extName, `third-party/${name}`);
    });
    if (!internalExtensionName) return null;
    const isEnabled = !extension_settings.disabledExtensions.includes(internalExtensionName);
    return { name: internalExtensionName, enabled: isEnabled };
}

/**
 * Returns a deep clone of the manifest for the given extension name.
 * Accepts either the short name (e.g. `SillyTavern-MyExtension`) or the full internal key
 * (e.g. `third-party/SillyTavern-MyExtension`). Returns null if the extension is not found.
 * @param {string} name - Extension name or internal key
 * @returns {object|null} Cloned manifest object, or null if not found
 */
export function getExtensionManifest(name) {
    const found = extensionNames.find(extName =>
        equalsIgnoreCaseAndAccents(extName, name) || equalsIgnoreCaseAndAccents(extName, `third-party/${name}`),
    );
    const manifest = found ? manifests[found] : null;
    return manifest ? structuredClone(manifest) : null;
}

/**
 * Loads manifest.json files for extensions.
 * @param {string[]} names Array of extension names
 * @returns {Promise<Record<string, object>>} Object with extension names as keys and their manifests as values
 */
async function getManifests(names) {
    const obj = {};
    const promises = [];

    for (const name of names) {
        const promise = new Promise((resolve, reject) => {
            fetch(getStaticAssetUrl(`/scripts/extensions/${name}/manifest.json`)).then(async response => {
                if (response.ok) {
                    const json = await response.json();
                    obj[name] = json;
                    resolve();
                } else {
                    reject();
                }
            }).catch(err => {
                reject();
                console.log('Could not load manifest.json for ' + name, err);
            });
        });

        promises.push(promise);
    }

    await Promise.allSettled(promises);
    return obj;
}

/**
 * Tries to activate all available extensions that are not already active.
 * @returns {Promise<void>}
 */
async function activateExtensions({ onlyNames = null } = {}) {
    extensionLoadErrors.clear();
    const clientVersion = CLIENT_VERSION.split(':')[1];
    const extensions = Object.entries(manifests).sort((a, b) => sortManifestsByOrder(a[1], b[1]));
    const extensionNames = extensions.map(x => x[0]);
    const activationNames = onlyNames ? new Set(onlyNames) : null;
    const promises = [];
    let activationBatch = [];
    let currentLoadingOrder = null;
    const flushActivationBatch = async () => {
        if (!activationBatch.length) return;
        const batchStartedAt = performance.now();
        const loadingOrder = currentLoadingOrder;
        await Promise.allSettled(activationBatch);
        const duration = Math.round((performance.now() - batchStartedAt) * 10) / 10;
        globalThis.__NORA_BOOT_METRICS__?.extensionBatches.push({ loadingOrder, duration });
        console.debug(`[Nora boot] extension batch ${loadingOrder}: ${duration}ms blocking wait`);
        activationBatch = [];
    };

    for (let entry of extensions) {
        const name = entry[0];
        const manifest = entry[1];
        if (activationNames && !activationNames.has(name)) {
            continue;
        }
        const loadingOrder = Number.parseInt(manifest.loading_order) || 0;
        if (currentLoadingOrder !== null && loadingOrder !== currentLoadingOrder) {
            await flushActivationBatch();
        }
        currentLoadingOrder = loadingOrder;
        const extrasRequirements = manifest.requires;
        const extensionDependencies = manifest.dependencies;
        const minClientVersion = manifest.minimum_client_version;
        const displayName = manifest.display_name || name;

        if (activeExtensions.has(name)) {
            continue;
        }
        // Client version requirement: pass if 'minimum_client_version' is undefined or null.
        let meetsClientMinimumVersion = true;
        if (minClientVersion !== undefined) {
            meetsClientMinimumVersion = versionCompare(clientVersion, minClientVersion);
        }

        // Module requirements: pass if 'requires' is undefined, null, or not an array; check subset if it's an array
        let meetsModuleRequirements = true;
        let missingModules = [];
        if (extrasRequirements !== undefined) {
            if (Array.isArray(extrasRequirements)) {
                meetsModuleRequirements = isSubsetOf(modules, extrasRequirements);
                missingModules = extrasRequirements.filter(req => !modules.includes(req));
            } else {
                console.warn(`Extension ${name}: manifest.json 'requires' field is not an array. Loading allowed, but any intended requirements were not verified to exist.`);
            }
        }

        // Extension dependencies: pass if 'dependencies' is undefined or not an array; check subset and disabled status if it's an array
        let meetsExtensionDeps = true;
        let missingDependencies = [];
        let disabledDependencies = [];
        if (extensionDependencies !== undefined) {
            if (Array.isArray(extensionDependencies)) {
                // Check if all dependencies exist
                meetsExtensionDeps = isSubsetOf(extensionNames, extensionDependencies);
                missingDependencies = extensionDependencies.filter(dep => !extensionNames.includes(dep));
                // Check for disabled dependencies
                if (meetsExtensionDeps) {
                    disabledDependencies = extensionDependencies.filter(isExtensionDisabled);
                    if (disabledDependencies.length > 0) {
                        // Fail if any dependencies are disabled
                        meetsExtensionDeps = false;
                    }
                }
            } else {
                console.warn(`Extension ${name}: manifest.json 'dependencies' field is not an array. Loading allowed, but any intended requirements were not verified to exist.`);
            }
        }

        const isDisabled = isExtensionDisabled(name);

        if (meetsModuleRequirements && meetsExtensionDeps && meetsClientMinimumVersion && !isDisabled) {
            try {
                const existingActivation = extensionActivationTasks.get(name);
                if (existingActivation) {
                    activationBatch.push(existingActivation);
                    promises.push(existingActivation);
                    continue;
                }
                console.debug('Activating extension', name);
                const extensionStartedAt = performance.now();
                const promise = addExtensionLocale(name, manifest).finally(() =>
                    Promise.all([
                        ensureExtensionStyleResources(name),
                        addExtensionScript(name, manifest),
                        addExtensionStyle(name, manifest),
                    ]),
                );
                let activation;
                activation = promise
                    .then(() => {
                        activeExtensions.add(name);
                        return callExtensionHook(name, 'activate');
                    })
                    .catch(err => {
                        console.log('Could not activate extension', name, err);
                        extensionLoadErrors.add(t`Extension "${displayName}" failed to load: ${err}`);
                    })
                    .finally(() => {
                        const duration = Math.round((performance.now() - extensionStartedAt) * 10) / 10;
                        globalThis.__NORA_BOOT_METRICS__?.extensions.push({ name, loadingOrder, duration });
                        console.debug(`[Nora boot] extension ${name}: ${duration}ms`);
                        if (extensionActivationTasks.get(name) === activation) extensionActivationTasks.delete(name);
                    });
                extensionActivationTasks.set(name, activation);
                activationBatch.push(activation);
                promises.push(activation);
            } catch (error) {
                console.error('Could not activate extension', name, error);
            }
        } else if (!meetsModuleRequirements && !isDisabled) {
            console.warn(t`Extension "${name}" did not load. Missing required Extras module(s): "${missingModules.join(', ')}"`);
            extensionLoadErrors.add(t`Extension "${displayName}" did not load. Missing required Extras module(s): "${missingModules.join(', ')}"`);
        } else if (!meetsExtensionDeps && !isDisabled) {
            if (disabledDependencies.length > 0) {
                console.warn(t`Extension "${name}" did not load. Required extensions exist but are disabled: "${disabledDependencies.join(', ')}". Enable them first, then reload.`);
                extensionLoadErrors.add(t`Extension "${displayName}" did not load. Required extensions exist but are disabled: "${disabledDependencies.join(', ')}". Enable them first, then reload.`);
            } else {
                console.warn(t`Extension "${name}" did not load. Missing required extensions: "${missingDependencies.join(', ')}"`);
                extensionLoadErrors.add(t`Extension "${displayName}" did not load. Missing required extensions: "${missingDependencies.join(', ')}"`);
            }
        } else if (!meetsClientMinimumVersion && !isDisabled) {
            console.warn(t`Extension "${name}" did not load. Requires ST client version ${minClientVersion}, but current version is ${clientVersion}.`);
            extensionLoadErrors.add(t`Extension "${displayName}" did not load. Requires ST client version ${minClientVersion}, but current version is ${clientVersion}.`);
        }
    }

    await flushActivationBatch();
    await Promise.allSettled(promises);
    $('#extensions_details').toggleClass('warning', extensionLoadErrors.size > 0);
}

export async function activateExtensionNames(names) {
    if (typeof prepareExtensionsForActivation !== 'function') {
        throw new Error('Extension discovery is not ready.');
    }
    await prepareExtensionsForActivation();
    const requested = [...new Set((names || []).map(name => String(name || '').trim()).filter(Boolean))];
    await activateExtensions({ onlyNames: requested });
    return requested.filter(name => activeExtensions.has(name));
}

export function getActiveExtensionNames() {
    return [...activeExtensions];
}

/**
 * Connects to the Extras API.
 * @param {string} baseUrl Extras API base URL
 * @returns {Promise<void>}
 */
async function connectToApi(baseUrl) {
    if (!baseUrl) {
        return;
    }

    const url = new URL(baseUrl);
    url.pathname = '/api/modules';

    try {
        const getExtensionsResult = await doExtrasFetch(url);

        if (getExtensionsResult.ok) {
            const data = await getExtensionsResult.json();
            modules = data.modules;
            await activateExtensions();
            await eventSource.emit(event_types.EXTRAS_CONNECTED, modules);
        }

        if (!getExtensionsResult.ok) {
            console.warn('[Nora] Extras API connection failed.', getExtensionsResult.status);
        }
    } catch (error) {
        console.warn('[Nora] Extras API connection failed.', error);
    }
}

/**
 * Adds a CSS file for an extension.
 * @param {string} name Extension name
 * @param {object} manifest Extension manifest
 * @returns {Promise<void>} When the CSS is loaded
 */
function addExtensionStyle(name, manifest) {
    if (!manifest.css) {
        return Promise.resolve();
    }

    const id = sanitizeSelector(`${name}-css`);
    const existingStyle = $(`link[id="${id}"]`);
    if (existingStyle.length > 0) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const url = getStaticAssetUrl(`/scripts/extensions/${name}/${manifest.css}`);
        const link = document.createElement('link');
        link.id = id;
        link.rel = 'stylesheet';
        link.type = 'text/css';
        link.href = url;
        link.onload = function () {
            resolve();
        };
        link.onerror = function (e) {
            reject(e);
        };
        document.head.appendChild(link);
    });
}

/**
 * Loads a JS file for an extension.
 * @param {string} name Extension name
 * @param {object} manifest Extension manifest
 * @returns {Promise<void>} When the script is loaded
 */
function addExtensionScript(name, manifest) {
    if (!manifest.js) {
        return Promise.resolve();
    }

    const url = getStaticAssetUrl(`/scripts/extensions/${name}/${manifest.js}`);
    const id = sanitizeSelector(`${name}-js`);
    if ($(`script[id="${id}"]`).length > 0) {
        return Promise.resolve();
    }

    const marker = document.createElement('script');
    marker.id = id;
    marker.type = 'module';
    marker.dataset.moduleSrc = url;
    document.body.appendChild(marker);

    return import(new URL(url, location.origin).href)
        .then(() => undefined)
        .catch((error) => {
            marker.remove();
            throw error;
        });
}

/**
 * Adds a localization data for an extension.
 * @param {string} name Extension name
 * @param {object} manifest Manifest object
 */
function addExtensionLocale(name, manifest) {
    // No i18n data in the manifest
    if (!manifest.i18n || typeof manifest.i18n !== 'object') {
        return Promise.resolve();
    }

    const currentLocale = getCurrentLocale();
    const localeFile = manifest.i18n[resolveExtensionLocale(manifest.i18n, currentLocale)];

    // Manifest doesn't provide a locale file for the current locale
    if (!localeFile) {
        return Promise.resolve();
    }

    return fetch(getStaticAssetUrl(`/scripts/extensions/${name}/${localeFile}`))
        .then(async response => {
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            if (data && typeof data === 'object') {
                addLocaleData(currentLocale, data);
            }
        })
        .catch(err => {
            console.log('Could not load extension locale data for ' + name, err);
        });
}

/**
 * Loads extension settings from the app settings.
 * @param {object} settings App Settings
 * @param {boolean} versionChanged Is this a version change?
 * @param {boolean} enableAutoUpdate Enable auto-update
 */
export async function loadExtensionSettings(settings, _versionChanged, _enableAutoUpdate, { deferActivation = false } = {}) {
    if (settings.extension_settings) {
        Object.assign(extension_settings, settings.extension_settings);
    }
    applyNoraProductExtensionPolicy();

    let preparationPromise = null;
    const prepare = () => preparationPromise ??= (async () => {
        await eventSource.emit(event_types.EXTENSIONS_FIRST_LOAD);
        const extensions = await discoverExtensions();
        extensionNames = extensions.map(x => x.name);
        extensionTypes = Object.fromEntries(extensions.map(x => [x.name, x.type]));
        const eligibleExtensionNames = extensionNames.filter(name => !isExtensionDisabled(name));
        manifests = await getManifests(eligibleExtensionNames);
        const noraProduct = globalThis.__NORA_ENTRY_ACTIVE__ || document.body.classList.contains('nora-product');
        if (globalThis.__NORA_BOOT_METRICS__) {
            globalThis.__NORA_BOOT_METRICS__.extensionPolicy = {
                discovered: extensionNames.length,
                eligible: eligibleExtensionNames.length,
                skipped: extensionNames.filter(isExtensionDisabled),
                deferred: noraProduct ? [...NORA_PRODUCT_DEFERRED_EXTENSIONS] : [],
            };
        }
        if (globalThis.__NORA_ENTRY_ACTIVE__ || document.querySelector('script[src*="/scripts/extensions/third-party/nora-ui/index.js?v="]')) {
            activeExtensions.add('third-party/nora-ui');
            activeExtensions.add('third-party/nora-ledger');
        }
    })();
    prepareExtensionsForActivation = prepare;

    const activateRemaining = async () => {
        await prepare();
        const noraProduct = globalThis.__NORA_ENTRY_ACTIVE__ || document.body.classList.contains('nora-product');
        const names = Object.keys(manifests).filter(name => !noraProduct || !NORA_PRODUCT_DEFERRED_EXTENSIONS.includes(name));
        await activateExtensions({ onlyNames: names });
        if (extension_settings.autoConnect && extension_settings.apiUrl) {
            connectToApi(extension_settings.apiUrl);
        }
    };

    if (deferActivation) {
        return {
            activateCritical: async (names) => {
                await prepare();
                await activateExtensions({ onlyNames: names });
            },
            activateRemaining,
        };
    }
    await activateRemaining();
    return null;
}

/**
 * Runs the generate interceptors for all extensions.
 * @param {any[]} chat Chat array
 * @param {number} contextSize Context size
 * @param {string} type Generation type
 * @returns {Promise<boolean>} True if generation should be aborted
 */
export async function runGenerationInterceptors(chat, contextSize, type) {
    let aborted = false;
    let exitImmediately = false;

    const abort = (/** @type {boolean} */ immediately) => {
        aborted = true;
        exitImmediately = immediately;
    };

    for (const manifest of Object.values(manifests).filter(x => x.generate_interceptor).sort((a, b) => sortManifestsByOrder(a, b))) {
        const interceptorKey = manifest.generate_interceptor;
        if (typeof globalThis[interceptorKey] === 'function') {
            try {
                await globalThis[interceptorKey](chat, contextSize, abort, type);
            } catch (e) {
                console.error(`Failed running interceptor for ${manifest.display_name}`, e);
            }
        }

        if (exitImmediately) {
            break;
        }
    }

    return aborted;
}

/**
 * Sentinel value that signals a field should be completely removed (unset)
 * from the character card rather than being set to any value. Pass this as
 * the `value` argument to {@link writeExtensionField} or
 * {@link writeExtensionFieldBulk} to delete the key entirely.
 *
 * Using `null` as a value will set the field to `null` (the key remains).
 * Using this sentinel will delete the key from the character card.
 * @type {string}
 */
export const UNSET_VALUE = '__@@UNSET@@__';

/**
 * Writes a field to the character's data extensions object.
 * @param {number|string} characterId Index in the character array
 * @param {string} key Field name
 * @param {any} value Field value
 * @returns {Promise<void>} When the field is written
 */
export async function writeExtensionField(characterId, key, value) {
    const context = getContext();
    const character = context.characters[characterId];
    if (!character) {
        console.warn('Character not found', characterId);
        return;
    }
    const extensionPath = `data.extensions.${key}`;
    const isUnset = value === UNSET_VALUE;

    if (isUnset) {
        deleteValueByPath(character, extensionPath);
    } else {
        setValueByPath(character, extensionPath, value);
    }

    // Process JSON data
    if (character.json_data) {
        const jsonData = JSON.parse(character.json_data);
        if (isUnset) {
            deleteValueByPath(jsonData, extensionPath);
        } else {
            setValueByPath(jsonData, extensionPath, value);
        }
        character.json_data = JSON.stringify(jsonData);

        // Make sure the data doesn't get lost when saving the current character
        if (Number(characterId) === Number(context.characterId)) {
            $('#character_json_data').val(character.json_data);
        }
    }

    // Save data to the server
    const saveDataRequest = {
        avatar: character.avatar,
        data: {
            extensions: {
                [key]: value,
            },
        },
    };
    const mergeResponse = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(saveDataRequest),
    });

    if (!mergeResponse.ok) {
        console.error('Failed to save extension field', mergeResponse.statusText);
    }
}

/**
 * @typedef {object} BulkExtensionFieldResult
 * @property {string[]} updated  Avatar filenames that were successfully updated
 * @property {string[]} skipped  Avatar filenames skipped (filter didn't match or unreadable)
 * @property {string[]} failed   Avatar filenames where the update failed
 */

/**
 * Writes (or deletes) an extension field for multiple characters in a single
 * bulk request. Unlike {@link writeExtensionField}, this sends one API call
 * for all characters, and the server processes them in parallel.
 *
 * When `value` is {@link UNSET_VALUE} the extension key is **deleted** from
 * each matching character card. Passing `null` sets the field to `null`
 * (the key is preserved).
 *
 * @param {string[]|null} avatars Avatar filenames to update. Pass `null` or an
 *   empty array to target **all** characters in the user's character directory.
 * @param {string} key Extension field name (e.g. "greeting_tools")
 * @param {any} value Field value, `null` to set null, or
 *   {@link UNSET_VALUE} to delete the key entirely
 * @param {object} [options={}] Optional settings
 * @param {string} [options.filterPath] Dot-path filter — the server will only
 *   update characters where this path is present and not `undefined`;
 *   `null` still counts as a match. Useful when the frontend has shallow
 *   character data and cannot pre-filter.
 *   Defaults to `data.extensions.<key>` when unsetting, so deletion requests
 *   automatically skip characters where the field is missing/`undefined`.
 * @returns {Promise<BulkExtensionFieldResult>} Summary of the bulk operation
 */
export async function writeExtensionFieldBulk(avatars, key, value, { filterPath } = {}) {
    const context = getContext();
    const extensionPath = `data.extensions.${key}`;
    const isUnset = value === UNSET_VALUE;

    // Build the server request
    const requestBody = {
        avatars: Array.isArray(avatars) && avatars.length > 0 ? avatars : [],
        data: {
            data: {
                extensions: {
                    [key]: value,
                },
            },
        },
    };

    // Default filter: when unsetting, only touch characters that have the field
    const resolvedFilterPath = filterPath ?? (isUnset ? extensionPath : undefined);
    if (resolvedFilterPath) {
        requestBody.filter = { path: resolvedFilterPath };
    }

    const mergeResponse = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(requestBody),
    });

    if (!mergeResponse.ok) {
        console.error('Bulk extension field update failed', mergeResponse.statusText);
        return { updated: [], skipped: [], failed: [] };
    }

    /** @type {BulkExtensionFieldResult} */
    const result = await mergeResponse.json();

    // Sync in-memory character objects for successfully updated characters
    const updatedSet = new Set(result.updated);
    for (const character of context.characters) {
        if (!character || !updatedSet.has(character.avatar)) continue;

        if (isUnset) {
            deleteValueByPath(character, extensionPath);
        } else {
            setValueByPath(character, extensionPath, value);
        }

        // Keep json_data in sync
        if (character.json_data) {
            const jsonData = JSON.parse(character.json_data);
            if (isUnset) {
                deleteValueByPath(jsonData, extensionPath);
            } else {
                setValueByPath(jsonData, extensionPath, value);
            }
            character.json_data = JSON.stringify(jsonData);
        }
    }

    // If the currently active character was updated, sync the hidden input
    if (context.characterId !== undefined) {
        const activeChar = context.characters[context.characterId];
        if (activeChar && updatedSet.has(activeChar.avatar) && activeChar.json_data) {
            $('#character_json_data').val(activeChar.json_data);
        }
    }

    return result;
}

/**
 * Compatibility facade for callers that previously opened ST's extension market.
 * @returns {Promise<boolean>} Always false because Nora has no extension market UI.
 */
export async function openThirdPartyExtensionMenu() {
    console.info('[Nora] Extension installation UI is disabled.');
    return false;
}

/**
 * Sentinel value representing an empty author, used when author information cannot be extracted from a URL.
 * @type {{name: string, url: string}}
 */
export const EMPTY_AUTHOR = Object.freeze({
    name: '',
    url: '',
});

/**
 * Extracts the repository author from a given URL.
 * @param {string} url - The URL of the repository.
 * @returns {{name: string, url: string}} Object containing the author's name and URL, or empty strings if not found.
 */
export function getAuthorFromUrl(url) {
    const result = structuredClone(EMPTY_AUTHOR);

    try {
        const parsedUrl = new URL(url);
        const pathSegments = parsedUrl.pathname.split('/').filter(s => s.length > 0);

        // TODO: Handle non-GitHub URLs if needed
        if (parsedUrl.host === 'github.com' && pathSegments.length >= 2) {
            result.name = pathSegments[0];
            result.url = `${parsedUrl.protocol}//${parsedUrl.hostname}/${result.name}`;
        }
    } catch (error) {
        console.debug('Error parsing URL:', error);
    }

    return result;
}
