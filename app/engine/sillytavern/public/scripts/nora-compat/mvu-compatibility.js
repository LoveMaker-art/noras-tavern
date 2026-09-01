const INIT_COMMENT_MARKER = /\[initvar\]/i;
const UPDATE_COMMENT_MARKER = /\[mvu_update\]/i;
const PLOT_COMMENT_MARKER = /\[mvu_plot\]/i;
const VARIABLE_CONTENT_MARKER = /(?:<status_current_variables>|{{(?:format|get)_message_variable::stat_data(?:[.}]|}}))/i;
const UPDATE_CONTENT_MARKER = /(?:<\/?\s*(?:UpdateVariable|JSONPatch)\b|\b_\.set\s*\()/i;
const MVU_RUNTIME_SCRIPT = /MagicalAstrogy\/MagVarUpdate(?:@[^/'"\s]+)?\/artifact\/bundle\.js/i;
const MVU_SCHEMA_SCRIPT = /StageDog\/tavern_resource\/dist\/util\/mvu_zod\.js/i;
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

function unwrapScript(item) {
    if (!item || typeof item !== 'object') return [];
    if (item.type === 'script' && item.value && typeof item.value === 'object') {
        return [{ ...item.value, type: 'script' }];
    }
    if (item.type === 'script') return [item];
    if (Array.isArray(item.scripts)) return item.scripts.flatMap(unwrapScript);
    return [];
}

function scriptIdentity(script) {
    const id = String(script?.id || '').trim();
    if (id) return `id:${id}`;
    return `body:${String(script?.name || '')}\u0000${String(script?.content || '')}`;
}

export function normalizeTavernHelperScripts(card) {
    const extensions = record(cardData(card).extensions);
    const canonical = Array.isArray(extensions.tavern_helper?.scripts)
        ? extensions.tavern_helper.scripts.flatMap(unwrapScript)
        : [];
    const legacy = Array.isArray(extensions.TavernHelper_scripts)
        ? extensions.TavernHelper_scripts.flatMap(unwrapScript)
        : [];
    const seen = new Set();
    return [...canonical, ...legacy].filter((script) => {
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
    const declared = hasInit || hasSplitUpdate || hasSplitPlot
        || (hasVariableReference && updateEntryIds.length > 0)
        || embeddedRuntime || schemaRuntime;

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
    const book = data.character_book && data.character_book.entries ? data.character_book : null;
    const scripts = normalizeTavernHelperScripts(card);
    const plan = inspectMvuCompatibility({ card, books: book ? [book] : [], helperScripts: scripts });
    const hasLegacyScripts = Array.isArray(data.extensions?.TavernHelper_scripts);
    const canonicalScripts = data.extensions?.tavern_helper?.scripts;
    const scriptsChanged = hasLegacyScripts
        || (scripts.length > 0 && JSON.stringify(canonicalScripts || []) !== JSON.stringify(scripts));
    const bookChanged = plan.updateProtocol === 'legacy-adaptable' && plan.updateEntryIds.length > 0;
    if (!scriptsChanged && !bookChanged) return Object.freeze({ card, changed: false, plan });

    const projected = structuredClone(card);
    const projectedData = cardData(projected);
    projectedData.extensions ??= {};
    if (scripts.length > 0 || projectedData.extensions.tavern_helper) {
        projectedData.extensions.tavern_helper = {
            ...record(projectedData.extensions.tavern_helper),
            scripts: structuredClone(scripts),
        };
    }
    delete projectedData.extensions.TavernHelper_scripts;
    if (bookChanged) projectedData.character_book = adaptBook(projectedData.character_book, plan.updateEntryIds);
    return Object.freeze({ card: projected, changed: true, plan });
}

export function isMvuUpdateInstructionEntry(entry = {}) {
    return UPDATE_COMMENT_MARKER.test(String(entry?.comment || ''))
        || UPDATE_CONTENT_MARKER.test(String(entry?.content || ''));
}
