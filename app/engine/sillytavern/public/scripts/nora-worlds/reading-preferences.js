// Numeric reading policy shared by storage, controls and the page renderer.
export const READING_SCHEMA = 'nora-reading-preferences/1';
export const READING_FIELDS = Object.freeze({
    font_size: Object.freeze({ min: 12, max: 32, step: 0.5, unit: 'px' }),
    line_height: Object.freeze({ min: 1.2, max: 2.5, step: 0.05, unit: '' }),
    paragraph_spacing: Object.freeze({ min: 0, max: 40, step: 1, unit: 'px' }),
});
export const READING_DEFAULTS = Object.freeze({
    assistant: Object.freeze({ font_size: 15.5, line_height: 1.68, paragraph_spacing: null }),
    user: Object.freeze({ font_size: 14, line_height: 1.6, paragraph_spacing: null }),
});
export function readingError(message) {
    return Object.assign(new Error(message), { code: 'NORA_READING_INVALID' });
}
function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function normalizeReadingValues(value, { patch = false } = {}) {
    if (!object(value)) throw readingError('Reading values must be an object.');
    const result = {};
    for (const [key, number] of Object.entries(value)) {
        const spec = Object.hasOwn(READING_FIELDS, key) && READING_FIELDS[key];
        if (!spec) throw readingError(`Unknown reading field: ${key}`);
        if (patch && number === null) { result[key] = null; continue; }
        const steps = (number - spec.min) / spec.step;
        if (typeof number !== 'number' || !Number.isFinite(number) || number < spec.min || number > spec.max
            || Math.abs(steps - Math.round(steps)) > 1e-8) throw readingError(`Invalid ${key}; see reading.catalog.`);
        result[key] = number;
    }
    return result;
}
export function readingTarget(scope, worldId = '') {
    if (scope !== 'global' && scope !== 'world') throw readingError('Explicit global or world scope is required.');
    if (scope === 'world' && (typeof worldId !== 'string' || !worldId || worldId.length > 256
        || [...worldId].some(character => character.charCodeAt(0) < 32))) throw readingError('A stable world ID is required.');
    return { scope, worldId: scope === 'world' ? worldId : '' };
}
export function normalizeReadingDocument(value) {
    if (!object(value) || value.schema !== READING_SCHEMA || !object(value.worlds)
        || Object.keys(value).some(key => !['schema', 'defaults', 'worlds'].includes(key))) throw readingError('Invalid reading preferences document.');
    const worlds = Object.create(null);
    for (const [id, fields] of Object.entries(value.worlds)) {
        readingTarget('world', id);
        worlds[id] = normalizeReadingValues(fields);
    }
    return { schema: READING_SCHEMA, defaults: normalizeReadingValues(value.defaults), worlds };
}
export function describeReading(document, scope, worldId = '') {
    const target = readingTarget(scope, worldId);
    const values = target.scope === 'global' ? document.defaults : document.worlds[target.worldId] ?? {};
    const overrides = { ...document.defaults, ...(target.scope === 'world' ? values : {}) };
    const sources = Object.fromEntries(Object.keys(READING_FIELDS).map(key => [key,
        target.scope === 'world' && Object.hasOwn(values, key) ? 'world' : Object.hasOwn(document.defaults, key) ? 'global' : 'builtin']));
    return { ...target, values: { ...values }, defaults: { ...document.defaults }, overrides,
        effective: { assistant: { ...READING_DEFAULTS.assistant, ...overrides }, user: { ...READING_DEFAULTS.user, ...overrides } }, sources };
}
export function projectReading(values) {
    return Object.fromEntries(Object.entries(normalizeReadingValues(values)).map(([key, value]) =>
        [`--nora-reading-${key.replaceAll('_', '-')}`, `${value}${READING_FIELDS[key].unit}`]));
}
