// Shared by the authenticated broker and the browser executor. No eval/reflective dispatch.
const action = (description, fields = {}, options = {}) => Object.freeze({ description, fields, readOnly: false, ...options });
export const CONTROL_ACTIONS = Object.freeze({
    'theme.catalog': action('Read supported original World Visuals theme fields, fonts and scope', {}, { readOnly: true }),
    'theme.backgrounds': action('List existing ST background images without downloading them', {}, { readOnly: true }),
    'theme.inspect': action('Read current World visual configuration, revision and renderer state', {}, { readOnly: true }),
    'theme.apply': action('Replace current World visual config only; preserve unmodified fields from inspect; no new UI controls', { ui: 'object', expectedRevision: 'string' }),
    'theme.clear': action('Restore default appearance for current World; keep story data and image assets', { expectedRevision: 'string' }),
    'world.inspect': action('Read active World name/persona and authoritative revision', {}, { readOnly: true }),
    'world.update': action('Patch active World name or persona through World Core; never change library card or other Worlds', { patch: 'object', expectedRevision: 'string' }),
    'scenario.inspect': action('Read current-session background override and card fallback', {}, { readOnly: true }),
    'scenario.update': action('Save current-session background; empty text restores card scenario', { text: 'string', expectedRevision: 'string' }),
    'worldbook.list': action('List authoritative World runtime worldbooks and ownership', {}, { readOnly: true }),
    'worldbook.inspect': action('Read a bound World runtime worldbook, stable entry IDs and revision', { name: 'string' }, { readOnly: true }),
    'worldbook.update-entry': action('Patch a World-owned runtime entry, preserving MVU/extensions/insertion fields', { name: 'string', entryId: 'string', patch: 'object', expectedRevision: 'string' }),
    'worldbook.delete-entry': action('Delete one World-owned runtime entry, not the entire worldbook', { name: 'string', entryId: 'string', expectedRevision: 'string' }),
    'models.list': action('List saved text models including Hermes; credentials excluded; GLOBAL configuration', {}, { readOnly: true }),
    'models.select': action('Select a saved text model through the same service as the panel; global; no generation', { id: 'string', expectedRevision: 'string' }),
    'models.delete': action('Delete one custom model profile with the same fallback as UI; Hermes cannot be deleted; global', { id: 'string', expectedRevision: 'string' }),
    'plugins.list': action('List installed frontend extensions, policy and runtime state', {}, { readOnly: true }),
    'plugins.enabled': action('Set extension enabled state; generic extensions require a page reload', { name: 'string', enabled: 'boolean' }, { script: true }),
    'plugins.config': action('Inspect an extension configuration (credentials redacted)', { name: 'string' }, { readOnly: true }),
    'plugins.configure': action('Patch existing primitive configuration fields; reload required', { name: 'string', updates: 'object' }, { script: true }),
    'scripts.list': action('Read actual helper script trees', { scope: ['global', 'character', 'preset'] }, { readOnly: true }),
    'scripts.inspect': action('Read a script by stable ID and its tree revision', { scope: ['global', 'character', 'preset'], id: 'string' }, { readOnly: true }),
    'scripts.create': action('Create a disabled script in the selected scope; enable separately', { scope: ['global', 'character', 'preset'], name: 'string', content: 'string', expectedRevision: 'string' }, { script: true }),
    'scripts.enabled': action('Enable or disable a script or folder by stable ID', { scope: ['global', 'character', 'preset'], id: 'string', enabled: 'boolean', expectedRevision: 'string' }, { script: true }),
    'scripts.update': action('Edit one existing script; helper owns validation and lifecycle', { scope: ['global', 'character', 'preset'], id: 'string', patch: 'object', expectedRevision: 'string' }, { script: true }),
    'scripts.delete': action('Remove one existing script/folder; no whole-tree replacement', { scope: ['global', 'character', 'preset'], id: 'string', expectedRevision: 'string' }, { script: true }),
    'scripts.buttons': action('List buttons exposed by currently enabled helper scripts', {}, { readOnly: true }),
    'scripts.button': action('Trigger an existing script button; completion of arbitrary script work is not guaranteed', { buttonId: 'string' }, { script: true, model: true }),
    'regex.list': action('Read regex scripts for the selected scope', { scope: ['global', 'character', 'preset'] }, { readOnly: true }),
    'regex.create': action('Create a disabled regex in the selected scope', { scope: ['global', 'character', 'preset'], name: 'string', findRegex: 'string', replaceString: 'string', expectedRevision: 'string' }),
    'regex.permission': action('Enable/disable the current character or preset regex scope', { scope: ['character', 'preset'], enabled: 'boolean' }),
    'regex.enabled': action('Toggle one regex by ID', { scope: ['global', 'character', 'preset'], id: 'string', enabled: 'boolean', expectedRevision: 'string' }),
    'regex.update': action('Edit one existing regex using native regex storage', { scope: ['global', 'character', 'preset'], id: 'string', patch: 'object', expectedRevision: 'string' }),
    'regex.delete': action('Remove one regex by ID', { scope: ['global', 'character', 'preset'], id: 'string', expectedRevision: 'string' }),
    'mvu.status': action('Read runtime, initialization, model mode and managed-runtime policy', {}, { readOnly: true }),
    'mvu.settings': action('Inspect MVU settings with secrets redacted', {}, { readOnly: true }),
    'mvu.configure': action('Configure existing non-credential MVU parser settings', { updates: 'object' }, { model: true }),
    'mvu.data': action('Read latest stored MVU message variables, without modifying them', {}, { readOnly: true }),
    'mvu.enabled': action('Toggle EXTRA MODEL automatic parsing, not the whole MVU runtime; global setting', { enabled: 'boolean' }, { model: true }),
    'mvu.model': action('Select story or previously configured independent model; global setting', { source: ['story', 'independent'] }, { model: true }),
    'mvu.runtime': action('Enable/disable Nora-managed MVU script persistently; reload required. Embedded card scripts use scripts.enabled.', { enabled: 'boolean' }, { script: true, model: true }),
    'mvu.retry': action('Retry latest variable update through the real runtime', {}, { model: true }),
    'helper.permissions': action('Set execution permission for global, current character or preset scripts', { scope: ['global', 'character', 'preset'], enabled: 'boolean' }, { script: true }),
    'helper.settings': action('Inspect Helper render/audio/macro and other existing settings', {}, { readOnly: true }),
    'helper.configure': action('Patch existing primitive Helper settings; script permissions use dedicated operations', { updates: 'object' }, { script: true }),
    'cards.inspect': action('Read active World runtime-card fields and revision', {}, { readOnly: true }),
    'cards.opening': action('Change active World runtime-card opening template, not existing chat history or library source', { text: 'string', expectedRevision: 'string' }),
    'cards.fields': action('Patch active World runtime-card narrative fields', { patch: 'object', expectedRevision: 'string' }),
    'story.send': action('Send text through the existing Nora action dispatcher', { text: 'string' }, { model: true }),
    'story.regenerate': action('Regenerate through the existing Nora action dispatcher', {}, { model: true }),
    'story.suggest': action('Generate suggested replies through the existing dispatcher', {}, { model: true }),
    'story.stop': action('Request cancellation through the existing Nora dispatcher', {}),
    'page.reload': action('Explicitly reload this client to apply pending extension changes', {}),
});

export function controlError(code, message) { return Object.assign(new Error(message), { code }); }
export function validateControl(input, { readOnly = false } = {}) {
    const definition = CONTROL_ACTIONS[input?.action];
    if (!definition) throw controlError('NORA_CONTROL_UNSUPPORTED', 'Unknown control action.');
    if (readOnly && !definition.readOnly) throw controlError('NORA_CONTROL_WRITE_DENIED', 'Read tool cannot execute mutations.');
    if (!definition.readOnly && input.confirm !== true) throw controlError('NORA_CONFIRMATION_REQUIRED', 'Explicit confirmation required.');
    if (definition.model && input.allowModelCall !== true) throw controlError('NORA_MODEL_CALL_NOT_AUTHORIZED', 'This action may call a model.');
    if (definition.script && input.allowScriptExecution !== true) throw controlError('NORA_SCRIPT_NOT_AUTHORIZED', 'This action can execute or stop user scripts.');
    const params = input.params ?? {};
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw controlError('NORA_CONTROL_INVALID', 'params must be an object.');
    if (JSON.stringify(params).length > 256000) throw controlError('NORA_CONTROL_LIMIT', 'Control parameters exceed 256k characters.');
    for (const key of Object.keys(params)) if (!Object.hasOwn(definition.fields, key)) throw controlError('NORA_CONTROL_INVALID', `Unexpected parameter: ${key}`);
    for (const [key, type] of Object.entries(definition.fields)) {
        const value = params[key];
        if (Array.isArray(type) ? !type.includes(value) : type === 'object' ? !value || typeof value !== 'object' || Array.isArray(value) : typeof value !== type) {
            throw controlError('NORA_CONTROL_INVALID', `Invalid parameter: ${key}`);
        }
    }
    return definition;
}
