import { controlError } from './contract.js';
import { contentRevision as revision } from './revision.js';
import { createModelProfiles } from '../nora-adapters/model-profiles.js';

// World-owned panel operations reuse Story Core adapters, never a second data store.
export function createPanelActions({ getContext, story, request, character, assertOwnedCard, save }) {
    const stale = () => controlError('NORA_CONTROL_EDIT_STALE', 'Content changed; inspect the target again.');
    const invalid = () => controlError('NORA_CONTROL_INVALID', 'Unsupported field or invalid value.');
    const models = createModelProfiles({ model: story.model, settings: () => story.settings.uiSettings(), persist: save });
    async function plan() {
        const worldId = getContext().chatMetadata?.nora_world?.id;
        const sessionId = getContext().chatMetadata?.nora_session?.id;
        character();
        const result = (await request(`/api/nora-worlds-v2/worlds/${encodeURIComponent(worldId)}/open-plan`)).plan;
        if (getContext().chatMetadata?.nora_world?.id !== worldId || getContext().chatMetadata?.nora_session?.id !== sessionId
            || result?.world_id !== worldId || result.runtime_card?.binding?.avatar !== character().avatar) throw controlError('NORA_CONTROL_SCOPE_CHANGED', 'World binding changed.');
        return result;
    }
    async function modelRevision() {
        const settings = story.settings.uiSettings();
        // Hash configuration/secret references, but never return credentials or secret IDs.
        return revision([settings.activeModel, settings.modelProfiles, settings.hermesModel]);
    }
    return async function apply(action, params, command = {}) {
        if (action.startsWith('models.')) {
            if (action === 'models.list') return { models: models.list(), revision: await modelRevision(), scope: 'global' };
            if (await modelRevision() !== params.expectedRevision) throw stale();
            const result = action === 'models.select' ? await models.select(params.id) : await models.remove(params.id);
            return { ...result, revision: await modelRevision(), generationRequested: false };
        }
        if (action === 'world.inspect') {
            const current = await plan();
            return { worldId: current.world_id, name: current.name, persona: current.persona,
                characters: current.story_context?.characters ?? [], relationships: current.story_context?.relationships ?? [],
                cardProfileEnabled: current.story_context?.card_profile_enabled !== false, revision: String(current.world_revision) };
        }
        if (action === 'world.update') {
            const current = await plan();
            if (String(current.world_revision) !== params.expectedRevision) throw stale();
            return story.worlds.updateActive(params.patch, { expectedRevision: current.world_revision });
        }
        if (action === 'world.setting.add' || action === 'world.library.apply') {
            const current = await plan();
            if (String(current.world_revision) !== params.expectedRevision) throw stale();
            if (action === 'world.setting.add') {
                const { setting } = params;
                if (Object.keys(setting).some(key => !['type', 'title', 'content', 'keys'].includes(key))
                    || !['constant', 'trigger'].includes(setting.type) || typeof setting.content !== 'string'
                    || (setting.title !== undefined && typeof setting.title !== 'string')
                    || (setting.keys !== undefined && (!Array.isArray(setting.keys) || setting.keys.some(key => typeof key !== 'string')))
                    || (setting.type === 'constant' && setting.keys?.length)) throw invalid();
                if (typeof command.idempotencyKey !== 'string' || !command.idempotencyKey.trim()) throw invalid();
                return story.worlds.addSetting(setting, { expectedRevision: current.world_revision, idempotencyKey: command.idempotencyKey });
            }
            const { input } = params;
            if (Object.keys(input).some(key => !['character', 'source', 'source_revision'].includes(key))) throw invalid();
            return story.worlds.importLibraryItem(current.world_id, { ...input, expected_revision: current.world_revision });
        }
        if (action.startsWith('scenario.')) {
            const card = character();
            const context = getContext();
            const value = { override: String(context.chatMetadata?.scenario || ''), cardScenario: String(card.data?.scenario ?? card.scenario ?? '') };
            if (action === 'scenario.inspect') return { ...value, effective: value.override || value.cardScenario, revision: await revision(value) };
            if (await revision(value) !== params.expectedRevision) throw stale();
            await story.worldbook.saveWorldScenario(params.text);
            await story.worlds.refresh();
            return { saved: true, scope: 'current-session', effective: params.text.trim() || value.cardScenario, librarySourceUnchanged: true };
        }
        if (action.startsWith('worldbook.')) {
            const current = await plan();
            const card = character();
            const resources = current.knowledge.map(item => ({ name: item.binding.name, ownership: item.ownership, resourceId: item.resource_id }));
            if (action === 'worldbook.list') return { books: resources, embeddedOriginalAvailable: Boolean(card.data?.character_book),
                note: 'Edit the World runtime book used in the prompt, not the imported embedded original.' };
            const resource = resources.find(item => item.name === params.name);
            if (!resource) throw controlError('NORA_CONTROL_RESOURCE_SCOPE', 'Worldbook is not a resource of this World.');
            const book = await story.worldbook.loadWorldbook(params.name, { fresh: true });
            if (!book?.entries || Array.isArray(book.entries)) throw controlError('NORA_CONTROL_WORLDBOOK_FORMAT', 'Expected a runtime ST worldbook with keyed entries.');
            if (action === 'worldbook.inspect') return { ...resource, book, revision: await revision(book) };
            if (resource.ownership !== 'owned') throw controlError('NORA_CONTROL_RESOURCE_SHARED', 'Editing a shared/external Worldbook is not implicitly authorized by a World-scoped operation.');
            await assertOwnedCard();
            if (await revision(book) !== params.expectedRevision) throw stale();
            if (!Object.hasOwn(book.entries, params.entryId)) throw controlError('NORA_CONTROL_ENTRY_MISSING', 'Entry ID not found; inspect again.');
            const next = structuredClone(book);
            if (action === 'worldbook.delete-entry') delete next.entries[params.entryId];
            else {
                const entry = next.entries[params.entryId];
                for (const [key, value] of Object.entries(params.patch)) {
                    if (['comment', 'content'].includes(key) ? typeof value !== 'string'
                        : ['key', 'keysecondary'].includes(key) ? !Array.isArray(value) || value.some(item => typeof item !== 'string')
                            : ['constant', 'disable', 'selective'].includes(key) ? typeof value !== 'boolean' : true) throw invalid();
                    entry[key] = value;
                }
            }
            await story.worldbook.saveWorldbook(params.name, next, { expectedRevision: params.expectedRevision });
            return { saved: true, name: params.name, entryId: params.entryId, revision: await revision(next), librarySourceUnchanged: true };
        }
        throw controlError('NORA_CONTROL_UNSUPPORTED', 'Unsupported panel action.');
    };
}
