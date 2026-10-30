import { READING_FIELDS, READING_DEFAULTS, normalizeReadingValues, projectReading } from '../../engine/sillytavern/public/scripts/nora-worlds/reading-preferences.js';

const failure = (code, message) => Object.assign(new Error(message), { code });

// One style owner; the independent preference document never enters ordinary settings saves.
export function createReadingController({ select, getWorldId, requestHeaders, fetcher = (...args) => fetch(...args),
    scheduleFrame = callback => requestAnimationFrame(callback), timeoutMs = 30000 } = {}) {
    let worldId, target, generation = 0, defaults = {}, pending;
    const paragraphAttribute = 'data-nora-reading-paragraph-spacing';
    let previousParagraphAttribute = null;
    let state = { ready: false, applied: false, visualVerified: false };
    const originals = new Map();
    let restoreSequence = 0;
    async function request(scope, id, body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const query = new URLSearchParams({ scope, ...(id ? { worldId: id } : {}) });
            const response = await fetcher(`/api/nora-worlds-v2/reading${body ? '' : `?${query}`}`, {
                method: body ? 'POST' : 'GET', headers: requestHeaders(), signal: controller.signal,
                cache: 'no-store', ...(body ? { body: JSON.stringify(body) } : {}),
            });
            const value = await response.json();
            if (!response.ok) throw failure(value.error?.code || 'NORA_READING_REQUEST_FAILED', value.error?.message || 'Reading request failed.');
            return value;
        } finally { clearTimeout(timer); }
    }
    function restore() {
        for (const [name, previous] of originals) {
            if (previous[0]) target?.style.setProperty(name, previous[0], previous[1]);
            else target?.style.removeProperty(name);
        }
        originals.clear();
        restoreParagraphAttribute();
    }
    function restoreParagraphAttribute() {
        if (previousParagraphAttribute === null) target?.removeAttribute(paragraphAttribute);
        else target?.setAttribute(paragraphAttribute, previousParagraphAttribute);
    }
    function apply(values) {
        if (!target) throw failure('NORA_READING_NOT_READY', 'Story reading surface is unavailable.');
        const properties = projectReading(values);
        const element = target;
        const token = ++restoreSequence;
        const atEnd = element.scrollHeight - element.clientHeight - element.scrollTop <= 32;
        const top = element.getBoundingClientRect?.().top ?? 0;
        const visible = selector => [...(element.querySelectorAll?.(selector) || [])].find(node => node.getBoundingClientRect().bottom > top);
        const anchor = visible('.mes_text > p') || visible('.mes');
        const offset = anchor ? anchor.getBoundingClientRect().top - top : null;
        const scrollTop = element.scrollTop;
        let interrupted = false;
        const cancel = () => { interrupted = true; };
        for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) element.addEventListener?.(name, cancel, { passive: true });
        try {
            for (const [name, previous] of originals) if (!(name in properties)) {
                if (previous[0]) element.style.setProperty(name, previous[0], previous[1]); else element.style.removeProperty(name);
                originals.delete(name);
            }
            for (const [name, value] of Object.entries(properties)) {
                if (!originals.has(name)) originals.set(name, [element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]);
                element.style.setProperty(name, value);
            }
            if (Object.hasOwn(values, 'paragraph_spacing')) element.setAttribute(paragraphAttribute, '');
            else restoreParagraphAttribute();
        } finally {
            scheduleFrame(() => {
                for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) element.removeEventListener?.(name, cancel);
                if (interrupted || token !== restoreSequence || element !== target || element.scrollTop !== scrollTop) return;
                if (atEnd) element.scrollTop = element.scrollHeight;
                else if (anchor?.isConnected) element.scrollTop += anchor.getBoundingClientRect().top - top - offset;
            });
        }
    }
    async function load() {
        const id = worldId;
        const ticket = ++generation;
        const value = await request(id ? 'world' : 'global', id);
        if (ticket !== generation || id !== (getWorldId() || '')) throw failure('NORA_CONTROL_SCOPE_CHANGED', 'World changed before reading preferences were applied.');
        defaults = value.defaults;
        apply(value.overrides);
        state = { ready: true, applied: true, worldId: id, revision: value.revision, visualVerified: false };
        return { ...value, renderer: { ...state }, applied: true, visualVerified: false };
    }
    function render() {
        const id = getWorldId() || '';
        const element = select('#nora-chat');
        if (id === worldId && element === target) return { ...state };
        ++generation; ++restoreSequence;
        restore(); target = element; worldId = id;
        previousParagraphAttribute = target?.getAttribute(paragraphAttribute) ?? null;
        state = { ready: false, applied: false, worldId: id, visualVerified: false };
        // Never keep the preceding World's override while awaiting the next read.
        try { if (target) apply(defaults); } catch { /* load reports the unavailable renderer */ }
        pending = load().catch(error => {
            if (worldId === id && !state.ready) state = { ...state, error: { code: error.code || 'NORA_READING_REQUEST_FAILED', message: error.message } };
        });
        return { ...state };
    }
    async function execute(action, params = {}) {
        if (action === 'reading.catalog') return { fields: READING_FIELDS, builtin: READING_DEFAULTS,
            unsetParagraphSpacing: 'existing stylesheet; no numeric override',
            scopes: ['global', 'world'], fontActions: 'theme.catalog', crossTab: 'reload', visualVerified: false };
        const id = getWorldId() || '';
        if (params.scope === 'world' && !id) throw failure('NORA_READING_INVALID', 'An active World is required.');
        if (action === 'reading.inspect') {
            const value = await request(params.scope, params.scope === 'world' ? id : '');
            if (id !== (getWorldId() || '')) throw failure('NORA_CONTROL_SCOPE_CHANGED', 'World changed while reading preferences.');
            return value;
        }
        render();
        if (action === 'reading.refresh') return load();
        if (!['reading.apply', 'reading.reset'].includes(action)) throw failure('NORA_CONTROL_UNSUPPORTED', 'Unknown reading action.');
        const fields = params.field === 'all' ? Object.keys(READING_FIELDS) : [params.field];
        const values = action === 'reading.reset' ? Object.fromEntries(fields.map(field => [field, null])) : params.values;
        normalizeReadingValues(values, { patch: true });
        const saved = await request(params.scope, params.scope === 'world' ? id : '', {
            scope: params.scope, ...(params.scope === 'world' ? { worldId: id } : {}), values, expectedRevision: params.expectedRevision,
        });
        try {
            if (id !== (getWorldId() || '')) throw failure('NORA_CONTROL_SCOPE_CHANGED', 'World changed after saving.');
            const current = await load();
            return { ...saved, applied: true, appliedRevision: current.revision, superseded: saved.revision !== current.revision,
                renderer: current.renderer, visualVerified: false };
        } catch (error) {
            return { ...saved, applied: false, reopenRequired: true, visualVerified: false,
                applicationError: { code: error.code || 'NORA_READING_NOT_READY', message: error.message } };
        }
    }
    return Object.freeze({ render, execute, inspect: () => ({ ...state }), settled: () => pending });
}
