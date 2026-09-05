import {
    inspectMvuCompatibility,
    isMvuUpdateInstructionEntry,
    isNoraMvuV1Entry,
} from './mvu-compatibility.js';

export const NORA_MVU_V1_PROMPT = [
    'Use Nora MVU protocol v1 for this variable update.',
    'Never output _.set, JSONPatch, prose, or markdown inside the update block.',
    'Append exactly one block: <UpdateVariable><NoraMvu>{"protocol":"nora-mvu/1","operations":[...]}</NoraMvu></UpdateVariable>.',
    'Allowed operations: set(path,value), increment(path,amount), append(path,value), insert(path,index,value), delete(path), move(from,path).',
    'Every path must be an array of non-empty string keys or non-negative integer indexes.',
    'When no variable should change, return {"protocol":"nora-mvu/1","operations":[]}.',
].join('\n');

export function isNoraMvuVariableModelEnabled(settings = {}) {
    return settings?.['更新方式'] === '额外模型解析'
        && settings?.['额外模型解析配置']?.['启用自动请求'] !== false;
}

export function isNoraMvuUpdateInstructionEntry(entry = {}) {
    return isMvuUpdateInstructionEntry(entry);
}

export function projectNoraMvuUpdateContent(entry = {}, content = '') {
    const source = String(content || '');
    if (!isNoraMvuV1Entry(entry) || source.includes(NORA_MVU_V1_PROMPT)) return source;
    return `${source.trimEnd()}\n\n${NORA_MVU_V1_PROMPT}`;
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
