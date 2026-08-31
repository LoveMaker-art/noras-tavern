import { translate as tr } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
function normalized(value) {
    return String(value || '').trim();
}

function joinedLabel(...parts) {
    return [...new Set(parts.map(normalized).filter(Boolean))].join(' · ');
}

export const HERMES_MODEL_ID = 'hermes';

export function projectTextModelChoices(uiSettings = {}) {
    const activeId = normalized(uiSettings.activeModel);
    const hermes = uiSettings.hermesModel;
    const choices = [];
    if (normalized(hermes?.provider) && normalized(hermes?.model)) {
        choices.push(Object.freeze({
            id: HERMES_MODEL_ID,
            name: normalized(hermes.provider),
            model: normalized(hermes.model),
            source: 'hermes',
            active: !activeId || activeId === HERMES_MODEL_ID,
            deletable: false,
        }));
    }
    const profiles = Array.isArray(uiSettings.modelProfiles) ? uiSettings.modelProfiles : [];
    for (const profile of profiles) {
        const id = normalized(profile?.id);
        if (!id || id === HERMES_MODEL_ID) continue;
        choices.push(Object.freeze({
            id,
            name: normalized(profile.name) || normalized(profile.model),
            model: normalized(profile.model),
            source: 'profile',
            active: id === activeId,
            deletable: true,
        }));
    }
    return Object.freeze(choices);
}

export function projectTextModelDisplay({ nativeModel = {}, uiSettings = {} } = {}) {
    const nativeId = normalized(nativeModel.custom_model);
    const nativeReady = Boolean(normalized(nativeModel.custom_url) && nativeId);
    const profiles = Array.isArray(uiSettings.modelProfiles) ? uiSettings.modelProfiles : [];
    const activeProfile = profiles.find(profile => profile.id === uiSettings.activeModel);
    if (nativeReady && activeProfile && normalized(activeProfile.model) === nativeId) {
        return Object.freeze({
            configured: true,
            source: 'profile',
            label: joinedLabel(activeProfile.name, activeProfile.model),
            model: nativeId,
        });
    }

    const hermes = uiSettings.hermesModel;
    if (nativeReady && normalized(hermes?.provider) && normalized(hermes?.model) === nativeId) {
        return Object.freeze({
            configured: true,
            source: 'hermes',
            label: joinedLabel(hermes.provider, hermes.model),
            model: nativeId,
        });
    }

    return Object.freeze({
        configured: false,
        source: 'none',
        label: tr("尚未配置模型"),
        model: '',
    });
}
