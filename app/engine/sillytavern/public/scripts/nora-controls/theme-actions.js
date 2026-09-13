import { normalizeWorldTheme, resolveWorldTheme, worldThemeCatalog } from '../nora-worlds/world-theme.js';
import { controlError } from './contract.js';

export function createThemeActions({ getContext, request, story, readTheme, renderTheme = () => ({ ready: false }) }) {
    return async (action, params) => {
        if (action === 'theme.catalog') return worldThemeCatalog();
        if (action === 'theme.backgrounds') {
            const result = await request('/api/backgrounds/all', {});
            return { images: result.images.map(item => ({ ...item, url: `/backgrounds/${encodeURIComponent(item.filename)}` })) };
        }
        if (action.startsWith('theme.global.')) {
            if (action === 'theme.global.inspect') return { scope: 'global', ...await request('/api/nora-worlds-v2/theme'), renderer: readTheme() };
            const ui = normalizeWorldTheme(action === 'theme.global.clear' ? {} : params.ui);
            const saved = await request('/api/nora-worlds-v2/theme', { ui, expectedRevision: params.expectedRevision });
            try {
                story.settings.uiSettings().globalTheme = saved.ui;
                const renderer = renderTheme();
                return { ...saved, scope: 'global', renderer, reopenRequired: !renderer?.ready, generationRequested: false };
            }
            catch { return { ...saved, scope: 'global', renderer: { ready: false }, reopenRequired: true }; }
        }
        const worldId = getContext().chatMetadata?.nora_world?.id;
        if (!worldId) throw controlError('NORA_CONTROL_NO_WORLD', 'Open the target World first.');
        const { plan } = await request(`/api/nora-worlds-v2/worlds/${encodeURIComponent(worldId)}/open-plan`);
        if (getContext().chatMetadata?.nora_world?.id !== worldId) throw controlError('NORA_CONTROL_SCOPE_CHANGED', 'World changed while reading its theme.');
        if (action === 'theme.inspect') {
            const { ui: globalUi } = await request('/api/nora-worlds-v2/theme');
            if (getContext().chatMetadata?.nora_world?.id !== worldId) throw controlError('NORA_CONTROL_SCOPE_CHANGED', 'World changed while reading its theme.');
            return { worldId, revision: String(plan.world_revision), ui: normalizeWorldTheme(plan.ui), globalUi,
                effectiveUi: resolveWorldTheme(globalUi, plan.ui), renderer: readTheme() };
        }
        if (String(plan.world_revision) !== params.expectedRevision) throw controlError('NORA_CONTROL_EDIT_STALE', 'World changed; inspect again.');
        const ui = normalizeWorldTheme(action === 'theme.clear' ? {} : params.ui);
        const { world } = await request(`/api/nora-worlds-v2/worlds/${encodeURIComponent(worldId)}/theme`, { ui, expected_revision: plan.world_revision });
        // Refresh the existing World projection, never a separate theme cache or DOM script.
        try { await story.worlds.refresh(); } catch { return { saved: true, worldId, revision: String(world.revision), ui: world.ui, renderer: { ready: false }, reopenRequired: true }; }
        return { saved: true, worldId, revision: String(world.revision), ui: world.ui, renderer: readTheme(), generationRequested: false };
    };
}
