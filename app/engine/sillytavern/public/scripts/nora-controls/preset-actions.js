import { controlError } from './contract.js';
import { createWorldPreset, validateWorldPresetParameters } from '../nora-worlds/world-preset.js';
import { editPreset } from '../nora-worlds/preset-edit.js';

const MAX_PRESET_RECEIPT_CHARS = 12000;

export function createPresetActions({ getContext, story, request }) {
    const stale = () => { throw controlError('NORA_CONTROL_EDIT_STALE', 'Preset or World changed; inspect again.'); };
    async function world() {
        const context = getContext().chatMetadata;
        const id = context?.nora_world?.id;
        const session = context?.nora_session?.id;
        if (!id) throw controlError('NORA_CONTROL_NO_WORLD', 'Open the target World first.');
        const { plan } = await request(`/api/nora-worlds-v2/worlds/${encodeURIComponent(id)}/open-plan`);
        if (plan?.world_id !== id || getContext().chatMetadata?.nora_world?.id !== id || getContext().chatMetadata?.nora_session?.id !== session) stale();
        if (!plan.preset) throw controlError('NORA_PRESET_NOT_READY', 'Reopen the World to initialize its preset.');
        return plan;
    }
    const read = name => request('/api/presets/nora-read', { name });
    function publicResult({ storedPreset, ...result }) {
        if (JSON.stringify(result).length <= MAX_PRESET_RECEIPT_CHARS) return result;
        const { preset, ...metadata } = result;
        return { ...metadata, contentOmitted: true, promptCount: preset?.prompts?.length || 0,
            message: 'Large preset content omitted from this response; stored file is unchanged. Use preset.read-chunk with this revision for full safe content.' };
    }
    function cache(result) {
        // Match library import: refresh the list without native preset selection events.
        const { presets, preset_names } = getContext().getPresetManager('openai').getPresetList();
        if (!Object.hasOwn(preset_names, result.name)) {
            preset_names[result.name] = presets.length;
            presets.push(structuredClone(result.storedPreset));
        } else {
            presets[preset_names[result.name]] = structuredClone(result.storedPreset);
        }
    }
    return async function apply(action, params) {
        if (params.scope === 'world' && params.name !== '') throw controlError('NORA_CONTROL_INVALID', 'World scope uses the target World, not a library name; pass an empty name.');
        const target = getContext().chatMetadata;
        const worldId = target?.nora_world?.id;
        const sessionId = target?.nora_session?.id;
        const checkTarget = () => {
            if (getContext().chatMetadata?.nora_world?.id !== worldId || getContext().chatMetadata?.nora_session?.id !== sessionId) stale();
        };
        if (action === 'preset.list') return request('/api/presets/nora-list', {});
        if (action === 'preset.inspect') {
            if (params.scope === 'library') return { ...publicResult(await read(params.name)), scope: 'library' };
            const plan = await world();
            return publicResult({ ...plan.preset, scope: 'world', worldId: plan.world_id, revision: String(plan.world_revision) });
        }
        if (action === 'preset.read-chunk') {
            if (!Number.isInteger(params.offset) || params.offset < 0 || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > 16000) {
                throw controlError('NORA_CONTROL_INVALID', 'Invalid preset chunk range.');
            }
            const source = params.scope === 'library' ? await read(params.name) : await world().then(plan => ({ ...plan.preset, revision: String(plan.world_revision) }));
            checkTarget();
            if (source.revision !== params.expectedRevision) stale();
            const json = JSON.stringify(source.preset);
            if (params.offset > json.length) throw controlError('NORA_CONTROL_INVALID', 'Offset is past the end.');
            const text = json.slice(params.offset, params.offset + params.limit);
            const end = params.offset + text.length;
            return { scope: params.scope, name: params.name, revision: source.revision, encoding: 'json/utf16', offset: params.offset, text,
                total: json.length, nextOffset: end < json.length ? end : null };
        }
        if (getContext().isGenerating?.()) throw controlError('NORA_CONTROL_BUSY', 'Wait until generation finishes.');
        if (action === 'preset.delete') {
            const source = await read(params.name);
            checkTarget();
            if (source.revision !== params.expectedRevision) stale();
            const snapshot = story.presets.readPreset(params.name, { storedOnly: true });
            if (snapshot.revision !== JSON.stringify(source.storedPreset)) stale();
            await story.presets.deletePreset(snapshot);
            return { deleted: true, name: params.name, scope: 'library', worldUnchanged: true, generationRequested: false };
        }
        if (action === 'preset.create' || (action === 'preset.edit' && params.scope === 'library')) {
            const result = await request('/api/presets/nora-save', action === 'preset.create'
                ? { mode: 'create', name: params.name, source: params.source, edits: params.edits }
                : { mode: 'edit', name: params.name, expectedRevision: params.expectedRevision, edits: params.edits });
            try { cache(result); } catch { return { ...publicResult(result), scope: 'library', reloadRequired: true }; }
            return { ...publicResult(result), scope: 'library' };
        }
        const plan = await world();
        checkTarget();
        if (String(plan.world_revision) !== params.expectedRevision) stale();
        if (action === 'preset.save-as') {
            const result = await request('/api/presets/nora-save', { mode: 'create', name: params.name, preset: plan.preset.preset });
            try { cache(result); } catch { return { ...publicResult(result), scope: 'library', worldUnchanged: true, reloadRequired: true }; }
            return { ...publicResult(result), scope: 'library', worldUnchanged: true };
        }
        let value;
        if (action === 'preset.apply') {
            const source = await read(params.name);
            if (source.revision !== params.sourceRevision) stale();
            const latest = await world();
            checkTarget();
            if (latest.world_id !== plan.world_id || latest.world_revision !== plan.world_revision) stale();
            value = createWorldPreset(source.name, source.preset);
            try { validateWorldPresetParameters(value.preset); } catch (error) {
                throw controlError('NORA_PRESET_PARAMETERS_INVALID', error.message);
            }
        } else if (action === 'preset.edit' && params.scope === 'world') {
            value = createWorldPreset(plan.preset.name, editPreset(plan.preset.preset, params.edits), true);
            value.extension_permissions = { ...plan.preset.extension_permissions };
        } else throw controlError('NORA_CONTROL_UNSUPPORTED', 'Unsupported preset action.');
        const result = await story.worlds.updateActive({ preset: value }, { expectedRevision: plan.world_revision });
        if (JSON.stringify(result).length > MAX_PRESET_RECEIPT_CHARS) {
            return { saved: result.saved, runtimeApplied: result.runtimeApplied, scope: 'world', worldId: plan.world_id,
                libraryUnchanged: true, generationRequested: false, contentOmitted: true };
        }
        return { ...result, scope: 'world', worldId: plan.world_id, libraryUnchanged: true, generationRequested: false };
    };
}
