import { controlError } from './contract.js';
import { contentRevision } from './revision.js';

export function validatePluginRepository(value) {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.replace(/\/$/, '').split('/').pop()) {
        throw controlError('NORA_CONTROL_INVALID', 'Use an HTTP(S) Git repository URL without credentials, query or fragment.');
    }
    return url.href.replace(/\/$/, '');
}

export function createPluginLibraryActions({ request, loadExtensions, getContext }) {
    async function list() {
        const { items } = await request('/api/extensions/library');
        const module = await loadExtensions();
        const runtime = module.getExtensionLibraryRuntime?.() || {};
        return items.map(item => ({ ...item,
            enabled: item.libraryEnabled ?? runtime[item.name]?.enabled ?? !getContext().extensionSettings.disabledExtensions?.includes(item.name),
            active: Boolean(runtime[item.name]?.loaded ?? getContext().getActiveExtensionNames().includes(item.name)),
            controllable: item.editable || ['tavern_helper', 'prompt_template', 'mvu'].includes(item.builtin?.key),
            reason: item.editable || item.builtin ? null : 'shared-or-protected-plugin',
            effect: 'reload-required',
        }));
    }
    async function execute(action, params) {
        if (action === 'plugins.install') {
            await request('/api/extensions/install', { url: validatePluginRepository(params.url), global: false, disabled: true });
            return { installed: true, enabled: false, runtimeApplied: false, reloadRequired: false };
        }
        const items = await list();
        if (await contentRevision(items) !== params.expectedRevision) throw controlError('NORA_CONTROL_EDIT_STALE', 'Plugin library changed; list again.');
        const item = items.find(item => item.name === params.name);
        if (!item?.editable || (action === 'plugins.update' && !item.repository)) throw controlError('NORA_CONTROL_PROTECTED', 'Only editable local plugins support this operation.');
        const result = await request(`/api/extensions/${action === 'plugins.uninstall' ? 'delete' : 'update'}`, {
            extensionName: item.name.replace(/^third-party\//, ''), global: false,
        });
        return { name: item.name, saved: true, deleted: action === 'plugins.uninstall', isUpToDate: result?.isUpToDate === true,
            runtimeApplied: false, reloadRequired: action === 'plugins.uninstall' || !result?.isUpToDate };
    }
    return { list, execute };
}
