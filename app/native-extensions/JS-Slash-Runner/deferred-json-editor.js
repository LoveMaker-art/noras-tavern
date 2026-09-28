let pending;

export function loadJSONEditor() {
    if (!pending) {
        pending = import('./lib/jsoneditor.js').catch(error => {
            pending = null;
            throw error;
        });
    }
    return pending;
}

export async function mountJSONEditor({ target, disposed, initialize, load = loadJSONEditor }) {
    if (disposed()) return;
    target.setAttribute('aria-busy', 'true');
    try {
        const editor = await load();
        if (disposed()) return;
        initialize(editor);
    } catch (error) {
        if (!disposed()) {
            target.textContent = 'JSON editor could not be loaded. Close and reopen to retry.';
            console.error('[Tavern Helper] JSON editor initialization failed', error);
        }
    } finally {
        if (!disposed()) target.removeAttribute('aria-busy');
    }
}
