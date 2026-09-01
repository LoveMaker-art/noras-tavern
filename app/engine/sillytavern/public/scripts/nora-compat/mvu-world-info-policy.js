import {
    inspectMvuCompatibility,
    isMvuUpdateInstructionEntry,
} from './mvu-compatibility.js';

export function isNoraMvuVariableModelEnabled(settings = {}) {
    return settings?.['更新方式'] === '额外模型解析'
        && settings?.['额外模型解析配置']?.['启用自动请求'] !== false;
}

export function isNoraMvuUpdateInstructionEntry(entry = {}) {
    return isMvuUpdateInstructionEntry(entry);
}

export function isNoraMvuExtraAnalysisRunning(runtime = globalThis.Mvu) {
    try {
        return runtime?.isDuringExtraAnalysis?.() === true;
    } catch {
        return false;
    }
}

export function shouldSuppressNoraMvuUpdateEntryForMainPrompt(entry, {
    extensionSettings = {},
    mvuRuntime = globalThis.Mvu,
    lorebookEntries = null,
    primaryLorebookName = null,
} = {}) {
    const settings = extensionSettings?.mvu_settings ?? extensionSettings;
    let primary = String(primaryLorebookName || '').trim();
    if (!primary) {
        try {
            primary = String(globalThis.TavernHelper?.getCurrentCharPrimaryLorebook?.() || '').trim();
        } catch {
            primary = '';
        }
    }
    const candidates = lorebookEntries || [entry];
    const protocolEntries = primary
        ? candidates.filter(candidate => String(candidate?.world || '') === primary)
        : candidates;
    const plan = inspectMvuCompatibility({ books: [protocolEntries] });
    return isNoraMvuVariableModelEnabled(settings)
        && !isNoraMvuExtraAnalysisRunning(mvuRuntime)
        && plan.splitModelSupported
        && isNoraMvuUpdateInstructionEntry(entry);
}
