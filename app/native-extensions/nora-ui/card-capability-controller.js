import { translate as tr, t } from '../../engine/sillytavern/public/scripts/nora-i18n/core.js';
export function createCardCapabilityController({
    cards,
    worldRuntime,
    confirmAction,
    showToast,
    onWorldCapabilitiesChanged = () => {},
}) {
    const promptPromises = new Map();

    function capabilities(character) {
        return cards.characterCapabilities(character);
    }

    async function resolve(characterId) {
        return cards.resolveCharacter(characterId);
    }

    function markPrompted(character, current = capabilities(character)) {
        cards.markCharacterCapabilitiesPrompted(character, current);
    }

    async function enable(character, { reload = false } = {}) {
        await cards.enableCharacterCapabilities(character, { reload });
    }

    async function runPrompt(character, { reload = false, force = false } = {}) {
        if (!character) return false;
        const current = capabilities(character);
        const missingRegex = current.regexScripts.length > 0 && !current.regexAllowed;
        const missingHelper = current.helperScripts.length > 0 && !current.helperAllowed;
        if (!missingRegex && !missingHelper) return true;
        if (!force && (!missingRegex || current.regexPrompted) && (!missingHelper || current.helperPrompted)) return false;

        markPrompted(character, current);
        const details = [
            ...current.regexScripts.map((script, index) => t`显示规则：${script?.scriptName || script?.name || t`规则 ${index + 1}`}`),
            ...current.helperScripts.map((script, index) => t`角色脚本：${script?.name || t`脚本 ${index + 1}`}`),
        ];
        const confirmed = await confirmAction({
            kicker: tr("角色卡增强"),
            title: t`启用“${character.name || tr("这名角色")}”的增强功能？`,
            body: tr("这张角色卡包含用于界面显示、变量更新和剧情运行的增强内容。启用后才能获得角色卡设计者提供的完整体验。"),
            confirmLabel: tr("启用并进入"),
            cancelLabel: tr("暂不启用"),
            details,
            detailsLabel: tr("查看包含的功能"),
        });
        if (!confirmed) return false;
        await enable(character, { reload });
        showToast(tr("角色卡增强功能已启用。"));
        return true;
    }

    async function prompt(character, options = {}) {
        if (!character) return false;
        const key = String(character.avatar || character.name || 'current');
        if (promptPromises.has(key)) return promptPromises.get(key);
        const pending = runPrompt(character, options).finally(() => promptPromises.delete(key));
        promptPromises.set(key, pending);
        return pending;
    }

    async function rerenderReadyCapabilities(result) {
        const becameReady = result?.results?.some(item => item?.result?.status === 'READY');
        if (!becameReady) return false;
        const avatar = String(result?.world?.runtime_card?.binding?.avatar || '').trim();
        return cards.rerenderCharacterChat(avatar);
    }

    async function load(worldId, { force = false } = {}) {
        if (typeof worldRuntime?.ensureCapabilities !== 'function') {
            throw new Error('World capability loading is unavailable.');
        }
        const result = await worldRuntime.ensureCapabilities(worldId, {
            authorize: (character, options) => prompt(character, { ...options, force: force || options.force }),
        });
        await rerenderReadyCapabilities(result);
        await onWorldCapabilitiesChanged(result);
        return result;
    }

    async function retry(worldId, capability) {
        if (typeof worldRuntime?.retryCapability !== 'function') {
            throw new Error('World capability retry is unavailable.');
        }
        const result = await worldRuntime.retryCapability(worldId, capability, {
            authorize: (character, options) => prompt(character, { ...options, force: true }),
        });
        await rerenderReadyCapabilities(result);
        await onWorldCapabilitiesChanged(result);
        const settled = result.results[0]?.result;
        if (settled?.status === 'READY') showToast(tr("增强能力已恢复。"));
        else if (settled?.status === 'DEGRADED') showToast(tr("增强能力仍未就绪，请稍后重试。"), { tone: 'error', duration: 4200 });
        return result;
    }

    return Object.freeze({ capabilities, resolve, markPrompted, enable, prompt, load, retry });
}
