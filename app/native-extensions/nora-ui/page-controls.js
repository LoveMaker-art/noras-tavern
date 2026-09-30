const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export function createPageControls({ ready, dialogs, shell, draft, setDraft, loadWorlds, openWorld, openPanel, openLibrary, modalOpen }) {
    const state = () => ({ ready: ready(), modalOpen: modalOpen(), protectedDialog: dialogs.protected,
        view: dialogs.viewKey || '', drawers: shell.drawerState(), draft: draft(), dialogVersion: dialogs.version });
    async function execute(action, params) {
        const snapshot = state();
        if (!snapshot.ready) fail('NORA_CONTROL_OFFLINE', 'Page is not ready.');
        if (action === 'page.close') {
            await dialogs.close();
            shell.closeDrawers();
            return { applied: !state().modalOpen, page: state() };
        }
        if (snapshot.protectedDialog || snapshot.modalOpen && !['page.open', 'page.library', 'page.sidebar'].includes(action)) {
            fail('NORA_CONTROL_EDITOR_OPEN', 'Close the current dialog first; edits were preserved.');
        }
        if (action === 'page.draft') setDraft(params.text);
        else if (action === 'page.world') {
            if (snapshot.draft) fail('NORA_CONTROL_DRAFT_PRESENT', 'Composer draft was preserved.');
            await loadWorlds();
            const latest = state();
            if (latest.modalOpen || latest.draft || latest.dialogVersion !== snapshot.dialogVersion) fail('NORA_CONTROL_EDIT_STALE', 'Page changed during navigation.');
            await openWorld(params.targetWorldId);
        } else if (action === 'page.open') await openPanel(params.panel);
        else if (action === 'page.library') await openLibrary(params.kind);
        else if (action === 'page.sidebar') shell.setDrawer(params.which, params.expanded);
        else fail('NORA_CONTROL_UNSUPPORTED', 'Unsupported page operation.');
        return { applied: true, page: state() };
    }
    return Object.freeze({ state, execute });
}
