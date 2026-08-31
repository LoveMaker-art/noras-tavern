const MVU_UPDATE_COMMENT_MARKER = /\[mvu_update\]/i;
const MVU_UPDATE_CONTENT_MARKER = /<\s*(?:UpdateVariable|JSONPatch)\b/i;

export function isNoraMvuVariableModelEnabled(settings = {}) {
    return settings?.['更新方式'] === '额外模型解析'
        && settings?.['额外模型解析配置']?.['启用自动请求'] !== false;
}

export function isNoraMvuUpdateInstructionEntry(entry = {}) {
    return MVU_UPDATE_COMMENT_MARKER.test(String(entry?.comment || ''))
        || MVU_UPDATE_CONTENT_MARKER.test(String(entry?.content || ''));
}

export function isNoraMvuExtraAnalysisRunning(runtime = globalThis.Mvu) {
    try {
        return runtime?.isDuringExtraAnalysis?.() === true;
    } catch {
        return false;
    }
}

export function shouldSuppressNoraMvuUpdateEntryForMainPrompt(entry, { extensionSettings = {}, mvuRuntime = globalThis.Mvu } = {}) {
    const settings = extensionSettings?.mvu_settings ?? extensionSettings;
    return isNoraMvuVariableModelEnabled(settings)
        && !isNoraMvuExtraAnalysisRunning(mvuRuntime)
        && isNoraMvuUpdateInstructionEntry(entry);
}
