// Shared model-profile operations for Nora UI and live controls. No UI or model generation.
export const HERMES_MODEL_ID = 'hermes';
const busySettings = new WeakSet();

export function planModelRemoval(profiles, activeId, removeId, hasHermes = false) {
    const remaining = (Array.isArray(profiles) ? profiles : []).filter(profile => profile.id !== removeId);
    const removingActive = activeId === removeId;
    const fallback = removingActive ? remaining[0] || (hasHermes ? { id: HERMES_MODEL_ID, source: 'hermes' } : null) : null;
    return { remaining, nextActive: removingActive ? (fallback?.source === 'hermes' ? '' : fallback?.id || '') : activeId,
        fallback, clearBackend: removingActive && !fallback };
}

export function createModelProfiles({ model, settings, persist }) {
    async function persistChange() {
        try { await persist(); } catch (cause) {
            throw Object.assign(new Error('Model runtime changed, but persistence is unconfirmed. Inspect settings before retrying.'),
                { code: 'NORA_MODEL_SAVE_UNCONFIRMED', runtimeApplied: true, cause });
        }
    }
    const exclusive = operation => async (...args) => {
        const owner = settings();
        if (busySettings.has(owner)) throw Object.assign(new Error('Model configuration is busy.'), { code: 'NORA_CONTROL_BUSY' });
        busySettings.add(owner);
        try { return await operation(...args); } finally { busySettings.delete(owner); }
    };
    const profiles = () => settings().modelProfiles || [];
    const hermes = () => {
        const item = settings().hermesModel;
        return item?.base && item?.model && item?.secretId
            ? { ...item, id: HERMES_MODEL_ID, name: item.provider } : null;
    };
    const resolve = id => id === HERMES_MODEL_ID ? hermes() : profiles().find(item => item.id === id);
    function list() {
        return [hermes(), ...profiles().filter(item => item.id !== HERMES_MODEL_ID)].filter(Boolean).map(item => ({
            id: item.id, name: item.name, model: item.model, context: item.context, tokens: item.tokens,
            source: item.id === HERMES_MODEL_ID ? 'hermes' : 'profile',
            active: (settings().activeModel || HERMES_MODEL_ID) === item.id,
            deletable: item.id !== HERMES_MODEL_ID,
        }));
    }
    async function select(id) {
        const profile = resolve(id);
        if (!profile) throw new Error('Model profile not found or Hermes configuration is not ready.');
        await model.configureModel(profile);
        settings().activeModel = id === HERMES_MODEL_ID ? '' : id;
        await persistChange();
        return { saved: true, activeId: id, scope: 'global', models: list() };
    }
    async function create(profile, apiKey = '') {
        if (!profile?.id || profile.id === HERMES_MODEL_ID || resolve(profile.id)) throw new Error('A unique custom model ID is required.');
        const configured = await model.configureModel(profile, apiKey);
        const item = { ...profile, secretId: configured?.secretId || profile.secretId || '' };
        settings().modelProfiles = [...profiles(), item];
        settings().activeModel = item.id;
        await persistChange();
        return { saved: true, activeId: item.id, scope: 'global', models: list() };
    }
    async function remove(id) {
        if (id === HERMES_MODEL_ID) throw new Error('The managed Hermes model cannot be deleted.');
        const profile = resolve(id);
        if (!profile) throw new Error('Model profile not found.');
        const plan = planModelRemoval(profiles(), settings().activeModel, id, Boolean(hermes()));
        if (plan.fallback) await model.configureModel(plan.fallback.source === 'hermes' ? hermes() : plan.fallback);
        else if (plan.clearBackend) await model.clearModelConfiguration();
        settings().modelProfiles = plan.remaining;
        settings().activeModel = plan.nextActive;
        await persistChange();
        // A shared credential belongs to surviving profiles too. Never delete it with one profile.
        const shared = profile.secretId && [hermes(), ...plan.remaining].some(item => item?.secretId === profile.secretId);
        if (profile.secretId && !shared && !plan.clearBackend) await model.deleteModelSecret(profile.secretId);
        return { saved: true, activeId: settings().activeModel || (hermes() ? HERMES_MODEL_ID : ''), scope: 'global', models: list() };
    }
    return Object.freeze({ list, select: exclusive(select), create: exclusive(create), remove: exclusive(remove) });
}
