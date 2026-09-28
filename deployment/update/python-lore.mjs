// Compile Python's literal-key conjunction into ST's existing regex-key format.
// No second runtime selector or extra generation request is introduced.
const words = (entry, ...names) => {
    const value = names.map(name => entry[name]).find(value => Array.isArray(value) ? value.length : value);
    return (Array.isArray(value) ? value : value ? [value] : []).map(String).map(word => word.trim()).filter(Boolean);
};
const literal = word => word.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
const any = values => '(?:' + values.map(literal).join('|') + ')';

export function pythonLoreEntry(entry, book) {
    const primary = words(entry, 'keys', 'key');
    const secondary = entry.selective ? words(entry, 'secondary_keys', 'secondaryKeys', 'secondary') : [];
    const excluded = words(entry, 'exclusion_keys', 'exclude_keys', 'exclude', 'exclusions');
    const sensitive = Boolean(entry.case_sensitive || entry.caseSensitive);
    const constant = Boolean(entry.constant) && !secondary.length && !excluded.length;
    const compiled = excluded.length || (entry.constant && secondary.length) || [...primary, ...secondary].some(key => key.startsWith('/') || key.includes('{{'));
    let expression = '^';
    if (!entry.constant) expression += primary.length ? '(?=[\\s\\S]*' + any(primary) + ')' : '(?!)';
    if (secondary.length) expression += '(?=[\\s\\S]*' + any(secondary) + ')';
    if (excluded.length) expression += '(?![\\s\\S]*' + any(excluded) + ')';
    const probability = Number(entry.probability ?? entry.probability_percent ?? 100);
    const chance = Number.isFinite(probability) ? probability : 100;
    return { ...entry, keys: compiled ? ['/' + expression + '[\\s\\S]*/' + (sensitive ? '' : 'i')] : primary,
        constant, selective: !compiled && Boolean(entry.selective), secondary_keys: compiled ? [] : secondary, content: entry.content || entry.comment || '',
        insertion_order: entry.insertion_order ?? entry.order ?? 100,
        extensions: { ...entry.extensions, case_sensitive: sensitive, match_whole_words: false,
            scan_depth: 6, exclude_recursion: !(book.recursive || entry.recursive),
            probability: Math.max(0, Math.min(100, chance <= 1 ? chance * 100 : chance)) } };
}
