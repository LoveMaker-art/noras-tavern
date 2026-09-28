const modes = ['system', 'light', 'dark'];
const failure = (code, message) => Object.assign(new Error(message), { code });

// Page appearance is independent of World visuals. Non-loopback pages keep the
// browser/WebView color preference; a saved local choice never overrides it.
export function createAppearanceController({ root, media, hostname, settings, persist }) {
    const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
    let saving = false;
    const savedMode = () => modes.includes(settings().appearanceMode) ? settings().appearanceMode : 'system';
    function render() {
        const mode = local ? savedMode() : 'system';
        if (mode === 'system') root.removeAttribute('data-nora-appearance');
        else root.setAttribute('data-nora-appearance', mode);
        root.style.colorScheme = mode === 'system' ? 'light dark' : mode;
    }
    function inspect() {
        const mode = local ? savedMode() : 'system';
        return { ready: true, scope: 'page', controllable: local, savedMode: savedMode(), mode,
            effectiveMode: mode === 'system' ? (media.matches ? 'dark' : 'light') : mode,
            source: local && mode !== 'system' ? 'local-preference' : 'browser-preference',
            revision: savedMode(), applied: true, visualVerified: false };
    }
    async function set({ mode, expectedRevision }) {
        if (!local) throw failure('NORA_APPEARANCE_AUTOMATIC', 'This page follows its browser/WebView appearance.');
        if (!modes.includes(mode)) throw failure('NORA_CONTROL_INVALID', 'Expected system, light or dark.');
        if (saving) throw failure('NORA_CONTROL_BUSY', 'Appearance save is in progress.');
        if (expectedRevision !== savedMode()) throw failure('NORA_CONTROL_EDIT_STALE', 'Inspect appearance again.');
        const target = settings();
        const previous = target.appearanceMode;
        saving = true;
        try {
            target.appearanceMode = mode;
            await persist();
            render();
            return { ...inspect(), saved: true, generationRequested: false };
        } catch (error) {
            if (previous === undefined) delete target.appearanceMode;
            else target.appearanceMode = previous;
            render();
            throw error;
        } finally { saving = false; }
    }
    media.addEventListener('change', render);
    render();
    return Object.freeze({ inspect, set, dispose: () => media.removeEventListener('change', render) });
}
