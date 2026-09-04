const TEMPLATE_MARKERS = Object.freeze([
    { reason: 'ejs-syntax', pattern: /<%[-_=#]?/ },
    { reason: 'prompt-decorator', pattern: /@@(?:render|generate)_(?:before|after)|@@dont_preload/i },
    { reason: 'prompt-template-api', pattern: /\bEjsTemplate\b|(?:^|\s)\/ejs(?:-refresh)?\b/i },
]);

function collectReasons(value, reasons, visited) {
    if (typeof value === 'string') {
        for (const marker of TEMPLATE_MARKERS) {
            if (marker.pattern.test(value)) reasons.add(marker.reason);
        }
        return;
    }
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
        for (const item of value) collectReasons(item, reasons, visited);
        return;
    }
    for (const item of Object.values(value)) collectReasons(item, reasons, visited);
}

/**
 * Detects cards and World Info that require the managed ST Prompt Template runtime.
 * The scan is deliberately data-shaped rather than field-shaped so older card specs
 * and extension-owned containers receive the same compatibility treatment.
 */
export function inspectPromptTemplateCompatibility({ card = null, books = [] } = {}) {
    const reasons = new Set();
    const visited = new WeakSet();
    collectReasons(card, reasons, visited);
    collectReasons(books, reasons, visited);
    return Object.freeze({
        declared: reasons.size > 0,
        reasons: Object.freeze([...reasons].sort()),
    });
}
