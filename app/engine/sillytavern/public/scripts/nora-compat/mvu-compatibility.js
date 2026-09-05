const INIT_COMMENT_MARKER = /\[initvar\]/i;
const UPDATE_COMMENT_MARKER = /\[mvu_update\]/i;
const PLOT_COMMENT_MARKER = /\[mvu_plot\]/i;
const VARIABLE_CONTENT_MARKER = /(?:<status_current_variables>|{{(?:format|get)_message_variable::stat_data(?:[.}]|}}))/i;
const UPDATE_CONTENT_MARKER = /(?:<\/?\s*(?:UpdateVariable|JSONPatch)\b|\b_\.set\s*\()/i;
const MVU_RUNTIME_SCRIPT = /MagicalAstrogy\/MagVarUpdate(?:@[^/'"\s]+)?\/artifact\/bundle\.js/i;
const MVU_SCHEMA_SCRIPT = /StageDog\/tavern_resource\/dist\/util\/mvu_zod\.js/i;
const MVU_SCHEMA_URL = /https?:\/\/[^'"\s]*StageDog\/tavern_resource(?:@[^/'"\s]+)?\/dist\/util\/mvu_zod\.js(?:\?[^'"\s]*)?/gi;
// This URL is persisted into adapted cards and may be cached by Liveware for a
// long time. Keep its revision independent from the main MVU bundle revision.
const LOCAL_MVU_SCHEMA_URL = '/scripts/extensions/third-party/nora-mvu/mvu-zod.js?v=4.1.11-nora1';
const ADAPTATION_SCHEMA = 1;

function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cardData(card) {
    return record(card?.data && typeof card.data === 'object' ? card.data : card);
}

function worldbookEntries(book) {
    const entries = Array.isArray(book) ? book : (book?.entries || book || {});
    return Array.isArray(entries) ? entries : Object.values(entries);
}

function normalizeScriptTree(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (item.type === 'script' && item.value && typeof item.value === 'object' && !Array.isArray(item.value)) {
        return { ...item.value, type: 'script' };
    }
    if (item.type === 'folder') {
        const children = Array.isArray(item.scripts) ? item.scripts : (Array.isArray(item.value) ? item.value : []);
        const normalized = children.map(normalizeScriptTree).filter(Boolean);
        const folder = { ...item, type: 'folder', scripts: normalized };
        delete folder.value;
        return folder;
    }
    if (item.type === 'script' || typeof item.content === 'string') return { ...item, type: 'script' };
    return null;
}

function normalizeScriptTrees(value) {
    return Array.isArray(value) ? value.map(normalizeScriptTree).filter(Boolean) : [];
}

function flattenScriptTrees(value) {
    return normalizeScriptTrees(value).flatMap(item => item.type === 'folder'
        ? flattenScriptTrees(item.scripts)
        : [item]);
}

export function normalizeTavernHelperExtension(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (!Array.isArray(value)) return {};

    const entries = value.filter(item => Array.isArray(item)
        && item.length >= 2
        && typeof item[0] === 'string'
        && !['__proto__', 'prototype', 'constructor'].includes(item[0]));
    if (entries.length !== value.length) return {};
    return Object.fromEntries(entries);
}

function scriptIdentity(script) {
    const id = String(script?.id || '').trim();
    if (id) return `id:${id}`;
    return `body:${String(script?.name || '')}\u0000${String(script?.content || '')}`;
}

export function normalizeTavernHelperScripts(card) {
    const extensions = record(cardData(card).extensions);
    const helper = normalizeTavernHelperExtension(extensions.tavern_helper);
    // Match Tavern Helper's own migration contract: canonical data wins when
    // both generations are present; legacy fields are only a fallback.
    const source = Object.hasOwn(extensions, 'tavern_helper')
        ? helper.scripts
        : extensions.TavernHelper_scripts;
    const scripts = flattenScriptTrees(source);
    const seen = new Set();
    return scripts.filter((script) => {
        const identity = scriptIdentity(script);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
    });
}

function entryId(entry, index) {
    return entry?.uid ?? entry?.id ?? index;
}

function isActiveUpdateEntry(entry) {
    return entry?.disable !== true
        && entry?.enabled !== false
        && UPDATE_CONTENT_MARKER.test(String(entry?.content || ''));
}

export function inspectMvuCompatibility({ card = null, books = [], helperScripts = null } = {}) {
    const data = cardData(card);
    const scripts = helperScripts ?? normalizeTavernHelperScripts(card);
    const entries = books.flatMap(worldbookEntries);
    const hasInit = entries.some(entry => INIT_COMMENT_MARKER.test(String(entry?.comment || '')));
    const hasSplitUpdate = entries.some(entry => UPDATE_COMMENT_MARKER.test(String(entry?.comment || '')));
    const hasSplitPlot = entries.some(entry => PLOT_COMMENT_MARKER.test(String(entry?.comment || '')));
    const updateEntryIds = entries
        .map((entry, index) => ({ entry, id: entryId(entry, index) }))
        .filter(({ entry }) => isActiveUpdateEntry(entry))
        .map(({ id }) => id);
    const hasVariableReference = entries.some(entry => VARIABLE_CONTENT_MARKER.test(String(entry?.content || '')));
    const embeddedRuntime = scripts.some(script => script?.enabled !== false && MVU_RUNTIME_SCRIPT.test(String(script?.content || '')));
    const schemaRuntime = scripts.some(script => script?.enabled !== false && MVU_SCHEMA_SCRIPT.test(String(script?.content || '')));
    const managedRuntime = record(data.extensions?.nora_mvu_compatibility).managed_runtime === true;
    const declared = hasInit || hasSplitUpdate || hasSplitPlot
        || (hasVariableReference && updateEntryIds.length > 0)
        || embeddedRuntime || schemaRuntime || managedRuntime;

    let updateProtocol = 'none';
    if (declared) {
        if (hasSplitUpdate || hasSplitPlot) updateProtocol = 'native-split';
        else if (updateEntryIds.length > 0) updateProtocol = 'legacy-adaptable';
        else if (hasVariableReference) updateProtocol = 'legacy-inline';
        else updateProtocol = 'initialization-only';
    }

    const reasons = [];
    if (hasInit) reasons.push('initvar');
    if (hasSplitUpdate) reasons.push('mvu-update-entry');
    if (hasSplitPlot) reasons.push('mvu-plot-entry');
    if (updateEntryIds.length > 0 && !hasSplitUpdate && !hasSplitPlot) reasons.push('legacy-update-content');
    if (embeddedRuntime) reasons.push('embedded-runtime');
    if (schemaRuntime) reasons.push('schema-runtime');
    if (managedRuntime) reasons.push('managed-runtime');

    return Object.freeze({
        declared,
        runtimeSource: !declared ? 'none' : (embeddedRuntime ? 'embedded' : 'managed'),
        updateProtocol,
        splitModelSupported: hasSplitUpdate || hasSplitPlot,
        updateEntryIds: Object.freeze(updateEntryIds),
        helperScripts: Object.freeze([...scripts]),
        reasons: Object.freeze(reasons),
    });
}

function projectManagedMvuScripts(trees) {
    let runtimeSuppressed = false;
    let schemaLocalized = false;
    const project = (script) => {
        if (script?.type === 'folder') return { ...script, scripts: script.scripts.map(project) };
        const content = String(script?.content || '');
        if (script?.enabled !== false && MVU_RUNTIME_SCRIPT.test(content)) {
            runtimeSuppressed = true;
            return { ...script, enabled: false };
        }
        const localized = content.replace(MVU_SCHEMA_URL, LOCAL_MVU_SCHEMA_URL);
        if (localized !== content) {
            schemaLocalized = true;
            return { ...script, content: localized };
        }
        return script;
    };
    const projected = trees.map(project);
    return Object.freeze({
        scripts: projected,
        changed: runtimeSuppressed || schemaLocalized,
        runtimeSuppressed,
        schemaLocalized,
    });
}

function adaptBook(book, updateEntryIds) {
    const ids = new Set(updateEntryIds.map(String));
    const projected = structuredClone(book);
    const entries = projected?.entries;
    const values = Array.isArray(entries) ? entries : Object.values(entries || {});
    values.forEach((entry, index) => {
        if (!ids.has(String(entryId(entry, index))) || UPDATE_COMMENT_MARKER.test(String(entry?.comment || ''))) return;
        entry.comment = `[mvu_update] ${String(entry?.comment || '').trim()}`.trim();
        entry.extensions = {
            ...record(entry.extensions),
            nora_mvu_compatibility: {
                schema: ADAPTATION_SCHEMA,
                source: 'legacy-update-content',
            },
        };
    });
    return projected;
}

export function adaptCardForMvuRuntime(card) {
    const data = cardData(card);
    const extensions = record(data.extensions);
    const hasCanonicalHelper = Object.hasOwn(extensions, 'tavern_helper');
    const helperExtension = normalizeTavernHelperExtension(extensions.tavern_helper);
    const legacyScripts = extensions.TavernHelper_scripts;
    const legacyVariables = record(extensions.TavernHelper_characterScriptVariables);
    const sourceTrees = normalizeScriptTrees(hasCanonicalHelper ? helperExtension.scripts : legacyScripts);
    const sourceVariables = hasCanonicalHelper
        ? record(helperExtension.variables)
        : legacyVariables;
    const book = data.character_book && data.character_book.entries ? data.character_book : null;
    const sourceScripts = flattenScriptTrees(sourceTrees);
    const sourcePlan = inspectMvuCompatibility({ card, books: book ? [book] : [], helperScripts: sourceScripts });
    const runtimeScripts = projectManagedMvuScripts(sourceTrees);
    const hasLegacyScripts = Object.hasOwn(extensions, 'TavernHelper_scripts');
    const hasLegacyVariables = Object.hasOwn(extensions, 'TavernHelper_characterScriptVariables');
    const hasSerializedHelperMap = Array.isArray(extensions.tavern_helper);
    const scriptsChanged = hasLegacyScripts
        || hasLegacyVariables
        || hasSerializedHelperMap
        || runtimeScripts.changed
        || (sourceTrees.length > 0 && JSON.stringify(helperExtension.scripts || []) !== JSON.stringify(sourceTrees));
    const bookChanged = sourcePlan.updateProtocol === 'legacy-adaptable' && sourcePlan.updateEntryIds.length > 0;
    if (!scriptsChanged && !bookChanged) return Object.freeze({ card, changed: false, plan: sourcePlan });

    const projected = structuredClone(card);
    const projectedData = cardData(projected);
    projectedData.extensions ??= {};
    if (sourceTrees.length > 0 || Object.keys(sourceVariables).length > 0 || hasCanonicalHelper || hasLegacyScripts || hasLegacyVariables) {
        projectedData.extensions.tavern_helper = {
            ...helperExtension,
            variables: structuredClone(sourceVariables),
            scripts: structuredClone(runtimeScripts.scripts),
        };
    }
    delete projectedData.extensions.TavernHelper_scripts;
    delete projectedData.extensions.TavernHelper_characterScriptVariables;
    if (runtimeScripts.changed) {
        projectedData.extensions.nora_mvu_compatibility = {
            ...record(projectedData.extensions.nora_mvu_compatibility),
            schema: ADAPTATION_SCHEMA,
            managed_runtime: true,
            ...(runtimeScripts.runtimeSuppressed ? { embedded_runtime_suppressed: true } : {}),
            ...(runtimeScripts.schemaLocalized ? { schema_runtime_localized: true } : {}),
        };
    }
    if (bookChanged) projectedData.character_book = adaptBook(projectedData.character_book, sourcePlan.updateEntryIds);
    const projectedBook = projectedData.character_book && projectedData.character_book.entries
        ? projectedData.character_book
        : null;
    const plan = inspectMvuCompatibility({
        card: projected,
        books: projectedBook ? [projectedBook] : [],
        helperScripts: flattenScriptTrees(runtimeScripts.scripts),
    });
    return Object.freeze({ card: projected, changed: true, plan });
}

export function isMvuUpdateInstructionEntry(entry = {}) {
    return UPDATE_COMMENT_MARKER.test(String(entry?.comment || ''))
        || UPDATE_CONTENT_MARKER.test(String(entry?.content || ''));
}
