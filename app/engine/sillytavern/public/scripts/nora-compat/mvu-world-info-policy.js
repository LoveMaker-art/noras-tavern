import {
    inspectMvuCompatibility,
    isMvuUpdateInstructionEntry,
} from './mvu-compatibility.js';
import { isMvuVariableModelEnabled } from './mvu-settings.js';
export { isMvuVariableModelEnabled as isNoraMvuVariableModelEnabled } from './mvu-settings.js';

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
    return isMvuVariableModelEnabled(settings)
        && !isNoraMvuExtraAnalysisRunning(mvuRuntime)
        && plan.splitModelSupported
        && isNoraMvuUpdateInstructionEntry(entry);
}
